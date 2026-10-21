/**
 * Each codemod on small apps written for the case: the Babel config in its many shapes, navigation
 * (React Navigation's containers and refs, expo-router's layout), the entry import and VitalsRoot.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectProject } from '../detect'
import { makePlan } from '../plan'
import { writeApp } from '../testFixtures'
import type { Product } from '../types'
import { docsConfig, insertIntoList, planBabel } from './babel'
import { detectStyle, parses, parseSource, relativeImport, Splicer } from './source'
import type { StartChoices } from './start'

const KEY = 'kfp_live_A1b2C3d4E5f6G7h8I9j0K1l2'
const expoPkg = (extra: object = {}) => JSON.stringify({ name: 'a', main: 'index.ts', dependencies: { expo: '~57.0.0', 'react-native': '0.86.2', 'react-native-reanimated': '4.5.1', 'react-native-worklets': '0.10.1', 'expo-constants': '1', ...extra } })
const barePkg = (extra: object = {}) => JSON.stringify({ name: 'a', version: '1.4.0', dependencies: { 'react-native': '0.86.2', 'react-native-reanimated': '4.5.1', 'react-native-worklets': '0.10.1', ...extra } })

function babel(files: Record<string, string>, products: Product[]) {
  const dir = writeApp(files)
  return planBabel(detectProject(dir), products)
}

function after(plan: ReturnType<typeof babel>): string {
  if (plan.kind !== 'edit' && plan.kind !== 'create') throw new Error(`expected an edit, got ${plan.kind}: ${'reason' in plan ? plan.reason : ''}`)
  expect(parses(plan.after) || plan.file.endsWith('.json') || plan.file.endsWith('.babelrc')).toBe(true)
  return plan.after
}

/** Plans the whole app; `changes` by path relative to the app. */
function plan(files: Record<string, string>, choices: Partial<StartChoices> = {}) {
  const dir = writeApp({ 'tsconfig.json': '{}', ...files })
  const project = detectProject(dir)
  const p = makePlan(project, { products: ['inspector', 'vitals'], view: 'devtools', relay: null, code: null, api: 'https://api.keyframer.dev', key: KEY, vitalsRoot: false, ...choices })
  const changes = Object.fromEntries(p.changes.map((c) => [path.relative(dir, c.file), c.after]))
  for (const [f, text] of Object.entries(changes)) if (/\.(tsx?|jsx?)$/.test(f)) expect(parses(text), f).toBe(true)
  return { dir, project, plan: p, changes, manual: p.manual.map((m) => `${m.title}: ${m.reason}`).join('\n') }
}

