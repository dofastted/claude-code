import { expect, test } from 'bun:test'
import type { ToolPermissionContext } from '../../Tool.js'
import { parsePermissionModeCli } from './PermissionMode.js'
import {
  PROACTIVITY_ASK_UNAVAILABLE_NOTIFICATION,
  isProactivitySelectorAvailable,
  isRemoteThinClientSession,
  mapProactivityLevelToPermissionMode,
  permissionModeSuppliedOnInvocation,
  selectProactivityPermissionMode,
} from './proactivityPermissionMode.js'

const SELECTOR_ENV = [
  'CLAUDE_CODE_DISABLE_PROACTIVITY',
  'CLAUDE_CODE_DISABLE_ATTACHMENTS',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_RELAUNCH_PROACTIVITY_LEVEL',
  'CLAUDE_CODE_RELAUNCH_PROACTIVITY_EVER_ON',
  'CLAUDE_CODE_RELAUNCH_PROACTIVITY_DECIDED',
] as const

function withEnv(
  env: Record<string, string | undefined>,
  run: () => void,
): void {
  const prev = Object.fromEntries(SELECTOR_ENV.map(k => [k, process.env[k]]))
  for (const k of SELECTOR_ENV) {
    if (!(k in env)) continue
    if (env[k] === undefined) delete process.env[k]
    else process.env[k] = env[k]
  }
  try {
    run()
  } finally {
    for (const k of SELECTOR_ENV) {
      if (prev[k] == null) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

function ctx(
  partial: Partial<ToolPermissionContext> = {},
): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...partial,
  }
}

function select(
  partial: Parameters<typeof selectProactivityPermissionMode>[0],
) {
  return selectProactivityPermissionMode({
    context: ctx(),
    ...partial,
  })
}

test('parsePermissionModeCli accepts auto even when it cannot be entered', () => {
  expect(parsePermissionModeCli('auto')).toBe('auto')
  expect(parsePermissionModeCli('manual')).toBe('manual')
  expect(parsePermissionModeCli('default')).toBe('default')
  expect(() => parsePermissionModeCli('not-a-mode')).toThrow(/Allowed choices/)
})

test('cle: ask/default/proactive map from real capabilities', () => {
  const none = {
    isAutoModeAvailable: false,
    isBypassPermissionsModeAvailable: false,
  }
  const autoOnly = {
    isAutoModeAvailable: true,
    isBypassPermissionsModeAvailable: false,
  }
  const both = {
    isAutoModeAvailable: true,
    isBypassPermissionsModeAvailable: true,
  }
  const bypassOnly = {
    isAutoModeAvailable: false,
    isBypassPermissionsModeAvailable: true,
  }

  expect(mapProactivityLevelToPermissionMode('ask', none)).toBe('default')
  expect(mapProactivityLevelToPermissionMode('ask', autoOnly)).toBe('auto')

  expect(mapProactivityLevelToPermissionMode('default', autoOnly)).toBe('auto')
  expect(
    mapProactivityLevelToPermissionMode('default', none, 'acceptEdits'),
  ).toBe('acceptEdits')
  expect(mapProactivityLevelToPermissionMode('default', none, 'auto')).toBe(
    'default',
  )
  expect(
    mapProactivityLevelToPermissionMode(
      'default',
      none,
      'bypassPermissions',
    ),
  ).toBe('default')
  expect(
    mapProactivityLevelToPermissionMode(
      'default',
      bypassOnly,
      'bypassPermissions',
    ),
  ).toBe('bypassPermissions')

  expect(mapProactivityLevelToPermissionMode('proactive', both)).toBe(
    'bypassPermissions',
  )
  expect(mapProactivityLevelToPermissionMode('proactive', autoOnly)).toBe(
    'auto',
  )
  expect(mapProactivityLevelToPermissionMode('proactive', none)).toBe(
    'acceptEdits',
  )
  expect(mapProactivityLevelToPermissionMode('proactive', bypassOnly)).toBe(
    'bypassPermissions',
  )
})

test('restricted/unavailable bypass cannot map proactive to bypass', () => {
  expect(
    mapProactivityLevelToPermissionMode('proactive', {
      isAutoModeAvailable: false,
      isBypassPermissionsModeAvailable: false,
    }),
  ).toBe('acceptEdits')
})

test('explicit permission/inherit/skip/agent win; settings baseline does not', () => {
  expect(
    permissionModeSuppliedOnInvocation({ permissionModeCli: 'plan' }),
  ).toBe(true)
  expect(
    permissionModeSuppliedOnInvocation({
      inheritPermissionModeCli: 'acceptEdits',
    }),
  ).toBe(true)
  expect(
    permissionModeSuppliedOnInvocation({ dangerouslySkipPermissions: true }),
  ).toBe(true)
  expect(
    permissionModeSuppliedOnInvocation({ agentPermissionMode: 'dontAsk' }),
  ).toBe(true)
  expect(permissionModeSuppliedOnInvocation({})).toBe(false)
})

test('selector-on ask/proactive remap; default level does not', () => {
  withEnv(
    {
      CLAUDE_CODE_DISABLE_PROACTIVITY: undefined,
      CLAUDE_CODE_DISABLE_ATTACHMENTS: undefined,
      CLAUDE_CODE_SIMPLE: undefined,
      CLAUDE_CODE_RELAUNCH_PROACTIVITY_LEVEL: undefined,
    },
    () => {
      expect(isProactivitySelectorAvailable()).toBe(true)

      const ask = select({
        context: ctx({ isAutoModeAvailable: true }),
        cliProactivityLevel: 'ask',
      })
      expect(ask.mode).toBe('auto')
      expect(ask.decidedByProactivityLevel).toBe(true)
      expect(ask.notification).toBeUndefined()

      const proactive = select({
        context: ctx({
          isAutoModeAvailable: true,
          isBypassPermissionsModeAvailable: true,
        }),
        cliProactivityLevel: 'proactive',
      })
      expect(proactive.mode).toBe('bypassPermissions')
      expect(proactive.decidedByProactivityLevel).toBe(true)

      const def = select({
        context: ctx({ isAutoModeAvailable: true, mode: 'plan' }),
        cliProactivityLevel: 'default',
      })
      expect(def.mode).toBe('plan')
      expect(def.decidedByProactivityLevel).toBe(false)
    },
  )
})

test('explicit modes retain precedence over proactivity remap', () => {
  withEnv(
    {
      CLAUDE_CODE_DISABLE_PROACTIVITY: undefined,
      CLAUDE_CODE_DISABLE_ATTACHMENTS: undefined,
      CLAUDE_CODE_SIMPLE: undefined,
      CLAUDE_CODE_RELAUNCH_PROACTIVITY_LEVEL: undefined,
    },
    () => {
      const explicit = select({
        context: ctx({
          mode: 'plan',
          isAutoModeAvailable: true,
          isBypassPermissionsModeAvailable: true,
        }),
        cliProactivityLevel: 'proactive',
        permissionModeCli: 'plan',
      })
      expect(explicit.mode).toBe('plan')
      expect(explicit.decidedByProactivityLevel).toBe(false)
      expect(explicit.modeSuppliedOnInvocation).toBe(true)

      const inherited = select({
        context: ctx({
          mode: 'acceptEdits',
          isAutoModeAvailable: true,
        }),
        cliProactivityLevel: 'ask',
        inheritPermissionModeCli: 'acceptEdits',
      })
      expect(inherited.mode).toBe('acceptEdits')
      expect(inherited.decidedByProactivityLevel).toBe(false)

      const skip = select({
        context: ctx({
          mode: 'bypassPermissions',
          isBypassPermissionsModeAvailable: true,
        }),
        cliProactivityLevel: 'ask',
        dangerouslySkipPermissions: true,
      })
      expect(skip.mode).toBe('bypassPermissions')
      expect(skip.decidedByProactivityLevel).toBe(false)
    },
  )
})

test('settings baseline does not block non-default proactivity remap', () => {
  withEnv(
    {
      CLAUDE_CODE_DISABLE_PROACTIVITY: undefined,
      CLAUDE_CODE_DISABLE_ATTACHMENTS: undefined,
      CLAUDE_CODE_SIMPLE: undefined,
      CLAUDE_CODE_RELAUNCH_PROACTIVITY_LEVEL: undefined,
    },
    () => {
      const fromSettings = select({
        context: ctx({
          mode: 'plan',
          isAutoModeAvailable: true,
        }),
        cliProactivityLevel: 'ask',
      })
      expect(fromSettings.mode).toBe('auto')
      expect(fromSettings.decidedByProactivityLevel).toBe(true)
    },
  )
})

test('restricted ctx cannot enable bypass via proactive', () => {
  withEnv(
    {
      CLAUDE_CODE_DISABLE_PROACTIVITY: undefined,
      CLAUDE_CODE_DISABLE_ATTACHMENTS: undefined,
      CLAUDE_CODE_SIMPLE: undefined,
      CLAUDE_CODE_RELAUNCH_PROACTIVITY_LEVEL: undefined,
    },
    () => {
      const restricted = select({
        context: ctx({
          restricted: true,
          isBypassPermissionsModeAvailable: false,
          isAutoModeAvailable: false,
        }),
        cliProactivityLevel: 'proactive',
      })
      expect(restricted.mode).toBe('acceptEdits')
      expect(restricted.decidedByProactivityLevel).toBe(true)
    },
  )
})

test('ask with selector off notifies and stays manual; proactive does not remap', () => {
  withEnv(
    {
      CLAUDE_CODE_DISABLE_PROACTIVITY: '1',
      CLAUDE_CODE_RELAUNCH_PROACTIVITY_LEVEL: undefined,
    },
    () => {
      expect(isProactivitySelectorAvailable()).toBe(false)

      const ask = select({
        context: ctx({ isAutoModeAvailable: true }),
        cliProactivityLevel: 'ask',
      })
      expect(ask.mode).toBe('default')
      expect(ask.decidedByProactivityLevel).toBe(false)
      expect(ask.notification).toBe(PROACTIVITY_ASK_UNAVAILABLE_NOTIFICATION)

      const askExplicit = select({
        context: ctx({ mode: 'plan' }),
        cliProactivityLevel: 'ask',
        permissionModeCli: 'plan',
      })
      expect(askExplicit.notification).toBeUndefined()
      expect(askExplicit.mode).toBe('plan')

      const proactive = select({
        context: ctx({
          isAutoModeAvailable: true,
          isBypassPermissionsModeAvailable: true,
        }),
        cliProactivityLevel: 'proactive',
      })
      expect(proactive.mode).toBe('default')
      expect(proactive.decidedByProactivityLevel).toBe(false)
      expect(proactive.notification).toBeUndefined()
    },
  )
})

test('attachments off and remote thin client drop the selector level', () => {
  withEnv(
    {
      CLAUDE_CODE_DISABLE_PROACTIVITY: undefined,
      CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
      CLAUDE_CODE_RELAUNCH_PROACTIVITY_LEVEL: undefined,
    },
    () => {
      expect(isProactivitySelectorAvailable()).toBe(false)
      const dropped = select({
        context: ctx({ isAutoModeAvailable: true }),
        cliProactivityLevel: 'proactive',
      })
      expect(dropped.decidedByProactivityLevel).toBe(false)
      expect(dropped.mode).toBe('default')
    },
  )

  withEnv(
    {
      CLAUDE_CODE_DISABLE_PROACTIVITY: undefined,
      CLAUDE_CODE_DISABLE_ATTACHMENTS: undefined,
      CLAUDE_CODE_SIMPLE: undefined,
      CLAUDE_CODE_RELAUNCH_PROACTIVITY_LEVEL: undefined,
    },
    () => {
      const thin = select({
        context: ctx({
          isAutoModeAvailable: true,
          isBypassPermissionsModeAvailable: true,
        }),
        cliProactivityLevel: 'proactive',
        startsAsRemoteThinClient: true,
      })
      expect(thin.decidedByProactivityLevel).toBe(false)
      expect(thin.mode).toBe('default')
    },
  )
})

test('isRemoteThinClientSession matches official zGo', () => {
  expect(
    isRemoteThinClientSession({
      isNonInteractiveSession: true,
      headlessCloud: true,
    }),
  ).toBe(true)
  expect(
    isRemoteThinClientSession({
      isNonInteractiveSession: true,
      headlessCloud: false,
    }),
  ).toBe(false)
  expect(
    isRemoteThinClientSession({
      isNonInteractiveSession: false,
      isContinue: true,
      remote: { id: 'x' },
    }),
  ).toBe(false)
  expect(
    isRemoteThinClientSession({
      isNonInteractiveSession: false,
      pendingSSHHost: 'box',
    }),
  ).toBe(true)
})
