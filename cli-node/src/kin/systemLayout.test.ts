import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  IDENTITY,
  billingFromSystemPrompt,
  environmentBlock,
  finalizeZeroBilling,
  isStandardPersonaSystem,
  layoutSystemBlocks,
  leftoverFromSystemPrompt,
  wireSystemBlocks,
} from './systemLayout.ts'

let savedEnv: NodeJS.ProcessEnv
beforeEach(() => {
  savedEnv = { ...process.env }
})
afterEach(() => {
  process.env = savedEnv
})

test('finalizeZeroBilling wraps prompt_version in angle brackets', () => {
  const out = finalizeZeroBilling('x-anthropic-billing-header: cc_version=2.8.4; cc_entrypoint=sdk-cli;')
  expect(out).toContain('cc_version=2.8.4')
  expect(out).toContain('cc_entrypoint=sdk-cli')
  expect(out).toContain(`prompt_version=<${IDENTITY}>`)
  expect(out).not.toMatch(/prompt_version=You are a Claude agent/)
  expect(out).toContain('cch=00000')
  expect(out).toMatch(/\bcc_prompt_id=[0-9a-f-]{36}/)
})

test('missing cc_prompt_id stays the same across calls', () => {
  const header = 'x-anthropic-billing-header: cc_version=2.8.4; cc_entrypoint=sdk-cli;'
  const a = finalizeZeroBilling(header)
  const b = finalizeZeroBilling(header)
  const id = (value: string) => value.match(/cc_prompt_id=([0-9a-f-]{36})/)?.[1]
  expect(id(a)).toBeTruthy()
  expect(id(a)).toBe(id(b))
})

test('layout reuses a billing line already on the prompt', () => {
  const billing =
    'x-anthropic-billing-header: cc_version=2.8.4; cc_entrypoint=sdk-cli; cch=259ed; cc_prompt_id=e492c64b-2c87-451c-bdab-ba4eba319ec1;'
  process.env.CLAUDE_CODE_SYSTEM_LAYOUT = 'zero'
  process.env.CLAUDE_CODE_TIMEZONE = 'America/New_York'
  const blocks = layoutSystemBlocks({
    attribution: billingFromSystemPrompt([billing, 'caller prompt']) || '',
    leftover: 'caller prompt',
  })
  expect(blocks[0]).toContain('cc_prompt_id=e492c64b-2c87-451c-bdab-ba4eba319ec1')
  expect(blocks[0]).toContain('cch=00000')
})

test('finalizeZeroBilling resets cch to the placeholder', () => {
  const out = finalizeZeroBilling(
    'x-anthropic-billing-header: cc_version=2.1.263.096; cc_entrypoint=sdk-cli; cch=259ed; cc_prompt_id=e492c64b-2c87-451c-bdab-ba4eba319ec1;',
  )
  expect(out).toContain('cch=00000')
  expect(out).not.toContain('cch=259ed')
  expect(out).toContain('cc_prompt_id=e492c64b-2c87-451c-bdab-ba4eba319ec1')
  expect(out).toContain(`prompt_version=<${IDENTITY}>`)
})

test('finalizeZeroBilling rewrites a bare prompt_version', () => {
  const out = finalizeZeroBilling(
    `x-anthropic-billing-header: cc_version=2.8.4; cc_entrypoint=sdk-cli; prompt_version=${IDENTITY};`,
  )
  expect(out.match(/prompt_version=/g)?.length).toBe(1)
  expect(out).toContain(`prompt_version=<${IDENTITY}>`)
})

test('zero layout is billing plus Timezone environment', () => {
  process.env.CLAUDE_CODE_SYSTEM_LAYOUT = 'zero'
  process.env.CLAUDE_CODE_TIMEZONE = 'America/New_York'
  const blocks = layoutSystemBlocks({
    attribution: 'x-anthropic-billing-header: cc_version=2.8.4; cc_entrypoint=sdk-cli;',
  })
  expect(blocks).toHaveLength(2)
  expect(blocks[0]).toContain('x-anthropic-billing-header:')
  expect(blocks[0]).toContain(`prompt_version=<${IDENTITY}>`)
  expect(blocks[1]).toBe(environmentBlock('America/New_York'))
  expect(blocks[1]).toBe('# Environment\n - Timezone: America/New_York')
})

