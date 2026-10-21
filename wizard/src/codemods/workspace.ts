/**
 * The app's source files while a plan is made: each file is read and parsed once, every codemod adds
 * its edits to the same Splicer, and the plan reads back what changed. Nothing is written here.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type * as t from '@babel/types'
import { detectStyle, parseSource, Splicer, type Style } from './source'

export type Edited = { file: string; code: string; ast: t.File; style: Style; sp: Splicer }

/** A file the plan creates or changes. `before` is null for a new file. */
export type FileChange = { file: string; before: string | null; after: string; why: string[] }

/** Something the wizard didn't change: where, why, and what to paste. */
export type ManualStep = { title: string; file: string | null; line?: number; reason: string; snippet: string }

export class Workspace {
  private files = new Map<string, Edited>()
  private why = new Map<string, string[]>()
  private created = new Map<string, { after: string; why: string[] }>()

  constructor(readonly root: string) {}

  /** The file, parsed. Throws a SyntaxError when it doesn't parse. */
  get(file: string): Edited {
    let e = this.files.get(file)
    if (!e) {
      const code = readFileSync(file, 'utf8')
      const ast = parseSource(code)
      e = { file, code, ast, style: detectStyle(code, ast), sp: new Splicer(code) }
      this.files.set(file, e)
    }
    return e
  }

  /** The file, or null when it doesn't parse. */
  tryGet(file: string): Edited | null {
    try {
      return this.get(file)
    } catch {
      return null
    }
  }

  /** Says why a file changes (shown above its diff). */
  because(file: string, why: string): void {
    const list = this.why.get(file) ?? []
    if (!list.includes(why)) list.push(why)
    this.why.set(file, list)
  }

  create(file: string, after: string, why: string): void {
    this.created.set(file, { after, why: [why] })
  }

  changes(): FileChange[] {
    const out: FileChange[] = []
    for (const [file, { after, why }] of this.created) {
      const before = existsSync(file) ? readFileSync(file, 'utf8') : null
      if (before !== after) out.push({ file, before, after, why })
    }
    for (const e of this.files.values()) {
      if (!e.sp.changed) continue
      const after = e.sp.apply()
      if (after !== e.code) out.push({ file: e.file, before: e.code, after, why: this.why.get(e.file) ?? [] })
    }
    return out
  }
}

const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', 'dist', 'build', 'web-build', 'coverage', '__tests__', '__mocks__', 'Pods', 'vendor'])
const SOURCE = /\.(tsx?|jsx?)$/
const NOT_SOURCE = /\.(d\.ts|test\.[jt]sx?|spec\.[jt]sx?|stories\.[jt]sx?)$/

/** The app's own source files (no node_modules, native folders, builds or tests), at most `limit`. */
export function sourceFiles(root: string, limit = 5000): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const e of entries.sort()) {
      if (out.length >= limit) return
      if (e.startsWith('.')) continue
      const p = path.join(dir, e)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(e)) walk(p)
      } else if (SOURCE.test(e) && !NOT_SOURCE.test(e) && !/^(babel|metro|jest|eslint|prettier|tailwind|app)\.config\./.test(e) && e !== '.babelrc.js') out.push(p)
    }
  }
  walk(root)
  return out
}

/** Source files whose text matches `re`, cheap to find before parsing any. */
export function filesMatching(root: string, re: RegExp, except: string[] = []): string[] {
  return sourceFiles(root).filter((f) => !except.includes(f) && re.test(safeRead(f)))
}

function safeRead(f: string): string {
  try {
    return readFileSync(f, 'utf8')
  } catch {
    return ''
  }
}
