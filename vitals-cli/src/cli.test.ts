import { createServer, type IncomingMessage } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { main, type Io } from './cli'

const FIX = path.resolve(__dirname, '../../protocol/fixtures/vitals/symbols')
const IN = path.join(FIX, 'inputs')
const EXPECTED = path.join(FIX, 'expected')

type Captured = Io & { out: string[]; err: string[] }
function io(extra: Partial<Io> = {}): Captured {
  const out: string[] = []
  const err: string[] = []
  return { out, err, log: (l) => out.push(l), error: (l) => err.push(l), env: { SOURCE_DATE_EPOCH: '0' }, backoffMs: 1, ...extra }
}

const tmps: string[] = []
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'kf-vitals-cli-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Every file under a folder, relative, sorted. */
function tree(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(path.relative(dir, p))
    }
  }
  walk(dir)
  return out.sort()
}

const CASES: Array<[string, string[]]> = [
  ['dsym-tiny', ['--dsym', path.join(IN, 'Tiny.dSYM')]],
  ['dsym-card', ['--dsym', path.join(IN, 'Card.dSYM'), '--no-swift-demangle']],
  ['elf', ['--elf', path.join(IN, 'app.android-arm64.symbols')]],
  ['r8', ['--mapping', path.join(IN, 'mapping.txt'), '--app-version', '1.4.0', '--build', '212']],
  ['r8-sharded', ['--mapping', path.join(IN, 'mapping.txt'), '--app-version', '1.4.0', '--build', '212', '--chunk-budget', '600']],
  ['rn-sites', ['--rn-sites', path.join(IN, 'sites-1.4.0+212.json')]],
]

