// Critical system constants extracted to break circular dependencies

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { logForDebugging } from '../utils/debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../utils/envUtils.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from '../utils/model/providers.js'
import { getWorkload } from '../utils/workloadContext.js'
import { officialCliVersion } from '../kin/cliVersion.js'
import { readPanelCcEntrypoint } from '../kin/cacheTtl.js'
export const CC_VERSION = '2.1.296'

const DEFAULT_PREFIX = `You are Claude Code, Anthropic's official CLI for Claude.`
const AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX = `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.`
const AGENT_SDK_PREFIX = `You are a Claude agent, built on Anthropic's Claude Agent SDK.`

const CLI_SYSPROMPT_PREFIX_VALUES = [DEFAULT_PREFIX, AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX, AGENT_SDK_PREFIX] as const

export type CLISyspromptPrefix = (typeof CLI_SYSPROMPT_PREFIX_VALUES)[number]

/**
 * All possible CLI sysprompt prefix values, used by splitSysPromptPrefix
 * to identify prefix blocks by content rather than position.
 */
export const CLI_SYSPROMPT_PREFIXES: ReadonlySet<string> = new Set(CLI_SYSPROMPT_PREFIX_VALUES)

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
 * 2.1.303 billing line (`GPo`). `cch=00000` is the placeholder the native
 * scanner overwrites. Empty fragments are omitted. Order is fixed.
 */
const PROJECT_ID =
  /^claude_proj_(?:staging_|local_)?01[1-9A-HJ-NP-Za-km-z]{22}$/
const PROJECT_SOURCES: Record<string, true> = {
  harness: true,
  user: true,
  project: true,
  local: true,
  flag: true,
  managed: true,
  admin_default: true,
}
const SELF_HOSTED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.lan',
  '.home',
  '.localdomain',
]

export type AttributionOptions = {
  isSubagent?: boolean
  prevReqId?: string
  promptId?: string
  turnOrigin?: string
  promptIndex?: number
  turnIndex?: number
  includeCch?: boolean
  includeSubscriberFields?: boolean
  /** `1` when the gateway credential is verified, otherwise `env`. */
  gateway?: '1' | 'env'
  gatewayUrl?: string
  /** `vouched` drops cc_gateway. */
  hostVerdict?: string
  projectId?: string
  projectSource?: string
}

function billingProvider(): 'gateway' | 'firstParty' | 'bedrock' | 'vertex' | 'foundry' {
  if (
    process.env.CLAUDE_CODE_USE_GATEWAY === '1' ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_GATEWAY)
  ) {
    return 'gateway'
  }
  return getAPIProvider()
}

/** xi(): declared official host, or no ANTHROPIC_BASE_URL. */
function officialClientUrl(): boolean {
  return !process.env.ANTHROPIC_BASE_URL || isFirstPartyAnthropicBaseUrl()
}

function firstPartyBillingGate(): boolean {
  return billingProvider() === 'firstParty' && officialClientUrl()
}

export function attributionGates(isSubscriber: boolean): {
  includeCch: boolean
  includeSubscriberFields: boolean
} {
  const provider = billingProvider()
  return {
    includeCch:
      (provider === 'firstParty' && officialClientUrl()) || provider === 'vertex',
    includeSubscriberFields: provider === 'firstParty' && (isSubscriber || officialClientUrl()),
  }
}

function selfHostedHost(host: string): boolean {
  const name = host.toLowerCase()
  if (name === 'localhost' || name.endsWith('.localhost')) return true
  return SELF_HOSTED_HOST_SUFFIXES.some(
    (suffix) => name.endsWith(suffix) && name !== suffix.slice(1),
  )
}


export function resolveTurnOrigin(querySource: unknown): string | undefined {
  if (typeof querySource === 'string' && /^[a-z][a-z_]{0,31}$/.test(querySource)) {
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
  if ('message' in message && message.message && typeof message.message === 'object' && 'content' in message.message) {
    return message.message.content
  }
  return undefined
}

function toolResultOnly(message: unknown): boolean {
  const content = messageContent(message)
  if (!Array.isArray(content) || content.length === 0) return false
  return content.every((block) => {
    if (!block || typeof block !== 'object' || !('type' in block)) return false
    return block.type === 'tool_result'
  })
}

/** Keep the billing prefix stable across turns, matching the control plane. */
export function billingIndexesFromMessages(messages: unknown): {
  promptIndex: number
  turnIndex: number
} | null {
  if (!Array.isArray(messages)) return null
  let prompts = 0
  for (const message of messages) {
    const role = messageRole(message)
    if (role === 'user' && !toolResultOnly(message)) prompts += 1
  }
  if (prompts < 1) return null
  return { promptIndex: 0, turnIndex: 1 }
}

export function getAttributionHeader(fingerprint: string, opts: AttributionOptions = {}): string {
  if (!isAttributionHeaderEnabled()) {
    return ''
  }

  const version = `${officialCliVersion()}.${fingerprint}`
  const entrypoint = readPanelCcEntrypoint()
  const cch = opts.includeCch === false ? '' : ' cch=00000;'
  const workload = getWorkload()
  const workloadPair = workload ? ` cc_workload=${workload};` : ''
  const subscriber = opts.includeSubscriberFields === true && firstPartyBillingGate()
  const sub = opts.isSubagent ? ' cc_is_subagent=true;' : ''
  const prev =
    subscriber && opts.prevReqId && /^req_[A-Za-z0-9_-]{1,36}$/.test(opts.prevReqId)
      ? ` cc_prev_req=${opts.prevReqId};`
      : ''
  const prompt =
    subscriber &&
    opts.promptId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opts.promptId)
      ? ` cc_prompt_id=${opts.promptId};`
      : ''
  const origin =
    subscriber && opts.turnOrigin && /^[a-z][a-z_]{0,31}$/.test(opts.turnOrigin)
      ? ` cc_turn_origin=${opts.turnOrigin};`
      : ''
  const promptIndex = boundedBillingIndex(opts.promptIndex, 0)
  const turnIndex = boundedBillingIndex(opts.turnIndex, 1)
  const indexes =
    subscriber && promptIndex !== undefined && turnIndex !== undefined
      ? ` cc_prompt_index=${promptIndex}; cc_turn_index=${turnIndex};`
      : ''
  let gateway = ''
  if (opts.gateway === '1' || opts.gateway === 'env') {
    let excluded = opts.hostVerdict?.includes('vouched') === true
    if (!excluded && opts.gatewayUrl) {
      try {
        const host = new URL(opts.gatewayUrl).host
        excluded = !host || selfHostedHost(host)
      } catch {
        excluded = true
      }
    }
    if (!excluded) gateway = ` cc_gateway=${opts.gateway};`
  }
  let project = ''
  if (
    !process.env.ANTHROPIC_UNIX_SOCKET &&
    !isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
    firstPartyBillingGate() &&
    opts.projectId &&
    PROJECT_ID.test(opts.projectId) &&
    opts.projectSource &&
    Object.hasOwn(PROJECT_SOURCES, opts.projectSource)
  ) {
    project = ` cc_project=${opts.projectId}; cc_project_src=${opts.projectSource};`
  }
  const header = `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=${entrypoint};${cch}${workloadPair}${sub}${prev}${prompt}${origin}${indexes}${gateway}${project}`

  logForDebugging(`attribution header ${header}`)
  return header
}
