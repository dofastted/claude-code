export const PROTOCOL_VERSION = 2
export const CAPABILITIES = [
  'multi_slot',
  'native_sse',
  'stateless',
  // Answers ping from the stdin loop and acks every cancel.
  'ping',
  'classifier_request_context',
] as const

export type StdinFrame =
  | {
      type: 'job_start'
      job_id: string
      slot_id: string
      request: Record<string, unknown>
      request_context?: import('./classifierRequest.js').ClassifierRequestContext
    }
  | { type: 'cancel'; job_id: string; slot_id?: string }
  | { type: 'ping'; nonce: string }

export type StdoutFrame =
  | {
      type: 'host_ready'
      protocol_version: number
      slots: number
      system_layout: string
      timezone: string
      capabilities: string[]
      config_hash?: string
    }
  | { type: 'slot_ready'; slot_id: string }
  | {
      type: 'stream_event'
      job_id: string
      slot_id: string
      event: unknown
    }
  | {
      type: 'job_done'
      job_id: string
      slot_id: string
      stop_reason: string
      usage?: unknown
      headers?: Record<string, string>
    }
  | {
      type: 'job_error'
      job_id: string
      slot_id?: string
      error: string
      code?: string
      status?: number
      error_type?: string
      retry_after?: string
      upstream_code?: string
      request_id?: string
    }
  | { type: 'cancel_ack'; job_id: string; slot_id: string }
  | { type: 'pong'; nonce: string }

export function parseStdinLine(line: string): StdinFrame | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as StdinFrame
    if (!parsed || typeof parsed.type !== 'string') return null
    if (parsed.type !== 'job_start' && parsed.type !== 'cancel' && parsed.type !== 'ping') return null
    return parsed
  } catch {
    return null
  }
}

let writeChain: Promise<void> = Promise.resolve()

export function writeStdout(frame: StdoutFrame): Promise<void> {
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
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (err?: Error | null) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve()
    }
    const ok = process.stdout.write(line, err => done(err))
    if (!ok) process.stdout.once('drain', () => done())
  })
}

export function slotId(index: number): string {
  return `s${String(index).padStart(2, '0')}`
}