describe('symbols upload --dry-run', () => {
  it.each(CASES)('%s matches the golden fixture', async (name, args) => {
    const out = tmp()
    const c = io()
    expect(await main(['symbols', 'upload', ...args, '--dry-run', '--out', out], c)).toBe(0)
    const want = path.join(EXPECTED, name)
    expect(tree(out)).toEqual(tree(want))
    for (const f of tree(want)) {
      const got = readFileSync(path.join(out, f), 'utf8')
      const exp = readFileSync(path.join(want, f), 'utf8')
      if (f.endsWith('manifest.json')) {
        // Byte for byte once the CLI's own version is set to the fixtures' one.
        const m = JSON.parse(got)
        expect(m.cli.name).toBe('keyframer-vitals')
        m.cli.version = '0.0.0-fixture'
        expect(JSON.stringify(m)).toBe(exp)
      } else {
        expect(got).toBe(exp)
      }
    }
  })

  it('finds dSYM bundles inside a folder', async () => {
    const c = io()
    expect(await main(['symbols', 'upload', '--dsym', IN, '--dry-run', '--no-swift-demangle'], c)).toBe(0)
    expect(c.out.join('\n')).toMatch(/macho 8f69955161a838ff9b5a2f258e1f3124 \(Card arm64\)/)
    expect(c.out.join('\n')).toMatch(/macho 3c612e63ac043ff49a44204bed4b5465 \(Tiny arm64\)/)
    expect(c.out.join('\n')).toMatch(/macho 0b5cdfb9082732b9bfcb426b398b3248 \(Tiny x86_64\)/)
  })

  it('takes a bare Mach-O file with DWARF (Flutter app.ios-arm64.symbols)', async () => {
    const c = io()
    expect(await main(['symbols', 'upload', '--dsym', path.join(IN, 'Tiny.dSYM/Contents/Resources/DWARF/Tiny'), '--dry-run'], c)).toBe(0)
    expect(c.out.join('\n')).toMatch(/macho 3c612e63ac043ff49a44204bed4b5465 \(Tiny arm64\)/)
    const d = io()
    expect(await main(['symbols', 'inspect', path.join(IN, 'Tiny.dSYM/Contents/Resources/DWARF/Tiny')], d)).toBe(0)
    expect(d.out.join('\n')).toMatch(/macho {2}arm64 {2}3c612e63ac043ff49a44204bed4b5465/)
  })

  it('skips *.symbols of the other kind in a folder', async () => {
    const c = io()
    expect(await main(['symbols', 'upload', '--dsym', IN, '--dry-run', '--no-swift-demangle'], c)).toBe(0)
    expect(c.err.join('\n')).toMatch(/skipped .*app\.android-arm64\.symbols: an ELF file/)
  })

  it('demangles Swift names with the demangler it is given', async () => {
    const out = tmp()
    const c = io({ swiftDemangle: (names) => Object.fromEntries(names.map((n) => [n, `swift:${n}`])) })
    expect(await main(['symbols', 'upload', '--dsym', path.join(IN, 'Card.dSYM'), '--dry-run', '--out', out], c)).toBe(0)
    const dir = path.join(out, 'macho/8f69955161a838ff9b5a2f258e1f3124')
    expect(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')).mangled).toBeUndefined()
    const names: string[] = JSON.parse(readFileSync(path.join(dir, '0000.json'), 'utf8')).names
    expect(names.some((n) => n.startsWith('$s'))).toBe(false)
    expect(names).toContain('swift:$s4Card06expandA0yS2dF')
  })

  it.runIf(process.platform === 'darwin')('demangles Swift names with xcrun swift-demangle on macOS', async () => {
    const out = tmp()
    const c = io()
    expect(await main(['symbols', 'upload', '--dsym', path.join(IN, 'Card.dSYM'), '--dry-run', '--out', out], c)).toBe(0)
    const dir = path.join(out, 'macho/8f69955161a838ff9b5a2f258e1f3124')
    const names: string[] = JSON.parse(readFileSync(path.join(dir, '0000.json'), 'utf8')).names
    // Without Xcode the CLI says so and keeps them mangled.
    if (c.err.some((l) => l.includes('kept mangled'))) return
    expect(names).toContain('expandCard(_:)')
    expect(names).toContain('CardAnimation.step(_:)')
  })

  it('needs a version for a mapping', async () => {
    const c = io()
    expect(await main(['symbols', 'upload', '--mapping', path.join(IN, 'mapping.txt'), '--dry-run'], c)).toBe(2)
    expect(c.err[0]).toMatch(/--app-version and --build/)
  })

  it('needs a kft_ key to upload', async () => {
    const c = io()
    expect(await main(['symbols', 'upload', '--rn-sites', path.join(IN, 'sites-1.4.0+212.json')], c)).toBe(2)
    expect(c.err[0]).toMatch(/no upload key/)
    const d = io()
    expect(await main(['symbols', 'upload', '--rn-sites', path.join(IN, 'sites-1.4.0+212.json'), '--key', 'kfp_live_abc'], d)).toBe(2)
    expect(d.err[0]).toMatch(/field key/)
  })

  it('says what is wrong with a file that is not a symbol file', async () => {
    const c = io()
    expect(await main(['symbols', 'upload', '--elf', path.join(IN, 'mapping.txt'), '--dry-run'], c)).toBe(1)
    expect(c.err[0]).toMatch(/not a symbol file/)
    const d = io()
    expect(await main(['symbols', 'upload', '--elf', path.join(IN, 'Tiny.dSYM/Contents/Resources/DWARF/Tiny'), '--dry-run'], d)).toBe(1)
    expect(d.err[0]).toMatch(/pass it with --dsym/)
  })
})

describe('symbols inspect', () => {
  it('prints debug ids and architectures', async () => {
    const c = io()
    expect(await main(['symbols', 'inspect', path.join(IN, 'Tiny.dSYM'), path.join(IN, 'app.android-arm64.symbols'), path.join(IN, 'sites-1.4.0+212.json')], c)).toBe(0)
    const text = c.out.join('\n')
    expect(text).toMatch(/macho {2}x86_64 {2}0b5cdfb9082732b9bfcb426b398b3248/)
    expect(text).toMatch(/macho {2}arm64 {2}3c612e63ac043ff49a44204bed4b5465/)
    expect(text).toMatch(/elf {2}arm64 {2}c3f9ee9a3fa0587cfd669fda94ae06946a4e87c2/)
    expect(text).toMatch(/rn-sites {2}1\.4\.0\+212 {2}4 sites/)
  })
})

type Seen = { method: string; url: string; auth?: string; encoding?: string; body: Buffer }

async function server(respond: (req: Seen, n: number) => number) {
  const seen: Seen[] = []
  const srv = createServer((req: IncomingMessage, res) => {
    const parts: Buffer[] = []
    req.on('data', (d: Buffer) => parts.push(d))
    req.on('end', () => {
      const s: Seen = { method: req.method!, url: req.url!, auth: req.headers.authorization, encoding: req.headers['content-encoding'] as string | undefined, body: Buffer.concat(parts) }
      seen.push(s)
      const status = respond(s, seen.length)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(status === 200 ? '{"ok":true}' : `{"ok":false,"error":"status ${status}"}`)
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  return { url, seen, close: () => new Promise<void>((r) => srv.close(() => r())) }
}

describe('symbols upload', () => {
  const SHARDED = ['--mapping', path.join(IN, 'mapping.txt'), '--app-version', '1.4.0', '--build', '212', '--chunk-budget', '600']

  it('puts every chunk gzipped, then posts the manifest', async () => {
    const s = await server(() => 200)
    try {
      const c = io({ env: { SOURCE_DATE_EPOCH: '0', KEYFRAMER_VITALS_UPLOAD_KEY: 'kft_test' } })
      expect(await main(['symbols', 'upload', ...SHARDED, '--endpoint', s.url], c)).toBe(0)
      expect(s.seen.map((r) => `${r.method} ${r.url}`)).toEqual(
        expect.arrayContaining(['PUT /v1/symbols/r8/1.4.0%2B212/0000.json', 'PUT /v1/symbols/r8/1.4.0%2B212/0001.json']),
      )
      expect(s.seen).toHaveLength(3)
      expect(`${s.seen[2].method} ${s.seen[2].url}`).toBe('POST /v1/symbols/r8/1.4.0%2B212/manifest')
      for (const r of s.seen) expect(r.auth).toBe('Bearer kft_test')
      const dir = path.join(EXPECTED, 'r8-sharded/r8/1.4.0+212')
      for (const r of s.seen.slice(0, 2)) {
        expect(r.encoding).toBe('gzip')
        expect(gunzipSync(r.body).toString('utf8')).toBe(readFileSync(path.join(dir, path.basename(r.url)), 'utf8'))
      }
      expect(JSON.parse(s.seen[2].body.toString('utf8')).chunks).toHaveLength(2)
    } finally {
      await s.close()
    }
  })

  it('retries a server error and goes on', async () => {
    const s = await server((_, n) => (n === 1 ? 503 : 200))
    try {
      const c = io()
      expect(await main(['symbols', 'upload', '--rn-sites', path.join(IN, 'sites-1.4.0+212.json'), '--key', 'kft_x', '--endpoint', s.url], c)).toBe(0)
      expect(s.seen).toHaveLength(3)
      expect(c.out.join('\n')).toMatch(/retrying chunk 0000\.json/)
    } finally {
      await s.close()
    }
  })

  it('stops at a refused key with what to do', async () => {
    const s = await server(() => 401)
    try {
      const c = io()
      expect(await main(['symbols', 'upload', '--rn-sites', path.join(IN, 'sites-1.4.0+212.json'), '--key', 'kft_wrong', '--endpoint', s.url], c)).toBe(3)
      expect(s.seen).toHaveLength(1)
      expect(c.err[0]).toMatch(/upload key was refused \(401\)/)
      expect(c.err[0]).toMatch(/KEYFRAMER_VITALS_UPLOAD_KEY/)
    } finally {
      await s.close()
    }
  })

  it('stops at a chunk the server finds too large', async () => {
    const s = await server(() => 413)
    try {
      const c = io()
      expect(await main(['symbols', 'upload', '--rn-sites', path.join(IN, 'sites-1.4.0+212.json'), '--key', 'kft_x', '--endpoint', s.url], c)).toBe(3)
      expect(c.err[0]).toMatch(/chunk 0000\.json of rn-sites 1\.4\.0\+212 is too large for the server \(413\)/)
    } finally {
      await s.close()
    }
  })
})
