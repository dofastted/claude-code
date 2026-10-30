// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { isUltrathinkEnabled } from './thinking.js'
import { getInitialSettings } from './settings/settings.js'
import { isProSubscriber, isMaxSubscriber, isTeamSubscriber } from './auth.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { getAPIProvider } from './model/providers.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { resolveAntModel, getAntModelOverrideConfig } from './model/antModels.js'
import { getCanonicalName } from './model/model.js'
import { isEnvTruthy } from './envUtils.js'
import { readPanelModelEffort } from '../kin/cacheTtl.js'

export type { EffortLevel }

export const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly EffortLevel[]

export type EffortValue = EffortLevel | number

const EFFORT_VALUE_ALIASES: Record<string, EffortLevel> = {
  med: 'medium',
  ultracode: 'xhigh',
}

function remainingClaudeFamilySupports(
  canonical: string,
  firstPartyUnknown: boolean,
): boolean {
  if (
    canonical.includes('opus') ||
    canonical.includes('sonnet') ||
    canonical.includes('haiku')
  ) {
    return true
  }
  return firstPartyUnknown && getAPIProvider() === 'firstParty'
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports the effort parameter.
export function modelSupportsEffort(model: string): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT)) {
    return true
  }
  const supported3P = get3PModelCapabilityOverride(model, 'effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  const canonical = getCanonicalName(model)
  // Official Xv denylist
  if (
    canonical.includes('claude-3-') ||
    canonical === 'claude-opus-4' ||
    canonical === 'claude-opus-4-1' ||
    canonical === 'claude-sonnet-4' ||
    canonical === 'claude-sonnet-4-5' ||
    canonical === 'claude-haiku-4-5'
  ) {
    return false
  }
  // IMPORTANT: Do not change the default effort support without notifying
  // the model launch DRI and research. This is a sensitive setting that can
  // greatly affect model quality and bashing.
  return remainingClaudeFamilySupports(canonical, true)
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports 'max' effort.
export function modelSupportsMaxEffort(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'max_effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  const canonical = getCanonicalName(model)
  // Official Wte denylist (adds opus-4-5 vs effort)
  if (
    canonical.includes('claude-3-') ||
    canonical === 'claude-opus-4' ||
    canonical === 'claude-opus-4-1' ||
    canonical === 'claude-opus-4-5' ||
    canonical === 'claude-sonnet-4' ||
    canonical === 'claude-sonnet-4-5' ||
    canonical === 'claude-haiku-4-5'
  ) {
    return false
  }
  if (process.env.USER_TYPE === 'ant' && resolveAntModel(model)) {
    return true
  }
  return remainingClaudeFamilySupports(canonical, false)
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports 'xhigh' effort.
export function modelSupportsXHighEffort(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'xhigh_effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  const canonical = getCanonicalName(model)
  // Official Trt denylist (adds opus-4-6 and sonnet-4-6 vs max)
  if (
    canonical.includes('claude-3-') ||
    canonical === 'claude-opus-4' ||
    canonical === 'claude-opus-4-1' ||
    canonical === 'claude-opus-4-5' ||
    canonical === 'claude-opus-4-6' ||
    canonical === 'claude-sonnet-4' ||
    canonical === 'claude-sonnet-4-5' ||
    canonical === 'claude-sonnet-4-6' ||
    canonical === 'claude-haiku-4-5'
  ) {
    return false
  }
  if (process.env.USER_TYPE === 'ant' && resolveAntModel(model)) {
    return true
  }
  return remainingClaudeFamilySupports(canonical, true)
}

export function getAvailableEffortLevels(model: string): EffortLevel[] {
  return EFFORT_LEVELS.filter(level => {
    if (level === 'max') return modelSupportsMaxEffort(model)
    if (level === 'xhigh') return modelSupportsXHighEffort(model)
    return true
  })
}

export function effortLevelAboveHigh(level: EffortLevel): boolean {
  return level === 'xhigh' || level === 'max'
}

/** Official _pr: catalog thinking_disabled_effort_cap, else opus-5 only (not 5.5). */
export function modelCapsEffortWhenDisabled(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(
    model,
    'thinking_disabled_effort_cap',
  )
  if (supported3P !== undefined) {
    return supported3P
  }
  return getCanonicalName(model) === 'claude-opus-5'
}

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value === 'number' && isValidNumericEffort(value)) {
    return value
  }
  const str = String(value).toLowerCase().trim()
  const aliased = EFFORT_VALUE_ALIASES[str] ?? str
  if (isEffortLevel(aliased)) {
    return aliased
  }
  const numericValue = parseInt(str, 10)
  if (!isNaN(numericValue) && isValidNumericEffort(numericValue)) {
    return numericValue
  }
  return undefined
}

