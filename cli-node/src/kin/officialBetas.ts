/**
 * Claude Code 2.1.303 `--print` anthropic-beta order.
 * Field-gated tokens stay after this prefix when a request actually uses them.
 */
export const OFFICIAL_MESSAGE_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'per-turn-control-2026-07-01',
  'mid-conversation-tool-changes-2026-07-01',
  'advanced-tool-use-2025-11-20',
  'mid-conversation-system-clear-at-2026-08-21',
  'effort-2025-11-24',
  'thinking-binding-controls-2026-08-01',
  'extended-cache-ttl-2025-04-11',
  'cache-diagnosis-2026-04-07',
] as const

/** Tokens the native base list does not already carry. */
export const OFFICIAL_EXTRA_BETAS = [
  'thinking-token-count-2026-05-13',
  'advanced-tool-use-2025-11-20',
  'mid-conversation-system-clear-at-2026-08-21',
  'thinking-binding-controls-2026-08-01',
  'cache-diagnosis-2026-04-07',
] as const

export function mergeOfficialExtraBetas(betas: string[]): string[] {
  const out: string[] = []
  for (const beta of betas) {
    if (beta && !out.includes(beta)) out.push(beta)
  }
  for (const beta of OFFICIAL_MESSAGE_BETAS) {
    // claude-code-20250219 is a session beta. Setup-token inference rejects it,
    // and Haiku only receives it from the agentic insert.
    if (beta === 'claude-code-20250219') continue
    // auto is not in the per_turn_effort catalog. Absence is the selector's decision.
    if (beta === 'per-turn-control-2026-07-01') continue
    if (!out.includes(beta)) out.push(beta)
  }
  return out
}
