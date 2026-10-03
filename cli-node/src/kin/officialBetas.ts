/**
 * 2.1.280 main Messages betas from the linux-x64 sdk-cli capture.
 * Order is the wire order, not "append whatever the fork omitted".
 * 2.1.280 sends advanced-tool-use and thinking-binding-controls together,
 * and adds mid-conversation-system-clear-at.
 * Do not add context-1m here — inbound `[1m]` / matrix owns that.
 * Outbound UA/cc_version use officialCliVersion() (2.1.280), not package.json.
 */
export const KIN_OFFICIAL_MESSAGE_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
  'advanced-tool-use-2025-11-20',
  'mid-conversation-system-clear-at-2026-08-21',
  'effort-2025-11-24',
  'thinking-binding-controls-2026-08-01',
  'extended-cache-ttl-2025-04-11',
  'cache-diagnosis-2026-04-07',
] as const

/** Tokens the wrap fork does not emit on its own. Kept for callers that only append. */
export const KIN_OFFICIAL_EXTRA_BETAS = [
  'thinking-token-count-2026-05-13',
  'mid-conversation-system-2026-04-07',
  'advanced-tool-use-2025-11-20',
  'mid-conversation-system-clear-at-2026-08-21',
  'thinking-binding-controls-2026-08-01',
  'extended-cache-ttl-2025-04-11',
  'cache-diagnosis-2026-04-07',
] as const

export function mergeOfficialExtraBetas(betas: string[]): string[] {
  const have = [...betas]
  for (const beta of KIN_OFFICIAL_EXTRA_BETAS) {
    if (!have.includes(beta)) have.push(beta)
  }
  const out: string[] = []
  for (const beta of KIN_OFFICIAL_MESSAGE_BETAS) {
    if (have.includes(beta)) out.push(beta)
  }
  for (const beta of have) {
    if (!out.includes(beta)) out.push(beta)
  }
  return out
}
