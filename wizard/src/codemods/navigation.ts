/**
 * Navigation, so Motion Vitals names screens and the Inspector marks screen changes: the container's
 * ref reaches startVitals and trackNavigation.
 *
 *   expo-router        `const navigationRef = useNavigationContainerRef()` and `useKeyframer(navigationRef)`
 *                      at the top of the root layout (the ref exists only inside a component)
 *   React Navigation   one <NavigationContainer> without a ref: `ref={navigationRef}`, the ref made in the
 *                      wizard's file; with a ref already: that ref, followed to where it is made, and
 *                      `useKeyframer(ref)` in the component around the container
 *
 * Anything else (no container, several, a wrapper of its own, a ref it can't follow) is not edited:
 * the step says what to paste and where.
 */
import path from 'node:path'
import type * as t from '@babel/types'
import type { Project } from '../types'
import type { NavMode } from './startFile'
import {
  addNamedImport,
  calleeName,
  callsFunction,
  declarationIn,
  defaultExportFunction,
  enclosingFunction,
  end,
  hookSlot,
  importedAs,
  isComponent,
  isKeyframerImport,
  lineAt,
  moduleDeclarator,
  moduleNames,
  relativeImport,
  semi,
  start,
  visit,
  type Fn,
} from './source'
import { filesMatching, type ManualStep, type Workspace } from './workspace'

export type NavPlan = {
  mode: NavMode
  /** The file an edit makes import the wizard's file (so the entry doesn't need to). */
  importsWizard: string | null
  /** Where the hook is called, for its comment. */
  hookFor?: string
  /** The component that renders the app's navigation, for VitalsRoot. */
  component: { file: string; fn: Fn } | null
  manual: ManualStep[]
  notes: string[]
}

const rel = (project: Project, f: string) => path.relative(project.root, f)

export function planNavigation(ws: Workspace, project: Project, wizardFile: string): NavPlan {
  if (project.navigation === 'expo-router') return planExpoRouter(ws, project, wizardFile)
  if (project.navigation === 'react-navigation') return planReactNavigation(ws, project, wizardFile)
  return { mode: 'none', importsWizard: null, component: null, manual: [], notes: [] }
}

// ── expo-router ─────────────────────────────────────────────────────────────────────

function expoRouterSnippet(project: Project, layout: string, wizardFile: string): string {
  return [
    `import { useNavigationContainerRef } from 'expo-router'`,
    `import { useKeyframer } from '${relativeImport(layout, wizardFile)}'`,
    '',
    'export default function RootLayout() {',
    '  const navigationRef = useNavigationContainerRef()',
    '  useKeyframer(navigationRef)',
    '  // …',
    '}',
  ].join('\n')
}

function planExpoRouter(ws: Workspace, project: Project, wizardFile: string): NavPlan {
  const layout = project.entry
  const manual = (reason: string, line?: number): NavPlan => ({
    mode: 'hook',
    importsWizard: null,
    hookFor: layout ? rel(project, layout) : 'app/_layout.tsx',
    component: null,
    manual: [{ title: 'expo-router', file: layout, line, reason, snippet: expoRouterSnippet(project, layout ?? path.join(project.root, 'app/_layout.tsx'), wizardFile) }],
    notes: [],
  })
  if (!layout) return manual('There is no root layout (app/_layout.tsx) to start Keyframer in. Add this to it:')
  const e = ws.tryGet(layout)
  if (!e) return manual(`${rel(project, layout)} doesn't parse, so it was left as it is. Add this to its root layout component:`)
  const fn = defaultExportFunction(e.ast)
  if (!fn) return manual(`${rel(project, layout)} has no default-exported component the wizard recognises. Add this to it:`)
  const plan: NavPlan = { mode: 'hook', importsWizard: layout, hookFor: rel(project, layout), component: { file: layout, fn }, manual: [], notes: [] }
  if (callsFunction(e.ast, 'useKeyframer')) return plan
  if (fn.body.type !== 'BlockStatement') return manual(`${rel(project, layout)}'s layout is an arrow function returning JSX directly. Give it a body and add:`, lineAt(e.code, start(fn)))

  const s = semi(e.style)
  const hookName = importedAs(e.ast, 'expo-router', 'useNavigationContainerRef')
  // A ref the layout makes already: reuse it.
  const existing = hookName
    ? fn.body.body.find(
        (st): st is t.VariableDeclaration =>
          st.type === 'VariableDeclaration' && st.declarations.length === 1 && st.declarations[0]!.id.type === 'Identifier' && calleeName(st.declarations[0]!.init) === hookName,
      )
    : undefined
  if (existing) {
    const name = (existing.declarations[0]!.id as t.Identifier).name
    const slot = hookSlot(e.code, fn, existing)!
    e.sp.insert(slot.at, `\n${slot.indent}useKeyframer(${name})${s}`)
  } else {
    if (moduleNames(e.ast).has('navigationRef') || declarationIn(fn, 'navigationRef')) {
      return manual(`${rel(project, layout)} already has something called navigationRef. Add this to its root layout, with a name of your own:`, lineAt(e.code, start(fn)))
    }
    const local = addNamedImport(e.sp, e.ast, e.style, 'expo-router', 'useNavigationContainerRef')
    const slot = hookSlot(e.code, fn)
    if (!slot) return manual(`${rel(project, layout)}'s layout component is empty. Add this to it:`)
    e.sp.insert(slot.at, `const navigationRef = ${local}()${s}\n${slot.indent}useKeyframer(navigationRef)${s}\n\n${slot.indent}`)
  }
  addNamedImport(e.sp, e.ast, e.style, relativeImport(layout, wizardFile), 'useKeyframer')
  ws.because(layout, "Starts Keyframer in the root layout, with expo-router's navigation ref (screens are named from its routes).")
  return plan
}

