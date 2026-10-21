/**
 * Claude Code 2.1.296 CCH.
 * Seed and the four lane constants are the movabs immediates in the linux-x64
 * The SDK may pretty-print JSON; the sealer compacts it before applying the
 * official compact-JSON scanner, then sends that compact body. The hash input:
 *   1. resets the first cch= value to 00000
 *   2. clears every string-valued model
 *   3. removes fallbacks, fallback_credit_token, and max_tokens digits
 * The compact body is sent without the SDK's stale Content-Length header.
 */
export const CCH_SEED = 0x4d659218e32a3268n

const U = (1n << 64n) - 1n
const P1 = 0x9e3779b185ebca87n
const P2 = 0xc2b2ae3d27d4eb4fn
const P3 = 0x165667b19e3779f9n
const P4 = 0x85ebca77c2b2ae63n
const P5 = 0x27d4eb2f165667c5n

function rotl(x: bigint, r: bigint): bigint {
  return ((x << r) | (x >> (64n - r))) & U
}

function round(acc: bigint, input: bigint): bigint {
  acc = (acc + ((input * P2) & U)) & U
  return (rotl(acc, 31n) * P1) & U
}

function merge(acc: bigint, val: bigint): bigint {
  return ((acc ^ round(0n, val)) * P1 + P4) & U
}

function read64(data: Uint8Array, offset: number): bigint {
  let n = 0n
  for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(data[offset + i]!)
  return n
}

function read32(data: Uint8Array, offset: number): bigint {
  let n = 0n
  for (let i = 3; i >= 0; i--) n = (n << 8n) | BigInt(data[offset + i]!)
  return n
}

export function xxh64(data: Uint8Array, seed: bigint = CCH_SEED): bigint {
  const n = data.length
  let i = 0
  let h: bigint
  if (n >= 32) {
    let v1 = (seed + P1 + P2) & U
    let v2 = (seed + P2) & U
    let v3 = seed & U
    let v4 = (seed - P1) & U
    while (i <= n - 32) {
      v1 = round(v1, read64(data, i))
      i += 8
      v2 = round(v2, read64(data, i))
      i += 8
      v3 = round(v3, read64(data, i))
      i += 8
      v4 = round(v4, read64(data, i))
      i += 8
    }
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & U
    h = merge(h, v1)
    h = merge(h, v2)
    h = merge(h, v3)
    h = merge(h, v4)
  } else {
    h = (seed + P5) & U
  }
  h = (h + BigInt(n)) & U
  while (i + 8 <= n) {
    h = (rotl(h ^ round(0n, read64(data, i)), 27n) * P1 + P4) & U
    i += 8
  }
  if (i + 4 <= n) {
    h = (rotl(h ^ ((read32(data, i) * P1) & U), 23n) * P2 + P3) & U
    i += 4
  }
  while (i < n) {
    h = (rotl(h ^ ((BigInt(data[i]!) * P5) & U), 11n) * P1) & U
    i += 1
  }
  h = (h ^ (h >> 33n)) & U
  h = (h * P2) & U
  h = (h ^ (h >> 29n)) & U
  h = (h * P3) & U
  h = h ^ (h >> 32n)
  return h
}

function cut(s: string, start: number, end: number): string {
  if (end < s.length && s[end] === ',') end += 1
  else if (start > 0 && s[start - 1] === ',') start -= 1
  return s.slice(0, start) + s.slice(end)
}

function blankStringModels(s: string): string {
  const needle = '"model":"'
  const out: string[] = []
  let i = 0
  while (true) {
    const j = s.indexOf(needle, i)
    if (j < 0) {
      out.push(s.slice(i))
      break
    }
    let k = j + needle.length
    while (k < s.length) {
      if (s[k] === '\\' && k + 1 < s.length) {
        k += 2
        continue
      }
      if (s[k] === '"') break
      k += 1
    }
    out.push(s.slice(i, j + needle.length))
    i = k
  }
  return out.join('')
}

function skipFallbacks(s: string): string {
  const needle = '"fallbacks":['
  const j = s.indexOf(needle)
  if (j < 0) return s
  let i = j + needle.length - 1
  let depth = 0
  let inStr = false
  let esc = false
  while (i < s.length) {
    const c = s[i]!
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '[') depth += 1
    else if (c === ']') {
      depth -= 1
      if (depth === 0) return cut(s, j, i + 1)
    }
    i += 1
  }
  return s
}

function skipCredit(s: string): string {
  const needle = '"fallback_credit_token":"'
  const j = s.indexOf(needle)
  if (j < 0) return s
  let k = j + needle.length
  while (k < s.length) {
    if (s[k] === '\\' && k + 1 < s.length) {
      k += 2
      continue
    }
    if (s[k] === '"') return cut(s, j, k + 1)
    k += 1
  }
  return s
}

function skipMaxTokens(s: string): string {
  const needle = '"max_tokens":'
  const j = s.indexOf(needle)
  if (j < 0) return s
  let k = j + needle.length
  if (k >= s.length || !/[0-9]/.test(s[k]!)) return s
  while (k < s.length && /[0-9]/.test(s[k]!)) k += 1
  return cut(s, j, k)
}

function setSystemCch(body: unknown, value: string): boolean {
  if (!body || typeof body !== 'object' || !('system' in body)) return false
  let found = false
  const rewrite = (text: string) =>
    text.replace(
      /(^\s*x-anthropic-billing-header:[^\r\n]*?\bcch=)[0-9a-f]{5}(?=;)/im,
      (_match, prefix: string) => {
        found = true
        return `${prefix}${value}`
      },
    )
  if (typeof body.system === 'string') body.system = rewrite(body.system)
  else if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (block && typeof block === 'object' && typeof block.text === 'string') {
        block.text = rewrite(block.text)
      }
    }
  }
  return found
}

export function projectForCch(body: string): string {
  let material = body
  try {
    const parsed = JSON.parse(body) as unknown
    setSystemCch(parsed, '00000')
    const compact = JSON.stringify(parsed)
    if (typeof compact === 'string') material = compact
  } catch {
    // Keep non-JSON bodies unchanged; the SDK Messages request is JSON.
  }
  return skipMaxTokens(skipCredit(skipFallbacks(blankStringModels(material))))
}

export function computeCch(body: string): string {
  const material = new TextEncoder().encode(projectForCch(body))
  const digest = xxh64(material, CCH_SEED)
  return (digest & 0xfffffn).toString(16).padStart(5, '0')
}

/** Seal billing CCH. Enabled requests rewrite any five-hex digest, not only the placeholder. */
export function stampCchBody(body: string, enabled = true): string {
  if (!enabled) return body
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  if (!setSystemCch(parsed, '00000')) return body
  setSystemCch(parsed, computeCch(JSON.stringify(parsed)))
  return JSON.stringify(parsed)
}
