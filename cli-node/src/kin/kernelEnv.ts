/** Kernel sets `CLAUDE_CODE_<SUFFIX>`. Absent means this process is not a native slot host. */
export function kernelEnv(suffix: string): string | undefined {
  const value = process.env[`CLAUDE_CODE_${suffix}`]
  return value || undefined
}
