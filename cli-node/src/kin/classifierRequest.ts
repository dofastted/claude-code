import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'

export type ClassifierRequestContext = {
  purpose: 'auto_mode_classifier'
  format: 'xml' | 'tool'
  stage?: 'xml_s1' | 'xml_s2' | 'fast'
}

export function validClassifierContext(value: unknown, request: Record<string, unknown>): value is ClassifierRequestContext {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(k => !['purpose', 'format', 'stage'].includes(k)) || v.purpose !== 'auto_mode_classifier') return false
  if (v.format === 'tool') {
    const choice = request.tool_choice as Record<string, unknown> | undefined
    return v.stage === undefined && choice?.type === 'tool' && choice.name === 'classify_result' &&
      Array.isArray(request.tools) && request.tools.some(t => t?.name === 'classify_result')
  }
  // Text verdict tags change across client versions (`<block>`, `<severity>`, …);
  // only the transcript envelope and the absence of a forced tool define xml.
  return v.format === 'xml' && (v.stage === undefined || ['xml_s1', 'xml_s2', 'fast'].includes(String(v.stage))) &&
    request.tool_choice === undefined && (JSON.stringify(request.messages) || '').includes('<transcript>')
}

/** Replace transport billing only; text, boundaries and caller cache anchors stay intact. */
export function classifierSystemBlocks(system: unknown, attribution: string): TextBlockParam[] {
  const blocks: TextBlockParam[] = typeof system === 'string'
    ? [{ type: 'text', text: system }]
    : Array.isArray(system) ? structuredClone(system) : []
  const kept = blocks.filter(b => !/^x-anthropic-billing-header:/i.test(b.text.trimStart()))
  return attribution ? [{ type: 'text', text: attribution }, ...kept] : kept
}