describe('Babel', () => {
  it('a new config is the docs one, for every kind of app and product', () => {
    expect(docsConfig(true, { inspector: true, vitals: false })).toContain("plugins: dev ? ['@keyframerdev/inspector/babel'] : [],")
    expect(docsConfig(true, { inspector: true, vitals: true })).toContain("plugins: [...(dev ? ['@keyframerdev/inspector/babel'] : []), '@keyframerdev/vitals/babel'],")
    expect(docsConfig(true, { inspector: false, vitals: true })).toContain("api.cache(true)\n  return {\n    presets: ['babel-preset-expo'],\n    plugins: ['@keyframerdev/vitals/babel'],")
    expect(docsConfig(false, { inspector: true, vitals: false })).toContain("const dev = api.env('development')")
    expect(docsConfig(false, { inspector: true, vitals: false })).toContain("plugins: [...(dev ? ['@keyframerdev/inspector/babel'] : []), 'react-native-worklets/plugin'],")
    expect(docsConfig(false, { inspector: false, vitals: true })).toBe("module.exports = {\n  presets: ['module:@react-native/babel-preset'],\n  plugins: ['@keyframerdev/vitals/babel', 'react-native-worklets/plugin'],\n}\n")
  })

  it('"type": "module" gets babel.config.cjs', () => {
    const p = babel({ 'package.json': JSON.stringify({ name: 'a', type: 'module', dependencies: { expo: '1' } }) }, ['inspector'])
    expect(p.kind === 'create' && path.basename(p.file)).toBe('babel.config.cjs')
  })

  it("Expo's function config: plugins after presets, a dev flag, and a cache that follows NODE_ENV", () => {
    const code = "module.exports = function (api) {\n  api.cache(true);\n  return {\n    presets: ['babel-preset-expo'],\n  };\n};\n"
    const out = after(babel({ 'package.json': expoPkg(), 'babel.config.js': code }, ['inspector']))
    expect(out).toBe(
      "module.exports = function (api) {\n  api.cache.using(() => process.env.NODE_ENV);\n  const dev = process.env.NODE_ENV !== 'production';\n  return {\n    presets: ['babel-preset-expo'],\n    plugins: dev ? ['@keyframerdev/inspector/babel'] : [],\n  };\n};\n",
    )
  })

  it('the docs inspector-only config, then Vitals: the conditional goes inside an array, beside the Vitals plugin', () => {
    const out = after(babel({ 'package.json': expoPkg(), 'babel.config.js': docsConfig(true, { inspector: true, vitals: false }) }, ['inspector', 'vitals']))
    expect(out).toBe(docsConfig(true, { inspector: true, vitals: true }))
  })

  it('a worklets plugin with options, an existing dev flag of its own name, double quotes, tabs', () => {
    const code = 'module.exports = function (api) {\n\tapi.cache.using(() => process.env.NODE_ENV)\n\tconst isDev = process.env.NODE_ENV !== "production"\n\treturn {\n\t\tpresets: ["babel-preset-expo"],\n\t\tplugins: [\n\t\t\t"expo-router/babel",\n\t\t\t["react-native-worklets/plugin", { relativeSourceLocation: true }],\n\t\t],\n\t}\n}\n'
    const out = after(babel({ 'package.json': expoPkg(), 'babel.config.js': code }, ['inspector', 'vitals']))
    expect(out).toContain('\t\t\t"expo-router/babel",\n\t\t\t...(isDev ? ["@keyframerdev/inspector/babel"] : []),\n\t\t\t"@keyframerdev/vitals/babel",\n\t\t\t["react-native-worklets/plugin"')
    expect(out).not.toContain('const dev')
  })

  it('ESM (babel.config.mjs, export default function)', () => {
    const code = "export default function (api) {\n  api.cache(true)\n  return { presets: ['babel-preset-expo'], plugins: [] }\n}\n"
    const out = after(babel({ 'package.json': expoPkg(), 'babel.config.mjs': code }, ['vitals']))
    expect(out).toBe("export default function (api) {\n  api.cache(true)\n  return { presets: ['babel-preset-expo'], plugins: ['@keyframerdev/vitals/babel'] }\n}\n")
  })

  it('bare React Native: an object config becomes a function; the worklets plugin is added last when missing', () => {
    const out = after(babel({ 'package.json': barePkg(), 'babel.config.js': "module.exports = {\n  presets: ['module:@react-native/babel-preset'],\n};\n" }, ['inspector']))
    expect(out).toBe(
      "module.exports = function (api) {\n  const dev = api.env('development');\n  return {\n    presets: ['module:@react-native/babel-preset'],\n    plugins: [...(dev ? ['@keyframerdev/inspector/babel'] : []), 'react-native-worklets/plugin'],\n  };\n};\n",
    )
    // Vitals alone needs no dev flag: the object stays an object.
    const v = after(babel({ 'package.json': barePkg(), 'babel.config.js': "module.exports = {\n  presets: ['module:@react-native/babel-preset'],\n  plugins: ['react-native-worklets/plugin'],\n};\n" }, ['vitals']))
    expect(v).toBe("module.exports = {\n  presets: ['module:@react-native/babel-preset'],\n  plugins: ['@keyframerdev/vitals/babel', 'react-native-worklets/plugin'],\n};\n")
  })

  it('in place already: nothing to do; the wrong order is said, not fixed', () => {
    const ok = babel({ 'package.json': expoPkg(), 'babel.config.js': docsConfig(true, { inspector: true, vitals: true }) }, ['inspector', 'vitals'])
    expect(ok.kind).toBe('ok')
    const wrong = babel({ 'package.json': barePkg(), 'babel.config.js': "module.exports = { presets: ['module:@react-native/babel-preset'], plugins: ['react-native-worklets/plugin', '@keyframerdev/vitals/babel'] }\n" }, ['vitals'])
    expect(wrong.kind).toBe('ok')
    expect(wrong.notes.join('\n')).toContain('the worklets plugin should stay last')
  })

  it("leaves alone what it can't edit safely, with the docs' config to paste", () => {
    const branches = "module.exports = function (api) {\n  api.cache(true)\n  if (process.env.STORYBOOK) return { presets: ['babel-preset-expo'] }\n  return { presets: ['babel-preset-expo'], plugins: [] }\n}\n"
    const a = babel({ 'package.json': expoPkg(), 'babel.config.js': branches }, ['inspector'])
    expect(a.kind).toBe('manual')
    expect(a.kind === 'manual' && a.reason).toContain('more than one way to return')
    expect(a.kind === 'manual' && a.snippet).toBe(docsConfig(true, { inspector: true, vitals: false }))
    const built = babel({ 'package.json': expoPkg(), 'babel.config.js': "const plugins = []\nmodule.exports = function (api) {\n  api.cache(true)\n  return { presets: ['babel-preset-expo'], plugins }\n}\n" }, ['vitals'])
    expect(built.kind === 'manual' && built.reason).toContain('Its plugins come from a variable.')
    const dev = babel({ 'package.json': expoPkg(), 'babel.config.js': "module.exports = function (api) {\n  api.cache(true)\n  const dev = require('./env').dev\n  return { presets: ['babel-preset-expo'] }\n}\n" }, ['inspector'])
    expect(dev.kind === 'manual' && dev.reason).toContain('`dev`')
    const broken = babel({ 'package.json': expoPkg(), 'babel.config.js': 'module.exports = {' }, ['vitals'])
    expect(broken.kind === 'manual' && broken.reason).toContain("doesn't parse")
  })

  it('JSON: Vitals before the worklets plugin, the Inspector under env.development; comments or bare React Native: by hand', () => {
    const json = JSON.stringify({ presets: ['babel-preset-expo'], plugins: ['expo-router/babel'] }, null, 2) + '\n'
    const out = after(babel({ 'package.json': expoPkg(), 'babel.config.json': json }, ['inspector', 'vitals']))
    expect(JSON.parse(out)).toEqual({ presets: ['babel-preset-expo'], plugins: ['expo-router/babel', '@keyframerdev/vitals/babel'], env: { development: { plugins: ['@keyframerdev/inspector/babel'] } } })
    const comments = babel({ 'package.json': expoPkg(), '.babelrc': '{\n  // the preset\n  "presets": ["babel-preset-expo"]\n}\n' }, ['vitals'])
    expect(comments.kind === 'manual' && comments.reason).toContain("isn't plain JSON")
    const bare = babel({ 'package.json': barePkg(), 'babel.config.json': '{ "presets": ["module:@react-native/babel-preset"], "plugins": ["react-native-worklets/plugin"] }' }, ['inspector'])
    expect(bare.kind).toBe('manual')
    const vitalsOnly = after(babel({ 'package.json': barePkg(), 'babel.config.json': '{ "presets": ["module:@react-native/babel-preset"], "plugins": ["react-native-worklets/plugin"] }' }, ['vitals']))
    expect(JSON.parse(vitalsOnly).plugins).toEqual(['@keyframerdev/vitals/babel', 'react-native-worklets/plugin'])
  })

  it('the package.json "babel" key: by hand', () => {
    const p = babel({ 'package.json': JSON.stringify({ name: 'a', dependencies: { expo: '1' }, babel: { presets: ['babel-preset-expo'] } }) }, ['inspector'])
    expect(p.kind === 'manual' && p.reason).toContain('"babel" key in package.json')
  })
})

