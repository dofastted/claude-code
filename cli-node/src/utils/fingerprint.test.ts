import { expect, test } from 'bun:test'
import {
  computeFingerprint,
  extractFirstMessageText,
} from './fingerprint.ts'

function userMsg(
  content: string | Array<{ type: string; text?: string }>,
  isMeta?: boolean,
) {
  return { type: 'user' as const, isMeta, message: { content } }
}

test('extractFirstMessageText skips isMeta users and keeps the hash formula', () => {
  const meta = 'meta-prompt-xxxxx'
  const real = 'hello-real-user-abc'
  expect(extractFirstMessageText([userMsg(meta, true)] as never)).toBe('')
  expect(
    extractFirstMessageText([userMsg(meta, true), userMsg(real)] as never),
  ).toBe(real)
  expect(
    extractFirstMessageText([
      userMsg([{ type: 'text', text: real }]),
    ] as never),
  ).toBe(real)

  const version = '2.1.293'
  expect(computeFingerprint(extractFirstMessageText([userMsg(meta, true)] as never), version)).toBe(
    computeFingerprint('', version),
  )
  expect(
    computeFingerprint(
      extractFirstMessageText([userMsg(meta, true), userMsg(real)] as never),
      version,
    ),
  ).toBe(computeFingerprint(real, version))
  expect(computeFingerprint(meta, version)).not.toBe(
    computeFingerprint('', version),
  )
})
