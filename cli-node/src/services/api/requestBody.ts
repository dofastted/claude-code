import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

type MessageRequestBody = Pick<
  BetaMessageStreamParams,
  'model' | 'messages' | 'max_tokens'
> & Record<string, unknown>

type FinalMessageRequestBody = Omit<BetaMessageStreamParams, 'stream'> &
  Record<string, unknown>

type MessageRequestInput = MessageRequestBody & {
  extraBodyParams: Record<string, unknown>
  wireBody?: Record<string, unknown>
  outputConfig: Record<string, unknown>
  safeguards?: unknown
  speed?: unknown
}

const NATIVE_OWNED_FIELDS = {
  model: true,
  messages: true,
  system: true,
  tools: true,
  tool_choice: true,
  thinking: true,
  metadata: true,
  max_tokens: true,
  stream: true,
  temperature: true,
  top_p: true,
  top_k: true,
  stop_sequences: true,
  betas: true,
  wireMessages: true,
  request_context: true,
  output_config: true,
  context_management: true,
  safeguards: true,
} as const

const CALLER_OPTIONAL_FIELDS = [
  'tools',
  'tool_choice',
  'thinking',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'context_management',
  'output_config',
  'safeguards',
] as const

/** One final merge for generated CLI requests and caller-owned native requests. */
export function assembleMessageRequest(
  input: MessageRequestInput,
): FinalMessageRequestBody {
  const extra = input.extraBodyParams
  const wire = input.wireBody
  const body: MessageRequestBody = {
    model: input.model,
    messages: input.messages,
    system: input.system,
    tools: input.tools,
    tool_choice: input.tool_choice,
    betas: input.betas,
    metadata: input.metadata,
    max_tokens: input.max_tokens,
    thinking: input.thinking,
    ...(input.temperature !== undefined && { temperature: input.temperature }),
    ...(input.top_p !== undefined && { top_p: input.top_p }),
    ...(input.top_k !== undefined && { top_k: input.top_k }),
    ...(input.stop_sequences !== undefined && {
      stop_sequences: input.stop_sequences,
    }),
    ...(input.context_management !== undefined && {
      context_management: input.context_management,
    }),
    ...extra,
  }

  if (wire) {
    for (const key in wire) {
      if (Object.hasOwn(wire, key) && !Object.hasOwn(NATIVE_OWNED_FIELDS, key)) {
        body[key] = wire[key]
      }
    }
    for (const key of CALLER_OPTIONAL_FIELDS) {
      if (Object.hasOwn(extra, key)) continue
      if (!Object.hasOwn(wire, key)) {
        // Omission is meaningful on thread continuations; [] is not inheritance.
        delete body[key]
      } else if (key !== 'tools' || !Array.isArray(wire.tools)) {
        body[key] = wire[key]
      }
    }
  }

  if (input.safeguards != null) body.safeguards = input.safeguards
  if (Object.keys(input.outputConfig).length > 0) {
    body.output_config = input.outputConfig
  }
  if (input.speed !== undefined && !wire) body.speed = input.speed
  return body as FinalMessageRequestBody
}
