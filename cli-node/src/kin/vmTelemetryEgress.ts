import { isIP } from 'node:net'
import { randomUUID } from 'node:crypto'
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  readTelemetryJson,
  readVmTelemetryContext,
  telemetryHash,
  type VmTelemetryContext,
} from './vmTelemetryContext.js'
import { createTelemetryRoute, requestTelemetryJson, type TelemetryRoute } from './vmTelemetryHttp.js'

const snapshotSchema = z.object({
  vm_id: z.string(),
  binding: z.string(),
  epoch: z.string(),
  ip: z.string(),
  timezone: z.string(),
  checked_at: z.number().finite(),
  error: z.string().nullable().optional(),
  country: z.string().optional(),
  country_code: z.string().optional(),
  region: z.string().optional(),
  city: z.string().optional(),
  isp: z.string().optional(),
})
export type EgressSnapshot = z.infer<typeof snapshotSchema>
const geoSchema = z.object({
  status: z.string().optional(),
  query: z.string().optional(),
  ip: z.string().optional(),
  timezone: z.string().optional(),
  country: z.string().optional(),
  countryCode: z.string().optional(),
  regionName: z.string().optional(),
  city: z.string().optional(),
  isp: z.string().optional(),
})

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format()
    return true
  } catch {
    return false
  }
}

export class VmTelemetryEgress {
  private current: EgressSnapshot | null = null
  private binding: string | null = null
  private route: TelemetryRoute | undefined
  private initial = true
  private readonly filename: string

  constructor(context: VmTelemetryContext) {
    this.filename = join(context.home, 'telemetry', 'egress.json')
    const parsed = snapshotSchema.safeParse(readTelemetryJson(this.filename))
    if (
      parsed.success &&
      parsed.data.vm_id === context.kernel.vm_id &&
      parsed.data.binding === context.binding &&
      isIP(parsed.data.ip) &&
      validZone(parsed.data.timezone) &&
      parsed.data.epoch === telemetryHash([parsed.data.binding, parsed.data.ip])
    ) {
      this.current = parsed.data
    }
  }

  get snapshot() {
    return this.current
  }

  transport(context: VmTelemetryContext): TelemetryRoute {
    if (!context.bindingValid || !context.binding || context.proxyUrl === null)
      throw new Error('telemetry_proxy_unavailable')
    if (this.binding === context.binding && this.route) return this.route
    this.close()
    this.binding = context.binding
    this.initial = true
    this.route = createTelemetryRoute(context.proxyUrl)
    return this.route
  }

  async ensure(context: VmTelemetryContext, signal: AbortSignal): Promise<EgressSnapshot> {
    const route = this.transport(context)
    if (
      !this.initial &&
      this.current &&
      this.current.binding === context.binding &&
      !this.current.error &&
      Date.now() >= this.current.checked_at &&
      Date.now() - this.current.checked_at < 600_000
    )
      return this.current
    try {
      const payload = await requestTelemetryJson(context.geoEndpoint, route, { signal, maxBytes: 32768 })
      const parsed = geoSchema.safeParse(payload)
      if (!parsed.success || parsed.data.status === 'fail') throw new Error('telemetry_geo_invalid')
      const geo = parsed.data
      const ip = geo.query || geo.ip || ''
      const timezone = geo.timezone || ''
      if (!isIP(ip) || !timezone || !validZone(timezone)) throw new Error('telemetry_geo_invalid')
      const latest = readVmTelemetryContext()
      if (
        signal.aborted ||
        !latest.enabled ||
        latest.binding !== context.binding ||
        latest.version !== context.version
      ) {
        throw new Error('telemetry_context_changed')
      }
      const observed: EgressSnapshot = {
        vm_id: context.kernel.vm_id,
        binding: context.binding!,
        epoch: telemetryHash([context.binding, ip]),
        ip,
        timezone,
        checked_at: Date.now(),
        error: null,
        ...(geo.country ? { country: geo.country.slice(0, 128) } : {}),
        ...(geo.countryCode ? { country_code: geo.countryCode.slice(0, 8) } : {}),
        ...(geo.regionName ? { region: geo.regionName.slice(0, 128) } : {}),
        ...(geo.city ? { city: geo.city.slice(0, 128) } : {}),
        ...(geo.isp ? { isp: geo.isp.slice(0, 128) } : {}),
      }
      this.save(context, observed)
      this.current = observed
      this.initial = false
      return observed
    } catch (error) {
      if (!signal.aborted) {
        if (this.current?.binding === context.binding) this.current = { ...this.current, error: 'telemetry_geo_failed' }
        this.save(
          context,
          this.current?.binding === context.binding
            ? this.current
            : {
                vm_id: context.kernel.vm_id,
                binding: context.binding,
                error: 'telemetry_geo_failed',
                checked_at: 0,
              },
        )
      }
      throw error instanceof Error && /^telemetry_[a-z_]+$/.test(error.message)
        ? error
        : new Error('telemetry_geo_failed')
    }
  }

  private save(context: VmTelemetryContext, value: unknown) {
    const directory = join(context.home, 'telemetry')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
      throw new Error('telemetry_storage_invalid')
    const temp = `${this.filename}.${randomUUID()}.tmp`
    const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try {
      writeFileSync(fd, JSON.stringify(value))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, this.filename)
  }

  close() {
    if (this.route) void this.route.dispatcher.destroy()
    this.route = undefined
    this.binding = null
  }
}
