import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getSessionId } from '../bootstrap/state.js'
import { VmTelemetryOwner } from './vmTelemetry.js'

let root: string
let originalConfig: string | undefined
let originalHome: string | undefined
let owner: VmTelemetryOwner | undefined

function write(name: string, value: unknown) {
  writeFileSync(join(root, name), JSON.stringify(value))
}
function queue() {
  return JSON.parse(readFileSync(join(root, 'telemetry', 'queue.json'), 'utf8'))
}
function grant(account = 'account-a', token = 'local-grant-a') {
  write('credentials.json', {
    claudeAiOauth: {
      accessToken: token,
      expiresAt: Date.now() + 3600_000,
      scopes: ['user:profile'],
      accountUuid: account,
    },
    account_uuid: account,
  })
  write('.claude.json', { userID: 'vm-only-user', oauthAccount: { accountUuid: account } })
}
function event(phase: 'start' | 'success' | 'failure', attempt_id: string, operation = 'session_key') {
  return { event_id: randomUUID(), kind: 'oauth', attempt_id, operation, phase }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'native-telemetry-'))
  originalConfig = process.env.KERNEL_CONFIG
  originalHome = process.env.CLAUDE_CONFIG_DIR
  process.env.KERNEL_CONFIG = join(root, 'kernel.json')
  process.env.CLAUDE_CONFIG_DIR = root
  mkdirSync(join(root, 'telemetry'))
  write('kernel.json', {
    vm_id: 'vm-local',
    credential_path: join(root, 'credentials.json'),
    socket_path: join(root, 'kernel.sock'),
    internal_token: 'local-internal-token',
    telemetry: { upload_interval_seconds: 600, proxy_id: 'px-local', proxy_url: '', proxy_required: false },
  })
  write('kin-seed.json', { seed_policy: { telemetry_disabled: false } })
  grant()
})
afterEach(() => {
  owner?.close()
  owner = undefined
  if (originalConfig === undefined) delete process.env.KERNEL_CONFIG
  else process.env.KERNEL_CONFIG = originalConfig
  if (originalHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalHome
  rmSync(root, { recursive: true, force: true })
})

function runIsolated(script: string) {
  // Native config deliberately uses memory-only state under NODE_ENV=test.
  // A fresh process exercises real VM config persistence and cold import order.
  const result = Bun.spawnSync([process.execPath, '--preload', './plugins/bunBundleDev.ts', '--eval', script], {
    cwd: join(import.meta.dir, '../..'),
    env: { ...process.env, HOME: root, NODE_ENV: 'development' },
    timeout: 10_000,
  })
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
}

test('analytics-first record-only imports forward real events without creating VM identity', () => {
  write('.claude.json', { oauthAccount: { accountUuid: 'account-a' } })
  const before = readFileSync(join(root, '.claude.json'), 'utf8')
  runIsolated(`
    import { logEventAsync } from './src/services/analytics/index.ts'
    import { readVmTelemetryContext } from './src/kin/vmTelemetryContext.ts'
    import { telemetryEventSchema } from './src/kin/vmTelemetryContract.ts'
    import assert from 'node:assert/strict'
    import http from 'node:http'
    const context = readVmTelemetryContext()
    assert.equal(context.userId, undefined)
    let received
    const server = http.createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      received = telemetryEventSchema.parse(JSON.parse(body))
      response.writeHead(200).end('{}')
    })
    const listening = Promise.withResolvers()
    server.once('error', listening.reject)
    server.listen(context.kernel.socket_path, listening.resolve)
    await listening.promise
    try {
      await logEventAsync('tengu_auto_compact_setting_changed', { enabled: true })
      assert.equal(received.kind, 'setting')
      assert.equal(received.setting, 'autoCompactEnabled')
      assert.equal(received.value, true)
      assert.equal(readVmTelemetryContext().userId, undefined)
    } finally {
      const closed = Promise.withResolvers()
      server.close(closed.resolve)
      await closed.promise
    }
  `)
  expect(readFileSync(join(root, '.claude.json'), 'utf8')).toBe(before)
})

for (const initiallyEnabled of [true, false]) {
  test(`primary owner initializes missing native identity on ${initiallyEnabled ? 'construction' : 'hot enable'} and retains its queue`, () => {
    write('.claude.json', { oauthAccount: { accountUuid: 'account-a' } })
    write('kin-seed.json', { seed_policy: { telemetry_disabled: !initiallyEnabled } })
    runIsolated(`
      import './src/services/analytics/index.ts'
      import { enableConfigs, getOrCreateUserID } from './src/utils/config.ts'
      import { VmTelemetryOwner } from './src/kin/vmTelemetry.ts'
      import { readVmTelemetryContext } from './src/kin/vmTelemetryContext.ts'
      import assert from 'node:assert/strict'
      import { readFileSync, writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      const home = process.env.CLAUDE_CONFIG_DIR
      const readQueue = () => JSON.parse(readFileSync(join(home, 'telemetry/queue.json'), 'utf8'))
      enableConfigs()
      let owner = new VmTelemetryOwner(() => {})
      try {
        if (!${initiallyEnabled}) {
          owner.recordJob(owner.captureJob(), true, 'disabled-job', 'claude-sonnet')
          assert.equal(readVmTelemetryContext().userId, undefined)
          assert.deepEqual(readQueue().records, [])
          writeFileSync(join(home, 'kin-seed.json'), JSON.stringify({ seed_policy: { telemetry_disabled: false } }))
        }
        owner.recordJob(owner.captureJob(), true, 'enabled-job', 'claude-sonnet')
        const identity = readVmTelemetryContext().userId
        assert.match(identity, /^[0-9a-f]{64}$/)
        assert.equal(identity, getOrCreateUserID())
        assert.equal(readQueue().user_id, identity)
        const records = readQueue().records
        assert.equal(records.length, 1)
        owner.close()
        owner = new VmTelemetryOwner(() => {})
        assert.equal(readVmTelemetryContext().userId, identity)
        assert.equal(readQueue().user_id, identity)
        assert.deepEqual(readQueue().records, records)
      } finally {
        owner.close()
      }
    `)
  })
}

test('login records remain provisional until a new valid grant is installed', async () => {
  owner = new VmTelemetryOwner(() => {})
  const attempt = randomUUID()
  await owner.record(event('start', attempt))
  expect(queue().records[0].transaction).toBe(attempt)
  expect(queue().records[0].account).toBeNull()
  grant('account-b', 'local-grant-b')
  await owner.record(event('success', attempt))
  const records = queue().records
  expect(records.map((entry: { account: string }) => entry.account)).toEqual(['account-b', 'account-b'])
  expect(records.every((entry: { transaction: string | null }) => entry.transaction === null)).toBe(true)
})

test('same-account refresh retains records and changed route drops the old pending context', async () => {
  owner = new VmTelemetryOwner(() => {})
  const attempt = randomUUID()
  await owner.record(event('start', attempt, 'refresh'))
  grant('account-a', 'local-refreshed-grant')
  await owner.record(event('success', attempt, 'refresh'))
  expect(queue().records).toHaveLength(2)
  const config = JSON.parse(readFileSync(join(root, 'kernel.json'), 'utf8'))
  config.telemetry.proxy_id = 'new-explicit-local-route'
  write('kernel.json', config)
  const next = randomUUID()
  await owner.record(event('start', next, 'refresh'))
  expect(queue().records).toHaveLength(1)
  expect(queue().records[0].session).toBe(next)
})

test('durable duplicate event IDs are not re-enqueued after a CLI restart', async () => {
  const submitted = event('start', randomUUID(), 'refresh')
  owner = new VmTelemetryOwner(() => {})
  await owner.record(submitted)
  owner.close()
  owner = new VmTelemetryOwner(() => {})
  await owner.record(submitted)
  expect(queue().records).toHaveLength(1)
})

test('opt-out purges pending records and re-enable cannot replay old activities', async () => {
  owner = new VmTelemetryOwner(() => {})
  await owner.record(event('start', randomUUID(), 'refresh'))
  write('kin-seed.json', { seed_policy: { telemetry_disabled: true } })
  await owner.record(event('start', randomUUID(), 'refresh'))
  expect(queue().records).toEqual([])
  write('kin-seed.json', { seed_policy: { telemetry_disabled: false } })
  const next = event('start', randomUUID(), 'refresh')
  await owner.record(next)
  expect(queue().records.map((entry: { id: string }) => entry.id)).toEqual([next.event_id])
})

test('invalid ingress metadata cannot put credentials or identity into the persisted queue', async () => {
  owner = new VmTelemetryOwner(() => {})
  await expect(owner.record({ ...event('start', randomUUID()), access_token: 'never-store-me' })).rejects.toThrow(
    'invalid_event',
  )
  expect(readFileSync(join(root, 'telemetry', 'queue.json'), 'utf8')).not.toContain('never-store-me')
  expect(queue().records).toEqual([])
})

for (const ok of [true, false]) {
  test(`late account-A ${ok ? 'success' : 'error'} is discarded after account-B rebind`, () => {
    owner = new VmTelemetryOwner(() => {})
    const oldScope = owner.captureJob()
    expect(oldScope?.account).toBe('account-a')
    expect(Object.isFrozen(oldScope)).toBe(true)
    expect(JSON.stringify(oldScope)).not.toContain('local-grant-a')
    grant('account-b', 'local-grant-b')
    owner.recordJob(oldScope, ok, randomUUID(), 'claude-sonnet', 'api_error')
    expect(queue().records).toEqual([])
    const session = randomUUID()
    owner.recordJob(owner.captureJob(), ok, session, 'claude-sonnet', 'api_error')
    expect(queue().records).toMatchObject([
      {
        name: ok ? 'tengu_api_success' : 'tengu_api_error',
        account: 'account-b',
        session,
        model: 'claude-sonnet',
        metadata: ok ? {} : { error_code: 'api_error' },
      },
    ])
  })
}

test('disable/reopen rejects both pre-disable and disabled-admitted jobs, collecting only new work', () => {
  owner = new VmTelemetryOwner(() => {})
  const beforeDisable = owner.captureJob()
  write('kin-seed.json', { seed_policy: { telemetry_disabled: true } })
  const whileDisabled = owner.captureJob()
  expect(whileDisabled).toBeNull()
  write('kin-seed.json', { seed_policy: { telemetry_disabled: false } })
  owner.recordJob(beforeDisable, true, randomUUID(), 'claude-sonnet')
  owner.recordJob(whileDisabled, false, randomUUID(), 'claude-sonnet', 'api_error')
  expect(queue().records).toEqual([])
  const session = randomUUID()
  owner.recordJob(owner.captureJob(), true, session, 'claude-sonnet')
  expect(queue().records.map((entry: { session: string }) => entry.session)).toEqual([session])
})

test('same-account token rotation and settings changes retain an in-flight job and native process session', () => {
  owner = new VmTelemetryOwner(() => {})
  const scope = owner.captureJob()
  grant('account-a', 'local-rotated-grant')
  const config = JSON.parse(readFileSync(join(root, 'kernel.json'), 'utf8'))
  config.telemetry.upload_interval_seconds = 60
  write('kernel.json', config)
  write('settings.json', { autoCompactEnabled: false })
  const session = randomUUID()
  owner.recordJob(scope, true, session, 'claude-sonnet')
  expect(owner.captureJob()).toEqual(scope)
  expect(queue().records).toMatchObject([
    {
      name: 'tengu_config_changed',
      session: getSessionId(),
      metadata: { setting: 'autoCompactEnabled', value: false },
    },
    { name: 'tengu_api_success', account: 'account-a', session },
  ])
  expect(readFileSync(join(root, 'telemetry', 'queue.json'), 'utf8')).not.toContain('local-rotated-grant')
})

test('observed account and binding ABA changes cannot revive a prior job scope', () => {
  owner = new VmTelemetryOwner(() => {})
  const original = owner.captureJob()
  grant('account-b', 'local-grant-b')
  owner.captureJob()
  grant()
  owner.recordJob(original, true, randomUUID(), 'claude-sonnet')
  expect(queue().records).toEqual([])
  const beforeBinding = owner.captureJob()
  const config = JSON.parse(readFileSync(join(root, 'kernel.json'), 'utf8'))
  config.telemetry.proxy_id = 'px-local-route-b'
  write('kernel.json', config)
  owner.captureJob()
  config.telemetry.proxy_id = 'px-local'
  write('kernel.json', config)
  owner.recordJob(beforeBinding, true, randomUUID(), 'claude-sonnet')
  expect(queue().records).toEqual([])
  const session = randomUUID()
  owner.recordJob(owner.captureJob(), true, session, 'claude-sonnet')
  expect(queue().records.map((entry: { session: string }) => entry.session)).toEqual([session])
})

test('VM user identity changes invalidate an in-flight job without accepting caller identity', () => {
  owner = new VmTelemetryOwner(() => {})
  const scope = owner.captureJob()
  write('.claude.json', { userID: 'new-vm-only-user', oauthAccount: { accountUuid: 'account-a' } })
  owner.recordJob(scope, true, randomUUID(), 'claude-sonnet')
  expect(queue().records).toEqual([])
  expect(owner.captureJob()?.userId).toBe('new-vm-only-user')
  owner.recordJob(owner.captureJob(), true, randomUUID(), 'claude-sonnet')
  expect(queue().records).toHaveLength(1)
  expect(queue().user_id).toBe('new-vm-only-user')
})

test('first geo observation binds unknown jobs, but observed IP ABA invalidates old scopes', async () => {
  let ip = '203.0.113.11'
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ query: ip, timezone: 'Etc/UTC' }),
  })
  let now = Date.now()
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  try {
    const config = JSON.parse(readFileSync(join(root, 'kernel.json'), 'utf8'))
    config.test_endpoints = true
    config.telemetry.geo_url = `http://127.0.0.1:${server.port}/geo`
    config.telemetry.event_logging_url = `http://127.0.0.1:${server.port}/events`
    write('kernel.json', config)
    // Keep the real geo transport but prevent any upload during these observations.
    write('credentials.json', {})
    owner = new VmTelemetryOwner(() => {})
    const unknown = owner.captureJob()
    expect(unknown?.epoch).toBeNull()
    await owner.tick()
    const first = owner.captureJob()
    expect(first?.epoch).toBeString()
    expect(first?.generation).toBe(unknown?.generation)
    owner.recordJob(unknown, true, randomUUID(), 'claude-sonnet')
    expect(queue().records).toHaveLength(1)
    expect(queue().records[0].epoch).toBe(first?.epoch)
    ip = '203.0.113.12'
    now += 600_001
    await owner.tick()
    expect(queue().records).toEqual([])
    const second = owner.captureJob()
    expect(second?.epoch).not.toBe(first?.epoch)
    owner.recordJob(second, true, randomUUID(), 'claude-sonnet')
    ip = '203.0.113.11'
    now += 600_001
    await owner.tick()
    const current = owner.captureJob()
    expect(current?.epoch).toBe(first?.epoch)
    expect(current?.generation).toBe(first!.generation + 2)
    owner.recordJob(unknown, true, randomUUID(), 'claude-sonnet')
    owner.recordJob(first, false, randomUUID(), 'claude-sonnet', 'api_error')
    expect(queue().records).toEqual([])
    const session = randomUUID()
    owner.recordJob(current, true, session, 'claude-sonnet')
    expect(queue().records.map((entry: { session: string }) => entry.session)).toEqual([session])
  } finally {
    clock.mockRestore()
    server.stop(true)
  }
})

