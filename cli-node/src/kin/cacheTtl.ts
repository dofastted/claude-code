/**
 * Native CLI keeps Node message markers. System/tools are CLI-owned and must
 * use the same request TTL. Panel kernel.json is only a fallback when the
 * request body has no explicit TTL (standalone CLI).
 */
import { readFileSync } from 'node:fs'

export type CacheTtl = '5m' | '1h'

const KERNEL_CONFIG = process.env.KIN_KERNEL_CONFIG || '/run/kin/kernel.json'
const MAX_CACHE_MARKERS = 4

export function normalizePanelCacheTtl(value: unknown): CacheTtl | null {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (raw === '5m' || raw === '1h') return raw
  return null
}

function cacheControlTtl(node: object): unknown {
  if (!('cache_control' in node)) return undefined
  const control = node.cache_control
  if (!control || typeof control !== 'object' || !('ttl' in control)) return undefined
  return control.ttl
}

function noteExplicitTtl(node: unknown, seen: { five: boolean; hour: boolean }) {
  if (Array.isArray(node)) {
    for (const item of node) noteExplicitTtl(item, seen)
    return
  }
  if (!node || typeof node !== 'object') return
  const ttl = normalizePanelCacheTtl(cacheControlTtl(node))
  if (ttl === '5m') seen.five = true
  else if (ttl === '1h') seen.hour = true
  if ('content' in node && Array.isArray(node.content)) noteExplicitTtl(node.content, seen)
}

/** 5m wins: a 1h placed after an existing 5m is the 400. */
export function explicitCacheTtl(parts: unknown[]): CacheTtl | null {
  const seen = { five: false, hour: false }
  for (const part of parts) noteExplicitTtl(part, seen)
  if (seen.five) return '5m'
  if (seen.hour) return '1h'
  return null
}

export function readPanelCacheTtl(path = KERNEL_CONFIG): CacheTtl | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !('default_cache_ttl' in parsed)) return null
    return normalizePanelCacheTtl(parsed.default_cache_ttl)
  } catch {
    return null
  }
}

export function resolveKinCacheTtl(opts: {
  system?: unknown
  tools?: unknown
  messages?: unknown
  panelTtl?: unknown
}): CacheTtl {
  return (
    explicitCacheTtl([opts.system, opts.tools, opts.messages]) ??
    normalizePanelCacheTtl(opts.panelTtl) ??
    '1h'
  )
}

function stampBlock(block: unknown, ttl: CacheTtl) {
  if (!block || typeof block !== 'object' || !('cache_control' in block)) return
  const control = block.cache_control
  if (!control || typeof control !== 'object') return
  if ('type' in control && control.type != null && control.type !== 'ephemeral') return
  if ('ttl' in control && normalizePanelCacheTtl(control.ttl)) return
  rewriteBlock(block, ttl)
}

function rewriteBlock(block: unknown, ttl: CacheTtl) {
  if (!block || typeof block !== 'object' || !('cache_control' in block)) return
  const control = block.cache_control
  if (!control || typeof control !== 'object') return
  if ('type' in control && control.type != null && control.type !== 'ephemeral') return
  const next: { type: 'ephemeral'; ttl: CacheTtl; scope?: unknown } = {
    type: 'ephemeral',
    ttl,
  }
  if ('scope' in control && (control.scope === 'global' || control.scope === 'org')) {
    next.scope = control.scope
  }
  ;(block as { cache_control: { type: 'ephemeral'; ttl: CacheTtl; scope?: unknown } }).cache_control =
    next
}

function isDeferredLoadingTool(tool: unknown): boolean {
  if (!tool || typeof tool !== 'object') return false
  const record = tool as { defer_loading?: unknown; custom?: { defer_loading?: unknown } }
  return record.defer_loading === true || record.custom?.defer_loading === true
}

function isServerTool(tool: unknown): boolean {
  if (!tool || typeof tool !== 'object' || !('type' in tool)) return false
  const type = String((tool as { type?: unknown }).type || '')
  return type !== '' && type !== 'function' && type !== 'custom'
}

