import { expect, test } from 'bun:test'
import { getAttributionHeader } from './system.ts'

test('billing always carries a CCH placeholder regardless of provider gates', () => {
  const previous = process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
  process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '1'
  try {
    expect(getAttributionHeader('abc')).toContain('cch=00000;')
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
    else process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = previous
  }
})
