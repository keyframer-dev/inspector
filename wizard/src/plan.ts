/**
 * The plan: every file the wizard would create or change (with its diff), what it would install, and
 * what it leaves to the person (with the snippet to paste), made before anything is written. Applying
 * it writes each file atomically (a temporary file renamed over the old one), so a stopped run never
 * leaves half a file.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { planBabel } from './codemods/babel'
import { planPackages, rebuildAdvice, type Install } from './codemods/packages'
import { planStart, type StartChoices } from './codemods/start'
import { Workspace, type FileChange, type ManualStep } from './codemods/workspace'
import type { Product, Project } from './types'

export type Plan = {
  changes: FileChange[]
  installs: Install[]
  manual: ManualStep[]
  /** Said along the way: what was used, what is optional. */
  notes: string[]
  /** Said loudly: what the app needs before Keyframer works. */
  warnings: string[]
  /** What to rebuild after installing, or null. */
  rebuild: string | null
  /** Already set up: one line each. */
  already: string[]
  /** The wizard's own file, when there is one. */
  startFile: string | null
}

export function makePlan(project: Project, choices: StartChoices): Plan {
  const ws = new Workspace(project.root)
  const notes: string[] = []
  const warnings: string[] = []
  const manual: ManualStep[] = []
  const already: string[] = []
  const rel = (f: string) => path.relative(project.root, f)

  // Babel: only for what the app will run (Vitals without a key is skipped).
  const products: Product[] = choices.products.filter((p) => p !== 'vitals' || !!choices.key)
  const babel = planBabel(project, products)
  if (babel.kind === 'create') ws.create(babel.file, babel.after, `A Babel config, as the docs write it, with ${products.map((p) => (p === 'inspector' ? 'the Inspector\'s plugin (development only)' : 'the Motion Vitals plugin')).join(' and ')}.`)
  else if (babel.kind === 'edit') {
    // Through the workspace, so it shows with the other changes. Configs are never edited by other steps.
    ws.create(babel.file, babel.after, `Adds ${products.map((p) => (p === 'inspector' ? '@keyframerdev/inspector/babel (development only)' : '@keyframerdev/vitals/babel')).join(' and ')} before the worklets plugin.`)
  } else if (babel.kind === 'manual') manual.push({ title: 'Babel', file: babel.file, reason: babel.reason, snippet: babel.snippet })
  else already.push(`Babel: ${rel(babel.file)} has the plugins already.`)
  notes.push(...babel.notes)

  const start = planStart(ws, project, choices)
  manual.push(...start.manual)
  notes.push(...start.notes)
  for (const a of start.already) already.push(`${a.product === 'inspector' ? 'The Inspector' : 'Motion Vitals'} is started in ${rel(a.file)} already: left as it is.`)

  const pkgs = planPackages(project, products, { babelPresetExpo: babel.kind === 'create' && !!project.expo, expoConstants: start.needsExpoConstants })
  notes.push(...pkgs.notes)
  warnings.push(...pkgs.warnings)
  for (const p of products) {
    const name = p === 'inspector' ? '@keyframerdev/inspector' : '@keyframerdev/vitals'
    if (project.deps[name]) already.push(`${name} is installed already.`)
  }

  return {
    changes: ws.changes(),
    installs: pkgs.installs,
    manual,
    notes,
    warnings,
    rebuild: rebuildAdvice(project, pkgs.native),
    already,
    startFile: start.file,
  }
}

/** Writes `after` to `file` through a temporary file beside it, so it is all there or not at all. */
export function writeAtomic(file: string, after: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.keyframer-${process.pid}.tmp`)
  try {
    writeFileSync(tmp, after)
    renameSync(tmp, file)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}