/** CLI --effort: unknown values warn and are ignored (official Crt). */
export function parseCliEffort(value: string): {
  level: EffortLevel | undefined
  warning?: string
} {
  const aliased =
    EFFORT_VALUE_ALIASES[value.trim().toLowerCase()] ??
    value.trim().toLowerCase()
  if (isEffortLevel(aliased)) {
    return { level: aliased }
  }
  return {
    level: undefined,
    warning: `Unknown --effort value '${value}' — ignoring it and using the default effort. Valid values: ${EFFORT_LEVELS.join(', ')}.`,
  }
}

/**
 * Numeric values are model-default only and not persisted.
 * 'max' is session-scoped for external users (ants can persist it).
 * Write sites call this before saving to settings so the Zod schema
 * (which only accepts string levels) never rejects a write.
 */
export function toPersistableEffort(
  value: EffortValue | undefined,
): EffortLevel | undefined {
  if (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  ) {
    return value
  }
  if (value === 'max' && process.env.USER_TYPE === 'ant') {
    return value
  }
  return undefined
}

export function getInitialEffortSetting(): EffortLevel | undefined {
  // toPersistableEffort filters 'max' for non-ants on read, so a manually
  // edited settings.json doesn't leak session-scoped max into a fresh session.
  return toPersistableEffort(getInitialSettings().effortLevel)
}

/**
 * Decide what effort level (if any) to persist when the user selects a model
 * in ModelPicker. Keeps an explicit prior /effort choice sticky even when it
 * matches the picked model's default, while letting purely-default and
 * session-ephemeral effort (CLI --effort, EffortCallout default) fall through
 * to undefined so it follows future model-default changes.
 *
 * priorPersisted must come from userSettings on disk
 * (getSettingsForSource('userSettings')?.effortLevel), NOT merged settings
 * (project/policy layers would leak into the user's global settings.json)
 * and NOT AppState.effortValue (includes session-scoped sources that
 * deliberately do not write to settings.json).
 */
export function resolvePickerEffortPersistence(
  picked: EffortLevel | undefined,
  modelDefault: EffortLevel,
  priorPersisted: EffortLevel | undefined,
  toggledInPicker: boolean,
): EffortLevel | undefined {
  const hadExplicit = priorPersisted !== undefined || toggledInPicker
  return hadExplicit || picked !== modelDefault ? picked : undefined
}

export function getEffortEnvOverride(): EffortValue | null | undefined {
  const envOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL
  return envOverride?.toLowerCase() === 'unset' ||
    envOverride?.toLowerCase() === 'auto'
    ? null
    : parseEffortValue(envOverride)
}

/**
 * Resolve the effort value that will actually be sent to the API for a given
 * model, following the full precedence chain:
 *   env CLAUDE_CODE_EFFORT_LEVEL → appState.effortValue → model default
 *
 * Returns undefined when no effort parameter should be sent (env set to
 * 'unset', or no default exists for the model).
 */
export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
): EffortValue | undefined {
  const envOverride = getEffortEnvOverride()
  if (envOverride === null) {
    return undefined
  }
  const panelEffort = readPanelModelEffort(model)
  if (panelEffort === 'off') return undefined
  const resolved =
    envOverride ?? appStateEffortValue ?? panelEffort ?? getDefaultEffortForModel(model)
  if (resolved === 'max' && !modelSupportsMaxEffort(model)) {
    return 'high'
  }
  if (resolved === 'xhigh' && !modelSupportsXHighEffort(model)) {
    return 'high'
  }
  return resolved
}

/**
 * Resolve the effort level to show the user. Wraps resolveAppliedEffort
 * with the 'high' fallback (what the API uses when no effort param is sent).
 * Single source of truth for the status bar and /effort output (CC-1088).
 */
export function getDisplayedEffortLevel(
  model: string,
  appStateEffort: EffortValue | undefined,
): EffortLevel {
  const resolved = resolveAppliedEffort(model, appStateEffort) ?? 'high'
  return convertEffortValueToLevel(resolved)
}

/**
 * Build the ` with {level} effort` suffix shown in Logo/Spinner.
 * Returns empty string if the user hasn't explicitly set an effort value.
 * Delegates to resolveAppliedEffort() so the displayed level matches what
 * the API actually receives (including max→high clamp for non-Opus models).
 */
export function getEffortSuffix(
  model: string,
  effortValue: EffortValue | undefined,
): string {
  if (effortValue === undefined) return ''
  const resolved = resolveAppliedEffort(model, effortValue)
  if (resolved === undefined) return ''
  return ` with ${convertEffortValueToLevel(resolved)} effort`
}