describe('source helpers', () => {
  it('detects semicolons, quotes, indentation and brace spacing', () => {
    const a = "import {a} from 'x';\nfunction f() {\n    return 1;\n}\n"
    expect(detectStyle(a, parseSource(a))).toEqual({ semi: true, quote: "'", indent: '    ', braces: '' })
    const b = 'import { a } from "x"\nconst y = "z"\n'
    expect(detectStyle(b, parseSource(b))).toEqual({ semi: false, quote: '"', indent: '  ', braces: ' ' })
  })

  it('inserts into single-line and multi-line lists in their own layout', () => {
    const code = "[\n  'a',\n  'b',\n]"
    const ast = parseSource(code)
    const arr = (ast.program.body[0] as unknown as { expression: { start: number; end: number; elements: never[] } }).expression
    const sp = new Splicer(code)
    insertIntoList(sp, code, { start: arr.start, end: arr.end, items: arr.elements }, 1, ['X'])
    expect(sp.apply()).toBe("[\n  'a',\n  X,\n  'b',\n]")
    const one = "['a']"
    const a1 = (parseSource(one).program.body[0] as unknown as { expression: { start: number; end: number; elements: never[] } }).expression
    const sp1 = new Splicer(one)
    insertIntoList(sp1, one, { start: a1.start, end: a1.end, items: a1.elements }, 1, ['X', 'Y'])
    expect(sp1.apply()).toBe("['a', X, Y]")
  })

  it('offsets match the text with indentation tabs and CRLF line ends (recast parses a normalised copy)', () => {
    const code = 'module.exports = {\r\n\t\tpresets: ["babel-preset-expo"],\r\n\t\tplugins: [],\r\n}\r\n'
    const ast = parseSource(code)
    const arr = (ast.program.body[0] as unknown as { expression: { right: { properties: Array<{ value: { start: number; end: number } }> } } }).expression.right.properties[1]!.value
    expect(code.slice(arr.start, arr.end)).toBe('[]')
    const out = after(babel({ 'package.json': expoPkg(), 'babel.config.js': code }, ['vitals']))
    expect(out).toBe('module.exports = {\r\n\t\tpresets: ["babel-preset-expo"],\r\n\t\tplugins: ["@keyframerdev/vitals/babel"],\r\n}\r\n')
  })

  it('a wrap keeps the edits inside it', () => {
    const sp = new Splicer('<A><B /></A>')
    sp.insert(2, ' ref={r}')
    sp.wrap(0, 12, (t) => `<V>${t}</V>`)
    sp.insert(0, '(')
    sp.insert(12, ')')
    expect(sp.apply()).toBe('(<V><A ref={r}><B /></A></V>)')
  })

  it('relative imports without extensions', () => {
    expect(relativeImport('/a/app/_layout.tsx', '/a/keyframer.ts')).toBe('../keyframer')
    expect(relativeImport('/a/index.js', '/a/src/keyframer.ts')).toBe('./src/keyframer')
    expect(relativeImport('/a/src/App.tsx', '/a/src/keyframer.ts')).toBe('./keyframer')
  })
})

