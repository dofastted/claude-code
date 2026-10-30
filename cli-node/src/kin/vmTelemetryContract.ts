import { z } from 'zod'
// RecordOnly and Context refer back to these schemas only inside functions, after module initialization.
import { forwardManagedAnalytics } from './vmTelemetryRecordOnly.js'

export const telemetrySettings = {
  autoCompactEnabled: z.boolean(),
  spinnerTipsEnabled: z.boolean(),
  prefersReducedMotion: z.boolean(),
  thinkingEnabled: z.boolean(),
  fastMode: z.boolean(),
  verbose: z.boolean(),
  respectGitignore: z.boolean(),
  useAutoModeDuringPlan: z.boolean(),
  'env.ANTHROPIC_API_KEY': z.boolean(),
  defaultPermissionMode: z.enum(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk']),
  defaultView: z.enum(['default', 'transcript', 'chat']),
  theme: z.enum(['dark', 'light', 'light-daltonized', 'dark-daltonized', 'light-ansi', 'dark-ansi', 'system']),
  editorMode: z.enum(['emacs', 'vim']),
  autoUpdatesChannel: z.enum(['latest', 'stable']),
} as const

const oauth = z
  .object({
    event_id: z.string().uuid(),
    kind: z.literal('oauth'),
    attempt_id: z.string().uuid(),
    operation: z.enum(['session_key', 'authorization_code', 'reauthorize', 'refresh']),
    phase: z.enum(['start', 'success', 'failure']),
    error_code: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .optional(),
  })
  .strict()

const setting = z
  .object({
    event_id: z.string().uuid(),
    kind: z.literal('setting'),
    setting: z.enum(
      Object.keys(telemetrySettings) as [keyof typeof telemetrySettings, ...Array<keyof typeof telemetrySettings>],
    ),
    value: z.union([z.boolean(), z.string()]),
  })
  .strict()
  .superRefine((event, context) => {
    if (!telemetrySettings[event.setting].safeParse(event.value).success) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid setting value' })
    }
  })

export const telemetryEventSchema = z.union([oauth, setting])
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>
export type TelemetryState = {
  enabled: boolean
  state: 'disabled' | 'idle' | 'waiting_credentials' | 'waiting_egress' | 'uploading' | 'error'
  pending_events: number
  last_upload_at: string | null
  last_error: string | null
}

export function isManagedTelemetryProcess(): boolean {
  return Boolean(process.env.KERNEL_CONFIG)
}

let recorder: ((eventName: string, metadata: Record<string, unknown>) => Promise<void>) | undefined

export function installManagedTelemetryRecorder(record: NonNullable<typeof recorder>): void {
  recorder = record
}

export async function recordManagedAnalytics(eventName: string, metadata: Record<string, unknown>): Promise<void> {
  if (recorder) {
    await recorder(eventName, metadata)
    return
  }
  await forwardManagedAnalytics(eventName, metadata)
}
