/**
 * NativeMessagesRunner — stateless slot host.
 *
 * Each job is one API call. System retains the caller's persona after the
 * CLI-owned billing, identity and timezone prefix. The caller transcript is
 * the prompt messages. The CLI still does not execute tools.
 */
import { createInterface } from 'node:readline'
import type {
  BetaToolChoiceAuto,
  BetaToolChoiceTool,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { queryKinMessagesWithStreaming } from '../services/api/claude.js'
import {
  runWithJobSession,
  getJobSessionId,
  getJobAutoCompactWindow,
  runWithJobAutoCompactWindow,
} from '../bootstrap/jobSession.js'
import { asSessionId } from '../types/ids.js'
import type { Message } from '../types/message.js'
import { createAssistantMessage, createUserMessage } from '../utils/messages.js'
import { isStaleConnectionError, isStaleConnectionHay } from './staleConnection.js'
import { CAPABILITIES, PROTOCOL_VERSION, parseStdinLine, slotId, writeStdout } from './stdioProtocol.js'
import { classifyKinJobError } from './jobError.js'
import { getKinTimezone, getSystemLayout } from './systemLayout.js'
import { WRAP_OFFICIAL_CLI_VERSION } from './cliVersion.js'
import { kernelEnv } from './kernelEnv.js'
import { validClassifierContext, type ClassifierRequestContext } from './classifierRequest.js'
import { withOutboundHeaders } from './outboundHeaders.js'
import { startVmTelemetry, captureVmJob, recordVmJob, type VmJobTelemetryScope } from './vmTelemetry.js'

type Phase = 'idle' | 'running' | 'cancelling'

type SlotState = {
  id: string
  phase: Phase
  jobId?: string
  abort?: AbortController
  task?: Promise<void>
}

export function nativeSlotCount(): number {
  const raw = kernelEnv('NATIVE_SLOTS')
  const n = raw ? Number(raw) : 0
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(20, Math.max(1, Math.floor(n)))
}

export async function runNativeMessagesLoop(_ctx: {
  options: {
    userSpecifiedModel?: string
    fallbackModel?: string
    thinkingConfig?: ThinkingConfig
  }
}): Promise<void> {
  const n = nativeSlotCount()
  if (n <= 0) return
  process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = '1'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli'
  process.env.USER_TYPE = process.env.USER_TYPE || 'external'
  process.env.CLAUDE_CODE_VERSION = process.env.CLAUDE_CODE_VERSION || WRAP_OFFICIAL_CLI_VERSION
  const telemetry = startVmTelemetry((state) => writeStdout({ type: 'telemetry_state', state }))

  process.stderr.write(`[kin] native_messages loop n=${n} protocol=${PROTOCOL_VERSION}\n`)
  const slots = new Map<string, SlotState>()
  for (let i = 0; i < n; i++) {
    const id = slotId(i)
    slots.set(id, { id, phase: 'idle' })
  }
  const configHash = kernelEnv('CONFIG_HASH')
  await writeStdout({
    type: 'host_ready',
    protocol_version: PROTOCOL_VERSION,
    slots: n,
    system_layout: getSystemLayout(),
    timezone: getKinTimezone(),
    capabilities: [...CAPABILITIES],
    ...(configHash ? { config_hash: configHash } : {}),
  })
  for (const id of slots.keys()) {
    await writeStdout({ type: 'slot_ready', slot_id: id })
  }
  telemetry?.start()

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of rl) {
    const msg = parseStdinLine(line)
    if (!msg) continue
    switch (msg.type) {
      case 'job_start':
        startJob(slots, msg.slot_id, msg.job_id, msg.request, _ctx.options, msg.request_context)
        break
      case 'cancel':
        // Never await here: one cancelled job that is slow to settle must not
        // stop this loop from reading frames for every other slot.
        void cancelJob(slots, msg.slot_id, msg.job_id)
        break
      case 'telemetry_event': {
        if (typeof msg.request_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(msg.request_id)) break
        // Persistence is bounded synchronous I/O; never await network in this reader.
        if (!telemetry) {
          void writeStdout({
            type: 'telemetry_ack',
            request_id: msg.request_id,
            ok: false,
            error: 'telemetry_unavailable',
          })
          break
        }
        void telemetry
          .record(msg.event)
          .then(
            () => writeStdout({ type: 'telemetry_ack', request_id: msg.request_id, ok: true }),
            (error) =>
              writeStdout({
                type: 'telemetry_ack',
                request_id: msg.request_id,
                ok: false,
                error:
                  error instanceof Error && error.message === 'invalid_event' ? 'invalid_event' : 'persistence_failed',
              }),
          )
          .catch(() => {})
        break
      }
      case 'ping':
        void writeStdout({ type: 'pong', nonce: msg.nonce })
        break
    }
  }
  telemetry?.close()
}

