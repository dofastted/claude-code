import { expect, test } from 'bun:test'
import { STDOUT_QUEUE_BYTES, stdoutQueueAccepts } from './stdioProtocol.ts'

const MIB = 1024 * 1024

test('a config item with an image is not capped at 2MiB', () => {
  expect(STDOUT_QUEUE_BYTES).toBe(64 * MIB)
  expect(stdoutQueueAccepts(0, 2 * MIB + 1)).toBe(true)
  expect(stdoutQueueAccepts(0, 64 * MIB)).toBe(true)
  expect(stdoutQueueAccepts(0, 64 * MIB + 1)).toBe(false)
  expect(stdoutQueueAccepts(63 * MIB, 2 * MIB)).toBe(false)
})
