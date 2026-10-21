/**
 * The whole wizard on each fixture app, through main() with a scripted Io: the account, Vitals key,
 * desktop app, agents and verify steps are fakes here (flowReal.test.ts runs the real ones). Each
 * fixture: the files it creates or changes (snapshotted), that they parse, that the wizard's file
 * typechecks against the real packages, and that a second run changes nothing.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from './cli'
import { parses } from './codemods/source'
import type { Run } from './exec'
import { loggedIo } from './fakes'
import { changedFiles, copyFixture, readTree } from './testFixtures'
import type { VerifyResult } from './types'

const KEY = 'kfp_live_A1b2C3d4E5f6G7h8I9j0K1l2'

vi.mock('./vitalsKey', async (orig) => ({
  ...(await orig<typeof import('./vitalsKey')>()),
  getVitalsKey: vi.fn(async ({ options }: { options: { vitalsKey: string | null } }) => ({ key: options.vitalsKey ?? KEY, projectId: 'p1', workspaceId: 'w1', token: null })),
}))
vi.mock('./account', () => ({ signIn: vi.fn(async () => 'token') }))
vi.mock('./desktop', () => ({ ensureDesktopApp: vi.fn(async () => ({ installed: true, relay: 'http://127.0.0.1:8790' })) }))
vi.mock('./agents', () => ({ setupAgents: vi.fn(async () => ['Claude Code: keyframer-inspector in .mcp.json']) }))
vi.mock('./verify', () => ({
  verifyInspector: vi.fn(async (): Promise<VerifyResult> => ({ ok: true, detail: 'Hello from the app on iOS 18.2, iPhone 16 Pro (simulator)' })),
  verifyVitals: vi.fn(async (): Promise<VerifyResult> => ({ ok: true, detail: 'The first session arrived at 12:00:07.' })),
}))

const verify = await import('./verify')
const agents = await import('./agents')
const desktop = await import('./desktop')

/** Installs recorded, none run: each adds its packages to package.json, as the real one would. */
function fakeRun() {
  const calls: string[] = []
  const run: Run = async (cmd, args, opts) => {
    const cwd = opts?.cwd ?? ''
    calls.push(`${path.basename(cwd)}$ ${[cmd, ...args].join(' ')}`)
    const file = path.join(cwd, 'package.json')
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, string>>
    const dev = args.includes('--dev') || args.includes('--save-dev')
    const names = args.filter((a) => !a.startsWith('-') && !['expo', 'install', 'add'].includes(a))
    const field = dev ? 'devDependencies' : 'dependencies'
    pkg[field] = { ...(pkg[field] ?? {}), ...Object.fromEntries(names.map((n) => [n, '*'])) }
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
    return { code: 0, stdout: `added ${names.length} packages`, stderr: '' }
  }
  return Object.assign(run, { calls })
}

type Run1 = { dir: string; code: number; log: string[]; changed: Record<string, string>; installs: string[] }

async function wizard(fixture: string, args: string[], opts: { answers?: Array<[string | RegExp, unknown]>; interactive?: boolean; dir?: string; sub?: string; expoSdk?: number; git?: 'clean' | 'dirty' } = {}): Promise<Run1> {
  const dir = opts.dir ?? copyFixture(fixture, { expoSdk: opts.expoSdk, git: opts.git })
  const root = opts.sub ? path.join(dir, opts.sub) : dir
  const io = loggedIo(opts.answers ?? [], { interactive: opts.interactive ?? false })
  const run = fakeRun()
  const code = await main([...args, '--root', root], { io, run, platform: 'darwin', print: (s) => io.log.push(`print: ${s}`) })
  return { dir, code, log: io.log, changed: changedFiles(fixture, dir, ''), installs: run.calls }
}