describe('React Navigation', () => {
  const app = (body: string) => ({ 'package.json': barePkg({ '@react-navigation/native': '7' }), 'babel.config.js': "module.exports = { presets: ['module:@react-native/babel-preset'], plugins: ['react-native-worklets/plugin'] }\n", 'index.js': "import App from './App'\n", 'App.tsx': body })

  it('an aliased import and a one-line container: the ref goes after its name', () => {
    const r = plan(app("import { NavigationContainer as Nav } from '@react-navigation/native'\n\nexport default function App() {\n  return <Nav theme={t}><Root /></Nav>\n}\n"))
    expect(r.changes['App.tsx']).toContain('<Nav ref={navigationRef} theme={t}>')
    expect(r.changes['App.tsx']).toContain("import { navigationRef } from './keyframer'")
    expect(r.changes['index.js']).toBeUndefined()
  })

  it('an arrow component with an expression body works for a new ref (no hook needed)', () => {
    const r = plan(app("import { NavigationContainer } from '@react-navigation/native'\n\nconst App = () => (\n  <NavigationContainer>\n    <Root />\n  </NavigationContainer>\n)\nexport default App\n"))
    expect(r.changes['App.tsx']).toContain('<NavigationContainer ref={navigationRef}>')
    expect(r.changes['keyframer.ts']).toContain('export const navigationRef = createNavigationContainerRef()')
  })

  it("React Navigation 7's static API: the ref goes on createStaticNavigation's component", () => {
    const r = plan(app("import { createStaticNavigation } from '@react-navigation/native'\nimport { RootStack } from './stack'\n\nconst Navigation = createStaticNavigation(RootStack)\n\nexport default function App() {\n  return <Navigation />\n}\n"))
    expect(r.changes['App.tsx']).toContain('return <Navigation ref={navigationRef} />')
  })

  it('a ref made in the component with useNavigationContainerRef: the hook goes after it', () => {
    const r = plan(app("import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native'\n\nexport default function App() {\n  const nav = useNavigationContainerRef()\n  return (\n    <NavigationContainer ref={nav}>\n      <Root />\n    </NavigationContainer>\n  )\n}\n"))
    expect(r.changes['App.tsx']).toContain('  const nav = useNavigationContainerRef()\n  useKeyframer(nav)\n  return (')
    expect(r.changes['keyframer.ts']).toContain('export function useKeyframer(navigationRef: NavigationRefLike)')
  })

  it('a plain React ref, props spread, a wrapper of its own: by hand, with where', () => {
    const useRef = plan(app("import { NavigationContainer } from '@react-navigation/native'\nimport { useRef } from 'react'\n\nexport default function App() {\n  const ref = useRef(null)\n  return <NavigationContainer ref={ref}><Root /></NavigationContainer>\n}\n"))
    expect(useRef.manual).toContain('takes ref from useRef(), a plain React ref')
    expect(useRef.changes['App.tsx']).toBeUndefined()
    // Not hooked, so the entry imports the wizard's file: the Inspector still starts.
    expect(useRef.changes['index.js']).toContain("import './keyframer'")
    const spread = plan(app("import { NavigationContainer } from '@react-navigation/native'\n\nexport default function App(props: object) {\n  return <NavigationContainer {...props}><Root /></NavigationContainer>\n}\n"))
    expect(spread.manual).toContain('spreads its props')
    const wrapper = plan(app("import { AppNavigationContainer } from './nav'\n\nexport default function App() {\n  return <AppNavigationContainer><Root /></AppNavigationContainer>\n}\n"))
    expect(wrapper.manual).toContain('behind a component of your own (App.tsx)')
  })

  it('no container found: the snippet, and the entry import', () => {
    const r = plan(app('export default function App() {\n  return null\n}\n'))
    expect(r.manual).toContain("couldn't find your <NavigationContainer>")
    expect(r.changes['index.js']).toBe("import App from './App'\nimport './keyframer'\n")
  })
})

