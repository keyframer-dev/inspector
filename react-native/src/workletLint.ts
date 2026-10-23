/**
 * Worklet mistakes that crash a React Native app on the UI thread, found in its code before it runs
 * (see InspectorWorkletIssue): a worklet that uses something declared further down (`declared-after`),
 * and a worklet that calls a function that is not one (`js-call`).
 *
 * What is a worklet follows react-native-worklets' Babel plugin (0.10), so nothing it workletizes is
 * flagged: functions with the 'worklet' directive; the callbacks of Reanimated's hooks, animations and
 * runners (useAnimatedStyle, withTiming's third argument, scheduleOnUI…), matched by name as the plugin
 * matches them; gesture builder callbacks (`Gesture.Pan().onUpdate`) and gesture hooks' objects; and a
 * function passed to those by name, followed to where it is declared (a function declaration, or a
 * constant set to one). A function passed through useCallback is not workletized. Worklet classes and
 * layout animation callbacks are left alone.
 *
 * Only what is certain is reported. A call is flagged when the function is in this file and provably
 * not a worklet, a React state setter (useState, useReducer) or Redux's dispatch, a navigation object,
 * a callback prop of a component (`on…`), a method of the component a React ref holds
 * (`listRef.current?.scrollToOffset(…)`, when the ref is given to an element here), or a JS-only API
 * (fetch, Alert, Linking, expo-haptics…). Optional calls (`onDone?.()`) count like plain ones.
 * Imports the analysis cannot see into are not flagged: they become suspects, which the runtime uses
 * to place a crash it did not see coming (workletCrash.ts). Gestures with `.runOnJS(true)` run their
 * callbacks on the JS thread, so their calls are fine. Bundle Mode, where worklets can call any
 * function, is not detected.
 *
 * A finding is silenced by a comment naming its rule on the line above it
 * (`// keyframer-disable-next-line js-call`) or at the end of its line (`// keyframer-disable-line`);
 * without a rule, every rule on that line. The same comments work for motionLint.ts.
 *
 * Pure: a Babel program path in (the Babel plugin's, or the CLI's own parse), findings out.
 */

import type { NodePath, types as T } from '@babel/core'
import type { InspectorWorkletIssue } from '../../protocol/inspector'
import { workletLabel } from './workletCrash'

/** A function the app calls in a worklet that the analysis could not see into: where, for the runtime to name in a crash. */
export type WorkletSuspect = {
  /** As written: `save`, `store.add`, `api.track`. */
  name: string
  /** The last part of the name, which is what an error says (`add`). */
  key: string
  line: number
  column: number
  worklet: NonNullable<InspectorWorkletIssue['worklet']>
}

export type WorkletLint = { issues: InspectorWorkletIssue[]; suspects: WorkletSuspect[] }

/** Where a worklet runs: the UI thread, another worklet runtime, the JS thread (a gesture with runOnJS), or not known ('worklet' alone). */
export type Thread = 'ui' | 'runtime' | 'js' | 'unknown'

export type Worklet = {
  fn: NodePath<T.Function>
  /** What makes it one: "useAnimatedStyle", "Pan.onUpdate", "scheduleOnUI", "'worklet'". */
  kind: string
  /** `file:line` of the call that makes it one (what UI work is timed under), or of the function. */
  site: string
  line: number
  name: string | null
  /** The key it was given under in an object of callbacks (`useAnimatedScrollHandler({ onScroll })` → "onScroll"); null when handed over directly. */
  key: string | null
  /** The call that makes it one (`useAnimatedStyle(…)`, `Gesture.Pan().onUpdate(…)`); null for the directive alone. */
  call: NodePath<T.CallExpression> | null
  thread: Thread
  /** For a worklet that runs on the UI thread because another one calls it: that one. */
  via: Worklet | null
}

// The plugin's tables (react-native-worklets/plugin, lib/autoworkletization.js).
const UI_ARGS = new Map<string, number[]>(Object.entries({
  useFrameCallback: [0],
  useAnimatedStyle: [0],
  useAnimatedProps: [0],
  createAnimatedPropAdapter: [0],
  useDerivedValue: [0],
  useAnimatedScrollHandler: [0],
  useAnimatedReaction: [0, 1],
  withTiming: [2],
  withSpring: [2],
  withDecay: [1],
  withRepeat: [3],
  runOnUI: [0],
  executeOnUIRuntimeSync: [0],
  scheduleOnUI: [0],
  runOnUISync: [0],
  runOnUIAsync: [0],
}))
const RUNTIME_ARGS = new Map<string, number[]>(Object.entries({
  runOnRuntime: [1],
  runOnRuntimeSync: [1],
  runOnRuntimeAsync: [1],
  scheduleOnRuntime: [1],
  runOnRuntimeSyncWithId: [1],
  scheduleOnRuntimeWithId: [1],
}))
export const GESTURE_HOOKS = new Set(['useTapGesture', 'usePanGesture', 'usePinchGesture', 'useRotationGesture', 'useFlingGesture', 'useLongPressGesture', 'useNativeGesture', 'useManualGesture', 'useHoverGesture'])
const OBJECT_HOOKS = new Set(['useAnimatedScrollHandler', ...GESTURE_HOOKS])
const GESTURE_OBJECTS = new Set(['Tap', 'Pan', 'Pinch', 'Rotation', 'Fling', 'LongPress', 'ForceTouch', 'Native', 'Manual', 'Race', 'Simultaneous', 'Exclusive', 'Hover'])
const GESTURE_METHODS = new Set(['onBegin', 'onStart', 'onEnd', 'onFinalize', 'onUpdate', 'onChange', 'onTouchesDown', 'onTouchesMove', 'onTouchesUp', 'onTouchesCancelled'])
/** Calls that hand a function to the JS thread: their function arguments do not run in the worklet. */
export const TO_JS = new Set(['scheduleOnRN', 'runOnJS'])
/** Methods of the components React refs hold that move a list: Reanimated's scrollTo does it on the UI thread. */
const SCROLL_METHODS = new Set(['scrollTo', 'scrollToOffset', 'scrollToEnd'])

