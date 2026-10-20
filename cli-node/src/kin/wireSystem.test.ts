import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { assembledRequest, queryKinMessagesWithStreaming } from '../services/api/claude.ts'
import { createUserMessage } from '../utils/messages.ts'
test('native kin keeps the official two system blocks and their omitted TTL', async () => {
  const official = JSON.parse(readFileSync(new URL('../../官方请求体.txt', import.meta.url), 'utf8'))
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
    const stream = queryKinMessagesWithStreaming({
      system: official.system.map((block: { text: string }) => block.text),
      messages: [createUserMessage({ content: official.messages[0].content })],
      toolSchemas: [],
      thinking: { type: 'adaptive' },
      model: official.model,
      signal: AbortSignal.abort(),
      wireSystem: official.system,
      wireMessages: official.messages,
      wireBody: official,
      wireThinking: official.thinking,
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
  const system = captured?.system as Array<{ text: string; cache_control?: { type?: string; ttl?: string } }>
  expect(system.map((block) => block.text)).toEqual(official.system.map((block: { text: string }) => block.text))
  expect(system.map((block) => block.cache_control)).toEqual([{ type: 'ephemeral' }, { type: 'ephemeral' }])
})
