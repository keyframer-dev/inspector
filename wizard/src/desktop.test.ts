import { describe, expect, it } from 'vitest'
import { ensureDesktopApp, pickDmg, type DesktopFs } from './desktop'
import type { Run } from './exec'
import { fakeFetch, loggedIo, testOptions } from './fakes'

const APP = '/Applications/Keyframer Inspector.app'
const HOME_APP = '/Users/ada/Applications/Keyframer Inspector.app'
const SIZE = 2048
const DMG_URL = 'https://github.com/keyframer-dev/inspector/releases/download/desktop-v0.2.0/Keyframer-Inspector-0.2.0-macos.dmg'
const releases = [
  { tag_name: '0.2.0', draft: false, prerelease: false, assets: [] },
  { tag_name: 'desktop-v0.3.0', draft: true, prerelease: false, assets: [{ name: 'Keyframer-Inspector-0.3.0-macos.dmg', size: 1, browser_download_url: 'https://example.test/draft.dmg' }] },
  {
    tag_name: 'desktop-v0.2.0',
    draft: false,
    prerelease: false,
    assets: [
      { name: 'Keyframer-Inspector-0.2.0-macos.app.tar.gz', size: 10, browser_download_url: 'https://example.test/x.tar.gz' },
      { name: 'Keyframer-Inspector-0.2.0-macos.dmg', size: SIZE, browser_download_url: DMG_URL },
    ],
  },
]

