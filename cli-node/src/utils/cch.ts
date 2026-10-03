/**
 * Claude Code 2.1.281 cch.
 * Seed and the four lane constants are the movabs immediates in the linux-x64
 * ELF. The hash input is the final JSON with:
 *   1. the first cch= value reset to 00000
 *   2. every string-valued "model" cleared, quotes kept
 *   3. fallbacks array, fallback_credit_token string, and max_tokens digits
 *      removed, plus one adjacent comma
 * Same-length replacement of 00000 keeps Content-Length valid.
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
  return (((acc ^ round(0n, val)) * P1) + P4) & U
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
    h =
      (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & U
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

export function projectForCch(body: string): string {
  const reset = body.replace(/cch=[0-9a-f]{5}/, 'cch=00000')
  return skipMaxTokens(skipCredit(skipFallbacks(blankStringModels(reset))))
}

export function computeCch(body: string): string {
  const material = new TextEncoder().encode(projectForCch(body))
  const digest = xxh64(material, CCH_SEED)
  return (digest & 0xfffffn).toString(16).padStart(5, '0')
}

/** Replace the first cch=00000 with the computed token. No-op if absent. */
export function stampCchBody(body: string): string {
  if (!body.includes('cch=00000')) return body
  return body.replace('cch=00000', `cch=${computeCch(body)}`)
}
