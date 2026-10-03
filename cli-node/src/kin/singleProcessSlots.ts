/**
 * One OS process, N background agent slots, stream-json on stdin/stdout.
 * Crag passes --single-process-subagents --max-procs N --continuous-tool-loop.
 * A tool_use turn parks the slot until the same session_id sends tool_result.
 * The CLI does not execute those tools.
 */
import { createInterface } from 'node:readline'
import { createAssistantMessage, createUserMessage } from '../utils/messages.js'
import type { ThinkingConfig } from '../utils/thinking.js'
import {
  clampMaxProcs,
  contentHasToolResult,
  pickSlot,
  type PoolSlot,
} from './slotPool.js'

type Phase = PoolSlot['phase']

type LiveSlot = PoolSlot & {
  tools: unknown[]
  transcript: Array<{ role: 'user' | 'assistant'; content: unknown }>
}

type Block = {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  partial?: string
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  return args[index + 1]
}

function thinkingFor(model: string): ThinkingConfig {
  if (/haiku/i.test(model)) return { type: 'disabled' }
  return { type: 'adaptive' }
}

let writeChain: Promise<void> = Promise.resolve()

function writeFrame(frame: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify(frame) + '\n'
  const next = writeChain.then(
    () => writeLine(line),
    () => writeLine(line),
  )
  writeChain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

function writeLine(line: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  const ok = process.stdout.write(line, () => resolve())
  if (!ok) process.stdout.once('drain', () => resolve())
  return promise
}

function userContent(frame: Record<string, unknown>): unknown {
  const message = frame.message
  if (!message || typeof message !== 'object' || !('content' in message)) return ''
  return message.content
}

function systemFromFrame(frame: Record<string, unknown>): string[] {
  const system = frame.system
  if (typeof system === 'string') {
    const text = system.trim()
    return text ? [text] : []
  }
  if (!Array.isArray(system)) return []
  const blocks: string[] = []
  for (const block of system) {
    if (typeof block === 'string') {
      if (block.trim()) blocks.push(block)
      continue
    }
    if (block && typeof block === 'object' && 'text' in block) {
      const text = String((block as { text?: unknown }).text || '')
      if (text.trim()) blocks.push(text)
    }
  }
  return blocks
}

function applyBlockEvent(blocks: Block[], event: Record<string, unknown>) {
  const index = typeof event.index === 'number' ? event.index : -1
  if (index < 0) return
  if (event.type === 'content_block_start') {
    const start = event.content_block
    if (start && typeof start === 'object' && 'type' in start) {
      blocks[index] = { ...(start as Block), partial: '' }
    }
    return
  }
  const block = blocks[index]
  if (!block) return
  if (event.type === 'content_block_delta') {
    const delta = event.delta
    if (!delta || typeof delta !== 'object' || !('type' in delta)) return
    if (delta.type === 'text_delta' && 'text' in delta) {
      block.text = `${block.text || ''}${String(delta.text || '')}`
    }
    if (delta.type === 'input_json_delta' && 'partial_json' in delta) {
      block.partial = `${block.partial || ''}${String(delta.partial_json || '')}`
    }
    return
  }
  if (event.type === 'content_block_stop' && block.type === 'tool_use' && block.partial) {
    try {
      block.input = JSON.parse(block.partial)
    } catch {
      block.input = {}
    }
    delete block.partial
  }
}

function toEngine(raw: { role: 'user' | 'assistant'; content: unknown }) {
  const content = Array.isArray(raw.content) || typeof raw.content === 'string' ? raw.content : ''
  if (raw.role === 'assistant') return createAssistantMessage({ content: content as never })
  return createUserMessage({ content: content as never })
}

export async function runSingleProcessSlots(): Promise<void> {
  const args = process.argv.slice(2)
  const count = clampMaxProcs(flagValue(args, '--max-procs'))
  const modelDefault = flagValue(args, '--model') || ''
  const continuous = args.includes('--continuous-tool-loop')
  process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = '1'
  process.env.CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'sdk-cli'
  process.env.USER_TYPE = process.env.USER_TYPE || 'external'

  const slots: LiveSlot[] = []
  for (let i = 0; i < count; i++) {
    slots.push({
      id: `s${String(i).padStart(2, '0')}`,
      phase: 'idle',
      model: '',
      tools: [],
      transcript: [],
    })
  }
  process.stderr.write(
    `[crag] single_process slots=${count} continuous=${continuous ? 1 : 0}\n`,
  )

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    if (frame.type !== 'user') continue
    const sessionId = typeof frame.session_id === 'string' ? frame.session_id : ''
    if (!sessionId) continue
    const content = userContent(frame)
    const resume = continuous && contentHasToolResult(content)
    const requested =
      typeof frame.model === 'string' && frame.model ? frame.model : modelDefault
    const index = pickSlot(slots, sessionId, requested, resume)
    if (index < 0) {
      await writeFrame({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        session_id: sessionId,
        stop_reason: 'end_turn',
        result: resume ? 'slot is not waiting for tool_result' : 'no free slot',
      })
      continue
    }
    const slot = slots[index]!
    if (!resume) {
      slot.transcript = slot.sessionId === sessionId ? slot.transcript : []
      if (Array.isArray(frame.tools)) slot.tools = frame.tools
    }
    slot.phase = 'running'
    slot.sessionId = sessionId
    slot.model = requested || slot.model
    slot.transcript.push({ role: 'user', content })
    void runSlot(slot, continuous, systemFromFrame(frame))
  }
}

async function runSlot(
  slot: LiveSlot,
  continuous: boolean,
  system: string[],
): Promise<void> {
  const sessionId = slot.sessionId || ''
  const blocks: Block[] = []
  let stop = ''
  let usage: unknown = {}
  try {
    const { queryKinMessagesWithStreaming } = await import('../services/api/claude.js')
    const stream = queryKinMessagesWithStreaming({
      messages: slot.transcript.map(toEngine),
      system,
      toolSchemas: slot.tools as never,
      thinking: thinkingFor(slot.model),
      model: slot.model,
      signal: new AbortController().signal,
    })
    for await (const ev of stream) {
      if (ev.type === 'stream_event') {
        const event = (ev as { event?: Record<string, unknown> }).event || {}
        applyBlockEvent(blocks, event)
        if (event.type === 'message_delta') {
          const delta = event.delta
          if (delta && typeof delta === 'object' && 'stop_reason' in delta && delta.stop_reason) {
            stop = String(delta.stop_reason)
          }
          if ('usage' in event && event.usage) usage = event.usage
        }
        await writeFrame({ type: 'stream_event', session_id: sessionId, event })
        continue
      }
      if (ev.type === 'assistant' && (ev as { isApiErrorMessage?: boolean }).isApiErrorMessage) {
        throw new Error('api_error')
      }
    }
  } catch (err) {
    slot.phase = 'idle'
    slot.sessionId = undefined
    await writeFrame({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: sessionId,
      stop_reason: 'end_turn',
      result: err instanceof Error ? err.message : String(err),
    })
    return
  }

  const text = blocks
    .filter(block => block.type === 'text' && block.text)
    .map(block => block.text)
    .join('')
  if (blocks.length) {
    slot.transcript.push({
      role: 'assistant',
      content: blocks.map(block => {
        const { partial: _partial, ...rest } = block
        return rest
      }),
    })
  }
  const parked = continuous && stop === 'tool_use'
  slot.phase = parked ? 'waiting' : 'idle'
  if (!parked) slot.sessionId = undefined
  await writeFrame({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId,
    stop_reason: stop || (text ? 'end_turn' : ''),
    ...(text ? { result: text } : {}),
    usage,
  })
}
