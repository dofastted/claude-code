/**
 * Linux ELF for vm2api share/wrap-cli/cli-node by default.
 * baseline: no AVX2/BMI2 (vm2api #120). Feature flags stay off unless FEATURE_* is set.
 * CLI_TARGET=bun-darwin-{x64,arm64} builds a Mach-O for Darwin; it needs an
 * explicit outfile so the default Linux product is never overwritten.
 * The 2.1.281 leak omits optional UI and cloud SDK files. Only those missing
 * specifiers become stubs. A real import of a stub throws at runtime.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const TARGETS = ['bun-linux-x64-baseline', 'bun-darwin-x64', 'bun-darwin-arm64'] as const
const target = (process.env.CLI_TARGET || TARGETS[0]) as (typeof TARGETS)[number]
if (!(TARGETS as readonly string[]).includes(target)) {
  console.error(`unsupported CLI_TARGET ${target}; expected one of ${TARGETS.join(', ')}`)
  process.exit(1)
}
if (target !== TARGETS[0] && !process.argv[2]) {
  console.error(`${target} requires an explicit outfile argument`)
  process.exit(1)
}
const outfile = process.argv[2] || 'dist/cli-node'
const stubbed: string[] = []

function relativeImportExists(importer: string, spec: string): boolean {
  const base = resolve(dirname(importer), spec)
  const candidates = [base]
  if (base.endsWith('.js')) {
    const stem = base.slice(0, -3)
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.jsx`, `${stem}.mjs`)
  }
  candidates.push(
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  )
  return candidates.some(path => existsSync(path))
}

function importedNames(importer: string, spec: string): string[] {
  let text = ''
  try {
    text = readFileSync(importer, 'utf8')
  } catch {
    return []
  }
  const names: string[] = []
  const pattern = /(?:import|export)\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g
  for (const match of text.matchAll(pattern)) {
    if (match[2] !== spec) continue
    for (const part of match[1].split(',')) {
      const cleaned = part.replace(/\/\*[\s\S]*?\*\//g, '').trim()
      if (!cleaned || cleaned.startsWith('type ')) continue
      const original = cleaned
        .split(/\s+as\s+/)[0]
        .replace(/^type\s+/, '')
        .trim()
      if (/^[A-Za-z_$][\w$]*$/.test(original) && !names.includes(original)) {
        names.push(original)
      }
    }
  }
  return names
}

const envFeatures = Object.keys(process.env)
  .filter(key => key.startsWith('FEATURE_'))
  .map(key => key.replace('FEATURE_', ''))

const result = await Bun.build({
  entrypoints: ['src/entrypoints/cli.tsx'],
  compile: {
    target,
    outfile,
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadTsconfig: false,
    autoloadPackageJson: true,
  },
  target: 'bun',
  splitting: false,
  sourcemap: 'none',
  define: {
    'MACRO.VERSION': JSON.stringify('2.1.303'),
    'MACRO.BUILD_TIME': JSON.stringify('2026-09-28T02:26:10Z'),
    'MACRO.PACKAGE_URL': JSON.stringify('@anthropic-ai/claude-code'),
    'MACRO.NATIVE_PACKAGE_URL': JSON.stringify(''),
    'MACRO.FEEDBACK_CHANNEL': JSON.stringify('https://github.com/anthropics/claude-code/issues'),
    'MACRO.ISSUES_EXPLAINER': JSON.stringify(
      'report the issue at https://github.com/anthropics/claude-code/issues',
    ),
    'MACRO.VERSION_CHANGELOG': JSON.stringify(''),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  features: envFeatures,
})

if (!result.success) {
  console.error('compile failed')
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.log(`compiled ${outfile} (${target})`)
console.log(`stubbed ${stubbed.length} missing modules`)
for (const line of stubbed) console.log(`  stub ${line}`)
