import { expect, test } from 'bun:test'
import {
  applyOfficialOutboundHeaders,
  assembleApiMetadata,
  claudeCodeAppHeader,
  claudeCodeIdentityHeaders,
  deriveClaudeCodeRequestClass,
  officialCliUserAgent,
  officialH2Fetch,
  officialStainlessHeaders,
  resetOfficialH2Fetch,
  sanitizeClaudeCodeExtraMetadata,
} from './officialFingerprint.ts'

test('officialCliUserAgent is claude-cli not bun or axios', () => {
  const prevUser = process.env.USER_TYPE
  const prevEntry = process.env.CLAUDE_CODE_ENTRYPOINT
  const prevVersion = process.env.CLAUDE_CODE_VERSION
  delete process.env.CLAUDE_CODE_VERSION
  process.env.USER_TYPE = 'external'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli'
  try {
    const ua = officialCliUserAgent()
    expect(ua).toMatch(/^claude-cli\/2\.1\.303 \(external, sdk-cli\)$/)
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
  const prevKind = process.env.CLAUDE_CODE_SESSION_KIND
  delete process.env.CLAUDE_CODE_SESSION_KIND
  const headers = new Headers({
    'User-Agent': 'Bun/1.3.14',
    'x-stainless-runtime-version': 'v24.3.0',
    'x-stainless-package-version': '0.81.0',
    'x-stainless-runtime': 'bun',
  })
  try {
    applyOfficialOutboundHeaders(headers, 'claude-cli/2.1.280 (external, sdk-cli)')
    expect(headers.get('User-Agent')).toBe('claude-cli/2.1.280 (external, sdk-cli)')
    expect(headers.get('x-app')).toBe('cli')
    const stamped = officialStainlessHeaders()
    expect(headers.get('x-stainless-runtime')).toBe(stamped['x-stainless-runtime'])
    expect(headers.get('x-stainless-runtime-version')).toBe(stamped['x-stainless-runtime-version'])
    expect(headers.get('x-stainless-package-version')).toBe(stamped['x-stainless-package-version'])
  } finally {
    if (prevKind == null) delete process.env.CLAUDE_CODE_SESSION_KIND
    else process.env.CLAUDE_CODE_SESSION_KIND = prevKind
  }
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
  const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ANTHROPIC_UNIX_SOCKET']
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

test('officialCliUserAgent ignores USER_TYPE', () => {
  const prevUser = process.env.USER_TYPE
  const prevEntry = process.env.CLAUDE_CODE_ENTRYPOINT
  const prevVersion = process.env.CLAUDE_CODE_VERSION
  delete process.env.CLAUDE_CODE_VERSION
  process.env.USER_TYPE = 'ant'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli'
  try {
    expect(officialCliUserAgent()).toMatch(/^claude-cli\/2\.1\.303 \(external, sdk-cli\)$/)
  } finally {
    if (prevUser == null) delete process.env.USER_TYPE
    else process.env.USER_TYPE = prevUser
    if (prevEntry == null) delete process.env.CLAUDE_CODE_ENTRYPOINT
    else process.env.CLAUDE_CODE_ENTRYPOINT = prevEntry
    if (prevVersion == null) delete process.env.CLAUDE_CODE_VERSION
    else process.env.CLAUDE_CODE_VERSION = prevVersion
  }
})

test('x-app is cli-bg for bg sessions and custom x-app wins', () => {
  const prevKind = process.env.CLAUDE_CODE_SESSION_KIND
  try {
    delete process.env.CLAUDE_CODE_SESSION_KIND
    expect(claudeCodeAppHeader()).toBe('cli')
    process.env.CLAUDE_CODE_SESSION_KIND = 'bg'
    expect(claudeCodeAppHeader()).toBe('cli-bg')
    const headers = new Headers({ 'x-app': 'custom-app' })
    applyOfficialOutboundHeaders(headers, 'claude-cli/2.1.296 (external, cli)')
    expect(headers.get('x-app')).toBe('custom-app')
    expect(
      claudeCodeIdentityHeaders({
        source: 'sdk',
        customHeaders: { 'x-app': 'from-custom' },
      })['x-app'],
    ).toBe('from-custom')
  } finally {
    if (prevKind == null) delete process.env.CLAUDE_CODE_SESSION_KIND
    else process.env.CLAUDE_CODE_SESSION_KIND = prevKind
  }
})

test('request class follows source and keeps custom/explicit overrides', () => {
  expect(deriveClaudeCodeRequestClass(undefined)).toBeUndefined()
  expect(deriveClaudeCodeRequestClass('sdk')).toBe('main')
  expect(deriveClaudeCodeRequestClass('repl_main_thread:1')).toBe('main')
  expect(deriveClaudeCodeRequestClass('agent:Explore')).toBe('subagent')
  expect(deriveClaudeCodeRequestClass('hook_agent')).toBe('subagent')
  expect(deriveClaudeCodeRequestClass('compact')).toBe('compaction')
  expect(deriveClaudeCodeRequestClass('side_query')).toBe('auxiliary')
  expect(deriveClaudeCodeRequestClass('side_reply')).toBe('side_reply')
  expect(
    deriveClaudeCodeRequestClass('agent:Explore', {
      agentType: 'subagent',
      workflowRunId: 'wf_1',
    }),
  ).toBe('workflow')
  expect(deriveClaudeCodeRequestClass('compact', undefined, 'main')).toBe('main')
  expect(
    claudeCodeIdentityHeaders({
      source: 'agent:Explore',
      customHeaders: { 'x-claude-code-request-class': 'auxiliary' },
    })['x-claude-code-request-class'],
  ).toBe('auxiliary')
})

test('applyOfficialOutboundHeaders leaves SDK helper version and retry fields', () => {
  const headers = new Headers({
    'User-Agent': 'claude-cli/2.1.296 (external, cli)',
    'x-app': 'cli',
    'x-stainless-helper': 'messages.create',
    'anthropic-version': '2023-06-01',
    'x-stainless-retry-count': '2',
    'x-stainless-timeout': '120',
    'x-stainless-runtime': 'bun',
  })
  applyOfficialOutboundHeaders(headers)
  expect(headers.get('x-stainless-helper')).toBe('messages.create')
  expect(headers.get('anthropic-version')).toBe('2023-06-01')
  expect(headers.get('x-stainless-retry-count')).toBe('2')
  expect(headers.get('x-stainless-timeout')).toBe('120')
  expect(headers.get('x-stainless-runtime')).toBe('node')
})

test('malformed reserved oversized extras cannot replace owned identity', () => {
  const identity = {
    device_id: 'dev-1',
    account_uuid: 'acct-1',
    session_id: 'sess-1',
    root_session_id: 'root-1',
  }
  expect(sanitizeClaudeCodeExtraMetadata('not-json')).toEqual({})
  expect(sanitizeClaudeCodeExtraMetadata(['x'])).toEqual({})
  expect(
    sanitizeClaudeCodeExtraMetadata({
      tk: 'stolen',
      os: 'evil',
      nested: { a: 1 },
      foo: true,
      n: 3,
    }),
  ).toEqual({ foo: true, n: 3 })

  const hijack = assembleApiMetadata({
    extra: {
      device_id: 'hijack',
      account_uuid: 'hijack',
      session_id: 'hijack',
      root_session_id: 'hijack',
      tk: 'stolen',
      foo: 1,
    },
    identity,
  })
  const hijackParsed = JSON.parse(hijack.user_id) as Record<string, unknown>
  expect(hijackParsed.device_id).toBe('dev-1')
  expect(hijackParsed.account_uuid).toBe('acct-1')
  expect(hijackParsed.session_id).toBe('sess-1')
  expect(hijackParsed.root_session_id).toBe('root-1')
  expect(hijackParsed.tk).toBeUndefined()
  expect(hijackParsed.foo).toBe(1)

  const oversized = assembleApiMetadata({
    extra: { blob: 'x'.repeat(600) },
    identity,
  })
  const oversizedParsed = JSON.parse(oversized.user_id) as Record<string, unknown>
  expect(oversizedParsed).toEqual(identity)
  expect(oversized.user_id).not.toContain('blob')
  expect(oversized.user_id.length).toBe(JSON.stringify(identity).length)
})
