import { expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, brotliCompressSync } from 'node:zlib'
import { getAnthropicClient } from './client.ts'
import { computeCch } from '../../utils/cch.ts'

// Exercise the real SDK serialization, CCH sealer and HTTP transport together.
test('API request headers describe the final UTF-8 body and accept compressed JSON/SSE', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'cli-request-headers-'))
  const keys = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_VERSION',
    'API_TIMEOUT_MS',
    'KERNEL_CONFIG',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_AGENT_SDK_VERSION',
    'CLAUDE_AGENT_SDK_CLIENT_APP',
    'ANTHROPIC_CUSTOM_HEADERS',
  ]
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  process.env.ANTHROPIC_API_KEY = 'local-fixture-key'
  process.env.CLAUDE_CONFIG_DIR = temp
  process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli'
  process.env.CLAUDE_CODE_VERSION = '2.1.303'
  process.env.API_TIMEOUT_MS = '600000'
  process.env.KERNEL_CONFIG = join(temp, 'kernel.json')
  writeFileSync(process.env.KERNEL_CONFIG, JSON.stringify({ cch_enabled: true }))

  const requests: Array<{ headers: Record<string, string | string[] | undefined>; raw: string }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = JSON.parse(raw)
    requests.push({ headers: request.headers, raw })
    if (body.stream) {
      const payload = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      response.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'br' })
      response.end(brotliCompressSync(payload))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
    response.end(
      gzipSync(
        JSON.stringify({
          id: 'msg_headers',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: '你好' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ),
    )
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing local listener')
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${address.port}`
    const client = await getAnthropicClient({ apiKey: 'local-fixture-key', maxRetries: 0 })
    const params = {
      model: 'claude-opus-5-5',
      max_tokens: 16,
      system: [{ type: 'text' as const, text: 'x-anthropic-billing-header: cc_entrypoint=cli; cch=00000;' }],
      messages: [{ role: 'user' as const, content: '中文与 emoji 🧪' }],
    }
    const message = await client.beta.messages.create({ ...params, stream: false })
    expect(message.content.map((block) => (block.type === 'text' ? block.text : null))).toEqual(['你好'])
    const stream = await client.beta.messages.create({ ...params, stream: true })
    const events = []
    for await (const event of stream) events.push(event.type)
    expect(events).toEqual(['message_stop'])
    expect(requests).toHaveLength(2)
    for (const { headers, raw } of requests) {
      expect(headers['user-agent']).toBe('claude-cli/2.1.303 (external, sdk-cli)')
      expect(headers.accept).toBe('application/json, text/event-stream')
      expect(headers['accept-encoding']).toBe('gzip, br')
      expect(headers['x-stainless-timeout']).toBe('600')
      expect(headers['content-length']).toBe(String(Buffer.byteLength(raw, 'utf8')))
      expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(raw.length)
      const body = JSON.parse(raw)
      expect(body.messages[0].content).toBe('中文与 emoji 🧪')
      expect(body.system[0].text).toContain(`cch=${computeCch(raw)};`)
      expect(body.system[0].text).not.toContain('cch=00000;')
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    rmSync(temp, { recursive: true, force: true })
  }
})
