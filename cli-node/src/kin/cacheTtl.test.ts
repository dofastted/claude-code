import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import {
  applyKinOwnedCacheMarkers,
  fillMissingCacheTtl,
  readPanelCacheTtl,
  resolveKinCacheTtl,
} from './cacheTtl.ts'


test('an existing 1h on tools fills the ttl-less system marker', () => {
  const system = [
    { type: 'text', text: 'prefix', cache_control: { type: 'ephemeral' } },
  ]
  const tools = [
    { name: 'Read', cache_control: { type: 'ephemeral', ttl: '1h' } },
  ]
  const ttl = resolveKinCacheTtl({ tools, messages: [], panelTtl: '5m' })
  fillMissingCacheTtl({ system, tools }, ttl)
  expect(ttl).toBe('1h')
  expect(system[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  expect(tools[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
})

test('an existing 5m wins over a panel 1h', () => {
  const system = [{ type: 'text', text: 'prefix', cache_control: { type: 'ephemeral' } }]
  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '5m' } }],
    },
  ]
  const ttl = resolveKinCacheTtl({ messages, panelTtl: '1h' })
  fillMissingCacheTtl({ system, messages }, ttl)
  expect(system[0]!.cache_control.ttl).toBe('5m')
  expect(messages[0]!.content[0]!.cache_control.ttl).toBe('5m')
})

test('no existing marker uses the panel value', () => {
  const system = [{ type: 'text', text: 'prefix', cache_control: { type: 'ephemeral' } }]
  const ttl = resolveKinCacheTtl({ tools: [], messages: [], panelTtl: '5m' })
  fillMissingCacheTtl({ system }, ttl)
  expect(system[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' })
})

test('no panel file falls back to 1h', () => {
  const system = [{ type: 'text', text: 'prefix', cache_control: { type: 'ephemeral' } }]
  const ttl = resolveKinCacheTtl({ panelTtl: readPanelCacheTtl('/no/such/kernel.json') })
  fillMissingCacheTtl({ system }, ttl)
  expect(ttl).toBe('1h')
  expect(system[0]!.cache_control.ttl).toBe('1h')
})

test('readPanelCacheTtl reads default_cache_ttl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kin-ttl-'))
  const path = join(dir, 'kernel.json')
  writeFileSync(path, JSON.stringify({ default_cache_ttl: '5m' }))
  expect(readPanelCacheTtl(path)).toBe('5m')
})

test('native path copies request TTL onto system/tools and keeps message markers', () => {
  const system = [{ type: 'text', text: 'prefix', cache_control: { type: 'ephemeral', ttl: '1h' } }]
  const tools = [{ name: 'Read' }, { name: 'web_search', type: 'web_search_20250305' }]
  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'u1', cache_control: { type: 'ephemeral', ttl: '5m' } }],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
    {
      role: 'user',
      content: [{ type: 'text', text: 'u2', cache_control: { type: 'ephemeral', ttl: '5m' } }],
    },
  ]
  const ttl = resolveKinCacheTtl({ system, tools, messages, panelTtl: '1h' })
  applyKinOwnedCacheMarkers({ system, tools, messages }, ttl)
  expect(ttl).toBe('5m')
  expect(system[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' })
  expect(tools[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' })
  expect(tools[1]!.cache_control).toBeUndefined()
  expect(messages[0]!.content[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' })
  expect(messages[2]!.content[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' })
})

test('native path drops thinking markers and caps at four breakpoints', () => {
  const system = [
    { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
  ]
  const tools = [
    { name: 'Read', cache_control: { type: 'ephemeral' } },
    { name: 'Edit', cache_control: { type: 'ephemeral' } },
  ]
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: 'a1', cache_control: { type: 'ephemeral', ttl: '5m' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'text', text: 'u2', cache_control: { type: 'ephemeral', ttl: '5m' } }],
    },
  ]
  applyKinOwnedCacheMarkers({ system, tools, messages }, '5m')
  expect(messages[0]!.content[0]!.cache_control).toBeUndefined()
  const live = [
    ...system.filter(block => block.cache_control),
    ...tools.filter(tool => tool.cache_control),
    ...messages.flatMap(message => message.content.filter(block => block.cache_control)),
  ]
  expect(live.length).toBe(4)
  expect(live.every(block => block.cache_control?.ttl === '5m')).toBe(true)
})