/** Imports whose functions only work on the JS thread, by module: the names (or `*` for all of them). */
const JS_ONLY_IMPORTS = new Map<string, Set<string> | '*'>(Object.entries({
  'react-native': new Set(['Alert', 'Linking', 'Vibration', 'Keyboard', 'Share', 'ToastAndroid', 'Clipboard', 'AccessibilityInfo', 'PermissionsAndroid', 'LayoutAnimation', 'InteractionManager']),
  'expo-haptics': '*',
  'expo-linking': '*',
  '@react-native-async-storage/async-storage': '*',
} as Record<string, Set<string> | '*'>))
const JS_ONLY_GLOBALS = new Set(['fetch', 'alert'])
/** Libraries whose functions are worklets (or safe to call in one): never suspects. */
const WORKLET_MODULES = new Set(['react-native-reanimated', 'react-native-worklets', 'react-native-gesture-handler', '@shopify/react-native-skia'])
const NAVIGATION_HOOKS = new Set(['useNavigation', 'useRouter'])
const isNavigationModule = (m: string) => m === 'expo-router' || m.startsWith('@react-navigation/')

/** Globals a worklet runtime has: a reference to anything else is a suspect (a crash may name it). */
const UI_GLOBALS = new Set(
  (
    'Math console Date JSON Object Array Number String Boolean Symbol Map Set WeakMap WeakSet Promise Error TypeError RangeError ReferenceError SyntaxError ' +
    'parseInt parseFloat isNaN isFinite Infinity NaN undefined globalThis global performance setTimeout clearTimeout setInterval clearInterval ' +
    'requestAnimationFrame cancelAnimationFrame queueMicrotask _WORKLET __DEV__ Reflect Proxy BigInt ArrayBuffer DataView Int8Array Uint8Array ' +
    'Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array Float32Array Float64Array encodeURIComponent decodeURIComponent encodeURI decodeURI Intl arguments require'
  ).split(' '),
)

export const isFunctionPath = (p: NodePath | null | undefined): p is NodePath<T.Function> =>
  !!p && (p.isFunctionDeclaration() || p.isFunctionExpression() || p.isArrowFunctionExpression() || p.isObjectMethod())

export function hasWorkletDirective(fn: T.Node): boolean {
  const body = (fn as T.Function).body
  return !!body && body.type === 'BlockStatement' && body.directives.some((d) => d.value.value === 'worklet')
}

export function keyName(key: T.Node): string | null {
  if (key.type === 'Identifier') return key.name
  if (key.type === 'StringLiteral') return key.value
  return null
}

/** The name the plugin matches a call by: `useAnimatedStyle(…)`, `Reanimated.useAnimatedStyle(…)`, `x.withTiming(…)`. */
export function calleeName(call: T.CallExpression | T.OptionalCallExpression): string | null {
  const callee = call.callee.type === 'SequenceExpression' ? call.callee.expressions[call.callee.expressions.length - 1]! : call.callee
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') return callee.property.name
  return null
}

/** `Gesture.Pan()` somewhere down a builder chain → "Pan" (by name, as the plugin matches it). */
function gestureOf(expr: T.Node): string | null {
  let e: T.Node = expr
  for (let i = 0; i < 60 && e.type === 'CallExpression' && e.callee.type === 'MemberExpression'; i++) {
    const { object, property } = e.callee
    if (object.type === 'Identifier' && object.name === 'Gesture' && property.type === 'Identifier' && GESTURE_OBJECTS.has(property.name)) return property.name
    e = object
  }
  return null
}

