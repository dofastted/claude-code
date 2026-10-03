import { AsyncLocalStorage } from 'node:async_hooks'
import type { SessionId } from '../types/ids.js'

const storage = new AsyncLocalStorage<SessionId>()

/** Session bound to the current native job, if one is running. */
export function getJobSessionId(): SessionId | undefined {
  return storage.getStore()
}

/** Keep header and metadata on this session across awaits in one job. */
export function runWithJobSession<T>(sessionId: SessionId, fn: () => T): T {
  return storage.run(sessionId, fn)
}
