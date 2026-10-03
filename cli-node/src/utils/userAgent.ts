/**
 * User-Agent string helpers.
 *
 * Kept dependency-free so SDK-bundled code (bridge, cli/transports) can
 * import without pulling in auth.ts and its transitive dependency tree.
 */
import { officialCliVersion } from '../kin/cliVersion.js'

export function getClaudeCodeUserAgent(): string {
  return `claude-code/${officialCliVersion()}`
}
