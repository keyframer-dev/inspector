/**
 * What the app is: its package manager (from the lockfile, walking up for monorepos), Expo and its
 * SDK, React Native, navigation, the Babel config, the entry the start code is imported from, and
 * whether git has uncommitted changes. Everything is read from disk; nothing is run but `git status`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Navigation, PackageManager, Project } from './types'

/** Not a React Native app: the message says why, and where one might be. */
export class NotReactNative extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotReactNative'
  }
}

type PackageJson = {
  name?: string
  version?: string
  main?: string
  type?: string
  workspaces?: string[] | { packages?: string[] }
  packageManager?: string
  babel?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

export function readJson<T = unknown>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

export function readPackageJson(dir: string): PackageJson | null {
  return readJson<PackageJson>(path.join(dir, 'package.json'))
}

/** Lockfiles in the order that wins when a folder has more than one. */
const LOCKFILES: Array<[string, PackageManager]> = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]

/** The package manager and the folder its lockfile is in, walking up from the app (a workspace keeps one at its root). */
export function findPackageManager(root: string): { pm: PackageManager; lockDir: string | null } {
  for (let dir = root; ; dir = path.dirname(dir)) {
    for (const [file, pm] of LOCKFILES) if (existsSync(path.join(dir, file))) return { pm, lockDir: dir }
    if (path.dirname(dir) === dir) break
  }
  // No lockfile yet: package.json's packageManager field, else npm.
  const field = readPackageJson(root)?.packageManager?.split('@')[0]
  const pm = (['bun', 'pnpm', 'yarn', 'npm'] as const).find((p) => p === field) ?? 'npm'
  return { pm, lockDir: null }
}

/** The workspace root above the app: a folder with a lockfile, `workspaces` or pnpm-workspace.yaml. */
function findMonorepoRoot(root: string, lockDir: string | null): string | null {
  if (lockDir && lockDir !== root) return lockDir
  for (let dir = path.dirname(root); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml')) || readPackageJson(dir)?.workspaces) return dir
  }
  return null
}

/** A package installed for the app: its node_modules, or a workspace's above it. */
export function installedPackage(root: string, name: string, stop: string | null): PackageJson | null {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const pkg = readJson<PackageJson>(path.join(dir, 'node_modules', name, 'package.json'))
    if (pkg) return pkg
    if (!stop || dir === stop || path.dirname(dir) === dir) return null
  }
}

export const BABEL_CONFIGS = ['babel.config.js', 'babel.config.cjs', 'babel.config.mjs', 'babel.config.json', '.babelrc', '.babelrc.js', '.babelrc.json']

const SOURCE_EXTS = ['.tsx', '.ts', '.jsx', '.js']

/** `base` with the first source extension that exists (`app/_layout` → app/_layout.tsx). */
export function withExtension(base: string): string | null {
  for (const ext of SOURCE_EXTS) if (existsSync(base + ext)) return base + ext
  return null
}

/** expo-router's app folder: `app/` or `src/app/`, when it has a root `_layout`. */
export function expoRouterLayout(root: string): string | null {
  return withExtension(path.join(root, 'app', '_layout')) ?? withExtension(path.join(root, 'src', 'app', '_layout'))
}

function findEntry(root: string, pkg: PackageJson, navigation: Navigation, expo: boolean): string | null {
  if (navigation === 'expo-router') return expoRouterLayout(root)
  const main = pkg.main
  // `expo/AppEntry` (and node_modules/expo/AppEntry.js) registers ./App itself.
  if (main && !/(^|\/)expo\/AppEntry(\.js)?$/.test(main) && !main.startsWith('expo-router/')) {
    const file = path.resolve(root, main)
    const hit = existsSync(file) && statSync(file).isFile() ? file : withExtension(file.replace(/\.(tsx?|jsx?)$/, ''))
    if (hit) return hit
  }
  if (!expo) {
    // Bare React Native: index.js registers App.
    const index = withExtension(path.join(root, 'index'))
    if (index) return index
  }
  return withExtension(path.join(root, 'App')) ?? withExtension(path.join(root, 'src', 'App'))
}

function gitStatus(root: string): { clean: boolean } | null {
  try {
    const r = spawnSync('git', ['status', '--porcelain', '--', '.'], { cwd: root, encoding: 'utf8', timeout: 5000 })
    if (r.status !== 0) return null
    return { clean: r.stdout.trim() === '' }
  } catch {
    return null
  }
}

