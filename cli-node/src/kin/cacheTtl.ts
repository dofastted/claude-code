/**
 * Preserved wire sections are caller-owned. Normalize only owned markers;
 * explicit TTLs stay intact. Panel kernel.json supplies the fallback TTL
 * when the request body has no explicit TTL (standalone CLI).
 */
import { readFileSync } from 'node:fs'

export type CacheTtl = '5m' | '1h'

export function kernelConfigPath() {
  return process.env.KERNEL_CONFIG || "/run/kin/kernel.json";
}
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
  if (!control || typeof control !== "object" || !("ttl" in control))
    return undefined;
  return control.ttl
  }

function noteExplicitTtl(
  node: unknown,
  seen: { five: boolean; hour: boolean },
) {
  if (Array.isArray(node)) {
    for (const item of node) noteExplicitTtl(item, seen)
    return
}
  if (!node || typeof node !== 'object') return
  const ttl = normalizePanelCacheTtl(cacheControlTtl(node))
  if (ttl === '5m') seen.five = true
  else if (ttl === '1h') seen.hour = true
  if ("content" in node && Array.isArray(node.content))
    noteExplicitTtl(node.content, seen);
}

/** 5m wins: a 1h placed after an existing 5m is the 400. */
export function explicitCacheTtl(parts: unknown[]): CacheTtl | null {
  const seen = { five: false, hour: false }
  for (const part of parts) noteExplicitTtl(part, seen)
  if (seen.five) return '5m'
  if (seen.hour) return '1h'
  return null
  }

export function readPanelCacheTtl(path = kernelConfigPath()): CacheTtl | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("default_cache_ttl" in parsed)
  )
    return null
    return normalizePanelCacheTtl(parsed.default_cache_ttl)
  } catch {
    return null;
}
}

let lastPanelCchEnabled = true;

/** Standalone CLI has no panel file; keep the last valid policy during atomic updates. */
export function readPanelCchEnabled(path = kernelConfigPath()): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (!("cch_enabled" in parsed)) lastPanelCchEnabled = true;
      else if (typeof parsed.cch_enabled === "boolean")
        lastPanelCchEnabled = parsed.cch_enabled;
}
  } catch {
    // Optional in standalone mode; a transient missing file must not flip an existing policy.
  }
  return lastPanelCchEnabled;
  }
let lastPanelCachedMicrocompactEnabled = false;

/** Default off. A missing or invalid panel value must not start deleting cached history. */
export function readPanelCachedMicrocompactEnabled(
  path = kernelConfigPath(),
): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (!("cached_microcompact_enabled" in parsed))
        lastPanelCachedMicrocompactEnabled = false;
      else if (typeof parsed.cached_microcompact_enabled === "boolean") {
        lastPanelCachedMicrocompactEnabled = parsed.cached_microcompact_enabled;
}
}
  } catch {
    // A transient missing file keeps the last valid policy.
}
  return lastPanelCachedMicrocompactEnabled;
  }
let lastPanelAutoCompactWindow: number | null = null

/** Null means inherit the model window. Invalid input keeps the last valid panel value. */
export function readPanelAutoCompactWindow(path = kernelConfigPath()): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return lastPanelAutoCompactWindow
    if (!('auto_compact_window' in parsed) || parsed.auto_compact_window == null) {
      lastPanelAutoCompactWindow = null
      return null
    }
    const value = Number(parsed.auto_compact_window)
    if (Number.isInteger(value) && value >= 100_000 && value <= 1_000_000) {
      lastPanelAutoCompactWindow = value
    }
  } catch {
    // A transient missing file keeps the last valid panel window.
  }
  return lastPanelAutoCompactWindow
}
export type CcEntrypoint = 'sdk-cli' | 'cli'

