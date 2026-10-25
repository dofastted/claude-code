import { expect, test } from 'bun:test'
import { WRAP_OFFICIAL_CLI_VERSION, officialCliVersion } from './cliVersion.ts'

test('officialCliVersion defaults to this source, not the old fork', () => {
  const prev = process.env.CLAUDE_CODE_VERSION
  delete process.env.CLAUDE_CODE_VERSION
  try {
    expect(WRAP_OFFICIAL_CLI_VERSION).toBe('2.1.303')
    expect(officialCliVersion()).toBe('2.1.303')
    expect(officialCliVersion()).not.toBe('2.8.4')
    expect(officialCliVersion()).not.toBe('2.1.278')
  } finally {
    if (prev == null) delete process.env.CLAUDE_CODE_VERSION
    else process.env.CLAUDE_CODE_VERSION = prev
  }
})

test('officialCliVersion prefers CLAUDE_CODE_VERSION env', () => {
  const prev = process.env.CLAUDE_CODE_VERSION
  process.env.CLAUDE_CODE_VERSION = '2.1.280'
  try {
    expect(officialCliVersion()).toBe('2.1.280')
  } finally {
    if (prev == null) delete process.env.CLAUDE_CODE_VERSION
    else process.env.CLAUDE_CODE_VERSION = prev
  }
})

test('officialCliVersion extracts semver from noisy env', () => {
  const prev = process.env.CLAUDE_CODE_VERSION
  process.env.CLAUDE_CODE_VERSION = 'claude-cli/2.1.999 (external, sdk-cli)'
  try {
    expect(officialCliVersion()).toBe('2.1.999')
  } finally {
    if (prev == null) delete process.env.CLAUDE_CODE_VERSION
    else process.env.CLAUDE_CODE_VERSION = prev
  }
})
