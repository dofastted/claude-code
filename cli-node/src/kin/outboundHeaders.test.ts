import { expect, test } from 'bun:test'
import { reportOutboundHeaders, withOutboundHeaders } from './outboundHeaders.js'

test('final headers keep byte length and SDK headers but redact credentials and unknown custom values', async () => {
  const snapshots: Record<string, string>[] = []
  const headers = new Headers({
    accept: 'application/json, text/event-stream',
    'content-length': '1234',
    'x-stainless-retry-count': '2',
    authorization: 'Bearer private',
    'proxy-authorization': 'Basic private',
    cookie: 'private',
    'x-api-key': 'private',
    'x-custom-access': 'private',
  })
  await withOutboundHeaders(
    async (snapshot) => {
      snapshots.push(snapshot)
    },
    () => reportOutboundHeaders(headers),
  )
  expect(snapshots).toHaveLength(1)
  expect(snapshots[0]!['content-length']).toBe('1234')
  expect(snapshots[0]!['x-stainless-retry-count']).toBe('2')
  for (const key of ['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'x-custom-access']) {
    expect(snapshots[0]![key]).toBe('***REDACTED***')
  }
  expect(headers.get('authorization')).toBe('Bearer private')
  expect(JSON.stringify(snapshots)).not.toContain('private')
})

test('concurrent jobs and successive SDK retries report to their own observer', async () => {
  const snapshots = [[], []] as string[][]
  await Promise.all(
    snapshots.map((items, index) =>
      withOutboundHeaders(
        async (headers) => {
          items.push(headers['content-length']!)
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, index ? 1 : 10))
          await reportOutboundHeaders(new Headers({ 'content-length': String(index) }))
          await reportOutboundHeaders(new Headers({ 'content-length': String(index + 10) }))
        },
      ),
    ),
  )
  expect(snapshots).toEqual([
    ['0', '10'],
    ['1', '11'],
  ])
  await reportOutboundHeaders(new Headers({ authorization: 'no-observer' }))
  expect(snapshots).toEqual([
    ['0', '10'],
    ['1', '11'],
  ])
})
