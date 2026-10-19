import { expect, test } from 'bun:test'
import { APIConnectionError, APIConnectionTimeoutError, APIError } from '@anthropic-ai/sdk'
import { classifyKinJobError, EMPTY_STREAM_MESSAGE } from './jobError.ts'

function apiError(status: number | undefined, type: string, headers: Record<string, string> = {}) {
  return new APIError(status, { type: 'error', error: { type, message: `${type} body` } }, undefined, headers)
}

test('upstream HTTP errors keep their status and Anthropic type', () => {
  expect(classifyKinJobError(apiError(429, 'rate_limit_error', { 'retry-after': '30' }), { sawEvent: false })).toEqual({
    error: 'rate_limit_error body',
    code: 'upstream_rate_limit',
    status: 429,
    error_type: 'rate_limit_error',
    retry_after: '30',
  })
  expect(classifyKinJobError(apiError(401, 'authentication_error'), { sawEvent: false }).code).toBe(
    'upstream_auth_error',
  )
  expect(classifyKinJobError(apiError(403, 'permission_error'), { sawEvent: false }).error_type).toBe(
    'permission_error',
  )
  expect(classifyKinJobError(apiError(400, 'invalid_request_error'), { sawEvent: false }).code).toBe(
    'upstream_invalid_request',
  )
  expect(classifyKinJobError(apiError(500, 'overloaded_error'), { sawEvent: false })).toMatchObject({
    code: 'upstream_overloaded',
    status: 529,
  })
  expect(classifyKinJobError(apiError(504, 'api_error'), { sawEvent: false }).code).toBe('upstream_timeout')
  expect(classifyKinJobError(apiError(503, 'api_error'), { sawEvent: false })).toMatchObject({
    code: 'upstream_error',
    status: 503,
  })
})

test('connection failures split on whether the stream already started', () => {
  const reset = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })
  expect(classifyKinJobError(reset, { sawEvent: false }).code).toBe('upstream_network_error')
  expect(classifyKinJobError(reset, { sawEvent: true }).code).toBe('upstream_stream_interrupted')
  expect(classifyKinJobError(new APIConnectionError({ message: 'Connection error.' }), { sawEvent: false }).code).toBe(
    'upstream_network_error',
  )
  expect(classifyKinJobError(new APIConnectionTimeoutError(), { sawEvent: false })).toMatchObject({
    code: 'upstream_timeout',
    status: 504,
  })
})

test('empty stream, flattened assistant errors and internal failures', () => {
  expect(classifyKinJobError(new Error(EMPTY_STREAM_MESSAGE), { sawEvent: false }).code).toBe('upstream_empty_stream')
  expect(classifyKinJobError(null, { sawEvent: false, message: 'limit', sdkKind: 'rate_limit' })).toMatchObject({
    code: 'upstream_rate_limit',
    status: 429,
  })
  expect(classifyKinJobError(null, { sawEvent: false, message: 'connection_reset' }).code).toBe(
    'upstream_network_error',
  )
  expect(classifyKinJobError(new TypeError('x is not a function'), { sawEvent: false }).code).toBe('cli_error')
})
test('enabled cached microcompact without an implementation is a request error', () => {
  const error = new Error(
    'cached_microcompact_unavailable: enabled in kernel.json, but this CLI build has no cache-editing implementation',
  )
  expect(classifyKinJobError(error, { sawEvent: false })).toMatchObject({
    code: 'cached_microcompact_unavailable',
    status: 400,
    error_type: 'invalid_request_error',
  })
})

test('receiving an event does not turn a local CLI exception into an upstream failure', () => {
  for (const sawEvent of [false, true]) {
    expect(classifyKinJobError(new TypeError('internal value is not callable'), { sawEvent })).toMatchObject({
      code: 'cli_error',
      status: 502,
    })
  }
})

test('SDK SSE error bodies keep their upstream cause without an HTTP status', () => {
  for (const [type, code, status] of [
    ['api_error', 'upstream_error', 502],
    ['rate_limit_error', 'upstream_rate_limit', 429],
    ['overloaded_error', 'upstream_overloaded', 529],
  ] as const) {
    const encoded = JSON.stringify({ type: 'error', error: { type, message: `${type} body` } })
    const legacy = APIError.generate(undefined, `SSE Error: ${encoded}`, encoded, {})
    for (const error of [apiError(undefined, type), legacy]) {
      expect(classifyKinJobError(error, { sawEvent: true })).toMatchObject({
        code,
        status,
        error_type: type,
        error: `${type} body`,
      })
    }
  }
})

test('SSE status, original code, request id and retry delay remain diagnostic fields', () => {
  const encoded = JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'classifier unavailable', status: 503, code: 'classifier_busy', retry_after: '13', request_id: 'req_classifier' } })
  const error = APIError.generate(undefined, `SSE Error: ${encoded}`, encoded, {})
  expect(classifyKinJobError(error, { sawEvent: true })).toMatchObject({ status: 503, code: 'upstream_error', upstream_code: 'classifier_busy', retry_after: '13', request_id: 'req_classifier' })
})
