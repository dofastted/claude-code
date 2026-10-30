import { feature } from 'bun:bundle'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from '../../tools/EnterPlanModeTool/constants.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '../../tools/ExitPlanModeTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from '../../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../../tools/GrepTool/prompt.js'
import { LIST_MCP_RESOURCES_TOOL_NAME } from '../../tools/ListMcpResourcesTool/prompt.js'
import { LSP_TOOL_NAME } from '../../tools/LSPTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../tools/SendMessageTool/constants.js'
import { SLEEP_TOOL_NAME } from '../../tools/SleepTool/prompt.js'
import { TASK_CREATE_TOOL_NAME } from '../../tools/TaskCreateTool/constants.js'
import { TASK_GET_TOOL_NAME } from '../../tools/TaskGetTool/constants.js'
import { TASK_LIST_TOOL_NAME } from '../../tools/TaskListTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '../../tools/TaskStopTool/prompt.js'
import { TASK_UPDATE_TOOL_NAME } from '../../tools/TaskUpdateTool/constants.js'
import { TEAM_CREATE_TOOL_NAME } from '../../tools/TeamCreateTool/constants.js'
import { TEAM_DELETE_TOOL_NAME } from '../../tools/TeamDeleteTool/constants.js'
import { TODO_WRITE_TOOL_NAME } from '../../tools/TodoWriteTool/constants.js'
import { TOOL_SEARCH_TOOL_NAME } from '../../tools/ToolSearchTool/prompt.js'
import { YOLO_CLASSIFIER_TOOL_NAME } from './yoloClassifier.js'

// Ant-only tool names: conditional require so Bun can DCE these in external builds.
// Gates mirror tools.ts. Keeps the tool name strings out of cli.js.
/* eslint-disable @typescript-eslint/no-require-imports */
const TERMINAL_CAPTURE_TOOL_NAME = feature('TERMINAL_PANEL')
  ? (
      require('../../tools/TerminalCaptureTool/prompt.js') as typeof import('../../tools/TerminalCaptureTool/prompt.js')
    ).TERMINAL_CAPTURE_TOOL_NAME
  : null
const OVERFLOW_TEST_TOOL_NAME = feature('OVERFLOW_TEST_TOOL')
  ? (
      require('../../tools/OverflowTestTool/OverflowTestTool.js') as typeof import('../../tools/OverflowTestTool/OverflowTestTool.js')
    ).OVERFLOW_TEST_TOOL_NAME
  : null
const VERIFY_PLAN_EXECUTION_TOOL_NAME =
  process.env.USER_TYPE === 'ant'
    ? (
        require('../../tools/VerifyPlanExecutionTool/constants.js') as typeof import('../../tools/VerifyPlanExecutionTool/constants.js')
      ).VERIFY_PLAN_EXECUTION_TOOL_NAME
    : null
const WORKFLOW_TOOL_NAME = feature('WORKFLOW_SCRIPTS')
  ? (
      require('../../tools/WorkflowTool/constants.js') as typeof import('../../tools/WorkflowTool/constants.js')
    ).WORKFLOW_TOOL_NAME
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

const PLUGIN_SKILL_SAFE_TOOL_NAMES = [
  'SearchPlugins',
  'SearchSkills',
  'SuggestPluginInstall',
  'SuggestSkills',
  'ListPlugins',
  'ListSkills',
] as const

/**
 * Tools that are safe and don't need any classifier checking.
 * Does NOT include write/edit tools — those are handled by the
 * acceptEdits fast path (allowed in CWD, classified outside CWD).
 * TaskOutput is gone in 2.1.310; browser tools are input predicates below.
 */
const SAFE_YOLO_ALLOWLISTED_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  LSP_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  LIST_MCP_RESOURCES_TOOL_NAME,
  'ReadMcpResourceTool',
  'ReadMcpResourceDirTool',
  'RefreshMcpTools',
  TODO_WRITE_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  'ReportFindings',
  ASK_USER_QUESTION_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  'ConnectGitHub',
  'ShowOnboardingRolePicker',
  TEAM_CREATE_TOOL_NAME,
  TEAM_DELETE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  ...(WORKFLOW_TOOL_NAME ? [WORKFLOW_TOOL_NAME] : []),
  SLEEP_TOOL_NAME,
  ...(TERMINAL_CAPTURE_TOOL_NAME ? [TERMINAL_CAPTURE_TOOL_NAME] : []),
  ...(OVERFLOW_TEST_TOOL_NAME ? [OVERFLOW_TEST_TOOL_NAME] : []),
  ...(VERIFY_PLAN_EXECUTION_TOOL_NAME ? [VERIFY_PLAN_EXECUTION_TOOL_NAME] : []),
  YOLO_CLASSIFIER_TOOL_NAME,
  ...PLUGIN_SKILL_SAFE_TOOL_NAMES,
])

