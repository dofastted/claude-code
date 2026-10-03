export const SLOT_CAP = 20

export type SlotPhase = 'idle' | 'running' | 'waiting'

export type PoolSlot = {
  id: string
  phase: SlotPhase
  /** Empty until the slot has served a model. Sticky until it goes idle. */
  model: string
  sessionId?: string
}

export function clampMaxProcs(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return SLOT_CAP
  return Math.min(SLOT_CAP, Math.max(1, Math.floor(n)))
}

export function contentHasToolResult(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.some(block => {
    if (!block || typeof block !== 'object' || !('type' in block)) return false
    return block.type === 'tool_result'
  })
}

export function agentPromptFromJson(raw: string, agentName: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, { prompt?: string }>
    if (agentName && parsed[agentName]?.prompt) return String(parsed[agentName].prompt)
    const first = Object.values(parsed).find(agent => agent?.prompt)
    return first?.prompt ? String(first.prompt) : ''
  } catch {
    return ''
  }
}

/**
 * Resume a waiting slot for this session. Otherwise prefer an idle slot
 * already pinned to the model, then an unpinned idle slot, then any idle
 * slot (the pool may mix models).
 */
export function pickSlot(
  slots: readonly PoolSlot[],
  sessionId: string,
  model: string,
  resume: boolean,
): number {
  if (resume) {
    return slots.findIndex(
      slot => slot.sessionId === sessionId && slot.phase === 'waiting',
    )
  }
  const pinned = slots.findIndex(
    slot => slot.phase === 'idle' && slot.model === model && model !== '',
  )
  if (pinned >= 0) return pinned
  const unpinned = slots.findIndex(slot => slot.phase === 'idle' && !slot.model)
  if (unpinned >= 0) return unpinned
  return slots.findIndex(slot => slot.phase === 'idle')
}