/** Runs it twice: the second run, with the same answers, must find everything in place. */
async function twice(fixture: string, args: string[], opts: Parameters<typeof wizard>[2] = {}) {
  const first = await wizard(fixture, args, opts)
  const tree = readTree(first.dir)
  const second = await wizard(fixture, args, { ...opts, dir: first.dir })
  expect(readTree(first.dir)).toEqual(tree)
  expect(second.installs).toEqual([])
  for (const [f, text] of Object.entries(first.changed)) {
    if (/\.(tsx?|jsx?|cjs|mjs)$/.test(f)) expect(parses(text), `${f} parses`).toBe(true)
    if (f.endsWith('.json')) expect(() => JSON.parse(text)).not.toThrow()
  }
  outputs.set(fixture, first.dir)
  return { first, second }
}

const outputs = new Map<string, string>()
const said = (r: Run1) => r.log.join('\n')
const yes = ['--yes', '--skip-verify', '--no-agents']

beforeEach(() => vi.clearAllMocks())

describe('expo-router (the tabs template)', () => {
  it('interactive: asks, shows the plan, writes, installs, offers agents, waits for the app', async () => {
    const { first, second } = await twice('expo-router', [], {
      interactive: true,
      expoSdk: 57,
      git: 'dirty',
      answers: [
        ['Continue anyway', true],
        ['What do you want to set up', ['inspector', 'vitals']],
        ['Where do you want to see the Inspector', 'devtools'],
        ['VitalsRoot', true],
      ],
    })
    expect(first.code).toBe(0)
    expect(first.changed).toMatchSnapshot()
    expect(first.installs).toEqual([expect.stringMatching(/\$ npx expo install @keyframerdev\/vitals$/), expect.stringMatching(/\$ npx expo install @keyframerdev\/inspector babel-preset-expo -- --save-dev$/)])
    expect(said(first)).toContain('Expo SDK 57 app "Tabs App", TypeScript, expo-router')
    expect(said(first)).toContain('Git has uncommitted changes here')
    expect(said(first)).toContain('Inspector: Hello from the app')
    expect(said(first)).toContain('Motion Vitals: The first session arrived')
    expect(vi.mocked(verify.verifyInspector).mock.calls[0]![0]).toMatchObject({ view: 'devtools', relay: null })
    expect(vi.mocked(agents.setupAgents).mock.calls[0]![0]).toMatchObject({ view: 'devtools' })
    // The second run: nothing to change or install, and it still checks the app.
    expect(said(second)).toContain('Everything is in place already')
    expect(second.installs).toEqual([])
    // A transcript, for reading the flow the way the person sees it.
    writeFileSync(path.join(first.dir, 'transcript.txt'), first.log.join('\n'))
    expect(first.log.filter((l) => l.startsWith('ask:'))).toMatchSnapshot('questions')
  })

  it('the wizard file sits at the root, never in app/ (where every file is a route)', () => {
    const dir = outputs.get('expo-router')!
    expect(existsSync(path.join(dir, 'keyframer.ts'))).toBe(true)
    expect(existsSync(path.join(dir, 'app/keyframer.ts'))).toBe(false)
  })
})

describe('Expo, blank (App.tsx, no babel config, no Reanimated)', () => {
  it("declining the new babel config: says what that costs, and doesn't install the preset it needed", async () => {
    const r = await wizard('expo-blank', ['--skip-verify', '--no-agents', '--products', 'inspector', '--view', 'devtools'], {
      interactive: true,
      answers: [['Create babel.config.js', false]],
    })
    expect(r.code).toBe(0)
    expect(existsSync(path.join(r.dir, 'babel.config.js'))).toBe(false)
    expect(said(r)).toContain("Without the Babel plugins in babel.config.js, the Inspector can't see your animations.")
    expect(said(r)).toContain('Not written (you said no): babel.config.js. Run the wizard again to see it.')
    expect(r.installs.join('\n')).not.toContain('babel-preset-expo')
    expect(r.installs.join('\n')).toContain('@keyframerdev/inspector')
  })

  it('creates the docs babel config, installs Reanimated, worklets, expo-constants and babel-preset-expo with bun', async () => {
    const { first, second } = await twice('expo-blank', [...yes, '--products', 'inspector,vitals', '--key', KEY])
    expect(first.code).toBe(0)
    expect(first.changed).toMatchSnapshot()
    expect(first.installs).toEqual([
      expect.stringMatching(/\$ npx expo install @keyframerdev\/vitals react-native-reanimated react-native-worklets expo-constants$/),
      expect.stringMatching(/\$ npx expo install @keyframerdev\/inspector babel-preset-expo -- --dev$/),
    ])
    expect(said(first)).toContain('Expo Go has already')
    expect(said(second)).toContain('Everything is in place already')
  })
})

