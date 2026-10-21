import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeProject, detectProject, findPackageManager, NotReactNative } from './detect'
import { copyFixture, writeApp } from './testFixtures'

const pkg = (o: object) => JSON.stringify(o)

describe('detectProject', () => {
  it('expo-router: the tabs template, its SDK from node_modules, npm, no babel config', () => {
    const dir = copyFixture('expo-router', { expoSdk: 57 })
    const p = detectProject(dir)
    expect(p).toMatchObject({ name: 'Tabs App', pm: 'npm', expo: { sdk: 57 }, reactNative: '0.86.2', navigation: 'expo-router', babelConfig: null, monorepoRoot: null, git: null, typescript: true })
    expect(p.entry).toBe(path.join(dir, 'app/_layout.tsx'))
    expect(describeProject(p)).toEqual(['Expo SDK 57 app "Tabs App", TypeScript, expo-router', 'Package manager: npm', 'Babel config: none yet', 'Entry: app/_layout.tsx'])
  })

  it('Expo without the router: the entry is package.json main, or App.tsx behind expo/AppEntry', () => {
    expect(detectProject(copyFixture('expo-blank')).entry).toMatch(/index\.ts$/)
    const w = detectProject(copyFixture('expo-worklets-plugin'))
    expect(w.entry).toMatch(/App\.tsx$/)
    expect(w.pm).toBe('yarn')
    expect(w.expo).toEqual({ sdk: null })
  })

  it('bare React Native: index.js; React Navigation; JavaScript; the babel file', () => {
    const b = detectProject(copyFixture('bare'))
    expect(b).toMatchObject({ expo: null, navigation: null, pm: 'npm' })
    expect(b.entry).toMatch(/index\.js$/)
    expect(b.babelConfig).toMatch(/babel\.config\.js$/)
    expect(detectProject(copyFixture('react-navigation')).navigation).toBe('react-navigation')
    const js = detectProject(copyFixture('javascript'))
    expect(js.typescript).toBe(false)
    expect(js.entry).toMatch(/index\.js$/)
  })

  it('expo-router in the dependencies but no app/_layout is not expo-router', () => {
    const dir = writeApp({ 'package.json': pkg({ name: 'a', dependencies: { expo: '1', 'expo-router': '1', '@react-navigation/native': '7' } }), 'App.tsx': 'export default function App() { return null }' })
    expect(detectProject(dir).navigation).toBe('react-navigation')
    const src = writeApp({ 'package.json': pkg({ name: 'a', main: 'expo-router/entry', dependencies: { expo: '1', 'expo-router': '1' } }), 'src/app/_layout.tsx': 'export default function L() { return null }' })
    const p = detectProject(src)
    expect(p.navigation).toBe('expo-router')
    expect(p.entry).toBe(path.join(src, 'src/app/_layout.tsx'))
  })

  it('a monorepo: pnpm from the workspace root, which is monorepoRoot', () => {
    const dir = copyFixture('monorepo')
    const p = detectProject(path.join(dir, 'apps/mobile'))
    expect(p.pm).toBe('pnpm')
    expect(p.monorepoRoot).toBe(dir)
    expect(describeProject(p)[1]).toBe('Package manager: pnpm (workspace at ../..)')
  })

  it('every babel config name, and .babelrc', () => {
    for (const f of ['babel.config.cjs', 'babel.config.mjs', 'babel.config.json', '.babelrc']) {
      const dir = writeApp({ 'package.json': pkg({ name: 'a', dependencies: { 'react-native': '0.86.0' } }), [f]: '{}' })
      expect(path.basename(detectProject(dir).babelConfig!)).toBe(f)
    }
  })

  it('lockfiles: bun wins over the others in one folder; packageManager when there is none', () => {
    const dir = writeApp({ 'package.json': pkg({ name: 'a', packageManager: 'pnpm@9.0.0' }) })
    expect(findPackageManager(dir).pm).toBe('pnpm')
    writeFileSync(path.join(dir, 'yarn.lock'), '')
    writeFileSync(path.join(dir, 'bun.lockb'), '')
    expect(findPackageManager(dir)).toEqual({ pm: 'bun', lockDir: dir })
  })

  it('git: clean, dirty, or outside a repository', () => {
    expect(detectProject(copyFixture('bare', { git: 'clean' })).git).toEqual({ clean: true })
    expect(detectProject(copyFixture('bare', { git: 'dirty' })).git).toEqual({ clean: false })
  })

  it('refuses a folder that is not a React Native app, pointing at one below it', () => {
    expect(() => detectProject(copyFixture('not-rn'))).toThrow(NotReactNative)
    expect(() => detectProject(copyFixture('not-rn'))).toThrow(/api-server doesn't look like a React Native app/)
    const dir = writeApp({ 'README.md': 'hi' })
    mkdirSync(path.join(dir, 'mobile'))
    writeFileSync(path.join(dir, 'mobile/package.json'), pkg({ name: 'm', dependencies: { expo: '1' } }))
    expect(() => detectProject(dir)).toThrow(/There is no package.json in .*Found a React Native app in mobile: run the wizard there, or pass --root mobile\./)
  })
})