function startJob(
  slots: Map<string, SlotState>,
  slotIdArg: string,
  jobId: string,
  request: Record<string, unknown>,
  hostOptions: {
    userSpecifiedModel?: string
    fallbackModel?: string
    thinkingConfig?: ThinkingConfig
  },
  requestContext?: ClassifierRequestContext,
): void {
  if (requestContext !== undefined && !validClassifierContext(requestContext, request)) {
    void writeStdout({
      type: 'job_error',
      job_id: jobId,
      slot_id: slotIdArg,
      error: 'Invalid classifier request context',
      code: 'invalid_request_context',
      status: 400,
      error_type: 'invalid_request_error',
    })
    return
  }
  const slot = slots.get(slotIdArg)
  if (!slot) {
    void writeStdout({
      type: 'job_error',
      job_id: jobId,
      slot_id: slotIdArg,
      error: `unknown slot ${slotIdArg}`,
      code: 'cli_error',
      status: 502,
      error_type: 'api_error',
    })
    return
  }
  if (slot.phase !== 'idle') {
    void writeStdout({
      type: 'job_error',
      job_id: jobId,
      slot_id: slot.id,
      error: `slot ${slot.id} busy phase=${slot.phase}`,
      code: 'cli_error',
      status: 502,
      error_type: 'api_error',
    })
    return
  }

  const telemetryScope = captureVmJob()
  const abort = new AbortController()
  slot.phase = 'running'
  slot.jobId = jobId
  slot.abort = abort
  slot.task = withOutboundHeaders(
    (headers) =>
      writeStdout({
        type: 'stream_event',
        job_id: jobId,
        slot_id: slot.id,
        event: { type: 'kin_outbound_headers', headers },
      }),
    () => runJob(slot, jobId, request, hostOptions, abort, telemetryScope, requestContext),
  ).finally(() => {
    if (slot.jobId === jobId) {
      slot.phase = 'idle'
      slot.jobId = undefined
      slot.abort = undefined
      slot.task = undefined
    }
  })
}

/**
 * Idempotent: every cancel gets exactly one ack. A running job is acked
 * only after its task settled, so the kernel never reuses a slot whose
 * upstream request is still alive. Unknown, finished or duplicate cancels are
 * acked right away; the kernel matches the ack against its own pending cancel.
 */
async function cancelJob(slots: Map<string, SlotState>, slotIdArg: string | undefined, jobId: string): Promise<void> {
  const slot = slotIdArg ? slots.get(slotIdArg) : undefined
  if (slot && slot.jobId === jobId && slot.task) {
    if (slot.phase === 'running') {
      slot.phase = 'cancelling'
      slot.abort?.abort()
    }
    // startJob's finally resets the slot once the task settles.
    await slot.task.catch(() => {})
  }
  await writeStdout({
    type: 'cancel_ack',
    job_id: jobId,
    slot_id: slotIdArg ?? '',
  }).catch((err) => {
    process.stderr.write(`[kin] cancel ack write failed: ${String(err)}\n`)
  })
}

/** Node writes metadata.user_id as JSON. Header and body must use this session. */
export function sessionIdFromRequest(request: Record<string, unknown>): string | undefined {
  const metadata = request.metadata
  if (!metadata || typeof metadata !== 'object' || !('user_id' in metadata)) {
    return undefined
  }
  const raw = metadata.user_id
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (!parsed || typeof parsed !== 'object' || !('session_id' in parsed)) {
    return undefined
  }
  const id = parsed.session_id
  if (typeof id !== 'string') return undefined
  const trimmed = id.trim()
  return trimmed || undefined
}

function autoCompactWindowFromRequest(request: Record<string, unknown>): number | undefined {
  const value = Number(request.auto_compact_window)
  return Number.isInteger(value) && value >= 100_000 && value <= 1_000_000 ? value : undefined
}