/** Whether a builder chain, read whole (before and after the callback), has `.runOnJS(true)`: its callbacks run on the JS thread. */
function chainRunsOnJs(call: NodePath<T.CallExpression>): boolean {
  let top: NodePath = call
  while (top.parentPath?.isMemberExpression() && top.parentPath.node.object === top.node && top.parentPath.parentPath?.isCallExpression() && top.parentPath.parentPath.node.callee === top.parentPath.node) {
    top = top.parentPath.parentPath
  }
  let e: T.Node = top.node
  for (let i = 0; i < 60 && e.type === 'CallExpression' && e.callee.type === 'MemberExpression'; i++) {
    if (keyName(e.callee.property) === 'runOnJS') {
      const arg = e.arguments[0]
      if (!(arg?.type === 'BooleanLiteral' && !arg.value)) return true
    }
    e = e.callee.object
  }
  return false
}

/** Where a binding imported from a module came from: the module, and the name it exports. */
export function importOf(path: NodePath, name: string): { source: string; imported: string } | null {
  const b = path.scope.getBinding(name)
  if (!b || b.kind !== 'module') return null
  const decl = b.path.parentPath
  if (!decl?.isImportDeclaration()) return null
  const spec = b.path.node
  const imported =
    spec.type === 'ImportSpecifier' ? (spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value) : spec.type === 'ImportDefaultSpecifier' ? 'default' : '*'
  return { source: decl.node.source.value, imported }
}

/** `useState(…)` / `React.useState(…)` from react: the hook's name. */
export function reactHook(call: T.Node | null | undefined, path: NodePath): string | null {
  if (!call || call.type !== 'CallExpression') return null
  const c = call.callee
  if (c.type === 'Identifier') {
    const from = importOf(path, c.name)
    return from?.source === 'react' ? from.imported : null
  }
  if (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && c.property.type === 'Identifier') {
    const from = importOf(path, c.object.name)
    return from?.source === 'react' ? c.property.name : null
  }
  return null
}

/** The name a function is known by: its own, or the variable it is assigned to (through memo / forwardRef). */
export function functionName(fn: NodePath): string | null {
  const node = fn.node as T.Function
  if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && node.id) return node.id.name
  let p: NodePath | null = fn.parentPath
  if (p?.isCallExpression()) p = p.parentPath
  if (p?.isVariableDeclarator() && p.node.id.type === 'Identifier') return p.node.id.name
  if (fn.parentPath?.isObjectProperty() || fn.isObjectMethod()) return keyName((fn.isObjectMethod() ? fn.node : (fn.parentPath!.node as T.ObjectProperty)).key as T.Node)
  return null
}

export const isComponentName = (n: string | null) => !!n && /^[A-Z]/.test(n)

/** A function handed by name to a call that workletizes it (`scheduleOnUI(update)`). */
export type PassedWorklet = { id: NodePath<T.Identifier>; call: NodePath<T.CallExpression>; kind: string }

const lineOf = (n: T.Node) => n.loc?.start.line ?? 0

/**
 * Which functions in a file are worklets, what makes each one (a hook, a gesture callback, an
 * animation's callback, the directive) and where it runs; with the functions handed over by name.
 * motionLint.ts reads the same map for what runs on every frame.
 */
