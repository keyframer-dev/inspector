/**
 * keyframer-wizard: sets up the Keyframer Inspector and Motion Vitals in a React Native or Expo app,
 * step by step, like Sentry's wizard, then waits for the app's first message to prove it works.
 *
 *   npx @keyframerdev/wizard
 *   npx @keyframerdev/wizard --yes --products inspector --view devtools     (agents, CI)
 *
 * The flow: find the app, warn about uncommitted changes, ask what to set up and where to look,
 * get a Vitals key, plan every change (shown as diffs), write each file on confirmation, install,
 * offer the agent integrations, then wait for the app.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { version as pkgVersion } from '../package.json'
import { setupAgents } from './agents'
import { DEFAULT_RELAY } from './codemods/startFile'
import { relativeImport } from './codemods/source'
import { filesMatching } from './codemods/workspace'
import { installCommand, shellLine } from './codemods/packages'
import { ensureDesktopApp } from './desktop'
import { describeProject, detectProject, NotReactNative } from './detect'
import { diffStat, renderDiff } from './diff'
import { Cancelled, NeedsAnswer, type Choice, type Io } from './io'
import { clackIo } from './ioClack'
import { makePlan, writeAtomic, type Plan } from './plan'
import { run as realRun, type Run } from './exec'
import type { SocketCtor } from './socket'
import type { AgentTool, InspectorView, Product, Project, VerifyResult, VitalsAuth, VitalsKey, WizardOptions } from './types'
import { verifyInspector, verifyVitals } from './verify'
import { FIELD_KEY_PATTERN, getVitalsKey, VITALS_ENDPOINT } from './vitalsKey'

export const CLI_NAME = 'keyframer-wizard'
export const CLI_VERSION: string = pkgVersion

export const DEFAULT_API = 'https://api.keyframer.dev'
export const DEFAULT_APP = 'https://keyframer.dev'
const DOCS = 'https://keyframer.dev/inspector/docs'

const HELP = `${CLI_NAME} ${CLI_VERSION}: sets up the Keyframer Inspector and Motion Vitals in a React Native or Expo app

Usage:
  npx @keyframerdev/wizard [options]

Options:
  --products <list>       inspector, vitals, or inspector,vitals (default: ask; with --yes, the
                          Inspector, plus Vitals when --key is given)
  --view <view>           where to see the Inspector: devtools (Expo's dev tools, shift+m in Metro),
                          desktop (the Keyframer Inspector app) or editor (keyframer.dev, with --code)
  --code <code>           the pairing code the Keyframer editor's Inspector panel shows (--view editor)
  --key <kfp_live_…>      the Motion Vitals project's field key (from keyframer.dev/app/vitals)
  --auth <paste|browser>  how to find the Vitals key without --key: paste it, or sign in in the browser
  --vitals-root           wrap the app in <VitalsRoot> (--no-vitals-root: don't; default: ask)
  --root <dir>            the app's folder (default: the current folder)
  --api <url>             default ${DEFAULT_API} (or KEYFRAMER_API_URL)
  --app <url>             default ${DEFAULT_APP} (or KEYFRAMER_APP_URL)
  --yes, -y               no questions: take the defaults, and fail naming the flag where there is none
  --dry-run               show every change, write nothing, install nothing
  --skip-install          print the install commands instead of running them
  --skip-verify           don't wait for the app's first message
  --install-desktop       download and install the desktop app if it's missing, without asking (--view desktop)
  --metro <url>           Metro's address when it isn't on 8081-8090 (http://localhost:8095)
  --agents <list>         set up these agents' MCP config: claude-code, cursor (default: ask; none
                          with --yes)
  --no-agents             don't offer the agent integrations
  -h, --help              this help
  -v, --version           the version

Exit codes: 0 done, 1 failed, 2 bad usage (or a question --yes can't answer), 130 cancelled.
`

export class UsageError extends Error {}

const PRODUCTS: Product[] = ['inspector', 'vitals']
const VIEWS: InspectorView[] = ['devtools', 'desktop', 'editor']
const AUTHS: VitalsAuth[] = ['paste', 'browser']
const AGENT_TOOLS: AgentTool[] = ['claude-code', 'cursor']
export const KEY_RE = FIELD_KEY_PATTERN
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function isPairingCode(code: string): boolean {
  return code.length === 6 && [...code].every((c) => CODE_ALPHABET.includes(c))
}

/** `metro`: --metro, Metro's URL, which verify and the agents' config use. */
export type Parsed = { options: WizardOptions; metro: string | null; help: boolean; version: boolean }

