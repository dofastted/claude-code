/**
 * Outbound Claude Code version for UA and billing.
 * This tree targets Claude Code 2.1.303. Runtime SSOT is still
 * CLAUDE_CODE_VERSION from kernel when the control plane sets it
 * (vm2api OFFICIAL_CLI_VERSION).
 */
export const WRAP_OFFICIAL_CLI_VERSION = '2.1.303'

export function officialCliVersion(): string {
  const raw = String(process.env.CLAUDE_CODE_VERSION || '').trim()
  const m = raw.match(/(\d+\.\d+\.\d+)/)
  if (m) return m[1]
  return WRAP_OFFICIAL_CLI_VERSION
}