describe('Expo with the worklets plugin in babel.config.js', () => {
  it('adds both plugins before it, follows NODE_ENV in the cache, uses AsyncStorage', async () => {
    const { first, second } = await twice('expo-worklets-plugin', [...yes, '--products', 'inspector,vitals', '--key', KEY])
    expect(first.code).toBe(0)
    expect(first.changed).toMatchSnapshot()
    expect(first.changed['babel.config.js']).toContain(
      "      ...(dev ? ['@keyframerdev/inspector/babel'] : []),\n      '@keyframerdev/vitals/babel',\n      // Reanimated's plugin, last.\n      'react-native-worklets/plugin',",
    )
    expect(first.changed['keyframer.ts']).toContain('storage: AsyncStorage')
    expect(first.installs.join('\n')).toContain('-- --dev')
    expect(said(second)).toContain('Everything is in place already')
  })
})

describe('React Navigation, a NavigationContainer without a ref (bare React Native)', () => {
  it('gives it the wizard ref, converts the babel object to a function, reads versions from device-info', async () => {
    const { first, second } = await twice('react-navigation', [...yes, '--products', 'inspector,vitals', '--view', 'desktop', '--key', KEY])
    expect(first.code).toBe(0)
    expect(first.changed).toMatchSnapshot()
    expect(first.changed['App.tsx']).toContain("import {navigationRef} from './keyframer';")
    expect(first.changed['App.tsx']).toContain('    <NavigationContainer\n      ref={navigationRef}\n      theme={DefaultTheme}')
    expect(first.changed['keyframer.ts']).toContain('DeviceInfo.getVersion()')
    expect(first.changed['index.js']).toBeUndefined()
    expect(vi.mocked(desktop.ensureDesktopApp)).toHaveBeenCalled()
    expect(first.installs).toEqual([expect.stringMatching(/\$ yarn add @keyframerdev\/vitals$/), expect.stringMatching(/\$ yarn add --dev @keyframerdev\/inspector$/)])
    expect(said(second)).toContain('Everything is in place already')
  })
})

describe('React Navigation with a ref of its own (Expo, src/)', () => {
  it('follows the ref to createNavigationContainerRef, calls useKeyframer with it, wraps in VitalsRoot', async () => {
    const { first, second } = await twice('react-navigation-ref', [...yes, '--products', 'vitals', '--key', KEY, '--vitals-root'])
    expect(first.code).toBe(0)
    expect(first.changed).toMatchSnapshot()
    expect(first.changed['src/App.tsx']).toContain('  useKeyframer(navigationRef)\n\n  // Analytics reads the route from the same ref.')
    expect(first.changed['src/keyframer.ts']).toContain('export function useKeyframer(navigationRef: NavigationRefLike)')
    expect(first.installs).toEqual([expect.stringMatching(/\$ npx expo install @keyframerdev\/vitals$/)])
    expect(said(second)).toContain('Everything is in place already')
  })
})

