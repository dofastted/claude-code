import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { ToolPermissionContext } from '../../Tool.js'
import { isBareMode, isEnvTruthy } from '../envUtils.js'
import type { PermissionMode } from './PermissionMode.js'

/**
 * Official 2.1.293 `--proactivity` levels (`Tee` / `ASt` / `Bie`).
 * Not KAIROS Sleep / activateProactive.
 */
export const PROACTIVITY_LEVELS = ['ask', 'default', 'proactive'] as const
export type ProactivityLevel = (typeof PROACTIVITY_LEVELS)[number]
export const DEFAULT_PROACTIVITY_LEVEL: ProactivityLevel = 'default'

export const RELAUNCH_PROACTIVITY_LEVEL_ENV = 'CLAUDE_CODE_RELAUNCH_PROACTIVITY_LEVEL'
export const RELAUNCH_PROACTIVITY_EVER_ON_ENV =
  'CLAUDE_CODE_RELAUNCH_PROACTIVITY_EVER_ON'
export const RELAUNCH_PROACTIVITY_DECIDED_ENV =
  'CLAUDE_CODE_RELAUNCH_PROACTIVITY_DECIDED'

/** Official `ga` copy when `--proactivity ask` cannot run the selector. */
export const PROACTIVITY_ASK_UNAVAILABLE_NOTIFICATION =
  "--proactivity ask isn't available here · Started in manual mode"

export type ProactivityModeCapabilities = {
  isAutoModeAvailable: boolean
  isBypassPermissionsModeAvailable: boolean
}

export type ProactivityLevelSource = 'handoff' | 'cli' | 'default'

export type ResolvedProactivityLevel = {
  level: ProactivityLevel
  source: ProactivityLevelSource
}

export function isProactivityLevel(
  value: unknown,
): value is ProactivityLevel {
  return (
    typeof value === 'string' &&
    (PROACTIVITY_LEVELS as readonly string[]).includes(value)
  )
}

/**
 * Official `Xn`: attachments enabled. Selector cannot go live without them.
 * `br()` is `--bare` / `CLAUDE_CODE_SIMPLE`.
 */
export function isProactivityAttachmentsEnabled(): boolean {
  return (
    !isBareMode() &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS)
  )
}

/**
 * Official `Du()`: `!CLAUDE_CODE_DISABLE_PROACTIVITY && T("tengu_proactivity_selector", true)`.
 * Default true — do not use the Statsig helper (defaults false).
 */
export function isProactivitySelectorGateEnabled(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_PROACTIVITY)) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_proactivity_selector',
    true,
  )
}

/**
 * Official `pC()` without a fake `host.proactivity` object: attachments && Du().
 * Passing `--proactivity` (or a relaunch handoff level) is the Sa() arming
 * equivalent; callers only consult this after a level is present.
 */
export function isProactivitySelectorAvailable(): boolean {
  return (
    isProactivityAttachmentsEnabled() && isProactivitySelectorGateEnabled()
  )
}

/**
 * Official `zGo`. Parent supplies the same startup flags it already has;
 * this helper does not invent a remote-session host.
 */
export function isRemoteThinClientSession({
  remote,
  isNonInteractiveSession,
  headlessCloud = false,
  headlessCloudPrint = false,
  isContinue = false,
  pendingAssistantChat,
  pendingConnectUrl,
  pendingSSHHost,
}: {
  remote?: unknown
  isNonInteractiveSession: boolean
  headlessCloud?: boolean
  headlessCloudPrint?: boolean
  isContinue?: boolean
  pendingAssistantChat?: { sessionId?: string; discover?: unknown } | null
  pendingConnectUrl?: string
  pendingSSHHost?: string
}): boolean {
  if (isNonInteractiveSession) return headlessCloud || headlessCloudPrint
  if (isContinue) return false
  return (
    remote != null ||
    Boolean(pendingAssistantChat?.sessionId) ||
    Boolean(pendingAssistantChat?.discover) ||
    Boolean(pendingConnectUrl) ||
    Boolean(pendingSSHHost)
  )
}

/**
 * Official `d1o`: consume relaunch level env if it is a real Tee value.
 */
export function consumeRelaunchProactivityLevel():
  | ProactivityLevel
  | undefined {
  const raw = process.env[RELAUNCH_PROACTIVITY_LEVEL_ENV]
  delete process.env[RELAUNCH_PROACTIVITY_LEVEL_ENV]
  if (isProactivityLevel(raw)) return raw
  delete process.env[RELAUNCH_PROACTIVITY_DECIDED_ENV]
  delete process.env[RELAUNCH_PROACTIVITY_EVER_ON_ENV]
  return undefined
}

/** Official `fa` (persisted `Pln` is a no-op in 2.1.293). */
export function resolveStartupProactivityLevel(
  cliLevel: string | undefined,
): ResolvedProactivityLevel {
  const handoff = consumeRelaunchProactivityLevel()
  if (handoff !== undefined) {
    return { level: handoff, source: 'handoff' }
  }
  if (isProactivityLevel(cliLevel)) {
    return { level: cliLevel, source: 'cli' }
  }
  return { level: DEFAULT_PROACTIVITY_LEVEL, source: 'default' }
}

