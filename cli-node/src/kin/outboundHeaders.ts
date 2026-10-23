import { AsyncLocalStorage } from 'node:async_hooks'

type Observer = (headers: Record<string, string>) => Promise<void>
const observer = new AsyncLocalStorage<Observer>()
const PUBLIC_HEADER =
  /^(accept(?:-encoding|-language)?|anthropic-(?:beta|version|dangerous-direct-browser-access)|content-(?:type|length)|user-agent|x-app|x-client-request-id|x-stainless-(?:lang|os|arch|runtime|runtime-version|package-version|retry-count|timeout|helper-method)|x-claude-code-(?:session-id|request-class|agent-type|prev-tool-durations|compaction|context-compacted|prompt-id))$/

export function withOutboundHeaders<T>(report: Observer, task: () => T): T {
  return observer.run(report, task)
}

/** Unknown/custom header values are private, even if their names do not say token. */
export async function reportOutboundHeaders(headers: Headers): Promise<void> {
  const report = observer.getStore()
  if (!report) return
  const snapshot: Record<string, string> = {}
  for (const [key, value] of headers.entries()) {
    snapshot[key] = PUBLIC_HEADER.test(key) ? value : '***REDACTED***'
  }
  try {
    await report(snapshot)
  } catch {
    // An unavailable diagnostic channel must not change the upstream request.
    process.stderr.write('[kin] outbound header report failed\n')
  }
}
