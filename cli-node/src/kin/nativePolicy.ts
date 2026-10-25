type NativeBody = {
  model?: unknown
  thinking?: unknown
  tools?: unknown
  tool_choice?: unknown
}

const COMPUTER_FROM = 'computer_20251124'
const COMPUTER_TO = 'computer_toolset_20260801'

function bareModel(model: unknown): string {
  const parts = String(model || '').split('[')[0].split('/').filter(Boolean)
  return parts[parts.length - 1] || ''
}

function adaptiveThinking(thinking: object) {
  if (!('display' in thinking)) return { type: 'adaptive' as const }
  const display = thinking.display
  if (display == null || String(display).trim() === '') return { type: 'adaptive' as const }
  return { type: 'adaptive' as const, display }
}

/**
 * Native jobs preserve caller fields after this point. Model rejections that
 * used to run in Node must happen here, or an explicit legacy value reaches
 * upstream unchanged.
 */
export function applyNativeModelPolicy(body: NativeBody): void {
  if (!body || typeof body !== 'object') return
  const model = bareModel(body.model)
  const thinking = body.thinking && typeof body.thinking === 'object' ? body.thinking : null
  if (/haiku/i.test(model) && !/^claude-haiku-5(?:-5|\.5)(?=-|$)/i.test(model)) {
    body.thinking = { type: 'disabled' }
    return
  }
  if (/^claude-haiku-5(?:-5|\.5)(?=-|$)/i.test(model)) {
    const type = thinking && 'type' in thinking ? String(thinking.type || '').toLowerCase() : ''
    const legacy = thinking && 'budget_tokens' in thinking && thinking.budget_tokens != null
    if (thinking && (type === 'enabled' || legacy)) body.thinking = adaptiveThinking(thinking)
    return
  }
  if (!/^claude-opus-5(?:-5|\.5)(?=-|$)/i.test(model) && !/^claude-sonnet-5(?:-5|\.5)(?=-|$)/i.test(model)) return
  if (thinking) {
    const type = 'type' in thinking ? String(thinking.type || '').toLowerCase() : ''
    const legacy = 'budget_tokens' in thinking && thinking.budget_tokens != null
    if (type === 'disabled' || type === 'enabled' || legacy) body.thinking = adaptiveThinking(thinking)
  }
  if (/^claude-opus-5(?:-5|\.5)(?=-|$)/i.test(model) && Array.isArray(body.tools)) {
    body.tools = body.tools.map((tool) => {
      if (!tool || typeof tool !== 'object' || !('type' in tool)) return tool
      return tool.type === COMPUTER_FROM ? { ...tool, type: COMPUTER_TO } : tool
    })
  }
  const choice = body.tool_choice
  const choiceType = typeof choice === 'string'
    ? choice.toLowerCase()
    : choice && typeof choice === 'object' && 'type' in choice
      ? String(choice.type || '').toLowerCase()
      : ''
  if (choiceType !== 'any' && choiceType !== 'tool' && choiceType !== 'required') return
  const name = choice && typeof choice === 'object' && 'name' in choice ? String(choice.name || '') : ''
  if (choiceType === 'tool' && name && Array.isArray(body.tools)) {
    body.tools = body.tools.map((tool) => {
      if (!tool || typeof tool !== 'object' || !('name' in tool) || !('input_schema' in tool)) return tool
      return tool.name === name && tool.input_schema ? { ...tool, strict: true } : tool
    })
  }
  body.tool_choice = { type: 'auto' }
}