test('different non-UUID conversations never collapse into the process session', () => {
  owner = new VmTelemetryOwner(() => {})
  const scope = owner.captureJob()
  owner.recordJob(scope, true, 'conversation-alpha', 'claude-sonnet')
  owner.recordJob(scope, true, 'conversation-beta', 'claude-sonnet')
  const records = queue().records
  expect(records[0].session).not.toBe(records[1].session)
  expect(records[0].session).not.toContain('conversation')
})

test('backlog removes expired events and keeps the newest 1000 within the byte cap', () => {
  owner = new VmTelemetryOwner(() => {})
  owner.recordJob(owner.captureJob(), true, 'expired-session', 'claude-sonnet')
  owner.close()
  const saved = queue()
  saved.records[0].at = Date.now() - 3600_001
  write('telemetry/queue.json', saved)
  owner = new VmTelemetryOwner(() => {})
  expect(queue().records).toEqual([])
  owner.close()
  const restored = queue()
  restored.records = Array.from({ length: 1000 }, () => ({ ...saved.records[0], id: randomUUID(), at: Date.now() }))
  restored.seen = []
  write('telemetry/queue.json', restored)
  const oldest = restored.records[0].id
  owner = new VmTelemetryOwner(() => {})
  owner.recordJob(owner.captureJob(), true, 'newest-conversation', 'claude-sonnet')
  expect(queue().records).toHaveLength(1000)
  expect(queue().records.some((entry: { id: string }) => entry.id === oldest)).toBe(false)
  expect(Buffer.byteLength(readFileSync(join(root, 'telemetry', 'queue.json')))).toBeLessThanOrEqual(1_048_576)
})