describe('React Navigation with two containers', () => {
  it("edits neither: prints the snippet and both places, imports the wizard's file in the entry", async () => {
    const { first } = await twice('react-navigation-two', [...yes, '--products', 'inspector', '--view', 'devtools'])
    expect(first.code).toBe(0)
    expect(first.changed).toMatchSnapshot()
    expect(Object.keys(first.changed).sort()).toEqual(['babel.config.js', 'index.js', 'keyframer.ts', 'package.json'])
    expect(said(first)).toContain('There are 2 navigation containers (App.tsx:10, Onboarding.tsx:7)')
    expect(said(first)).toContain("import { navigationRef } from './keyframer'")
    expect(said(first)).toContain('Almost there: finish the steps above by hand.')
  })
})

describe('bare React Native (index.js + App.tsx)', () => {
  it('converts the babel config, adds the worklets plugin last, installs Reanimated with npm, says to pod install', async () => {
    const { first, second } = await twice('bare', [...yes, '--products', 'inspector,vitals', '--view', 'desktop', '--key', KEY])
    expect(first.code).toBe(0)
    expect(first.changed).toMatchSnapshot()
    expect(first.changed['babel.config.js']).toContain("plugins: [...(dev ? ['@keyframerdev/inspector/babel'] : []), '@keyframerdev/vitals/babel', 'react-native-worklets/plugin'],")
    expect(first.changed['index.js']).toContain("import App from './App';\nimport {name as appName} from './app.json';\nimport './keyframer';")
    expect(first.changed['keyframer.ts']).toContain("appVersion: '0.0.1'")
    expect(first.installs[0]).toMatch(/npm install @keyframerdev\/vitals react-native-reanimated react-native-worklets$/)
    expect(said(first)).toContain('pod install')
    // Native folders are never touched.
    expect(Object.keys(first.changed).some((f) => f.startsWith('ios/') || f.startsWith('android/'))).toBe(false)
    expect(said(second)).toContain('Everything is in place already')
  })
})

describe('JavaScript (App.js, double quotes, no semicolons)', () => {
  it("writes keyframer.js in the app's own style, for the editor view", async () => {
    const { first, second } = await twice('javascript', [...yes, '--products', 'inspector,vitals', '--key', KEY, '--view', 'editor', '--code', 'abc234'])
    expect(first.code).toBe(0)
    expect(first.changed).toMatchSnapshot()
    const js = first.changed['keyframer.js']!
    expect(js).toContain('connectInspector({ apiUrl: "https://api.keyframer.dev", code: "ABC234", app: "JS App" })')
    expect(js).not.toMatch(/;\n/)
    expect(js).not.toContain('NavigationRefLike')
    expect(first.changed['index.js']).toContain('import "./keyframer"\n')
    expect(said(second)).toContain('Everything is in place already')
  })
})

describe('a pnpm monorepo (the app in apps/mobile)', () => {
  it('finds pnpm at the workspace root, installs from the app folder', async () => {
    const { first, second } = await twice('monorepo', [...yes, '--products', 'inspector', '--view', 'devtools'], { sub: 'apps/mobile' })
    expect(first.code).toBe(0)
    expect(first.changed).toMatchSnapshot()
    expect(said(first)).toContain('Package manager: pnpm (workspace at ../..)')
    expect(first.installs).toEqual([expect.stringMatching(/^mobile\$ npx expo install @keyframerdev\/inspector -- --save-dev$/)])
    expect(said(second)).toContain('Everything is in place already')
  })

  it('run from the workspace root, it points at the app', async () => {
    const r = await wizard('monorepo', [...yes, '--products', 'inspector'])
    expect(r.code).toBe(1)
    expect(said(r)).toContain('acme is not a React Native app, but apps/mobile is: run the wizard there, or pass --root apps/mobile.')
    expect(r.changed).toEqual({})
  })
})

describe('an app set up by hand, as the docs say', () => {
  it('changes nothing and installs nothing', async () => {
    const r = await wizard('already-set-up', [...yes, '--products', 'inspector,vitals', '--key', KEY])
    expect(r.code).toBe(0)
    expect(r.changed).toEqual({})
    expect(r.installs).toEqual([])
    expect(said(r)).toContain('The Inspector is started in app/_layout.tsx already: left as it is.')
    expect(said(r)).toContain('Motion Vitals is started in app/_layout.tsx already: left as it is.')
    expect(said(r)).toContain('Babel: babel.config.js has the plugins already.')
    expect(said(r)).toContain('Everything is in place already')
  })
})

