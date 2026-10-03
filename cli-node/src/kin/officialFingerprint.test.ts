import { expect, test } from 'bun:test'
import {
  WRAP_OFFICIAL_STAINLESS,
  applyOfficialOutboundHeaders,
  officialCliUserAgent,
  officialH2Fetch,
  officialStainlessHeaders,
  resetOfficialH2Fetch,
} from './officialFingerprint.ts'

test('official stainless matches 2.1.263 capture not wrap SDK 0.81.0', () => {
  expect(WRAP_OFFICIAL_STAINLESS.runtime).toBe('node')
  expect(WRAP_OFFICIAL_STAINLESS.runtimeVersion).toBe('v26.3.0')
  expect(WRAP_OFFICIAL_STAINLESS.packageVersion).toBe('0.112.1')
  expect(WRAP_OFFICIAL_STAINLESS.packageVersion).not.toBe('0.81.0')
})

test('officialCliUserAgent is claude-cli not bun or axios', () => {
  const prevUser = process.env.USER_TYPE
  const prevEntry = process.env.CLAUDE_CODE_ENTRYPOINT
  const prevVersion = process.env.CLAUDE_CODE_VERSION
  delete process.env.CLAUDE_CODE_VERSION
  process.env.USER_TYPE = 'external'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli'
  try {
    const ua = officialCliUserAgent()
    expect(ua).toBe('claude-cli/2.1.284 (external, sdk-cli)')
    expect(ua).not.toContain('Bun/')
    expect(ua).not.toContain('axios/')
  } finally {
    if (prevUser == null) delete process.env.USER_TYPE
    else process.env.USER_TYPE = prevUser
    if (prevEntry == null) delete process.env.CLAUDE_CODE_ENTRYPOINT
    else process.env.CLAUDE_CODE_ENTRYPOINT = prevEntry
    if (prevVersion == null) delete process.env.CLAUDE_CODE_VERSION
    else process.env.CLAUDE_CODE_VERSION = prevVersion
  }
})

test('applyOfficialOutboundHeaders overwrites bun stainless', () => {
  const headers = new Headers({
    'User-Agent': 'Bun/1.3.14',
    'x-stainless-runtime-version': 'v24.3.0',
    'x-stainless-package-version': '0.81.0',
    'x-stainless-runtime': 'bun',
  })
  applyOfficialOutboundHeaders(
    headers,
    'claude-cli/2.1.280 (external, sdk-cli)',
  )
  expect(headers.get('User-Agent')).toBe(
    'claude-cli/2.1.280 (external, sdk-cli)',
  )
  expect(headers.get('x-app')).toBe('cli')
  const stamped = officialStainlessHeaders()
  expect(headers.get('x-stainless-runtime')).toBe(
    stamped['x-stainless-runtime'],
  )
  expect(headers.get('x-stainless-runtime-version')).toBe(
    stamped['x-stainless-runtime-version'],
  )
  expect(headers.get('x-stainless-package-version')).toBe(
    stamped['x-stainless-package-version'],
  )
})

test('officialH2Fetch skips when HTTPS_PROXY is set', () => {
  const prev = process.env.HTTPS_PROXY
  process.env.HTTPS_PROXY = 'http://127.0.0.1:18080'
  try {
    expect(officialH2Fetch()).toBeUndefined()
  } finally {
    if (prev == null) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = prev
  }
})

test('resetOfficialH2Fetch drops cached agent', () => {
  const keys = [
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'ANTHROPIC_UNIX_SOCKET',
  ]
  const prev = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  for (const k of keys) delete process.env[k]
  try {
    resetOfficialH2Fetch()
    const first = officialH2Fetch()
    resetOfficialH2Fetch()
    const second = officialH2Fetch()
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
  } finally {
    for (const k of keys) {
      if (prev[k] == null) delete process.env[k]
      else process.env[k] = prev[k]
    }
    resetOfficialH2Fetch()
  }
})
