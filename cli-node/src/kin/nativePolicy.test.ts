import { expect, test } from 'bun:test'
import { assembledRequest, queryKinMessagesWithStreaming, queryModelWithStreaming } from '../services/api/claude.ts'
import { createUserMessage } from '../utils/messages.ts'

async function capture(wire: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  let captured: Record<string, unknown> | undefined
  assembledRequest.current = (params) => {
    captured = params
    throw new Error('stop-before-upstream')
  }
  const previous = process.env.ANTHROPIC_BASE_URL
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
  process.env.CLAUDE_CODE_SKIP_VCR = '1'
  process.env.ANTHROPIC_API_KEY = 'test-key'
  const original = structuredClone(wire)
  try {
    const stream = queryKinMessagesWithStreaming({
      system: ['caller'],
      messages: [createUserMessage({ content: 'hello' })],
      toolSchemas: [],
      thinking: (wire.thinking as { type: 'adaptive' | 'enabled' | 'disabled' }) || { type: 'adaptive' },
      model: String(wire.model),
      signal: AbortSignal.abort(),
      wireSystem: [{ type: 'text', text: 'caller' }],
      wireMessages: [{ role: 'user', content: 'hello' }],
      wireBody: wire,
      wireThinking: Object.hasOwn(original, 'thinking') ? original.thinking : undefined,
      toolChoice: wire.tool_choice as { type: 'auto' } | undefined,
      outputConfig: wire.output_config as Record<string, unknown> | undefined,
      contextManagement: wire.context_management,
      temperature: typeof wire.temperature === 'number' ? wire.temperature : undefined,
      toolSchemas: Array.isArray(wire.tools) ? wire.tools as [] : [],
      topK: typeof wire.top_k === 'number' ? wire.top_k : undefined,
      ...extra,
    })
    for await (const _event of stream) {
      // The observer throws before the request leaves the process.
    }
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('stop-before-upstream')) throw error
  } finally {
    assembledRequest.current = undefined
    delete process.env.CLAUDE_CODE_SKIP_VCR
    delete process.env.ANTHROPIC_API_KEY
    if (previous == null) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = previous
  }
  return captured
}

test('legacy Haiku thinking is disabled and Haiku 5.5 stays explicit', async () => {
  const legacy = await capture({ model: 'claude-3-5-haiku-latest', thinking: { type: 'enabled', budget_tokens: 2048 } })
  expect(legacy?.thinking).toEqual({ type: 'disabled' })
  const current = await capture({ model: 'claude-haiku-5-5', thinking: { type: 'adaptive' } })
  expect(current?.thinking).toEqual({ type: 'adaptive' })
})

