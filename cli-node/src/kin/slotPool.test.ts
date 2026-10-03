import { expect, test } from 'bun:test'
import {
  agentPromptFromJson,
  clampMaxProcs,
  contentHasToolResult,
  pickSlot,
  type PoolSlot,
} from './slotPool.ts'

function slots(partial: Partial<PoolSlot>[]): PoolSlot[] {
  return partial.map((slot, index) => ({
    id: `s${String(index).padStart(2, '0')}`,
    phase: 'idle',
    model: '',
    ...slot,
  }))
}

test('clampMaxProcs stays inside 1..20', () => {
  expect(clampMaxProcs(undefined)).toBe(20)
  expect(clampMaxProcs('0')).toBe(20)
  expect(clampMaxProcs('8')).toBe(8)
  expect(clampMaxProcs('40')).toBe(20)
})

test('pickSlot resumes only the waiting session', () => {
  const pool = slots([
    { phase: 'waiting', sessionId: 'sess-a', model: 'opus' },
    { phase: 'idle', model: 'opus' },
  ])
  expect(pickSlot(pool, 'sess-a', 'opus', true)).toBe(0)
  expect(pickSlot(pool, 'sess-b', 'opus', true)).toBe(-1)
})

test('pickSlot pins by model but can mix', () => {
  const pool = slots([
    { phase: 'idle', model: 'opus' },
    { phase: 'running', model: 'sonnet', sessionId: 'busy' },
    { phase: 'idle', model: '' },
  ])
  expect(pickSlot(pool, 'new', 'opus', false)).toBe(0)
  expect(pickSlot(pool, 'new', 'haiku', false)).toBe(2)
  pool[2]!.phase = 'running'
  pool[2]!.model = 'haiku'
  expect(pickSlot(pool, 'other', 'sonnet', false)).toBe(0)
})

test('agent prompt and tool_result detection', () => {
  const raw = JSON.stringify({
    'crag-worker': { prompt: 'You are a persistent Crag request slot.' },
  })
  expect(agentPromptFromJson(raw, 'crag-worker')).toContain('persistent Crag')
  expect(contentHasToolResult([{ type: 'tool_result', tool_use_id: 't1' }])).toBe(
    true,
  )
  expect(contentHasToolResult([{ type: 'text', text: 'hi' }])).toBe(false)
})
