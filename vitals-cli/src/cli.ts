/**
 * keyframer-vitals: Motion Vitals from the command line.
 *
 *   keyframer-vitals symbols upload --dsym <path> | --elf <path> | --rn-sites <path>
 *                                   | --mapping <path> --app-version <v> --build <b> [--debug-id <id>]
 *                                   [--key kft_…] [--endpoint <url>] [--dry-run [--out <dir>]]
 *   keyframer-vitals symbols inspect <path>
 *
 * Symbol files are turned into a manifest and chunks on this machine (WebAssembly, no native module),
 * then uploaded; the server never parses them.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { VITALS_ENDPOINT } from '../../protocol/vitals'
import { version as pkgVersion } from '../package.json'
import { findDsyms, findElfs, type FoundFile } from './files'
import { swiftNames, buildNative, buildR8, buildSites, inspectObjects, type BuildOptions, type SymbolSet } from './symbols'
import { xcrunSwiftDemangle, type SwiftDemangler } from './swift'
import { gzipChunk, MAX_CHUNK_GZIP, uploadSet, UploadError } from './upload'

export const CLI_NAME = 'keyframer-vitals'
export const CLI_VERSION: string = pkgVersion

export type Io = {
  log: (line: string) => void
  error: (line: string) => void
  env: Record<string, string | undefined>
  fetch?: typeof fetch
  swiftDemangle?: SwiftDemangler
  /** Milliseconds before the first upload retry (tests make it small). */
  backoffMs?: number
}

const HELP = `keyframer-vitals ${CLI_VERSION}: Motion Vitals symbol uploads

Usage:
  keyframer-vitals symbols upload [sources] [options]
  keyframer-vitals symbols inspect <path>

Sources (any number, each flag may repeat):
  --dsym <path>          a .dSYM bundle, its DWARF file, or a folder of .dSYM bundles
  --elf <path>           an ELF file with DWARF, or a folder of them (Flutter --split-debug-info)
  --mapping <path>       an R8 mapping.txt; needs --app-version and --build, or --debug-id
  --rn-sites <path>      a React Native sites file (.keyframer/sites-<version>+<build>.json)

Options:
  --app-version <v>      the app version (mapping; also recorded with other sources)
  --build <b>            the build number
  --app-id <id>          the bundle id or package name, recorded in the manifest
  --debug-id <id>        the debug id for a mapping (the Gradle plugin's build id), an ELF without
                         a build id, or a sites file
  --key <kft_…>          the project's CI upload key (or KEYFRAMER_VITALS_UPLOAD_KEY)
  --endpoint <url>       default ${VITALS_ENDPOINT} (or KEYFRAMER_VITALS_ENDPOINT)
  --dry-run              build everything, upload nothing
  --out <dir>            with --dry-run: write <dir>/<kind>/<debugId>/manifest.json and the chunks
  --no-swift-demangle    keep Swift names mangled (they are demangled with xcrun swift-demangle on macOS)
  --concurrency <n>      chunks uploaded at once (default 4)
  -h, --help             this help
  -v, --version          the version
`

class UsageError extends Error {}

function createdAt(env: Io['env']): string {
  const epoch = env.SOURCE_DATE_EPOCH
  if (epoch && /^\d+$/.test(epoch)) return new Date(Number(epoch) * 1000).toISOString()
  return new Date().toISOString()
}

function readBytes(p: string): Uint8Array {
  return new Uint8Array(readFileSync(p))
}

type Upload = {
  dsym: string[]
  elf: string[]
  mapping: string[]
  rnSites: string[]
  appVersion?: string
  build?: string
  appId?: string
  debugId?: string
  noSwiftDemangle: boolean
  chunkBudget?: number
}

function baseOptions(u: Upload, env: Io['env']): BuildOptions {
  const app = { id: u.appId, version: u.appVersion, build: u.build }
  return {
    createdAt: createdAt(env),
    cli: { name: CLI_NAME, version: CLI_VERSION },
    app: app.id || app.version || app.build ? app : undefined,
    chunkBudget: u.chunkBudget,
  }
}

