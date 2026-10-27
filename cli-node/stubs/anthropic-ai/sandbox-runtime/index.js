// Build stand-in for @anthropic-ai/sandbox-runtime, which the 2.1.x source does
// not ship. Slots never sandbox Bash: the platform reports unsupported, so
// SandboxManager.isSandboxingEnabled() is false and nothing is wrapped.
// The adapter forwards these statics unbound, and the REPL, Bash tool, HTTP
// hooks and /sandbox UI call several of them without checking enablement
// first, so every method it references must exist (vm2api #768).

const UNAVAILABLE = 'sandbox runtime is not bundled in this build'

export class SandboxViolationStore {
  subscribe(_listener) {
    return () => {}
  }
  getViolations() {
    return []
  }
  getTotalCount() {
    return 0
  }
  addViolation() {}
}

const violations = new SandboxViolationStore()

export class SandboxManager {
  static isSupportedPlatform() {
    return false
  }
  static checkDependencies() {
    return { errors: [UNAVAILABLE], warnings: [] }
  }
  static async initialize() {
    throw new Error(UNAVAILABLE)
  }
  static async wrapWithSandbox() {
    throw new Error(UNAVAILABLE)
  }
  static updateConfig() {}
  static async reset() {}
  static getFsReadConfig() {
    return { denyOnly: [], allowWithinDeny: [] }
  }
  static getFsWriteConfig() {
    return { allowOnly: [], denyWithinAllow: [] }
  }
  static getNetworkRestrictionConfig() {
    return {}
  }
  static getIgnoreViolations() {
    return undefined
  }
  static getAllowUnixSockets() {
    return undefined
  }
  static getAllowLocalBinding() {
    return undefined
  }
  static getEnableWeakerNestedSandbox() {
    return undefined
  }
  static getProxyPort() {
    return undefined
  }
  static getSocksProxyPort() {
    return undefined
  }
  static getLinuxHttpSocketPath() {
    return undefined
  }
  static getLinuxSocksSocketPath() {
    return undefined
  }
  static async waitForNetworkInitialization() {
    return false
  }
  static getSandboxViolationStore() {
    return violations
  }
  static annotateStderrWithSandboxFailures(_command, stderr) {
    return stderr
  }
  static cleanupAfterCommand() {}
}

export const SandboxRuntimeConfigSchema = {}
