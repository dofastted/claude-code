import { expect, test } from 'bun:test'
import {
  extractErrorText,
  pickRateLimitHeaders,
  thinkingFromRequest,
} from './nativeMessagesRunner.ts'

test('thinkingFromRequest keeps adaptive display', () => {
  const out = thinkingFromRequest(
    { thinking: { type: 'adaptive', display: 'omitted' } },
    { type: 'disabled' },
  )
  expect(out).toEqual({ type: 'adaptive', display: 'omitted' })
})

test('thinkingFromRequest keeps enabled budget', () => {
  const out = thinkingFromRequest(
    { thinking: { type: 'enabled', budget_tokens: 8192 } },
    { type: 'disabled' },
  )
  expect(out).toEqual({ type: 'enabled', budgetTokens: 8192 })
})

test('thinkingFromRequest disabled stays disabled', () => {
  const out = thinkingFromRequest(
    { thinking: { type: 'disabled' } },
    { type: 'adaptive' },
  )
  expect(out).toEqual({ type: 'disabled' })
})

test('thinkingFromRequest ignores spawn adaptive when job omits thinking', () => {
  const out = thinkingFromRequest({}, { type: 'adaptive' })
  expect(out).toEqual({ type: 'disabled' })
})

test('pickRateLimitHeaders keeps Extra windows and drops noise', () => {
  const out = pickRateLimitHeaders({
    'Anthropic-Ratelimit-Unified-5h-Utilization': '0.81',
    'anthropic-ratelimit-unified-5h-reset': '2026-09-09T12:00:00Z',
    'retry-after': '12',
    'request-id': 'req_test',
    'set-cookie': 'secret',
    authorization: 'Bearer x',
  })
  expect(out).toEqual({
    'anthropic-ratelimit-unified-5h-utilization': '0.81',
    'anthropic-ratelimit-unified-5h-reset': '2026-09-09T12:00:00Z',
    'retry-after': '12',
    'request-id': 'req_test',
  })
})

test('extractErrorText prefers nested error message over system error', () => {
  expect(extractErrorText({ error: { message: 'other side closed' } })).toBe(
    'other side closed',
  )
  expect(extractErrorText({ message: { content: 'boom' } })).toBe('boom')
  expect(extractErrorText({ code: 'ECONNRESET' })).toBe('connection_reset')
  expect(extractErrorText({ type: 'assistant' })).toBe('api_error')
})
