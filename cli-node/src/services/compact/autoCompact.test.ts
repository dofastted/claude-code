import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { getEffectiveContextWindowSize } from './autoCompact.ts'
import { runWithJobAutoCompactWindow } from '../../bootstrap/jobSession.ts'

function withCompactEnv(run: () => void) {
  const previousWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  const previousConfig = process.env.KERNEL_CONFIG
  const dir = mkdtempSync(join(tmpdir(), 'compact-window-'))
  process.env.KERNEL_CONFIG = join(dir, 'kernel.json')
  writeFileSync(process.env.KERNEL_CONFIG, '{}')
  try {
    run()
  } finally {
    if (previousWindow == null) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = previousWindow
    if (previousConfig == null) delete process.env.KERNEL_CONFIG
    else process.env.KERNEL_CONFIG = previousConfig
    rmSync(dir, { recursive: true, force: true })
  }
}

test('compact window follows the request model and a valid caller override replaces it', () => {
  withCompactEnv(() => {
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    expect(getEffectiveContextWindowSize('claude-opus-5-5')).toBe(980_000)
    expect(getEffectiveContextWindowSize('claude-sonnet-4-5')).toBe(180_000)

    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '1000000'
    expect(getEffectiveContextWindowSize('claude-sonnet-4-5')).toBe(980_000)

    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '50000'
    expect(getEffectiveContextWindowSize('claude-opus-5-5')).toBe(980_000)

    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    writeFileSync(process.env.KERNEL_CONFIG!, JSON.stringify({ auto_compact_window: 500_000 }))
    expect(getEffectiveContextWindowSize('claude-opus-5-5')).toBe(480_000)
  })
})

test('concurrent jobs keep their own compact windows', async () => {
  withCompactEnv(() => {
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    const first = runWithJobAutoCompactWindow(1_000_000, async () => {
      await Promise.resolve()
      return getEffectiveContextWindowSize('claude-sonnet-4-5')
    })
    const second = runWithJobAutoCompactWindow(200_000, async () => {
      await Promise.resolve()
      return getEffectiveContextWindowSize('claude-opus-5-5')
    })
    return Promise.all([first, second]).then(([left, right]) => {
      expect(left).toBe(980_000)
      expect(right).toBe(180_000)
    })
  })
})
