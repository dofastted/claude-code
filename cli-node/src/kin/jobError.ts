/**
 * Turns whatever ended a kin job into one structured `kin_job_error`.
 *
 * The kernel forwards these fields verbatim and Node maps `code` to the client
 * error. Before this, the frame carried text only and every failure surfaced as
 * `incomplete_response`.
 */
import { APIConnectionError, APIConnectionTimeoutError, APIError } from '@anthropic-ai/sdk'
import { isStaleConnectionError } from './staleConnection.js'

export type KinJobErrorCode =
  | 'upstream_rate_limit'
  | 'upstream_auth_error'
  | 'upstream_invalid_request'
  | 'upstream_overloaded'
  | 'upstream_timeout'
  | 'upstream_error'
  | 'upstream_network_error'
  | 'upstream_stream_interrupted'
  | 'upstream_empty_stream'
  | 'cli_error'

export type KinJobErrorFields = {
  error: string
  code: KinJobErrorCode
  status: number
  error_type: string
  retry_after?: string
  upstream_code?: string
  request_id?: string
}

export const EMPTY_STREAM_MESSAGE = 'Stream ended without receiving any events'

const NETWORK_CODE =
  /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_\w+|ERR_STREAM_\w+)$/i
const NETWORK_TEXT =
  /fetch failed|network|socket|terminated|other side closed|connection[ _](?:reset|refused|closed)|proxy|tunnel|ECONN\w+|ENOTFOUND|EAI_AGAIN/i
const TIMEOUT_CODE = /^(ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)$/i

function field(value: unknown, key: string): unknown {
  if (value == null || typeof value !== 'object' || !(key in value)) return undefined
  return (value as Record<string, unknown>)[key]
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function clip(message: string): string {
  return message.slice(0, 300)
}

function headerOf(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  const get = field(headers, 'get')
  if (typeof get === 'function') {
    return text((get as (key: string) => unknown).call(headers, name)) || undefined
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === name) return text(value) || undefined
  }
  return undefined
}

function fromApiError(body: unknown, status: number | undefined, raw: string, headers?: unknown): KinJobErrorFields {
  // Anthropic error body is `{type:'error', error:{type, message}}`; the SDK keeps it on `error.error`.
  const inner = field(body, 'error') ?? body
  const type = text(field(inner, 'type'))
  const declaredStatus = field(inner, 'status')
  if (status === undefined && typeof declaredStatus === 'number' && declaredStatus >= 400 && declaredStatus < 600) status = declaredStatus
  // SDK errors emitted inside SSE have no HTTP status; use their declared type.
  if (status === undefined) {
    switch (type) {
      case 'rate_limit_error':
        status = 429
        break
      case 'authentication_error':
        status = 401
        break
      case 'permission_error':
        status = 403
        break
      case 'invalid_request_error':
        status = 400
        break
      case 'timeout_error':
        status = 504
        break
      default:
        status = 502
    }
  }
  const message = clip(text(field(inner, 'message')) || raw || `upstream HTTP ${status}`)
  const retryAfter = headerOf(headers, 'retry-after') || text(field(inner, 'retry_after'))
  const upstreamCode = text(field(inner, 'code')).slice(0, 100)
  const requestId = (headerOf(headers, 'request-id') || text(field(inner, 'request_id')) || text(field(body, 'request_id'))).slice(0, 200)
  const base = { error: message, status, ...(retryAfter ? { retry_after: retryAfter } : {}), ...(upstreamCode ? { upstream_code: upstreamCode } : {}), ...(requestId ? { request_id: requestId } : {}) }
  if (status === 529 || type === 'overloaded_error') {
    return { ...base, status: 529, code: 'upstream_overloaded', error_type: 'overloaded_error' }
  }
  if (status === 429) return { ...base, code: 'upstream_rate_limit', error_type: 'rate_limit_error' }
  if (status === 401) return { ...base, code: 'upstream_auth_error', error_type: 'authentication_error' }
  if (status === 403) return { ...base, code: 'upstream_auth_error', error_type: type || 'permission_error' }
  if (status === 408 || status === 504) {
    return { ...base, status: 504, code: 'upstream_timeout', error_type: 'timeout_error' }
  }
  if (status < 500) {
    return { ...base, code: 'upstream_invalid_request', error_type: type || 'invalid_request_error' }
  }
  return { ...base, code: 'upstream_error', error_type: type || 'api_error' }
}