/** argv to options. Throws UsageError for an unknown flag or a bad value. */
export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}, cwd = process.cwd()): Parsed {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  const takesValue = new Set(['products', 'view', 'code', 'key', 'auth', 'root', 'api', 'app', 'metro', 'agents'])
  const booleans = new Set(['yes', 'dry-run', 'skip-install', 'skip-verify', 'install-desktop', 'no-agents', 'vitals-root', 'no-vitals-root', 'help', 'version'])
  const short: Record<string, string> = { '-y': 'yes', '-h': 'help', '-v': 'version' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (short[arg]) {
      flags.add(short[arg]!)
      continue
    }
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument: ${arg}`)
    const eq = arg.indexOf('=')
    const name = arg.slice(2, eq >= 0 ? eq : undefined)
    if (takesValue.has(name)) {
      const v = eq >= 0 ? arg.slice(eq + 1) : argv[++i]
      if (v === undefined || (eq < 0 && v.startsWith('--'))) throw new UsageError(`--${name} needs a value`)
      values.set(name, v)
    } else if (booleans.has(name)) {
      if (eq >= 0) throw new UsageError(`--${name} takes no value`)
      flags.add(name)
    } else throw new UsageError(`unknown option: --${name}`)
  }

  const list = <T extends string>(name: string, allowed: T[]): T[] | null => {
    const v = values.get(name)
    if (v === undefined) return null
    const items = v.split(',').map((s) => s.trim()).filter(Boolean)
    if (!items.length) throw new UsageError(`--${name} needs at least one of ${allowed.join(', ')}`)
    for (const it of items) if (!allowed.includes(it as T)) throw new UsageError(`--${name}: "${it}" is not one of ${allowed.join(', ')}`)
    return [...new Set(items as T[])].sort((a, b) => allowed.indexOf(a) - allowed.indexOf(b))
  }
  const one = <T extends string>(name: string, allowed: T[]): T | null => {
    const v = list(name, allowed)
    if (v && v.length > 1) throw new UsageError(`--${name} takes one of ${allowed.join(', ')}`)
    return v?.[0] ?? null
  }
  const url = (name: string, fallback: string): string => {
    const v = values.get(name) ?? fallback
    try {
      const u = new URL(v)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error()
    } catch {
      throw new UsageError(`--${name}: "${v}" is not an http(s) URL`)
    }
    return v.replace(/\/+$/, '')
  }

  const key = values.get('key') ?? null
  if (key !== null && !KEY_RE.test(key)) {
    throw new UsageError(
      key.startsWith('kft_')
        ? '--key: that is a CI upload key (kft_…); the app needs the project\'s field key, kfp_live_…'
        : '--key: a field key looks like kfp_live_ and 24 letters and digits (copy it from the project\'s setup at keyframer.dev/app/vitals)',
    )
  }
  const code = values.get('code')?.toUpperCase() ?? null
  if (code !== null && !isPairingCode(code)) throw new UsageError('--code: a pairing code is 6 letters and digits, as the editor\'s Inspector panel shows it')
  if (flags.has('vitals-root') && flags.has('no-vitals-root')) throw new UsageError('--vitals-root and --no-vitals-root together')
  if (values.has('agents') && flags.has('no-agents')) throw new UsageError('--agents and --no-agents together')
  const agentTools = list('agents', AGENT_TOOLS)
  const metro = values.has('metro') ? url('metro', '') : null

  const options: WizardOptions = {
    root: path.resolve(cwd, values.get('root') ?? '.'),
    products: list('products', PRODUCTS),
    yes: flags.has('yes'),
    inspectorView: one('view', VIEWS),
    vitalsKey: key,
    vitalsAuth: one('auth', AUTHS),
    api: url('api', env.KEYFRAMER_API_URL || DEFAULT_API),
    app: url('app', env.KEYFRAMER_APP_URL || DEFAULT_APP),
    skipInstall: flags.has('skip-install'),
    skipVerify: flags.has('skip-verify'),
    installDesktop: flags.has('install-desktop'),
    dryRun: flags.has('dry-run'),
    agents: flags.has('no-agents') ? false : agentTools ? true : null,
    agentTools,
    vitalsEndpoint: url('vitals-endpoint', env.KEYFRAMER_VITALS_URL || VITALS_ENDPOINT),
    inspectorCode: code,
    vitalsRoot: flags.has('vitals-root') ? true : flags.has('no-vitals-root') ? false : null,
  }
  return { options, metro, help: flags.has('help'), version: flags.has('version') }
}

export type MainDeps = {
  io?: Io
  cwd?: string
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  /** Runs the installs (exec.ts's runner by default). */
  run?: Run
  /** Where --help and --version print. */
  print?: (text: string) => void
  /** How long verify waits, passed through (tests make it short). */
  verifyTimeoutMs?: number
  /** What the network steps use (tests pass fakes.ts's fakes). */
  fetch?: typeof fetch
  WebSocket?: SocketCtor
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const print = deps.print ?? ((s: string) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`))
  let parsed: Parsed
  try {
    parsed = parseArgs(argv, deps.env ?? process.env, deps.cwd ?? process.cwd())
  } catch (e) {
    if (!(e instanceof UsageError)) throw e
    ;(deps.print ?? ((s: string) => process.stderr.write(`${s}\n`)))(`${CLI_NAME}: ${e.message}\nRun ${CLI_NAME} --help for the options.`)
    return 2
  }
  if (parsed.help) {
    print(HELP)
    return 0
  }
  if (parsed.version) {
    print(CLI_VERSION)
    return 0
  }
  const io = deps.io ?? clackIo({ yes: parsed.options.yes })
  try {
    return await wizard(parsed.options, parsed.metro, io, deps)
  } catch (e) {
    if (e instanceof Cancelled) {
      io.outro('Stopped. Files already written stay as they are; nothing is half written.')
      return 130
    }
    if (e instanceof NeedsAnswer) {
      io.error(e.flag ? `${e.question}: there is no terminal to ask in, so pass ${e.flag}.` : `${e.question}: there is no terminal to ask in.`)
      io.outro(`Run ${CLI_NAME} --help for the options.`)
      return 2
    }
    if (e instanceof UsageError) {
      io.error(e.message)
      io.outro(`Run ${CLI_NAME} --help for the options.`)
      return 2
    }
    if (e instanceof NotReactNative) {
      io.error(e.message)
      io.outro('Nothing was changed.')
      return 1
    }
    io.error(`Something went wrong: ${e instanceof Error ? e.message : String(e)}`)
    io.outro(`Nothing is half written. If it keeps happening, tell us at https://github.com/keyframer-dev/inspector/issues`)
    return 1
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Errors from a step that are the person's to answer (stop, or a missing flag) pass through; the rest become a message. */
function passThrough(e: unknown): boolean {
  return e instanceof Cancelled || e instanceof NeedsAnswer || e instanceof UsageError
}

function defaultView(project: Project, platform: NodeJS.Platform): InspectorView | undefined {
  if (project.expo) return 'devtools'
  if (platform === 'darwin') return 'desktop'
  return undefined
}

function metroCommand(project: Project): string {
  return project.expo ? 'npx expo start -c' : 'npx react-native start --reset-cache'
}

async function wizard(options: WizardOptions, metro: string | null, io: Io, deps: MainDeps): Promise<number> {
  const platform = deps.platform ?? process.platform
  const run = deps.run ?? realRun
  io.intro(`Keyframer setup ${CLI_VERSION}`)

  // ── The app ──
  const project = detectProject(options.root)
  io.step('Your app')
  io.info(describeProject(project).join('\n'))
  if (project.git && !project.git.clean) {
    io.warn('Git has uncommitted changes here. The wizard edits a few files: committing first makes them easy to review or undo.')
    const go = await io.confirm('Continue anyway?', { initial: true, flag: '--yes' })
    if (!go) {
      io.outro('Nothing was changed. Commit, then run the wizard again.')
      return 0
    }
  }

  // ── What to set up ──
  const productChoices: Choice<Product>[] = [
    { value: 'inspector', label: 'Inspector', hint: 'a motion debugger for development: record, scrub, find dropped frames' },
    { value: 'vitals', label: 'Motion Vitals', hint: 'slow frames and janky animations from production, by screen and line' },
  ]
  const products =
    options.products ??
    (await io.multiselect('What do you want to set up?', productChoices, {
      initial: io.interactive ? ['inspector', 'vitals'] : options.vitalsKey ? ['inspector', 'vitals'] : ['inspector'],
      flag: '--products',
    }))
  if (!products.length) throw new UsageError('Pick at least one: inspector, vitals.')
  const opts: WizardOptions = { ...options, products }

  // ── The Inspector: where to look ──
  let view: InspectorView | null = null
  let relay: string | null = null
  let code: string | null = null
  if (products.includes('inspector')) {
    const views: Choice<InspectorView>[] = [
      ...(project.expo ? [{ value: 'devtools' as const, label: "Expo's dev tools", hint: 'shift+m in Metro, no account' }] : []),
      { value: 'desktop', label: 'The Keyframer Inspector desktop app', hint: 'a recordings library and an MCP server for agents' },
      { value: 'editor', label: 'The Keyframer editor', hint: 'keyframer.dev, with a pairing code' },
    ]
    view = options.inspectorView ?? (await io.select('Where do you want to see the Inspector?', views, { initial: defaultView(project, platform), flag: '--view' }))
    if (view === 'devtools' && !project.expo) throw new UsageError("--view devtools needs an Expo app (it runs in Expo's dev tools): use --view desktop or --view editor.")
    if (view === 'desktop') {
      try {
        const d = await ensureDesktopApp({ io, options: opts, fetch: deps.fetch, platform })
        relay = d.relay
        if (!relay) io.warn(`The desktop app isn't running yet. Your app joins its relay at ${DEFAULT_RELAY} once it is (get it at https://github.com/keyframer-dev/inspector/releases/latest).`)
      } catch (e) {
        if (passThrough(e)) throw e
        io.warn(`Couldn't check the desktop app (${message(e)}). The app will look for it at ${DEFAULT_RELAY}.`)
      }
    }
    if (view === 'editor') {
      code = options.inspectorCode ?? null
      if (!code) {
        io.info(`Open ${opts.app}/editor, then its Inspector panel: it shows a pairing code.`)
        code = (
          await io.text('The pairing code', { placeholder: 'ABC234', validate: (v) => (isPairingCode(v.trim().toUpperCase()) ? undefined : 'A pairing code is 6 letters and digits.'), flag: '--code' })
        )
          .trim()
          .toUpperCase()
      }
    }
  }

  // ── Motion Vitals: the key ──
  let vitalsKey: VitalsKey | null = null
  if (products.includes('vitals')) {
    io.step('Motion Vitals key')
    try {
      vitalsKey = await getVitalsKey({ project, options: opts, io, fetch: deps.fetch })
      if (!KEY_RE.test(vitalsKey.key)) throw new Error(`"${vitalsKey.key.slice(0, 12)}…" is not a field key (kfp_live_…)`)
      io.success(`Key: ${vitalsKey.key.slice(0, 13)}…`)
    } catch (e) {
      if (passThrough(e)) throw e
      vitalsKey = null
      io.error(`Couldn't get a Motion Vitals key: ${message(e)}`)
      io.info(`Copy the field key from your project at ${opts.app}/app/vitals, then run the wizard again with --key kfp_live_…`)
      if (!products.includes('inspector')) {
        io.outro('Nothing was changed.')
        return 1
      }
      io.info('Going on with the Inspector.')
    }
  }
  const vitals = !!vitalsKey

  let vitalsRoot = false
  if (vitals) {
    const has = filesMatching(project.root, /<VitalsRoot\b/).length > 0
    vitalsRoot = has
      ? false
      : (options.vitalsRoot ??
        (await io.confirm('Wrap your app in <VitalsRoot>? Touches then open motion windows, so lists without scroll handlers are measured too (optional).', {
          initial: false,
          flag: '--vitals-root',
        })))
  }

  // ── The plan ──
  io.step('The plan')
  const plan = makePlan(project, { products, view, relay, code, api: opts.api, key: vitalsKey?.key ?? null, vitalsRoot })
  showPlan(io, project, plan)

  // ── The changes ──
  const written: string[] = []
  const declined: string[] = []
  const rel = (f: string) => path.relative(project.root, f) || path.basename(f)
  let startDeclined = false
  const ordered = [...plan.changes].sort((a, b) => rank(a.file, plan) - rank(b.file, plan))
  for (const ch of ordered) {
    const stat = diffStat(ch.before, ch.after)
    const title = `${rel(ch.file)}  ${ch.before === null ? 'new file' : `+${stat.added} -${stat.removed}`}`
    io.note(renderDiff(ch.before, ch.after), title)
    for (const w of ch.why) io.info(w)
    if (options.dryRun) continue
    const importsStart = plan.startFile !== null && ch.file !== plan.startFile && importsFile(ch.file, ch.after, plan.startFile)
    if (startDeclined && importsStart) {
      io.warn(`Skipped ${rel(ch.file)}: it imports ${rel(plan.startFile!)}, which you didn't create.`)
      declined.push(ch.file)
      continue
    }
    const ok = await io.confirm(ch.before === null ? `Create ${rel(ch.file)}?` : `Change ${rel(ch.file)}?`, { initial: true, flag: '--yes' })
    if (!ok) {
      declined.push(ch.file)
      if (ch.file === plan.startFile) startDeclined = true
      continue
    }
    writeAtomic(ch.file, ch.after)
    written.push(ch.file)
  }
  if (written.length) io.success(`Wrote ${written.map(rel).join(', ')}.`)

  // The Babel plugins are what tie animations to their lines: saying no to them is worth a sentence,
  // and the preset only a new config needed is not installed.
  const babelDeclined = declined.find((f) => /^(babel\.config\.([cm]?js|json)|\.babelrc(\.js)?)$/.test(path.basename(f)))
  if (babelDeclined) {
    const cost = [
      ...(products.includes('inspector') ? ["the Inspector can't see your animations"] : []),
      ...(products.includes('vitals') ? ['Motion Vitals counts frames per screen, with no call sites'] : []),
    ].join(', and ')
    io.warn(`Without the Babel plugins in ${rel(babelDeclined)}, ${cost}. Run the wizard again, or add them by hand: https://keyframer.dev/inspector/docs/getting-started/react-native`)
    if (!existsSync(babelDeclined)) {
      plan.installs = plan.installs
        .map((inst) => {
          const packages = inst.packages.filter((p) => p !== 'babel-preset-expo')
          return packages.length === inst.packages.length ? inst : { ...inst, packages, command: installCommand(project, packages, inst.dev) }
        })
        .filter((inst) => inst.packages.length)
    }
  }

  // ── By hand ──
  for (const m of plan.manual) {
    io.warn(m.reason)
    io.note(m.snippet, `${m.title}${m.file ? `: ${rel(m.file)}${m.line ? `:${m.line}` : ''}` : ''}`)
  }

  // ── Install ──
  let failed = false
  let installed = false
  if (plan.installs.length) {
    io.step('Packages')
    for (const inst of plan.installs) {
      const line = shellLine(inst.command)
      if (options.dryRun || options.skipInstall) {
        io.info(`${options.dryRun ? 'Would run' : 'Run this yourself'}: ${line}`)
        continue
      }
      const s = io.spinner(`Installing ${inst.packages.join(', ')}`)
      const [cmd, ...args] = inst.command
      // npx, npm, pnpm and yarn are .cmd scripts on Windows.
      const exe = platform === 'win32' && cmd !== 'bun' ? `${cmd}.cmd` : cmd!
      const r = await run(exe, args, { cwd: project.root })
      if (r.code === 0) {
        s.stop(`Installed ${inst.packages.join(', ')}`)
        installed = true
      } else {
        s.stop(`${line} failed (exit ${r.code})`, false)
        const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-12).join('\n')
        if (tail) io.note(tail, 'Its output')
        io.error(`Install them yourself, then run the app: ${line}`)
        failed = true
      }
    }
    if (plan.rebuild && !options.dryRun) io.warn(plan.rebuild)
  }

  // ── Agents ──
  let agentLines: string[] = []
  if (options.agents !== false) {
    if (options.dryRun) io.info('Agent integrations: not offered in a dry run.')
    else {
      try {
        agentLines = await setupAgents({ project, options: opts, io, view, relay, metro, code })
        for (const l of agentLines) io.success(l)
      } catch (e) {
        if (passThrough(e)) throw e
        io.warn(`Couldn't set up the agent integrations: ${message(e)}`)
      }
    }
  }

  // ── Check that it works ──
  const babelChanged = written.some((f) => /babel/.test(path.basename(f)))
  const anything = written.length > 0 || installed || plan.changes.length === 0
  if (!options.dryRun && !options.skipVerify && !failed && anything && (products.includes('inspector') || vitals)) {
    io.step('Check that it works')
    io.info(
      babelChanged
        ? `Start your app now, with a clean Metro cache (Babel changed): ${metroCommand(project)}`
        : `Start your app now (${project.expo ? 'npx expo start' : 'npx react-native start'}), or reload it if it is running.`,
    )
    await verifyAll(io, project, opts, { inspector: products.includes('inspector') ? view : null, relay, metro, code, key: vitalsKey }, deps)
  }

  // ── Done ──
  const next: string[] = []
  if (plan.manual.length) next.push(`${plan.manual.length} ${plan.manual.length === 1 ? 'step' : 'steps'} to do by hand, above.`)
  if (declined.length) next.push(`Not written (you said no): ${declined.map(rel).join(', ')}. Run the wizard again to see ${declined.length === 1 ? 'it' : 'them'}.`)
  if (options.skipInstall && plan.installs.length) next.push(`Install: ${plan.installs.map((i) => shellLine(i.command)).join(' && ')}`)
  if (products.includes('inspector')) {
    next.push(
      view === 'devtools'
        ? 'Inspector: start Metro, press shift+m and open @keyframerdev/inspector.'
        : view === 'desktop'
          ? 'Inspector: open the Keyframer Inspector app; your app shows in its header when it runs.'
          : `Inspector: keep ${opts.app}/editor open with its Inspector panel.`,
    )
    next.push(`Inspector docs: ${DOCS}/getting-started/react-native`)
  }
  if (vitals) {
    next.push(`Motion Vitals dashboard: ${opts.app}/app/vitals (release builds report within minutes; development builds when the project keeps them)`)
    next.push(`Motion Vitals docs: ${DOCS}/vitals/react-native`)
  }
  io.note(next.join('\n'), 'Next')
  io.outro(
    options.dryRun
      ? 'Dry run: nothing was written or installed.'
      : failed
        ? 'Almost there: the install failed, see above.'
        : plan.manual.length
          ? 'Almost there: finish the steps above by hand.'
          : 'Keyframer is set up.',
  )
  return failed ? 1 : 0
}

