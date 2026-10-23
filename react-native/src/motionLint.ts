/**
 * Motion mistakes in a React Native app's code, found before it runs: animations that do not do what
 * they say (an input range Reanimated cannot read, a spring merged over a default nobody wrote down),
 * work that runs on every frame when it need not, and APIs Reanimated 4 and Gesture Handler 2 replaced.
 * None of them crashes (workletLint.ts has those). Each finding has a rule, a severity (`error`: it
 * does not do what it says; `warning`: it moves wrong or costs frames somewhere; `info`: worth a look),
 * where it is, and the fix.
 *
 * Like workletLint.ts, only what the file decides is reported: a rule that would have to guess (an
 * imported value, a config built at runtime, a spread) stays silent. A call counts when it is the
 * library's own import (`withSpring` from react-native-reanimated, `Gesture` from
 * react-native-gesture-handler), never by its name alone. What runs on every frame comes from the
 * worklet map workletLint builds (findWorklets): animated styles and props, frame callbacks, onScroll,
 * gesture onUpdate / onChange, derived values, and a reaction's second function.
 *
 * Silence one finding with `// keyframer-disable-next-line <rule>` on the line above it, or
 * `// keyframer-disable-line <rule>` at its end (lineSuppressions in workletLint.ts).
 *
 * Pure: a Babel program path in (the Babel plugin's, or the CLI's own parse), findings out. What a file
 * cannot say comes in the options (lintFacts.ts reads it from the project): the installed Reanimated
 * version and whether React Compiler is on. Without them, the checks that need them stay silent.
 */

import type { NodePath, types as T } from '@babel/core'
import { workletLabel } from './workletCrash'
import {
  calleeName,
  findWorklets,
  functionName,
  GESTURE_HOOKS,
  importOf,
  isFunctionPath,
  isMember,
  keyName,
  lineSuppressions,
  TO_JS,
  type Worklet,
} from './workletLint'

export type MotionSeverity = 'error' | 'warning' | 'info'

/** Every rule, with its severity and what it finds in a few words (the CLI and the docs list them). */
export const MOTION_RULES = {
  'descending-input-range': { severity: 'error', summary: 'interpolate or interpolateColor with a literal input range of 3 or more points that does not ascend' },
  'deprecated-api': { severity: 'warning', summary: 'runOnJS and runOnUI, deprecated and no-op Reanimated APIs, and Gesture Handler’s old components, with what replaces each' },
  'screen-dimensions': { severity: 'warning', summary: "Dimensions.get('screen') in a file that never reads the window's size" },
  'value-in-render': { severity: 'warning', summary: 'a shared value read while its component renders (JSX, dependency arrays, conditions)' },
  'per-frame-js': { severity: 'warning', summary: 'scheduleOnRN or runOnJS on every frame of a style, scroll, gesture move, frame callback or reaction, with no check' },
  'unclamped-zero-crossing': { severity: 'warning', summary: 'opacity or scale interpolated from a scroll or gesture value without clamping, heading past 0' },
  'measure-per-frame': { severity: 'info', summary: 'measure() in a worklet that runs every frame' },
  'ignored-finished': { severity: 'warning', summary: "an animation's callback that starts another animation (or calls JS) without reading finished" },
  'bare-spring': { severity: 'info', summary: 'withSpring without a config, or springify() without spring settings: Reanimated 4’s default does not overshoot' },
  'spring-missing-mass': { severity: 'warning', summary: 'a spring config with damping or stiffness but no mass, merged over Reanimated 4’s mass of 4' },
  'frame-rate-speed': { severity: 'warning', summary: 'a frame callback that adds a fixed step each frame without reading the frame time' },
  'unmemoized-gesture': { severity: 'info', summary: 'a Gesture built in a component’s body outside useMemo (skipped under React Compiler)' },
  'inline-cell-renderer': { severity: 'warning', summary: 'CellRendererComponent written inline or inside the component, or a cell renderer that drops onLayout' },
  'console-per-frame': { severity: 'warning', summary: 'console.log (warn, info, debug) in a worklet that runs every frame' },
  'zero-duration': { severity: 'info', summary: 'withTiming with duration 0 assigned to a value' },
  'reverse-sequence': { severity: 'warning', summary: 'withRepeat(withSequence(…), n, true): reverse does nothing on a sequence' },
  'transparent-color': { severity: 'warning', summary: "interpolateColor toward black at alpha 0 (rgba(0, 0, 0, 0) always, 'transparent' before Reanimated 4.1.4)" },
  'derived-side-effect': { severity: 'warning', summary: 'useDerivedValue that writes other shared values or calls scheduleOnRN' },
  'floor-scroll-offset': { severity: 'warning', summary: 'Math.floor of a scroll offset when momentum ends' },
} as const satisfies Record<string, { severity: MotionSeverity; summary: string }>

export type MotionRule = keyof typeof MOTION_RULES

export type MotionIssue = {
  /** Stable across reloads: `rule:file:line:column:name`. */
  id: string
  rule: MotionRule
  severity: MotionSeverity
  message: string
  fix: string
  file: string
  line: number
  column: number
  /** What is at fault: `interpolate`, `runOnJS`, `progress.value`, `Gesture.Pan`. */
  name: string
}

export type MotionLintOptions = {
  file: string
  code?: string
  /** The app's react-native-reanimated version ("4.5.1"). Unknown: Reanimated 4 is assumed (the inspector needs it), and what needs the exact version stays silent. */
  reanimated?: string | null
  /** React Compiler memoizes the app's components: unmemoized-gesture has nothing to say. */
  reactCompiler?: boolean
}

const SEVERITY_RANK: Record<MotionSeverity, number> = { info: 0, warning: 1, error: 2 }
/** Whether a severity is at least `min`. */
export const atLeast = (severity: MotionSeverity, min: MotionSeverity) => SEVERITY_RANK[severity] >= SEVERITY_RANK[min]

const REANIMATED = 'react-native-reanimated'
const WORKLETS = 'react-native-worklets'
const GESTURE_HANDLER = 'react-native-gesture-handler'
const ANIMATIONS = new Set(['withTiming', 'withSpring', 'withDecay', 'withDelay', 'withSequence', 'withRepeat', 'withClamp'])
/** Where each animation takes its finish callback. */
const CALLBACK_ARG: Record<string, number> = { withTiming: 2, withSpring: 2, withDecay: 1, withRepeat: 3 }
/** Calls whose function argument runs later, not when the worklet runs. */
const DEFERRED = new Set([...ANIMATIONS, ...TO_JS, 'scheduleOnUI', 'runOnUI', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'queueMicrotask'])
const MOVE_CALLBACKS = new Set(['onUpdate', 'onChange', 'onTouchesMove'])
const GESTURE_BUILDERS = new Set(['Tap', 'Pan', 'Pinch', 'Rotation', 'Fling', 'LongPress', 'ForceTouch', 'Native', 'Manual', 'Hover'])
const SPRING_METHODS = ['damping', 'stiffness', 'mass', 'dampingRatio']
const SCALE_KEYS = new Set(['scale', 'scaleX', 'scaleY'])
/** What a frame callback reads to know how long a frame took. */
const FRAME_TIME = new Set(['timeSincePreviousFrame', 'timestamp', 'timeSinceFirstFrame', 'now'])
/** Event fields that run past any range while a finger or a list moves. */
const UNBOUNDED_FIELDS = new Set(['contentOffset', 'translationX', 'translationY', 'absoluteX', 'absoluteY'])
/** What keeps a value inside a range when it is set. */
const CLAMPS = new Set(['clamp', 'min', 'max', 'CLAMP'])
/** Reanimated 4's withSpring defaults (GentleSpringConfig, spring.ts), which a config is merged over. */
const DEFAULT_SPRING = { damping: 120, stiffness: 900 }
/** The first Reanimated that interpolates 'transparent' from its neighbour's color (processColorRanges): 4.1.3 does not, 4.1.5 does. */
const TRANSPARENT_FIXED = [4, 1, 4] as const