function legacySseErrorBody(error: APIConnectionError): unknown {
  // SDK 0.39 generates APIConnectionError for SSE error events because their
  // HTTP status is absent. Its cause retains the exact decoder payload.
  const cause = text(field(field(error, 'cause'), 'message'))
  const prefix = 'SSE Error: '
  if (!cause.startsWith(prefix)) return undefined
  try {
    const body: unknown = JSON.parse(cause.slice(prefix.length))
    return field(body, 'type') === 'error' ? body : undefined
  } catch {
    // Malformed SSE data keeps the original SDK failure below.
    return undefined
  }
}

/** SDKAssistantMessageError enum, for assistant error messages that carry no raw error. */
function fromSdkKind(kind: string, message: string): KinJobErrorFields | null {
  const error = clip(message || kind)
  switch (kind) {
    case 'rate_limit':
      return { error, code: 'upstream_rate_limit', status: 429, error_type: 'rate_limit_error' }
    case 'authentication_failed':
      return { error, code: 'upstream_auth_error', status: 401, error_type: 'authentication_error' }
    case 'billing_error':
      return { error, code: 'upstream_auth_error', status: 403, error_type: 'permission_error' }
    case 'invalid_request':
      return { error, code: 'upstream_invalid_request', status: 400, error_type: 'invalid_request_error' }
    case 'server_error':
      return { error, code: 'upstream_error', status: 502, error_type: 'api_error' }
    default:
      return null
  }
}

/**
 * `error` is the raw failure when one is known (thrown, or captured before the
 * CLI turned it into an assistant message). `sawEvent` says whether any SSE
 * event already reached the kernel for this job.
 */
export function classifyKinJobError(
  error: unknown,
  { sawEvent, message = '', sdkKind = '' }: { sawEvent: boolean; message?: string; sdkKind?: string },
): KinJobErrorFields {
  const raw = error instanceof Error ? error.message.trim() : text(field(error, 'message'))
  const msg = clip(raw || message)
  if (error instanceof APIError && !(error instanceof APIConnectionError)) {
    return fromApiError(field(error, 'error'), error.status, raw, field(error, 'headers'))
  }
  if (error instanceof APIConnectionError) {
    const body = legacySseErrorBody(error)
    if (body) return fromApiError(body, undefined, raw)
  }
  if (raw === EMPTY_STREAM_MESSAGE || message === EMPTY_STREAM_MESSAGE) {
    return { error: EMPTY_STREAM_MESSAGE, code: 'upstream_empty_stream', status: 502, error_type: 'api_error' }
  }
  const sysCode = text(field(error, 'code')) || text(field(field(error, 'cause'), 'code'))
  if (
    error instanceof APIConnectionTimeoutError ||
    TIMEOUT_CODE.test(sysCode) ||
    (error instanceof APIConnectionError && /timeout|timed out/i.test(msg))
  ) {
    return { error: msg || 'upstream timeout', code: 'upstream_timeout', status: 504, error_type: 'timeout_error' }
  }
  if (
    error instanceof APIConnectionError ||
    isStaleConnectionError(error) ||
    NETWORK_CODE.test(sysCode) ||
    NETWORK_TEXT.test(msg)
  ) {
    return {
      error: msg || 'upstream connection failed',
      code: sawEvent ? 'upstream_stream_interrupted' : 'upstream_network_error',
      status: 502,
      error_type: 'api_error',
    }
  }
  const sdk = error == null ? fromSdkKind(sdkKind, message) : null
  if (sdk) return sdk
  return { error: msg || 'cli error', code: 'cli_error', status: 502, error_type: 'api_error' }
}
