/**
 * Bundles the wizard into dist/cli.js (bin/keyframer-wizard.mjs runs it): one ESM file for Node 20+,
 * with clack, recast, the Babel parser and ws inside, so `npx @keyframerdev/wizard` installs nothing
 * but this package.
 *
 * Then assembles publish/, the package as it goes to npm: dist/, bin/, the README, the license and a
 * package.json without the workspace's scripts and dev dependencies (`workspace:` versions never ship).
 *
 *   bun run build
 *   bun scripts/publish-npm.ts wizard          (from inspector/; the owner publishes)
 */
import { builtinModules } from 'node:module'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

/** ws loads these native speedups when they are installed, inside a try: without them it works the same. */
const OPTIONAL = ['bufferutil', 'utf-8-validate']

rmSync('dist', { recursive: true, force: true })
const r = await Bun.build({
  entrypoints: ['src/cli.ts'],
  outdir: 'dist',
  naming: 'cli.js',
  target: 'node',
  format: 'esm',
  external: OPTIONAL,
  minify: { syntax: true, whitespace: true },
})
if (!r.success) {
  for (const log of r.logs) console.error(log)
  process.exit(1)
}
for (const o of r.outputs) console.log(`  ${o.path.replace(process.cwd() + '/', '')}  ${(o.size / 1024).toFixed(1)} KB`)

// Node built-ins only (and ws's optional speedups): anything else would be missing from a clean install.
const cli = readFileSync('dist/cli.js', 'utf8')
const builtins = new Set(builtinModules)
// Statements only: the bundled parsers and the wizard's own templates have `from '…'` inside strings.
const specifiers = [
  ...cli.matchAll(/(?:^|[;}\n])import\s*(?:[\w$*{},\s]*?\bfrom\s*)?["']([^"']+)["']/g),
  ...cli.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ...cli.matchAll(/\b__require\(\s*["']([^"']+)["']\s*\)/g),
].map((m) => m[1]!)
const bad = [...new Set(specifiers)].filter((s) => !s.startsWith('node:') && !builtins.has(s) && !OPTIONAL.includes(s))
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
  keywords: ['keyframer', 'inspector', 'motion-vitals', 'react-native', 'expo', 'reanimated', 'setup', 'wizard', 'cli'],
  homepage: 'https://keyframer.dev/inspector/docs/getting-started/react-native',
  repository: { type: 'git', url: 'git+https://github.com/keyframer-dev/inspector.git', directory: 'wizard' },
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