async function runJob(
  slot: SlotState,
  jobId: string,
  request: Record<string, unknown>,
  hostOptions: {
    userSpecifiedModel?: string
    fallbackModel?: string
    thinkingConfig?: ThinkingConfig
  },
  abort: AbortController,
  telemetryScope: VmJobTelemetryScope | null,
  requestContext?: ClassifierRequestContext,
): Promise<void> {
  const sessionId = sessionIdFromRequest(request)
  if (sessionId && getJobSessionId() !== sessionId) {
    return runWithJobSession(asSessionId(sessionId), () =>
      runJob(slot, jobId, request, hostOptions, abort, telemetryScope, requestContext),
    )
  }
  const callerWindow = autoCompactWindowFromRequest(request)
  if (callerWindow != null && getJobAutoCompactWindow() !== callerWindow) {
    delete request.auto_compact_window
    return runWithJobAutoCompactWindow(callerWindow, () =>
      runJob(slot, jobId, request, hostOptions, abort, telemetryScope, requestContext),
    )
  }
  delete request.auto_compact_window
  const model =
    typeof request.model === 'string' && request.model ? request.model : hostOptions.userSpecifiedModel || ''
  const messages = messagesFromRequest(request)
  const system = systemFromRequest(request)
  const toolSchemas = Array.isArray(request.tools) ? (request.tools as BetaToolUnion[]) : []
  const toolChoice = request.tool_choice as BetaToolChoiceTool | BetaToolChoiceAuto | undefined
  const thinking = thinkingFromRequest(request)
  const maxTokens = typeof request.max_tokens === 'number' ? request.max_tokens : undefined
  const temperature = typeof request.temperature === 'number' ? request.temperature : undefined
  const topP = typeof request.top_p === 'number' ? request.top_p : undefined
  const topK = typeof request.top_k === 'number' ? request.top_k : undefined
  const stopSequences = Array.isArray(request.stop_sequences) ? (request.stop_sequences as string[]) : undefined
  let rateLimitHeaders: Record<string, string> = {}
  const emitRateLimitHeaders = async () => {
    if (!Object.keys(rateLimitHeaders).length) return
    await writeStdout({
      type: 'stream_event',
      job_id: jobId,
      slot_id: slot.id,
      event: { type: 'response_headers', headers: rateLimitHeaders },
    })
  }
  // Raw failure behind an assistant API-error message; the message itself only has text.
  let rawError: unknown = null
  let sawEvent = false
  const failJob = async (error: unknown, message: string, sdkKind = '') => {
    // A cancelled job ends with the ack alone.
    if (abort.signal.aborted) return
    await emitRateLimitHeaders()
    const failure = classifyKinJobError(error, { sawEvent, message, sdkKind })
    failure.retry_after ??= rateLimitHeaders['retry-after']
    failure.request_id ??= rateLimitHeaders['request-id']
    recordVmJob(telemetryScope, false, sessionId || jobId, model, failure.code)
    await writeStdout({
      type: 'job_error',
      job_id: jobId,
      slot_id: slot.id,
      ...failure,
    })
  }

  try {
    const outputConfig =
      request.output_config && typeof request.output_config === 'object'
        ? (request.output_config as Record<string, unknown>)
        : undefined
    const stream = queryKinMessagesWithStreaming({
      requestContext,
      wireSystem: request.system,
      wireThinking: request.thinking,
      messages,
      system,
      toolSchemas,
      toolChoice,
      thinking,
      maxTokens,
      temperature,
      topP,
      topK,
      stopSequences,
      model,
      signal: abort.signal,
      wireBody: request,
      wireMessages: Array.isArray(request.messages) ? request.messages : undefined,
      outputConfig,
      contextManagement: request.context_management,
      safeguards: request.safeguards,
      onResponseHeaders: (headers) => {
        rateLimitHeaders = pickRateLimitHeaders(headers)
      },
      onError: (error) => {
        rawError = error
      },
    })
    // AbortSignal reaches the HTTP client, but the async generator can still await its current read.
    // Closing the iterator makes cancelJob observe completion and emit cancel_ack.
    const closeStreamOnAbort = () => {
      void stream.return?.().catch(() => {})
    }
    if (abort.signal.aborted) closeStreamOnAbort()
    else
      abort.signal.addEventListener('abort', closeStreamOnAbort, {
        once: true,
      })
    try {
      for await (const ev of stream) {
        if (ev.type === 'stream_event') {
          const rec = ev as { event?: unknown }
          await writeStdout({
            type: 'stream_event',
            job_id: jobId,
            slot_id: slot.id,
            event: rec.event,
          })
          sawEvent = true
          continue
        }
        if (ev.type === 'assistant') {
          if ('isApiErrorMessage' in ev && ev.isApiErrorMessage) {
            await failJob(
              rawError,
              extractErrorText(ev as Record<string, unknown>),
              'error' in ev && typeof ev.error === 'string' ? ev.error : '',
            )
            return
          }
          continue
        }
        if (ev.type === 'system') {
          await failJob('error' in ev ? ev.error : null, extractErrorText(ev as Record<string, unknown>))
          return
        }
      }
    } finally {
      abort.signal.removeEventListener('abort', closeStreamOnAbort)
    }
  } catch (err) {
    if (err && typeof err === 'object' && 'headers' in err && err.headers && typeof err.headers === 'object') {
      rateLimitHeaders = {
        ...rateLimitHeaders,
        ...pickRateLimitHeaders(err.headers as Headers | Record<string, string>),
      }
    }
    await failJob(err, err instanceof Error ? err.message : String(err))
    return
  }

  if (abort.signal.aborted) return

  await emitRateLimitHeaders()
  recordVmJob(telemetryScope, true, sessionId || jobId, model)
  await writeStdout({
    type: 'job_done',
    job_id: jobId,
    slot_id: slot.id,
    stop_reason: '',
    usage: {},
    ...(Object.keys(rateLimitHeaders).length ? { headers: rateLimitHeaders } : {}),
  })
}

