import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import {
  applyKinOwnedCacheMarkers,
  fillMissingCacheTtl,
  keepSingleMessageCacheMarker,
  kernelConfigPath,
  readPanelCachedMicrocompactEnabled,
  readPanelCacheTtl,
  readPanelCchEnabled,
  resolveKinCacheTtl,
} from './cacheTtl.ts'

test('an existing 1h on tools fills the ttl-less system marker', () => {
  const system = [{ type: 'text', text: 'prefix', cache_control: { type: 'ephemeral' } }]
  const tools = [{ name: 'Read', cache_control: { type: 'ephemeral', ttl: '1h' } }]
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
      content: [
        {
          type: 'text',
          text: 'hi',
          cache_control: { type: 'ephemeral', ttl: '5m' },
        },
      ],
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
  const ttl = resolveKinCacheTtl({
    panelTtl: readPanelCacheTtl('/no/such/kernel.json'),
  })
  fillMissingCacheTtl({ system }, ttl)
  expect(ttl).toBe('1h')
  expect(system[0]!.cache_control.ttl).toBe('1h')
})

test('readPanelCacheTtl reads default_cache_ttl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ttl-'))
  const path = join(dir, 'kernel.json')
  writeFileSync(path, JSON.stringify({ default_cache_ttl: '5m' }))
  expect(readPanelCacheTtl(path)).toBe('5m')
})

test('kernel config defaults to the live slot path and honors KERNEL_CONFIG', () => {
  const previous = process.env.KERNEL_CONFIG
  try {
    delete process.env.KERNEL_CONFIG
    expect(kernelConfigPath()).toBe('/run/kin/kernel.json')
    process.env.KERNEL_CONFIG = '/tmp/override-kernel.json'
    expect(kernelConfigPath()).toBe('/tmp/override-kernel.json')
  } finally {
    if (previous == null) delete process.env.KERNEL_CONFIG
    else process.env.KERNEL_CONFIG = previous
  }
})

test('CCH policy hot reloads without enabling it during an unreadable update', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cch-policy-'))
  const path = join(dir, 'kernel.json')
  try {
    writeFileSync(path, JSON.stringify({ cch_enabled: true }))
    expect(readPanelCchEnabled(path)).toBe(true)
    writeFileSync(path, JSON.stringify({ cch_enabled: false }))
    expect(readPanelCchEnabled(path)).toBe(false)
    writeFileSync(path, '{')
    expect(readPanelCchEnabled(path)).toBe(false)
    writeFileSync(path, JSON.stringify({ cch_enabled: 'true' }))
    expect(readPanelCchEnabled(path)).toBe(false)
    writeFileSync(path, '{}')
    expect(readPanelCchEnabled(path)).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native path keeps message markers and does not manufacture tool markers', () => {
  const system = [
    {
      type: 'text',
      text: 'prefix',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ]
  const tools = [{ name: 'Read' }, { name: 'web_search', type: 'web_search_20250305' }]
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'u1',
          cache_control: { type: 'ephemeral', ttl: '5m' },
        },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'u2',
          cache_control: { type: 'ephemeral', ttl: '5m' },
        },
      ],
    },
  ]
  const ttl = resolveKinCacheTtl({ system, tools, messages, panelTtl: '1h' })
  applyKinOwnedCacheMarkers({ system, tools, messages }, ttl)
  expect(ttl).toBe('5m')
  expect(system[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  expect(tools[0]!.cache_control).toBeUndefined()
  expect(tools[1]!.cache_control).toBeUndefined()
  expect(messages[0]!.content[0]!.cache_control).toEqual({
    type: 'ephemeral',
    ttl: '5m',
  })
  expect(messages[2]!.content[0]!.cache_control).toEqual({
    type: 'ephemeral',
    ttl: '5m',
  })
})

