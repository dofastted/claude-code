import { expect, test } from 'bun:test'
import {
  isStaleConnectionError,
  isStaleConnectionHay,
} from './staleConnection.ts'

test('stale hay matches reset and undici socket close', () => {
  expect(isStaleConnectionHay('ECONNRESET')).toBe(true)
  expect(isStaleConnectionHay('UND_ERR_SOCKET other side closed')).toBe(true)
  expect(isStaleConnectionHay('socket hang up')).toBe(true)
  expect(isStaleConnectionHay('invalid_request_error')).toBe(false)
})

test('isStaleConnectionError reads code and nested cause', () => {
  expect(isStaleConnectionError({ code: 'ECONNRESET' })).toBe(true)
  expect(isStaleConnectionError({ code: 'UND_ERR_SOCKET' })).toBe(true)
  expect(isStaleConnectionError({ cause: { code: 'EPIPE' } })).toBe(true)
  expect(
    isStaleConnectionError(new Error('fetch failed: other side closed')),
  ).toBe(true)
  expect(isStaleConnectionError({ message: '400 invalid_request_error' })).toBe(
    false,
  )
})
