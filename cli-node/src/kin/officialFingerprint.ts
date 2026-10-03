/**
 * Outbound HTTP fingerprint of official Claude CLI 2.1.280
 * (linux-x64 sdk-cli capture). Wrap bun/SDK 0.81.0 must not leak
 * runtime=bun, node v24, or package 0.81.0 on Anthropic hops.
 */
import { officialCliVersion } from './cliVersion.js'
import type * as Undici from 'undici'

export const WRAP_OFFICIAL_STAINLESS = Object.freeze({
  lang: 'js',
  os: 'Linux',
  arch: 'x64',
  runtime: 'node',
  runtimeVersion: 'v26.3.0',
  packageVersion: '0.112.1',
})

export function officialCliUserAgent(): string {
  const entry = process.env.CLAUDE_CODE_ENTRYPOINT || 'sdk-cli'
  const userType = process.env.USER_TYPE || 'external'
  return `claude-cli/${officialCliVersion()} (${userType}, ${entry})`
}

export function officialStainlessHeaders(): Record<string, string> {
  return {
    'x-stainless-lang': WRAP_OFFICIAL_STAINLESS.lang,
    'x-stainless-os': WRAP_OFFICIAL_STAINLESS.os,
    'x-stainless-arch': WRAP_OFFICIAL_STAINLESS.arch,
    'x-stainless-runtime': WRAP_OFFICIAL_STAINLESS.runtime,
    'x-stainless-runtime-version': WRAP_OFFICIAL_STAINLESS.runtimeVersion,
    'x-stainless-package-version': WRAP_OFFICIAL_STAINLESS.packageVersion,
    'x-stainless-retry-count': '0',
    'x-stainless-timeout': '600',
  }
}

export function applyOfficialOutboundHeaders(
  headers: Headers,
  userAgent = officialCliUserAgent(),
): void {
  headers.set('User-Agent', userAgent)
  headers.set('x-app', 'cli')
  for (const [key, value] of Object.entries(officialStainlessHeaders())) {
    headers.set(key, value)
  }
}

let h2Fetch: typeof fetch | undefined

export function resetOfficialH2Fetch(): void {
  h2Fetch = undefined
}

/** Official CLI 2.1.280 uses Node undici HTTP/2. Bun fetch is HTTP/1.1. */
export function officialH2Fetch(): typeof fetch | undefined {
  if (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ANTHROPIC_UNIX_SOCKET
  ) {
    return undefined
  }
  if (h2Fetch) return h2Fetch
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const undici = require('undici') as typeof Undici
    const agent = new undici.Agent({ allowH2: true })
    h2Fetch = ((input, init) =>
      undici.fetch(input as never, {
        ...(init as object),
        dispatcher: agent,
      })) as typeof fetch
    return h2Fetch
  } catch {
    return undefined
  }
}
