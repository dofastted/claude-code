import { expect, test } from 'bun:test'
import { mergeOfficialExtraBetas } from './officialBetas.ts'

test('merging explicit betas preserves credential and feature opt-ins without duplication', () => {
  const result = mergeOfficialExtraBetas([
    'claude-code-20250219',
    'caller-feature',
    'advanced-tool-use-2025-11-20',
    'caller-feature',
  ])
  expect(result).toContain('caller-feature')
  expect(result.filter((beta) => beta === 'caller-feature')).toHaveLength(1)
  expect(result).toContain('advanced-tool-use-2025-11-20')
  expect(result).not.toContain('oauth-2025-04-20')
  expect(result).not.toContain('thinking-binding-controls-2026-08-01')
  expect(result).not.toContain('cache-diagnosis-2026-04-07')
})