type Deprecation = { use: string; why: string; r4?: boolean }
const oldHandler = (gesture: string): Deprecation => ({ use: `Gesture.${gesture}() in a GestureDetector`, why: 'the old gesture API, deprecated in Gesture Handler 2' })
const OLD_TOUCHABLE: Deprecation = { use: 'Pressable from react-native-gesture-handler', why: 'deprecated in Gesture Handler 2' }
const SWIPEABLE: Deprecation = { use: "ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable'", why: 'deprecated in Gesture Handler 2' }
const DRAWER: Deprecation = { use: "ReanimatedDrawerLayout from 'react-native-gesture-handler/ReanimatedDrawerLayout'", why: 'deprecated in Gesture Handler 2' }
/**
 * What each library deprecated, by module and export, checked against Reanimated 4.5.1, worklets 0.10
 * and Gesture Handler 2.32. `r4`: only so in Reanimated 4 (left alone in a Reanimated 3 app).
 */
const DEPRECATED: Record<string, Record<string, Deprecation>> = {
  [REANIMATED]: {
    runOnJS: { use: 'scheduleOnRN from react-native-worklets: scheduleOnRN(fn, ...args) for runOnJS(fn)(...args)', why: 'a deprecated shim of scheduleOnRN in Reanimated 4', r4: true },
    runOnUI: { use: 'scheduleOnUI from react-native-worklets: scheduleOnUI(fn, ...args) for runOnUI(fn)(...args)', why: 'a deprecated shim of scheduleOnUI in Reanimated 4', r4: true },
    executeOnUIRuntimeSync: { use: 'runOnUISync from react-native-worklets', why: 'deprecated in Reanimated 4', r4: true },
    runOnRuntime: { use: 'scheduleOnRuntime from react-native-worklets', why: 'deprecated in Reanimated 4', r4: true },
    makeShareableCloneRecursive: { use: 'createSerializable from react-native-worklets', why: 'deprecated in Reanimated 4', r4: true },
    addWhitelistedNativeProps: { use: 'nothing: delete the call (Reanimated 4 animates any prop)', why: 'a no-op in Reanimated 4', r4: true },
    addWhitelistedUIProps: { use: 'nothing: delete the call (Reanimated 4 animates any prop)', why: 'a no-op in Reanimated 4', r4: true },
    enableLayoutAnimations: { use: 'nothing: delete the call', why: 'without effect in Reanimated 4', r4: true },
    useAnimatedKeyboard: { use: 'react-native-keyboard-controller (useReanimatedKeyboardAnimation, KeyboardAvoidingView)', why: 'deprecated in Reanimated 4', r4: true },
    useScrollViewOffset: { use: 'useScrollOffset (the same arguments)', why: 'a deprecated alias in Reanimated 4', r4: true },
    Extrapolate: { use: 'Extrapolation (the same values)', why: 'a deprecated alias in Reanimated 4', r4: true },
    useAnimatedGestureHandler: { use: 'Gesture.Pan() (or Tap, Pinch…) in a GestureDetector from react-native-gesture-handler', why: 'gone in Reanimated 4 (deprecated in 3): the import is undefined there' },
  },
  [WORKLETS]: {
    runOnJS: { use: 'scheduleOnRN(fn, ...args) for runOnJS(fn)(...args)', why: 'deprecated in react-native-worklets' },
    runOnUI: { use: 'scheduleOnUI(fn, ...args) for runOnUI(fn)(...args)', why: 'deprecated in react-native-worklets' },
  },
  [GESTURE_HANDLER]: {
    PanGestureHandler: oldHandler('Pan'),
    TapGestureHandler: oldHandler('Tap'),
    LongPressGestureHandler: oldHandler('LongPress'),
    PinchGestureHandler: oldHandler('Pinch'),
    RotationGestureHandler: oldHandler('Rotation'),
    FlingGestureHandler: oldHandler('Fling'),
    ForceTouchGestureHandler: oldHandler('ForceTouch'),
    NativeViewGestureHandler: oldHandler('Native'),
    Swipeable: SWIPEABLE,
    DrawerLayout: DRAWER,
    gestureHandlerRootHOC: { use: 'GestureHandlerRootView around the app', why: 'deprecated in Gesture Handler 2' },
    TouchableOpacity: OLD_TOUCHABLE,
    TouchableHighlight: OLD_TOUCHABLE,
    TouchableWithoutFeedback: OLD_TOUCHABLE,
    TouchableNativeFeedback: OLD_TOUCHABLE,
  },
  [`${GESTURE_HANDLER}/Swipeable`]: { default: SWIPEABLE },
  [`${GESTURE_HANDLER}/DrawerLayout`]: { default: DRAWER },
}

type Binding = NonNullable<ReturnType<NodePath['scope']['getBinding']>>
/** What makes a worklet run on every frame it is needed: what the per-frame rules read. */
type FrameKind = 'style' | 'frame' | 'scroll' | 'gesture' | 'derived' | 'reaction'

const lineOf = (n: T.Node) => n.loc?.start.line ?? 0

/** An expression without what types and parentheses add: `[0, 1] as const` → `[0, 1]`. */
function unwrap(n: T.Node | null | undefined): T.Node | null {
  let e = n ?? null
  while (e && (e.type === 'TSAsExpression' || e.type === 'TSSatisfiesExpression' || e.type === 'TSNonNullExpression' || e.type === 'TSTypeAssertion' || e.type === 'ParenthesizedExpression')) e = e.expression
  return e
}

/** A number written as one: `12`, `-0.5`. */
function num(n: T.Node | null | undefined): number | null {
  const e = unwrap(n)
  if (!e) return null
  if (e.type === 'NumericLiteral') return e.value
  if (e.type === 'UnaryExpression' && (e.operator === '-' || e.operator === '+')) {
    const v = num(e.argument)
    return v === null ? null : e.operator === '-' ? -v : v
  }
  return null
}

/** The installed version as numbers: "4.5.1" → [4, 5, 1]; null when unknown. */
function versionOf(v: string | null | undefined): number[] | null {
  const m = v ? /(\d+)\.(\d+)\.(\d+)/.exec(v) : null
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
function before(v: number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) < min[i]!
  return false
}

/**
 * What a callee is when it is a library's export: `withSpring` (a named import) or `Animated.withSpring`
 * (a namespace or default import) → { source, name }. Null for anything else.
 */
function apiOf(callee: T.Node, path: NodePath): { source: string; name: string } | null {
  if (callee.type === 'Identifier') {
    const from = importOf(path, callee.name)
    if (!from || from.imported === 'default' || from.imported === '*') return null
    return { source: from.source, name: from.imported }
  }
  if (isMember(callee) && !callee.computed && callee.object.type === 'Identifier') {
    const from = importOf(path, callee.object.name)
    const prop = keyName(callee.property)
    if (from && prop && (from.imported === 'default' || from.imported === '*')) return { source: from.source, name: prop }
  }
  return null
}
function isApi(callee: T.Node, path: NodePath, sources: string[], name: string): boolean {
  const api = apiOf(callee, path)
  return !!api && sources.includes(api.source) && api.name === name
}
/** `scheduleOnRN(fn, …)` or `runOnJS(fn)(…)`: a call that sends work to the JS thread. Which, or null. */
function toJsCall(call: NodePath<T.CallExpression>): 'scheduleOnRN' | 'runOnJS' | null {
  const callee = call.node.callee
  if (isApi(callee, call, [WORKLETS], 'scheduleOnRN')) return 'scheduleOnRN'
  if (callee.type === 'CallExpression' && isApi(callee.callee, call, [REANIMATED, WORKLETS], 'runOnJS')) return 'runOnJS'
  return null
}