/** A fake Mac: which bundles exist, what each command answers, and a clock the waits move. */
function mac(o: { installed?: string[]; relayAfter?: number; codesign?: number; spctl?: number; ditto?: (target: string) => number; dragAfter?: number } = {}) {
  const files = new Set(o.installed ?? [])
  const calls: string[] = []
  const written: string[] = []
  const removed: string[] = []
  let t = 0
  let sleeps = 0
  let relayPolls = 0
  const relayAfter = o.relayAfter ?? Infinity
  const run: Run = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '))
    if (cmd === 'codesign') return { code: o.codesign ?? 0, stdout: '', stderr: '' }
    if (cmd === 'spctl') return { code: o.spctl ?? 0, stdout: '', stderr: o.spctl ? 'rejected' : '' }
    if (cmd === 'ditto') {
      const code = o.ditto?.(args[1]!) ?? 0
      if (code === 0) files.add(args[1]!)
      return { code, stdout: '', stderr: code ? 'Permission denied' : '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const fs: DesktopFs = {
    exists: (p) => files.has(p),
    mkdtemp: async (prefix) => `${prefix}abc`,
    mkdir: async () => {},
    writeFile: async (p, data) => void written.push(`${p} (${data.byteLength} bytes)`),
    rm: async (p) => void removed.push(p),
  }
  const fetch = fakeFetch([
    ['GET', '/api/apps', () => (relayPolls++ >= relayAfter ? { body: { apps: [], port: 8790 } } : Promise.reject(new Error('ECONNREFUSED')))],
    ['GET', '/repos/keyframer-dev/inspector/releases', { body: releases }],
    ['GET', '/keyframer-dev/inspector/releases/download/desktop-v0.2.0/Keyframer-Inspector-0.2.0-macos.dmg', () => new Response(new Uint8Array(SIZE))],
  ])
  const sleep = async (ms: number) => {
    t += ms
    // The drag install lands after a few looks.
    if (o.dragAfter !== undefined && ++sleeps >= o.dragAfter) files.add(APP)
  }
  return { run, fs, fetch, calls, written, removed, deps: { run, fs, fetch, platform: 'darwin' as const, arch: 'arm64', home: '/Users/ada', tmp: '/tmp', sleep, now: () => t } }
}

describe('pickDmg', () => {
  it('the newest published desktop release, the Mac-specific image when there is one', () => {
    expect(pickDmg(releases, 'arm64')).toMatchObject({ version: '0.2.0', asset: { name: 'Keyframer-Inspector-0.2.0-macos.dmg' } })
    const split = [{ tag_name: 'desktop-v0.4.0', draft: false, prerelease: false, assets: ['arm64', 'x64'].map((a) => ({ name: `Keyframer-Inspector-0.4.0-macos-${a}.dmg`, size: 1, browser_download_url: a })) }]
    expect(pickDmg(split, 'x64')!.asset.name).toBe('Keyframer-Inspector-0.4.0-macos-x64.dmg')
    expect(pickDmg([], 'arm64')).toBeNull()
  })
})

describe('ensureDesktopApp', () => {
  it('not on a Mac: says the desktop app is macOS-only', async () => {
    const io = loggedIo()
    const m = mac()
    expect(await ensureDesktopApp({ io, options: testOptions(), ...m.deps, platform: 'linux' })).toEqual({ installed: false, relay: null })
    expect(io.log).toEqual(['info: The desktop app is for macOS only for now. Use Expo dev tools or the Keyframer editor to see the Inspector.'])
    expect(m.calls).toEqual([])
  })

  it('running: its relay answers, nothing to do', async () => {
    const m = mac({ installed: [APP], relayAfter: 0 })
    expect(await ensureDesktopApp({ io: loggedIo(), options: testOptions(), ...m.deps })).toEqual({ installed: true, relay: 'http://127.0.0.1:8790' })
    expect(m.calls).toEqual([])
  })

  it('installed, not running: opens it and waits for the relay', async () => {
    const io = loggedIo()
    const m = mac({ installed: [HOME_APP], relayAfter: 4 })
    expect(await ensureDesktopApp({ io, options: testOptions(), ...m.deps })).toEqual({ installed: true, relay: 'http://127.0.0.1:8790' })
    expect(m.calls).toEqual([`open -a ${HOME_APP}`])
    expect(io.log).toContain('ask: Keyframer Inspector is installed but not running. Open it? → true')
    expect(io.log.at(-1)).toBe('spinner done: Keyframer Inspector is running')
  })

  it('not installed: downloads, mounts read-only, checks the signature, copies it in (the default with --install-desktop) and opens it', async () => {
    const io = loggedIo([], { interactive: false })
    const m = mac({ relayAfter: 3 })
    expect(await ensureDesktopApp({ io, options: testOptions({ yes: true, installDesktop: true }), ...m.deps })).toEqual({ installed: true, relay: 'http://127.0.0.1:8790' })
    const dir = '/tmp/keyframer-inspector-abc'
    expect(m.written).toEqual([`${dir}/Keyframer-Inspector-0.2.0-macos.dmg (${SIZE} bytes)`])
    expect(m.calls).toEqual([
      `hdiutil attach -nobrowse -readonly -noautoopen -mountpoint ${dir}/mount ${dir}/Keyframer-Inspector-0.2.0-macos.dmg`,
      `codesign --verify --deep --strict ${dir}/mount/Keyframer Inspector.app`,
      `spctl --assess --type execute ${dir}/mount/Keyframer Inspector.app`,
      `ditto ${dir}/mount/Keyframer Inspector.app ${APP}`,
      `hdiutil detach ${dir}/mount -quiet`,
      `open -a ${APP}`,
    ])
    expect(m.removed).toEqual([dir])
    expect(io.log).toContain('ask: Keyframer Inspector isn\'t installed. Download version 0.2.0 (1 MB, signed and notarized)? → true')
  })

  it("falls back to ~/Applications when /Applications can't be written", async () => {
    const m = mac({ relayAfter: 1, ditto: (target) => (target === APP ? 1 : 0) })
    const r = await ensureDesktopApp({ io: loggedIo([], { interactive: false }), options: testOptions({ yes: true, installDesktop: true }), ...m.deps })
    expect(r.installed).toBe(true)
    expect(m.calls).toContain(`ditto /tmp/keyframer-inspector-abc/mount/Keyframer Inspector.app ${HOME_APP}`)
    expect(m.calls.at(-1)).toBe(`open -a ${HOME_APP}`)
  })

  it('unattended without --install-desktop: nothing is downloaded, it says where to get it', async () => {
    const io = loggedIo([], { interactive: false })
    const m = mac({ relayAfter: 3 })
    expect(await ensureDesktopApp({ io, options: testOptions({ yes: true }), ...m.deps })).toEqual({ installed: false, relay: null })
    expect(m.written).toEqual([])
    expect(m.calls).toEqual([])
    expect(io.log.join('\n')).toContain('github.com/keyframer-dev/inspector/releases')
  })

  it('a download that fails the signature check is not installed', async () => {
    const io = loggedIo()
    const m = mac({ spctl: 3 })
    expect(await ensureDesktopApp({ io, options: testOptions(), ...m.deps })).toEqual({ installed: false, relay: null })
    expect(m.calls.some((c) => c.startsWith('ditto') || c.startsWith('open'))).toBe(false)
    expect(m.calls.at(-1)).toBe('hdiutil detach /tmp/keyframer-inspector-abc/mount -quiet')
    expect(m.removed).toEqual(['/tmp/keyframer-inspector-abc'])
    expect(io.log).toContain("error: The download didn't pass macOS's signature check, so the wizard didn't install it.")
  })

  it('the drag install: opens the disk image, waits for the app in Applications, then opens it', async () => {
    const io = loggedIo([['How should it be installed', 'drag']])
    const m = mac({ relayAfter: 1, dragAfter: 3 })
    expect(await ensureDesktopApp({ io, options: testOptions(), ...m.deps })).toEqual({ installed: true, relay: 'http://127.0.0.1:8790' })
    expect(m.calls.slice(3)).toEqual([
      'hdiutil detach /tmp/keyframer-inspector-abc/mount -quiet',
      'open /tmp/keyframer-inspector-abc/Keyframer-Inspector-0.2.0-macos.dmg',
      'hdiutil detach /Volumes/Keyframer Inspector -quiet',
      `open -a ${APP}`,
    ])
  })

  it('declined, a dry run, or no release: nothing is downloaded', async () => {
    const no = mac()
    expect(await ensureDesktopApp({ io: loggedIo([['Download version', false]]), options: testOptions(), ...no.deps })).toEqual({ installed: false, relay: null })
    const dry = mac()
    const io = loggedIo()
    await ensureDesktopApp({ io, options: testOptions({ dryRun: true }), ...dry.deps })
    expect(io.log).toContain('info: Dry run: would download Keyframer-Inspector-0.2.0-macos.dmg and install it.')
    for (const m of [no, dry]) expect(m.calls).toEqual([])
    const none = mac()
    const io2 = loggedIo()
    await ensureDesktopApp({ io: io2, options: testOptions(), ...none.deps, fetch: fakeFetch([['GET', '/repos/keyframer-dev/inspector/releases', { body: [] }]]) })
    expect(io2.log[0]).toBe("warn: Couldn't find a desktop release to download.")
  })
})
