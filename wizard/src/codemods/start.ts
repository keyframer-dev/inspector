/**
 * The start code: the wizard's file, what imports it (the navigation edit, else the entry), and
 * VitalsRoot around the app when asked. A product the app already starts by hand (connectDevTools,
 * connectInspector or startVitals in its own code) is left as it is.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type * as t from '@babel/types'
import type { InspectorView, Product, Project } from '../types'
import { planNavigation, type NavPlan } from './navigation'
import {
  addImportLine,
  addNamedImport,
  defaultExportFunction,
  end,
  importsSource,
  indentAt,
  isKeyframerImport,
  quoted,
  reindent,
  relativeImport,
  semi,
  start,
  visit,
  type Fn,
  type Node,
  type Style,
} from './source'
import { isWizardFile, renderStartFile, versionSource } from './startFile'
import { filesMatching, type ManualStep, type Workspace } from './workspace'
import { withExtension } from '../detect'

export type StartChoices = {
  products: Product[]
  view: InspectorView | null
  relay: string | null
  code: string | null
  api: string
  key: string | null
  vitalsRoot: boolean
}

export type StartPlan = {
  /** The wizard's file, when one is needed. */
  file: string | null
  nav: NavPlan | null
  manual: ManualStep[]
  notes: string[]
  /** Products the app starts by hand already, and where. */
  already: Array<{ product: Product; file: string }>
  /** The file uses expo-constants, which the app doesn't list. */
  needsExpoConstants: boolean
}