/** The component or hook a function is (by its name): what runs while React renders. */
function rendersIn(fn: NodePath | null | undefined): string | null {
  const name = fn ? functionName(fn) : null
  return name && (/^[A-Z]/.test(name) || /^use[A-Z]/.test(name)) ? name : null
}

/** Whether a name in `names` appears anywhere in an expression: an identifier or a property. */
function mentions(path: NodePath, names: Set<string>): boolean {
  if (path.isIdentifier() && names.has(path.node.name)) return true
  let found = false
  path.traverse({
    Identifier(p) {
      if (names.has(p.node.name)) {
        found = true
        p.stop()
      }
    },
  })
  return found
}

/**
 * Whether code runs each time the worklet runs: written in it, or in a callback it hands to a call
 * that runs it right there (`items.forEach`), not in one that runs later (an animation's callback,
 * scheduleOnRN, a timer).
 */
function runsWith(path: NodePath, worklet: NodePath<T.Function>): boolean {
  let fn = path.getFunctionParent()
  while (fn && fn.node !== worklet.node) {
    const parent = fn.parentPath
    if (!parent?.isCallExpression() || !parent.node.arguments.includes(fn.node as T.Expression)) return false
    const name = calleeName(parent.node)
    if (!name || DEFERRED.has(name)) return false
    fn = parent.getFunctionParent()
  }
  return !!fn
}

/** Whether a call in a worklet runs on some frames only: under an if, a ternary, `&&` or a switch, or after an early return. */
function guarded(path: NodePath, worklet: NodePath<T.Function>): boolean {
  for (let p = path.parentPath; p && p.node !== worklet.node; p = p.parentPath) {
    if (p.isIfStatement() || p.isConditionalExpression() || p.isLogicalExpression() || p.isSwitchCase()) return true
  }
  const start = path.node.start ?? 0
  let early = false
  worklet.traverse({
    Function(inner) {
      inner.skip()
    },
    ReturnStatement(r) {
      if ((r.node.end ?? Infinity) <= start) early = true
    },
  })
  return early
}

/** What makes a worklet run on every frame it is needed, or null. */
function frameKind(w: Worklet): FrameKind | null {
  if (w.thread === 'js') return null
  switch (w.kind) {
    case 'useAnimatedStyle':
    case 'useAnimatedProps':
      return 'style'
    case 'useFrameCallback':
      return 'frame'
    case 'useDerivedValue':
      return 'derived'
    case 'useAnimatedScrollHandler':
      return w.key === null || w.key === 'onScroll' ? 'scroll' : null
    case 'useAnimatedReaction':
      return w.call?.node.arguments[1] === w.fn.node ? 'reaction' : null
  }
  const method = w.kind.includes('.') ? w.kind.split('.')[1]! : GESTURE_HOOKS.has(w.kind) ? w.key : null
  return method && MOVE_CALLBACKS.has(method) ? 'gesture' : null
}

