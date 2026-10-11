import { expect, test } from 'bun:test'
import {
  firstPartyNameToCanonical,
  getCanonicalName,
} from './model.js'
import {
  getAvailableEffortLevels,
  getDefaultEffortForModel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXHighEffort,
  parseCliEffort,
  parseEffortValue,
} from '../effort.js'
import {
  modelAcceptsTemperature,
  modelRejectsDisabledThinking,
  modelSupportsAdaptiveThinking,
} from '../thinking.js'
import { getModelMaxOutputTokens, modelHasNative1M } from '../context.js'

test('firstPartyNameToCanonical does not collapse public 5.5 IDs to family names', () => {
  expect(firstPartyNameToCanonical('claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
  expect(firstPartyNameToCanonical('claude-opus-5-5')).toBe('claude-opus-5-5')
  expect(firstPartyNameToCanonical('claude-haiku-5-5')).toBe('claude-haiku-5-5')
  expect(firstPartyNameToCanonical('us.anthropic.claude-sonnet-5-5')).toBe(
    'claude-sonnet-5-5',
  )
  expect(firstPartyNameToCanonical('claude-sonnet-5-5[1m]')).toBe(
    'claude-sonnet-5-5',
  )
  expect(firstPartyNameToCanonical('claude-sonnet-5')).toBe('claude-sonnet-5')
  expect(firstPartyNameToCanonical('claude-opus-5')).toBe('claude-opus-5')
  expect(firstPartyNameToCanonical('claude-sonnet-4-5-20250929')).toBe(
    'claude-sonnet-4-5',
  )
  expect(firstPartyNameToCanonical('claude-opus-4-6')).toBe('claude-opus-4-6')
})


test('no-override firstParty public 5.5 supports adaptive, max/xhigh, 1M, 128k, medium', () => {
  for (const model of [
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'claude-haiku-5-5',
  ]) {
    expect(getCanonicalName(model)).toBe(model)
    expect(modelSupportsEffort(model)).toBe(true)
    expect(modelSupportsMaxEffort(model)).toBe(true)
    expect(modelSupportsXHighEffort(model)).toBe(true)
    expect(modelSupportsAdaptiveThinking(model)).toBe(true)
    expect(modelHasNative1M(model)).toBe(true)
    expect(modelRejectsDisabledThinking(model)).toBe(true)
    expect(modelAcceptsTemperature(model)).toBe(false)
    expect(getDefaultEffortForModel(model)).toBe('medium')
    expect(getModelMaxOutputTokens(model)).toEqual({
      default: 128_000,
      upperLimit: 128_000,
    })
    expect(getAvailableEffortLevels(model)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  }
})

test('max/xhigh are not advertised on unsupported older models', () => {
  expect(modelSupportsXHighEffort('claude-opus-4-6')).toBe(false)
  expect(modelSupportsXHighEffort('claude-sonnet-4-6')).toBe(false)
  expect(modelSupportsXHighEffort('claude-sonnet-4-5')).toBe(false)
  expect(modelSupportsMaxEffort('claude-sonnet-4-5')).toBe(false)
  expect(modelSupportsMaxEffort('claude-opus-4-6')).toBe(true)
  expect(getAvailableEffortLevels('claude-opus-4-6')).toEqual([
    'low',
    'medium',
    'high',
    'max',
  ])
  expect(getAvailableEffortLevels('claude-sonnet-4-5')).toEqual([
    'low',
    'medium',
    'high',
  ])
  expect(modelSupportsAdaptiveThinking('claude-sonnet-4-5')).toBe(false)
  expect(modelHasNative1M('claude-sonnet-4-5')).toBe(false)
})

test('effort parsing accepts med/ultracode aliases and warns on unknown CLI values', () => {
  expect(parseEffortValue('med')).toBe('medium')
  expect(parseEffortValue('ultracode')).toBe('xhigh')
  expect(parseEffortValue('xhigh')).toBe('xhigh')
  expect(parseCliEffort('xhigh')).toEqual({ level: 'xhigh' })
  expect(parseCliEffort('nope').level).toBeUndefined()
  expect(parseCliEffort('nope').warning).toContain('Unknown --effort value')
})
