/**
 * Dead keep-alive / HTTP2 sockets after egress idle-close.
 * Must not require Anthropic SDK types — native_messages errors are plain objects.
 */
const STALE_CODE = /^(ECONNRESET|EPIPE|UND_ERR_SOCKET|ERR_STREAM_DESTROYED)$/i
const STALE_HAY =
  /socket hang up|connection reset|other side closed|ECONNRESET|EPIPE|UND_ERR_SOCKET|ERR_STREAM_DESTROYED|ECONNREFUSED/i

export function isStaleConnectionHay(hay: string): boolean {
  return STALE_HAY.test(hay)
}

function fieldString(value: unknown, key: string): string {
  if (value == null || typeof value !== 'object' || !(key in value)) return ''
  const raw = (value as Record<string, unknown>)[key]
  if (raw == null) return ''
  return String(raw)
}

export function isStaleConnectionError(error: unknown): boolean {
  if (error == null) return false
  if (STALE_CODE.test(fieldString(error, 'code'))) return true
  const cause =
    error != null && typeof error === 'object' && 'cause' in error
      ? error.cause
      : undefined
  if (STALE_CODE.test(fieldString(cause, 'code'))) return true
  const nested =
    error != null && typeof error === 'object' && 'error' in error
      ? error.error
      : undefined
  const hay = [
    error instanceof Error ? error.message : fieldString(error, 'message'),
    fieldString(error, 'code'),
    cause instanceof Error ? cause.message : fieldString(cause, 'message'),
    fieldString(cause, 'code'),
    nested instanceof Error ? nested.message : fieldString(nested, 'message'),
  ]
    .filter(Boolean)
    .join(' ')
  return isStaleConnectionHay(hay)
}
