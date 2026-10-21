/**
 * The one file the wizard owns in the app (keyframer.ts, or .js): the Inspector's start in development
 * builds, over the transport for the chosen view, and Motion Vitals' start in every build, as the docs
 * write them. How it starts depends on navigation:
 *
 *   none   module level, imported once by the entry
 *   own    module level, with `export const navigationRef = createNavigationContainerRef()`, which the
 *          app's NavigationContainer takes as its ref (React Navigation without a ref)
 *   hook   `useKeyframer(navigationRef)`, called in the component that has the ref (expo-router's root
 *          layout, or the component around a NavigationContainer that has a ref already)
 *
 * The Inspector is `require`d inside `if (__DEV__)`: Metro folds __DEV__ before it collects
 * dependencies, so a release build has none of it.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { InspectorView, Product, Project } from '../types'
import type { Style } from './source'

export const MARKER = '@keyframerdev/wizard'
export const DEFAULT_RELAY = 'http://127.0.0.1:8790'

export type NavMode = 'none' | 'own' | 'hook'

export type StartFileInput = {
  project: Project
  /** What this file starts (a product started elsewhere by hand is left out). */
  products: Product[]
  view: InspectorView | null
  relay: string | null
  /** The editor's pairing code. */
  code: string | null
  api: string
  key: string | null
  nav: NavMode
  /** Who the hook is for, in its comment: "app/_layout.tsx", "App.tsx". */
  hookFor?: string
  typescript: boolean
  style: Style
}

/** Where version and build come from, in words, for the wizard to say. */
export function versionSource(project: Project): { kind: 'expo-constants' | 'device-info' | 'literal'; detail: string; version: string } {
  if (project.expo) return { kind: 'expo-constants', detail: 'expo-constants (app.json\'s version, and the build number of the binary)', version: '' }
  if (project.deps['react-native-device-info']) return { kind: 'device-info', detail: "react-native-device-info (the binary's version and build number)", version: '' }
  const version = readVersion(project) ?? '1.0.0'
  return {
    kind: 'literal',
    detail: `package.json's version (${version}), written in the file: keep it in step with your releases, or install react-native-device-info and run the wizard again`,
    version,
  }
}

