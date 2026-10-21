/**
 * The fixture apps in test/fixtures, copied to a temporary folder for each run (the copies are what the
 * wizard edits), and the app's files read back as a map, for snapshots and "a second run changes
 * nothing". For tests only; the CLI never imports it.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURES = fileURLToPath(new URL('../test/fixtures', import.meta.url))

/** A fresh copy of a fixture. `expoSdk`: also an installed expo of that version in node_modules. */
export function copyFixture(name: string, opts: { expoSdk?: number; git?: 'clean' | 'dirty' } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), `kf-wizard-${name}-`))
  cpSync(path.join(FIXTURES, name), dir, { recursive: true })
  if (opts.expoSdk) {
    mkdirSync(path.join(dir, 'node_modules/expo'), { recursive: true })
    writeFileSync(path.join(dir, 'node_modules/expo/package.json'), JSON.stringify({ name: 'expo', version: `${opts.expoSdk}.0.10` }))
  }
  if (opts.git) {
    const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    git('init', '-q')
    git('add', '-A')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture')
    if (opts.git === 'dirty') writeFileSync(path.join(dir, 'NOTES.md'), 'work in progress\n')
  }
  return dir
}

/** A small app written from `files` (relative path to text) in a new temporary folder. */
export function writeApp(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kf-wizard-app-'))
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    writeFileSync(path.join(dir, f), text)
  }
  return dir
}

/** Every file below `dir` (not node_modules or .git), relative path to text. */
export function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      if (e === 'node_modules' || e === '.git') continue
      const p = path.join(d, e)
      if (statSync(p).isDirectory()) walk(p)
      else out[path.relative(dir, p)] = readFileSync(p, 'utf8')
    }
  }
  walk(dir)
  return out
}

/** The files a run created or changed, against the fixture it was copied from. */
export function changedFiles(name: string, dir: string, sub = ''): Record<string, string> {
  const before = readTree(path.join(FIXTURES, name, sub))
  const after = readTree(path.join(dir, sub))
  const out: Record<string, string> = {}
  for (const [f, text] of Object.entries(after)) if (before[f] !== text) out[f] = text
  return out
}
