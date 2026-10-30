/**
 * Outbound HTTP fingerprint of official Claude CLI 2.1.296
 * (linux-x64 sdk-cli capture). The fork's Bun/SDK versions must not leak
 * into Anthropic request headers.
 */
import { officialCliVersion } from './cliVersion.js'
import { readPanelCcEntrypoint } from './cacheTtl.js'
import type * as Undici from 'undici'

export const WRAP_OFFICIAL_STAINLESS = Object.freeze({
  lang: 'js',
  os: 'Linux',
  arch: 'x64',
  runtime: 'node',
  runtimeVersion: 'v26.3.0',
  packageVersion: '0.128.0',
})

const STAINLESS_IDENTITY_KEYS = [
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-arch',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-package-version',
] as const

/** Official rN reserved extra-metadata keys. Extras cannot set these. */
export const API_METADATA_RESERVED_KEYS: Record<string, true> = {
  ti: true,
  os: true,
  sb: true,
  he: true,
  uf: true,
  ap: true,
  tk: true,
}

/** Official xze encoded-size cap for extra+caller metadata. */
export const API_METADATA_MAX_ENCODED_BYTES = 512

export const CLAUDE_CODE_REQUEST_CLASSES = [
  'main',
  'subagent',
  'workflow',
  'compaction',
  'auxiliary',
  'side_reply',
] as const

export type ClaudeCodeRequestClass = (typeof CLAUDE_CODE_REQUEST_CLASSES)[number]

export type ApiMetadataPrimitive = string | number | boolean

export type RequestClassContext = {
  agentType?: string
  workflowRunId?: string
}

export function officialCliUserAgent(): string {
  const entrypoint = readPanelCcEntrypoint()
  return `claude-cli/${officialCliVersion()} (external, ${entrypoint})`
}

/**
 * Official ww()/Lt(): `x-app` is `cli-bg` when this process is a `claude --bg`
 * session. Same env signal as local `isBgSession()` (`CLAUDE_CODE_SESSION_KIND`)
 * without the BG_SESSIONS feature DCE, so unbundled/runtime headers still match.
 */
export function claudeCodeAppHeader(): 'cli' | 'cli-bg' {
  return process.env.CLAUDE_CODE_SESSION_KIND === 'bg' ? 'cli-bg' : 'cli'
}

/**
 * Official Ous + ss (2.1.296). `side_reply` is derived when the source
 * argument is already that class (explicit override still wins).
 */
export function deriveClaudeCodeRequestClass(
  source: string | undefined,
  context?: RequestClassContext | null,
  explicit?: string,
): string | undefined {
  if (source === undefined) return
  if (explicit !== undefined) return explicit
  if (source === 'compact') return 'compaction'
  if (source === 'side_reply') return 'side_reply'
  let mapped: 'main' | 'subagent' | 'auxiliary' = 'auxiliary'
  if (source.startsWith('repl_main_thread') || source === 'sdk') {
    mapped = 'main'
  } else if (source.startsWith('agent:') || source === 'hook_agent') {
    mapped = 'subagent'
  }
  if (mapped === 'subagent' && context?.agentType === 'subagent' && context.workflowRunId) {
    return 'workflow'
  }
  return mapped
}

/**
 * Default `x-app` / request-class, then explicit custom headers.
 * Custom keys win. Callers still layer session/env headers after this.
 */
export function claudeCodeIdentityHeaders(args: {
  source?: string
  requestClass?: string
  agentContext?: RequestClassContext | null
  customHeaders?: Record<string, string>
}): Record<string, string> {
  const requestClass = deriveClaudeCodeRequestClass(
    args.source,
    args.agentContext,
    args.requestClass,
  )
  return {
    'x-app': claudeCodeAppHeader(),
    ...(requestClass ? { 'x-claude-code-request-class': requestClass } : {}),
    ...args.customHeaders,
  }
}

export function sanitizeClaudeCodeExtraMetadata(
  extra: unknown,
): Record<string, ApiMetadataPrimitive> {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
    return {}
  }
  const out: Record<string, ApiMetadataPrimitive> = {}
  const fields = extra as Record<string, unknown>
  for (const key in fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue
    const value = fields[key]
    if (API_METADATA_RESERVED_KEYS[key]) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    }
  }
  return out
}

/**
 * Official xze assembler: extras (n) then identity (w) win; caller siblings
 * (s) sit under both. Oversized extras/siblings are shed; identity is kept.
 * Parent supplies identity (`device_id`, `account_uuid`, `session_id`,
 * custom `root_session_id`, optional remote `tk`). This helper never reads
 * account/credential files.
 */
export function assembleApiMetadata(opts: {
  extra?: unknown
  identity: Record<string, ApiMetadataPrimitive | undefined | null | unknown>
  caller?: Record<string, ApiMetadataPrimitive>
}): { user_id: string } {
  const extra = sanitizeClaudeCodeExtraMetadata(opts.extra)
  const caller = opts.caller ?? {}
  const identity: Record<string, ApiMetadataPrimitive> = {}
  for (const key in opts.identity) {
    if (!Object.prototype.hasOwnProperty.call(opts.identity, key)) continue
    const value = opts.identity[key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      identity[key] = value
    }
  }
  let encoded = JSON.stringify({ ...caller, ...extra, ...identity })
  if (encoded.length > API_METADATA_MAX_ENCODED_BYTES) {
    encoded = JSON.stringify({ ...caller, ...identity })
    if (encoded.length > API_METADATA_MAX_ENCODED_BYTES) {
      encoded = JSON.stringify(identity)
    }
  }
  return { user_id: encoded }
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
  const currentUa = headers.get('User-Agent')
  if (!currentUa || /Bun\//.test(currentUa) || /axios\//i.test(currentUa)) {
    headers.set('User-Agent', userAgent)
  }
  headers.set('accept', 'application/json, text/event-stream')
  headers.set('accept-encoding', 'gzip, br')
  if (!headers.has('x-app')) {
    headers.set('x-app', claudeCodeAppHeader())
  }
  const stainless = officialStainlessHeaders()
  for (const key of STAINLESS_IDENTITY_KEYS) {
    headers.set(key, stainless[key]!)
  }
  if (!headers.has('x-stainless-retry-count')) {
    headers.set('x-stainless-retry-count', stainless['x-stainless-retry-count']!)
  }
  if (!headers.has('x-stainless-timeout')) {
    headers.set('x-stainless-timeout', stainless['x-stainless-timeout']!)
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
