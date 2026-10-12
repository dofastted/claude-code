import { expect, test } from 'bun:test'
import { assembleMessageRequest } from './requestBody.js'
import { withRequestProtocolBetas } from '../../../../../src/lib/protocol/claude-code-betas.mjs'

function generatedInput() {
  return {
    model: 'claude-sonnet-5-5',
    messages: [{ role: 'user' as const, content: 'hello' }],
    system: [{ type: 'text', text: 'custom billing and caller system' }],
    tools: [],
    metadata: { user_id: 'worker-owned-identity' },
    betas: [],
    max_tokens: 128000,
    thinking: { type: 'adaptive' },
    context_management: {
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    },
    extraBodyParams: {},
    outputConfig: {},
  }
}

test('thread continuation does not replace inherited tools or add context edits', () => {
  const body = assembleMessageRequest({
    ...generatedInput(),
    wireBody: { thread: { type: 'continue', previous_message_id: 'msg_prior' } },
  })
  expect(Object.hasOwn(body, 'tools')).toBe(false)
  expect(Object.hasOwn(body, 'context_management')).toBe(false)
  expect(Object.hasOwn(body, 'thinking')).toBe(false)
})

test('explicit empty arrays and null context remain different from omission', () => {
  const body = assembleMessageRequest({
    ...generatedInput(),
    wireBody: { tools: [], stop_sequences: [], context_management: null },
  })
  expect(Object.hasOwn(body, 'tools')).toBe(true)
  expect(body.tools).toEqual([])
  expect(Object.hasOwn(body, 'stop_sequences')).toBe(true)
  expect(body.stop_sequences).toEqual([])
  expect(body.context_management).toBeNull()
})

test('native fields do not replace generated identity or expose local controls', () => {
  const wire = Object.freeze({
    model: 'caller-model',
    metadata: { user_id: 'caller-identity' },
    request_context: { purpose: 'local-only' },
    wireMessages: ['local-only'],
    diagnostics: { previous_message_id: null },
  })
  const body = assembleMessageRequest({ ...generatedInput(), wireBody: wire })
  expect(body.metadata).toEqual({ user_id: 'worker-owned-identity' })
  expect(Object.hasOwn(body, 'request_context')).toBe(false)
  expect(Object.hasOwn(body, 'wireMessages')).toBe(false)
  expect(body.diagnostics).toEqual({ previous_message_id: null })
})

test('explicit extra body retains owned overrides while caller extras take precedence', () => {
  const body = assembleMessageRequest({
    ...generatedInput(),
    extraBodyParams: {
      thinking: { type: 'disabled' },
      context_management: { edits: [] },
      thread: { type: 'create' },
    },
    wireBody: {
      thinking: { type: 'adaptive' },
      thread: { type: 'continue', previous_message_id: 'msg_prior' },
    },
  })
  expect(body.thinking).toEqual({ type: 'disabled' })
  expect(body.context_management).toEqual({ edits: [] })
  expect(body.thread).toEqual({ type: 'continue', previous_message_id: 'msg_prior' })
})

test('resolved output config wins and native speed is not replaced by local fast mode', () => {
  const body = assembleMessageRequest({
    ...generatedInput(),
    extraBodyParams: { output_config: { effort: 'low' } },
    wireBody: { output_config: { effort: 'xhigh' }, speed: 'standard' },
    outputConfig: { effort: 'xhigh', format: { type: 'json_schema', schema: {} } },
    speed: 'fast',
  })
  expect(body.output_config).toEqual({
    effort: 'xhigh',
    format: { type: 'json_schema', schema: {} },
  })
  expect(body.speed).toBe('standard')
})

test('ordinary requests retain generated tools and context management', () => {
  const input = generatedInput()
  const body = assembleMessageRequest(input)
  expect(Object.hasOwn(body, 'tools')).toBe(true)
  expect(body.context_management).toEqual({
    edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
  })
})

test('native wire messages keep empty system effort controls and top-level effort', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Reply OK.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'OK.' }] },
    { role: 'system', content: [], output_config: { effort: 'medium' } },
    { role: 'user', content: [{ type: 'text', text: 'Reply OK again.' }] },
  ]
  const body = assembleMessageRequest({
    ...generatedInput(),
    model: 'claude-opus-5-5',
    messages,
    outputConfig: { effort: 'high' },
    wireBody: {
      output_config: { effort: 'high' },
      messages,
    },
  })
  expect(body.output_config).toEqual({ effort: 'high' })
  expect(body.messages).toEqual(messages)
  const betas = withRequestProtocolBetas([], body)
  expect(betas).toContain('mid-conversation-output-config-2026-07-01')
  expect(betas).toContain('effort-2025-11-24')
})
