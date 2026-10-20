/**
 * Dev-only Babel plugin: tags every Reanimated animation call and shared value with where it was
 * written, so a running app can report its motion and accept edits back (see runtime.ts).
 *
 *   logoScale.value = withSpring(1, { damping: 12 })
 *     ↓
 *   logoScale.value = _kfAnim(withSpring, { id: "src/Welcome.tsx:37:20", target: "logoScale", … }, 1, { damping: 12 })
 *
 *   const logoScale = useSharedValue(0)
 *     ↓
 *   const logoScale = _kfSignal(useSharedValue(0), { id: "src/Welcome.tsx:31:20", name: "logoScale", … })
 *
 *   const logoStyle = useAnimatedStyle(() => ({ transform: [{ scale: logoScale.value }] }))
 *     ↓
 *   const logoStyle = _kfStyle(useAnimatedStyle(…), { name: "logoStyle", links: [{ signal: "logoScale", prop: "scale" }], … })
 *
 *   Gesture.Pan().onUpdate((e) => { … })
 *     ↓
 *   Gesture.Pan().onUpdate(_kfGesture((e) => { 'worklet'; … }, { gesture: "Pan", on: "onUpdate", … }))
 *
 * Only identifiers bound to an import from react-native-reanimated (and Gesture from
 * react-native-gesture-handler) are touched, so a local function
 * that happens to be called withTiming is left alone. The helpers are worklets, so a call inside a
 * gesture callback keeps running on the UI thread. List this plugin BEFORE react-native-worklets'
 * plugin, which has to run last.
 */

import type { NodePath, PluginObj, PluginPass, Visitor, types as BabelTypes } from '@babel/core'
import type { InspectorCallSite, InspectorGestureSite, InspectorParam, InspectorSignalSite, InspectorStyleSite } from '../../protocol/inspector'

export const ANIMATION_FNS = new Set([
  'withTiming',
  'withSpring',
  'withDelay',
  'withSequence',
  'withRepeat',
  'withDecay',
  'withClamp',
])
const REANIMATED = 'react-native-reanimated'
const WORKLETS = 'react-native-worklets'
/** Reanimated hooks whose worklets run on the UI thread every frame they are needed: timed while recording. */
const WORKLET_HOOKS: Record<string, string> = {
  useAnimatedStyle: 'style',
  useAnimatedProps: 'props',
  useDerivedValue: 'derived',
  useAnimatedReaction: 'reaction',
  useAnimatedScrollHandler: 'scroll',
  useFrameCallback: 'frame',
}
/** Calls that run a worklet on the UI thread once. */
const UI_RUNNERS = new Set(['scheduleOnUI', 'runOnUI'])
const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect'])
const GESTURE_HANDLER = 'react-native-gesture-handler'
/** Gesture callbacks whose events say where the finger is. */
export const GESTURE_CALLBACKS = new Set([
  'onBegin',
  'onStart',
  'onUpdate',
  'onChange',
  'onEnd',
  'onFinalize',
  'onTouchesDown',
  'onTouchesMove',
  'onTouchesUp',
  'onTouchesCancelled',
])
export const RUNTIME_MODULE = '@keyframerdev/inspector/runtime'

export type InspectorPluginOptions = {
  /** Paths in call site ids are relative to this; defaults to Babel's cwd. */
  root?: string
  /** Also instrument dependencies. Off by default: an app's own motion is what gets tuned, and a UI
   *  library's internal springs would only flood the timeline. */
  includeNodeModules?: boolean
}

type State = PluginPass & {
  opts: InspectorPluginOptions
  animLocals: Map<string, string>
  svLocals: Set<string>
  /** Local names of `Gesture` imported from react-native-gesture-handler. */
  gestureLocals: Set<string>
  gestureHelper: BabelTypes.Identifier | null
  styleLocals: Set<string>
  animHelper: BabelTypes.Identifier | null
  signalHelper: BabelTypes.Identifier | null
  styleHelper: BabelTypes.Identifier | null
  layoutHelper: BabelTypes.Identifier | null
  /** Reanimated hooks with worklets to time, by local name → kind. */
  workletHookLocals: Map<string, string>
  /** scheduleOnUI / runOnUI, by local name. */
  uiRunnerLocals: Set<string>
  /** useEffect / useLayoutEffect from react, and the local names of the React default / namespace import. */
  effectLocals: Set<string>
  reactLocals: Set<string>
  /** Helpers imported from the runtime on demand, by export name. */
  helpers: Map<string, BabelTypes.Identifier>
  /** The variable each tagged animated style is assigned to → its style id. */
  styleBindings: Map<BabelTypes.Node, string>
  wrapped: WeakSet<BabelTypes.Node>
  /** The file sets CSS animations or transitions (animationName, transitionProperty…) somewhere. */
  usesCss: boolean
  /** Local names of Reanimated's default or namespace import (`Animated`). */
  animatedLocals: Set<string>
  skip: boolean
}