function nativeSets(files: FoundFile[], u: Upload, io: Io, kind: 'macho' | 'elf'): SymbolSet[] {
  const sets: SymbolSet[] = []
  for (const f of files) {
    const bytes = readBytes(f.path)
    const objects = inspectObjects(bytes)
    if (f.searched && objects.some((o) => o.kind !== kind)) {
      io.error(`note: skipped ${f.path}: ${kind === 'macho' ? 'an ELF' : 'a Mach-O'} file (pass it with --${kind === 'macho' ? 'elf' : 'dsym'})`)
      continue
    }
    for (const o of objects) {
      if (o.kind !== kind) throw new Error(`${f.path} is a ${o.kind === 'macho' ? 'Mach-O' : 'ELF'} file: pass it with --${o.kind === 'macho' ? 'dsym' : 'elf'}`)
      if (!o.hasDwarf) {
        io.error(`warning: ${f.path}${o.arch ? ` (${o.arch})` : ''} has no DWARF line table: only symbol names will resolve`)
      }
      const opts: BuildOptions = { ...baseOptions(u, io.env), name: f.name }
      if (kind === 'elf' && u.debugId && !o.debugId) opts.debugId = u.debugId
      if (kind === 'macho' && !u.noSwiftDemangle) {
        const names = swiftNames(bytes, o.index)
        if (names.length > 0) {
          const map = (io.swiftDemangle ?? xcrunSwiftDemangle)(names)
          if (map) opts.swiftNames = map
          else io.error(`note: ${names.length} Swift names kept mangled (swift-demangle needs macOS with Xcode); the dashboard shows them as they are`)
        }
      }
      const set = buildNative(bytes, o.index, opts)
      for (const w of set.warnings) io.error(`warning: ${f.name}${o.arch ? ` (${o.arch})` : ''}: ${w}`)
      sets.push(set)
    }
  }
  return sets
}

function buildAll(u: Upload, io: Io): SymbolSet[] {
  const sets: SymbolSet[] = []
  for (const input of u.dsym) {
    const files = findDsyms(input)
    if (files.length === 0) throw new Error(`no dSYM found in ${input}`)
    sets.push(...nativeSets(files, u, io, 'macho'))
  }
  for (const input of u.elf) {
    const files = findElfs(input)
    if (files.length === 0) throw new Error(`no ELF symbol files (*.symbols, *.so, *.debug) found in ${input}`)
    sets.push(...nativeSets(files, u, io, 'elf'))
  }
  for (const input of u.mapping) {
    if (!u.debugId && !(u.appVersion && u.build)) throw new UsageError('--mapping needs --app-version and --build (or --debug-id)')
    sets.push(buildR8(readFileSync(input, 'utf8'), { ...baseOptions(u, io.env), debugId: u.debugId }))
  }
  for (const input of u.rnSites) {
    sets.push(buildSites(readFileSync(input, 'utf8'), { ...baseOptions(u, io.env), debugId: u.debugId }))
  }
  return sets
}

function describe(set: SymbolSet): string {
  const m = set.manifest
  const gz = set.chunks.reduce((n, c) => n + gzipChunk(c.json).length, 0)
  const what = [m.name, m.arch].filter(Boolean).join(' ')
  return `${set.kind} ${set.debugId}${what ? ` (${what})` : ''}: ${set.chunks.length} chunk${set.chunks.length === 1 ? '' : 's'}, ${(gz / 1024).toFixed(1)} KB gzipped${m.mangled?.length ? `, ${m.mangled.join(', ')} names mangled` : ''}`
}

function checkSizes(set: SymbolSet) {
  for (const c of set.chunks) {
    const n = gzipChunk(c.json).length
    if (n > MAX_CHUNK_GZIP) throw new Error(`chunk ${c.file} of ${set.kind} ${set.debugId} is ${n} bytes gzipped, over the ${MAX_CHUNK_GZIP} byte limit`)
  }
}