const CHROME_PREFIXES = [
  'mcp__claude-in-chrome__',
  'mcp__Claude_in_Chrome__',
  'mcp__remote-devices__claude-in-chrome__',
  'mcp__remote-devices__Claude_in_Chrome__',
  'mcp__claude-device__chrome_',
  'mcp__Claude_Preview__',
  'mcp__Claude_Browser__',
  'mcp__remote-devices__Claude_Browser__',
]
const BROWSER_PREFIXES = [
  'mcp__Claude_Preview__',
  'mcp__Claude_Browser__',
  'mcp__remote-devices__Claude_Browser__',
]

const BROWSER_SAFE_ACTIONS = [
  'find',
  'get_page_text',
  'list_connected_browsers',
  'read_page',
  'resize_window',
  'shortcuts_list',
  'switch_browser',
  'tabs_close_mcp',
]

const COMPUTER_CLICKS = new Set([
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_click_drag',
])
const COMPUTER_SAFE_ACTIONS = new Set([
  'screenshot',
  'zoom',
  'wait',
  'get_page_text',
  'find',
  'scroll',
  'scroll_to',
  'hover',
  'mouse_move',
  'cursor_position',
  ...COMPUTER_CLICKS,
])

type ToolInput = Record<string, unknown> | undefined

function notClear(input: ToolInput): boolean {
  return !input?.clear
}
function notCreateIfEmpty(input: ToolInput): boolean {
  return !input?.createIfEmpty
}
function computerSafe(input: ToolInput): boolean {
  if (!COMPUTER_SAFE_ACTIONS.has(String(input?.action))) return false
  return !input?.save_to_disk
}

const PREFIXED_INPUT_PREDICATES = new Map<string, (input: ToolInput) => boolean>([
  ['read_console_messages', notClear],
  ['read_network_requests', notClear],
  ['tabs_context_mcp', notCreateIfEmpty],
])

function prefixedNames(
  suffixes: readonly string[],
  prefixes: readonly string[] = CHROME_PREFIXES,
): string[] {
  return suffixes.flatMap(suffix => prefixes.map(prefix => prefix + suffix))
}

const BROWSER_ALLOWLIST = new Set(prefixedNames(BROWSER_SAFE_ACTIONS))
for (const name of prefixedNames(['tabs_close', 'tabs_select'], BROWSER_PREFIXES)) {
  BROWSER_ALLOWLIST.add(name)
}

const BROWSER_INPUT_PREDICATES = new Map<string, (input: ToolInput) => boolean>()
for (const [suffix, predicate] of PREFIXED_INPUT_PREDICATES) {
  for (const name of prefixedNames([suffix])) BROWSER_INPUT_PREDICATES.set(name, predicate)
}
for (const name of prefixedNames(['tabs_context'], BROWSER_PREFIXES)) {
  BROWSER_INPUT_PREDICATES.set(name, notCreateIfEmpty)
}

const COMPUTER_TOOLS = new Set(prefixedNames(['computer']))
const BROWSER_BATCH_TOOLS = new Set(prefixedNames(['browser_batch']))
const BATCH_SAFE_NAMES = new Set(BROWSER_SAFE_ACTIONS)
const BATCH_INPUT_PREDICATES = new Map<string, (input: ToolInput) => boolean>([
  ['computer', computerSafe],
  ...PREFIXED_INPUT_PREDICATES,
])

function batchActionSafe(action: unknown): boolean {
  if (typeof action !== 'object' || action === null) return false
  const record = action as { name?: unknown; input?: ToolInput }
  if (typeof record.name !== 'string') return false
  const predicate = BATCH_INPUT_PREDICATES.get(record.name)
  if (predicate) return predicate(record.input)
  return BATCH_SAFE_NAMES.has(record.name)
}

/**
 * Safe allowlist. `excludedFromAutoModeAllowlist()` forces the classifier.
 * Browser tools are safe only for the read/click actions that do not write disk.
 */
export function isAutoModeAllowlistedTool(
  tool: { name: string; excludedFromAutoModeAllowlist?: () => boolean },
  input?: unknown,
): boolean {
  if (tool.excludedFromAutoModeAllowlist?.() === true) return false
  const name = tool.name
  const record = (input ?? undefined) as ToolInput
  if (SAFE_YOLO_ALLOWLISTED_TOOLS.has(name)) return true
  if (BROWSER_ALLOWLIST.has(name)) return true
  const predicate = BROWSER_INPUT_PREDICATES.get(name)
  if (predicate) return predicate(record)
  if (COMPUTER_TOOLS.has(name)) return computerSafe(record)
  if (BROWSER_BATCH_TOOLS.has(name)) {
    const actions = record?.actions
    if (!Array.isArray(actions) || actions.length === 0) return false
    return actions.every(batchActionSafe)
  }
  return false
}
