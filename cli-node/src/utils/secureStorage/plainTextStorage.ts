import { chmodSync, existsSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../envUtils.js'
import { getErrnoCode } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import {
  jsonParse,
  jsonStringify,
  writeFileSync_DEPRECATED,
} from '../slowOperations.js'
import type { SecureStorage, SecureStorageData } from './types.js'

/**
 * Host refresher owns `credentials.json`. The official CLI name is
 * `.credentials.json`. Under CLAUDE_CODE_HOST_REFRESH those must be the
 * same grant: prefer the host file when it exists, and never unlink it.
 * A sibling `.credentials.json` with an older RT is what gets refreshed
 * twice and comes back revoked.
 */
export function credentialStorageFileName(): string {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_HOST_REFRESH)) return '.credentials.json'
  try {
    if (existsSync(join(getClaudeConfigHomeDir(), 'credentials.json'))) return 'credentials.json'
  } catch {
    // Fall through to the official name.
  }
  return '.credentials.json'
}

function getStoragePath(): { storageDir: string; storagePath: string } {
  const storageDir = getClaudeConfigHomeDir()
  return { storageDir, storagePath: join(storageDir, credentialStorageFileName()) }
}

export const plainTextStorage = {
  name: 'plaintext',
  read(): SecureStorageData | null {
    // sync IO: called from sync context (SecureStorage interface)
    const { storagePath } = getStoragePath()
    try {
      const data = getFsImplementation().readFileSync(storagePath, {
        encoding: 'utf8',
      })
      return jsonParse(data)
    } catch {
      return null
    }
  },
  async readAsync(): Promise<SecureStorageData | null> {
    const { storagePath } = getStoragePath()
    try {
      const data = await getFsImplementation().readFile(storagePath, {
        encoding: 'utf8',
      })
      return jsonParse(data)
    } catch {
      return null
    }
  },
  update(data: SecureStorageData): { success: boolean; warning?: string } {
    // sync IO: called from sync context (SecureStorage interface)
    try {
      const { storageDir, storagePath } = getStoragePath()
      try {
        getFsImplementation().mkdirSync(storageDir)
      } catch (e: unknown) {
        const code = getErrnoCode(e)
        if (code !== 'EEXIST') {
          throw e
        }
      }

      writeFileSync_DEPRECATED(storagePath, jsonStringify(data), {
        encoding: 'utf8',
        flush: false,
      })
      chmodSync(storagePath, 0o600)
      return {
        success: true,
        warning: 'Warning: Storing credentials in plaintext.',
      }
    } catch {
      return { success: false }
    }
  },
  delete(): boolean {
    // Host owns this file. Unlinking it, then saving a new grant beside it,
    // leaves the refresher holding the RT Anthropic already replaced.
    if (isEnvTruthy(process.env.CLAUDE_CODE_HOST_REFRESH)) return true
    const { storagePath } = getStoragePath()
    try {
      getFsImplementation().unlinkSync(storagePath)
      return true
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT') {
        return true
      }
      return false
    }
  },
} satisfies SecureStorage