test('a restarted VM recovers a stale reused PID lock but rejects another live sender', async () => {
  mkdirSync(join(root, 'telemetry'), { recursive: true })
  write('telemetry/owner.lock', { pid: process.pid, stamp: 'prior-guest-boot:1' })
  owner = new VmTelemetryOwner(() => {})
  const accepted = event('start', randomUUID(), 'refresh')
  await owner.record(accepted)
  expect(queue().records.map((entry: { id: string }) => entry.id)).toContain(accepted.event_id)
  expect(() => new VmTelemetryOwner(() => {})).toThrow('telemetry_owner_conflict')
})

test('restored larger records evict oldest activity at the byte limit before the count limit', () => {
  owner = new VmTelemetryOwner(() => {})
  owner.recordJob(owner.captureJob(), true, 'restored-conversation', 'claude-sonnet')
  owner.close()
  const restored = queue()
  const template = {
    ...restored.records[0],
    metadata: Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`safe_field_${index}`, 'x'.repeat(128)])),
  }
  restored.records = []
  while (true) {
    restored.records.push({ ...template, id: randomUUID() })
    if (Buffer.byteLength(JSON.stringify(restored)) > 1_048_576) {
      restored.records.pop()
      break
    }
  }
  const oldest = restored.records[0].id
  expect(restored.records.length).toBeLessThan(1000)
  write('telemetry/queue.json', restored)
  owner = new VmTelemetryOwner(() => {})
  for (let index = 0; index < 32 && queue().records.some((entry: { id: string }) => entry.id === oldest); index++) {
    owner.recordJob(owner.captureJob(), true, `new-conversation-${index}`, 'claude-sonnet')
  }
  expect(queue().records.some((entry: { id: string }) => entry.id === oldest)).toBe(false)
  expect(Buffer.byteLength(readFileSync(join(root, 'telemetry', 'queue.json')))).toBeLessThanOrEqual(1_048_576)
}, 15000)