describe('expo-router', () => {
  const app = (layout: string, extra: Record<string, string> = {}) => ({
    'package.json': JSON.stringify({ name: 'a', main: 'expo-router/entry', dependencies: { expo: '1', 'expo-router': '1', 'expo-constants': '1', 'react-native': '0.86.2', 'react-native-reanimated': '4.5.1', 'react-native-worklets': '0.10.1' } }),
    'babel.config.js': "module.exports = function (api) {\n  api.cache(true)\n  return { presets: ['babel-preset-expo'] }\n}\n",
    'app/_layout.tsx': layout,
    ...extra,
  })

  it('reuses a ref the layout makes already', () => {
    const r = plan(app("import { Stack, useNavigationContainerRef } from 'expo-router'\n\nexport default function Layout() {\n  const navigation = useNavigationContainerRef()\n  return <Stack />\n}\n"))
    expect(r.changes['app/_layout.tsx']).toBe(
      "import { Stack, useNavigationContainerRef } from 'expo-router'\nimport { useKeyframer } from '../keyframer'\n\nexport default function Layout() {\n  const navigation = useNavigationContainerRef()\n  useKeyframer(navigation)\n  return <Stack />\n}\n",
    )
  })

  it('a layout declared then exported, without an expo-router import yet', () => {
    const r = plan(app("import { Slot } from 'expo-router/build/views/Navigator'\n\nfunction Root() {\n  return <Slot />\n}\n\nexport default Root\n"))
    expect(r.changes['app/_layout.tsx']).toContain("import { useNavigationContainerRef } from 'expo-router'")
    expect(r.changes['app/_layout.tsx']).toContain('function Root() {\n  const navigationRef = useNavigationContainerRef()\n  useKeyframer(navigationRef)\n\n  return <Slot />')
  })

  it('src/app: the file goes in src/', () => {
    const files = app('')
    delete (files as Record<string, string>)['app/_layout.tsx']
    const r = plan({ ...files, 'src/app/_layout.tsx': "import { Stack } from 'expo-router'\nexport default function L() {\n  return <Stack />\n}\n" })
    expect(Object.keys(r.changes).sort()).toEqual(['babel.config.js', 'src/app/_layout.tsx', 'src/keyframer.ts'])
    expect(r.changes['src/app/_layout.tsx']).toContain("import { useKeyframer } from '../keyframer'")
  })

  it('an arrow layout returning JSX, or a navigationRef of its own: by hand', () => {
    const arrow = plan(app("import { Stack } from 'expo-router'\nexport default () => <Stack />\n"))
    expect(arrow.manual).toContain('arrow function returning JSX directly')
    const named = plan(app("import { Stack } from 'expo-router'\nconst navigationRef = 1\nexport default function L() {\n  return <Stack />\n}\n"))
    expect(named.manual).toContain('already has something called navigationRef')
  })

  it('VitalsRoot: wraps the one JSX return; several returns of JSX: by hand', () => {
    const one = plan(app("import { Stack } from 'expo-router'\nexport default function L() {\n  return (\n    <Stack>\n      <Stack.Screen name=\"index\" />\n    </Stack>\n  )\n}\n"), { vitalsRoot: true })
    expect(one.changes['app/_layout.tsx']).toContain('  return (\n    <VitalsRoot>\n      <Stack>\n        <Stack.Screen name="index" />\n      </Stack>\n    </VitalsRoot>\n  )')
    expect(one.changes['app/_layout.tsx']).toContain("import { VitalsRoot } from '@keyframerdev/vitals'")
    const two = plan(app("import { Stack, Slot } from 'expo-router'\nexport default function L({ a }: { a: boolean }) {\n  if (a) return <Slot />\n  return <Stack />\n}\n"), { vitalsRoot: true })
    expect(two.manual).toContain('returns more than one thing')
  })
})

