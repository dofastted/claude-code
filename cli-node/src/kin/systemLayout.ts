/**
 * P1: CLI-owned system layout. Rust must not construct billing.
 *
 * zero: attribution fields stay official (cc_version / cc_entrypoint / cch /
 * cc_prompt_id), then `prompt_version=<identity>` — same shape as the HTTP
 * hop 0-inject that Anthropic accepts. Never append bare `prompt_version=`.
 * identity: attribution block, then official sentence block.
 * Always append `# Environment` + leftover.
 */
import { randomUUID } from 'node:crypto'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY, SYSTEM_PROMPT_REPORTING_OUTCOMES } from '../constants/prompts.js'

export const IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
const CLI_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const CLI_SDK_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
const OFFICIAL_IDENTITIES: Record<string, true> = {
  [IDENTITY]: true,
  [CLI_IDENTITY]: true,
  [CLI_SDK_IDENTITY]: true,
}

export type SystemLayout = 'stock' | 'zero' | 'identity'

export function getSystemLayout(): SystemLayout {
  const raw = (process.env.CLAUDE_CODE_SYSTEM_LAYOUT || process.env.SYSTEM_MODE || '').trim().toLowerCase()
  if (raw === 'zero') return 'zero'
  if (raw === 'identity' || raw === 'id' || raw === 'block') return 'identity'
  return 'stock'
}

export function getKinTimezone(): string {
  const tz = (process.env.CLAUDE_CODE_TIMEZONE || process.env.SLOT_TZ || process.env.TZ || 'America/New_York').trim()
  return tz || 'America/New_York'
}

export function environmentBlock(timezone = getKinTimezone()): string {
  return `# Environment\n - Timezone: ${timezone}`
}

/** One id per process. A new UUID on every request changes the system prefix, so cache_read never moves past the tools breakpoint. */
let stablePromptId: string | undefined

function billingPromptId(): string {
  if (!stablePromptId) stablePromptId = randomUUID()
  return stablePromptId
}

/** Match HTTP 0-inject: prompt_version=<identity>; keep cc_prompt_id. */
export function finalizeZeroBilling(attribution: string): string {
  let header = (attribution || '').trim()
  if (!header) header = 'x-anthropic-billing-header:'
  if (!/^x-anthropic-billing-header:/i.test(header)) {
    header = `x-anthropic-billing-header: ${header}`
  }
  header = header
    .replace(/\s*prompt_version=<[^>]*>;?/g, '')
    .replace(/\s*prompt_version=[^;]*;?/g, '')
    .replace(/\s*\bcch=[^;]*;?/gi, '')
    .replace(/\s+$/g, '')
  if (!header.endsWith(';')) header += ';'
  if (!/\bcc_prompt_id=/.test(header)) header += ` cc_prompt_id=${billingPromptId()};`
  return `${header} cch=00000; prompt_version=<${IDENTITY}>`
}

function withCchPlaceholder(header: string): string {
  let found = false
  const reset = header.replace(/\bcch=[^;]*;?/gi, () => {
    if (found) return ''
    found = true
    return 'cch=00000;'
  })
  if (found) return reset
  if (/\bcc_entrypoint=[^;]*;/.test(reset)) {
    return reset.replace(/(\bcc_entrypoint=[^;]*;)/, '$1 cch=00000;')
  }
  return `${reset.endsWith(';') ? reset : `${reset};`} cch=00000;`
}

/**
 * A panel-assembled official system is already billing, identity, harness,
 * boundary, guidance. Keep that array. The 2.1.296 reporting shape is the
 * same contract with its static block in the third slot.
 */
