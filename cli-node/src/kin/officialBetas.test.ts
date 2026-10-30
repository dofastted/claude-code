import { expect, test } from 'bun:test'

import { THINKING_TOKEN_COUNT_BETA_HEADER } from '../constants/betas.ts'
import { clearBetasCaches, getMergedBetas } from '../utils/betas.ts'
import { mergeOfficialExtraBetas } from './officialBetas.ts'
const SONNET_303 = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  THINKING_TOKEN_COUNT_BETA_HEADER,
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'per-turn-control-2026-07-01',
  'mid-conversation-tool-changes-2026-07-01',
  'advanced-tool-use-2025-11-20',
  'mid-conversation-system-clear-at-2026-08-21',
  'effort-2025-11-24',
  'thinking-binding-controls-2026-08-01',
  'extended-cache-ttl-2025-04-11',
  'cache-diagnosis-2026-04-07',
]

const HAIKU_303 = [...SONNET_303.slice(1, 6), SONNET_303[0], ...SONNET_303.slice(6)]

const AUTO_303 = SONNET_303.filter((beta) => beta !== 'per-turn-control-2026-07-01')

test('303 print betas match the captured haiku, sonnet, opus, fable, and auto arrays', () => {
  const previous = {
    user: process.env.USER_TYPE,
    entry: process.env.CLAUDE_CODE_ENTRYPOINT,
    base: process.env.ANTHROPIC_BASE_URL,
    token: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    experimental: process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS,
    interleaved: process.env.DISABLE_INTERLEAVED_THINKING,
  }
  process.env.USER_TYPE = 'external'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli'
  process.env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN || 'test-token'
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  delete process.env.DISABLE_INTERLEAVED_THINKING
  clearBetasCaches()
  try {
    const selected = (model: string) =>
      mergeOfficialExtraBetas(getMergedBetas(model, { isAgenticQuery: true }), model)
    const haiku = selected('claude-haiku-5-5')
    expect(haiku[5]).toBe('claude-code-20250219')
    expect(haiku.slice(0, 6)).toEqual(HAIKU_303.slice(0, 6))
    for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']) {
      const got = selected(model)
      expect(got[0]).toBe('claude-code-20250219')
      expect(got.slice(0, 6)).toEqual(SONNET_303.slice(0, 6))
    }
    const auto = selected('auto')
    expect(auto.slice(0, 6)).toEqual(AUTO_303.slice(0, 6))
    expect(auto.includes('per-turn-control-2026-07-01')).toBe(false)
  } finally {
    clearBetasCaches()
    for (const [key, value] of [
      ['USER_TYPE', previous.user],
      ['CLAUDE_CODE_ENTRYPOINT', previous.entry],
      ['ANTHROPIC_BASE_URL', previous.base],
      ['CLAUDE_CODE_OAUTH_TOKEN', previous.token],
      ['CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', previous.experimental],
      ['DISABLE_INTERLEAVED_THINKING', previous.interleaved],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})



test('merging keeps caller opt-ins in the captured order', () => {
  const result = mergeOfficialExtraBetas([
    'claude-code-20250219',
    'caller-feature',
    'advanced-tool-use-2025-11-20',
    'per-turn-control-2026-07-01',
    'caller-feature',
  ])
  expect(result.filter((beta) => beta === 'caller-feature')).toHaveLength(1)
  expect(result.slice(0, 2)).toEqual(['claude-code-20250219', 'per-turn-control-2026-07-01'])
  expect(result.indexOf('advanced-tool-use-2025-11-20')).toBeLessThan(result.indexOf('caller-feature'))
  expect(result.includes('oauth-2025-04-20')).toBe(false)
  expect(result.at(-1)).toBe('caller-feature')
})