export function findWorklets(program: NodePath<T.Program>, file: string): { worklets: Map<T.Node, Worklet>; passed: PassedWorklet[] } {
  const worklets = new Map<T.Node, Worklet>()
  /** Functions passed by name to a call that workletizes them (`scheduleOnUI(update)`), checked for order. */
  const passed: PassedWorklet[] = []

  const add = (fn: NodePath<T.Function>, w: Omit<Worklet, 'fn' | 'via'>) => {
    const had = worklets.get(fn.node)
    // A 'worklet' function also handed to a hook: the hook says more about it.
    if (had && had.kind !== "'worklet'") {
      if (had.thread === 'unknown' || (had.thread === 'js' && w.thread !== 'unknown')) had.thread = w.thread
      return
    }
    worklets.set(fn.node, { fn, via: null, ...w, ...(had && w.kind === "'worklet'" ? { kind: had.kind, site: had.site, key: had.key, call: had.call } : {}) })
  }

  /**
   * What the plugin workletizes for an argument (findWorklet): an inline function or object, or one a
   * name refers to (a function declaration, a constant set to one, the last function assigned to a
   * variable). Also, for what runs where, a useCallback whose function says 'worklet'.
   */
  const resolve = (arg: NodePath, acceptFn: boolean, acceptObj: boolean, depth = 0): NodePath<T.Function> | NodePath<T.ObjectExpression> | null => {
    if (acceptFn && isFunctionPath(arg)) return arg
    if (acceptObj && arg.isObjectExpression()) return arg
    if (!arg.isIdentifier() || depth > 8) return null
    const b = arg.scope.getBinding(arg.node.name)
    if (!b) return null
    if (acceptFn && b.path.isFunctionDeclaration()) return b.path
    if (b.constant) {
      if (!b.path.isVariableDeclarator()) return null
      const init = b.path.get('init') as NodePath
      if (!init.node) return null
      if (acceptFn && isFunctionPath(init)) return init
      if (acceptObj && init.isObjectExpression()) return init
      if (init.isIdentifier()) return resolve(init, acceptFn, acceptObj, depth + 1)
      if (acceptFn && init.isCallExpression() && reactHook(init.node, init) === 'useCallback') {
        const inner = init.get('arguments')[0]
        if (isFunctionPath(inner) && hasWorkletDirective(inner.node)) return inner
      }
      return null
    }
    const assigned = [...b.constantViolations].reverse().find((v) => {
      if (!v.isAssignmentExpression()) return false
      const right = v.get('right')
      return (acceptFn && isFunctionPath(right)) || (acceptObj && right.isObjectExpression())
    })
    return assigned ? (assigned.get('right') as NodePath<T.Function> | NodePath<T.ObjectExpression>) : null
  }

  const take = (arg: NodePath, call: NodePath<T.CallExpression>, kind: string, thread: Thread, acceptObj: boolean, name: string | null) => {
    if (arg.isIdentifier()) passed.push({ id: arg, call, kind })
    const site = `${file}:${lineOf(call.node)}`
    const found = resolve(arg, true, acceptObj)
    if (!found) return
    if (isFunctionPath(found)) {
      add(found, { kind, site, line: lineOf(call.node), name: name ?? (found === arg ? null : functionName(found)), key: null, call, thread })
      return
    }
    // An object of callbacks (useAnimatedScrollHandler({ onScroll }), usePanGesture({ onUpdate })).
    const obj = found as NodePath<T.ObjectExpression>
    const objThread = obj.node.properties.some((p) => p.type === 'ObjectProperty' && keyName(p.key) === 'runOnJS' && p.value.type === 'BooleanLiteral' && p.value.value) ? 'js' : thread
    for (const prop of obj.get('properties')) {
      if (prop.isObjectMethod()) add(prop, { kind, site, line: lineOf(call.node), name: keyName(prop.node.key), key: keyName(prop.node.key), call, thread: objThread })
      else if (prop.isObjectProperty()) {
        const value = prop.get('value') as NodePath
        if (value.isIdentifier()) passed.push({ id: value, call, kind })
        const fn = resolve(value, true, false)
        if (fn && isFunctionPath(fn)) add(fn, { kind, site, line: lineOf(call.node), name: keyName(prop.node.key), key: keyName(prop.node.key), call, thread: objThread })
      }
    }
  }

  // ── Which functions are worklets, and where they run ────────────────────────────
  program.traverse({
    CallExpression(call) {
      const name = calleeName(call.node)
      if (!name) return
      const declarator = call.parentPath.isVariableDeclarator() && call.parentPath.node.id.type === 'Identifier' ? call.parentPath.node.id.name : null
      const args = call.get('arguments') as NodePath[]
      // Maps, not objects: an app's `toString()` is not a hook.
      const ui = UI_ARGS.get(name)
      const rt = RUNTIME_ARGS.get(name)
      if (ui || rt) {
        for (const i of ui ?? rt!) if (args[i]) take(args[i]!, call, name, ui ? 'ui' : 'runtime', OBJECT_HOOKS.has(name), declarator)
        return
      }
      if (GESTURE_HOOKS.has(name)) {
        if (args[0]) take(args[0], call, name, 'ui', true, declarator)
        return
      }
      const callee = call.node.callee
      if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier' && GESTURE_METHODS.has(callee.property.name)) {
        const gesture = gestureOf(callee.object)
        if (!gesture) return
        const thread: Thread = chainRunsOnJs(call) ? 'js' : 'ui'
        for (const arg of args) take(arg, call, `${gesture}.${callee.property.name}`, thread, true, null)
      }
    },
    Function(fn) {
      // As the plugin reads the directive: not on class methods (those belong to worklet classes).
      if (isFunctionPath(fn) && hasWorkletDirective(fn.node)) add(fn, { kind: "'worklet'", site: `${file}:${lineOf(fn.node)}`, line: lineOf(fn.node), name: functionName(fn), key: null, call: null, thread: 'unknown' })
    },
  })
  return { worklets, passed }
}

