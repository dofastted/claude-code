import { execa } from 'execa'
import {
  getMacOsKeychainStorageServiceName,
  usesMacOsKeychain,
} from 'src/utils/secureStorage/macOsKeychainHelpers.js'

export async function maybeRemoveApiKeyFromMacOSKeychainThrows(): Promise<void> {
  if (usesMacOsKeychain()) {
    const storageServiceName = getMacOsKeychainStorageServiceName()
    const result = await execa(
      `security delete-generic-password -a $USER -s "${storageServiceName}"`,
      { shell: true, reject: false },
    )
    if (result.exitCode !== 0) {
      throw new Error('Failed to delete keychain entry')
    }
  }
}

export function normalizeApiKeyForConfig(apiKey: string): string {
  return apiKey.slice(-20)
}
