import { expect, test } from 'bun:test'
import { getSessionId } from '../bootstrap/state.ts'
import { runWithJobSession } from '../bootstrap/jobSession.ts'
import { asSessionId } from '../types/ids.ts'
import { sessionIdFromRequest } from './nativeMessagesRunner.ts'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

test('sessionIdFromRequest reads metadata.user_id JSON', () => {
  const id = sessionIdFromRequest({
    metadata: {
      user_id: JSON.stringify({ device_id: 'dev', account_uuid: 'acc', session_id: A }),
    },
  })
  expect(id).toBe(A)
})

test('sessionIdFromRequest reads an object user_id', () => {
  expect(sessionIdFromRequest({ metadata: { user_id: { session_id: `  ${B}  ` } } })).toBe(B)
  expect(sessionIdFromRequest({})).toBeUndefined()
  expect(sessionIdFromRequest({ metadata: { user_id: 'not-json' } })).toBeUndefined()
})

test('concurrent jobs keep their own session for getSessionId', async () => {
  const seen = await Promise.all([
    runWithJobSession(asSessionId(A), async () => {
      await Promise.resolve()
      return getSessionId()
    }),
    runWithJobSession(asSessionId(B), async () => {
      await Promise.resolve()
      return getSessionId()
    }),
  ])
  expect(seen).toEqual([A, B])
})
