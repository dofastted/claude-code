import { AsyncLocalStorage } from 'node:async_hooks'
import type { SessionId } from '../types/ids.js'

type JobContext = {
  sessionId?: SessionId
  autoCompactWindow?: number
}

const storage = new AsyncLocalStorage<JobContext>()

/** Session bound to the current native job, if one is running. */
export function getJobSessionId(): SessionId | undefined {
  return storage.getStore()?.sessionId
}

/** Keep header and metadata on this session across awaits in one job. */
export function runWithJobSession<T>(sessionId: SessionId, fn: () => T): T {
  return storage.run({ ...storage.getStore(), sessionId }, fn)
}

export function getJobAutoCompactWindow(): number | undefined {
  return storage.getStore()?.autoCompactWindow
}

export function runWithJobAutoCompactWindow<T>(windowTokens: number | undefined, fn: () => T): T {
  const current = storage.getStore()
  return storage.run(
    windowTokens == null ? { ...current } : { ...current, autoCompactWindow: windowTokens },
    fn,
  )
}