const STARTS: Record<Product, RegExp> = {
  inspector: /\b(connectDevTools|connectInspector)\s*\(/,
  vitals: /\bstartVitals\s*\(/,
}

/** Where the wizard's file goes: src/ when the app has one, else beside the entry (never in expo-router's app/, where every file is a route). */
export function wizardFilePath(project: Project): string {
  const ext = project.typescript ? '.ts' : '.js'
  const src = path.join(project.root, 'src')
  if (existsSync(src) && statSync(src).isDirectory()) return path.join(src, `keyframer${ext}`)
  if (project.entry && project.navigation !== 'expo-router') return path.join(path.dirname(project.entry), `keyframer${ext}`)
  return path.join(project.root, `keyframer${ext}`)
}

export function planStart(ws: Workspace, project: Project, choices: StartChoices): StartPlan {
  const plan: StartPlan = { file: null, nav: null, manual: [], notes: [], already: [], needsExpoConstants: false }
  let file = wizardFilePath(project)
  // A keyframer.ts of the app's own: the wizard's goes beside it under another name.
  if (existsSync(file) && !isWizardFile(readFileSync(file, 'utf8'))) file = file.replace(/keyframer(\.\w+)$/, 'keyframer.setup$1')

  // Started by hand already?
  for (const product of choices.products) {
    const hit = filesMatching(project.root, STARTS[product], [file]).find((f) => !isWizardFile(readFileSync(f, 'utf8')))
    if (hit) plan.already.push({ product, file: hit })
  }
  const products = choices.products.filter((p) => !plan.already.some((a) => a.product === p) && (p !== 'vitals' || !!choices.key))
  const entryStyle = styleFor(ws, project)

  if (products.length) {
    plan.file = file
    const nav = planNavigation(ws, project, file)
    plan.nav = nav
    plan.manual.push(...nav.manual)
    plan.notes.push(...nav.notes)
    const content = renderStartFile({
      project,
      products,
      view: choices.view,
      relay: choices.relay,
      code: choices.code,
      api: choices.api,
      key: choices.key,
      nav: nav.mode,
      hookFor: nav.hookFor,
      typescript: !!project.typescript,
      style: entryStyle,
    })
    ws.create(file, content, `The wizard's file: ${products.map((p) => (p === 'inspector' ? 'the Inspector (development only)' : 'Motion Vitals')).join(' and ')}.`)
    if (products.includes('vitals')) {
      const v = versionSource(project)
      plan.notes.push(`Motion Vitals reads the version and build from ${v.detail}.`)
      if (v.kind === 'expo-constants' && !project.deps['expo-constants']) plan.needsExpoConstants = true
      if (!project.deps['@react-native-async-storage/async-storage']) {
        plan.notes.push('Without @react-native-async-storage/async-storage, Motion Vitals keeps nothing between launches (no checkpoints or retries after a restart). Install it and run the wizard again to use it.')
      }
      if (nav.mode === 'none') plan.notes.push('There is no navigation library, so screens are not named: call setVitalsScreen(\'Checkout\') from @keyframerdev/vitals where your screens change.')
    }
    if (!nav.importsWizard) planEntryImport(ws, project, file, plan)
  }

  if (choices.vitalsRoot && choices.products.includes('vitals')) planVitalsRoot(ws, project, plan)
  return plan
}

function styleFor(ws: Workspace, project: Project): Style {
  const e = project.entry ? ws.tryGet(project.entry) : null
  return e?.style ?? { semi: false, quote: "'", indent: '  ', braces: ' ' }
}

/** `import './keyframer'` in the entry, after its imports. */
function planEntryImport(ws: Workspace, project: Project, file: string, plan: StartPlan): void {
  const entry = project.entry
  const spec = (from: string) => relativeImport(from, file)
  const snippet = (from: string | null) => `import '${from ? spec(from) : './keyframer'}'`
  if (!entry) {
    plan.manual.push({ title: 'Entry', file: null, reason: "The wizard couldn't tell which file your app starts from. Import its file there, at the top:", snippet: snippet(null) })
    return
  }
  const e = ws.tryGet(entry)
  if (!e) {
    plan.manual.push({ title: 'Entry', file: entry, reason: `${path.relative(project.root, entry)} doesn't parse, so it was left as it is. Add, after its imports:`, snippet: snippet(entry) })
    return
  }
  if (importsSource(e.ast, (s) => isKeyframerImport(s))) return
  addImportLine(e.sp, e.ast, `import ${quoted(e.style, spec(entry))}${semi(e.style)}`)
  ws.because(entry, 'Imports the wizard\'s file, so Keyframer starts with the app.')
}

/** The app's root component: the navigation one, else App's default export, else the entry's. */
function rootComponent(ws: Workspace, project: Project, plan: StartPlan): { file: string; fn: Fn } | null {
  if (plan.nav?.component) return plan.nav.component
  if (project.navigation === 'expo-router' && project.entry) {
    const e = ws.tryGet(project.entry)
    const fn = e && defaultExportFunction(e.ast)
    return fn ? { file: project.entry, fn } : null
  }
  for (const f of [withExtension(path.join(project.root, 'App')), withExtension(path.join(project.root, 'src', 'App')), project.entry]) {
    if (!f) continue
    const e = ws.tryGet(f)
    const fn = e && defaultExportFunction(e.ast)
    if (fn) return { file: f, fn }
  }
  return null
}

const VITALS_ROOT_SNIPPET = ["import { VitalsRoot } from '@keyframerdev/vitals'", '', 'return (', '  <VitalsRoot>', '    {/* your app */}', '  </VitalsRoot>', ')'].join('\n')

/** Wraps what the root component returns in <VitalsRoot>, when it returns JSX in one place. */
function planVitalsRoot(ws: Workspace, project: Project, plan: StartPlan): void {
  const target = rootComponent(ws, project, plan)
  const manual = (reason: string, file: string | null) => plan.manual.push({ title: 'VitalsRoot', file, reason, snippet: VITALS_ROOT_SNIPPET })
  if (!target) return void manual("The wizard couldn't find your root component. Wrap what it returns:", null)
  const e = ws.get(target.file)
  if (/<VitalsRoot\b/.test(e.code)) return
  const fn = target.fn
  const name = path.relative(project.root, target.file)
  let jsx: t.JSXElement | t.JSXFragment | null = null
  if (fn.body.type === 'JSXElement' || fn.body.type === 'JSXFragment') jsx = fn.body
  else if (fn.body.type === 'BlockStatement') {
    const returns: t.ReturnStatement[] = []
    visit(fn.body, (n) => {
      if (n !== fn.body && (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'FunctionDeclaration')) return false
      if (n.type === 'ReturnStatement') returns.push(n)
    })
    const withJsx = returns.filter((r) => r.argument?.type === 'JSXElement' || r.argument?.type === 'JSXFragment')
    const others = returns.filter((r) => !withJsx.includes(r) && r.argument && !(r.argument.type === 'NullLiteral' || (r.argument.type === 'Identifier' && r.argument.name === 'undefined')))
    if (withJsx.length === 1 && others.length === 0) jsx = withJsx[0]!.argument as t.JSXElement
  }
  if (!jsx) return void manual(`${name}'s root component returns more than one thing (or not JSX). Wrap what it returns:`, target.file)
  const unit = e.style.indent
  const parenthesized = !!(jsx as Node & { extra?: { parenthesized?: boolean } }).extra?.parenthesized
  const ind = indentAt(e.code, start(jsx))
  // A wrap, so other edits inside the JSX (a ref on the container) are kept and indented with it.
  if (parenthesized) {
    // return (\n    <App />\n  ): the JSX has its own lines already.
    e.sp.wrap(start(jsx), end(jsx), (text) => `<VitalsRoot>\n${ind}${unit}${reindent(text, unit)}\n${ind}</VitalsRoot>`)
  } else {
    // return <App />: it gets parentheses and lines of its own.
    const two = unit + unit
    e.sp.wrap(start(jsx), end(jsx), (text) => `(\n${ind}${unit}<VitalsRoot>\n${ind}${two}${reindent(text, two)}\n${ind}${unit}</VitalsRoot>\n${ind})`)
  }
  addNamedImport(e.sp, e.ast, e.style, '@keyframerdev/vitals', 'VitalsRoot')
  ws.because(target.file, 'Wraps the app in <VitalsRoot>: touches open motion windows, so lists without scroll handlers are measured while they scroll.')
}
