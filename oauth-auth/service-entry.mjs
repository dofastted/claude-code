import { readFileSync } from 'node:fs'
import {
  FULL_OAUTH_SCOPE,
  completeAuthorizedToken,
  exchangeAuthorizationCode,
  sessionKeyToAuthorizedOAuth,
} from '../../src/lib/oauth/auth.js'

function redact(text) {
  return String(text || '')
    .replace(/sk-ant-[A-Za-z0-9._~+/-]+/g, '[redacted-token]')
    .replace(/sessionKey=[^;\s]+/gi, 'sessionKey=[redacted]')
    .replace(/code_verifier[^,\s]*/gi, 'code_verifier=[redacted]')
    .slice(0, 300)
}

function parseCode(raw, state = '') {
  const value = String(raw || '').trim()
  const index = value.indexOf('#')
  if (index < 0) return { code: value, state: String(state || '') }
  return { code: value.slice(0, index), state: value.slice(index + 1) }
}

async function execute(input) {
  // Keep "" (local egress, direct) distinct from a missing proxy.
  const proxyUrl = input.proxy_url ?? null
  const timeoutMs = Number(input.timeout_ms) || 15000
  if (input.operation === 'session_key') {
    const credential = await sessionKeyToAuthorizedOAuth({
      sessionKey: input.session_key,
      scope: FULL_OAUTH_SCOPE,
      proxyUrl,
      timeoutMs,
    })
    const setup = input.runtime_mode === 'setup-token'
    return {
      ...completeRuntimeMode(credential, setup),
      source: credential.source || 'oauth-auth-service',
    }
  }
  if (input.operation === 'exchange_code') {
    const parsed = parseCode(input.code, input.state)
    const token = await exchangeAuthorizationCode({
      code: parsed.code,
      codeVerifier: input.code_verifier,
      state: parsed.state,
      redirectUri: input.redirect_uri,
      proxyUrl,
      timeoutMs,
    })
    return {
      ...completeRuntimeMode(await completeAuthorizedToken({ token, proxyUrl, timeoutMs }), input.runtime_mode === 'setup-token'),
      source: 'oauth-auth-service',
    }
  }
  const error = new Error('unsupported OAuth service operation')
  error.code = 'invalid_operation'
  throw error
}

function completeRuntimeMode(credential, setup) {
  return {
    ...credential,
    type: setup ? 'setup-token' : credential.type || 'oauth',
    mode: setup ? 'setup-token' : credential.mode || 'oauth',
  }
}

async function main() {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    const credential = await execute(input)
    process.stdout.write(JSON.stringify({ ok: true, credential }) + '\n')
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: {
          code: error?.code || 'oauth_auth_failed',
          message: redact(error?.message || error),
        },
      }) + '\n',
    )
    process.exitCode = 1
  }
}

void main()
