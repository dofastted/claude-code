import { expect, test } from 'bun:test'
import {
  AFK_MODE_SERVER_BETA,
  KIN_OFFICIAL_EXTRA_BETAS,
  KIN_OFFICIAL_MESSAGE_BETAS,
  mergeOfficialExtraBetas,
  withServerSafeguardBeta,
} from './officialBetas.ts'

test('official message betas match the 2.1.280 sdk-cli capture', () => {
  expect([...KIN_OFFICIAL_MESSAGE_BETAS]).toEqual([
    'claude-code-20250219',
    'oauth-2025-04-20',
    'interleaved-thinking-2025-05-14',
    'thinking-token-count-2026-05-13',
    'context-management-2025-06-27',
    'prompt-caching-scope-2026-01-05',
    'mid-conversation-system-2026-04-07',
    'advanced-tool-use-2025-11-20',
    'mid-conversation-system-clear-at-2026-08-21',
    'effort-2025-11-24',
    'thinking-binding-controls-2026-08-01',
    'extended-cache-ttl-2025-04-11',
    'cache-diagnosis-2026-04-07',
  ])
  expect(KIN_OFFICIAL_MESSAGE_BETAS).not.toContain('context-1m-2025-08-07')
  expect(KIN_OFFICIAL_EXTRA_BETAS).toContain('advanced-tool-use-2025-11-20')
  expect(KIN_OFFICIAL_EXTRA_BETAS).toContain('mid-conversation-system-clear-at-2026-08-21')
})

test('mergeOfficialExtraBetas uses capture order and does not duplicate', () => {
  const merged = mergeOfficialExtraBetas([
    'claude-code-20250219',
    'oauth-2025-04-20',
    'interleaved-thinking-2025-05-14',
    'context-management-2025-06-27',
    'prompt-caching-scope-2026-01-05',
    'effort-2025-11-24',
    'context-1m-2025-08-07',
  ])
  expect(merged.filter(b => b === 'effort-2025-11-24')).toHaveLength(1)
  expect(merged).toEqual([...KIN_OFFICIAL_MESSAGE_BETAS, 'context-1m-2025-08-07'])
})

test('mergeOfficialExtraBetas does not invent betas the caller never had', () => {
  const merged = mergeOfficialExtraBetas(['claude-code-20250219'])
  expect(merged).not.toContain('oauth-2025-04-20')
  expect(merged[0]).toBe('claude-code-20250219')
  expect(merged).toContain('cache-diagnosis-2026-04-07')
})

test('mergeOfficialExtraBetas keeps advanced-tool-use beside thinking-binding-controls', () => {
  const merged = mergeOfficialExtraBetas([
    'claude-code-20250219',
    'advanced-tool-use-2025-11-20',
  ])
  const advanced = merged.indexOf('advanced-tool-use-2025-11-20')
  const binding = merged.indexOf('thinking-binding-controls-2026-08-01')
  const clearAt = merged.indexOf('mid-conversation-system-clear-at-2026-08-21')
  expect(advanced).toBeGreaterThan(-1)
  expect(clearAt).toBe(advanced + 1)
  expect(binding).toBeGreaterThan(clearAt)
})

test('server safeguard beta is not in the default list and is appended once', () => {
  expect(KIN_OFFICIAL_MESSAGE_BETAS).not.toContain(AFK_MODE_SERVER_BETA)
  expect(KIN_OFFICIAL_EXTRA_BETAS).not.toContain(AFK_MODE_SERVER_BETA)
  const plain = mergeOfficialExtraBetas(['claude-code-20250219'])
  expect(plain).not.toContain(AFK_MODE_SERVER_BETA)
  const merged = mergeOfficialExtraBetas(withServerSafeguardBeta(['claude-code-20250219'], true))
  expect(merged.at(-1)).toBe(AFK_MODE_SERVER_BETA)
  expect(merged.filter((beta) => beta === AFK_MODE_SERVER_BETA)).toHaveLength(1)
  expect(withServerSafeguardBeta(['claude-code-20250219'], false)).toEqual(['claude-code-20250219'])
})
