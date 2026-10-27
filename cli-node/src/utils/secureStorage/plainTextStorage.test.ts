import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'bun:test'
import { credentialStorageFileName, plainTextStorage } from './plainTextStorage.js'

const dirs: string[] = []

afterEach(() => {
  delete process.env.CLAUDE_CODE_HOST_REFRESH
  delete process.env.CLAUDE_CONFIG_DIR
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function slotDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-cred-store-'))
  dirs.push(dir)
  mkdirSync(dir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = dir
  return dir
}

describe('host refresh credential file', () => {
  test('reads credentials.json and ignores a stale .credentials.json', () => {
    const dir = slotDir()
    process.env.CLAUDE_CODE_HOST_REFRESH = '1'
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'at-host', refreshToken: 'rt-host', expiresAt: 5_000 },
    }))
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'at-stale', refreshToken: 'rt-stale', expiresAt: 1_000 },
    }))
    expect(credentialStorageFileName()).toBe('credentials.json')
    expect(plainTextStorage.read()?.claudeAiOauth?.accessToken).toBe('at-host')
  })

  test('does not unlink the host file on logout', () => {
    const dir = slotDir()
    process.env.CLAUDE_CODE_HOST_REFRESH = '1'
    const host = join(dir, 'credentials.json')
    writeFileSync(host, JSON.stringify({
      claudeAiOauth: { accessToken: 'at-host', refreshToken: 'rt-host', expiresAt: 5_000 },
    }))
    expect(plainTextStorage.delete()).toBe(true)
    expect(plainTextStorage.read()?.claudeAiOauth?.refreshToken).toBe('rt-host')
  })
})