function relativeFile(state: State): string {
  const file = state.filename ?? 'unknown'
  const root = state.opts.root ?? state.cwd ?? ''
  const rel = root && file.startsWith(root) ? file.slice(root.length).replace(/^[/\\]+/, '') : file
  return rel.replace(/\\/g, '/')
}

/** Nearest enclosing component (PascalCase) or hook (use…) name; else the nearest named function. */
function enclosingName(path: NodePath): string | null {
  let fallback: string | null = null
  for (let p: NodePath | null = path.parentPath; p; p = p.parentPath) {
    let name: string | null = null
    if (p.isFunctionDeclaration() && p.node.id) name = p.node.id.name
    else if ((p.isArrowFunctionExpression() || p.isFunctionExpression()) && p.parentPath?.isVariableDeclarator()) {
      const id = p.parentPath.node.id
      if (id.type === 'Identifier') name = id.name
    }
    if (!name) continue
    if (/^[A-Z]/.test(name) || /^use[A-Z]/.test(name)) return name
    fallback ??= name
  }
  return fallback
}

function keyName(key: BabelTypes.Node): string | null {
  if (key.type === 'Identifier') return key.name
  if (key.type === 'StringLiteral') return key.value
  return null
}

/** PascalCase functions declared at the top of a file: the app's components. */
function componentNames(program: BabelTypes.Program): string[] {
  const names = new Set<string>()
  const isComponentName = (n: string) => /^[A-Z][A-Za-z0-9]*$/.test(n)
  const fromDeclaration = (d: BabelTypes.Node | null | undefined) => {
    if (!d) return
    if (d.type === 'FunctionDeclaration' && d.id && isComponentName(d.id.name)) names.add(d.id.name)
    if (d.type === 'VariableDeclaration') {
      for (const v of d.declarations) {
        if (v.id.type !== 'Identifier' || !isComponentName(v.id.name) || !v.init) continue
        const init = v.init
        if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression' || init.type === 'CallExpression') names.add(v.id.name)
      }
    }
  }
  for (const stmt of program.body) {
    if (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') fromDeclaration(stmt.declaration as BabelTypes.Node)
    else fromDeclaration(stmt)
  }
  return [...names]
}

/** `file:line` of the useAnimatedScrollHandler(...) an onScroll prop gets, inline or through a const. */
function scrollHandlerSite(expr: BabelTypes.Node, path: NodePath, state: State): string | null {
  let call: BabelTypes.Node | null | undefined = expr
  if (expr.type === 'Identifier') {
    const node = path.scope.getBinding(expr.name)?.path.node
    call = node?.type === 'VariableDeclarator' ? node.init : null
  }
  if (!call || call.type !== 'CallExpression' || call.callee.type !== 'Identifier' || !call.loc) return null
  if (state.workletHookLocals.get(call.callee.name) !== 'scroll') return null
  return `${relativeFile(state)}:${call.loc.start.line}`
}

/**
 * An inline function, or a name bound in this file to one (a function declaration, a const arrow, or
 * useCallback(…)): an event handler that runs on the JS thread and is safe to wrap. Anything else
 * (a Reanimated event handler object, a prop passed through) is left alone.
 */
function isLocalFunction(expr: BabelTypes.Node, path: NodePath): boolean {
  if (expr.type === 'ArrowFunctionExpression' || expr.type === 'FunctionExpression') return true
  if (expr.type !== 'Identifier') return false
  const binding = path.scope.getBinding(expr.name)
  if (!binding) return false
  const node = binding.path.node
  if (node.type === 'FunctionDeclaration') return true
  if (node.type === 'VariableDeclarator' && node.init) {
    const init = node.init
    if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') return true
    if (init.type === 'CallExpression' && init.callee.type === 'Identifier' && init.callee.name === 'useCallback') return true
  }
  return false
}

/**
 * An element Reanimated renders: `<Animated.View>` (Animated being Reanimated's default or namespace
 * import), or a component made here with createAnimatedComponent(…).
 */
function isAnimatedElement(name: BabelTypes.JSXOpeningElement['name'], path: NodePath, state: State): boolean {
  if (name.type === 'JSXMemberExpression') {
    let obj: BabelTypes.JSXMemberExpression['object'] = name.object
    while (obj.type === 'JSXMemberExpression') obj = obj.object
    return obj.type === 'JSXIdentifier' && state.animatedLocals.has(obj.name) && path.scope.getBinding(obj.name)?.kind === 'module'
  }
  if (name.type !== 'JSXIdentifier') return false
  const node = path.scope.getBinding(name.name)?.path.node
  const init = node?.type === 'VariableDeclarator' ? node.init : null
  if (!init || init.type !== 'CallExpression') return false
  const callee = init.callee
  return (
    (callee.type === 'Identifier' && callee.name === 'createAnimatedComponent') ||
    (callee.type === 'MemberExpression' && !callee.computed && keyName(callee.property) === 'createAnimatedComponent')
  )
}

function jsxAttr(el: BabelTypes.JSXOpeningElement, name: string): BabelTypes.JSXAttribute | undefined {
  return el.attributes.find((a): a is BabelTypes.JSXAttribute => a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && a.name.name === name)
}

/** The expression in `name={…}`, or null. */
function jsxValue(attr: BabelTypes.JSXAttribute | undefined): BabelTypes.Expression | null {
  return attr?.value?.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression' ? attr.value.expression : null
}

/**
 * `Gesture.Pan()` at the root of a builder chain (`Gesture.Pan().minDistance(4).onUpdate`) → "Pan",
 * when `Gesture` is the import from react-native-gesture-handler.
 */
function gestureKind(expr: BabelTypes.Node, locals: Set<string>, path: NodePath): string | null {
  let e: BabelTypes.Node = expr
  for (let i = 0; i < 40 && e.type === 'CallExpression' && e.callee.type === 'MemberExpression'; i++) {
    const obj = e.callee.object
    if (obj.type === 'Identifier' && locals.has(obj.name) && path.scope.getBinding(obj.name)?.kind === 'module') return keyName(e.callee.property)
    e = obj
  }
  return null
}

/** The shared value's name in `logoScale` / `this.logoScale` / `refs.logoScale`. */
function nameOfObject(obj: BabelTypes.Node): string | null {
  return obj.type === 'Identifier' ? obj.name : obj.type === 'MemberExpression' && !obj.computed ? keyName(obj.property) : null
}

/**
 * `logoScale.value = …` or `logoScale.set(…)` (what React Compiler apps write) → "logoScale";
 * `{ scale: … }` → prop "scale". Stops at function bodies.
 */
function targetOf(path: NodePath): { target: string | null; prop: string | null } {
  let prop: string | null = null
  let child: NodePath = path
  for (let p: NodePath | null = path.parentPath; p; child = p, p = p.parentPath) {
    if (p.isFunction() || p.isStatement()) break
    if (p.isObjectProperty() && prop === null) prop = keyName(p.node.key)
    else if (p.isObjectProperty() && NESTED_STYLE_KEYS.has(keyName(p.node.key) ?? '')) prop = keyName(p.node.key)
    if (p.isCallExpression() && p.node.arguments[0] === child.node) {
      const callee = p.node.callee
      if (callee.type === 'MemberExpression' && !callee.computed && keyName(callee.property) === 'set') {
        return { target: nameOfObject(callee.object), prop }
      }
    }
    if (p.isAssignmentExpression()) {
      const left = p.node.left
      if (left.type === 'MemberExpression' && keyName(left.property) === 'value' && !left.computed) {
        return { target: nameOfObject(left.object), prop }
      }
      break
    }
  }
  return { target: null, prop }
}

function numberOf(node: BabelTypes.Node): number | null {
  if (node.type === 'NumericLiteral') return node.value
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'NumericLiteral')
    return -node.argument.value
  return null
}