test('native path preserves an explicit tool marker without adding one', () => {
  const tools = [{ name: 'Read', cache_control: { type: 'ephemeral', ttl: '1h' } }]
  applyKinOwnedCacheMarkers({ tools }, '5m')
  expect(tools[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
})
test('preserved wire tools keep caller TTL and marker count', () => {
  const system = [
    { type: 'text', text: 'header', cache_control: { type: 'ephemeral' } },
  ]
  const tools = Array.from({ length: 5 }, (_, i) => ({
    name: `Tool${i}`,
    cache_control: { type: 'ephemeral' },
  }))
  const before = structuredClone(tools)
  applyKinOwnedCacheMarkers({ system, tools }, '1h', {
    preserveSystem: true,
    preserveTools: true,
  })
  expect(tools).toEqual(before)
  expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' })
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
        {
          type: 'thinking',
          thinking: 'x',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
        {
          type: 'text',
          text: 'a1',
          cache_control: { type: 'ephemeral', ttl: '5m' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'u2',
          cache_control: { type: 'ephemeral', ttl: '5m' },
        },
      ],
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

test('preserved wire system and messages stay intact beyond the marker cap', () => {
  const system = Array.from({ length: 3 }, (_, i) => ({
    type: 'text',
    text: `system ${i}`,
    cache_control: { type: 'ephemeral' },
  }))
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'private', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'one', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: 'two', cache_control: { type: 'ephemeral' } },
      ],
    },
  ]
  const before = structuredClone({ system, messages })
  const tools = [{ name: 'Read', cache_control: { type: 'ephemeral' } }]
  applyKinOwnedCacheMarkers({ system, messages, tools }, '5m', {
    preserveSystem: true,
    preserveMessages: true,
  })
  expect({ system, messages }).toEqual(before)
  expect(tools[0]!.cache_control).toBeUndefined()
})

test('wire message markers reserve budget while owned system TTLs are filled', () => {
  const system = [{ type: 'text', text: 'prefix', cache_control: { type: 'ephemeral' } }]
  const messages = [
    {
      role: 'user',
      content: Array.from({ length: 3 }, (_, i) => ({
        type: 'text',
        text: `message ${i}`,
        cache_control: { type: 'ephemeral' },
      })),
    },
  ]
  const before = structuredClone(messages)
  const tools = [{ name: 'Read', cache_control: { type: 'ephemeral' } }]
  applyKinOwnedCacheMarkers({ system, tools, messages }, '1h', { preserveMessages: true })
  expect(messages).toEqual(before)
  expect(system[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  expect(tools[0]!.cache_control).toBeUndefined()
})

test('enabled cached microcompact uses an implementation or fails when it is absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kin-mc-fail-'))
  const previous = process.env.KERNEL_CONFIG
  const config = join(dir, 'kernel.json')
  process.env.KERNEL_CONFIG = config
  writeFileSync(config, JSON.stringify({ cached_microcompact_enabled: true }))
  const compact = await import('../services/compact/microCompact.ts')
  const original = compact.cachedMicrocompactRuntime.implementation
  let calls = 0
  compact.cachedMicrocompactRuntime.implementation = async () => {
    calls += 1
    return {
      isCachedMicrocompactEnabled: () => false,
      isModelSupportedForCacheEditing: () => false,
    }
  }
  try {
    await expect(compact.microcompactMessages([])).rejects.toThrow('cached_microcompact_unavailable:')
    expect(calls).toBe(1)
    compact.cachedMicrocompactRuntime.implementation = async () => null
    await expect(compact.microcompactMessages([])).rejects.toThrow('cached_microcompact_unavailable:')
  } finally {
    compact.cachedMicrocompactRuntime.implementation = original
    if (previous == null) delete process.env.KERNEL_CONFIG
    else process.env.KERNEL_CONFIG = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cached microcompact defaults off and only an explicit boolean turns it on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kin-mc-'))
  const path = join(dir, 'kernel.json')
  try {
    writeFileSync(path, '{}')
    expect(readPanelCachedMicrocompactEnabled(path)).toBe(false)
    writeFileSync(path, JSON.stringify({ cached_microcompact_enabled: true }))
    expect(readPanelCachedMicrocompactEnabled(path)).toBe(true)
    writeFileSync(path, JSON.stringify({ cached_microcompact_enabled: 'true' }))
    expect(readPanelCachedMicrocompactEnabled(path)).toBe(true)
    writeFileSync(path, JSON.stringify({ cached_microcompact_enabled: false }))
    expect(readPanelCachedMicrocompactEnabled(path)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('message markers collapse to the current tail before TTL fill', () => {
  const messages = [
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'old', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'new', cache_control: { type: 'ephemeral' } }],
    },
  ]
  keepSingleMessageCacheMarker(messages)
  applyKinOwnedCacheMarkers({ messages }, '1h')
  expect(messages[0]!.content[0]!.cache_control).toBeUndefined()
  expect(messages[1]!.content[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
})

test('prompt caching places one marker on an unmarked current tail', () => {
  const messages = [
    { role: 'user', content: 'older' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'private', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: 'tail' },
      ],
    },
  ]
  keepSingleMessageCacheMarker(messages, { ensureTail: true, ttl: '5m' })
  expect(messages[0]!.content).toEqual([{ type: 'text', text: 'older' }])
  expect(messages[1]!.content[0]!.cache_control).toBeUndefined()
  expect(messages[1]!.content[1]!.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' })
})

test('disabled caching and skipCacheWrite do not create a tail marker', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'tail' }] }]
  keepSingleMessageCacheMarker(messages, { ensureTail: false, ttl: '1h' })
  expect(messages[0]!.content[0]!.cache_control).toBeUndefined()
})
