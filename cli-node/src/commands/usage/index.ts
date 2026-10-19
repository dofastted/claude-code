import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

export const usage = {
  type: 'local-jsx',
  name: 'usage',
  description: 'Show plan usage limits',
  availability: ['claude-ai'],
  isEnabled: () => !getIsNonInteractiveSession(),
  load: () => import('./usage.js'),
} satisfies Command

export const usageNonInteractive = {
  type: 'local',
  name: 'usage',
  supportsNonInteractive: true,
  description: 'Show plan usage limits',
  availability: ['claude-ai'],
  isEnabled: () => getIsNonInteractiveSession(),
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  load: () => import('./usage-noninteractive.js'),
} satisfies Command