/** Panel `cc_entrypoint`. Missing or invalid stays sdk-cli, matching the shipped default. */
export function readPanelCcEntrypoint(path = kernelConfigPath()): CcEntrypoint {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('cc_entrypoint' in parsed)) {
      return 'sdk-cli'
    }
    return parsed.cc_entrypoint === 'cli' ? 'cli' : 'sdk-cli'
  } catch {
    return 'sdk-cli'
  }
}

const PANEL_EFFORTS = new Set(['off', 'low', 'medium', 'high', 'xhigh', 'max'])

/** Panel model effort. `off` means send no effort; an unknown value is ignored. */
export function readPanelModelEffort(model: string, path = kernelConfigPath()): string | undefined {
  const id = String(model || '').trim().toLowerCase()
  if (!id) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('model_effort' in parsed)) {
      return undefined
    }
    const table = parsed.model_effort
    if (!table || typeof table !== 'object' || Array.isArray(table)) return undefined
    const value = table[id]
    return typeof value === 'string' && PANEL_EFFORTS.has(value) ? value : undefined
  } catch {
    return undefined
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
  );
}

function stampBlock(block: unknown, ttl: CacheTtl) {
  if (!block || typeof block !== "object" || !("cache_control" in block))
    return;
  const control = block.cache_control
  if (!control || typeof control !== 'object') return
  if ("type" in control && control.type != null && control.type !== "ephemeral")
    return;
  if ('ttl' in control && normalizePanelCacheTtl(control.ttl)) return
  rewriteBlock(block, ttl)
  }

function rewriteBlock(block: unknown, ttl: CacheTtl) {
  if (!block || typeof block !== "object" || !("cache_control" in block))
    return;
  const control = block.cache_control
  if (!control || typeof control !== 'object') return
  if ("type" in control && control.type != null && control.type !== "ephemeral")
    return;
  const next: { type: 'ephemeral'; ttl: CacheTtl; scope?: unknown } = {
    type: 'ephemeral',
    ttl,
    }
  if (
    "scope" in control &&
    (control.scope === "global" || control.scope === "org")
) {
    next.scope = control.scope
  }
  (
    block as {
      cache_control: { type: "ephemeral"; ttl: CacheTtl; scope?: unknown };
      }
  ).cache_control = next;
    }

type MarkerLocation = {
  section: "tools" | "system" | "messages";
  block: { cache_control?: unknown; type?: unknown };
  }

function collectMarkers(params: {
  system?: unknown;
  tools?: unknown;
  messages?: unknown;
}): MarkerLocation[] {
  const hits: MarkerLocation[] = []
  const system = Array.isArray(params.system)
    ? params.system
    : params.system != null
      ? [params.system]
      : [];
  for (const block of system) {
    if (
      !block ||
      typeof block !== "object" ||
      !("cache_control" in block) ||
      !block.cache_control
    )
      continue;
    hits.push({ section: 'system', block: block as MarkerLocation['block'] })
}
  if (Array.isArray(params.tools)) {
    for (const tool of params.tools) {
      if (
        !tool ||
        typeof tool !== "object" ||
        !("cache_control" in tool) ||
        !tool.cache_control
      )
        continue;
      hits.push({ section: 'tools', block: tool as MarkerLocation['block'] })
    }
  }
  if (Array.isArray(params.messages)) {
    for (const message of params.messages) {
      if (!message || typeof message !== "object" || !("content" in message))
        continue;
      if (!Array.isArray(message.content)) continue
      for (const block of message.content) {
        if (
          !block ||
          typeof block !== "object" ||
          !("cache_control" in block) ||
          !block.cache_control
        )
          continue;
        hits.push({
          section: "messages",
          block: block as MarkerLocation["block"],
        });
}
  }
}
  return hits
  }

function dropThinkingMarkers(params: { messages?: unknown }) {
  if (!Array.isArray(params.messages)) return
  for (const message of params.messages) {
    if (!message || typeof message !== "object" || !("content" in message))
      continue;
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue
      const type = 'type' in block ? block.type : null
      if (type !== 'thinking' && type !== 'redacted_thinking') continue
      if ("cache_control" in block)
        delete (block as { cache_control?: unknown }).cache_control;
  }
}
  }
