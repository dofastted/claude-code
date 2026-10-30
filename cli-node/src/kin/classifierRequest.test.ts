import { test, expect } from 'bun:test'
import { classifierSystemBlocks, validClassifierContext } from './classifierRequest.js'

test('classifier system retains blocks, whitespace and cache independent of layout', () => {
  const system = [{ type: 'text', text: 'x-anthropic-billing-header: old;' }, { type: 'text', text: '  <block> rules\n', cache_control: { type: 'ephemeral', ttl: '1h' } }] as const
  const out = classifierSystemBlocks(system, 'x-anthropic-billing-header: new;')
  expect(out).toEqual([{ type: 'text', text: 'x-anthropic-billing-header: new;' }, system[1]])
  expect(system[0].text).toContain('old')
  expect(classifierSystemBlocks(system, '')).toEqual(system)
})
test('context rejects unknown enums, fields and body mismatch', () => {
  const context = { purpose: 'auto_mode_classifier', format: 'xml', stage: 'xml_s1' }
  const request = { system: '<block>', messages: [{ role: 'user', content: '<transcript>' }] }
  expect(validClassifierContext(context, request)).toBe(true)
  expect(validClassifierContext(context, { ...request, system: 'Output <severity>N</severity>' })).toBe(true)
  expect(validClassifierContext(context, { ...request, messages: [{ role: 'user', content: 'no envelope' }] })).toBe(false)
  expect(validClassifierContext({ ...context, stage: 'unknown' }, request)).toBe(false)
  expect(validClassifierContext({ ...context, extra: true }, request)).toBe(false)
  expect(validClassifierContext({ ...context, format: 'tool' }, request)).toBe(false)
  expect(validClassifierContext(context, {})).toBe(false)
})
