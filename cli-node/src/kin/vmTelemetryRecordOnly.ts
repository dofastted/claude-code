import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { readVmTelemetryContext } from './vmTelemetryContext.js'
import { telemetryEventSchema, type TelemetryEvent } from './vmTelemetryContract.js'

let loginAttempt: string | undefined
let pending = 0
const changes: Record<string, string> = {
  tengu_auto_compact_setting_changed: 'autoCompactEnabled',
  tengu_tips_setting_changed: 'spinnerTipsEnabled',
  tengu_reduce_motion_setting_changed: 'prefersReducedMotion',
  tengu_respect_gitignore_setting_changed: 'respectGitignore',
  tengu_default_view_setting_changed: 'defaultView',
}

export function managedEventFromAnalytics(name: string, metadata: Record<string, unknown>): TelemetryEvent | null {
  if (name === 'tengu_oauth_flow_start' || name === 'tengu_login_from_refresh_token') {
    loginAttempt = randomUUID()
    return { event_id: randomUUID(), kind: 'oauth', attempt_id: loginAttempt, operation: 'reauthorize', phase: 'start' }
  }
  if (name === 'tengu_oauth_success' || name === 'tengu_oauth_error') {
    if (!loginAttempt) return null
    const attempt_id = loginAttempt
    loginAttempt = undefined
    return {
      event_id: randomUUID(),
      kind: 'oauth',
      attempt_id,
      operation: 'reauthorize',
      phase: name === 'tengu_oauth_success' ? 'success' : 'failure',
      ...(name === 'tengu_oauth_error' ? { error_code: 'oauth_auth_failed' } : {}),
    }
  }
  const setting = name === 'tengu_config_changed' ? (metadata.setting ?? metadata.key) : changes[name]
  if (typeof setting !== 'string') return null
  const parsed = telemetryEventSchema.safeParse({
    event_id: randomUUID(),
    kind: 'setting',
    setting,
    value: Object.hasOwn(metadata, 'value') ? metadata.value : metadata.enabled,
  })
  return parsed.success ? parsed.data : null
}

export async function forwardManagedAnalytics(name: string, metadata: Record<string, unknown>) {
  const event = managedEventFromAnalytics(name, metadata)
  if (!event || pending >= 128) return
  const context = readVmTelemetryContext()
  if (!context.enabled) return
  const socketPath = context.kernel.socket_path
  const internalToken = context.kernel.internal_token
  if (
    typeof socketPath !== 'string' ||
    !socketPath.startsWith('/') ||
    typeof internalToken !== 'string' ||
    !internalToken
  ) {
    throw new Error('telemetry_ingress_unavailable')
  }
  const body = JSON.stringify(event)
  pending++
  try {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const req = http.request(
      {
        socketPath,
        path: '/internal/v1/telemetry/events',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-internal-token': internalToken,
        },
      },
      (response) => {
        let bytes = 0
        response.on('data', (chunk) => {
          bytes += chunk.length
          if (bytes > 8192) req.destroy(new Error('telemetry_ack_invalid'))
        })
        response.once('end', () =>
          response.statusCode === 200 ? resolve() : reject(new Error('telemetry_ingress_failed')),
        )
        response.once('error', reject)
      },
    )
    const timeout = setTimeout(() => req.destroy(new Error('telemetry_ingress_timeout')), 20_000)
    timeout.unref()
    req.once('close', () => clearTimeout(timeout))
    req.once('error', reject)
    req.end(body)
    await promise
  } finally {
    pending--
  }
}
