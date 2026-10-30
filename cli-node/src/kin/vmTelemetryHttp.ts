// Direct only. The slot network's egress forwarder is the only proxy.
import { Agent, request } from 'undici/index.js'
import type { Dispatcher } from 'undici'

export interface TelemetryRoute {
  dispatcher: Dispatcher
}

export function createTelemetryRoute(): TelemetryRoute {
  return { dispatcher: new Agent({ connect: { timeout: 10000 }, connections: 2, pipelining: 1 }) }
}

export async function requestTelemetryJson(
  url: string,
  route: TelemetryRoute,
  {
    method = 'GET',
    headers = {},
    body,
    signal,
    timeout = 10000,
    maxBytes = 65536,
  }: {
    method?: 'GET' | 'POST'
    headers?: Record<string, string>
    body?: string
    signal: AbortSignal
    timeout?: number
    maxBytes?: number
  },
) {
  const response = await request(url, {
    method,
    ...route,
    headers,
    body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    headersTimeout: timeout,
    bodyTimeout: timeout,
  })
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > maxBytes) {
      response.body.destroy()
      throw new Error('telemetry_response_too_large')
    }
    chunks.push(chunk)
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(response.statusCode === 401 ? 'telemetry_auth_failed' : 'telemetry_http_failed')
  }
  if (!bytes) return null
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown
  } catch {
    throw new Error('telemetry_response_invalid')
  }
}
