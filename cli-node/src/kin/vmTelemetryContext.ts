import { createHash } from 'node:crypto'
import { constants, closeSync, existsSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { release } from 'node:os'
import { z } from 'zod'
import type { EventMetadata } from '../services/analytics/metadata.js'
import type { CoreUserData } from '../utils/user.js'
import { telemetrySettings } from './vmTelemetryContract.js'

export function readTelemetryJson(filename: string): Record<string, unknown> {
  try {
    const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 1_048_576) return {}
      const parsed: unknown = JSON.parse(readFileSync(fd, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } finally {
      closeSync(fd)
    }
  } catch {
    return {}
  }
}

export function telemetryHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

const kernelSchema = z.object({
  vm_id: z.string().min(1).max(128),
  credential_path: z.string(),
  socket_path: z.string(),
  internal_token: z.string(),
  runtime_kind: z.string().optional(),
  cli_version: z.string().optional(),
  test_endpoints: z.boolean().optional(),
  telemetry: z
    .object({
      upload_interval_seconds: z.number().optional(),
      proxy_id: z.string().nullable(),
      proxy_url: z.string(),
      proxy_required: z.boolean(),
      event_logging_url: z.string().optional(),
      geo_url: z.string().optional(),
    })
    .optional(),
})
export type VmTelemetryKernelConfig = z.infer<typeof kernelSchema>
const profileSchema = z.object({
  accountUuid: z.string().optional(),
  organizationUuid: z.string().optional(),
  emailAddress: z.string().optional(),
})
const oauthSchema = z.object({
  accessToken: z.string().optional(),
  access_token: z.string().optional(),
  expiresAt: z.union([z.number(), z.string()]).optional(),
  expires_at: z.union([z.number(), z.string()]).optional(),
  scopes: z.union([z.array(z.string()), z.string()]).optional(),
  scope: z.string().optional(),
  accountUuid: z.string().optional(),
  account_uuid: z.string().optional(),
  organizationUuid: z.string().optional(),
  orgUuid: z.string().optional(),
  org_uuid: z.string().optional(),
  organization_uuid: z.string().optional(),
  email: z.string().optional(),
  emailAddress: z.string().optional(),
  email_address: z.string().optional(),
})
export interface VmTelemetryContext {
  home: string
  configPath: string
  configFile: string
  credentialPath: string
  kernel: VmTelemetryKernelConfig
  account: string | null
  credentialAccount: string | null
  enabled: boolean
  validCredentials: boolean
  accessToken: string | null
  tokenHash: string | null
  interval: number
  binding: string | null
  version: string
  bindingValid: boolean
  proxyUrl: string | null
  proxyId: string | null
  endpoint: string
  geoEndpoint: string
  safeSettings: Record<string, boolean | string>
  userId: string | undefined
  user: CoreUserData
}

export function readVmTelemetryContext(): VmTelemetryContext {
  const configPath = process.env.KERNEL_CONFIG
  const home = process.env.CLAUDE_CONFIG_DIR
  if (!configPath || !isAbsolute(configPath) || !home || !isAbsolute(home)) throw new Error('telemetry_context_missing')
  const parsedKernel = kernelSchema.safeParse(readTelemetryJson(configPath))
  if (!parsedKernel.success) throw new Error('telemetry_config_invalid')
  const kernel = parsedKernel.data
  if (!isAbsolute(kernel.credential_path) || resolve(dirname(kernel.credential_path)) !== resolve(home)) {
    throw new Error('telemetry_credential_path_invalid')
  }
  const policy = readTelemetryJson(join(home, 'kin-seed.json'))
  const seedPolicy = policy.seed_policy
  const enabled =
    process.platform === 'linux' &&
    Boolean(
      seedPolicy &&
        typeof seedPolicy === 'object' &&
        'telemetry_disabled' in seedPolicy &&
        seedPolicy.telemetry_disabled === false,
    )
  const configFile = join(home, existsSync(join(home, '.config.json')) ? '.config.json' : '.claude.json')
  const config = readTelemetryJson(configFile)
  const credentials = readTelemetryJson(kernel.credential_path)
  const parsedOAuth = oauthSchema.safeParse(credentials.claudeAiOauth ?? credentials)
  const oauth = parsedOAuth.success ? parsedOAuth.data : {}
  const parsedProfile = profileSchema.safeParse(config.oauthAccount)
  const profile = parsedProfile.success ? parsedProfile.data : {}
  const credentialAccount = oauth.accountUuid || oauth.account_uuid || null
  const account = credentialAccount || profile.accountUuid || null
  const sameProfile = !credentialAccount || credentialAccount === profile.accountUuid
  const token = oauth.accessToken || oauth.access_token || ''
  const rawExpiry = Number(oauth.expiresAt ?? oauth.expires_at)
  const expiresAt = rawExpiry < 10_000_000_000 ? rawExpiry * 1000 : rawExpiry
  const rawScopes = oauth.scopes ?? oauth.scope ?? []
  const scopes = typeof rawScopes === 'string' ? rawScopes.split(/\s+/) : rawScopes
  const validCredentials =
    !credentials.anthropicApiKey &&
    credentials.type !== 'apikey' &&
    Boolean(token && Number.isFinite(expiresAt) && expiresAt > Date.now() && scopes.includes('user:profile') && account)
  const projection = kernel.telemetry
  const interval = projection?.upload_interval_seconds ?? 600
  const intervalValid = Number.isInteger(interval) && interval >= 60 && interval <= 86400 && interval % 60 === 0
  const bindingValid = Boolean(projection?.proxy_id)
  // The guest never dials a proxy. Binding identifies the exit the outer forwarder already applies.
  const binding = bindingValid ? telemetryHash([projection!.proxy_id, '', false]) : null
  const endpoint =
    kernel.test_endpoints === true && projection?.event_logging_url
      ? projection.event_logging_url
      : 'https://api.anthropic.com/api/event_logging/batch'
  const geoEndpoint =
    kernel.test_endpoints === true && projection?.geo_url
      ? projection.geo_url
      : 'http://ip-api.com/json/?fields=status,message,query,country,countryCode,regionName,city,timezone,isp'
  for (const [url, productionHost] of [
    [endpoint, 'api.anthropic.com'],
    [geoEndpoint, 'ip-api.com'],
  ]) {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      throw new Error('telemetry_endpoint_invalid')
    }
    if (
      /^https?:\/\/[^/]*@/i.test(url) ||
      !['http:', 'https:'].includes(target.protocol) ||
      (kernel.test_endpoints !== true && target.hostname !== productionHost)
    )
      throw new Error('telemetry_endpoint_invalid')
  }
  const settings = { ...config, ...readTelemetryJson(join(home, 'settings.json')) }
  const safeSettings: Record<string, boolean | string> = {}
  for (const [key, schema] of Object.entries(telemetrySettings)) {
    if (key === 'env.ANTHROPIC_API_KEY') continue
    const parsed = schema.safeParse(settings[key])
    if (parsed.success) safeSettings[key] = parsed.data
  }
  const env = settings.env
  safeSettings['env.ANTHROPIC_API_KEY'] = Boolean(
    env &&
      typeof env === 'object' &&
      'ANTHROPIC_API_KEY' in env &&
      typeof env.ANTHROPIC_API_KEY === 'string' &&
      env.ANTHROPIC_API_KEY.length,
  )
  const userId =
    typeof config.userID === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(config.userID) ? config.userID : undefined
  return {
    home,
    configPath,
    kernel,
    configFile,
    credentialPath: kernel.credential_path,
    account,
    enabled,
    validCredentials,
    accessToken: validCredentials ? token : null,
    tokenHash: token ? telemetryHash(token) : null,
    credentialAccount,
    interval: intervalValid ? interval * 1000 : 600_000,
    binding,
    version: telemetryHash([binding, endpoint, geoEndpoint]),
    bindingValid,
    proxyUrl: null,
    proxyId: bindingValid ? projection!.proxy_id : null,
    endpoint,
    geoEndpoint,
    safeSettings,
    userId,
    user: {
      deviceId: userId || '',
      sessionId: '',
      appVersion: kernel.cli_version || MACRO.VERSION,
      platform: 'linux',
      ...(account ? { accountUuid: account } : {}),
      ...(oauth.organizationUuid ||
      oauth.orgUuid ||
      oauth.org_uuid ||
      oauth.organization_uuid ||
      (sameProfile && profile.organizationUuid)
        ? {
            organizationUuid:
              oauth.organizationUuid ||
              oauth.orgUuid ||
              oauth.org_uuid ||
              oauth.organization_uuid ||
              profile.organizationUuid,
          }
        : {}),
      ...(oauth.email || oauth.emailAddress || oauth.email_address || (sameProfile && profile.emailAddress)
        ? { email: oauth.email || oauth.emailAddress || oauth.email_address || profile.emailAddress }
        : {}),
    },
  }
}

export function vmEventEnrichment(context: VmTelemetryContext, sessionId?: string, model?: string) {
  const envContext = {
    platform: process.platform,
    platformRaw: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    isRunningWithBun: Boolean(process.versions.bun),
    version: context.kernel.cli_version || MACRO.VERSION,
    isClaudeAiAuth: context.validCredentials,
    // Containers see the host kernel; do not label it as this VM's observation.
    ...(context.kernel.runtime_kind === 'kvm' ? { linuxKernel: release() } : {}),
  }
  const coreMetadata = {
    sessionId: sessionId || '',
    model: model || '',
    userType: 'external',
    entrypoint: 'sdk-cli',
    isInteractive: 'false',
    clientType: 'cli',
    envContext,
    processMetrics: { uptime: process.uptime(), ...process.memoryUsage(), cpuUsage: process.cpuUsage() },
  } as EventMetadata // Native serializer accepts optional environment fields; no host-derived defaults.
  return { userId: context.userId, userMetadata: context.user, coreMetadata }
}
