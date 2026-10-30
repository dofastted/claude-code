import { expect, test } from 'bun:test'
import { resolveStage2NullVerdict } from './yoloClassifier.js'

test('stage 1 block survives a stage 2 refusal as a real block', () => {
  const verdict = resolveStage2NullVerdict({
    stage1Blocked: true,
    stage1Refused: false,
    stage1Reason: 'Blocked by fast classifier',
    stage2StopReason: 'refusal',
  })
  expect(verdict).toEqual({
    stage1Stands: true,
    reason: 'Blocked by fast classifier',
  })
  expect(verdict.failureMode).toBeUndefined()
  expect(verdict.refusedBySafeguard).toBeUndefined()
})

test('stage 1 refusal stands when stage 2 is not itself a refusal', () => {
  expect(
    resolveStage2NullVerdict({
      stage1Blocked: false,
      stage1Refused: true,
      stage1Reason: undefined,
      stage2StopReason: 'end_turn',
    }),
  ).toEqual({
    stage1Stands: false,
    reason: 'Classifier stage 1 unparseable - blocking for safety',
    failureMode: 'policy_refusal',
    refusedBySafeguard: true,
  })
})

test('an unparseable stage 2 without a prior block stays a missing verdict', () => {
  expect(
    resolveStage2NullVerdict({
      stage1Blocked: false,
      stage1Refused: false,
      stage1Reason: undefined,
      stage2StopReason: 'end_turn',
    }).failureMode,
  ).toBe('unparseable')
})
