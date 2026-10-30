import { randomUUID } from 'node:crypto'
import {
  constants,
  closeSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs'
import { z } from 'zod'
import { getSessionId } from '../bootstrap/state.js'
import { FirstPartyEventLoggingExporter } from '../services/analytics/firstPartyEventLoggingExporter.js'
import { getOrCreateUserID } from '../utils/config.js'
import {
  readTelemetryJson,
  readVmTelemetryContext,
  telemetryHash,
  vmEventEnrichment,
  type VmTelemetryContext,
} from './vmTelemetryContext.js'
import { VmTelemetryEgress } from './vmTelemetryEgress.js'
import { installManagedTelemetryRecorder, telemetryEventSchema, type TelemetryState } from './vmTelemetryContract.js'
import { managedEventFromAnalytics } from './vmTelemetryRecordOnly.js'

const MAX_AGE = 3_600_000
const MAX_EVENTS = 1000
const MAX_BYTES = 1_048_576
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ownerLockSchema = z.object({ pid: z.number().int().positive(), stamp: z.string().min(1).max(128) }).strict()

function processStamp(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const started = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/)[19]
  if (!started || !/^\d+$/.test(started)) throw new Error('telemetry_owner_conflict')
  return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${started}`
}

const recordSchema = z
  .object({
    id: z.string().uuid(),
    at: z.number().finite(),
    account: z.string().max(256).nullable(),
    transaction: z.string().uuid().nullable(),
    binding: z.string().max(64).nullable(),
    epoch: z.string().max(64).nullable(),
    name: z.enum([
      'tengu_init',
      'tengu_config_changed',
      'tengu_oauth_flow_start',
      'tengu_oauth_success',
      'tengu_oauth_error',
      'tengu_api_success',
      'tengu_api_error',
    ]),
    session: z.union([z.string().uuid(), z.string().regex(/^[0-9a-f]{64}$/)]),
    model: z.string().max(128).optional(),
    metadata: z.record(z.union([z.string().max(128), z.number().finite(), z.boolean()])),
  })
  .strict()
const attemptSchema = z
  .object({
    at: z.number().finite(),
    operation: z.string().max(32),
    oldToken: z.string().max(64).nullable(),
    terminal: z.boolean(),
  })
  .strict()
const queueSchema = z
  .object({
    schema: z.literal(1),
    vm_id: z.string().min(1).max(128),
    user_id: z.string().max(256).nullable(),
    binding: z.string().max(64).nullable(),
    epoch: z.string().max(64).nullable(),
    account: z.string().max(256).nullable(),
    next_send_at: z.number().finite(),
    records: z.array(recordSchema).max(MAX_EVENTS),
    attempts: z.array(z.tuple([z.string().uuid(), attemptSchema])).max(128),
    seen: z.array(z.tuple([z.string().uuid(), z.number().finite()])).max(2048),
  })
  .strict()
type StoredRecord = z.infer<typeof recordSchema>
type Attempt = z.infer<typeof attemptSchema>
type QueueDocument = z.infer<typeof queueSchema>

// Captured from the VM owner before a native job starts; never contains credentials.
export type VmJobTelemetryScope = Readonly<{
  account: string | null
  binding: string | null
  userId: string | null
  epoch: string | null
  generation: number
}>

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined
}

function atomicJson(filename: string, value: unknown) {
  const directory = dirname(filename)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
    throw new Error('telemetry_storage_invalid')
  const temp = `${filename}.${randomUUID()}.tmp`
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    writeFileSync(fd, JSON.stringify(value))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temp, filename)
    const dirFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY)
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  } finally {
    try {
      unlinkSync(temp)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  }
}

function readQueue(filename: string): QueueDocument | null {
  try {
    const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > MAX_BYTES) return null
      const data = queueSchema.safeParse(JSON.parse(readFileSync(fd, 'utf8')))
      return data.success ? data.data : null
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return /^[a-z][a-z0-9_]{0,63}$/.test(message) ? message : 'telemetry_transport_failed'
}

// Only the primary owner may initialize native identity; record-only readers never write config.
function readOwnerContext(): VmTelemetryContext {
  const context = readVmTelemetryContext()
  if (!context.enabled || context.userId) return context
  getOrCreateUserID()
  return readVmTelemetryContext()
}

export class VmTelemetryOwner {
  private readonly exporter = new FirstPartyEventLoggingExporter({ managed: true })
  private readonly egress: VmTelemetryEgress
  private readonly queuePath: string
  private readonly lockPath: string
  private readonly processSession = getSessionId()
  private context: VmTelemetryContext
  private records: StoredRecord[] = []
  private attempts = new Map<string, Attempt>()
  private seen = new Map<string, number>()
  private binding: string | null
  private epoch: string | null = null
  private account: string | null
  private userId: string | null
  private generation = 0
  private nextSendAt: number
  private state: TelemetryState
  private poll: NodeJS.Timeout | undefined
  private busy = false
  private closed = false
  private startupProbe = true
  private network: AbortController | undefined
  private settings: Record<string, string | boolean>
  private publishing = ''
  private persisted = ''
  private retryProbeAt = 0
  private readonly lockIdentity = JSON.stringify({ pid: process.pid, stamp: processStamp(process.pid) })

  constructor(private readonly publish: (state: TelemetryState) => void | Promise<void>) {
    this.context = readOwnerContext()
    this.binding = this.context.binding
    this.account = this.context.account
    this.userId = this.context.userId ?? null
    this.settings = { ...this.context.safeSettings }
    this.egress = new VmTelemetryEgress(this.context)
    this.queuePath = join(this.context.home, 'telemetry', 'queue.json')
    this.lockPath = join(this.context.home, 'telemetry', 'owner.lock')
    this.nextSendAt = Date.now() + this.context.interval
    this.state = {
      enabled: this.context.enabled,
      state: this.context.enabled ? 'idle' : 'disabled',
      pending_events: 0,
      last_upload_at: null,
      last_error: null,
    }
    mkdirSync(dirname(this.lockPath), { recursive: true, mode: 0o700 })
    this.acquire()
    const saved = readQueue(this.queuePath)
    if (saved && saved.vm_id === this.context.kernel.vm_id) this.epoch = saved.epoch
    this.synchronize()
    this.trim()
    this.persist()
  }

  private acquire() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(
          this.lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        )
        try {
          writeFileSync(fd, this.lockIdentity)
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        return
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error
        const stat = lstatSync(this.lockPath)
        if (!stat.isFile() || stat.size > 256) throw new Error('telemetry_owner_conflict')
        const previous = ownerLockSchema.safeParse(readTelemetryJson(this.lockPath))
        if (!previous.success) throw new Error('telemetry_owner_conflict')
        try {
          if (processStamp(previous.data.pid) === previous.data.stamp) throw new Error('telemetry_owner_conflict')
        } catch (probe) {
          if (errorCode(probe) !== 'ENOENT' && errorCode(probe) !== 'ESRCH') throw probe
        }
        if (attempt === 1) throw new Error('telemetry_owner_conflict')
        unlinkSync(this.lockPath)
      }
    }
  }

  start() {
    installManagedTelemetryRecorder(async (name, metadata) => {
      const event = managedEventFromAnalytics(name, metadata)
      if (event) await this.record(event)
    })
    this.notify()
    this.poll = setInterval(() => {
      try {
        this.synchronize()
        this.trim()
        this.notify()
      } catch (error) {
        this.failure(error)
      }
      if (!this.busy && this.context.enabled && Date.now() >= this.retryProbeAt) void this.tick()
    }, 200)
    this.poll.unref()
    void this.tick()
  }

  private synchronize() {
    const next = readOwnerContext()
    if (next.home !== this.context.home || next.kernel.vm_id !== this.context.kernel.vm_id) {
      this.network?.abort()
      throw new Error('telemetry_owner_context_changed')
    }
    const off = !next.enabled
    const changedBinding = next.binding !== this.binding || next.version !== this.context.version
    const changedAccount = next.account !== this.account && this.account !== null
    const changedUser = (next.userId ?? null) !== this.userId
    const changedEnabled = next.enabled !== this.context.enabled
    if (changedEnabled || next.account !== this.account || changedBinding || changedUser) this.generation++
    const purge =
      off && (this.context.enabled || this.records.length > 0 || this.attempts.size > 0 || this.seen.size > 0)
    if (off || changedBinding || changedAccount || changedUser || changedEnabled) this.network?.abort()
    if (purge || changedBinding || changedUser) {
      this.records = []
      this.attempts.clear()
      this.seen.clear()
      this.epoch = null
      this.nextSendAt = Date.now() + next.interval
    } else if (changedAccount) {
      // New-login transactions are provisional; never send old-account events with a new grant.
      this.records = this.records.filter((record) => record.transaction !== null)
    }
    if (this.account === null && next.account && next.validCredentials) {
      for (const record of this.records)
        if (!record.transaction && record.account === null) record.account = next.account
    }
    if (changedBinding || (changedEnabled && next.enabled)) {
      this.startupProbe = true
      this.retryProbeAt = 0
    }
    if (next.interval !== this.context.interval || (changedEnabled && next.enabled))
      this.nextSendAt = Date.now() + next.interval
    this.binding = next.binding
    this.account = next.account
    this.userId = next.userId ?? null
    this.context = next
    this.state.enabled = next.enabled
    if (off) {
      this.state.state = 'disabled'
      this.state.last_error = null
      this.settings = { ...next.safeSettings }
    } else {
      this.settings = { ...next.safeSettings }
    }
    if (purge || changedBinding || changedAccount || changedUser || changedEnabled) this.persist()
  }

  private trim() {
    const now = Date.now()
    this.records = this.records.filter((record) => record.at <= now && now - record.at < MAX_AGE)
    for (const [id, at] of this.seen) if (now - at >= MAX_AGE) this.seen.delete(id)
    for (const [id, attempt] of this.attempts) if (now - attempt.at >= MAX_AGE) this.attempts.delete(id)
    while (this.records.length > MAX_EVENTS) this.records.shift()
    while (this.seen.size > 2048) this.seen.delete(this.seen.keys().next().value!)
    while (this.attempts.size > 128) this.attempts.delete(this.attempts.keys().next().value!)
    while (Buffer.byteLength(JSON.stringify(this.document())) > MAX_BYTES && this.records.length) this.records.shift()
  }

  private document(): QueueDocument {
    return {
      schema: 1,
      vm_id: this.context.kernel.vm_id,
      user_id: this.userId,
      binding: this.binding,
      epoch: this.epoch,
      account: this.account,
      next_send_at: this.nextSendAt,
      records: this.records,
      attempts: [...this.attempts],
      seen: [...this.seen],
    }
  }

  private persist() {
    this.trim()
    const document = this.document()
    const body = JSON.stringify(document)
    if (body === this.persisted) return
    try {
      atomicJson(this.queuePath, document)
      this.persisted = body
    } catch (error) {
      const durable = readQueue(this.queuePath)
      this.records = durable?.records ?? []
      this.seen = new Map(durable?.seen ?? [])
      this.attempts = new Map(durable?.attempts ?? [])
      throw error
    }
  }

  private enqueue(
    name: StoredRecord['name'],
    metadata: Record<string, string | number | boolean>,
    session: string,
    save = true,
    id: string = randomUUID(),
    transaction: string | null = null,
    model?: string,
  ) {
    if (!this.context.enabled || this.closed || this.seen.has(id)) return
    const at = Date.now()
    this.seen.set(id, at)
    this.records.push({
      id,
      at,
      name,
      metadata,
      session: UUID.test(session) ? session : telemetryHash([this.context.kernel.vm_id, session]),
      account: transaction ? null : this.account,
      transaction,
      binding: this.binding,
      epoch: this.epoch,
      ...(model && /^[a-zA-Z0-9._:/-]{1,128}$/.test(model) ? { model } : {}),
    })
    if (save) this.persist()
  }

  async record(raw: unknown) {
    const parsed = telemetryEventSchema.safeParse(raw)
    if (!parsed.success) throw new Error('invalid_event')
    this.synchronize()
    const event = parsed.data
    if (!this.context.enabled || this.seen.has(event.event_id)) return
    if (event.kind === 'setting') {
      // synchronize() observes the actual VM files and records each real change.
      // A menu notification cannot forge a value or duplicate that file change.
      return
    } else {
      const attempt = this.attempts.get(event.attempt_id)
      if (event.phase === 'start') {
        if (attempt || this.attempts.size >= 128) return
        this.attempts.set(event.attempt_id, {
          at: Date.now(),
          operation: event.operation,
          oldToken: this.context.tokenHash,
          terminal: false,
        })
      } else {
        if (!attempt || attempt.terminal || attempt.operation !== event.operation) return
        attempt.terminal = true
      }
      const provisional = event.operation !== 'refresh' ? event.attempt_id : null
      const name =
        event.phase === 'start'
          ? 'tengu_oauth_flow_start'
          : event.phase === 'success'
            ? 'tengu_oauth_success'
            : 'tengu_oauth_error'
      this.enqueue(
        name,
        {
          operation: event.operation,
          phase: event.phase,
          ...(event.error_code ? { error_code: event.error_code } : {}),
        },
        event.attempt_id,
        false,
        event.event_id,
        provisional,
      )
      if (event.phase === 'success' && provisional && this.context.validCredentials && this.account) {
        const original = this.attempts.get(event.attempt_id)!
        if (original.oldToken === null || original.oldToken !== this.context.tokenHash) {
          for (const record of this.records)
            if (record.transaction === provisional) {
              record.transaction = null
              record.account = this.account
            }
        }
      }
      this.persist()
    }
    this.notify()
  }

  captureJob(): VmJobTelemetryScope | null {
    try {
      this.synchronize()
      if (!this.context.enabled || this.closed) return null
      return Object.freeze({
        account: this.account,
        binding: this.binding,
        userId: this.userId,
        epoch: this.epoch,
        generation: this.generation,
      })
    } catch (error) {
      this.failure(error)
      return null
    }
  }

  recordJob() {}

  sendSlotStart(session: string, model: string) {
    try {
      this.synchronize()
      if (!this.context.enabled || this.closed) return
      this.enqueue('tengu_init', { phase: 'slot_start' }, session, true, randomUUID(), null, model)
      this.nextSendAt = 0
      this.retryProbeAt = 0
      void this.tick()
    } catch (error) {
      this.failure(error)
    }
  }

  private notify() {
    this.state.pending_events = this.records.length
    if (!this.context.enabled) this.state.state = 'disabled'
    else if (!this.busy)
      this.state.state = !this.context.validCredentials
        ? 'waiting_credentials'
        : !this.egress.snapshot || this.egress.snapshot.binding !== this.binding || this.egress.snapshot.error
          ? 'waiting_egress'
          : this.state.last_error
            ? 'error'
            : 'idle'
    const body = JSON.stringify(this.state)
    if (body !== this.publishing) {
      this.publishing = body
      atomicJson(join(this.context.home, 'telemetry', 'telemetry-state.json'), this.state)
      void Promise.resolve(this.publish({ ...this.state })).catch(() => {
        process.stderr.write('[telemetry] telemetry_state_publish_failed\n')
      })
    }
  }

  private failure(error: unknown) {
    this.state.state = this.context.enabled ? 'error' : 'disabled'
    this.state.last_error = safeError(error)
    this.notify()
  }

  private audit(ok: boolean, count: number, code: string | null) {
    const filename = join(dirname(this.context.configPath), 'telemetry-upload.log')
    let lines: string[] = []
    try {
      if (lstatSync(filename).isFile() && lstatSync(filename).size < 65536)
        lines = readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean)
    } catch {}
    lines.push(JSON.stringify({ at: new Date().toISOString(), ok, events: count, error: code }))
    // Counts/status only: no identity, endpoints, headers, tokens or payloads.
    const temp = `${filename}.${randomUUID()}.tmp`
    writeFileSync(temp, lines.slice(-40).join('\n') + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(temp, filename)
  }

  async tick() {
    if (this.busy || this.closed) return
    this.busy = true
    const network = new AbortController()
    this.network = network
    try {
      this.synchronize()
      if (!this.context.enabled) return
      const mustProbe = this.startupProbe || this.records.length > 0
      if (!mustProbe) return
      const snapshot = await this.egress.ensure(this.context, network.signal)
      this.synchronize()
      if (network.signal.aborted || !this.context.enabled || snapshot.binding !== this.binding) return
      this.startupProbe = false
      if (this.epoch !== null && snapshot.epoch !== this.epoch) {
        this.generation++
        this.records = []
      }
      this.epoch = snapshot.epoch
      for (const record of this.records)
        if (record.binding === this.binding && record.epoch === null) record.epoch = this.epoch
      if (!this.context.validCredentials || !this.account || !this.context.userId) return
      // The authorization grant must agree with the recorded owner at the actual send.
      const batch = this.records
        .filter(
          (record) =>
            !record.transaction &&
            record.account === this.account &&
            record.binding === this.binding &&
            record.epoch === this.epoch,
        )
        .slice(0, 1)
      if (!batch.length) return
      const context = this.context
      const logs = batch.map((record) => ({
        hrTime: [Math.floor(record.at / 1000), (record.at % 1000) * 1_000_000],
        body: record.name,
        attributes: {
          event_name: record.name,
          event_id: record.id,
          user_id: context.userId,
          core_metadata: vmEventEnrichment(context, record.session, record.model).coreMetadata,
          user_metadata: context.user,
          event_metadata: { ...record.metadata, timezone: snapshot.timezone },
        },
      })) as unknown as ReadableLogRecord[]
      const payload = this.exporter.serializeVmRecords(logs)
      this.nextSendAt = 0
      this.persist()
      this.state.state = 'uploading'
      this.state.last_error = null
      this.notify()
      try {
        await this.exporter.sendVmBatch(payload, {
          endpoint: context.endpoint,
          accessToken: context.accessToken!,
          signal: network.signal,
          route: this.egress.transport(context),
        })
        this.synchronize()
        if (network.signal.aborted) return
        const sent = new Set(batch.map((record) => record.id))
        this.records = this.records.filter((record) => !sent.has(record.id))
        this.state.last_upload_at = new Date().toISOString()
        this.state.last_error = null
        this.audit(true, batch.length, null)
      } catch (error) {
        this.audit(false, batch.length, safeError(error))
        throw error
      }
    } catch (error) {
      if (!network.signal.aborted) {
        this.retryProbeAt = Date.now() + 60_000
        this.failure(error)
      }
    } finally {
      this.busy = false
      if (this.network === network) this.network = undefined
      try {
        this.persist()
        this.notify()
      } catch (error) {
        process.stderr.write(`[telemetry] ${safeError(error)}\n`)
      }
    }
  }

  close() {
    this.closed = true
    clearInterval(this.poll)
    this.network?.abort()
    this.egress.close()
    this.persist()
    try {
      if (readFileSync(this.lockPath, 'utf8') === this.lockIdentity) unlinkSync(this.lockPath)
    } catch {}
  }
}

let owner: VmTelemetryOwner | undefined
export function startVmTelemetry(publish: (state: TelemetryState) => void | Promise<void>) {
  if (process.platform !== 'linux' || !process.env.KERNEL_CONFIG) return undefined
  owner = new VmTelemetryOwner(publish)
  return owner
}
export function captureVmJob(): VmJobTelemetryScope | null {
  return owner?.captureJob() ?? null
}
export function sendSlotStart(session: string, model: string) {
  owner?.sendSlotStart(session, model)
}
