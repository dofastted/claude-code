import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { REPL_TOOL_NAME } from '../../tools/REPLTool/constants.js'
import { WEB_FETCH_TOOL_NAME } from '../../tools/WebFetchTool/prompt.js'
import type { PermissionMode } from './PermissionMode.js'

export const BYPASS_NOT_SUPPORTED_IN_RESTRICTED =
  'bypassPermissions not supported in restricted mode'

const RESTRICTED_CODE_EXEC_TOOLS = [
  BASH_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  REPL_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
] as const

export function restrictedBypassConflict({
  restricted,
  permissionMode,
  allowDangerouslySkipPermissions,
}: {
  restricted: boolean
  permissionMode: PermissionMode
  allowDangerouslySkipPermissions: boolean
}): string | undefined {
  if (
    restricted &&
    (permissionMode === 'bypassPermissions' ||
      allowDangerouslySkipPermissions)
  ) {
    return BYPASS_NOT_SUPPORTED_IN_RESTRICTED
  }
  return undefined
}

/**
 * Tools restricted mode removes unless `--tools` names them.
 * Official iQr: code-execution tools + WebFetch.
 */
export function restrictedToolsToDisallow(
  namedTools: ReadonlySet<string>,
): string[] {
  const denies: string[] = []
  for (const name of RESTRICTED_CODE_EXEC_TOOLS) {
    if (!namedTools.has(name)) denies.push(name)
  }
  return denies
}
