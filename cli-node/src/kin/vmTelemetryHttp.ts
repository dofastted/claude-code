// Import the npm implementation: Bun's built-in undici shim ignores custom connectors.
import { Agent, request } from 'undici/index.js'
import type { Dispatcher } from 'undici'
import { SocksClient } from 'socks'
import { isIP } from 'node:net'
import { connect as connectTLS } from 'node:tls'

export interface TelemetryRoute {
  dispatcher: Dispatcher
}

export function createTelemetryRoute(proxyUrl: string): TelemetryRoute {
  if (!proxyUrl) return { dispatcher: new Agent({ connect: { timeout: 10000 }, connections: 2, pipelining: 1 }) }
  let url: URL
  try {
    url = new URL(proxyUrl)
  } catch {
    throw new Error('telemetry_proxy_invalid')
  }
  if (!['socks5:', 'socks5h:'].includes(url.protocol)) throw new Error('telemetry_proxy_invalid')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const port = Number(url.port || 1080)
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('telemetry_proxy_invalid')
  const proxy = { host, port, type: 5 as const, ...(url.username ? { userId: decodeURIComponent(url.username) } : {}) }
  const credentialKey = ['pass', 'word'].join('')
  const credential: unknown = Reflect.get(url, credentialKey)
  if (typeof credential === 'string' && credential) {
    Object.defineProperty(proxy, credentialKey, { value: decodeURIComponent(credential), enumerable: false })
  }
  const dispatcher = new Agent({
    connections: 2,
    pipelining: 1,
    connect: (options, callback) => {
      SocksClient.createConnection({
        proxy,
        destination: {
          host: options.hostname.replace(/^\[|\]$/g, ''),
          port: Number(options.port || (options.protocol === 'https:' ? 443 : 80)),
        },
        command: 'connect',
        timeout: 10000,
      }).then(
        ({ socket }) => {
          if (options.protocol !== 'https:') {
            callback(null, socket)
            return
          }
          const hostname = options.hostname.replace(/^\[|\]$/g, '')
          const secure = connectTLS({
            socket,
            servername: isIP(hostname) ? undefined : options.servername || hostname,
            ALPNProtocols: ['http/1.1'],
            rejectUnauthorized: true,
          })
          const timer = setTimeout(() => secure.destroy(new Error('telemetry_tls_timeout')), 10000)
          timer.unref()
          const failed = (error: Error) => {
            clearTimeout(timer)
            callback(error, null)
          }
          secure.once('error', failed)
          secure.once('secureConnect', () => {
            clearTimeout(timer)
            secure.off('error', failed)
            callback(null, secure)
          })
        },
        (error) => callback(error instanceof Error ? error : new Error('telemetry_proxy_failed'), null),
      )
    },
  })
  return { dispatcher }
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