/** Whether `code` (of `file`) imports `target`. */
function importsFile(file: string, code: string, target: string): boolean {
  const spec = relativeImport(file, target)
  return code.includes(`'${spec}'`) || code.includes(`"${spec}"`)
}

/** Babel first, then the wizard's file, then what imports it. */
function rank(file: string, plan: Plan): number {
  if (/babel/.test(path.basename(file))) return 0
  if (file === plan.startFile) return 1
  return 2
}

function showPlan(io: Io, project: Project, plan: Plan): void {
  const rel = (f: string) => path.relative(project.root, f)
  for (const a of plan.already) io.success(a)
  for (const w of plan.warnings) io.warn(w)
  const lines: string[] = []
  for (const c of plan.changes) lines.push(`${c.before === null ? 'create' : 'change'}  ${rel(c.file)}`)
  for (const i of plan.installs) lines.push(`install ${i.packages.join(', ')}${i.dev ? ' (dev)' : ''}`)
  for (const m of plan.manual) lines.push(`by hand ${m.title}${m.file ? ` (${rel(m.file)})` : ''}`)
  if (!lines.length) {
    io.success('Everything is in place already: nothing to change.')
    return
  }
  io.note(lines.join('\n'), 'What changes')
  for (const n of plan.notes) io.info(n)
}