export function isValidNumericEffort(value: number): boolean {
  return Number.isInteger(value)
}

export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === 'string') {
    // Runtime guard: value may come from remote config (GrowthBook) where
    // TypeScript types can't help us. Coerce unknown strings to 'high'
    // rather than passing them through unchecked.
    return isEffortLevel(value) ? value : 'high'
  }
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    if (value <= 50) return 'low'
    if (value <= 85) return 'medium'
    if (value <= 100) return 'high'
    return 'max'
  }
  return 'high'
}

/**
 * Get user-facing description for effort levels
 *
 * @param level The effort level to describe
 * @returns Human-readable description
 */
export function getEffortLevelDescription(level: EffortLevel): string {
  switch (level) {
    case 'low':
      return 'Quick, straightforward implementation with minimal overhead'
    case 'medium':
      return 'Balanced approach with standard implementation and testing'
    case 'high':
      return 'Comprehensive implementation with extensive testing and documentation'
    case 'xhigh':
      return 'Deeper reasoning than high, just below maximum (on supported models)'
    case 'max':
      return 'Maximum capability with deepest reasoning. May use excessive tokens resulting in long response times or overthinking. Use sparingly for the hardest tasks.'
  }
}

/**
 * Get user-facing description for effort values (both string and numeric)
 *
 * @param value The effort value to describe
 * @returns Human-readable description
 */
export function getEffortValueDescription(value: EffortValue): string {
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    return `[ANT-ONLY] Numeric effort value of ${value}`
  }

  if (typeof value === 'string') {
    return getEffortLevelDescription(value)
  }
  return 'Balanced approach with standard implementation and testing'
}

export type OpusDefaultEffortConfig = {
  enabled: boolean
  dialogTitle: string
  dialogDescription: string
}

const OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT: OpusDefaultEffortConfig = {
  enabled: true,
  dialogTitle: 'We recommend medium effort for Opus',
  dialogDescription:
    'Effort determines how long Claude thinks for when completing your task. We recommend medium effort for most tasks to balance speed and intelligence and maximize rate limits. Use ultrathink to trigger high effort when needed.',
}

export function getOpusDefaultEffortConfig(): OpusDefaultEffortConfig {
  const config = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_grey_step2',
    OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
  )
  return {
    ...OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
    ...config,
  }
}

// @[MODEL LAUNCH]: Update the default effort levels for new models
export function getDefaultEffortForModel(
  model: string,
): EffortValue | undefined {
  if (process.env.USER_TYPE === 'ant') {
    const config = getAntModelOverrideConfig()
    const isDefaultModel =
      config?.defaultModel !== undefined &&
      model.toLowerCase() === config.defaultModel.toLowerCase()
    if (isDefaultModel && config?.defaultModelEffortLevel) {
      return config.defaultModelEffortLevel
    }
    const antModel = resolveAntModel(model)
    if (antModel) {
      if (antModel.defaultEffortLevel) {
        return antModel.defaultEffortLevel
      }
      if (antModel.defaultEffortValue !== undefined) {
        return antModel.defaultEffortValue
      }
    }
    // Always default ants to undefined/high
    return undefined
  }

  // IMPORTANT: Do not change the default effort level without notifying
  // the model launch DRI and research. Default effort is a sensitive setting
  // that can greatly affect model quality and bashing.
  // 2.1.303 catalog defaults. Only models whose capability set includes
  // effort. Haiku 4.5 lists medium but rejects the parameter. Match the id,
  // not getCanonicalName: mythos has no canonical entry.
  const id = model.toLowerCase()
  const catalogDefault: Array<[string, EffortLevel]> = [
    ['haiku-5', 'medium'],
    ['sonnet-5-5', 'medium'],
    ['sonnet-5', 'high'],
    ['sonnet-4-6', 'high'],
    ['opus-5-5', 'medium'],
    ['opus-5', 'high'],
    ['opus-4-8', 'high'],
    ['opus-4-7', 'xhigh'],
    ['opus-4-6', 'xhigh'],
    ['fable-5-1', 'high'],
    ['fable-5', 'high'],
    ['mythos-5-1', 'high'],
  ]
  const matched = catalogDefault.find(([needle]) => id.includes(needle))
  if (matched) return matched[1]



  // When ultrathink feature is on, default effort to medium (ultrathink bumps to high)
  if (isUltrathinkEnabled() && modelSupportsEffort(model)) {
    return 'medium'
  }

  // Fallback to undefined, which means we don't set an effort level. This
  // should resolve to high effort level in the API.
  return undefined
}
