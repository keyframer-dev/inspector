import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CLI_VERSION, main, parseArgs, UsageError } from './cli'
import { diffLines, renderDiff } from './diff'
import { loggedIo } from './fakes'
import { NeedsAnswer } from './io'
import { clackIo } from './ioClack'
import { copyFixture } from './testFixtures'

const KEY = 'kfp_live_A1b2C3d4E5f6G7h8I9j0K1l2'

describe('parseArgs', () => {
  it('defaults: ask everything, the production URLs, the current folder', () => {
    const { options, metro } = parseArgs([], {}, '/work/app')
    expect(options).toMatchObject({
      root: '/work/app',
      products: null,
      yes: false,
      inspectorView: null,
      vitalsKey: null,
      vitalsAuth: null,
      api: 'https://api.keyframer.dev',
      app: 'https://keyframer.dev',
      vitalsEndpoint: 'https://vitals.keyframer.dev',
      skipInstall: false,
      skipVerify: false,
      dryRun: false,
      agents: null,
      agentTools: null,
      inspectorCode: null,
      vitalsRoot: null,
    })
    expect(metro).toBeNull()
  })

  it('every flag, in both forms', () => {
    const { options, metro } = parseArgs(
      ['-y', '--products=vitals,inspector', '--view', 'editor', '--code', 'abc234', '--key', KEY, '--auth', 'paste', '--root', 'apps/mobile', '--api', 'http://localhost:8787/', '--app=http://localhost:3001', '--skip-install', '--skip-verify', '--dry-run', '--agents', 'cursor', '--vitals-root', '--metro', 'http://localhost:8095'],
      {},
      '/work',
    )
    expect(options).toMatchObject({
      yes: true,
      products: ['inspector', 'vitals'],
      inspectorView: 'editor',
      inspectorCode: 'ABC234',
      vitalsKey: KEY,
      vitalsAuth: 'paste',
      root: path.resolve('/work/apps/mobile'),
      api: 'http://localhost:8787',
      app: 'http://localhost:3001',
      skipInstall: true,
      skipVerify: true,
      dryRun: true,
      agents: true,
      agentTools: ['cursor'],
      vitalsRoot: true,
    })
    expect(metro).toBe('http://localhost:8095')
    expect(parseArgs(['--no-agents', '--no-vitals-root']).options).toMatchObject({ agents: false, vitalsRoot: false })
  })

  it('the environment sets the URLs, flags win', () => {
    const env = { KEYFRAMER_API_URL: 'http://localhost:8787', KEYFRAMER_APP_URL: 'http://localhost:3001', KEYFRAMER_VITALS_URL: 'http://localhost:8788' }
    expect(parseArgs([], env).options).toMatchObject({ api: 'http://localhost:8787', app: 'http://localhost:3001', vitalsEndpoint: 'http://localhost:8788' })
    expect(parseArgs(['--api', 'https://staging.keyframer.dev'], env).options.api).toBe('https://staging.keyframer.dev')
  })

  it.each([
    [['--products', 'debugger'], '--products: "debugger" is not one of inspector, vitals'],
    [['--products', ''], '--products needs at least one of inspector, vitals'],
    [['--view', 'devtools,desktop'], '--view takes one of devtools, desktop, editor'],
    [['--view'], '--view needs a value'],
    [['--key', 'kft_live_123'], 'a CI upload key'],
    [['--key', 'kfp_live_short'], 'a field key looks like kfp_live_'],
    [['--code', 'ABC23'], 'a pairing code is 6 letters and digits'],
    [['--api', 'ftp://x'], 'is not an http(s) URL'],
    [['--agents', 'vscode'], '"vscode" is not one of claude-code, cursor'],
    [['--agents', 'cursor', '--no-agents'], '--agents and --no-agents together'],
    [['--vitals-root', '--no-vitals-root'], 'together'],
    [['--frobnicate'], 'unknown option: --frobnicate'],
    [['apps/mobile'], 'unexpected argument: apps/mobile'],
    [['--yes=1'], '--yes takes no value'],
  ])('%j is bad usage', (argv, message) => {
    expect(() => parseArgs(argv as string[])).toThrow(UsageError)
    expect(() => parseArgs(argv as string[])).toThrow(message)
  })
})