function stampLastEligibleTool(tools: unknown[], ttl: CacheTtl) {
  let idx = -1
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i]
    if (!tool || typeof tool !== 'object') continue
    if (isDeferredLoadingTool(tool) || isServerTool(tool)) continue
    idx = i
  }
  if (idx < 0) return
  const tool = tools[idx] as { cache_control?: unknown }
  if (!tool.cache_control) tool.cache_control = { type: 'ephemeral', ttl }
  else rewriteBlock(tool, ttl)
}

type MarkerLocation = { section: 'tools' | 'system' | 'messages'; block: { cache_control?: unknown; type?: unknown } }

function collectMarkers(params: { system?: unknown; tools?: unknown; messages?: unknown }): MarkerLocation[] {
  const hits: MarkerLocation[] = []
  const system = Array.isArray(params.system) ? params.system : params.system != null ? [params.system] : []
  for (const block of system) {
    if (!block || typeof block !== 'object' || !('cache_control' in block) || !block.cache_control) continue
    hits.push({ section: 'system', block: block as MarkerLocation['block'] })
  }
  if (Array.isArray(params.tools)) {
    for (const tool of params.tools) {
      if (!tool || typeof tool !== 'object' || !('cache_control' in tool) || !tool.cache_control) continue
      hits.push({ section: 'tools', block: tool as MarkerLocation['block'] })
    }
  }
  if (Array.isArray(params.messages)) {
    for (const message of params.messages) {
      if (!message || typeof message !== 'object' || !('content' in message)) continue
      if (!Array.isArray(message.content)) continue
      for (const block of message.content) {
        if (!block || typeof block !== 'object' || !('cache_control' in block) || !block.cache_control) continue
        hits.push({ section: 'messages', block: block as MarkerLocation['block'] })
      }
    }
  }
  return hits
}

function dropThinkingMarkers(params: { messages?: unknown }) {
  if (!Array.isArray(params.messages)) return
  for (const message of params.messages) {
    if (!message || typeof message !== 'object' || !('content' in message)) continue
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue
      const type = 'type' in block ? block.type : null
      if (type !== 'thinking' && type !== 'redacted_thinking') continue
      if ('cache_control' in block) delete (block as { cache_control?: unknown }).cache_control
    }
  }
}

function capCacheMarkers(params: { system?: unknown; tools?: unknown; messages?: unknown }, maximum = MAX_CACHE_MARKERS) {
  dropThinkingMarkers(params)
  const live = collectMarkers(params).filter(location => location.block.cache_control)
  if (live.length <= maximum) return
  const bySection = (name: MarkerLocation['section']) => live.filter(location => location.section === name)
  const order = [...bySection('tools').reverse(), ...bySection('system').reverse(), ...bySection('messages')]
  for (const location of order.slice(0, live.length - maximum)) {
    delete location.block.cache_control
  }
}

/** Fill cache_control that cli-node just added without a ttl. Leave explicit values. */
export function fillMissingCacheTtl(
  params: { system?: unknown; tools?: unknown; messages?: unknown },
  ttl: CacheTtl,
) {
  const system = Array.isArray(params.system) ? params.system : [params.system]
  for (const block of system) stampBlock(block, ttl)
  if (Array.isArray(params.tools)) {
    for (const tool of params.tools) stampBlock(tool, ttl)
  }
  if (!Array.isArray(params.messages)) return
  for (const message of params.messages) {
    if (!message || typeof message !== 'object' || !('content' in message)) continue
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) stampBlock(block, ttl)
  }
}

/**
 * Native path: keep Node message markers, rewrite CLI system/tools to the
 * same request TTL, stamp the last eligible tool, and cap at 4.
 */
export function applyKinOwnedCacheMarkers(
  params: { system?: unknown; tools?: unknown; messages?: unknown },
  ttl: CacheTtl,
) {
  const system = Array.isArray(params.system) ? params.system : params.system != null ? [params.system] : []
  for (const block of system) rewriteBlock(block, ttl)
  if (Array.isArray(params.tools)) {
    for (const tool of params.tools) rewriteBlock(tool, ttl)
    stampLastEligibleTool(params.tools, ttl)
  }
  fillMissingCacheTtl({ messages: params.messages }, ttl)
  capCacheMarkers(params, MAX_CACHE_MARKERS)
}
