import { expect, test } from 'bun:test'
import { getUserAgent } from './http.ts'

function withUaEnv(env: Record<string, string | undefined>, run: () => void) {
  const keys = [
    'USER_TYPE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_VERSION',
    'CLAUDE_AGENT_SDK_VERSION',
    'CLAUDE_AGENT_SDK_CLIENT_APP',
  ]
  const prev = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  for (const k of keys) {
    if (env[k] === undefined) delete process.env[k]
    else process.env[k] = env[k]
  }
  try {
    run()
  } finally {
    for (const k of keys) {
      if (prev[k] == null) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

test('getUserAgent pins external cli while preserving SDK client suffixes', () => {
  withUaEnv(
    {
      USER_TYPE: undefined,
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_VERSION: undefined,
      CLAUDE_AGENT_SDK_VERSION: undefined,
      CLAUDE_AGENT_SDK_CLIENT_APP: undefined,
    },
    () => {
      expect(getUserAgent()).toBe('claude-cli/2.1.296 (external, cli)')
    },
  )
  withUaEnv(
    {
      USER_TYPE: 'ant',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-cli',
      CLAUDE_CODE_VERSION: undefined,
      CLAUDE_AGENT_SDK_VERSION: '0.2.0',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'acme/1',
    },
    () => {
      expect(getUserAgent()).toMatch(
        /^claude-cli\/2\.1\.296 \(external, cli, agent-sdk\/0\.2\.0, client-app\/acme\/1\)$/,
      )
    },
  )
})