/** React Native apps in the folders below `dir` (two levels), for the "run it from there" hint. */
export function findAppsBelow(dir: string): string[] {
  const found: string[] = []
  const visit = (d: string, depth: number) => {
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const e of entries) {
      if (e === 'node_modules' || e.startsWith('.')) continue
      const sub = path.join(d, e)
      try {
        if (!statSync(sub).isDirectory()) continue
      } catch {
        continue
      }
      const deps = allDeps(readPackageJson(sub))
      if (deps['react-native'] || deps.expo) found.push(path.relative(dir, sub))
      else if (depth < 2) visit(sub, depth + 1)
    }
  }
  visit(dir, 1)
  return found.sort()
}

function allDeps(pkg: PackageJson | null): Record<string, string> {
  return { ...(pkg?.devDependencies ?? {}), ...(pkg?.dependencies ?? {}) }
}

/** The app at `root`, or NotReactNative. */
export function detectProject(root: string): Project {
  root = path.resolve(root)
  const pkg = readPackageJson(root)
  if (!pkg) {
    const apps = existsSync(root) ? findAppsBelow(root) : []
    throw new NotReactNative(
      apps.length
        ? `There is no package.json in ${root}. Found a React Native app in ${apps.join(', ')}: run the wizard there, or pass --root ${apps[0]}.`
        : `There is no package.json in ${root}. Run the wizard in your React Native or Expo app's folder, or pass --root.`,
    )
  }
  const deps = allDeps(pkg)
  if (!deps['react-native'] && !deps.expo) {
    const apps = findAppsBelow(root)
    throw new NotReactNative(
      apps.length
        ? `${pkg.name ?? 'This folder'} is not a React Native app, but ${apps.join(', ')} ${apps.length === 1 ? 'is' : 'are'}: run the wizard there, or pass --root ${apps[0]}.`
        : `${pkg.name ?? 'This folder'} doesn't look like a React Native app: its package.json has neither react-native nor expo. The wizard sets up React Native and Expo apps; for iOS, Android and Flutter, see https://keyframer.dev/inspector/docs.`,
    )
  }
  const { pm, lockDir } = findPackageManager(root)
  const monorepoRoot = findMonorepoRoot(root, lockDir)
  const expo = deps.expo
    ? (() => {
        const v = installedPackage(root, 'expo', monorepoRoot)?.version
        const major = v ? Number.parseInt(v, 10) : Number.NaN
        return { sdk: Number.isFinite(major) ? major : null }
      })()
    : null
  const navigation: Navigation =
    deps['expo-router'] && expoRouterLayout(root) ? 'expo-router' : deps['@react-navigation/native'] ? 'react-navigation' : null
  const babelConfig = BABEL_CONFIGS.map((f) => path.join(root, f)).find((f) => existsSync(f)) ?? null
  const appJson = readJson<{ expo?: { name?: string }; name?: string; displayName?: string }>(path.join(root, 'app.json'))
  return {
    root,
    name: appJson?.expo?.name ?? appJson?.displayName ?? pkg.name ?? path.basename(root),
    pm,
    expo,
    reactNative: deps['react-native'] ?? null,
    navigation,
    deps,
    babelConfig,
    entry: findEntry(root, pkg, navigation, !!expo),
    monorepoRoot,
    git: gitStatus(root),
    typescript: existsSync(path.join(root, 'tsconfig.json')) || !!deps.typescript,
  }
}

/** One line for each thing found, for the wizard to show. */
export function describeProject(p: Project): string[] {
  const rel = (f: string | null) => (f ? path.relative(p.root, f) : null)
  const kind = p.expo ? `Expo${p.expo.sdk ? ` SDK ${p.expo.sdk}` : ''}` : `React Native${p.reactNative ? ` ${p.reactNative.replace(/^[\^~]/, '')}` : ''}`
  const nav = p.navigation === 'expo-router' ? 'expo-router' : p.navigation === 'react-navigation' ? 'React Navigation' : 'no navigation library'
  return [
    `${kind} app "${p.name}", ${p.typescript ? 'TypeScript' : 'JavaScript'}, ${nav}`,
    `Package manager: ${p.pm}${p.monorepoRoot ? ` (workspace at ${path.relative(p.root, p.monorepoRoot) || '.'})` : ''}`,
    `Babel config: ${rel(p.babelConfig) ?? 'none yet'}`,
    `Entry: ${rel(p.entry) ?? 'not found'}`,
  ]
}
