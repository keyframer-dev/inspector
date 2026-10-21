/**
 * The desktop app, Keyframer Inspector (macOS): found installed or answering on its relay, else
 * offered as a download of the latest signed build from the public repository's releases, then
 * opened, so the app has a relay to join.
 *
 * The relay answers GET /api/apps on 127.0.0.1:8790 (desktop/src-tauri/src/server.rs). Releases are
 * `desktop-v<version>` on keyframer-dev/inspector, with `Keyframer-Inspector-<version>-macos.dmg`, one
 * universal build (.github/workflows/inspector-desktop-release.yml). A download is mounted read-only,
 * checked with codesign and Gatekeeper (spctl) before anything is copied, and copied with ditto, or the
 * disk image is opened for the drag install its window is laid out for. Every command goes through
 * an injectable runner, so tests run none.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { run as realRun, type Run } from './exec'
import { sleep as realSleep, type Fetch } from './http'
import type { Io } from './io'
import type { WizardOptions } from './types'

export const APP_NAME = 'Keyframer Inspector'
export const RELAY = 'http://127.0.0.1:8790'
export const RELEASES_API = 'https://api.github.com/repos/keyframer-dev/inspector/releases?per_page=30'
export const RELEASES_PAGE = 'https://github.com/keyframer-dev/inspector/releases'

/** The file system and clock the step touches, injectable for tests. */
export type DesktopFs = {
  exists(path: string): boolean
  mkdtemp(prefix: string): Promise<string>
  mkdir(path: string): Promise<void>
  writeFile(path: string, data: Uint8Array): Promise<void>
  rm(path: string): Promise<void>
}

const nodeFs: DesktopFs = {
  exists: existsSync,
  mkdtemp: (prefix) => mkdtemp(prefix),
  mkdir: async (path) => void (await mkdir(path, { recursive: true })),
  writeFile: (path, data) => writeFile(path, data),
  rm: (path) => rm(path, { recursive: true, force: true }),
}

export type DesktopOptions = {
  io: Io
  options: WizardOptions
  fetch?: typeof fetch
  run?: Run
  fs?: DesktopFs
  platform?: NodeJS.Platform
  arch?: string
  home?: string
  tmp?: string
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  /** How long to wait for the relay once the app is opened. Default 30 s. */
  startTimeoutMs?: number
  /** How long to wait for the drag install. Default 3 min. */
  dragTimeoutMs?: number
}

type Asset = { name: string; size: number; browser_download_url: string }
type Release = { tag_name: string; name?: string; draft: boolean; prerelease: boolean; assets: Asset[] }

/** The newest desktop release's disk image for this Mac: an arm64 or x64 one when published, else the universal one. */
export function pickDmg(releases: Release[], arch: string): { version: string; asset: Asset } | null {
  const cpu = arch === 'arm64' ? 'arm64' : 'x64'
  for (const r of releases) {
    if (r.draft || r.prerelease || !r.tag_name.startsWith('desktop-v')) continue
    const dmgs = r.assets.filter((a) => a.name.endsWith('.dmg'))
    const asset = dmgs.find((a) => a.name.includes(`-macos-${cpu}`)) ?? dmgs.find((a) => a.name.endsWith('-macos.dmg')) ?? dmgs.find((a) => /universal/.test(a.name))
    if (asset) return { version: r.tag_name.slice('desktop-v'.length), asset }
  }
  return null
}

