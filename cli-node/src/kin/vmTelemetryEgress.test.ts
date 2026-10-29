import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { VmTelemetryEgress } from './vmTelemetryEgress.js'
import { telemetryHash, type VmTelemetryContext } from './vmTelemetryContext.js'

function context(home: string, binding = 'binding-a'): VmTelemetryContext {
  return {
    home,
    binding,
    kernel: { vm_id: 'vm-1' },
  } as VmTelemetryContext
}

function snapshot(binding: string, ip = '203.0.113.10') {
  return {
    vm_id: 'vm-1',
    binding,
    epoch: telemetryHash([binding, ip]),
    ip,
    timezone: 'Asia/Tokyo',
    checked_at: 1,
    error: null,
    country: 'JP',
  }
}

function writeSnapshot(home: string, value: unknown) {
  const file = join(home, 'telemetry', 'egress.json')
  mkdirSync(join(home, 'telemetry'), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
  return file
}

describe('published proxy geo', () => {
  test('uses a proxy publication and does not replace it with a probe stub', async () => {
    const home = mkdtempSync(join(tmpdir(), 'telemetry-egress-'))
    try {
      const published = snapshot('binding-a')
      const file = writeSnapshot(home, published)
      const egress = new VmTelemetryEgress(context(home))
      const loaded = await egress.ensure(context(home), new AbortController().signal)
      expect(loaded.ip).toBe(published.ip)
      expect(loaded.timezone).toBe('Asia/Tokyo')
      expect(JSON.parse(readFileSync(file, 'utf8')).error).toBe(null)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('replaces a failed stub when the proxy publication arrives', async () => {
    const home = mkdtempSync(join(tmpdir(), 'telemetry-egress-'))
    try {
      writeSnapshot(home, { vm_id: 'vm-1', binding: 'binding-a', error: 'telemetry_geo_failed', checked_at: 0 })
      const egress = new VmTelemetryEgress(context(home))
      await expect(egress.ensure(context(home), new AbortController().signal)).rejects.toThrow(
        'telemetry_egress_unpublished',
      )
      const published = snapshot('binding-a')
      writeSnapshot(home, published)
      const loaded = await egress.ensure(context(home), new AbortController().signal)
      expect(loaded.ip).toBe(published.ip)
      expect(loaded.country).toBe('JP')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