type MessageBlock = { type?: unknown; text?: unknown; cache_control?: unknown };

/** Official CLI keeps one message marker. Extras are removed. Never invent a ttl the caller omitted. */
export function keepSingleMessageCacheMarker(
  messages: unknown,
  { ensureTail = false } = {},
) {
  if (!Array.isArray(messages)) return;
  const marked: MessageBlock[] = [];
  let tail: MessageBlock[] | null = null;
  for (const message of messages) {
    if (!message || typeof message !== "object" || !("content" in message))
      continue;
    const content = message.content;
    if (typeof content === "string") {
      if (!content) continue;
      const block: MessageBlock = { type: "text", text: content };
      message.content = [block];
      tail = [block];
      continue;
    }
    if (!Array.isArray(content) || content.length === 0) continue;
    const blocks: MessageBlock[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const typed = block as MessageBlock;
      if (typed.type === "thinking" || typed.type === "redacted_thinking") {
        delete typed.cache_control;
        continue;
      }
      blocks.push(typed);
      if (typed.cache_control) marked.push(typed);
    }
    if (blocks.length > 0) tail = blocks;
  }
  const anchor = tail?.[tail.length - 1];
  for (const block of marked) {
    if (block !== anchor) delete block.cache_control;
  }
  if (!ensureTail || !anchor || anchor.cache_control) return;
  anchor.cache_control = { type: "ephemeral" };
}

function capCacheMarkers(
  params: { system?: unknown; tools?: unknown; messages?: unknown },
  maximum = MAX_CACHE_MARKERS,
) {
  dropThinkingMarkers(params)
  const live = collectMarkers(params).filter(
    (location) => location.block.cache_control,
  );
  if (live.length <= maximum) return
  const tools = live.filter((location) => location.section === "tools");
  const system = live.filter((location) => location.section === "system");
  const messages = live.filter((location) => location.section === "messages");
  const order = [...tools.reverse(), ...system.reverse(), ...messages];
  for (const location of order.slice(0, live.length - maximum)) {
    delete location.block.cache_control
  }
}

/** Fill a ttl only when some sibling marker already named one. An omitted ttl is the official 5m default; writing 1h changes the wire. */
export function fillMissingCacheTtl(
  params: { system?: unknown; tools?: unknown; messages?: unknown },
  ttl: CacheTtl,
) {
  if (!explicitCacheTtl([params.system, params.tools, params.messages])) return
  const system = Array.isArray(params.system) ? params.system : [params.system]
  for (const block of system) stampBlock(block, ttl)
  if (Array.isArray(params.tools)) {
    for (const tool of params.tools) stampBlock(tool, ttl)
  }
  if (!Array.isArray(params.messages)) return
  for (const message of params.messages) {
    if (!message || typeof message !== "object" || !("content" in message))
      continue;
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) stampBlock(block, ttl)
  }
}
/** Only Kin-owned sections may be normalized or trimmed to the marker cap. */
export function applyKinOwnedCacheMarkers(
  params: { system?: unknown; tools?: unknown; messages?: unknown },
  ttl: CacheTtl,
  {
    preserveSystem = false,
    preserveMessages = false,
    preserveTools = false,
  } = {},
) {
  const owned = {
    system: preserveSystem ? undefined : params.system,
    tools: preserveTools ? undefined : params.tools,
    messages: preserveMessages ? undefined : params.messages,
  };
  const preservedCount = collectMarkers({
    system: preserveSystem ? params.system : undefined,
    tools: preserveTools ? params.tools : undefined,
    messages: preserveMessages ? params.messages : undefined,
  }).length;
  // Invalid caller-only marker counts must reach upstream unchanged, not be repaired here.
  fillMissingCacheTtl(owned, ttl);
  capCacheMarkers(owned, Math.max(0, MAX_CACHE_MARKERS - preservedCount));
}