/**
 * Official `ha`: keep the resolved startup level only when the selector is
 * live and this process is not a remote thin client.
 */
export function keepStartupProactivityLevel({
  startupLevel,
  startsAsRemoteThinClient = false,
}: {
  startupLevel: ResolvedProactivityLevel
  startsAsRemoteThinClient?: boolean
}): ResolvedProactivityLevel | undefined {
  if (isProactivitySelectorAvailable() && !startsAsRemoteThinClient) {
    return startupLevel
  }
  return undefined
}

/**
 * Invocation-supplied mode that wins over proactivity remapping.
 * Settings `defaultMode` is intentionally excluded.
 */
export function permissionModeSuppliedOnInvocation({
  permissionModeCli,
  inheritPermissionModeCli,
  dangerouslySkipPermissions,
  agentPermissionMode,
}: {
  permissionModeCli?: string
  inheritPermissionModeCli?: string
  dangerouslySkipPermissions?: boolean
  agentPermissionMode?: string
}): boolean {
  return Boolean(
    permissionModeCli ||
      inheritPermissionModeCli ||
      dangerouslySkipPermissions ||
      agentPermissionMode,
  )
}

export function permissionModeCapabilitiesFromContext(
  context: ToolPermissionContext,
): ProactivityModeCapabilities {
  return {
    isAutoModeAvailable: context.isAutoModeAvailable === true,
    isBypassPermissionsModeAvailable:
      context.isBypassPermissionsModeAvailable === true &&
      context.restricted !== true,
  }
}

/**
 * Official `cle`. Uses caller-provided initialized capabilities — never
 * assumes auto/bypass are available.
 */
export function mapProactivityLevelToPermissionMode(
  level: ProactivityLevel,
  capabilities: ProactivityModeCapabilities,
  baseline: PermissionMode = 'default',
): PermissionMode {
  switch (level) {
    case 'ask':
      return capabilities.isAutoModeAvailable ? 'auto' : 'default'
    case 'default': {
      if (capabilities.isAutoModeAvailable) return 'auto'
      const sanitized = baseline
      if (
        sanitized === 'auto' ||
        (sanitized === 'bypassPermissions' &&
          !capabilities.isBypassPermissionsModeAvailable)
      ) {
        return 'default'
      }
      return sanitized
    }
    case 'proactive':
      if (capabilities.isBypassPermissionsModeAvailable) {
        return 'bypassPermissions'
      }
      return capabilities.isAutoModeAvailable ? 'auto' : 'acceptEdits'
  }
}

export type SelectProactivityPermissionModeInput = {
  context: ToolPermissionContext
  cliProactivityLevel?: string
  permissionModeCli?: string
  inheritPermissionModeCli?: string
  dangerouslySkipPermissions?: boolean
  agentPermissionMode?: string
  startsAsRemoteThinClient?: boolean
}

export type SelectProactivityPermissionModeResult = {
  mode: PermissionMode
  notification?: string
  decidedByProactivityLevel: boolean
  modeSuppliedOnInvocation: boolean
  /** ha() kept level; undefined means selector/thin-client dropped it. */
  proactivityLevel?: ProactivityLevel
  startupLevel: ResolvedProactivityLevel
}

/**
 * Official `ga` + `ha` + `mpr` proactivity branch against an already
 * initialized ToolPermissionContext. Does not mutate context.
 */
export function selectProactivityPermissionMode({
  context,
  cliProactivityLevel,
  permissionModeCli,
  inheritPermissionModeCli,
  dangerouslySkipPermissions,
  agentPermissionMode,
  startsAsRemoteThinClient = false,
}: SelectProactivityPermissionModeInput): SelectProactivityPermissionModeResult {
  const modeSupplied = permissionModeSuppliedOnInvocation({
    permissionModeCli,
    inheritPermissionModeCli,
    dangerouslySkipPermissions,
    agentPermissionMode,
  })
  const startupLevel = resolveStartupProactivityLevel(cliProactivityLevel)
  const selectorAvailable = isProactivitySelectorAvailable()
  const kept = keepStartupProactivityLevel({
    startupLevel,
    startsAsRemoteThinClient,
  })

  let notification: string | undefined
  if (
    cliProactivityLevel === 'ask' &&
    !modeSupplied &&
    !selectorAvailable
  ) {
    notification = PROACTIVITY_ASK_UNAVAILABLE_NOTIFICATION
  }

  const baseline = context.mode
  if (
    kept &&
    kept.level !== 'default' &&
    !modeSupplied
  ) {
    const capabilities = permissionModeCapabilitiesFromContext(context)
    const mapped = mapProactivityLevelToPermissionMode(
      kept.level,
      capabilities,
      baseline,
    )
    return {
      mode: mapped,
      notification,
      decidedByProactivityLevel: true,
      modeSuppliedOnInvocation: modeSupplied,
      proactivityLevel: kept.level,
      startupLevel,
    }
  }

  return {
    mode: baseline,
    notification,
    decidedByProactivityLevel: false,
    modeSuppliedOnInvocation: modeSupplied,
    proactivityLevel: kept?.level,
    startupLevel,
  }
}