describe('the start code', () => {
  it("a keyframer.ts of the app's own is left alone: the wizard's is keyframer.setup.ts", () => {
    const r = plan({ 'package.json': barePkg(), 'babel.config.js': "module.exports = { presets: ['module:@react-native/babel-preset'], plugins: ['react-native-worklets/plugin'] }\n", 'index.js': "import './App'\n", 'App.tsx': 'export default function App() { return null }\n', 'keyframer.ts': 'export const brand = 1\n' }, { products: ['vitals'] })
    expect(Object.keys(r.changes)).toContain('keyframer.setup.ts')
    expect(r.changes['index.js']).toBe("import './App'\nimport './keyframer.setup'\n")
    expect(readFileSync(path.join(r.dir, 'keyframer.ts'), 'utf8')).toBe('export const brand = 1\n')
  })

  it('Vitals without a key starts nothing and adds no plugin', () => {
    const r = plan({ 'package.json': barePkg(), 'babel.config.js': "module.exports = { presets: ['module:@react-native/babel-preset'], plugins: ['react-native-worklets/plugin'] }\n", 'index.js': '', 'App.tsx': '' }, { products: ['vitals'], key: null })
    expect(r.changes).toEqual({})
  })

  it('Reanimated 3 is a warning, not an upgrade', () => {
    const r = plan({ 'package.json': barePkg({ 'react-native-reanimated': '~3.17.0' }), 'babel.config.js': "module.exports = { presets: ['module:@react-native/babel-preset'], plugins: ['react-native-reanimated/plugin'] }\n", 'index.js': '', 'App.tsx': '' }, { products: ['inspector'] })
    expect(r.plan.warnings.join('\n')).toContain('Keyframer needs Reanimated 4')
    expect(r.plan.installs.flatMap((i) => i.packages)).toEqual(['@keyframerdev/inspector'])
    // The reanimated plugin counts as the worklets plugin: the Inspector's goes before it.
    expect(r.changes['babel.config.js']).toContain("[...(dev ? ['@keyframerdev/inspector/babel'] : []), 'react-native-reanimated/plugin']")
  })

  it('edits only the lines that change: a re-plan of an applied plan changes nothing', () => {
    const r = plan({ 'package.json': barePkg({ '@react-navigation/native': '7' }), 'babel.config.js': "module.exports = { presets: ['module:@react-native/babel-preset'], plugins: ['react-native-worklets/plugin'] }\n", 'index.js': "import App from './App'\n", 'App.tsx': "import { NavigationContainer } from '@react-navigation/native'\nexport default function App() {\n  return <NavigationContainer><Root /></NavigationContainer>\n}\n" }, { vitalsRoot: true })
    for (const c of r.plan.changes) writeFileSync(c.file, c.after)
    const again = makePlan(detectProject(r.dir), { products: ['inspector', 'vitals'], view: 'devtools', relay: null, code: null, api: 'https://api.keyframer.dev', key: KEY, vitalsRoot: true })
    expect(again.changes).toEqual([])
    expect(again.manual).toEqual([])
  })
})