function readVersion(project: Project): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(project.root, 'package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}

export function renderStartFile(input: StartFileInput): string {
  const { project, products, nav, typescript: ts, style } = input
  const q = (s: string) => `${style.quote}${s.replaceAll('\\', '\\\\').replaceAll(style.quote, `\\${style.quote}`)}${style.quote}`
  const i = style.indent
  const inspector = products.includes('inspector')
  const vitals = products.includes('vitals') && !!input.key
  const view = input.view ?? 'devtools'
  const ver = versionSource(project)
  const storage = !!project.deps['@react-native-async-storage/async-storage']

  const L: string[] = []
  // ── header ──
  L.push('/**')
  L.push(` * Keyframer, set up by ${MARKER}. Running the wizard again updates this file.`)
  if (inspector) {
    const where =
      view === 'devtools'
        ? "Expo's dev tools (press shift+m in Metro, then open @keyframerdev/inspector)"
        : view === 'desktop'
          ? 'the Keyframer Inspector desktop app'
          : "the Keyframer editor's Inspector panel"
    L.push(` * The Inspector runs in development builds only, shown in ${where}.`)
  }
  if (vitals) L.push(' * Motion Vitals reports slow frames and janky animations from every build: https://keyframer.dev/app/vitals')
  L.push(' * Docs: https://keyframer.dev/inspector/docs')
  L.push(' */')

  // ── imports ──
  const imports: string[] = []
  if (vitals) imports.push(`import { startVitals${ts && nav === 'hook' ? ', type NavigationRefLike' : ''} } from ${q('@keyframerdev/vitals')};`)
  if (nav === 'own') imports.push(`import { createNavigationContainerRef } from ${q('@react-navigation/native')};`)
  if (vitals && storage) imports.push(`import AsyncStorage from ${q('@react-native-async-storage/async-storage')};`)
  if (vitals && ver.kind === 'expo-constants') imports.push(`import Constants from ${q('expo-constants')};`)
  if (vitals && ver.kind === 'device-info') imports.push(`import DeviceInfo from ${q('react-native-device-info')};`)
  if (nav === 'hook') imports.push(`import { useEffect } from ${q('react')};`)
  if (vitals && ver.kind === 'expo-constants') imports.push(`import { Platform } from ${q('react-native')};`)
  if (imports.length) L.push(...imports)

  if (nav === 'own') {
    L.push('')
    L.push('/** On your NavigationContainer (ref={navigationRef}): screens are named from its routes. */')
    L.push(`export const navigationRef = createNavigationContainerRef();`)
  }

  // ── the Inspector ──
  if (inspector) {
    L.push('')
    L.push('// The Inspector, in development only: `require` inside `if (__DEV__)` keeps it out of release builds.')
    L.push('if (__DEV__) {')
    const app = q(project.name)
    if (view === 'devtools') {
      L.push(`${i}const { connectDevTools } = require(${q('@keyframerdev/inspector/devtools')});`)
    } else {
      L.push(`${i}const { connectInspector } = require(${q('@keyframerdev/inspector/native')});`)
    }
    if (nav === 'own') L.push(`${i}const { trackNavigation } = require(${q('@keyframerdev/inspector/record')});`)
    if (view === 'devtools') L.push(`${i}connectDevTools({ app: ${app} });`)
    else if (view === 'desktop') {
      L.push(`${i}// The desktop app's relay. On a phone, use the Mac's LAN address the app shows in its status bar.`)
      L.push(`${i}// On an Android emulator, run \`adb reverse tcp:8790 tcp:8790\` first.`)
      L.push(`${i}connectInspector({ apiUrl: ${q(input.relay ?? DEFAULT_RELAY)}, code: ${q('DESKTOP')}, app: ${app} });`)
    } else {
      L.push(`${i}// The pairing code the editor's Inspector panel shows (a new code there means a new one here).`)
      L.push(`${i}connectInspector({ apiUrl: ${q(input.api)}, code: ${q(input.code ?? '')}, app: ${app} });`)
    }
    if (nav === 'own') {
      L.push(`${i}// Screen changes become markers in a recording, from the container's first state.`)
      L.push(`${i}let tracking = false;`)
      L.push(`${i}navigationRef.addListener(${q('state')}, () => {`)
      L.push(`${i}${i}if (tracking) return;`)
      L.push(`${i}${i}tracking = true;`)
      L.push(`${i}${i}trackNavigation(navigationRef);`)
      L.push(`${i}});`)
    }
    L.push('}')
  }

  // ── Motion Vitals ──
  const options = (ind: string, ref: boolean) => {
    const o: string[] = []
    o.push(`${ind}key: VITALS_KEY,`)
    if (ver.kind === 'expo-constants') {
      o.push(`${ind}appVersion: Constants.expoConfig?.version ?? ${q('0')},`)
      o.push(`${ind}build: build == null ? undefined : String(build),`)
    } else if (ver.kind === 'device-info') {
      o.push(`${ind}appVersion: DeviceInfo.getVersion(),`)
      o.push(`${ind}build: DeviceInfo.getBuildNumber(),`)
    } else {
      o.push(`${ind}appVersion: ${q(ver.version)}, // package.json's version: keep it in step with your releases`)
    }
    if (ref) o.push(`${ind}navigationRef,`)
    if (storage) o.push(`${ind}storage: AsyncStorage, // checkpoints, retries and the daily cap survive restarts`)
    return o
  }
  if (vitals) {
    L.push('')
    L.push('// The project\'s field key. It is public and write-only (it can only send reports to this project),')
    L.push('// so it is safe to ship in the app, like the docs show.')
    L.push(`const VITALS_KEY = ${q(input.key!)};`)
    if (ver.kind === 'expo-constants') {
      L.push(`const build = Platform.OS === ${q('ios')} ? Constants.platform?.ios?.buildNumber : Constants.expoConfig?.android?.versionCode;`)
    }
    if (nav !== 'hook') {
      L.push('')
      L.push('startVitals({')
      L.push(...options(i, nav === 'own'))
      L.push('});')
    }
  }

  // ── the hook ──
  if (nav === 'hook') {
    L.push('')
    L.push(`/** Call once in ${input.hookFor ?? 'your root component'}, with the navigation container's ref: screens are named from its routes. */`)
    const param = ts ? (vitals ? 'navigationRef: NavigationRefLike' : 'navigationRef: object') : 'navigationRef'
    L.push(`export function useKeyframer(${param}) {`)
    if (vitals) {
      L.push(`${i}useEffect(() => {`)
      L.push(`${i}${i}startVitals({`)
      L.push(...options(`${i}${i}${i}`, true))
      L.push(`${i}${i}});`)
      L.push(`${i}}, [navigationRef]);`)
    }
    if (inspector) {
      L.push(`${i}useEffect(() => {`)
      L.push(`${i}${i}// Screen changes become markers in an Inspector recording.`)
      L.push(`${i}${i}if (__DEV__) return require(${q('@keyframerdev/inspector/record')}).trackNavigation(navigationRef);`)
      L.push(`${i}}, [navigationRef]);`)
    }
    L.push('}')
  }
  L.push('')
  // Statements end in `;` above, and braces have spaces inside: the app's own style may differ.
  const code = L.map((l) => {
    if (/^\s*(\/\/|\/\*\*| \*)/.test(l)) return l
    let out = style.semi ? l : l.replace(/;$/, '')
    if (style.braces === '') out = out.replace(/\{ (?=\S)/g, '{').replace(/(?<=\S) \}/g, '}')
    return out
  })
  return code.join('\n')
}

/** Whether `code` is the wizard's file (it says so in its first lines). */
export function isWizardFile(code: string): boolean {
  return code.slice(0, 400).includes(MARKER)
}