/** A color as `rgba(r, g, b, 0)` when it is written as hex or rgb(a): the same color, invisible. */
function clearOf(color: string): string | null {
  const c = color.trim()
  let m = /^#([0-9a-f]{3,4})$/i.exec(c)
  if (m) {
    const [r, g, b] = [...m[1]!].map((d) => parseInt(d + d, 16))
    return `rgba(${r}, ${g}, ${b}, 0)`
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c)
  if (m) return `rgba(${parseInt(m[1]!.slice(0, 2), 16)}, ${parseInt(m[1]!.slice(2, 4), 16)}, ${parseInt(m[1]!.slice(4, 6), 16)}, 0)`
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(c)
  if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, 0)`
  return null
}
/** Black at alpha 0, written out: what interpolates through dark grey. */
const isClearBlack = (color: string) => /^(#0000|#00000000|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0(\.0+)?\s*\))$/i.test(color.trim())
/** Black itself, which fades to black at alpha 0 without a grey between. */
const isBlack = (color: string) => /^(black|#000|#000f|#000000|#000000ff|rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(,\s*[\d.]+\s*)?\))$/i.test(color.trim())

/** A reference that changes the object it names: `cfg.mass = 1`, `cfg.damping++`, `delete cfg.mass`, `Object.assign(cfg, …)`. */
function changes(r: NodePath): boolean {
  const m = r.parentPath
  if (m?.isMemberExpression() && m.node.object === r.node) {
    const up = m.parentPath
    return (!!up?.isAssignmentExpression() && up.node.left === m.node) || !!up?.isUpdateExpression() || (!!up?.isUnaryExpression() && up.node.operator === 'delete')
  }
  if (!m?.isCallExpression() || m.node.arguments[0] !== r.node) return false
  const callee = m.node.callee
  return isMember(callee) && callee.object.type === 'Identifier' && callee.object.name === 'Object' && keyName(callee.property) === 'assign'
}

const isMomentumProp = (p: NodePath | null | undefined) => !!p?.isJSXAttribute() && p.node.name.type === 'JSXIdentifier' && p.node.name.name === 'onMomentumScrollEnd'

/** A cell renderer that never hands onLayout to what it renders. False when that can't be told. */
function dropsOnLayout(fn: NodePath<T.Function>): boolean {
  const first = fn.node.params[0]
  if (!first) return true
  // What carries the props on: `{...props}` on an element or in an object, or props.onLayout.
  const carried = (name: string, allowMember: boolean) => {
    let passes = false
    fn.traverse({
      JSXSpreadAttribute(s) {
        if (s.node.argument.type === 'Identifier' && s.node.argument.name === name) passes = true
      },
      SpreadElement(s) {
        if (s.node.argument.type === 'Identifier' && s.node.argument.name === name) passes = true
      },
      MemberExpression(m) {
        if (allowMember && m.node.object.type === 'Identifier' && m.node.object.name === name && keyName(m.node.property) === 'onLayout') passes = true
      },
    })
    return passes
  }
  if (first.type === 'Identifier') return !carried(first.name, true)
  if (first.type !== 'ObjectPattern') return false
  if (first.properties.some((p) => p.type === 'ObjectProperty' && keyName(p.key) === 'onLayout')) return false
  const rest = first.properties.find((p): p is T.RestElement => p.type === 'RestElement')
  if (!rest) return true
  return rest.argument.type === 'Identifier' ? !carried(rest.argument.name, false) : false
}

export function analyzeMotion(program: NodePath<T.Program>, opts: MotionLintOptions): MotionIssue[] {
  const file = opts.file
  const code = opts.code ?? ''
  const suppressed = lineSuppressions(program)
  const version = versionOf(opts.reanimated)
  const usesWorklets = program.node.body.some((s) => s.type === 'ImportDeclaration' && s.source.value === WORKLETS)
  /** Reanimated 4: known, or assumed (the inspector needs it), and certain when the file imports react-native-worklets. */
  const r4 = usesWorklets || !version || version[0]! >= 4
  const issues: MotionIssue[] = []
  const seen = new Set<string>()
  const report = (rule: MotionRule, node: T.Node, name: string, message: string, fix: string) => {
    const line = lineOf(node)
    const column = (node.loc?.start.column ?? 0) + 1
    if (suppressed(rule, line)) return
    const id = `${rule}:${file}:${line}:${column}:${name}`
    if (seen.has(id)) return
    seen.add(id)
    issues.push({ id, rule, severity: MOTION_RULES[rule].severity, message, fix, file, line, column, name })
  }
  /** Code as written (`scrollY.value`), or null when it is long, spans lines, or there is no source. */
  const src = (n: T.Node | null | undefined, max = 60): string | null => {
    if (!n || n.start == null || n.end == null || !code) return null
    const t = code.slice(n.start, n.end)
    return t.length > max || t.includes('\n') ? null : t
  }

  const { worklets } = findWorklets(program, file)

  // ── What the file holds: its shared values, and which run past any range ──────
  /** Shared values made here (useSharedValue, useDerivedValue, useScrollOffset). */
  const sharedValues = new Set<Binding>()
  /** Shared values that follow a scroll or a finger: set in onScroll or a gesture's move without a clamp, or useScrollOffset. */
  const unbounded = new Set<Binding>()
  program.traverse({
    VariableDeclarator(decl) {
      const init = unwrap(decl.node.init)
      if (decl.node.id.type !== 'Identifier' || init?.type !== 'CallExpression') return
      const api = apiOf(init.callee, decl)
      if (api?.source !== REANIMATED) return
      const b = decl.scope.getBinding(decl.node.id.name)
      if (!b) return
      if (['useSharedValue', 'useDerivedValue', 'useScrollOffset', 'useScrollViewOffset'].includes(api.name)) sharedValues.add(b)
      if (api.name === 'useScrollOffset' || api.name === 'useScrollViewOffset') unbounded.add(b)
    },
  })
  for (const w of worklets.values()) {
    const kind = frameKind(w)
    if (kind !== 'scroll' && kind !== 'gesture') continue
    w.fn.traverse({
      AssignmentExpression(a) {
        const left = a.node.left
        if (left.type !== 'MemberExpression' || left.computed || keyName(left.property) !== 'value' || left.object.type !== 'Identifier') return
        const right = a.get('right') as NodePath
        const r = unwrap(right.node)
        if (r?.type === 'CallExpression' && ANIMATIONS.has(calleeName(r) ?? '')) return
        if (mentions(right, CLAMPS)) return
        const b = a.scope.getBinding(left.object.name)
        if (b && sharedValues.has(b)) unbounded.add(b)
      },
    })
  }

  /** A literal array argument, or a constant set to one that nothing changes: the array. */
  const arrayOf = (arg: NodePath | undefined): T.ArrayExpression | null => {
    if (!arg) return null
    const e = unwrap(arg.node)
    if (e?.type === 'ArrayExpression') return e
    if (e?.type !== 'Identifier') return null
    const b = arg.scope.getBinding(e.name)
    if (!b || !b.constant || !b.path.isVariableDeclarator()) return null
    const init = unwrap(b.path.node.init)
    if (init?.type !== 'ArrayExpression') return null
    // `range.reverse()`, `range[0] = …`: what it holds when interpolate runs is not what is written.
    if (b.referencePaths.some((r) => changes(r) || (r.parentPath?.isMemberExpression() && r.parentPath.node.object === r.node && r.parentPath.parentPath?.isCallExpression()))) return null
    return init
  }
  const numbersOf = (arr: T.ArrayExpression | null): number[] | null => {
    if (!arr) return null
    const out: number[] = []
    for (const el of arr.elements) {
      const v = num(el)
      if (v === null) return null
      out.push(v)
    }
    return out
  }
  const stringsOf = (arr: T.ArrayExpression | null): string[] | null => {
    if (!arr) return null
    const out: string[] = []
    for (const el of arr.elements) {
      const e = unwrap(el)
      if (e?.type !== 'StringLiteral') return null
      out.push(e.value)
    }
    return out
  }
  const listText = (arr: T.ArrayExpression, reversed: boolean): string | null => {
    const parts = arr.elements.map((el) => src(el, 40))
    if (parts.some((p) => p === null)) return null
    return `[${(reversed ? parts.reverse() : parts).join(', ')}]`
  }

  // ── interpolate: the input range, extrapolation past 0, colors ───────────────────
  const interpolation = (call: NodePath<T.CallExpression>, fn: 'interpolate' | 'interpolateColor') => {
    const args = call.get('arguments') as NodePath[]
    const inputArr = arrayOf(args[1])
    const input = numbersOf(inputArr)
    const outputArr = arrayOf(args[2])
    if (input && input.length >= 3) {
      const at = input.findIndex((v, i) => i > 0 && v < input[i - 1]!)
      if (at > 0) {
        const descending = input.every((v, i) => i === 0 || v < input[i - 1]!)
        const value = src(args[0]?.node)
        const inText = inputArr ? listText(inputArr, true) : null
        const outText = outputArr ? listText(outputArr, true) : null
        report(
          'descending-input-range',
          args[1]!.node,
          fn,
          `${fn}'s input range [${input.join(', ')}] does not ascend (${input[at - 1]} then ${input[at]}): Reanimated finds a value's segment with a binary search that assumes it does, so values land on the wrong segment`,
          descending && value && inText && outText
            ? `Write both ranges the other way round, which maps the same: ${fn}(${value}, ${inText}, ${outText}${args.length > 3 ? ', …' : ''}).`
            : 'Write the input range in ascending order and move each output value with its input (two points may go either way; three or more must ascend).',
        )
      }
    }
    if (fn === 'interpolateColor') {
      const colors = stringsOf(outputArr)
      if (!colors || !outputArr) return
      colors.forEach((c, i) => {
        const transparent = c === 'transparent' && version !== null && before(version, TRANSPARENT_FIXED)
        if (!transparent && !isClearBlack(c)) return
        const neighbour = [colors[i - 1], colors[i + 1]].find((n): n is string => n !== undefined && n !== 'transparent' && !isBlack(n) && !isClearBlack(n))
        if (!neighbour) return
        const clear = clearOf(neighbour)
        report(
          'transparent-color',
          outputArr.elements[i]!,
          c,
          `interpolateColor goes from ${neighbour} to '${c}', which is black at alpha 0${transparent ? ` in Reanimated ${opts.reanimated}` : ''}: the colors between pass through a dark, half-clear grey`,
          `Fade the same color out instead: ${clear ? `'${clear}'` : `${neighbour} at alpha 0`}${c === 'transparent' ? " (Reanimated 4.1.4 and later do this for 'transparent' on their own)" : ''}.`,
        )
      })
      return
    }
    zeroCrossing(call, args, input, numbersOf(outputArr))
  }

  /** `scale: interpolate(scrollY.value, [0, 200], [1, 0.6])`: past the range it keeps shrinking, through 0 into a mirrored view. */
  const zeroCrossing = (call: NodePath<T.CallExpression>, args: NodePath[], input: number[] | null, output: number[] | null) => {
    if (!input || !output || input.length !== output.length || input.length < 2) return
    if (input.some((v, i) => i > 0 && v <= input[i - 1]!)) return
    // The value of a style key, as written: `opacity: interpolate(…)`, `{ scale: interpolate(…) }`.
    let p: NodePath = call
    while (p.parentPath && (p.parentPath.isTSAsExpression() || p.parentPath.isParenthesizedExpression() || p.parentPath.isTSNonNullExpression())) p = p.parentPath
    const prop = p.parentPath?.isObjectProperty() && p.parentPath.node.value === p.node ? keyName(p.parentPath.node.key) : null
    if (!prop || (prop !== 'opacity' && !SCALE_KEYS.has(prop))) return
    // Only an input known to run past its range: a scroll offset, or a finger's movement.
    const driver = args[0]
    const by = driver ? drivenBy(driver) : null
    if (!by) return
    const extend = (side: 'Left' | 'Right'): boolean | null => {
      const cfg = unwrap(args[3]?.node)
      const kind = (e: T.Node | null): boolean | null => {
        if (!e) return true
        if (e.type === 'StringLiteral') return e.value === 'extend' ? true : e.value === 'clamp' || e.value === 'identity' ? false : null
        if (isMember(e) && !e.computed) {
          const k = keyName(e.property)
          return k === 'EXTEND' ? true : k === 'CLAMP' || k === 'IDENTITY' ? false : null
        }
        return null
      }
      if (cfg?.type !== 'ObjectExpression') return kind(cfg)
      if (cfg.properties.some((q) => q.type !== 'ObjectProperty')) return null
      const own = cfg.properties.find((q): q is T.ObjectProperty => q.type === 'ObjectProperty' && keyName(q.key) === `extrapolate${side}`)
      return own ? kind(unwrap(own.value)) : true
    }
    const n = input.length
    // How the output moves per unit as the input leaves the range on each side.
    const edges = [
      { side: 'Left' as const, rate: -(output[1]! - output[0]!) / (input[1]! - input[0]!), edge: output[0]!, at: input[0]!, where: `below ${input[0]}, the start of its input range` },
      { side: 'Right' as const, rate: (output[n - 1]! - output[n - 2]!) / (input[n - 1]! - input[n - 2]!), edge: output[n - 1]!, at: input[n - 1]!, where: `past ${input[n - 1]}, the end of its input range` },
    ]
    for (const e of edges) {
      // Heading down to 0. A rate of ±1 follows the input one to one: a pin, on purpose.
      if (!(e.rate < 0) || e.edge < 0 || Math.abs(e.rate) === 1 || extend(e.side) !== true) continue
      const zeroAt = e.side === 'Left' ? e.at - e.edge / -e.rate : e.at + e.edge / -e.rate
      const scale = SCALE_KEYS.has(prop)
      report(
        'unclamped-zero-crossing',
        call.node,
        prop,
        `${prop} keeps falling ${e.where}: interpolate extends by default, so as the ${by} goes on ${prop} reaches 0 at ${+zeroAt.toFixed(2)} and then ${scale ? 'turns negative, which mirrors the view' : 'goes below 0'}`,
        `Clamp it: interpolate(…, Extrapolation.CLAMP), or { extrapolate${e.side}: Extrapolation.CLAMP } for this side only.`,
      )
    }
  }
  /** What drives an interpolation past any range: 'scroll' or 'gesture', or null when not known to. */
  const drivenBy = (driver: NodePath): 'scroll' | 'gesture' | null => {
    let by: 'scroll' | 'gesture' | null = null
    const check = (p: NodePath) => {
      if (p.isIdentifier()) {
        const b = p.scope.getBinding(p.node.name)
        if (b && unbounded.has(b)) by ??= /scroll/i.test(p.node.name) ? 'scroll' : 'gesture'
        if (UNBOUNDED_FIELDS.has(p.node.name) && p.parentPath && isMember(p.parentPath.node) && p.parentPath.node.property === p.node) by ??= p.node.name === 'contentOffset' ? 'scroll' : 'gesture'
      }
    }
    check(driver)
    driver.traverse({ Identifier: check })
    return by
  }

  // ── Springs ───────────────────────────────────────────────────────────────────────
  /** What these numbers do with mass 4 against mass 1, for the message. */
  const springWords = (damping: number | null, stiffness: number | null) => {
    const d = damping ?? DEFAULT_SPRING.damping
    const k = stiffness ?? DEFAULT_SPRING.stiffness
    if (!(k > 0) || !(d >= 0)) return ''
    const ratio = (m: number) => +(d / (2 * Math.sqrt(k * m))).toFixed(2)
    return ` (damping ratio ${ratio(4)} instead of ${ratio(1)})`
  }
  const which = (damping: boolean, stiffness: boolean) => (damping && stiffness ? 'damping and stiffness' : damping ? 'damping' : 'stiffness')
  const withSpring = (call: NodePath<T.CallExpression>) => {
    const cfg = unwrap(call.node.arguments[1])
    if (!cfg || (cfg.type === 'Identifier' && cfg.name === 'undefined')) {
      report(
        'bare-spring',
        call.node,
        'withSpring',
        "withSpring without a config uses Reanimated 4's default, GentleSpringConfig, which is critically damped: it settles without overshoot or bounce",
        'If it should bounce, pass a config: withSpring(v, WigglySpringConfig) (both from react-native-reanimated), or { damping, stiffness, mass }. A Reanimated 3 app moving to 4 loses its bounce here.',
      )
      return
    }
    // A config written here, or a constant set to one that nothing changes (`const SNAPPY = { damping: 15 }`).
    let config: T.Node = cfg
    let held: string | null = null
    if (cfg.type === 'Identifier') {
      const b = call.scope.getBinding(cfg.name)
      const init = b?.constant && b.path.isVariableDeclarator() ? unwrap(b.path.node.init) : null
      if (!b || init?.type !== 'ObjectExpression' || b.referencePaths.some(changes)) return
      config = init
      held = cfg.name
    }
    if (config.type !== 'ObjectExpression' || config.properties.some((p) => p.type !== 'ObjectProperty' || p.computed)) return
    const keys = new Map(config.properties.map((p) => [keyName((p as T.ObjectProperty).key) ?? '', (p as T.ObjectProperty).value]))
    if ((!keys.has('damping') && !keys.has('stiffness')) || keys.has('mass') || keys.has('duration') || keys.has('dampingRatio')) return
    report(
      'spring-missing-mass',
      config,
      'withSpring',
      `This spring${held ? ` (${held})` : ''} sets ${which(keys.has('damping'), keys.has('stiffness'))} but not mass: Reanimated 4 merges it over its default config, whose mass is 4, so it moves half as fast and bounces more than the same numbers with mass 1${springWords(num(keys.get('damping')), num(keys.get('stiffness')))}`,
      'Add mass: 1 if the numbers come from Reanimated 3 or a tool that assumes mass 1; otherwise write the mass you tuned with, so the config says what it does.',
    )
  }
  /** Layout animations, read as one chain: `FadeIn.springify().damping(12)`. */
  const chainsRead = new Set<T.Node>()
  const springify = (call: NodePath<T.CallExpression>) => {
    let top: NodePath = call
    while (top.parentPath?.isMemberExpression() && top.parentPath.node.object === top.node && top.parentPath.parentPath?.isCallExpression() && top.parentPath.parentPath.node.callee === top.parentPath.node) {
      top = top.parentPath.parentPath
    }
    if (chainsRead.has(top.node)) return
    chainsRead.add(top.node)
    const methods = new Map<string, T.CallExpression>()
    let e: T.Node = top.node
    for (let i = 0; i < 60 && e.type === 'CallExpression' && isMember(e.callee) && !e.callee.computed; i++) {
      const name = keyName(e.callee.property)
      if (name) methods.set(name, e)
      e = e.callee.object
    }
    // The chain starts at one of Reanimated's layout animations: `FadeIn`, `LinearTransition`, `new ZoomIn()`.
    const root = e.type === 'NewExpression' ? e.callee : e
    if (root.type !== 'Identifier' || importOf(call, root.name)?.source !== REANIMATED) return
    const spring = methods.get('springify')
    if (!spring) return
    const has = (m: string) => methods.has(m)
    if (!spring.arguments.length && !SPRING_METHODS.some(has)) {
      report(
        'bare-spring',
        spring,
        'springify',
        `${root.name}.springify() without spring settings uses Reanimated 4's default, GentleSpringConfig, which is critically damped: it settles without overshoot`,
        `If it should bounce, chain the spring: ${root.name}.springify().damping(…).stiffness(…).mass(…), or .dampingRatio(…) below 1.`,
      )
      return
    }
    if ((has('damping') || has('stiffness')) && !has('mass') && !has('dampingRatio') && !spring.arguments.length) {
      report(
        'spring-missing-mass',
        spring,
        'springify',
        `${root.name}.springify() sets ${which(has('damping'), has('stiffness'))} but not mass: Reanimated 4 merges it over its default config, whose mass is 4, so it moves half as fast and bounces more than the same numbers with mass 1${springWords(num(methods.get('damping')?.arguments[0]), num(methods.get('stiffness')?.arguments[0]))}`,
        'Chain .mass(1) if the numbers come from Reanimated 3 or a tool that assumes mass 1; otherwise chain the mass you tuned with.',
      )
    }
  }

  // ── Animation calls: callbacks, zero-length timings, repeats ────────────────────
  const animationCall = (call: NodePath<T.CallExpression>, fn: string) => {
    const args = call.get('arguments') as NodePath[]
    const i = CALLBACK_ARG[fn]
    if (i !== undefined && args[i]) ignoredFinished(args[i]!, fn)
    if (fn === 'withTiming') zeroDuration(call, args)
    if (fn === 'withRepeat') {
      const inner = unwrap(args[0]?.node)
      const reverse = unwrap(args[2]?.node)
      if (inner?.type === 'CallExpression' && reverse?.type === 'BooleanLiteral' && reverse.value && isApi(inner.callee, call, [REANIMATED], 'withSequence')) {
        report(
          'reverse-sequence',
          args[2]!.node,
          'withRepeat',
          "withRepeat's reverse only swaps the inner animation's target: a withSequence has none of its own, so every repeat plays the sequence forward again from where the last one ended",
          'Drop reverse and write the way back into the sequence: withRepeat(withSequence(withTiming(a), withTiming(b), withTiming(a)), n).',
        )
      }
    }
  }
  const zeroDuration = (call: NodePath<T.CallExpression>, args: NodePath[]) => {
    const parent = call.parentPath
    const assigned =
      (parent.isAssignmentExpression() && parent.node.right === call.node && parent.node.operator === '=') ||
      (parent.isCallExpression() && parent.node.arguments[0] === call.node && isMember(parent.node.callee) && keyName(parent.node.callee.property) === 'set')
    const cfg = unwrap(args[1]?.node)
    if (!assigned || args.length !== 2 || cfg?.type !== 'ObjectExpression') return
    if (!cfg.properties.every((p) => p.type === 'ObjectProperty' && !p.computed && ['duration', 'easing'].includes(keyName(p.key) ?? ''))) return
    const duration = cfg.properties.find((p) => keyName((p as T.ObjectProperty).key) === 'duration') as T.ObjectProperty | undefined
    if (!duration || num(duration.value) !== 0) return
    const target = parent.isAssignmentExpression() ? src(parent.node.left) : null
    const value = src(args[0]?.node)
    report(
      'zero-duration',
      call.node,
      'withTiming',
      'withTiming with duration 0 still starts an animation: the value changes a frame later, and only then is whatever was running cancelled',
      `Set the value: ${target && value ? `${target} = ${value}` : 'x.value = v'}.`,
    )
  }
  const ignoredFinished = (arg: NodePath, fn: string) => {
    let cb: NodePath<T.Function> | null = isFunctionPath(arg) ? arg : null
    if (!cb && arg.isIdentifier()) {
      const b = arg.scope.getBinding(arg.node.name)
      if (b?.path.isFunctionDeclaration()) cb = b.path
      else if (b?.constant && b.path.isVariableDeclarator()) {
        const init = b.path.get('init') as NodePath
        if (isFunctionPath(init)) cb = init
      }
    }
    if (!cb) return
    const callback = cb
    const first = callback.node.params[0]
    if (first) {
      // `_finished`: ignored on purpose.
      if (first.type !== 'Identifier' || first.name.startsWith('_')) return
      if (callback.scope.getBinding(first.name)?.referenced) return
    }
    let does: string | null = null
    callback.traverse({
      CallExpression(c) {
        if (does || !runsWith(c, callback)) return
        const api = apiOf(c.node.callee, c)
        const js = toJsCall(c)
        if (api?.source === REANIMATED && ANIMATIONS.has(api.name)) does = `starts ${api.name}`
        else if (js) does = `calls ${js}`
      },
    })
    if (!does) return
    report(
      'ignored-finished',
      callback.node,
      fn,
      `The ${fn} callback ${does} without reading finished: it also runs when the animation is cancelled (finished is false), so an interrupted animation still chains into what comes next`,
      'Read the first argument: (finished) => { if (finished) { … } }.',
    )
  }

  // ── Worklets that run on every frame ────────────────────────────────────────────
  for (const w of worklets.values()) {
    const kind = frameKind(w)
    if (!kind) continue
    const label = workletLabel(w)
    const derived = `The useDerivedValue worklet${w.name ? ` (${w.name})` : ''}`
    w.fn.traverse({
      CallExpression(call) {
        if (!runsWith(call, w.fn)) return
        const callee = call.node.callee
        const js = toJsCall(call)
        if (js && kind === 'derived') {
          report(
            'derived-side-effect',
            call.node,
            js,
            `${derived} calls ${js}: a derived value should only compute and return, and it runs again whenever what it reads changes, so this runs on every frame`,
            'Move it to a useAnimatedReaction on the same inputs, with a check that the value changed.',
          )
        } else if (js && !guarded(call, w.fn)) {
          const target = src(js === 'runOnJS' ? (callee as T.CallExpression).arguments[0] : call.node.arguments[0], 30)
          report(
            'per-frame-js',
            call.node,
            js,
            `${label} calls ${js}${target ? ` (${target})` : ''} on every frame it runs, with nothing checking whether the value changed: up to 120 trips a second to the JS thread, each a React render when it sets state`,
            kind === 'reaction'
              ? 'Compare with the previous value first: useAnimatedReaction(() => …, (now, prev) => { if (now !== prev) scheduleOnRN(fn, now) }), or derive something that changes less often (Math.round, a threshold).'
              : 'Call it only when what JS needs changes: useAnimatedReaction(() => Math.round(x.value), (now, prev) => { if (now !== prev) scheduleOnRN(fn, now) }), or keep the last value in a shared value and compare before calling.',
          )
        }
        if (kind !== 'derived' && kind !== 'reaction' && isApi(callee, call, [REANIMATED], 'measure')) {
          report(
            'measure-per-frame',
            call.node,
            'measure',
            `${label} calls measure() on every frame it runs: a synchronous layout read on the UI thread each time`,
            'If the measured view does not move while this runs, measure once when the gesture or scroll starts (onBegin, onStart, onBeginDrag) and keep the result in a shared value. A view that moves needs it.',
          )
        }
        if (kind !== 'reaction' && isMember(callee) && !callee.computed && callee.object.type === 'Identifier' && callee.object.name === 'console' && !call.scope.getBinding('console')) {
          const method = keyName(callee.property)
          if (method && ['log', 'warn', 'info', 'debug'].includes(method)) {
            report(
              'console-per-frame',
              call.node,
              `console.${method}`,
              `${label} calls console.${method} on every frame it runs: each call is copied to the JS thread, and the log floods`,
              'Remove it, or log only when something changes.',
            )
          }
        }
        // `other.set(…)` in a derived value, React Compiler style.
        if (kind === 'derived' && isMember(callee) && !callee.computed && keyName(callee.property) === 'set' && callee.object.type === 'Identifier') {
          const b = call.scope.getBinding(callee.object.name)
          if (b && sharedValues.has(b)) {
            report(
              'derived-side-effect',
              callee,
              `${callee.object.name}.set`,
              `${derived} sets ${callee.object.name}: a derived value should only compute and return, and it runs again whenever what it reads changes, so the write runs on every frame`,
              `Return the value from useDerivedValue, or set ${callee.object.name} in a useAnimatedReaction on the same inputs.`,
            )
          }
        }
      },
      AssignmentExpression(a) {
        if (kind !== 'derived' || !runsWith(a, w.fn)) return
        const left = a.node.left
        if (left.type !== 'MemberExpression' || left.computed || keyName(left.property) !== 'value' || left.object.type !== 'Identifier') return
        const b = a.scope.getBinding(left.object.name)
        if (!b || b.path === w.fn || b.path.isDescendant(w.fn)) return
        report(
          'derived-side-effect',
          left,
          `${left.object.name}.value`,
          `${derived} writes ${left.object.name}.value: a derived value should only compute and return, and it runs again whenever what it reads changes, so the write runs on every frame (and can feed itself)`,
          `Return the value from useDerivedValue, or write ${left.object.name}.value in a useAnimatedReaction on the same inputs.`,
        )
      },
    })
    if (kind === 'frame') frameRate(w)
  }

  /** `rotation.value += 2` once per frame: twice as fast at 120 Hz as at 60. */
  function frameRate(w: Worklet) {
    if (mentions(w.fn, FRAME_TIME)) return
    w.fn.traverse({
      AssignmentExpression(a) {
        if (!runsWith(a, w.fn)) return
        const left = a.node.left
        if (left.type !== 'MemberExpression' || left.computed || keyName(left.property) !== 'value' || left.object.type !== 'Identifier') return
        const b = a.scope.getBinding(left.object.name)
        if (!b || b.path === w.fn || b.path.isDescendant(w.fn)) return
        const target = left.object.name
        let step: T.Node | null = null
        if (a.node.operator === '+=' || a.node.operator === '-=') step = a.node.right
        else if (a.node.operator === '=') {
          const right = unwrap(a.node.right)
          const same = (n: T.Node) => n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && n.object.name === target && keyName(n.property) === 'value'
          if (right?.type === 'BinaryExpression' && (right.operator === '+' || right.operator === '-') && same(right.left)) step = right.right
        }
        if (!step) return
        // A counter (`frames.value += 1`) counts frames on purpose.
        if (num(step) === 1 && /count|frame|tick/i.test(left.object.name)) return
        report(
          'frame-rate-speed',
          left,
          `${left.object.name}.value`,
          `The useFrameCallback worklet moves ${left.object.name}.value by a fixed step every frame: it runs once per frame, so it goes twice as fast at 120 Hz as at 60 Hz, and slows down when frames drop`,
          `Scale the step by the frame's time: useFrameCallback(({ timeSincePreviousFrame }) => { ${left.object.name}.value ${a.node.operator === '-=' ? '-=' : '+='} ${src(step, 30) ?? 'step'} * ((timeSincePreviousFrame ?? 16.7) / 16.7) }).`,
        )
      },
    })
  }

  // ── Imports: what each library deprecated ──────────────────────────────────────
  for (const stmt of program.get('body')) {
    if (!stmt.isImportDeclaration() || stmt.node.importKind === 'type') continue
    const source = stmt.node.source.value
    const table = DEPRECATED[source]
    if (!table) continue
    for (const spec of stmt.get('specifiers')) {
      const node = spec.node
      if (node.type === 'ImportSpecifier' && node.importKind === 'type') continue
      const imported = node.type === 'ImportSpecifier' ? (node.imported.type === 'Identifier' ? node.imported.name : node.imported.value) : node.type === 'ImportDefaultSpecifier' ? 'default' : '*'
      const refs = spec.scope.getBinding(node.local.name)?.referencePaths ?? []
      if (imported === '*' || (imported === 'default' && !table.default)) {
        // `Reanimated.runOnJS(…)`, `Animated.addWhitelistedNativeProps(…)`: each use of a deprecated member.
        for (const r of refs) {
          const m = r.parentPath
          if (!m || !isMember(m.node) || m.node.object !== r.node || m.node.computed) continue
          const name = keyName(m.node.property)
          const d = name ? table[name] : undefined
          if (!name || !d || (d.r4 && !r4)) continue
          report('deprecated-api', m.node, name, `${node.local.name}.${name} is ${d.why}`, `Use ${d.use}.`)
        }
        continue
      }
      const d = table[imported]
      if (!d || (d.r4 && !r4)) continue
      const lines = [...new Set(refs.map((r) => lineOf(r.node)))].sort((x, y) => x - y)
      const shown = imported === 'default' ? node.local.name : imported
      report(
        'deprecated-api',
        node,
        shown,
        `${shown} from ${source} is ${d.why}`,
        `Use ${d.use}${lines.length ? ` (used on line${lines.length === 1 ? '' : 's'} ${lines.slice(0, 6).join(', ')}${lines.length > 6 ? '…' : ''})` : ''}.`,
      )
    }
  }

  // ── The rest, in one pass ──────────────────────────────────────────────────────
  /** Dimensions.get('screen') calls, reported unless the file also reads the window (then comparing them is the point). */
  const screenCalls: T.CallExpression[] = []
  let readsWindow = false
  const usesMemoDirective = (fn: NodePath | null) => {
    for (let p: NodePath | null = fn; p; p = p.parentPath) {
      const body = p.isProgram() ? p.node : p.isFunction() && p.node.body.type === 'BlockStatement' ? p.node.body : null
      if (body?.directives.some((d) => d.value.value === 'use memo')) return true
    }
    return false
  }
  program.traverse({
    CallExpression(call) {
      const callee = call.node.callee
      const api = apiOf(callee, call)
      if (api?.source === REANIMATED) {
        if (api.name === 'interpolate' || api.name === 'interpolateColor') interpolation(call, api.name)
        if (api.name === 'withSpring') withSpring(call)
        if (ANIMATIONS.has(api.name)) animationCall(call, api.name)
      }
      if (api?.source === 'react-native' && api.name === 'useWindowDimensions') readsWindow = true
      if (!isMember(callee) || callee.computed) return
      const prop = keyName(callee.property)
      const object = callee.object.type === 'Identifier' ? callee.object.name : null
      if (prop === 'springify') springify(call)
      if (prop === 'get' && object) {
        const from = importOf(call, object)
        const arg = unwrap(call.node.arguments[0])
        if (from?.source === 'react-native' && from.imported === 'Dimensions' && arg?.type === 'StringLiteral') {
          if (arg.value === 'screen') screenCalls.push(call.node)
          if (arg.value === 'window') readsWindow = true
        }
        // A shared value's get() while rendering.
        if (!call.node.arguments.length) renderRead(call, object, `${object}.get()`)
      }
      // Gesture.Pan() in a component's body
      if (prop && GESTURE_BUILDERS.has(prop) && object) {
        const from = importOf(call, object)
        const fn = call.getFunctionParent()
        const owner = rendersIn(fn)
        if (from?.source === GESTURE_HANDLER && from.imported === 'Gesture' && owner && !opts.reactCompiler && !usesMemoDirective(fn)) {
          report(
            'unmemoized-gesture',
            call.node,
            `Gesture.${prop}`,
            `Gesture.${prop}() is built again on every render of ${owner}: each new gesture makes Gesture Handler update the native handler and send its callbacks to the UI thread again`,
            `Build it once: useMemo(() => Gesture.${prop}()…, [what it reads]), or turn on React Compiler.`,
          )
        }
      }
      // Math.floor(e.nativeEvent.contentOffset.x / width) when momentum ends
      if ((prop === 'floor' || prop === 'trunc') && object === 'Math' && !call.scope.getBinding('Math')) {
        const arg = (call.get('arguments') as NodePath[])[0]
        if (arg && mentions(arg, new Set(['contentOffset'])) && endsMomentum(call)) {
          report(
            'floor-scroll-offset',
            call.node,
            `Math.${prop}`,
            `Math.${prop} of the scroll offset when momentum ends: a paging list often stops a fraction short of a page (374.99 for 375), so the index comes out one too low`,
            `Use Math.round(${src(arg.node, 50) ?? 'offset / pageWidth'}).`,
          )
        }
      }
    },
    MemberExpression(member) {
      const { node } = member
      if (node.computed || keyName(node.property) !== 'value' || node.object.type !== 'Identifier') return
      // A write is not a read (`x.value = …`, `x.value++`).
      if ((member.parentPath.isAssignmentExpression() && member.parentPath.node.left === node) || member.parentPath.isUpdateExpression()) return
      renderRead(member, node.object.name, `${node.object.name}.value`)
    },
    Identifier(id) {
      if (id.node.name === 'useWindowDimensions' && importOf(id, 'useWindowDimensions')?.source === 'react-native') readsWindow = true
    },
    JSXAttribute(attr) {
      const name = attr.node.name
      if (name.type !== 'JSXIdentifier' || name.name !== 'CellRendererComponent' || attr.node.value?.type !== 'JSXExpressionContainer') return
      const value = attr.get('value').get('expression') as NodePath
      if (isFunctionPath(value)) {
        report(
          'inline-cell-renderer',
          value.node,
          'CellRendererComponent',
          'CellRendererComponent is a function written inline: a new component type on every render, so every cell unmounts and mounts again whenever the list re-renders (state lost, entering animations played again)',
          'Declare the cell renderer once, outside the component, and pass it by name.',
        )
        return
      }
      if (!value.isIdentifier()) return
      const b = value.scope.getBinding(value.node.name)
      let fn: NodePath | null = null
      if (b?.path.isFunctionDeclaration()) fn = b.path
      else if (b?.constant && b.path.isVariableDeclarator()) {
        let init = b.path.get('init') as NodePath
        // memo(function Cell(…) {…}), forwardRef((props, ref) => …)
        if (init.isCallExpression() && ['memo', 'forwardRef'].includes(calleeName(init.node) ?? '')) init = (init.get('arguments') as NodePath[])[0] ?? init
        if (isFunctionPath(init)) fn = init
      }
      if (!b || !isFunctionPath(fn)) return
      // Declared in a component's body: a new component type on every render, like an inline one.
      const owner = rendersIn(b.path.getFunctionParent())
      if (owner) {
        report(
          'inline-cell-renderer',
          value.node,
          'CellRendererComponent',
          `${value.node.name}, the list's CellRendererComponent, is declared inside ${owner}: a new component type on every render, so every cell unmounts and mounts again whenever ${owner} re-renders (state lost, entering animations played again)`,
          `Move ${value.node.name} out of ${owner}, to the top of the file.`,
        )
        return
      }
      if (!dropsOnLayout(fn)) return
      report(
        'inline-cell-renderer',
        value.node,
        'CellRendererComponent',
        `${value.node.name}, the list's CellRendererComponent, does not pass onLayout on: the list measures each cell through it, so without it scrolling to an index, sticky headers and which cells get rendered all go wrong`,
        'Spread the props it gets onto the view it renders (<Animated.View {...props} />), or pass onLayout={props.onLayout} along with style.',
      )
    },
  })
  if (!readsWindow) {
    for (const call of screenCalls) {
      report(
        'screen-dimensions',
        call,
        "Dimensions.get('screen')",
        "Dimensions.get('screen') is the whole display: on Android it includes the status and navigation bars, and it ignores split screen and resizable windows, so what is sized or placed from it overflows the app's window",
        "Use useWindowDimensions() from react-native (it follows rotation and resizing), or Dimensions.get('window').",
      )
    }
  }

  /** A read of a shared value made in the same component or hook, in its body: while it renders. */
  function renderRead(path: NodePath, name: string, what: string) {
    const b = path.scope.getBinding(name)
    if (!b || !sharedValues.has(b)) return
    const fn = path.getFunctionParent()
    const home = b.path.getFunctionParent()
    if (!fn || !home || fn.node !== home.node) return
    const owner = rendersIn(fn)
    if (!owner) return
    let where = 'while it renders'
    let fix = 'Read it in a worklet: useAnimatedStyle or useAnimatedProps for what a view shows, useDerivedValue for another value, or useAnimatedReaction with scheduleOnRN when React state must follow it.'
    for (let p: NodePath | null = path.parentPath; p && p.node !== fn.node; p = p.parentPath) {
      if (p.isJSXExpressionContainer() || p.isJSXAttribute()) {
        where = 'in its JSX'
        break
      }
      if (p.isArrayExpression() && p.parentPath?.isCallExpression() && p.parentPath.node.arguments[1] === p.node && /^use[A-Z]/.test(calleeName(p.parentPath.node) ?? '')) {
        where = 'in a dependency array'
        fix = `Depend on ${name} itself and read ${what} inside the effect, or react to it with useAnimatedReaction.`
        break
      }
    }
    report(
      'value-in-render',
      path.node,
      what,
      `${owner} reads ${what} ${where}: a shared value changing does not re-render the component, so what it renders from it goes stale (and Reanimated asks not to read .value during render)`,
      fix,
    )
  }

  /** Whether a call runs when a scroll's momentum ends: in an onMomentumScrollEnd handler (inline or by name), or a scroll handler's onMomentumEnd. */
  function endsMomentum(call: NodePath): boolean {
    for (let fn = call.getFunctionParent(); fn; fn = fn.parentPath?.getFunctionParent() ?? null) {
      const w = worklets.get(fn.node)
      if (w?.kind === 'useAnimatedScrollHandler' && w.key === 'onMomentumEnd') return true
      const parent = fn.parentPath
      if (parent?.isJSXExpressionContainer() && isMomentumProp(parent.parentPath)) return true
      // A handler declared here and handed to onMomentumScrollEnd by name.
      const id = fn.isFunctionDeclaration() ? fn.node.id : parent?.isVariableDeclarator() && parent.node.id.type === 'Identifier' ? parent.node.id : null
      const b = id ? (parent ?? fn).scope.getBinding(id.name) : null
      if (b?.referencePaths.some((r) => r.parentPath?.isJSXExpressionContainer() && isMomentumProp(r.parentPath.parentPath))) return true
    }
    return false
  }

  issues.sort((a, b) => a.line - b.line || a.column - b.column)
  return issues
}

/** One finding as Metro prints it: where, the rule, what, and the fix. */
export function formatMotionIssue(i: MotionIssue): string {
  return `[Keyframer Inspector] ${i.file}:${i.line}:${i.column} ${i.severity} ${i.rule}: ${i.message}.\n  Fix: ${i.fix}`
}
