import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { microcompactMessages } from '../services/compact/microCompact.ts'

test('KERNEL_CONFIG controls cached microcompact before the request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dynamic-clean-'))
  const path = join(dir, 'kernel.json')
  const previous = process.env.KERNEL_CONFIG
  process.env.KERNEL_CONFIG = path
  try {
    writeFileSync(path, JSON.stringify({ cached_microcompact_enabled: true }))
    await expect(microcompactMessages([])).rejects.toThrow('cached_microcompact_unavailable:')
    writeFileSync(path, JSON.stringify({ cached_microcompact_enabled: false }))
    await expect(microcompactMessages([])).resolves.toEqual({ messages: [] })
  } finally {
    if (previous == null) delete process.env.KERNEL_CONFIG
    else process.env.KERNEL_CONFIG = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
