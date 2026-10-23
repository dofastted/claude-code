import { expect, test } from 'bun:test'
import { computeCch, projectForCch, stampCchBody } from './cch.ts'

test('stamps compact CCH into a pretty SDK request body', () => {
  const body = JSON.stringify(
    {
      model: 'claude-opus-5-5',
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.296; cch=00000;',
        },
      ],
      messages: [{ role: 'user', content: 'probe' }],
      max_tokens: 128,
    },
    null,
    2,
  )

  const stamped = stampCchBody(body)

  expect(stamped).not.toContain('cch=00000')
  expect(stamped).toMatch(/"model":"claude-opus-5-5"/)
  expect(stamped).toMatch(/cch=[0-9a-f]{5}/)
})

test('disabled sealing keeps exactly five zeroes and never hashes prompt literals', () => {
  const body = {
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'Keep literal cch=00000; unchanged.' }],
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.296; cc_entrypoint=sdk-cli; cch=00000;' }],
    max_tokens: 128,
  }
  const raw = JSON.stringify(body, null, 2)
  expect(JSON.parse(stampCchBody(raw, false)).system[0].text).toMatch(/cc_entrypoint=sdk-cli; cch=00000;/)
  const enabled = JSON.parse(stampCchBody(raw, true))
  expect(enabled.system[0].text).toMatch(/cch=[0-9a-f]{5};/)
  expect(enabled.system[0].text).not.toContain('cch=00000;')
  expect(enabled.messages).toEqual(body.messages)
})
test('enabled sealing rewrites a caller digest instead of leaving it stale', () => {
  const body = {
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'hi' }],
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.296; cch=cc746;' }],
    max_tokens: 128,
  }
  const raw = JSON.stringify(body, null, 2)
  const enabled = JSON.parse(stampCchBody(raw, true))
  expect(enabled.system[0].text).toMatch(/cch=[0-9a-f]{5};/)
  expect(enabled.system[0].text).not.toContain('cch=cc746;')
  expect(enabled.system[0].text).not.toContain('cch=00000;')
  expect(JSON.parse(stampCchBody(raw, false)).system[0].text).toMatch(/cc_entrypoint=sdk-cli; cch=00000;/)
})

test('CCH projection uses compact JSON scanner needles', () => {
  const body = JSON.stringify({
    model: 'claude-opus-5-5',
    fallbacks: ['claude-sonnet-5-5'],
    max_tokens: 128,
    system: [{ type: 'text', text: 'cch=00000' }],
  })

  const projected = projectForCch(body)

  expect(projected).toContain('"model":""')
  expect(projected).not.toContain('"fallbacks"')
  expect(projected).not.toContain('"max_tokens"')
})

test('growing turns never reseal a billing example inside an old tool result', () => {
  const literal = 'x-anthropic-billing-header: cc_version=2.8.4; cch=259ed;'
  const messages: Array<Record<string, unknown>> = [
    { role: 'user', content: 'Read the fixture' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read_1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read_1', content: literal }] },
  ]
  let previous: unknown[] = []
  for (let turn = 0; turn < 3; turn++) {
    if (turn) messages.push({ role: 'assistant', content: 'Done' }, { role: 'user', content: `Turn ${turn}` })
    const body = {
      model: 'claude-opus-5-5',
      messages,
      system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.296; cc_entrypoint=sdk-cli; cch=00000;' }],
    }
    const sealed = JSON.parse(stampCchBody(JSON.stringify(body)))
    expect(sealed.messages).toEqual(messages)
    expect(sealed.messages.slice(0, previous.length)).toEqual(previous)
    expect(sealed.messages[2].content[0].content).toBe(literal)
    expect(sealed.system[0].text).toContain(`cch=${computeCch(JSON.stringify(sealed))};`)
    expect(stampCchBody(JSON.stringify(sealed))).toBe(JSON.stringify(sealed))
    previous = sealed.messages
  }
})

test('only the first system billing block is sealed, not quoted examples in later blocks', () => {
  const quote = 'x-anthropic-billing-header: cc_version=example; cch=259ed;'
  const body = {
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.296; cc_entrypoint=sdk-cli; cch=00000;' },
      { type: 'text', text: quote },
      { type: 'text', text: `Documentation:\n${quote}` },
    ],
    messages: [{ role: 'user', content: quote }],
  }
  const sealed = JSON.parse(stampCchBody(JSON.stringify(body)))
  expect(sealed.system[0].text).not.toContain('cch=00000;')
  expect(sealed.system.slice(1)).toEqual(body.system.slice(1))
  expect(sealed.messages).toEqual(body.messages)
  const projected = JSON.parse(projectForCch(JSON.stringify(sealed)))
  expect(projected.system).toEqual(body.system)
})

test('a system block containing only a quoted billing line is not treated as billing', () => {
  const raw = JSON.stringify({
    system: [{ type: 'text', text: 'Example:\nx-anthropic-billing-header: cc_version=example; cch=259ed;' }],
    messages: [{ role: 'user', content: 'Keep the example unchanged' }],
  })
  expect(stampCchBody(raw)).toBe(raw)
})