export function analyzeWorklets(program: NodePath<T.Program>, opts: { file: string; code?: string }): WorkletLint {
  const file = opts.file
  const code = opts.code ?? ''
  const { worklets, passed } = findWorklets(program, file)
  const suppressed = lineSuppressions(program)

  const issues: InspectorWorkletIssue[] = []
  const suspects: WorkletSuspect[] = []
  const seen = new Set<string>()
  /** Names each worklet already uses before they are declared: that crash comes first, so no second finding for the call. */
  const lateNames = new Map<T.Node, Set<string>>()
  const report = (i: Omit<InspectorWorkletIssue, 'id' | 'file'>) => {
    const id = `${i.issue}:${file}:${i.line}:${i.column}:${i.name}`
    if (seen.has(id) || suppressed(i.issue, i.line)) return
    seen.add(id)
    issues.push({ id, file, ...i })
  }
  const info = (w: Worklet): NonNullable<InspectorWorkletIssue['worklet']> => ({ site: w.site, kind: w.kind, name: w.name })
  const at = (n: T.Node) => ({ line: lineOf(n), column: (n.loc?.start.column ?? 0) + 1 })
  /** A call's arguments as written, for the fix (`e.translationX`), or `...args` when long. */
  const argsText = (call: T.CallExpression | T.OptionalCallExpression) => {
    const parts = call.arguments.map((a) => (a.start != null && a.end != null && code ? code.slice(a.start, a.end) : '…'))
    const text = parts.join(', ')
    return text.length > 60 || text.includes('\n') ? '...args' : text
  }

  // ── Declared after: what a worklet captures before it exists ────────────────────
  const frameOf = (p: NodePath) => (p.getFunctionParent() ?? program).node
  /** A binding a worklet would capture uninitialized: block-scoped (or a worklet function, which the plugin makes a constant) declared further down the same function. */
  const uninitializedAt = (ref: NodePath<T.Identifier>, from: NodePath, pos: number, callee: boolean) => {
    const b = ref.scope.getBinding(ref.node.name)
    if (!b) return null
    const decl = b.path
    if (b.kind === 'hoisted') {
      if (!decl.isFunctionDeclaration() || !worklets.has(decl.node)) return null
    } else if (b.kind === 'var') {
      if (!callee) return null
    } else if (b.kind !== 'const' && b.kind !== 'let') return null
    if (frameOf(decl) !== frameOf(from)) return null
    const end = decl.node.end ?? 0
    if (pos >= end) return null
    return { line: lineOf(b.identifier), worklet: decl.isFunctionDeclaration() }
  }

  for (const w of worklets.values()) {
    const pos = w.fn.node.start ?? 0
    const named = new Set<string>()
    w.fn.traverse({
      Identifier(ref) {
        if (!ref.isReferencedIdentifier() || named.has(ref.node.name) || isTypeOnly(ref, w.fn)) return
        const b = ref.scope.getBinding(ref.node.name)
        // Its own (declared inside it), or a function declaration naming itself.
        if (!b || b.path === w.fn || b.path.isDescendant(w.fn)) return
        const callee = (ref.parentPath.isCallExpression() || ref.parentPath.isOptionalCallExpression()) && ref.parentPath.node.callee === ref.node
        const late = uninitializedAt(ref, w.fn, pos, callee)
        if (!late) return
        named.add(ref.node.name)
        lateNames.set(w.fn.node, named)
        report({
          issue: 'declared-after',
          ...at(ref.node),
          name: ref.node.name,
          worklet: info(w),
          message: `${who(w)} uses ${ref.node.name} before it is declared (line ${late.line})`,
          fix:
            `Declare ${ref.node.name} above ${anchor(w)} (line ${lineOf(w.fn.node)}): a worklet captures what it uses when it is created, and ${ref.node.name} does not exist yet, so the worklet gets undefined${callee ? ' and throws when it calls it' : ' instead of its value'}.` +
            (late.worklet ? ` A function declaration that is a worklet is not hoisted: the worklets plugin turns it into a constant.` : ''),
        })
      },
    })
  }
  for (const { id, call, kind } of passed) {
    const late = uninitializedAt(id, call, call.node.start ?? 0, true)
    if (!late) continue
    const callText = `${kind.includes('.') ? kind : calleeName(call.node)}(${id.node.name})`
    report({
      issue: 'declared-after',
      ...at(id.node),
      name: id.node.name,
      worklet: { site: `${file}:${lineOf(call.node)}`, kind, name: id.node.name },
      message: `${callText} runs before ${id.node.name} is declared (line ${late.line})`,
      fix:
        `Declare ${id.node.name} above the ${kind} call (line ${lineOf(call.node)}): it does not exist yet when ${callText} runs, so the worklet is undefined (or the JS thread throws "Cannot access before initialization").` +
        (late.worklet ? ` A function declaration handed to ${kind} becomes a worklet, and a worklet is not hoisted: the worklets plugin turns it into a constant.` : ''),
    })
  }

  // ── JS calls: what runs on the UI thread, and the functions it calls there ───────
  const queue = [...worklets.values()].filter((w) => w.thread === 'ui' || w.thread === 'runtime')
  const running = new Set<T.Node>(queue.map((w) => w.fn.node))
  while (queue.length) {
    const w = queue.shift()!
    // A call (or an optional call, `onDone?.()`) the worklet makes where it runs.
    const onCall = (call: NodePath<T.CallExpression | T.OptionalCallExpression>) => {
      const verdict = classify(call, w)
      if (!verdict) return
      if (verdict.type === 'worklet') {
        const next = worklets.get(verdict.fn.node)
        if (next && !running.has(next.fn.node)) {
          running.add(next.fn.node)
          next.thread = w.thread
          next.via = w.via ?? w
          queue.push(next)
        }
        return
      }
      if (lateNames.get(w.fn.node)?.has(verdict.name)) return
      if (verdict.type === 'suspect') {
        suspects.push({ name: verdict.name, key: verdict.name.split('.').pop()!, ...at(call.node.callee), worklet: info(w) })
        return
      }
      const where = w.thread === 'runtime' ? 'its worklet runtime' : 'the UI thread'
      const args = argsText(call.node)
      const direct = `scheduleOnRN(${[verdict.name, ...(args ? [args] : [])].join(', ')})`
      const v3 = `runOnJS(${verdict.name})(${args})`
      const method = `${verdict.name.split('.').pop()!}OnJS`
      const viaJs = verdict.wrap
        ? `Call it on the JS thread through a function declared outside the worklet: const ${method} = (...args) => ${verdict.name}(...args), then scheduleOnRN(${[method, ...(args ? [args] : [])].join(', ')}) (runOnJS(${method})(${args}) in Reanimated 3).`
        : `Call it on the JS thread: ${direct} (${v3} in Reanimated 3).`
      report({
        issue: 'js-call',
        ...at(call.node.callee),
        name: verdict.name,
        worklet: info(w),
        message: `${who(w)} calls ${verdict.name}, ${verdict.what}, on ${where}`,
        fix:
          (verdict.line !== null
            ? `Make ${verdict.name} a worklet ('worklet' as the first line of its body, line ${verdict.line}) if it only computes or sets shared values; if it needs React state or JS APIs, call it with ${direct} instead (${v3} in Reanimated 3).`
            : viaJs) + (verdict.hint ? ` ${verdict.hint}` : ''),
      })
    }
    w.fn.traverse({
      Function(inner) {
        if (!runsInside(inner, w.fn)) inner.skip()
      },
      Identifier(ref) {
        if (!ref.isReferencedIdentifier() || isTypeOnly(ref, w.fn)) return
        // A global the worklet runtime does not have: "Property 'x' doesn't exist" names it.
        if (!ref.scope.getBinding(ref.node.name) && !UI_GLOBALS.has(ref.node.name) && !JS_ONLY_GLOBALS.has(ref.node.name)) {
          suspects.push({ name: ref.node.name, key: ref.node.name, ...at(ref.node), worklet: info(w) })
        }
      },
      CallExpression: onCall,
      OptionalCallExpression: onCall,
    })
  }
  issues.sort((a, b) => a.line - b.line || a.column - b.column)
  return { issues, suspects }

  type Verdict =
    | { type: 'worklet'; fn: NodePath<T.Function> }
    | { type: 'suspect'; name: string }
    | { type: 'js'; name: string; what: string; wrap: boolean; line: number | null; hint?: string }

  /** What a call in a worklet that runs on the UI thread calls. Null: nothing to say (a builtin, a shared value's method, its own code). */
  function classify(call: NodePath<T.CallExpression | T.OptionalCallExpression>, w: Worklet): Verdict | null {
    const callee = call.node.callee
    if (callee.type === 'Identifier') {
      const name = callee.name
      const b = call.scope.getBinding(name)
      if (!b) return JS_ONLY_GLOBALS.has(name) ? { type: 'js', name, what: 'a JS-only API', wrap: false, line: null } : null
      if (b.path === w.fn || b.path.isDescendant(w.fn)) return null
      if (b.kind === 'module') {
        const from = importOf(call, name)
        if (from && jsOnly(from.source, from.imported)) return { type: 'js', name, what: `a JS-only API from ${from.source}`, wrap: false, line: null }
        return from && WORKLET_MODULES.has(from.source) ? null : { type: 'suspect', name }
      }
      const decl = b.path
      // A function in this file.
      const fn = decl.isFunctionDeclaration() ? decl : decl.isVariableDeclarator() && b.constant && isFunctionPath(decl.get('init') as NodePath) ? (decl.get('init') as NodePath<T.Function>) : null
      if (fn) {
        if (worklets.has(fn.node)) return { type: 'worklet', fn }
        return { type: 'js', name, what: `a function without 'worklet' (line ${lineOf(fn.node)})`, wrap: false, line: lineOf(fn.node) }
      }
      if (decl.isVariableDeclarator()) {
        const init = decl.node.init
        const hook = reactHook(init, decl)
        if (hook === 'useCallback' && b.constant) {
          const inner = decl.get('init').get('arguments') as NodePath[]
          const first = inner[0]
          if (first && isFunctionPath(first)) {
            if (hasWorkletDirective(first.node)) return worklets.has(first.node) ? { type: 'worklet', fn: first } : null
            return { type: 'js', name, what: `a useCallback function without 'worklet' (line ${lineOf(first.node)})`, wrap: false, line: lineOf(first.node) }
          }
        }
        // const [open, setOpen] = useState(…); const [state, dispatch] = useReducer(…)
        if ((hook === 'useState' || hook === 'useReducer') && decl.node.id.type === 'ArrayPattern' && decl.node.id.elements[1]?.type === 'Identifier' && decl.node.id.elements[1].name === name) {
          return { type: 'js', name, what: hook === 'useState' ? 'a React state setter' : "useReducer's dispatch", wrap: false, line: null }
        }
        if (init?.type === 'CallExpression' && init.callee.type === 'Identifier') {
          const from = importOf(decl, init.callee.name)
          if (from?.source === 'react-redux' && from.imported === 'useDispatch') return { type: 'js', name, what: "Redux's dispatch", wrap: false, line: null }
          // const { navigate } = useNavigation()
          if (from && isNavigationModule(from.source) && NAVIGATION_HOOKS.has(from.imported) && decl.node.id.type === 'ObjectPattern') return { type: 'js', name, what: 'a navigation method', wrap: false, line: null }
        }
        return null
      }
      if (b.kind === 'param') {
        const prop = propOf(b)
        if (prop && /^on[A-Z]/.test(prop)) return { type: 'js', name, what: 'a callback prop', wrap: false, line: null }
        return null
      }
      return null
    }
    if (!isMember(callee) || callee.computed || callee.property.type !== 'Identifier') return null
    // obj.method(…), obj?.method(…): what the object is.
    const text = memberText(callee)
    if (!text) return null
    let root: T.Node = callee.object
    while (isMember(root) || root.type === 'TSNonNullExpression') root = isMember(root) ? root.object : root.expression
    if (root.type !== 'Identifier') return null
    const b = call.scope.getBinding(root.name)
    if (!b || b.path === w.fn || b.path.isDescendant(w.fn)) return null
    if (b.kind === 'module') {
      const from = importOf(call, root.name)
      if (!from) return null
      if (callee.object.type === 'Identifier' && jsOnly(from.source, from.imported)) return { type: 'js', name: text, what: `a JS-only API from ${from.source}`, wrap: true, line: null }
      if (callee.object.type === 'Identifier' && from.source === 'expo-router' && from.imported === 'router') return { type: 'js', name: text, what: 'a navigation method', wrap: true, line: null }
      return WORKLET_MODULES.has(from.source) ? null : { type: 'suspect', name: text }
    }
    // listRef.current?.scrollToOffset(…): the component a React ref holds, given to an element here.
    const held = callee.object.type === 'TSNonNullExpression' ? callee.object.expression : callee.object
    if (isMember(held) && !held.computed && keyName(held.property) === 'current' && held.object.type === 'Identifier' && isElementRef(b)) {
      const method = callee.property.name
      return {
        type: 'js',
        name: text,
        what: 'a method of the component in a ref',
        wrap: true,
        line: null,
        ...(SCROLL_METHODS.has(method)
          ? { hint: `To scroll on the UI thread instead, give the list a ref from useAnimatedRef and call scrollTo(animatedRef, x, y, true) from react-native-reanimated in the worklet.` }
          : {}),
      }
    }
    if (callee.object.type === 'Identifier' && b.path.isVariableDeclarator()) {
      const init = b.path.node.init
      if (init?.type === 'CallExpression' && init.callee.type === 'Identifier') {
        const from = importOf(b.path, init.callee.name)
        if (from && isNavigationModule(from.source) && NAVIGATION_HOOKS.has(from.imported)) return { type: 'js', name: text, what: 'a navigation method', wrap: true, line: null }
      }
      return null
    }
    if (b.kind === 'param') {
      const prop = propOf(b)
      // { navigation }: a screen's navigation prop.
      if (prop === 'navigation' && callee.object.type === 'Identifier') return { type: 'js', name: text, what: 'a navigation method', wrap: true, line: null }
      // props.onDone(…), props.navigation.navigate(…)
      if (prop === '' && callee.object.type === 'Identifier' && /^on[A-Z]/.test(callee.property.name)) return { type: 'js', name: text, what: 'a callback prop', wrap: false, line: null }
      if (prop === '' && isMember(callee.object) && !callee.object.computed && keyName(callee.object.property) === 'navigation' && callee.object.object.type === 'Identifier') {
        return { type: 'js', name: text, what: 'a navigation method', wrap: true, line: null }
      }
    }
    return null
  }
}

