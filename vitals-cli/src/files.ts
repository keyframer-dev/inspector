/** Finding the symbol files a path stands for. */
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/** `searched`: found inside a folder (a file of the other kind is skipped there, not an error). */
export type FoundFile = { path: string; name: string; searched?: boolean }

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function exists(p: string): boolean {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

function sortedEntries(dir: string): string[] {
  return readdirSync(dir).sort()
}

/** The DWARF files inside one .dSYM bundle. */
function dsymBundle(bundle: string): FoundFile[] {
  const dwarf = path.join(bundle, 'Contents/Resources/DWARF')
  if (!isDir(dwarf)) return []
  return sortedEntries(dwarf)
    .filter((f) => !f.startsWith('.') && !isDir(path.join(dwarf, f)))
    .map((f) => ({ path: path.join(dwarf, f), name: f }))
}

function walk(dir: string, depth: number, match: (p: string, dir: boolean) => 'take' | 'skip' | 'descend', out: string[]) {
  if (depth < 0) return
  for (const entry of sortedEntries(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue
    const p = path.join(dir, entry)
    const d = isDir(p)
    const m = match(p, d)
    if (m === 'take') out.push(p)
    else if (m === 'descend' && d) walk(p, depth - 1, match, out)
  }
}

/**
 * `--dsym`: a .dSYM bundle, any Mach-O file with DWARF (the DWARF file inside a bundle, Flutter's
 * `app.ios-arm64.symbols`), or a folder holding .dSYM bundles (Xcode's DWARF_DSYM_FOLDER_PATH, an
 * archive's dSYMs folder) and `*.symbols` files, searched a few levels deep.
 */
export function findDsyms(input: string): FoundFile[] {
  if (!exists(input)) throw new Error(`no such file or folder: ${input}`)
  if (!isDir(input)) return [{ path: input, name: path.basename(input) }]
  if (input.replace(/\/+$/, '').endsWith('.dSYM')) return dsymBundle(input)
  const found: string[] = []
  walk(input, 4, (p, d) => (d ? (p.endsWith('.dSYM') ? 'take' : 'descend') : p.endsWith('.symbols') ? 'take' : 'skip'), found)
  return found.flatMap((p) => (p.endsWith('.dSYM') ? dsymBundle(p) : [{ path: p, name: path.basename(p), searched: true }]))
}

/** `--elf`: an ELF file, or a folder of them (Flutter's --split-debug-info folder: *.symbols). */
export function findElfs(input: string): FoundFile[] {
  if (!exists(input)) throw new Error(`no such file or folder: ${input}`)
  if (!isDir(input)) return [{ path: input, name: path.basename(input) }]
  const files: string[] = []
  walk(input, 2, (p, d) => (d ? 'descend' : /\.(symbols|so|debug)$/.test(p) ? 'take' : 'skip'), files)
  return files.map((p) => ({ path: p, name: path.basename(p), searched: true }))
}