describe('not a React Native app', () => {
  it('refuses politely, changing nothing', async () => {
    const r = await wizard('not-rn', yes)
    expect(r.code).toBe(1)
    expect(said(r)).toContain("api-server doesn't look like a React Native app")
    expect(said(r)).toContain('Nothing was changed.')
    expect(r.changed).toEqual({})
  })
})

describe('--dry-run', () => {
  it('shows every diff and writes nothing', async () => {
    const r = await wizard('expo-router', ['--yes', '--dry-run', '--products', 'inspector,vitals', '--key', KEY])
    expect(r.code).toBe(0)
    expect(r.changed).toEqual({})
    expect(r.installs).toEqual([])
    expect(said(r)).toContain('note (keyframer.ts  new file)')
    expect(said(r)).toContain('Would run: npx expo install @keyframerdev/vitals')
    expect(said(r)).toContain('Dry run: nothing was written or installed.')
    expect(verify.verifyInspector).not.toHaveBeenCalled()
  })
})

describe('saying no', () => {
  it("to the wizard's file skips the files that import it", async () => {
    const r = await wizard('react-navigation', ['--skip-verify', '--no-agents', '--products', 'inspector', '--view', 'desktop'], { interactive: true, answers: [['Create keyframer.ts', false]] })
    expect(r.code).toBe(0)
    expect(Object.keys(r.changed)).toEqual(['babel.config.js', 'package.json'])
    expect(said(r)).toContain("Skipped App.tsx: it imports keyframer.ts, which you didn't create.")
  })
})

describe('verify outcomes', () => {
  it('a timeout and an error each get their own message', async () => {
    vi.mocked(verify.verifyInspector).mockResolvedValueOnce({ ok: false, reason: 'timeout', detail: 'No hello from the app in 3 minutes.' })
    vi.mocked(verify.verifyVitals).mockRejectedValueOnce(new Error('socket hang up'))
    const r = await wizard('expo-router', ['--yes', '--no-agents', '--products', 'inspector,vitals', '--key', KEY])
    expect(r.code).toBe(0)
    expect(said(r)).toContain('warn: Inspector: not heard from yet. No hello from the app in 3 minutes.')
    expect(said(r)).toContain('error: Motion Vitals: socket hang up')
  })

  it('a failed install: exit 1, the command to run, and no waiting', async () => {
    const dir = copyFixture('expo-router')
    const io = loggedIo([], { interactive: false })
    const run: Run = async () => ({ code: 1, stdout: '', stderr: 'npm ERR! network' })
    const code = await main(['--yes', '--no-agents', '--products', 'inspector', '--root', dir], { io, run, platform: 'darwin' })
    expect(code).toBe(1)
    expect(io.log.join('\n')).toContain('npm ERR! network')
    expect(io.log.join('\n')).toContain('Install them yourself, then run the app: npx expo install @keyframerdev/inspector babel-preset-expo -- --save-dev')
    expect(verify.verifyInspector).not.toHaveBeenCalled()
  })
})

// ── The wizard's files typecheck against the real packages ──────────────────────────

// The inspector's tree, and the node_modules with React Native and expo-router in it: the inspector's
// own (standalone) or Keyframer's (the monorepo). The public repository has neither: the check is skipped.
const INSPECTOR = fileURLToPath(new URL('../../..', import.meta.url))
const NODE_MODULES = [path.join(INSPECTOR, 'node_modules'), path.join(INSPECTOR, '..', 'node_modules')].find(
  (d) => existsSync(path.join(d, 'react-native', 'package.json')) && existsSync(path.join(d, 'expo-router', 'package.json')),
)
const VITALS_SRC = path.join(INSPECTOR, 'packages', 'vitals', 'src', 'index.ts')
const PROTOCOL_SRC = path.join(INSPECTOR, 'packages', 'protocol', 'src')