/** Style keys whose value is an object of their own: a read inside one animates the outer key. */
const NESTED_STYLE_KEYS = new Set(['shadowOffset', 'textShadowOffset'])

/**
 * Inside a useAnimatedStyle worklet, every `x.value` read and the style key it ends up under:
 * `{ opacity: o.value, transform: [{ translateY: y.value }] }` → o → opacity, y → translateY,
 * `{ shadowOffset: { height: h.value } }` → h → shadowOffset (not the layout height).
 */
export function styleLinks(worklet: NodePath): Array<{ signal: string; prop: string }> {
  const links: Array<{ signal: string; prop: string }> = []
  const seen = new Set<string>()
  worklet.traverse({
    MemberExpression(member) {
      const { node } = member
      if (node.computed || node.object.type !== 'Identifier' || keyName(node.property) !== 'value') return
      for (let p: NodePath | null = member.parentPath; p && p !== worklet; p = p.parentPath) {
        if (!p.isObjectProperty()) continue
        let prop = keyName(p.node.key)
        const outer = p.parentPath?.parentPath
        const outerKey = outer?.isObjectProperty() ? keyName(outer.node.key) : null
        if (outerKey && NESTED_STYLE_KEYS.has(outerKey)) prop = outerKey
        if (!prop || prop === 'transform') continue
        const key = `${node.object.name}>${prop}`
        if (!seen.has(key)) {
          seen.add(key)
          links.push({ signal: node.object.name, prop })
        }
        return
      }
    },
  })
  return links
}

/** Numeric literals among the arguments, one object level deep: the values worth tuning. */
export function literalParams(args: BabelTypes.Node[]): InspectorParam[] {
  const params: InspectorParam[] = []
  args.forEach((arg, i) => {
    const n = numberOf(arg)
    if (n !== null) params.push({ path: String(i), value: n })
    else if (arg.type === 'ObjectExpression') {
      for (const prop of arg.properties) {
        if (prop.type !== 'ObjectProperty' || prop.computed) continue
        const key = keyName(prop.key)
        const v = numberOf(prop.value)
        if (key !== null && v !== null) params.push({ path: `${i}.${key}`, value: v })
      }
    }
  })
  return params
}