// ── React Navigation ────────────────────────────────────────────────────────────────

type Container = { file: string; el: t.JSXOpeningElement; line: number; name: string }

function ownSnippet(project: Project, file: string | null, wizardFile: string): string {
  const from = file ?? project.entry ?? path.join(project.root, 'App.tsx')
  return [`import { navigationRef } from '${relativeImport(from, wizardFile)}'`, '', '<NavigationContainer ref={navigationRef}>'].join('\n')
}

function planReactNavigation(ws: Workspace, project: Project, wizardFile: string): NavPlan {
  const containers: Container[] = []
  const wrappers: string[] = []
  const unreadable: string[] = []
  for (const f of filesMatching(project.root, /NavigationContainer|createStaticNavigation/, [wizardFile])) {
    const e = ws.tryGet(f)
    if (!e) {
      unreadable.push(rel(project, f))
      continue
    }
    const names = new Set<string>()
    const nc = importedAs(e.ast, '@react-navigation/native', 'NavigationContainer')
    if (nc) names.add(nc)
    const sn = importedAs(e.ast, '@react-navigation/native', 'createStaticNavigation')
    if (sn) {
      for (const st of e.ast.program.body) {
        const d = st.type === 'ExportNamedDeclaration' ? st.declaration : st
        if (d?.type !== 'VariableDeclaration') continue
        for (const x of d.declarations) if (x.id.type === 'Identifier' && calleeName(x.init) === sn) names.add(x.id.name)
      }
    }
    let found = false
    visit(e.ast.program, (n) => {
      if (n.type === 'JSXOpeningElement' && n.name.type === 'JSXIdentifier' && names.has(n.name.name)) {
        containers.push({ file: f, el: n, line: lineAt(e.code, start(n)), name: n.name.name })
        found = true
      }
    })
    if (!found && /<\w*NavigationContainer\b/.test(e.code)) wrappers.push(rel(project, f))
  }

  const own = (reason: string, file: string | null, line?: number): NavPlan => ({
    mode: 'own',
    importsWizard: null,
    component: null,
    manual: [{ title: 'React Navigation', file, line, reason, snippet: ownSnippet(project, file, wizardFile) }],
    notes: unreadable.length ? [`Not read (they don't parse): ${unreadable.join(', ')}`] : [],
  })

  if (containers.length === 0) {
    if (wrappers.length) return own(`Your NavigationContainer is behind a component of your own (${wrappers.join(', ')}). Pass the wizard's ref to the NavigationContainer inside it:`, null)
    return own("The wizard couldn't find your <NavigationContainer>. Where you render it, add the ref:", null)
  }
  if (containers.length > 1) {
    const where = containers.map((c) => `${rel(project, c.file)}:${c.line}`).join(', ')
    return own(`There are ${containers.length} navigation containers (${where}), so the wizard didn't pick one. Add the ref to the root one:`, containers[0]!.file, containers[0]!.line)
  }

  const c = containers[0]!
  const e = ws.get(c.file)
  const where = `${rel(project, c.file)}:${c.line}`
  const attrs = c.el.attributes
  const refAttr = attrs.find((a): a is t.JSXAttribute => a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && a.name.name === 'ref')
  const encl = enclosingFunction(e.ast, start(c.el))
  const component = encl && isComponent(encl) ? { file: c.file, fn: encl.fn } : null

  if (!refAttr) {
    if (attrs.some((a) => a.type === 'JSXSpreadAttribute')) return own(`The <${c.name}> at ${where} spreads its props, which may carry a ref already. Add the wizard's ref if it doesn't:`, c.file, c.line)
    if (moduleNames(e.ast).has('navigationRef') || (encl && declarationIn(encl.fn, 'navigationRef'))) {
      return own(`${rel(project, c.file)} already has something called navigationRef. Add the wizard's ref under a name of your own:`, c.file, c.line)
    }
    const first = attrs[0]
    const nameEnd = end(c.el.name)
    const onOwnLine = first && e.code.slice(nameEnd, start(first)).includes('\n')
    const indent = first ? e.code.slice(e.code.lastIndexOf('\n', start(first) - 1) + 1, start(first)) : ''
    e.sp.insert(nameEnd, onOwnLine ? `\n${indent}ref={navigationRef}` : ' ref={navigationRef}')
    addNamedImport(e.sp, e.ast, e.style, relativeImport(c.file, wizardFile), 'navigationRef')
    ws.because(c.file, `Gives the <${c.name}> the wizard's navigation ref, so screens are named from its routes.`)
    return { mode: 'own', importsWizard: c.file, component, manual: [], notes: [] }
  }

  // A ref already: follow it.
  const v = refAttr.value
  const hookManual = (reason: string): NavPlan => ({
    mode: 'hook',
    importsWizard: null,
    hookFor: rel(project, c.file),
    component,
    manual: [
      {
        title: 'React Navigation',
        file: c.file,
        line: c.line,
        reason,
        snippet: [
          `import { createNavigationContainerRef } from '@react-navigation/native'`,
          `import { useKeyframer } from '${relativeImport(c.file, wizardFile)}'`,
          '',
          'const navigationRef = createNavigationContainerRef()',
          '',
          '// in the component that renders the container:',
          'useKeyframer(navigationRef)',
          '<NavigationContainer ref={navigationRef}>',
        ].join('\n'),
      },
    ],
    notes: [],
  })
  if (v?.type !== 'JSXExpressionContainer' || v.expression.type !== 'Identifier') {
    return hookManual(`The <${c.name}> at ${where} has a ref the wizard can't follow. Use a container ref and pass it to useKeyframer:`)
  }
  const name = v.expression.name
  const imported = e.ast.program.body
    .filter((s): s is t.ImportDeclaration => s.type === 'ImportDeclaration')
    .find((d) => d.specifiers.some((s) => s.local.name === name))
  if (imported && isKeyframerImport(imported.source.value)) return { mode: 'own', importsWizard: c.file, component, manual: [], notes: [] }
  if (!encl || !isComponent(encl) || encl.fn.body.type !== 'BlockStatement') {
    return hookManual(`The <${c.name}> at ${where} isn't rendered by a component the wizard can add a hook to. Call useKeyframer with its ref there:`)
  }
  if (callsFunction(e.ast, 'useKeyframer')) return { mode: 'hook', importsWizard: c.file, hookFor: rel(project, c.file), component, manual: [], notes: [] }

  let after: t.Node | null = null
  const local = declarationIn(encl.fn, name)
  if (local) {
    const d = local.declarations.find((x) => x.id.type === 'Identifier' && x.id.name === name)
    const callee = calleeName(d?.init)
    if (callee !== 'useNavigationContainerRef' && callee !== 'createNavigationContainerRef') {
      return hookManual(`The <${c.name}> at ${where} takes ${name}${callee ? ` from ${callee}()` : ''}, a plain React ref: screen names need a container ref.`)
    }
    after = local
  } else if (!imported) {
    const d = moduleDeclarator(e.ast, name)
    if (!d || calleeName(d.init) !== 'createNavigationContainerRef') {
      return hookManual(`The <${c.name}> at ${where} takes ${name}, which the wizard can't follow to a createNavigationContainerRef().`)
    }
  }
  const slot = hookSlot(e.code, encl.fn, after)
  if (!slot) return hookManual(`The component around <${c.name}> at ${where} is empty.`)
  const s = semi(e.style)
  if (after) e.sp.insert(slot.at, `\n${slot.indent}useKeyframer(${name})${s}`)
  else e.sp.insert(slot.at, `useKeyframer(${name})${s}\n\n${slot.indent}`)
  addNamedImport(e.sp, e.ast, e.style, relativeImport(c.file, wizardFile), 'useKeyframer')
  ws.because(c.file, `Starts Keyframer with your navigation ref (${name}), so screens are named from its routes.`)
  return { mode: 'hook', importsWizard: c.file, hookFor: rel(project, c.file), component, manual: [], notes: [] }
}
