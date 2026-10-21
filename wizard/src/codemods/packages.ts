/**
 * What to install: `@keyframerdev/inspector` (a dev dependency: it only runs in development) and
 * `@keyframerdev/vitals` (a dependency: it ships in release builds), and what they need that the app
 * doesn't have. Expo apps install through `npx expo install` (versions that match the SDK), others
 * through their package manager, from the app's folder.
 *
 * Both packages are JavaScript only: no native module, no config plugin, no rebuild. What they need
 * may not be (Reanimated, worklets), and the wizard says so.
 */
import type { PackageManager, Product, Project } from '../types'

export type Install = {
  packages: string[]
  dev: boolean
  /** argv, run in the app's folder. */
  command: string[]
}

export type PackagePlan = { installs: Install[]; notes: string[]; warnings: string[]; native: string[] }

/** Native modules among what the wizard may install. */
const NATIVE = new Set(['react-native-reanimated', 'react-native-worklets', 'expo-constants'])

function major(range: string | undefined): number | null {
  const m = range?.match(/(\d+)/)
  return m ? Number(m[1]) : null
}

export function planPackages(project: Project, products: Product[], extra: { babelPresetExpo: boolean; expoConstants: boolean }): PackagePlan {
  const d = project.deps
  const deps: string[] = []
  const devDeps: string[] = []
  const notes: string[] = []
  const warnings: string[] = []
  if (products.includes('inspector') && !d['@keyframerdev/inspector']) devDeps.push('@keyframerdev/inspector')
  if (products.includes('vitals') && !d['@keyframerdev/vitals']) deps.push('@keyframerdev/vitals')

  // Both need Reanimated 4 with react-native-worklets.
  const rea = major(d['react-native-reanimated'])
  if (!d['react-native-reanimated']) {
    deps.push('react-native-reanimated')
    if (!d['react-native-worklets']) deps.push('react-native-worklets')
    notes.push('Reanimated 4 and react-native-worklets: Keyframer measures the animations they run.')
  } else if (rea !== null && rea < 4) {
    warnings.push(
      `This app has Reanimated ${d['react-native-reanimated']}, and Keyframer needs Reanimated 4 with react-native-worklets. Upgrade first: https://docs.swmansion.com/react-native-reanimated/docs/guides/migration-from-3.x`,
    )
  } else if (!d['react-native-worklets']) {
    deps.push('react-native-worklets')
    notes.push('react-native-worklets: Reanimated 4 needs it beside it.')
  }
  if (project.expo?.sdk != null && project.expo.sdk < 54) warnings.push(`Expo SDK ${project.expo.sdk} comes with Reanimated 3: Keyframer needs Reanimated 4 (Expo SDK 54 or later).`)
  if (extra.babelPresetExpo && !d['babel-preset-expo']) devDeps.push('babel-preset-expo')
  if (extra.expoConstants && !d['expo-constants']) {
    deps.push('expo-constants')
    notes.push("expo-constants: Motion Vitals reads the app's version and build from it.")
  }

  const installs: Install[] = []
  if (deps.length) installs.push({ packages: deps, dev: false, command: installCommand(project, deps, false) })
  if (devDeps.length) installs.push({ packages: devDeps, dev: true, command: installCommand(project, devDeps, true) })
  const native = [...deps, ...devDeps].filter((p) => NATIVE.has(p))
  return { installs, notes, warnings, native }
}

const DEV_FLAG: Record<PackageManager, string> = { npm: '--save-dev', pnpm: '--save-dev', yarn: '--dev', bun: '--dev' }

export function installCommand(project: Project, packages: string[], dev: boolean): string[] {
  if (project.expo) return ['npx', 'expo', 'install', ...packages, ...(dev ? ['--', DEV_FLAG[project.pm]] : [])]
  const add: Record<PackageManager, string[]> = { npm: ['npm', 'install'], pnpm: ['pnpm', 'add'], yarn: ['yarn', 'add'], bun: ['bun', 'add'] }
  return [...add[project.pm], ...(dev ? [DEV_FLAG[project.pm]] : []), ...packages]
}

/** What to do after installing native modules, or null when nothing is needed. */
export function rebuildAdvice(project: Project, native: string[]): string | null {
  if (!native.length) return null
  const list = native.join(', ')
  if (project.expo) {
    if (project.deps['expo-dev-client']) return `${list} ${native.length === 1 ? 'is a native module' : 'are native modules'}: rebuild your development build (npx expo run:ios, npx expo run:android, or eas build). Expo Go has them already.`
    return `${list} ${native.length === 1 ? 'is a native module' : 'are native modules'} that Expo Go has already. In a development build, rebuild it (npx expo run:ios or run:android).`
  }
  return `${list} ${native.length === 1 ? 'is a native module' : 'are native modules'}: run \`cd ios && pod install\`, then rebuild the app (Android rebuilds on its next run).`
}

/** A command as a person would type it. */
export function shellLine(argv: string[]): string {
  return argv.map((a) => (/^[\w@./:=+-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`)).join(' ')
}
