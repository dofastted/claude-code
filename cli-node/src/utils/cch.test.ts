import { expect, test } from 'bun:test'
import { projectForCch, stampCchBody } from './cch.ts'

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
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.296; cch=00000;' }],
    max_tokens: 128,
  }
  const raw = JSON.stringify(body, null, 2)
  expect(stampCchBody(raw, false)).toBe(raw)
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
  expect(stampCchBody(raw, false)).toBe(raw)
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
