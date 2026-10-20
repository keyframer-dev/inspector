/**
 * Bundles the CLI into dist/cli.js (bin/keyframer-vitals.mjs runs it): one ESM file for Node 18+,
 * with the protocol constants and the symbols WebAssembly (base64, src/symbolsWasm/bytes.ts) inside,
 * so the published package has no dependencies.
 *
 * Then assembles publish/, the package as it goes to npm: dist/, bin/, the README, the license and a
 * package.json without the workspace's scripts and dev dependencies (`workspace:` versions never ship).
 *
 *   bun run build
 *   npm publish "$PWD/publish" --access public --workspaces=false      (the owner publishes)
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

rmSync('dist', { recursive: true, force: true })
const r = await Bun.build({ entrypoints: ['src/cli.ts'], outdir: 'dist', naming: 'cli.js', target: 'node', format: 'esm', minify: { syntax: true, whitespace: true } })
if (!r.success) {
  for (const log of r.logs) console.error(log)
  process.exit(1)
}
for (const o of r.outputs) console.log(`  ${o.path.replace(process.cwd() + '/', '')}  ${(o.size / 1024).toFixed(1)} KB`)

// Node built-ins only: anything else would be missing from a clean install.
const cli = readFileSync('dist/cli.js', 'utf8')
const imports = [...cli.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2]!)
const bad = imports.filter((s) => !s.startsWith('node:'))
if (bad.length || cli.includes('@keyframerdev/inspector-protocol')) {
  console.error(`build: dist/cli.js imports ${bad.join(', ') || '@keyframerdev/inspector-protocol'}`)
  process.exit(1)
}

// ── publish/ ─────────────────────────────────────────────────────────────────────────
rmSync('publish', { recursive: true, force: true })
mkdirSync('publish', { recursive: true })
for (const d of ['dist', 'bin']) cpSync(d, `publish/${d}`, { recursive: true })
for (const f of ['README.md', 'LICENSE']) cpSync(f, `publish/${f}`)
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const manifest = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  keywords: ['keyframer', 'motion-vitals', 'symbols', 'dsym', 'r8', 'flutter', 'react-native', 'cli'],
  homepage: 'https://keyframer.dev/inspector/docs/vitals/symbols',
  repository: { type: 'git', url: 'git+https://github.com/keyframer-dev/inspector.git', directory: 'vitals-cli' },
  bugs: 'https://github.com/keyframer-dev/inspector/issues',
  license: 'MIT',
  author: 'Catalin Miron',
  type: 'module',
  bin: pkg.bin,
  files: ['bin', 'dist', 'README.md', 'LICENSE'],
  engines: pkg.engines,
}
writeFileSync('publish/package.json', `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`  publish/  ${pkg.name}@${pkg.version}`)
