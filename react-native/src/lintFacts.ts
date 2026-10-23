/**
 * What motionLint.ts needs to know about a project that its files do not say: the installed
 * react-native-reanimated version (found up the tree, for monorepos that hoist it), and whether React
 * Compiler is on (babel-plugin-react-compiler in package.json, `experiments.reactCompiler` in Expo's
 * app config, or the plugin named in a Babel config). Read once per root; anything unreadable is unknown.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

export type LintFacts = { reanimated: string | null; reactCompiler: boolean }

const cache = new Map<string, LintFacts>()

export function readLintFacts(root: string): LintFacts {
  const dir = path.resolve(root)
  let facts = cache.get(dir)
  if (!facts) {
    facts = { reanimated: reanimatedVersion(dir), reactCompiler: usesReactCompiler(dir) }
    cache.set(dir, facts)
  }
  return facts
}

function read(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function json(file: string): Record<string, unknown> | null {
  const text = read(file)
  if (!text) return null
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

function reanimatedVersion(dir: string): string | null {
  for (let d = dir; ; d = path.dirname(d)) {
    const pkg = json(path.join(d, 'node_modules', 'react-native-reanimated', 'package.json'))
    if (typeof pkg?.version === 'string') return pkg.version
    if (path.dirname(d) === d) return null
  }
}

function usesReactCompiler(dir: string): boolean {
  const pkg = json(path.join(dir, 'package.json'))
  const deps = { ...(pkg?.dependencies as object | undefined), ...(pkg?.devDependencies as object | undefined) }
  if ('babel-plugin-react-compiler' in deps) return true
  const app = json(path.join(dir, 'app.json')) as { expo?: { experiments?: { reactCompiler?: unknown } } } | null
  if (app?.expo?.experiments?.reactCompiler === true) return true
  for (const name of ['app.config.ts', 'app.config.js', 'app.config.mjs', 'babel.config.js', 'babel.config.cjs', 'babel.config.mjs', '.babelrc', '.babelrc.js']) {
    const text = read(path.join(dir, name))
    if (text && /reactCompiler\s*:\s*true|babel-plugin-react-compiler|['"]react-compiler['"]/.test(text)) return true
  }
  return false
}
