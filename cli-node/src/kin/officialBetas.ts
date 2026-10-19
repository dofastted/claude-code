/**
 * Claude Code 2.1.296 first-party Messages wire order.
 * Field-gated betas are added from each request, not process-wide defaults.
 * OAuth is retained only when the credential's base list declares it.
 */
export const OFFICIAL_MESSAGE_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
  'per-turn-control-2026-07-01',
  'mid-conversation-tool-changes-2026-07-01',
  'effort-2025-11-24',
] as const

/** Common first-party tokens absent from the fork's base model list. */
export const OFFICIAL_EXTRA_BETAS = [
  'thinking-token-count-2026-05-13',
  'mid-conversation-system-2026-04-07',
] as const

export function mergeOfficialExtraBetas(betas: string[]): string[] {
  const have = [...betas]
  for (const beta of OFFICIAL_EXTRA_BETAS) {
    if (!have.includes(beta)) have.push(beta)
  }
  const out: string[] = []
  for (const beta of OFFICIAL_MESSAGE_BETAS) {
    if (have.includes(beta)) out.push(beta)
  }
  for (const beta of have) {
    if (!out.includes(beta)) out.push(beta)
  }
  return out
}