/**
 * Whether a function written inside a worklet runs there: a callback handed to a call (`items.forEach(…)`),
 * but not one handed to the JS thread (`scheduleOnRN(() => …)`), and a named one only when the worklet
 * calls it. One it returns or stores is not known to run, so it is left alone.
 */
function runsInside(inner: NodePath<T.Function>, worklet: NodePath): boolean {
  const parent = inner.parentPath
  if (parent.isCallExpression() && parent.node.arguments.includes(inner.node as T.Expression)) {
    return !(parent.node.callee.type === 'Identifier' && TO_JS.has(parent.node.callee.name))
  }
  const id = inner.isFunctionDeclaration() ? inner.node.id : parent.isVariableDeclarator() && parent.node.id.type === 'Identifier' ? parent.node.id : null
  if (!id) return false
  const b = inner.scope.parent?.getBinding(id.name) ?? inner.scope.getBinding(id.name)
  return !!b && b.referencePaths.some((r) => r.isDescendant(worklet) && r.parentPath?.isCallExpression() === true && (r.parentPath.node as T.CallExpression).callee === r.node)
}

/**
 * A component's prop a parameter binding holds: its key in `function Card({ onDone })` ("onDone"), ""
 * for the props object itself (`function Card(props)`), or null when the function is not a component.
 */