/** Whether the desktop relay answers on 127.0.0.1:8790. */
export async function relayUp(fetchImpl: Fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${RELAY}/api/apps`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return false
    const body = (await res.json().catch(() => null)) as { apps?: unknown } | null
    return Array.isArray(body?.apps)
  } catch {
    return false
  }
}

const mb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1_000_000))} MB`

/** `relay`: the address the app should join (http://127.0.0.1:8790), or null when there is no desktop app. */
export async function ensureDesktopApp(opts: DesktopOptions): Promise<{ installed: boolean; relay: string | null }> {
  const { io, options } = opts
  const fetchImpl = opts.fetch ?? fetch
  const run = opts.run ?? realRun
  const fs = opts.fs ?? nodeFs
  const sleep = opts.sleep ?? realSleep
  const now = opts.now ?? Date.now
  const home = opts.home ?? homedir()

  if ((opts.platform ?? process.platform) !== 'darwin') {
    io.info('The desktop app is for macOS only for now. Use Expo dev tools or the Keyframer editor to see the Inspector.')
    return { installed: false, relay: null }
  }

  const bundles = [join('/Applications', `${APP_NAME}.app`), join(home, 'Applications', `${APP_NAME}.app`)]
  const installed = bundles.find((b) => fs.exists(b)) ?? null

  if (await relayUp(fetchImpl)) {
    io.success(`${APP_NAME} is running (its relay answers on 127.0.0.1:8790).`)
    return { installed: true, relay: RELAY }
  }

  /** Opens the app and waits for its relay. */
  const start = async (bundle: string) => {
    const opened = await run('open', ['-a', bundle])
    if (opened.code !== 0) {
      io.error(`Couldn't open ${APP_NAME}: ${opened.stderr.trim() || `open exited with ${opened.code}`}`)
      return { installed: true, relay: null }
    }
    const spin = io.spinner(`Waiting for ${APP_NAME} to start`)
    const until = now() + (opts.startTimeoutMs ?? 30_000)
    while (now() < until) {
      if (await relayUp(fetchImpl)) {
        spin.stop(`${APP_NAME} is running`, true)
        return { installed: true, relay: RELAY }
      }
      await sleep(500)
    }
    spin.stop(`${APP_NAME} opened, but its relay isn't answering on 127.0.0.1:8790 yet`, false)
    io.info('If another program holds port 8790, quit it, or set KEYFRAMER_RELAY_PORT for the desktop app and point the app at that port.')
    return { installed: true, relay: null }
  }

  if (installed) {
    if (!(await io.confirm(`${APP_NAME} is installed but not running. Open it?`, { initial: true }))) return { installed: true, relay: null }
    if (options.dryRun) {
      io.info(`Dry run: would open ${installed}.`)
      return { installed: true, relay: null }
    }
    return start(installed)
  }

  // Not installed: the latest signed build from the public repository.
  let pick: ReturnType<typeof pickDmg> = null
  try {
    const res = await fetchImpl(RELEASES_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'keyframer-wizard' } })
    if (res.ok) pick = pickDmg((await res.json()) as Release[], opts.arch ?? process.arch)
  } catch {
    // Offline: said below.
  }
  if (!pick) {
    io.warn("Couldn't find a desktop release to download.")
    io.info(`Download Keyframer Inspector from ${RELEASES_PAGE}, then run the wizard again.`)
    return { installed: false, relay: null }
  }
  const { version, asset } = pick
  if (!(await io.confirm(`${APP_NAME} isn't installed. Download version ${version} (${mb(asset.size)}, signed and notarized)?`, { initial: io.interactive || !!options.installDesktop, flag: '--install-desktop' }))) {
    io.info(`You can get it later from ${RELEASES_PAGE}`)
    return { installed: false, relay: null }
  }
  if (options.dryRun) {
    io.info(`Dry run: would download ${asset.name} and install it.`)
    return { installed: false, relay: null }
  }

  const dir = await fs.mkdtemp(join(opts.tmp ?? tmpdir(), 'keyframer-inspector-'))
  const dmg = join(dir, asset.name)
  const mount = join(dir, 'mount')
  let mounted = false
  const detach = async () => {
    if (!mounted) return
    mounted = false
    await run('hdiutil', ['detach', mount, '-quiet'])
  }
  try {
    const spin = io.spinner(`Downloading ${asset.name}`)
    const ok = await download(fetchImpl, asset, dmg, fs, (got) => spin.update(`Downloading ${asset.name} (${mb(got)} of ${mb(asset.size)})`))
    if (!ok.done) {
      spin.stop(`The download failed: ${ok.error}`, false)
      io.info(`Get it from ${RELEASES_PAGE} instead.`)
      return { installed: false, relay: null }
    }
    spin.stop(`Downloaded ${asset.name}`, true)

    await fs.mkdir(mount)
    const attach = await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg])
    if (attach.code !== 0) {
      io.error(`Couldn't open the disk image: ${attach.stderr.trim() || `hdiutil exited with ${attach.code}`}`)
      return { installed: false, relay: null }
    }
    mounted = true
    const app = join(mount, `${APP_NAME}.app`)
    const sign = await run('codesign', ['--verify', '--deep', '--strict', app])
    const gate = sign.code === 0 ? await run('spctl', ['--assess', '--type', 'execute', app]) : sign
    if (sign.code !== 0 || gate.code !== 0) {
      io.error("The download didn't pass macOS's signature check, so the wizard didn't install it.")
      io.info(`Get Keyframer Inspector from ${RELEASES_PAGE} instead.`)
      return { installed: false, relay: null }
    }
    io.success('The signature checks out, and Gatekeeper accepts it')

    const how = await io.select(
      'How should it be installed?',
      [
        { value: 'copy' as const, label: 'Copy it to Applications for me' },
        { value: 'drag' as const, label: "Open the disk image, and I'll drag it in" },
      ],
      { initial: 'copy' },
    )
    if (how === 'copy') {
      let target = bundles[0]!
      let copied = await run('ditto', [app, target])
      // No write access to /Applications (a managed Mac): the user's own Applications folder.
      if (copied.code !== 0) {
        target = bundles[1]!
        copied = await run('ditto', [app, target])
      }
      await detach()
      if (copied.code !== 0) {
        io.error(`Couldn't copy it to Applications: ${copied.stderr.trim() || `ditto exited with ${copied.code}`}`)
        return { installed: false, relay: null }
      }
      io.success(`Installed ${APP_NAME} in ${target.replace(/\/[^/]+$/, '')}`)
      return start(target)
    }

    // Finder shows the image's own window, laid out for dragging the app onto Applications.
    await detach()
    await run('open', [dmg])
    const spin2 = io.spinner(`Drag ${APP_NAME} onto Applications in the window that opened`)
    const until = now() + (opts.dragTimeoutMs ?? 3 * 60_000)
    let found: string | null = null
    while (!found && now() < until) {
      found = bundles.find((b) => fs.exists(b)) ?? null
      if (!found) await sleep(1000)
    }
    if (!found) {
      spin2.stop(`${APP_NAME} isn't in Applications yet`, false)
      return { installed: false, relay: null }
    }
    spin2.stop(`${APP_NAME} is in Applications`, true)
    // The image Finder mounted is named after the app; ejecting it is a courtesy.
    await run('hdiutil', ['detach', `/Volumes/${APP_NAME}`, '-quiet'])
    return start(found)
  } finally {
    await detach()
    await fs.rm(dir).catch(() => {})
  }
}

/** Downloads to `dest`, reporting progress; false (with why) on any failure or a size that does not match. */
async function download(fetchImpl: Fetch, asset: Asset, dest: string, fs: DesktopFs, progress: (bytes: number) => void): Promise<{ done: true } | { done: false; error: string }> {
  let res: Response
  try {
    res = await fetchImpl(asset.browser_download_url, { headers: { 'User-Agent': 'keyframer-wizard' } })
  } catch (e) {
    return { done: false, error: (e as Error).message }
  }
  if (!res.ok || !res.body) return { done: false, error: `GitHub answered ${res.status}` }
  const chunks: Uint8Array[] = []
  let got = 0
  let shown = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    got += value.byteLength
    if (got - shown > 1_000_000) {
      shown = got
      progress(got)
    }
  }
  if (asset.size && got !== asset.size) return { done: false, error: `got ${got} bytes of ${asset.size}` }
  const all = new Uint8Array(got)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  await fs.writeFile(dest, all)
  return { done: true }
}