export default function keyframerInspector({ types: t }: { types: typeof BabelTypes }): PluginObj<State> {
  const literal = (value: unknown): BabelTypes.Expression => t.valueToNode(value) as BabelTypes.Expression

  /**
   * Wrapping a call hides its inline function arguments from the worklets plugin, which turns the
   * callbacks of withTiming / withSpring / gesture builders into worklets only when they are passed
   * to those directly. Marked 'worklet' here instead, so they still run on the UI thread: an
   * unconverted callback there aborts the app.
   */
  const markWorklet = (fn: BabelTypes.Node) => {
    if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') return
    if (fn.body.type !== 'BlockStatement') fn.body = t.blockStatement([t.returnStatement(fn.body)])
    if (!fn.body.directives.some((d) => d.value.value === 'worklet')) fn.body.directives.unshift(t.directive(t.directiveLiteral('worklet')))
  }

  /** A runtime helper's local name, imported once per file. */
  const helper = (state: State, path: NodePath, name: string): BabelTypes.Identifier => {
    let id = state.helpers.get(name)
    if (!id) {
      id = path.scope.getProgramParent().generateUidIdentifier(name.replace(/^__/, ''))
      state.helpers.set(name, id)
    }
    return id
  }

  const timed = new WeakSet<BabelTypes.Node>()
  /**
   * Times an inline worklet on the UI thread: its body runs between two clock reads and reports how
   * long it took (`__kfWork`, a no-op unless a recording listens). Stays a worklet.
   */
  const timeWorklet = (state: State, path: NodePath, fn: BabelTypes.Node | undefined, kind: string, site: string, name: string | null) => {
    if (!fn || (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') || timed.has(fn)) return
    timed.add(fn)
    markWorklet(fn)
    const body = fn.body as BabelTypes.BlockStatement
    const start = t.identifier('__kfT0')
    const now = () => t.callExpression(t.cloneNode(helper(state, path, '__kfNow')), [])
    const report = t.expressionStatement(
      t.callExpression(t.cloneNode(helper(state, path, '__kfWork')), [
        t.stringLiteral(kind),
        t.stringLiteral(site),
        name ? t.stringLiteral(name) : t.nullLiteral(),
        t.binaryExpression('-', now(), t.cloneNode(start)),
      ]),
    )
    fn.body = t.blockStatement(
      [t.variableDeclaration('const', [t.variableDeclarator(start, now())]), t.tryStatement(t.blockStatement(body.body), null, t.blockStatement([report]))],
      body.directives,
    )
  }

  /**
   * An onScroll worklet reports where the list is (`__kfScroll`, a no-op unless a recording listens),
   * so a recording can scroll the real list back, not only the shared values its handler drives.
   */
  const scrolled = new WeakSet<BabelTypes.Node>()
  const reportScroll = (state: State, path: NodePath, fn: BabelTypes.Node | undefined, scrollId: string) => {
    if (!fn || (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') || scrolled.has(fn)) return
    scrolled.add(fn)
    let event = fn.params[0]
    if (!event) fn.params.push((event = t.identifier('__kfEvent')))
    if (event.type !== 'Identifier') return
    markWorklet(fn)
    const body = fn.body as BabelTypes.BlockStatement
    body.body.unshift(t.expressionStatement(t.callExpression(t.cloneNode(helper(state, path, '__kfScroll')), [t.stringLiteral(scrollId), t.identifier(event.name)])))
  }

  /** True when `name` at `path` is the binding imported from react-native-reanimated. */
  const isImported = (path: NodePath, name: string, locals: { has(name: string): boolean }) => {
    if (!locals.has(name)) return false
    const binding = path.scope.getBinding(name)
    return binding?.kind === 'module'
  }

  /** What a file gets once its calls are wrapped: the list of its components, and the helpers it calls. */
  const finish = (program: NodePath<BabelTypes.Program>, state: State) => {
          // The app's own components, so render time in View / Text / navigators is charged to the
          // component of this app that rendered them.
          {
            const names = componentNames(program.node)
            if (names.length) {
              program.pushContainer(
                'body',
                t.expressionStatement(t.callExpression(t.cloneNode(helper(state, program, '__kfComponents')), [t.stringLiteral(relativeFile(state)), literal(names)])),
              )
            }
          }
          const specifiers: BabelTypes.ImportSpecifier[] = []
          for (const [exported, local] of state.helpers) specifiers.push(t.importSpecifier(local, t.identifier(exported)))
          if (state.animHelper) specifiers.push(t.importSpecifier(state.animHelper, t.identifier('__kfAnim')))
          if (state.signalHelper) specifiers.push(t.importSpecifier(state.signalHelper, t.identifier('useKfSignal')))
          if (state.styleHelper) specifiers.push(t.importSpecifier(state.styleHelper, t.identifier('__kfStyle')))
          if (state.layoutHelper) specifiers.push(t.importSpecifier(state.layoutHelper, t.identifier('__kfLayout')))
          if (state.gestureHelper) specifiers.push(t.importSpecifier(state.gestureHelper, t.identifier('__kfGesture')))
          if (specifiers.length) program.unshiftContainer('body', t.importDeclaration(specifiers, t.stringLiteral(RUNTIME_MODULE)))
  }

  const nodes: Visitor<State> = {
      // The element an animated style lands on reports where it is (`onLayout={__kfLayout(id, theirs)}`),
      // so an overlay can outline the view that moves. A no-op until something watches layouts.
      JSXOpeningElement(path, state) {
        if (state.skip) return
        // A list scrolled by a useAnimatedScrollHandler: a ref tells the runtime which view it is, so a
        // recording can scroll it back (useAnimatedScrollHandler's call site is the id they share).
        const onScroll = path.node.attributes.find(
          (a): a is BabelTypes.JSXAttribute => a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && a.name.name === 'onScroll',
        )
        const scrollExpr = onScroll?.value?.type === 'JSXExpressionContainer' ? onScroll.value.expression : null
        const scrollSite = scrollExpr && scrollExpr.type !== 'JSXEmptyExpression' ? scrollHandlerSite(scrollExpr, path, state) : null
        if (scrollSite) {
          const refAttr = path.node.attributes.find(
            (a): a is BabelTypes.JSXAttribute => a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && a.name.name === 'ref',
          )
          const prev = refAttr?.value?.type === 'JSXExpressionContainer' && refAttr.value.expression.type !== 'JSXEmptyExpression' ? refAttr.value.expression : null
          const already = prev?.type === 'CallExpression' && prev.callee.type === 'Identifier' && prev.callee.name === state.helpers.get('__kfScrollRef')?.name
          if (!already) {
            const call = t.callExpression(t.cloneNode(helper(state, path, '__kfScrollRef')), [t.stringLiteral(`scroll:${scrollSite}`), ...(prev ? [prev] : [])])
            if (refAttr) refAttr.value = t.jsxExpressionContainer(call)
            else path.node.attributes.push(t.jsxAttribute(t.jsxIdentifier('ref'), t.jsxExpressionContainer(call)))
          }
        }
        // Event handlers written in this file (inline, or a function declared here) are timed while
        // recording: the JS work that can explain a long frame, by where it is written.
        for (const attr of path.node.attributes) {
          if (attr.type !== 'JSXAttribute' || attr.name.type !== 'JSXIdentifier') continue
          const prop = attr.name.name
          if (!/^on[A-Z]/.test(prop) || prop === 'onLayout' || attr.value?.type !== 'JSXExpressionContainer') continue
          const expr = attr.value.expression
          if (expr.type === 'JSXEmptyExpression' || !expr.loc) continue
          if (expr.type === 'CallExpression' && expr.callee.type === 'Identifier' && expr.callee.name === state.helpers.get('__kfHandler')?.name) continue
          // Written here, or passed in (a prop, a hook's result, an import, `store.save`): the runtime
          // skips the ones an outer component already wrapped, worklets, and non-functions.
          const local = isLocalFunction(expr, path)
          if (!local && expr.type !== 'Identifier' && expr.type !== 'MemberExpression') continue
          if (!local && attr === onScroll && scrollSite) continue
          if (expr.type === 'Identifier' && expr.name === 'undefined') continue
          attr.value.expression = t.callExpression(t.cloneNode(helper(state, path, '__kfHandler')), [
            expr,
            t.stringLiteral(prop),
            t.stringLiteral(`${relativeFile(state)}:${expr.loc.start.line}`),
            literal(enclosingName(path)),
            ...(local ? [] : [t.booleanLiteral(true)]),
          ])
        }
        // A list scrolled by a plain JS onScroll: its offsets become scroll tracks and its ref lets a
        // recording scroll it back, as for useAnimatedScrollHandler (by the onScroll's line).
        const jsScroll = scrollSite ? null : jsxValue(onScroll)
        const isHelperCall = (e: BabelTypes.Node | null, name: string) =>
          e?.type === 'CallExpression' && e.callee.type === 'Identifier' && e.callee.name === state.helpers.get(name)?.name
        const scrollLine = scrollExpr?.loc?.start.line ?? onScroll?.loc?.start.line
        if (onScroll && jsScroll && scrollLine && !isHelperCall(jsScroll, '__kfScrollJs')) {
          const id = `scroll:${relativeFile(state)}:${scrollLine}`
          onScroll.value = t.jsxExpressionContainer(t.callExpression(t.cloneNode(helper(state, path, '__kfScrollJs')), [t.stringLiteral(id), jsScroll]))
          const refAttr = jsxAttr(path.node, 'ref')
          const prev = jsxValue(refAttr)
          const call = t.callExpression(t.cloneNode(helper(state, path, '__kfScrollRef')), [t.stringLiteral(id), ...(prev ? [prev] : [])])
          if (refAttr) refAttr.value = t.jsxExpressionContainer(call)
          else path.node.attributes.push(t.jsxAttribute(t.jsxIdentifier('ref'), t.jsxExpressionContainer(call)))
        }
        // Reanimated's animations from props: entering / exiting / layout, and CSS animations and
        // transitions in the style. Each is reported when it starts, with where the element is written.
        const loc = path.node.loc
        if (loc) {
          const site = () =>
            t.objectExpression([
              t.objectProperty(t.identifier('id'), t.stringLiteral(`${relativeFile(state)}:${loc.start.line}:${loc.start.column + 1}`)),
              t.objectProperty(t.identifier('file'), t.stringLiteral(relativeFile(state))),
              t.objectProperty(t.identifier('line'), t.numericLiteral(loc.start.line)),
              t.objectProperty(t.identifier('column'), t.numericLiteral(loc.start.column + 1)),
              t.objectProperty(t.identifier('component'), literal(enclosingName(path))),
            ])
          let mounts = false
          for (const kind of ['entering', 'exiting', 'layout'] as const) {
            const attr = jsxAttr(path.node, kind)
            const value = jsxValue(attr)
            if (!attr || !value || isHelperCall(value, '__kfLayoutAnim')) continue
            attr.value = t.jsxExpressionContainer(t.callExpression(t.cloneNode(helper(state, path, '__kfLayoutAnim')), [value, t.stringLiteral(kind), site()]))
            if (kind === 'layout') {
              const onLayout = jsxAttr(path.node, 'onLayout')
              const prev = jsxValue(onLayout)
              const call = t.callExpression(t.cloneNode(helper(state, path, '__kfLayoutMoved')), [site(), ...(prev ? [prev] : [])])
              if (onLayout) onLayout.value = t.jsxExpressionContainer(call)
              else path.node.attributes.push(t.jsxAttribute(t.jsxIdentifier('onLayout'), t.jsxExpressionContainer(call)))
            } else mounts = true
          }
          if (mounts) {
            const refAttr = jsxAttr(path.node, 'ref')
            const prev = jsxValue(refAttr)
            const call = t.callExpression(t.cloneNode(helper(state, path, '__kfMotionRef')), [site(), ...(prev ? [prev] : [])])
            if (refAttr) refAttr.value = t.jsxExpressionContainer(call)
            else path.node.attributes.push(t.jsxAttribute(t.jsxIdentifier('ref'), t.jsxExpressionContainer(call)))
          }
          const style = jsxAttr(path.node, 'style')
          const styleValue = jsxValue(style)
          if (state.usesCss && style && styleValue && !isHelperCall(styleValue, '__kfCss') && isAnimatedElement(path.node.name, path, state)) {
            style.value = t.jsxExpressionContainer(t.callExpression(t.cloneNode(helper(state, path, '__kfCss')), [styleValue, site()]))
          }
        }
        if (!state.styleBindings.size) return
        let styleId: string | null = null
        for (const attr of path.node.attributes) {
          if (attr.type !== 'JSXAttribute' || attr.name.type !== 'JSXIdentifier') continue
          if (attr.name.name !== 'style' && attr.name.name !== 'animatedProps') continue
          if (attr.value?.type !== 'JSXExpressionContainer') continue
          const found: string[] = []
          path.get('attributes').forEach((ap) => {
            if (ap.node !== attr) return
            ap.traverse({
              Identifier(id) {
                const binding = id.scope.getBinding(id.node.name)
                const sid = binding ? state.styleBindings.get(binding.identifier) : undefined
                if (sid) found.push(sid)
              },
            })
          })
          if (found.length) {
            styleId = found[0]!
            break
          }
        }
        if (!styleId) return
        // Its static style is read once at runtime for what makes moving it costly (a shadow without a
        // path on iOS). The same object goes through.
        const viewStyle = jsxAttr(path.node, 'style')
        const viewStyleValue = jsxValue(viewStyle)
        if (viewStyle && viewStyleValue && !isHelperCall(viewStyleValue, '__kfViewStyle')) {
          viewStyle.value = t.jsxExpressionContainer(t.callExpression(t.cloneNode(helper(state, path, '__kfViewStyle')), [viewStyleValue, t.stringLiteral(styleId)]))
        }
        state.layoutHelper ??= path.scope.getProgramParent().generateUidIdentifier('kfLayout')
        const existing = path.node.attributes.find(
          (a): a is BabelTypes.JSXAttribute => a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && a.name.name === 'onLayout',
        )
        const prev = existing?.value?.type === 'JSXExpressionContainer' && existing.value.expression.type !== 'JSXEmptyExpression' ? existing.value.expression : null
        if (prev && prev.type === 'CallExpression' && prev.callee.type === 'Identifier' && prev.callee.name === state.layoutHelper.name) return
        const call = t.callExpression(t.cloneNode(state.layoutHelper), [t.stringLiteral(styleId), ...(prev ? [prev] : [])])
        if (existing) existing.value = t.jsxExpressionContainer(call)
        else path.node.attributes.push(t.jsxAttribute(t.jsxIdentifier('onLayout'), t.jsxExpressionContainer(call)))
      },

      CallExpression(path, state) {
        if (state.skip) return
        const { node } = path

        if (node.loc) {
          const file = relativeFile(state)
          const site = `${file}:${node.loc.start.line}`
          const callee = node.callee
          const calleeName =
            callee.type === 'Identifier'
              ? callee.name
              : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && state.reactLocals.has(callee.object.name)
                ? `React.${keyName(callee.property)}`
                : null
          // useEffect(() => …): timed on the JS thread while recording.
          if (calleeName && (state.effectLocals.has(calleeName) || /^React\.use(Layout)?Effect$/.test(calleeName))) {
            const fn = node.arguments[0]
            if (fn && (fn.type === 'ArrowFunctionExpression' || fn.type === 'FunctionExpression')) {
              node.arguments[0] = t.callExpression(t.cloneNode(helper(state, path, '__kfEffect')), [
                fn,
                t.stringLiteral(calleeName.replace('React.', '')),
                t.stringLiteral(site),
                literal(enclosingName(path)),
              ])
            }
          }
          // Worklets of Reanimated hooks, and scheduleOnUI / runOnUI: timed on the UI thread.
          if (calleeName && state.workletHookLocals.has(calleeName) && path.scope.getBinding(calleeName)?.kind === 'module') {
            const kind = state.workletHookLocals.get(calleeName)!
            const declarator = path.parentPath.isVariableDeclarator() ? path.parentPath.node : null
            const name = declarator?.id.type === 'Identifier' ? declarator.id.name : null
            const [first, second] = node.arguments
            if (kind === 'scroll' && first?.type === 'ObjectExpression') {
              for (const p of first.properties) {
                if (p.type !== 'ObjectProperty') continue
                if (keyName(p.key) === 'onScroll') reportScroll(state, path, p.value, `scroll:${site}`)
                timeWorklet(state, path, p.value, kind, site, keyName(p.key))
              }
            } else {
              if (kind === 'scroll') reportScroll(state, path, first, `scroll:${site}`)
              timeWorklet(state, path, first, kind, site, name)
            }
            if (kind === 'reaction') timeWorklet(state, path, second, kind, site, name)
          }
          if (calleeName && state.uiRunnerLocals.has(calleeName) && path.scope.getBinding(calleeName)?.kind === 'module') {
            timeWorklet(state, path, node.arguments[0], 'worklet', site, calleeName)
          }
        }

        // Gesture.Pan().onUpdate((e) => …): the inline callback reports where the finger is. Wrapping
        // it hides it from the worklets plugin's automatic workletization of gesture callbacks, so it
        // is marked 'worklet' here. Callbacks passed by name are left alone: they may not be worklets.
        if (state.gestureLocals.size && node.callee.type === 'MemberExpression' && !node.callee.computed && node.loc) {
          const on = keyName(node.callee.property)
          const fnArg = node.arguments[0]
          const gesture = on && GESTURE_CALLBACKS.has(on) ? gestureKind(node.callee.object, state.gestureLocals, path) : null
          if (gesture && fnArg && (fnArg.type === 'ArrowFunctionExpression' || fnArg.type === 'FunctionExpression')) {
            markWorklet(fnArg)
            const file = relativeFile(state)
            const site: InspectorGestureSite = {
              id: `${file}:${node.loc.start.line}:${node.loc.start.column}`,
              file,
              line: node.loc.start.line,
              component: enclosingName(path),
              gesture,
              on: on!,
            }
            state.gestureHelper ??= path.scope.getProgramParent().generateUidIdentifier('kfGesture')
            node.arguments[0] = t.callExpression(t.cloneNode(state.gestureHelper), [fnArg, literal(site)])
          }
          return
        }

        if (state.wrapped.has(node) || node.callee.type !== 'Identifier' || !node.loc) return
        const name = node.callee.name
        const file = relativeFile(state)
        const { line, column } = node.loc.start

        if (isImported(path, name, state.animLocals)) {
          const { target, prop } = targetOf(path)
          const site: InspectorCallSite = {
            id: `${file}:${line}:${column}`,
            file,
            line,
            column,
            fn: state.animLocals.get(name)!,
            component: enclosingName(path),
            target,
            prop,
            params: literalParams(node.arguments),
          }
          state.animHelper ??= path.scope.getProgramParent().generateUidIdentifier('kfAnim')
          // The finish callback (withTiming(1, cfg, (finished) => …)) runs on the UI thread.
          node.arguments.forEach(markWorklet)
          const call = t.callExpression(t.cloneNode(state.animHelper), [
            t.identifier(name),
            literal(site),
            ...node.arguments,
          ])
          state.wrapped.add(call)
          path.replaceWith(call)
          return
        }

        if (isImported(path, name, state.styleLocals)) {
          const declarator = path.parentPath.isVariableDeclarator() ? path.parentPath.node : null
          const worklet = path.get('arguments')[0]
          const site: InspectorStyleSite = {
            id: `${file}:${line}:${column}`,
            file,
            line,
            component: enclosingName(path),
            name: declarator?.id.type === 'Identifier' ? declarator.id.name : null,
            links: worklet && (worklet.isFunction() as boolean) ? styleLinks(worklet) : [],
          }
          state.styleHelper ??= path.scope.getProgramParent().generateUidIdentifier('kfStyle')
          if (declarator?.id.type === 'Identifier') state.styleBindings.set(declarator.id, site.id)
          state.wrapped.add(node)
          const call = t.callExpression(t.cloneNode(state.styleHelper), [node, literal(site)])
          state.wrapped.add(call)
          path.replaceWith(call)
          return
        }

        if (isImported(path, name, state.svLocals)) {
          const declarator = path.parentPath.isVariableDeclarator() ? path.parentPath.node : null
          const site: InspectorSignalSite = {
            id: `${file}:${line}:${column}`,
            file,
            line,
            component: enclosingName(path),
            name: declarator?.id.type === 'Identifier' ? declarator.id.name : null,
          }
          // A hook (it registers the instance in an effect), so its name starts with `use`: the React
          // Compiler and the rules of hooks must see it as one.
          state.signalHelper ??= path.scope.getProgramParent().hasBinding('useKfSignal')
            ? path.scope.getProgramParent().generateUidIdentifier('useKfSignal')
            : t.identifier('useKfSignal')
          state.wrapped.add(node)
          const call = t.callExpression(t.cloneNode(state.signalHelper), [node, literal(site)])
          state.wrapped.add(call)
          path.replaceWith(call)
        }
      },
  }

  return {
    name: 'keyframer-inspector',
    visitor: {
      Program: {
        enter(program, state) {
          const file = (state.filename ?? '').replace(/\\/g, '/')
          state.skip =
            (!state.opts.includeNodeModules && file.includes('/node_modules/')) || /\/packages\/inspector\/(src|dist)\//.test(file)
          state.animLocals = new Map()
          state.svLocals = new Set()
          state.gestureLocals = new Set()
          state.gestureHelper = null
          state.workletHookLocals = new Map()
          state.uiRunnerLocals = new Set()
          state.effectLocals = new Set()
          state.reactLocals = new Set()
          state.helpers = new Map()
          state.styleLocals = new Set()
          state.animHelper = null
          state.signalHelper = null
          state.styleHelper = null
          state.layoutHelper = null
          state.styleBindings = new Map()
          state.wrapped = new WeakSet()
          state.usesCss = /\b(animationName|transitionProperty|transitionDuration)\b/.test(state.file.code ?? '')
          state.animatedLocals = new Set()
          for (const stmt of program.node.body) {
            if (stmt.type === 'ImportDeclaration' && stmt.importKind !== 'type' && (stmt.source.value === 'react' || stmt.source.value === WORKLETS)) {
              for (const spec of stmt.specifiers) {
                if (spec.type !== 'ImportSpecifier') {
                  if (stmt.source.value === 'react') state.reactLocals.add(spec.local.name)
                  continue
                }
                const imported = spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value
                if (stmt.source.value === 'react' && EFFECT_HOOKS.has(imported)) state.effectLocals.add(spec.local.name)
                if (stmt.source.value === WORKLETS && UI_RUNNERS.has(imported)) state.uiRunnerLocals.add(spec.local.name)
              }
            }
            if (stmt.type === 'ImportDeclaration' && stmt.source.value === GESTURE_HANDLER && stmt.importKind !== 'type') {
              for (const spec of stmt.specifiers) {
                if (spec.type !== 'ImportSpecifier') continue
                const imported = spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value
                if (imported === 'Gesture') state.gestureLocals.add(spec.local.name)
              }
            }
            if (stmt.type !== 'ImportDeclaration' || stmt.source.value !== REANIMATED) continue
            if (stmt.importKind === 'type') continue
            for (const spec of stmt.specifiers) {
              if (spec.type !== 'ImportSpecifier') {
                state.animatedLocals.add(spec.local.name)
                continue
              }
              const imported = spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value
              if (ANIMATION_FNS.has(imported)) state.animLocals.set(spec.local.name, imported)
              if (imported === 'useSharedValue') state.svLocals.add(spec.local.name)
              if (imported === 'useAnimatedStyle' || imported === 'useAnimatedProps') state.styleLocals.add(spec.local.name)
              if (imported in WORKLET_HOOKS) state.workletHookLocals.set(spec.local.name, WORKLET_HOOKS[imported]!)
              if (UI_RUNNERS.has(imported)) state.uiRunnerLocals.add(spec.local.name)
            }
          }
          if (state.skip) return
          // Everything in one pass, here, before the plugins after this one see the file:
          // react-native-worklets/plugin copies each worklet's code when it reaches it, so the calls in
          // a worklet must be wrapped, and the helpers they call imported, by then.
          program.traverse(nodes, state)
          finish(program, state)
          // The imports are new bindings: the worklets plugin looks them up to capture them.
          program.scope.crawl()
        },
      },
    },
  }
}