function propOf(b: NonNullable<ReturnType<NodePath['scope']['getBinding']>>): string | null {
  const fn = b.scope.path
  if (!isFunctionPath(fn) || !isComponentName(functionName(fn))) return null
  const first = fn.node.params[0]
  if (!first) return null
  if (first.type === 'Identifier') return first === b.identifier ? '' : null
  if (first.type !== 'ObjectPattern') return null
  for (const p of first.properties) {
    if (p.type !== 'ObjectProperty') continue
    const value = p.value.type === 'AssignmentPattern' ? p.value.left : p.value
    if (value === b.identifier) return keyName(p.key)
  }
  return null
}

function jsOnly(source: string, imported: string): boolean {
  const names = JS_ONLY_IMPORTS.get(source)
  return names === '*' || (!!names && names.has(imported))
}

/** `navigation.navigate`, `props.navigation.goBack`: a member call as written, when it is plain names. */
export function memberText(e: T.Node): string | null {
  if (e.type === 'Identifier') return e.name
  if (e.type === 'ThisExpression') return 'this'
  if (e.type === 'TSNonNullExpression') {
    const inner = memberText(e.expression)
    return inner ? `${inner}!` : null
  }
  if (!isMember(e) || e.computed) return null
  const obj = memberText(e.object)
  const prop = keyName(e.property)
  return obj && prop ? `${obj}${e.type === 'OptionalMemberExpression' && e.optional ? '?.' : '.'}${prop}` : null
}