afterAll(() => outputs.clear())

describe('the generated code', () => {
  it.skipIf(!NODE_MODULES || !existsSync(VITALS_SRC))('typechecks (strict, noImplicitReturns) against @keyframerdev/vitals, expo-router and React Navigation', () => {
    const modules = NODE_MODULES!
    const tc = mkdtempSync(path.join(tmpdir(), 'kf-wizard-tsc-'))
    const files: string[] = []
    const usage: Record<string, string> = {
      'expo-router': "import { useNavigationContainerRef } from 'expo-router'\nimport { useKeyframer } from './keyframer'\nexport function Layout() {\n  const navigationRef = useNavigationContainerRef()\n  useKeyframer(navigationRef)\n  return null\n}\n",
      'react-navigation': "import { NavigationContainer } from '@react-navigation/native'\nimport { navigationRef } from './keyframer'\nexport const app = <NavigationContainer ref={navigationRef}>{null}</NavigationContainer>\n",
      'react-navigation-ref':
        "import { createNavigationContainerRef } from '@react-navigation/native'\nimport { useKeyframer } from './keyframer'\nconst ref = createNavigationContainerRef<{ Home: undefined; Profile: { id: string } }>()\nexport function App() {\n  useKeyframer(ref)\n  return null\n}\n",
    }
    for (const [fixture, dir] of outputs) {
      const file = ['keyframer.ts', 'src/keyframer.ts', 'apps/mobile/keyframer.ts'].map((f) => path.join(dir, f)).find((f) => existsSync(f))
      if (!file) continue
      const to = path.join(tc, fixture)
      mkdirSync(to, { recursive: true })
      writeFileSync(path.join(to, 'keyframer.ts'), readFileSync(file, 'utf8'))
      files.push(path.join(to, 'keyframer.ts'))
      if (usage[fixture]) {
        writeFileSync(path.join(to, 'use.tsx'), usage[fixture]!)
        files.push(path.join(to, 'use.tsx'))
      }
    }
    expect(files.length).toBeGreaterThanOrEqual(6)
    // Packages the monorepo doesn't install, as they declare themselves.
    writeFileSync(
      path.join(tc, 'stubs.d.ts'),
      [
        "declare module 'react-native-device-info' { const DeviceInfo: { getVersion(): string; getBuildNumber(): string }; export default DeviceInfo }",
        "declare module '@react-native-async-storage/async-storage' { const AsyncStorage: { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void>; removeItem(k: string): Promise<void> }; export default AsyncStorage }",
      ].join('\n'),
    )
    files.push(path.join(tc, 'stubs.d.ts'), path.join(modules, 'react-native', 'src', 'types', 'globals.d.ts'))
    const nm = (p: string) => path.join(modules, p)
    writeFileSync(
      path.join(tc, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noImplicitReturns: true,
          noEmit: true,
          skipLibCheck: true,
          target: 'ES2022',
          lib: ['ES2022', 'DOM'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          customConditions: ['react-native'],
          jsx: 'react-jsx',
          types: [],
          allowImportingTsExtensions: true,
          paths: {
            '@keyframerdev/vitals': [VITALS_SRC],
            '@keyframerdev/inspector-protocol/*': [path.join(PROTOCOL_SRC, '*')],
            '@react-navigation/native': [nm('expo-router/build/react-navigation/native/index.d.ts')],
          },
        },
        files,
      }),
    )
    // The monorepo's node_modules, found the usual way (@types/react included).
    symlinkSync(modules, path.join(tc, 'node_modules'))
    const r = spawnSync(path.join(modules, '.bin', 'tsc'), ['-p', tc], { encoding: 'utf8' })
    expect(r.stdout + r.stderr).toBe('')
    expect(r.status).toBe(0)
  }, 120_000)
})
