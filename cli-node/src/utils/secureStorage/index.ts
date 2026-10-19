import { createFallbackStorage } from './fallbackStorage.js'
import { macOsKeychainStorage } from './macOsKeychainStorage.js'
import { usesMacOsKeychain } from './macOsKeychainHelpers.js'
import { plainTextStorage } from './plainTextStorage.js'
import type { SecureStorage } from './types.js'

/**
 * Get the appropriate secure storage implementation for the current platform
 */
export function getSecureStorage(): SecureStorage {
  if (usesMacOsKeychain()) {
    return createFallbackStorage(macOsKeychainStorage, plainTextStorage)
  }

  // TODO: add libsecret support for Linux

  return plainTextStorage
}