/** `a.b` or `a?.b`. */
export const isMember = (e: T.Node): e is T.MemberExpression | T.OptionalMemberExpression => e.type === 'MemberExpression' || e.type === 'OptionalMemberExpression'

/** A useRef / createRef from react that is given to an element here (`ref={listRef}`): what it holds is a component. */
function isElementRef(b: NonNullable<ReturnType<NodePath['scope']['getBinding']>>): boolean {
  if (!b.path.isVariableDeclarator()) return false
  const hook = reactHook(b.path.node.init, b.path)
  if (hook !== 'useRef' && hook !== 'createRef') return false
  return b.referencePaths.some((r) => {
    const attr = r.parentPath?.parentPath
    return !!r.parentPath?.isJSXExpressionContainer() && !!attr?.isJSXAttribute() && attr.node.name.type === 'JSXIdentifier' && attr.node.name.name === 'ref'
  })
}

/**
 * Lines whose findings a comment silences: `// keyframer-disable-next-line rule-a, rule-b` above the
 * line, `// keyframer-disable-line rule` at its end (in JSX, the same words in a block comment).
 * Without rules, every rule on that line; text after ` -- ` is the reason, for people.
 */
export function lineSuppressions(program: NodePath<T.Program>): (rule: string, line: number) => boolean {
  const comments = (program.parent as T.File | undefined)?.comments ?? []
  const byLine = new Map<number, Set<string> | '*'>()
  for (const c of comments) {
    const m = /^\s*keyframer-disable-(next-line|line)\b([^]*)$/.exec(c.value)
    if (!m || !c.loc) continue
    const line = m[1] === 'line' ? c.loc.start.line : c.loc.end.line + 1
    const rules = m[2]!.split(/\s--\s/)[0]!.split(/[\s,]+/).filter(Boolean)
    const had = byLine.get(line)
    if (!rules.length || had === '*') byLine.set(line, '*')
    else byLine.set(line, new Set([...(had ?? []), ...rules]))
  }
  return (rule, line) => {
    const s = byLine.get(line)
    return s === '*' || !!s?.has(rule)
  }
}

/** A name inside a TypeScript type (`x: Foo`): not a reference at runtime. */
function isTypeOnly(ref: NodePath, stop: NodePath): boolean {
  for (let p: NodePath | null = ref.parentPath; p && p !== stop; p = p.parentPath) {
    const t = p.node.type
    if (t.startsWith('TS') && t !== 'TSAsExpression' && t !== 'TSNonNullExpression' && t !== 'TSSatisfiesExpression' && t !== 'TSTypeAssertion' && t !== 'TSInstantiationExpression') return true
  }
  return false
}

/** The worklet as a sentence starts: "The useAnimatedStyle worklet (logoStyle)", "The Pan.onUpdate callback", "The worklet clamp". */
function who(w: Worklet): string {
  const self = workletLabel(w)
  if (!w.via) return self
  const via = workletLabel({ kind: w.via.kind, name: null })
  return `${self} (called from ${via[0]!.toLowerCase()}${via.slice(1)} on line ${w.via.line})`
}

/** What to declare the value above: the call that makes the worklet, or the worklet itself. */
function anchor(w: Worklet): string {
  return w.kind === "'worklet'" ? `the worklet${w.name ? ` ${w.name}` : ''}` : `the ${w.kind} call`
}

/** One finding as Metro prints it: where, what, and the fix. */
export function formatWorkletIssue(i: InspectorWorkletIssue): string {
  const where = i.file ? `${i.file}:${i.line}:${i.column}` : 'somewhere in a worklet'
  return `[Keyframer Inspector] ${where} ${i.message}. This crashes the app.\n  Fix: ${i.fix}`
}