export function extractErrorText(ev: Record<string, unknown>): string {
  const nested =
    ev.error != null && typeof ev.error === 'object' && 'message' in ev.error ? ev.error.message : undefined
  if (typeof nested === 'string' && nested.trim()) return nested.trim().slice(0, 300)
  const message = ev.message
  if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300)
  if (message != null && typeof message === 'object' && 'content' in message) {
    const content = message.content
    if (typeof content === 'string' && content.trim()) return content.trim().slice(0, 300)
    if (Array.isArray(content)) {
      const first = content[0]
      if (first != null && typeof first === 'object' && 'text' in first) {
        const text = first.text
        if (typeof text === 'string' && text.trim()) return text.trim().slice(0, 300)
      }
    }
  }
  const hay = [typeof ev.type === 'string' ? ev.type : '', typeof nested === 'string' ? nested : ''].join(' ')
  if (isStaleConnectionError(ev) || isStaleConnectionHay(hay)) return 'connection_reset'
  return 'api_error'
}

function systemFromRequest(request: Record<string, unknown>): string[] {
  const system = request.system
  if (typeof system === 'string') return [system]
  if (!Array.isArray(system)) return []
  return system.map((block) => {
    if (typeof block === 'string') return block
    if (block && typeof block === 'object' && 'text' in block) {
      return String((block as { text?: unknown }).text || '')
    }
    return ''
  })
}

function messagesFromRequest(request: Record<string, unknown>): Message[] {
  const messages = Array.isArray(request.messages) ? request.messages : []
  return messages.map(toEngineMessage).filter((m): m is Message => m !== null)
}

function toEngineMessage(raw: unknown): Message | null {
  if (!raw || typeof raw !== 'object') return null
  const msg = raw as { role?: string; content?: unknown }
  const content = msg.content
  const asContent: string | ContentBlockParam[] =
    typeof content === 'string' || Array.isArray(content) ? (content as string | ContentBlockParam[]) : ''
  if (msg.role === 'assistant') {
    return createAssistantMessage({ content: asContent as never })
  }
  if (msg.role === 'user' || msg.role === 'tool') {
    return createUserMessage({ content: asContent })
  }
  return null
}

export function pickRateLimitHeaders(headers?: Headers | Record<string, string> | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  const entries =
    typeof (headers as Headers).entries === 'function'
      ? [...(headers as Headers).entries()]
      : Object.entries(headers as Record<string, string>)
  for (const [key, value] of entries) {
    if (value == null || value === '') continue
    const lower = key.toLowerCase()
    if (lower.startsWith('anthropic-ratelimit-') || lower === 'retry-after' || lower === 'request-id') {
      out[lower] = String(value)
    }
  }
  return out
}

export function thinkingFromRequest(request: Record<string, unknown>, _fallback?: ThinkingConfig): ThinkingConfig {
  const raw = request.thinking
  if (raw && typeof raw === 'object') {
    const rec = raw as {
      type?: string
      budget_tokens?: number
      budgetTokens?: number
      display?: string
    }
    if (rec.type === 'enabled') {
      return {
        type: 'enabled',
        budgetTokens: Number(rec.budget_tokens ?? rec.budgetTokens ?? 0),
      }
    }
    if (rec.type === 'adaptive') {
      const display = String(rec.display || '').trim()
      return display ? { type: 'adaptive', display } : { type: 'adaptive' }
    }
    if (rec.type === 'disabled' || rec.type === 'none') return { type: 'disabled' }
  }
  // Official --print fills a missing thinking block. An explicit disabled stays disabled.
  return { type: 'adaptive', display: 'omitted' }
}