test('Haiku 5.5 keeps disabled thinking unless effort is xhigh or max', async () => {
  const high = await capture({
    model: 'claude-haiku-5-5',
    thinking: { type: 'disabled', display: 'summarized' },
    output_config: { effort: 'high' },
  })
  expect(high?.thinking).toEqual({ type: 'disabled', display: 'summarized' })
  const blocked = await capture({
    model: 'claude-haiku-5-5',
    thinking: { type: 'disabled', display: 'summarized' },
    output_config: { effort: 'xhigh' },
  })
  expect(blocked?.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
  const max = await capture({
    model: 'claude-haiku-5-5',
    thinking: { type: 'disabled' },
    output_config: { effort: 'max' },
  })
  expect(max?.thinking).toEqual({ type: 'adaptive' })
})

test('Opus and Sonnet 5.5 rewrite legacy thinking and forced tool choice', async () => {
  const body = await capture({
    model: 'claude-opus-5-5',
    thinking: { type: 'enabled', budget_tokens: 2048, display: 'summarized' },
    tool_choice: { type: 'tool', name: 'Read' },
    tools: [
      { name: 'Read', input_schema: { type: 'object' } },
      { name: 'Computer', type: 'computer_20251124' },
    ],
  })
  expect(body?.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
  expect(body?.tool_choice).toEqual({ type: 'auto' })
  expect(body?.tools).toEqual([
    { name: 'Read', input_schema: { type: 'object' }, strict: true },
    { name: 'Computer', type: 'computer_toolset_20260801' },
  ])
})

test('unsupported native effort stays omitted and explicit sampling fields stay', async () => {
  const missing = await capture({ model: 'claude-sonnet-4-5' })
  expect(missing?.output_config).toBeUndefined()
  const explicit = await capture({
    model: 'claude-sonnet-4-5',
    output_config: { effort: 'high' },
    temperature: 0.2,
    top_p: 0.8,
    top_k: 12,
    context_management: { edits: [] },
  })
  expect(explicit?.output_config).toEqual({ effort: 'high' })
  expect(explicit?.temperature).toBe(0.2)
  expect(explicit?.top_p).toBe(0.8)
  expect(explicit?.top_k).toBe(12)
  expect(explicit?.context_management).toEqual({ edits: [] })
})

test('native omitted effort uses the catalog default on the assembled body', async () => {
  const cases: Array<[string, string | undefined]> = [
    ['claude-sonnet-5', 'high'],
    ['claude-opus-5', 'high'],
    ['claude-opus-4-8', 'high'],
    ['claude-opus-4-6', 'high'],
    ['claude-opus-4-7', 'xhigh'],
    ['claude-haiku-5-5', 'medium'],
    ['claude-sonnet-5-5', 'medium'],
    ['claude-opus-5-5', 'medium'],
    ['claude-fable-5', 'high'],
    ['claude-mythos-5-1', 'high'],
    ['claude-haiku-4-5', undefined],
    ['claude-sonnet-4-5', undefined],
  ]
  for (const [model, effort] of cases) {
    const body = await capture({ model })
    expect(body?.output_config?.effort).toBe(effort)
  }
})

test('omitted native sampling fields stay omitted', async () => {
  const body = await capture({ model: 'claude-sonnet-4-5', thinking: { type: 'adaptive' } })
  expect(Object.hasOwn(body || {}, 'temperature')).toBe(false)
  expect(Object.hasOwn(body || {}, 'top_p')).toBe(false)
  expect(Object.hasOwn(body || {}, 'top_k')).toBe(false)
  expect(Object.hasOwn(body || {}, 'context_management')).toBe(false)
})

test('classifier requests skip ordinary model policy', async () => {
  const body = await capture(
    { model: 'claude-3-5-haiku-latest', thinking: { type: 'enabled', budget_tokens: 2048 } },
    { requestContext: { purpose: 'auto_mode_classifier', format: 'xml' } },
  )
  expect(body?.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 })
})

test('omitted native thinking stays adaptive', async () => {
  const plain = await capture({ model: 'claude-sonnet-4-5' })
  expect(plain?.thinking).toEqual({ type: 'adaptive' })
})

test('thread continuation keeps omitted tools and thinking omitted', async () => {
  const thread = await capture({
    model: 'claude-sonnet-4-5',
    thread: { type: 'continue', previous_message_id: 'msg_prior' },
  })
  expect(Object.hasOwn(thread || {}, 'tools')).toBe(false)
  expect(Object.hasOwn(thread || {}, 'thinking')).toBe(false)
})

test('generated thinking still turns a forced tool choice into auto', async () => {
  let captured: Record<string, unknown> | undefined
  assembledRequest.current = (params) => {
    captured = params
    throw new Error('stop-before-upstream')
  }
  const previous = process.env.ANTHROPIC_BASE_URL
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
  process.env.CLAUDE_CODE_SKIP_VCR = '1'
  process.env.ANTHROPIC_API_KEY = 'test-key'
  try {
    const stream = queryModelWithStreaming({
      messages: [createUserMessage({ content: 'hello' })],
      systemPrompt: ['caller'],
      thinkingConfig: { type: 'adaptive' },
      tools: [],
      signal: AbortSignal.abort(),
      options: {
        model: 'claude-sonnet-4-5',
        toolChoice: { type: 'tool', name: 'Read' },
        mcpTools: [],
        getToolPermissionContext: async () => ({ mode: 'bypassPermissions', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, isBypassPermissionsModeAvailable: true }),
        querySource: 'repl_main_thread',
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
      },
    })
    for await (const _event of stream) {
      // The observer throws before the request leaves the process.
    }
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('stop-before-upstream')) throw error
  } finally {
    assembledRequest.current = undefined
    delete process.env.CLAUDE_CODE_SKIP_VCR
    delete process.env.ANTHROPIC_API_KEY
    if (previous == null) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = previous
  }
  expect(captured?.tool_choice).toEqual({ type: 'auto' })
})