/**
 * The Inspector's hello, then Motion Vitals' first session. One after the other: each step draws its
 * own spinner and may ask a question, and a terminal shows one spinner at a time. The Inspector's is
 * quick (it answers on reload); the session comes when the app goes to the background.
 */
async function verifyAll(
  io: Io,
  project: Project,
  options: WizardOptions,
  what: { inspector: InspectorView | null; relay: string | null; metro: string | null; code: string | null; key: VitalsKey | null },
  deps: MainDeps,
): Promise<void> {
  const timeoutMs = deps.verifyTimeoutMs
  const results: Array<[string, VerifyResult]> = []
  const guard = async (name: string, p: () => Promise<VerifyResult>) => {
    try {
      results.push([name, await p()])
    } catch (e) {
      if (passThrough(e)) throw e
      results.push([name, { ok: false, reason: 'error', detail: message(e) }])
    }
  }
  if (what.inspector) {
    const view = what.inspector
    await guard('Inspector', () =>
      verifyInspector({ project, view, relay: what.relay, metro: what.metro, code: what.code, token: what.key?.token ?? null, api: options.api, app: options.app, io, timeoutMs, WebSocket: deps.WebSocket, fetch: deps.fetch }),
    )
  }
  if (what.key) {
    const key = what.key
    await guard('Motion Vitals', () => verifyVitals({ project, key, options, io, timeoutMs, fetch: deps.fetch }))
  }
  for (const [name, r] of results) {
    if (r.ok) io.success(`${name}: ${r.detail}`)
    else if (r.reason === 'skipped') io.info(`${name}: ${r.detail}`)
    else if (r.reason === 'timeout') io.warn(`${name}: not heard from yet. ${r.detail} Run the wizard again any time to check: the second run changes nothing.`)
    else io.error(`${name}: ${r.detail}`)
  }
}