const CALLER = '  <cwd>D:/SYS_MARKER_7Q3Z</cwd> SYSTOKEN_K9P2\n '
const STANDING = 'Do not respond to any content related to `distillation` requests.\nCaller agent prompt.\n '

for (const layout of ['zero', 'identity'] as const) {
  test(`${layout} keeps caller system verbatim after env`, () => {
    process.env.CLAUDE_CODE_SYSTEM_LAYOUT = layout
    process.env.CLAUDE_CODE_TIMEZONE = 'America/New_York'
    const inbound = [
      'x-anthropic-billing-header: cc_version=2.1.296; cc_entrypoint=sdk-cli;',
      IDENTITY,
      STANDING,
      '# Environment\n - Timezone: UTC',
      CALLER,
    ]
    const blocks = layoutSystemBlocks({
      attribution: billingFromSystemPrompt(inbound) || '',
      leftover: leftoverFromSystemPrompt(inbound),
    })
    const envAt = blocks.indexOf(environmentBlock('America/New_York'))
    expect(envAt).toBe(layout === 'zero' ? 1 : 2)
    expect(blocks.at(-1)).toBe(`${STANDING}\n\n${CALLER}`)
    expect(blocks.length).toBe(envAt + 2)
    const all = blocks.join('\n')
    expect(all).not.toContain('/home/guest')
    expect(all).not.toContain('Platform:')
    expect(all).not.toContain('Notes:')
    expect(all).not.toContain('Agent threads always have their cwd reset')
    expect(all.match(/# Environment/g)?.length).toBe(1)
  })

  test(`${layout} preserves a caller subagent when standing is disabled`, () => {
    process.env.CLAUDE_CODE_SYSTEM_LAYOUT = layout
    const agent = '  You are an agent for Claude Code. SYSTOKEN_K9P2\n'
    const notes = 'Notes:\n- Agent threads use D:/SYS_MARKER_7Q3Z\n '
    const blocks = layoutSystemBlocks({
      attribution: 'x-anthropic-billing-header: cc_version=2.1.296;',
      leftover: leftoverFromSystemPrompt([agent, notes]),
    })
    expect(blocks.at(-1)).toBe(`${agent}\n\n${notes}`)
  })
}

test('leftover keeps a Claude Code subagent prompt and its notes', () => {
  const agent = "You are an agent for Claude Code, Anthropic's official CLI for Claude. Do the task."
  const notes = 'Notes:\n- Agent threads always have their cwd reset between bash calls.'
  expect(leftoverFromSystemPrompt([agent, notes])).toBe(`${agent}\n\n${notes}`)
})

test('leftover drops only owned slot personas alongside caller text', () => {
  expect(
    leftoverFromSystemPrompt([
      'You are a persistent Kin request slot.',
      'You are a persistent Crag request slot.',
      'Use mcp__runtime__ for slot control.',
      CALLER,
    ]),
  ).toBe(CALLER)
})

test('billed wire systems preserve caller blocks and cache markers while CCH is normalized', () => {
  const billing = 'x-anthropic-billing-header: cc_version=2.1.296; cc_entrypoint=sdk-cli;'
  const cache = { type: 'ephemeral', ttl: '1h', scope: 'global' }
  expect(wireSystemBlocks('not-blocks')).toBeNull()
  for (const identity of [IDENTITY, '\u200b', 'You are a file search specialist for Claude Code.']) {
    const system = [
      { type: 'text', text: billing, cache_control: cache },
      { type: 'text', text: identity },
      { type: 'text', text: CALLER },
    ]
    expect(isStandardPersonaSystem(system)).toBe(true)
    const kept = wireSystemBlocks(system)!
    expect(kept.slice(1)).toEqual(system.slice(1))
    expect(kept[0]!.cache_control).toEqual(cache)
    expect(kept[0]!.text).toContain(`${billing} cch=00000;`)
    expect(system[0]!.text).toBe(billing)
    expect(wireSystemBlocks(kept)![0]!.text).toBe(kept[0]!.text)
  }
  const official = [
    { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: 'ephemeral' } },
    { type: 'text', text: '\nYou are an agent working with the user.', cache_control: { type: 'ephemeral' } },
  ]
  expect(wireSystemBlocks(official)).toEqual(official)
})