async function upload(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      dsym: { type: 'string', multiple: true },
      elf: { type: 'string', multiple: true },
      mapping: { type: 'string', multiple: true },
      'rn-sites': { type: 'string', multiple: true },
      'app-version': { type: 'string' },
      build: { type: 'string' },
      'app-id': { type: 'string' },
      'debug-id': { type: 'string' },
      key: { type: 'string' },
      endpoint: { type: 'string' },
      'dry-run': { type: 'boolean' },
      out: { type: 'string' },
      'no-swift-demangle': { type: 'boolean' },
      concurrency: { type: 'string' },
      // Bytes of JSON per chunk; for tests and fixtures.
      'chunk-budget': { type: 'string' },
    },
  })
  const u: Upload = {
    dsym: values.dsym ?? [],
    elf: values.elf ?? [],
    mapping: values.mapping ?? [],
    rnSites: values['rn-sites'] ?? [],
    appVersion: values['app-version'],
    build: values.build,
    appId: values['app-id'],
    debugId: values['debug-id'],
    noSwiftDemangle: !!values['no-swift-demangle'],
    chunkBudget: values['chunk-budget'] ? Number(values['chunk-budget']) : undefined,
  }
  if (u.dsym.length + u.elf.length + u.mapping.length + u.rnSites.length === 0) throw new UsageError('nothing to upload: pass --dsym, --elf, --mapping or --rn-sites')
  if (values.out && !values['dry-run']) throw new UsageError('--out works with --dry-run')
  const dryRun = !!values['dry-run']
  const key = values.key ?? io.env.KEYFRAMER_VITALS_UPLOAD_KEY
  if (!dryRun) {
    if (!key) throw new UsageError('no upload key: pass --key kft_… or set KEYFRAMER_VITALS_UPLOAD_KEY (the project CI key from the Motion Vitals dashboard)')
    if (key.startsWith('kfp_')) throw new UsageError('that is the field key the app ships (kfp_…); symbol uploads need the project CI key (kft_…)')
    if (!key.startsWith('kft_')) io.error('warning: upload keys start with kft_; sending it anyway')
  }

  const sets = buildAll(u, io)
  for (const s of sets) checkSizes(s)

  if (dryRun) {
    for (const s of sets) {
      io.log(describe(s))
      if (values.out) {
        const dir = path.join(values.out, s.kind, s.debugId)
        mkdirSync(dir, { recursive: true })
        for (const c of s.chunks) writeFileSync(path.join(dir, c.file), c.json)
        writeFileSync(path.join(dir, 'manifest.json'), s.manifestJson)
      }
    }
    if (values.out) io.log(`wrote ${sets.length} symbol set${sets.length === 1 ? '' : 's'} to ${values.out}`)
    return 0
  }

  const endpoint = values.endpoint ?? io.env.KEYFRAMER_VITALS_ENDPOINT ?? VITALS_ENDPOINT
  const concurrency = values.concurrency ? Math.max(1, Number(values.concurrency) || 4) : 4
  for (const s of sets) {
    await uploadSet(s, { endpoint, key: key!, concurrency, fetch: io.fetch, log: io.log, backoffMs: io.backoffMs })
    io.log(`uploaded ${describe(s)}`)
  }
  return 0
}

function inspect(args: string[], io: Io): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} })
  if (positionals.length === 0) throw new UsageError('symbols inspect needs a path')
  for (const input of positionals) {
    if (/\.json$/.test(input)) {
      const v = JSON.parse(readFileSync(input, 'utf8')) as { format?: string; app?: { version?: string; build?: string }; sites?: Record<string, unknown> }
      if (v.format !== 'keyframer-vitals-sites') throw new Error(`${input} is not a sites file`)
      const id = [v.app?.version, v.app?.build].filter(Boolean).join('+')
      io.log(`${input}\n  rn-sites  ${id}  ${Object.keys(v.sites ?? {}).length} sites`)
      continue
    }
    if (/\.txt$/.test(input)) {
      const text = readFileSync(input, 'utf8')
      const mapId = /^# pg_map_id: (\S+)/m.exec(text)?.[1]
      const classes = text.split('\n').filter((l) => /^\S.* -> .*:$/.test(l)).length
      io.log(`${input}\n  r8  ${classes} classes${mapId ? `  pg_map_id ${mapId}` : ''}  (debug id: the Gradle plugin's build id, or <app version>+<build>)`)
      continue
    }
    let files = findDsyms(input)
    if (files.length === 0) files = findElfs(input)
    if (files.length === 0) throw new Error(`no symbol files found in ${input}`)
    for (const f of files) {
      io.log(f.path)
      for (const o of inspectObjects(readBytes(f.path))) {
        io.log(`  ${o.kind}  ${o.arch ?? '?'}  ${o.debugId || '(no debug id)'}${o.hasDwarf ? '' : '  (no DWARF)'}`)
      }
    }
  }
  return 0
}

/** Runs the CLI; answers the exit code. */
export async function main(argv: string[], io: Io = { log: console.log, error: console.error, env: process.env }): Promise<number> {
  try {
    if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
      io.log(HELP)
      return 0
    }
    if (argv[0] === '-v' || argv[0] === '--version') {
      io.log(CLI_VERSION)
      return 0
    }
    if (argv[0] !== 'symbols' || !['upload', 'inspect'].includes(argv[1])) throw new UsageError(`unknown command: ${argv.slice(0, 2).join(' ')}`)
    if (argv.includes('-h') || argv.includes('--help')) {
      io.log(HELP)
      return 0
    }
    return argv[1] === 'upload' ? await upload(argv.slice(2), io) : inspect(argv.slice(2), io)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    io.error(`keyframer-vitals: ${msg}`)
    if (e instanceof UsageError || (e instanceof TypeError && /option|argument/i.test(msg))) {
      io.error('run keyframer-vitals --help for usage')
      return 2
    }
    return e instanceof UploadError ? 3 : 1
  }
}