describe('main', () => {
  it('--help, --version, and bad usage (exit 2, naming --help)', async () => {
    const out: string[] = []
    const print = (s: string) => void out.push(s)
    expect(await main(['--help'], { print })).toBe(0)
    expect(out[0]).toContain('npx @keyframerdev/wizard [options]')
    expect(out[0]).toContain('Exit codes: 0 done, 1 failed, 2 bad usage')
    expect(await main(['-v'], { print })).toBe(0)
    expect(out[1]).toBe(CLI_VERSION)
    expect(await main(['--view', 'nope'], { print })).toBe(2)
    expect(out[2]).toBe('keyframer-wizard: --view: "nope" is not one of devtools, desktop, editor\nRun keyframer-wizard --help for the options.')
  })

  it("non-interactive: a question without a default fails with exit 2 and the flag that answers it", async () => {
    // Bare React Native on Linux: no default view (the desktop app is for macOS).
    const dir = copyFixture('bare')
    const io = loggedIo([], { interactive: false })
    expect(await main(['--products', 'inspector', '--root', dir], { io, platform: 'linux' })).toBe(2)
    expect(io.log.join('\n')).toContain('error: Where do you want to see the Inspector?: there is no terminal to ask in, so pass --view.')
    // The editor view without its code.
    const io2 = loggedIo([], { interactive: false })
    expect(await main(['--products', 'inspector', '--view', 'editor', '--root', copyFixture('bare')], { io: io2 })).toBe(2)
    expect(io2.log.join('\n')).toContain('The pairing code: there is no terminal to ask in, so pass --code.')
  })

  it('--view devtools on bare React Native is bad usage', async () => {
    const io = loggedIo([], { interactive: false })
    expect(await main(['--yes', '--products', 'inspector', '--view', 'devtools', '--root', copyFixture('bare')], { io })).toBe(2)
    expect(io.log.join('\n')).toContain("--view devtools needs an Expo app (it runs in Expo's dev tools)")
  })

  it('cancelled: exit 130, nothing half written', async () => {
    const dir = copyFixture('expo-blank')
    const io = loggedIo([], { interactive: true })
    const { Cancelled } = await import('./io')
    vi.spyOn(io, 'multiselect').mockRejectedValueOnce(new Cancelled())
    expect(await main(['--root', dir], { io })).toBe(130)
    expect(io.log.at(-1)).toBe('outro: Stopped. Files already written stay as they are; nothing is half written.')
  })
})

describe('the terminal Io, without a terminal', () => {
  it('takes initial answers, and throws NeedsAnswer naming the flag when there is none', async () => {
    const io = clackIo({ yes: true })
    expect(io.interactive).toBe(false)
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      expect(await io.confirm('Continue?', { initial: true })).toBe(true)
      expect(await io.select('Where?', [{ value: 'a', label: 'A' }], { initial: 'a' })).toBe('a')
      await expect(io.select('Where?', [{ value: 'a', label: 'A' }], { flag: '--view' })).rejects.toThrow(new NeedsAnswer('Where?', '--view'))
      await expect(io.text('Code', { initial: 'x', validate: () => 'too short', flag: '--code' })).rejects.toThrow('Code: too short (pass --code)')
    } finally {
      write.mockRestore()
    }
  })
})

describe('diffs', () => {
  it('removals before additions, context around them, … between hunks', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n')
    const after = ['a', 'B', 'c', 'd', 'e', 'f', 'g', 'H'].join('\n')
    expect(diffLines('x\ny', 'x\nz')).toEqual([{ op: ' ', text: 'x' }, { op: '-', text: 'y' }, { op: '+', text: 'z' }])
    expect(renderDiff(before, after, 1)).toBe('  a\n- b\n+ B\n  c\n  …\n  g\n- h\n+ H')
    expect(renderDiff(null, 'new\nfile\n')).toBe('+ new\n+ file')
  })
})