export function preserveOfficialSystem(systemPrompt: readonly string[]): string[] | null {
  const raw = systemPrompt.filter((block) => (block || '').trim())
  const boundaryAt = raw.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
  const blocks = raw.filter((block) => block !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
  if (blocks.length < 4) return null
  const [billing, identity, third] = blocks
  if (!billing.trim().startsWith('x-anthropic-billing-header')) return null
  if (!OFFICIAL_IDENTITIES[identity.trim()]) return null
  const officialThird =
    third === SYSTEM_PROMPT_REPORTING_OUTCOMES ||
    third.includes('You are an agent working with the user toward their goals')
  if (!officialThird) return null
  const normalized = blocks.map((block) =>
    block.trim().startsWith('x-anthropic-billing-header') ? withCchPlaceholder(block) : block,
  )
  const splitAt = boundaryAt > 0 ? Math.min(boundaryAt, normalized.length) : 4
  return [...normalized.slice(0, splitAt), SYSTEM_PROMPT_DYNAMIC_BOUNDARY, ...normalized.slice(splitAt)]
}

export function layoutSystemBlocks(opts: { attribution: string; leftover?: string }): string[] {
  const layout = getSystemLayout()
  const attribution = (opts.attribution || '').trim()
  const leftover = opts.leftover
  const env = environmentBlock()
  const blocks: string[] = []

  if (layout === 'zero') {
    blocks.push(finalizeZeroBilling(attribution))
  } else {
    if (attribution) blocks.push(withCchPlaceholder(attribution))
    blocks.push(IDENTITY)
  }
  blocks.push(env)
  if (leftover) blocks.push(leftover)
  return blocks
}

export function billingFromSystemPrompt(systemPrompt: readonly string[]): string | undefined {
  for (const block of systemPrompt) {
    const text = (block || '').trim()
    if (text.startsWith('x-anthropic-billing-header')) return text
  }
  return undefined
}

export function leftoverFromSystemPrompt(systemPrompt: readonly string[]): string | undefined {
  const parts: string[] = []
  for (const block of systemPrompt) {
    const text = (block || '').trim()
    if (!text) continue
    if (text.startsWith('x-anthropic-billing-header')) continue
    if (text === IDENTITY) continue
    if (text.startsWith('# Environment')) continue
    if (isDefaultAgentField(text)) continue
    parts.push(block)
  }
  return parts.length ? parts.join('\n\n') : undefined
}

/** Kin / Crag slot persona only. Caller system text, including a Claude Code
 * subagent prompt and its notes, must stay. */
function isDefaultAgentField(text: string): boolean {
  if (text.includes('persistent Crag') || text.includes('persistent Kin')) return true
  if (text.includes('mcp__runtime__')) return true
  return false
}

function blockText(block: unknown): string {
  if (!block || typeof block !== 'object' || !('text' in block)) return ''
  return typeof block.text === 'string' ? block.text : ''
}

/** A native wire system is already assembled. Billing is one shape; the official two-block body is another. */
export function isStandardPersonaSystem(system: unknown): boolean {
  return Array.isArray(system) && system.length > 0 && system.every((block) => {
    if (!block || typeof block !== 'object' || !('text' in block)) return false
    return typeof block.text === 'string'
  })
}

/** Keep Node's system blocks, including a zero-width identity slot and an omitted TTL. */
export function wireSystemBlocks(
  system: unknown,
): Array<{ type: 'text'; text: string; cache_control?: Record<string, unknown> }> | null {
  if (!isStandardPersonaSystem(system) || !Array.isArray(system)) return null
  const blocks: Array<{ type: 'text'; text: string; cache_control?: Record<string, unknown> }> = []
  for (const block of system) {
    if (!block || typeof block !== 'object') return null
    const text = blockText(block)
    if (!text && !('text' in block)) return null
    const next: { type: 'text'; text: string; cache_control?: Record<string, unknown> } = {
      type: 'text',
      text: /^\s*x-anthropic-billing-header:/i.test(text) ? withCchPlaceholder(text) : text,
    }
    if ('cache_control' in block && block.cache_control && typeof block.cache_control === 'object') {
      next.cache_control = block.cache_control as Record<string, unknown>
    }
    blocks.push(next)
  }
  return blocks.length ? blocks : null
}
