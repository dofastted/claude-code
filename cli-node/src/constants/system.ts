// Critical system constants extracted to break circular dependencies

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { logForDebugging } from '../utils/debug.js'
import { isEnvDefinedFalsy } from '../utils/envUtils.js'
import { getAPIProvider } from '../utils/model/providers.js'
import { getWorkload } from '../utils/workloadContext.js'
import { officialCliVersion } from '../kin/cliVersion.js'
export const CC_VERSION = '2.1.284'

const DEFAULT_PREFIX = `You are Claude Code, Anthropic's official CLI for Claude.`
const AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX = `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.`
const AGENT_SDK_PREFIX = `You are a Claude agent, built on Anthropic's Claude Agent SDK.`

const CLI_SYSPROMPT_PREFIX_VALUES = [
  DEFAULT_PREFIX,
  AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX,
  AGENT_SDK_PREFIX,
] as const

export type CLISyspromptPrefix = (typeof CLI_SYSPROMPT_PREFIX_VALUES)[number]

/**
 * All possible CLI sysprompt prefix values, used by splitSysPromptPrefix
 * to identify prefix blocks by content rather than position.
 */
export const CLI_SYSPROMPT_PREFIXES: ReadonlySet<string> = new Set(
  CLI_SYSPROMPT_PREFIX_VALUES,
)

export function getCLISyspromptPrefix(options?: {
  isNonInteractive: boolean
  hasAppendSystemPrompt: boolean
}): CLISyspromptPrefix {
  const apiProvider = getAPIProvider()
  if (apiProvider === 'vertex') {
    return DEFAULT_PREFIX
  }

  if (options?.isNonInteractive) {
    if (options.hasAppendSystemPrompt) {
      return AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX
    }
    return AGENT_SDK_PREFIX
  }
  return DEFAULT_PREFIX
}

/**
 * Check if attribution header is enabled.
 * Enabled by default, can be disabled via env var or GrowthBook killswitch.
 */
function isAttributionHeaderEnabled(): boolean {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_attribution_header', true)
}

/**
 * 2.1.284 billing block. cch=00000 is overwritten in fetch() by utils/cch.ts
 * because this tree has no Bun native attestation. The hash formula is unchanged.
 * cc_prompt_id, cc_prev_req, cc_turn_origin, and the prompt/turn indexes are
 * first-party subscriber only. cc_is_subagent is not.
 */
export type AttributionOptions = {
  includeCch?: boolean
  includeSubscriberFields?: boolean
  isSubagent?: boolean
  prevReqId?: string
  promptId?: string
  turnOrigin?: string
  promptIndex?: number
  turnIndex?: number
}

export function attributionGates(isSubscriber: boolean): {
  includeCch: boolean
  includeSubscriberFields: boolean
} {
  const provider = getAPIProvider()
  const firstPartySub = provider === 'firstParty' && isSubscriber
  return {
    includeCch: firstPartySub || provider === 'vertex',
    includeSubscriberFields: firstPartySub,
  }
}

export function resolveTurnOrigin(querySource: unknown): string | undefined {
  if (
    typeof querySource === 'string' &&
    /^[a-z][a-z_]{0,31}$/.test(querySource)
  ) {
    return querySource
  }
  const entry = process.env.CLAUDE_CODE_ENTRYPOINT
  if (entry === 'sdk-cli' || entry === 'sdk-ts' || entry === 'sdk-py') {
    return 'sdk'
  }
  if (entry === 'cli') return 'cli'
  return undefined
}

const BILLING_INDEX_MAX = 1e7

function boundedBillingIndex(value: unknown, min: number): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  if (value < min || value > BILLING_INDEX_MAX) return undefined
  return value
}

function messageRole(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  if ('role' in message && message.role != null) return String(message.role)
  if (
    'message' in message &&
    message.message &&
    typeof message.message === 'object' &&
    'role' in message.message &&
    message.message.role != null
  ) {
    return String(message.message.role)
  }
  return ''
}

function messageContent(message: unknown): unknown {
  if (!message || typeof message !== 'object') return undefined
  if ('content' in message) return message.content
  if (
    'message' in message &&
    message.message &&
    typeof message.message === 'object' &&
    'content' in message.message
  ) {
    return message.message.content
  }
  return undefined
}

function toolResultOnly(message: unknown): boolean {
  const content = messageContent(message)
  if (!Array.isArray(content) || content.length === 0) return false
  return content.every(block => {
    if (!block || typeof block !== 'object' || !('type' in block)) return false
    return block.type === 'tool_result'
  })
}

/** promptIndex is the latest user prompt. turnIndex is the upcoming model turn. */
export function billingIndexesFromMessages(messages: unknown): {
  promptIndex: number
  turnIndex: number
} | null {
  if (!Array.isArray(messages)) return null
  let prompts = 0
  let assistants = 0
  for (const message of messages) {
    const role = messageRole(message)
    if (role === 'assistant') assistants += 1
    else if (role === 'user' && !toolResultOnly(message)) prompts += 1
  }
  if (prompts < 1) return null
  return { promptIndex: prompts - 1, turnIndex: assistants + 1 }
}

export function getAttributionHeader(
  fingerprint: string,
  opts: AttributionOptions = {},
): string {
  if (!isAttributionHeaderEnabled()) {
    return ''
  }

  const version = `${officialCliVersion()}.${fingerprint}`
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? 'unknown'
  const cch = opts.includeCch ? ' cch=00000;' : ''
  const workload = getWorkload()
  const workloadPair = workload ? ` cc_workload=${workload};` : ''
  const sub = opts.isSubagent ? ' cc_is_subagent=true;' : ''
  const subscriber = opts.includeSubscriberFields
  const prev =
    subscriber &&
    opts.prevReqId &&
    /^req_[A-Za-z0-9_-]{1,36}$/.test(opts.prevReqId)
      ? ` cc_prev_req=${opts.prevReqId};`
      : ''
  const prompt =
    subscriber &&
    opts.promptId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      opts.promptId,
    )
      ? ` cc_prompt_id=${opts.promptId};`
      : ''
  const origin =
    subscriber &&
    opts.turnOrigin &&
    /^[a-z][a-z_]{0,31}$/.test(opts.turnOrigin)
      ? ` cc_turn_origin=${opts.turnOrigin};`
      : ''
  const promptIndex = subscriber ? boundedBillingIndex(opts.promptIndex, 0) : undefined
  const turnIndex = subscriber ? boundedBillingIndex(opts.turnIndex, 1) : undefined
  const indexes =
    promptIndex !== undefined && turnIndex !== undefined
      ? ` cc_prompt_index=${promptIndex}; cc_turn_index=${turnIndex};`
      : ''
  const header = `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=${entrypoint};${cch}${workloadPair}${sub}${prev}${prompt}${origin}${indexes}`

  logForDebugging(`attribution header ${header}`)
  return header
}
