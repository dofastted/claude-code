import { expect, test } from 'bun:test'
import { kernelEnv } from './kernelEnv.js'

test('native slot count comes from CLAUDE_CODE_NATIVE_SLOTS', () => {
  const prev = process.env.CLAUDE_CODE_NATIVE_SLOTS
  process.env.CLAUDE_CODE_NATIVE_SLOTS = '20'
  try {
    expect(kernelEnv('NATIVE_SLOTS')).toBe('20')
  } finally {
    restore('CLAUDE_CODE_NATIVE_SLOTS', prev)
  }
})

test('legacy CLAUDE_CODE_KIN_ names are not a slot host', () => {
  const prevModern = process.env.CLAUDE_CODE_NATIVE_SLOTS
  const prevLegacy = process.env.CLAUDE_CODE_KIN_NATIVE_SLOTS
  delete process.env.CLAUDE_CODE_NATIVE_SLOTS
  process.env.CLAUDE_CODE_KIN_NATIVE_SLOTS = '20'
  try {
    expect(kernelEnv('NATIVE_SLOTS')).toBeUndefined()
  } finally {
    restore('CLAUDE_CODE_NATIVE_SLOTS', prevModern)
    restore('CLAUDE_CODE_KIN_NATIVE_SLOTS', prevLegacy)
  }
})

function restore(key: string, value: string | undefined): void {
  if (value == null) delete process.env[key]
  else process.env[key] = value
}
