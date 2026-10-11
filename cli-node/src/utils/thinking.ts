// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import type { Theme } from './theme.js'
import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getCanonicalName } from './model/model.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { resolveAntModel } from './model/antModels.js'
import { getAPIProvider } from './model/providers.js'
import { getSettingsWithErrors } from './settings/settings.js'

export type ThinkingDisplay = 'summarized' | 'omitted'

export type ThinkingConfig =
  | { type: 'adaptive'; display?: ThinkingDisplay }
  | { type: 'enabled'; budgetTokens: number; display?: ThinkingDisplay }
  | { type: 'disabled' }

/**
 * Build-time gate (feature) + runtime gate (GrowthBook). The build flag
 * controls code inclusion in external builds; the GB flag controls rollout.
 */
export function isUltrathinkEnabled(): boolean {
  if (!feature('ULTRATHINK')) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_turtle_carbon', true)
}

/**
 * Check if text contains the "ultrathink" keyword.
 */
export function hasUltrathinkKeyword(text: string): boolean {
  return /\bultrathink\b/i.test(text)
}

/**
 * Find positions of "ultrathink" keyword in text (for UI highlighting/notification)
 */
export function findThinkingTriggerPositions(text: string): Array<{
  word: string
  start: number
  end: number
}> {
  const positions: Array<{ word: string; start: number; end: number }> = []
  // Fresh /g literal each call — String.prototype.matchAll copies lastIndex
  // from the source regex, so a shared instance would leak state from
  // hasUltrathinkKeyword's .test() into this call on the next render.
  const matches = text.matchAll(/\bultrathink\b/gi)

  for (const match of matches) {
    if (match.index !== undefined) {
      positions.push({
        word: match[0],
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return positions
}

const RAINBOW_COLORS: Array<keyof Theme> = [
  'rainbow_red',
  'rainbow_orange',
  'rainbow_yellow',
  'rainbow_green',
  'rainbow_blue',
  'rainbow_indigo',
  'rainbow_violet',
]

const RAINBOW_SHIMMER_COLORS: Array<keyof Theme> = [
  'rainbow_red_shimmer',
  'rainbow_orange_shimmer',
  'rainbow_yellow_shimmer',
  'rainbow_green_shimmer',
  'rainbow_blue_shimmer',
  'rainbow_indigo_shimmer',
  'rainbow_violet_shimmer',
]

export function getRainbowColor(
  charIndex: number,
  shimmer: boolean = false,
): keyof Theme {
  const colors = shimmer ? RAINBOW_SHIMMER_COLORS : RAINBOW_COLORS
  return colors[charIndex % colors.length]!
}

// TODO(inigo): add support for probing unknown models via API error detection
// Provider-aware thinking support detection (aligns with modelSupportsISP in betas.ts)
export function modelSupportsThinking(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'thinking')
  if (supported3P !== undefined) {
    return supported3P
  }
  if (process.env.USER_TYPE === 'ant') {
    if (resolveAntModel(model.toLowerCase())) {
      return true
    }
  }
  // IMPORTANT: Do not change thinking support without notifying the model
  // launch DRI and research. This can greatly affect model quality and bashing.
  const canonical = getCanonicalName(model)
  const provider = getAPIProvider()
  // 1P and Foundry: all Claude 4+ models (including Haiku 4.5)
  if (provider === 'foundry' || provider === 'firstParty') {
    return !canonical.includes('claude-3-')
  }
  // 3P (Bedrock/Vertex): Opus/Sonnet 4+ and 5.x, plus Haiku 4.5+
  return (
    canonical.includes('sonnet-4') ||
    canonical.includes('opus-4') ||
    canonical.includes('sonnet-5') ||
    canonical.includes('opus-5') ||
    canonical.includes('haiku-4') ||
    canonical.includes('haiku-5')
  )
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports adaptive thinking.
export function modelSupportsAdaptiveThinking(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'adaptive_thinking')
  if (supported3P !== undefined) {
    return supported3P
  }
  const canonical = getCanonicalName(model)
  // Official Vlo denylist: 3.x and older 4.x that never learned adaptive thinking.
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
  if (
    canonical.includes('opus') ||
    canonical.includes('sonnet') ||
    canonical.includes('haiku')
  ) {
    return true
  }
  // IMPORTANT: Do not change adaptive thinking support without notifying the
  // model launch DRI and research. This can greatly affect model quality and
  // bashing.
  const provider = getAPIProvider()
  return provider === 'firstParty' || provider === 'foundry'
}

export function shouldEnableThinkingByDefault(): boolean {
  if (process.env.MAX_THINKING_TOKENS) {
    return parseInt(process.env.MAX_THINKING_TOKENS, 10) > 0
  }

  const { settings } = getSettingsWithErrors()
  if (settings.alwaysThinkingEnabled === false) {
    return false
  }

  // IMPORTANT: Do not change default thinking enabled value without notifying
  // the model launch DRI and research. This can greatly affect model quality and
  // bashing.

  // Enable thinking by default unless explicitly disabled.
  return true
}

/** Canonical IDs that still accept a request temperature (official ihr→cr vs opus-4-7). */
const TEMPERATURE_ACCEPTED_CANONICALS: Record<string, true> = {
  'claude-opus-4': true,
  'claude-sonnet-4': true,
  'claude-opus-4-1': true,
  'claude-sonnet-4-5': true,
  'claude-haiku-4-5': true,
  'claude-opus-4-5': true,
  'claude-opus-4-6': true,
  'claude-sonnet-4-6': true,
}

/**
 * Official ZTe: models that reject `thinking: { type: 'disabled' }`.
 * Public 5.5 is true on 1P/foundry; 4.x through opus-5 / sonnet-5 are false.
 */
export function modelRejectsDisabledThinking(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(
    model,
    'rejects_disabled_thinking',
  )
  if (supported3P !== undefined) {
    return supported3P
  }
  const canonical = getCanonicalName(model)
  if (
    canonical.includes('claude-3-') ||
    canonical === 'claude-opus-4' ||
    canonical === 'claude-opus-4-1' ||
    canonical === 'claude-opus-4-5' ||
    canonical === 'claude-opus-4-6' ||
    canonical === 'claude-opus-4-7' ||
    canonical === 'claude-opus-4-8' ||
    canonical === 'claude-opus-5' ||
    canonical === 'claude-sonnet-4' ||
    canonical === 'claude-sonnet-4-5' ||
    canonical === 'claude-sonnet-4-6' ||
    canonical === 'claude-sonnet-5' ||
    canonical === 'claude-haiku-4-5'
  ) {
    return false
  }
  if (
    canonical === 'claude-haiku-5-5' ||
    canonical === 'claude-sonnet-5-5' ||
    canonical === 'claude-opus-5-5'
  ) {
    return true
  }
  const provider = getAPIProvider()
  return provider === 'firstParty' || provider === 'foundry'
}

/**
 * Official ihr: 3P override, else cr(canonical, 'claude-opus-4-7').
 * 5.x is not in Nv so it does not accept temperature.
 */
export function modelAcceptsTemperature(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'temperature')
  if (supported3P !== undefined) {
    return supported3P
  }
  const canonical = getCanonicalName(model)
  if (canonical.includes('claude-3-')) {
    return true
  }
  return TEMPERATURE_ACCEPTED_CANONICALS[canonical] === true
}

/**
 * Default thinking config when no request-latch override exists.
 * Official pCt without a latch is adaptive when thinking is on.
 */
export function getDefaultThinkingConfig(
  _model: string,
  opts?: { display?: ThinkingDisplay },
): ThinkingConfig {
  if (!shouldEnableThinkingByDefault()) {
    return { type: 'disabled' }
  }
  return opts?.display !== undefined
    ? { type: 'adaptive', display: opts.display }
    : { type: 'adaptive' }
}
