import { expect, test } from 'bun:test'
import { getAttributionHeader } from './system.ts'

test('billing always carries a CCH placeholder regardless of provider gates', () => {
  const previous = process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
  process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '1'
  try {
    expect(getAttributionHeader('abc')).toContain('cch=00000;')
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
    else process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = previous
  }
})

const PROJECT = 'claude_proj_01' + '1'.repeat(22)

test('303 billing keeps field order and drops empty fragments', () => {
  const previous = process.env.CLAUDE_CODE_ENTRYPOINT
  process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli'
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.CLAUDE_CODE_USE_GATEWAY
  try {
    const header = getAttributionHeader('958', {
      includeSubscriberFields: true,
      isSubagent: false,
      promptId: '299380de-c314-463b-87ee-d69283720312',
      turnOrigin: 'sdk',
      promptIndex: 0,
      turnIndex: 1,
      gateway: '1',
      projectId: PROJECT,
      projectSource: 'harness',
    })
    const fields = [...header.matchAll(/\bcc_[a-z_]+/g)].map((match) => match[0].trim())
    expect(fields).toEqual([
      'cc_version',
      'cc_entrypoint',
      'cc_prompt_id',
      'cc_turn_origin',
      'cc_prompt_index',
      'cc_turn_index',
      'cc_gateway',
      'cc_project',
      'cc_project_src',
    ])
    expect(header).toContain('cc_version=2.1.303.958;')
    expect(header).toContain('cc_entrypoint=sdk-cli;')
    expect(header).toContain('cch=00000;')
    expect(header).not.toContain('cc_is_subagent')
    expect(header).not.toContain('cc_workload')
    expect(header).toContain(`cc_project=${PROJECT}; cc_project_src=harness;`)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT
    else process.env.CLAUDE_CODE_ENTRYPOINT = previous
  }
})

test('303 billing omits gateway and project when excluded', () => {
  delete process.env.ANTHROPIC_BASE_URL
  const header = getAttributionHeader('958', {
    includeSubscriberFields: true,
    gateway: 'env',
    hostVerdict: 'vouched',
    projectId: 'not-a-project',
    projectSource: 'harness',
  })
  expect(header).not.toContain('cc_gateway')
  expect(header).not.toContain('cc_project')
})

test('303 billing rejects inherited project source names', () => {
  delete process.env.ANTHROPIC_BASE_URL
  for (const projectSource of ['constructor', 'toString']) {
    const header = getAttributionHeader('958', {
      includeSubscriberFields: true,
      projectId: PROJECT,
      projectSource,
    })
    expect(header).not.toContain('cc_project')
    expect(header).not.toContain('cc_project_src')
  }
})

test('303 billing opt-out drops the whole line', () => {
  const previous = process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
  process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = 'off'
  try {
    expect(getAttributionHeader('958', { includeSubscriberFields: true })).toBe('')
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
    else process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = previous
  }
})
