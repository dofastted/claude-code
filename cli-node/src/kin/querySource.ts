/** cli-hop jobs only. Real AgentTool sources (`agent:<type>`) stay on the stock path. */
export function isKinQuerySource(source: unknown): boolean {
  return source === 'agent:kin' || source === 'kin_native_messages'
}
