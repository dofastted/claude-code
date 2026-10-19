import { fetchUtilization } from '../../services/api/usage.js'

/**
 * Print mode cannot mount the Settings UI. Return the raw
 * GET /api/oauth/usage body so every Utilization field survives.
 */
export async function call(): Promise<{ type: 'text'; value: string }> {
  try {
    const data = await fetchUtilization()
    if (data == null) {
      return { type: 'text', value: JSON.stringify({ error: 'oauth_token_expired' }) }
    }
    return { type: 'text', value: JSON.stringify(data) }
  } catch (error) {
    const err = error as {
      message?: string
      response?: { status?: number; data?: unknown }
    }
    return {
      type: 'text',
      value: JSON.stringify({
        error: err.message || 'usage_fetch_failed',
        status: err.response?.status ?? null,
        body: err.response?.data ?? null,
      }),
    }
  }
}
