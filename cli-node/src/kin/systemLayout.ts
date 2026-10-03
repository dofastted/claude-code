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

export const IDENTITY =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK."

export type SystemLayout = 'stock' | 'zero' | 'identity'

export function getSystemLayout(): SystemLayout {
  const raw = (
    process.env.CLAUDE_CODE_SYSTEM_LAYOUT ||
    process.env.KIN_SYSTEM_MODE ||
    ''
  )
    .trim()
    .toLowerCase()
  if (raw === 'zero') return 'zero'
  if (raw === 'identity' || raw === 'id' || raw === 'block') return 'identity'
  return 'stock'
}

export function getKinTimezone(): string {
  const tz = (
    process.env.CLAUDE_CODE_TIMEZONE ||
    process.env.KIN_SLOT_TZ ||
    process.env.TZ ||
    'America/New_York'
  ).trim()
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

/** Match HTTP 0-inject: prompt_version=<identity>; keep cc_prompt_id.
 * cch stays 00000 here. The fetch sealer writes the real digest on the wire bytes. */
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
  if (!/\bcc_prompt_id=/.test(header))
    header += ` cc_prompt_id=${billingPromptId()};`
  return `${header} cch=00000; prompt_version=<${IDENTITY}>`
}

function withCchPlaceholder(header: string): string {
  const reset = header.replace(/\bcch=[0-9a-f]{5}/gi, 'cch=00000')
  if (/\bcch=00000/i.test(reset)) return reset
  const base = reset.endsWith(';') ? reset : `${reset};`
  return `${base} cch=00000;`
}

export function layoutSystemBlocks(opts: {
  attribution: string
  leftover?: string
}): string[] {
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

export function billingFromSystemPrompt(
  systemPrompt: readonly string[],
): string | undefined {
  for (const block of systemPrompt) {
    const text = (block || '').trim()
    if (text.startsWith('x-anthropic-billing-header')) return text
  }
  return undefined
}

export function leftoverFromSystemPrompt(
  systemPrompt: readonly string[],
): string | undefined {
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
  if (text.includes('mcp__kin_runtime__')) return true
  return false
}
