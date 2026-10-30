import { isIP } from 'node:net'
import { join } from 'node:path'
import { z } from 'zod'
import { readTelemetryJson, telemetryHash, type VmTelemetryContext } from './vmTelemetryContext.js'
import { createTelemetryRoute, type TelemetryRoute } from './vmTelemetryHttp.js'

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
    this.load(context)
  }

  /** A control-plane publication can replace a failed stub without restarting the sender. */
  private load(context: VmTelemetryContext) {
    const raw = readTelemetryJson(this.filename)
    if (!Object.keys(raw).length) return
    const parsed = snapshotSchema.safeParse(raw)
    if (
      parsed.success &&
      parsed.data.vm_id === context.kernel.vm_id &&
      parsed.data.binding === context.binding &&
      isIP(parsed.data.ip) &&
      validZone(parsed.data.timezone) &&
      parsed.data.epoch === telemetryHash([parsed.data.binding, parsed.data.ip]) &&
      !parsed.data.error
    ) {
      this.current = parsed.data
      this.initial = false
      return
    }
    this.current = null
  }

  get snapshot() {
    return this.current
  }

  transport(context: VmTelemetryContext): TelemetryRoute {
    if (!context.bindingValid || !context.binding) throw new Error('telemetry_proxy_unavailable')
    if (this.binding === context.binding && this.route) return this.route
    this.close()
    this.binding = context.binding
    this.initial = true
    this.route = createTelemetryRoute()
    return this.route
  }

  async ensure(context: VmTelemetryContext, signal: AbortSignal): Promise<EgressSnapshot> {
    if (signal.aborted) throw new Error('telemetry_context_changed')
    // Proxy geo is published by the control plane. A sender probe can fail and
    // replace that snapshot with a stub, so a valid publication is authoritative.
    this.load(context)
    if (this.current && this.current.binding === context.binding && !this.current.error) {
      this.initial = false
      return this.current
    }
    throw new Error('telemetry_egress_unpublished')
  }

  close() {
    if (this.route) void this.route.dispatcher.destroy()
    this.route = undefined
    this.binding = null
  }
}
