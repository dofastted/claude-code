/**
 * Ordered --fallback-model list: comma-separated CLI string or settings array.
 * Official uas/ooo/Ne: split, trim, drop empty, resolve "default", dedupe, cap 3.
 * Public CLI name stays fallbackModel; callers normalize at the boundary.
 */

export const MAX_FALLBACK_MODELS = 3

export function splitFallbackModelList(raw: string): string[] {
  return raw
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== '')
}

export function normalizeFallbackModels(
  raw: string | readonly string[] | undefined,
  resolveDefault: () => string,
  isAllowed: (model: string) => boolean = () => true,
): string[] | undefined {
  if (raw === undefined) return undefined
  const items = typeof raw === 'string' ? splitFallbackModelList(raw) : raw
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const trimmed = typeof item === 'string' ? item.trim() : ''
    if (trimmed === '') continue
    const resolved = trimmed === 'default' ? resolveDefault() : trimmed
    if (seen.has(resolved)) continue
    if (!isAllowed(resolved)) continue
    seen.add(resolved)
    out.push(resolved)
    if (out.length === MAX_FALLBACK_MODELS) break
  }
  return out.length > 0 ? out : undefined
}

/** [primary, ...fallbacks] with primary retried at the start of each user turn. */
export function buildFallbackChain(
  primary: string,
  fallbacks: readonly string[] | undefined,
): string[] {
  if (!fallbacks || fallbacks.length === 0) return [primary]
  const seen = new Set<string>([primary])
  const chain = [primary]
  for (const model of fallbacks) {
    if (seen.has(model)) continue
    seen.add(model)
    chain.push(model)
  }
  return chain
}
