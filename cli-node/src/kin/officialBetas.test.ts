import { expect, test } from 'bun:test'
import { OFFICIAL_MESSAGE_BETAS, mergeOfficialExtraBetas } from './officialBetas.ts'

test('merging keeps caller opt-ins and fills the official remainder', () => {
  const result = mergeOfficialExtraBetas([
    'claude-code-20250219',
    'caller-feature',
    'advanced-tool-use-2025-11-20',
    'caller-feature',
  ])
  expect(result.filter((beta) => beta === 'caller-feature')).toHaveLength(1)
  expect(result).toContain('oauth-2025-04-20')
  expect(result).toContain('thinking-binding-controls-2026-08-01')
  expect(result).toContain('cache-diagnosis-2026-04-07')
  const official = result.filter((beta) => OFFICIAL_MESSAGE_BETAS.includes(beta))
  expect(official).toEqual([...OFFICIAL_MESSAGE_BETAS])
  expect(result.at(-1)).toBe('caller-feature')
})
