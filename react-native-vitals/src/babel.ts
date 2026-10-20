/**
 * `@keyframerdev/vitals/babel`: tags every Reanimated animation start with where it is written, so the
 * field reporter can say which call site drops frames. Safe for store builds: it adds a pass-through
 * call per site and nothing else (no handler, effect or worklet timing, no overrides).
 *
 *   scale.value = withSpring(1, { damping: 12 })
 *     ↓
 *   scale.value = _kfvAnim(withSpring, { ref: { kind: "source", file: "app/feed.tsx", line: 42, column: 18 },
 *                                        key: "app/feed.tsx#FeedCard#withSpring#scale#1", fn: "withSpring", … }, 1, { damping: 12 })
 *
 *   <Animated.View entering={FadeIn.duration(300)} />
 *     ↓
 *   <Animated.View entering={_kfvLayout(FadeIn.duration(300), "entering", site)} ref={_kfvMotionRef(site, null)} />
 *
 *   useAnimatedScrollHandler({ onScroll: (e) => { … } })   →   the handler calls _kfvScroll() first
 *   <ScrollView onScroll={onScroll} />                      →   onScroll={_kfvScrollJs(onScroll)}
 *
 * Site keys leave the line out (`file#Component#fn#prop#ordinal`), so a site keeps its identity across
 * versions while lines move. `hashSites: true` sends 12 hex character ids instead of file paths and writes
 * `.keyframer/sites-<version>+<build>.json` for `keyframer-vitals symbols upload`.
 *
 * Order: like the inspector's plugin, everything happens before any other plugin sees the file
 * (Program enter), so react-native-worklets' plugin, before or after this one, copies worklets that are
 * already wrapped. With the inspector's development plugin in the same build, this plugin always runs
 * after it, whatever the order in babel.config.js, and wraps its calls (`_kfvAnimVia`): both see every
 * animation.
 */

import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { NodePath, PluginObj, PluginPass, Visitor, types as BabelTypes } from '@babel/core'

export const PLUGIN_NAME = 'keyframer-vitals'
export const RUNTIME_MODULE = '@keyframerdev/vitals/runtime'
const INSPECTOR_PLUGIN = 'keyframer-inspector'
const INSPECTOR_RUNTIME = '@keyframerdev/inspector/runtime'
const REANIMATED = 'react-native-reanimated'

export const ANIMATION_FNS = new Set(['withTiming', 'withSpring', 'withDecay', 'withRepeat', 'withSequence', 'withDelay', 'withClamp'])
const LAYOUT_PROPS = ['entering', 'exiting', 'layout'] as const
/** useAnimatedScrollHandler's handler names, in its object form. */
const SCROLL_EVENTS = new Set(['onScroll', 'onBeginDrag', 'onEndDrag', 'onMomentumBegin', 'onMomentumEnd'])

export type VitalsPluginOptions = {
  /** File paths in sites are relative to this; defaults to Babel's cwd. */
  root?: string
  /** Also instrument dependencies. Off by default: an app's own motion is what gets fixed. */
  includeNodeModules?: boolean
  /** Send hashed ids instead of file paths, and write the sites manifest to upload. */
  hashSites?: boolean
  /** Mixed into every hash (the project's field key is a good choice): ids differ between projects. */
  salt?: string
  /** The app version and build the manifest is named for. Default: KEYFRAMER_APP_VERSION / KEYFRAMER_APP_BUILD, else app.json (expo.version, ios.buildNumber or android.versionCode), else package.json version. */
  appVersion?: string
  build?: string
  /** Where the manifest goes. Default `<root>/.keyframer`. */
  manifestDir?: string
}

type SiteRecord = { file: string; line: number; column: number; fn: string; component: string | null; prop: string | null; key: string }

type State = PluginPass & {
  opts: VitalsPluginOptions
  skip: boolean
  /** Waiting for the inspector's plugin (listed after this one) to finish its Program enter. */
  pending: boolean
  program: NodePath<BabelTypes.Program> | null
  done: boolean
}

type FileState = {
  file: string
  animLocals: Map<string, string>
  scrollHookLocals: Set<string>
  /** The inspector runtime's helpers in this file, by exported name → local name. */
  inspector: Map<string, string>
  helpers: Map<string, BabelTypes.Identifier>
  ordinals: Map<string, number>
  wrapped: WeakSet<BabelTypes.Node>
  sites: Record<string, SiteRecord>
}

function keyName(key: BabelTypes.Node): string | null {
  if (key.type === 'Identifier') return key.name
  if (key.type === 'StringLiteral') return key.value
  return null
}

function relativeFile(state: State): string {
  const file = state.filename ?? 'unknown'
  const root = state.opts.root ?? state.cwd ?? ''
  const rel = root && file.startsWith(root) ? file.slice(root.length).replace(/^[/\\]+/, '') : file
  return rel.replace(/\\/g, '/')
}

/** Nearest enclosing component (PascalCase) or hook (use…) name; else the nearest named function. Same rule as the inspector's plugin. */
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

const NESTED_STYLE_KEYS = new Set(['shadowOffset', 'textShadowOffset'])

function nameOfObject(obj: BabelTypes.Node): string | null {
  return obj.type === 'Identifier' ? obj.name : obj.type === 'MemberExpression' && !obj.computed ? keyName(obj.property) : null
}

/**
 * What a call animates: `scale.value = …` / `scale.set(…)` → "scale"; `{ opacity: … }` → "opacity" (the
 * style key wins over the shared value's name). Same reading as the inspector's `targetOf`.
 */
function propOf(path: NodePath): string | null {
  let prop: string | null = null
  let child: NodePath = path
  for (let p: NodePath | null = path.parentPath; p; child = p, p = p.parentPath) {
    if (p.isFunction() || p.isStatement()) break
    if (p.isObjectProperty() && prop === null) prop = keyName(p.node.key)
    else if (p.isObjectProperty() && NESTED_STYLE_KEYS.has(keyName(p.node.key) ?? '')) prop = keyName(p.node.key)
    if (p.isCallExpression() && p.node.arguments[0] === child.node) {
      const callee = p.node.callee
      if (callee.type === 'MemberExpression' && !callee.computed && keyName(callee.property) === 'set') return prop ?? nameOfObject(callee.object)
    }
    if (p.isAssignmentExpression()) {
      const left = p.node.left
      if (left.type === 'MemberExpression' && keyName(left.property) === 'value' && !left.computed) return prop ?? nameOfObject(left.object)
      break
    }
  }
  return prop
}

const hex12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)

// ─── The sites manifest (hashSites) ─────────────────────────────────────────────────

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** The app version and build the manifest is named for. */
export function appIdentity(root: string, opts: VitalsPluginOptions): { version: string; build?: string } {
  const appJson = readJson(path.join(root, 'app.json'))
  const expo = (appJson?.expo ?? appJson) as { version?: string; ios?: { buildNumber?: string }; android?: { versionCode?: number } } | undefined
  const pkg = readJson(path.join(root, 'package.json')) as { version?: string } | null
  const version = opts.appVersion ?? process.env.KEYFRAMER_APP_VERSION ?? expo?.version ?? pkg?.version ?? '0.0.0'
  const build = opts.build ?? process.env.KEYFRAMER_APP_BUILD ?? expo?.ios?.buildNumber ?? (expo?.android?.versionCode !== undefined ? String(expo.android.versionCode) : undefined)
  return build ? { version, build } : { version }
}

export function manifestPath(root: string, opts: VitalsPluginOptions): string {
  const app = appIdentity(root, opts)
  const name = app.build ? `${app.version}+${app.build}` : app.version
  return path.join(opts.manifestDir ?? path.join(root, '.keyframer'), `sites-${name.replace(/[^\w.+-]/g, '_')}.json`)
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * Replaces one file's sites in the manifest. Metro transforms files in several processes at once, so
 * the read-merge-write runs under a lock file (a stale one, over 10 s old, is taken over).
 */
export function writeManifest(file: string, source: string, sites: Record<string, SiteRecord>, app: { version: string; build?: string }): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const lock = `${file}.lock`
  let fd = -1
  for (let i = 0; i < 400 && fd < 0; i++) {
    try {
      fd = openSync(lock, 'wx')
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) unlinkSync(lock)
      } catch {
        // gone already
      }
      sleep(5)
    }
  }
  try {
    const prev = readJson(file) as { sites?: Record<string, SiteRecord> } | null
    const merged: Record<string, SiteRecord> = {}
    for (const [hash, s] of Object.entries(prev?.sites ?? {})) if (s.file !== source) merged[hash] = s
    Object.assign(merged, sites)
    const sorted = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : 1)))
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ format: 'keyframer-vitals-sites', version: 1, app, sites: sorted }, null, 2) + '\n')
    renameSync(tmp, file)
  } finally {
    if (fd >= 0) {
      closeSync(fd)
      try {
        unlinkSync(lock)
      } catch {
        // someone took it over
      }
    }
  }
}

// ─── The plugin ───────────────────────────────────────────────────────────────────

export default function keyframerVitals({ types: t }: { types: typeof BabelTypes }): PluginObj<State> {
  const literal = (value: unknown): BabelTypes.Expression => t.valueToNode(value) as BabelTypes.Expression

  /**
   * Wrapping a call hides its inline function arguments from the worklets plugin, which turns the
   * callbacks of withTiming / withSpring into worklets only when passed to them directly. Marked
   * 'worklet' here instead, so they still run on the UI thread.
   */
  const markWorklet = (fn: BabelTypes.Node) => {
    if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') return
    if (fn.body.type !== 'BlockStatement') fn.body = t.blockStatement([t.returnStatement(fn.body)])
    if (!fn.body.directives.some((d) => d.value.value === 'worklet')) fn.body.directives.unshift(t.directive(t.directiveLiteral('worklet')))
  }

  const helper = (fs: FileState, path: NodePath, name: string): BabelTypes.Identifier => {
    let id = fs.helpers.get(name)
    if (!id) {
      id = path.scope.getProgramParent().generateUidIdentifier(name.replace(/^__/, ''))
      fs.helpers.set(name, id)
    }
    return t.cloneNode(id)
  }
  const isHelper = (fs: FileState, e: BabelTypes.Node | null | undefined, name: string) =>
    e?.type === 'CallExpression' && e.callee.type === 'Identifier' && e.callee.name === fs.helpers.get(name)?.name

  const isModuleBinding = (path: NodePath, name: string) => path.scope.getBinding(name)?.kind === 'module'

  /** The site object a call carries: a source ref and key, or (hashSites) a hashed id. */
  const site = (state: State, fs: FileState, at: { line: number; column: number }, fn: string, component: string | null, prop: string | null) => {
    const group = `${fs.file}#${component ?? ''}#${fn}#${prop ?? ''}`
    const n = (fs.ordinals.get(group) ?? 0) + 1
    fs.ordinals.set(group, n)
    const key = `${group}#${n}`
    if (state.opts.hashSites) {
      const salt = state.opts.salt ?? ''
      const hash = hex12(`${salt}\n${fs.file}:${at.line}:${at.column}\n${key}`)
      fs.sites[hash] = { file: fs.file, line: at.line, column: at.column, fn, component, prop, key }
      return literal({ ref: { kind: 'hashed', hash }, key: `k_${hex12(`${salt}\n${key}`)}`, fn, component: null, prop: null })
    }
    return literal({ ref: { kind: 'source', file: fs.file, line: at.line, column: at.column }, key, fn, component, prop })
  }

  /** `line` and `column` of the inspector's site literal in `__kfAnim(fn, { … line: 4, column: 20 … }, …)`. */
  const inspectorPosition = (node: BabelTypes.Node | undefined): { line: number; column: number } | null => {
    if (!node || node.type !== 'ObjectExpression') return null
    let line: number | null = null
    let column: number | null = null
    for (const p of node.properties) {
      if (p.type !== 'ObjectProperty' || p.value.type !== 'NumericLiteral') continue
      if (keyName(p.key) === 'line') line = p.value.value
      if (keyName(p.key) === 'column') column = p.value.value
    }
    return line !== null ? { line, column: column ?? 0 } : null
  }

  /** The first statement of a scroll handler worklet: `_kfvScroll()`. */
  const reportScroll = (fs: FileState, path: NodePath, fn: BabelTypes.Node | null | undefined) => {
    if (!fn || fs.wrapped.has(fn)) return
    let body: BabelTypes.BlockStatement | null = null
    if (fn.type === 'ArrowFunctionExpression' || fn.type === 'FunctionExpression') {
      markWorklet(fn)
      body = fn.body as BabelTypes.BlockStatement
    } else if (fn.type === 'ObjectMethod') body = fn.body
    if (!body) return
    fs.wrapped.add(fn)
    body.body.unshift(t.expressionStatement(t.callExpression(helper(fs, path, '__kfvScroll'), [])))
  }

  const nodes: Visitor<State & { fs: FileState }> = {
    CallExpression(path, state) {
      const { fs } = state
      const { node } = path
      if (fs.wrapped.has(node) || node.callee.type !== 'Identifier') return
      const name = node.callee.name

      // useAnimatedScrollHandler(fn | { onScroll, onBeginDrag, … })
      if (fs.scrollHookLocals.has(name) && isModuleBinding(path, name)) {
        const [first] = node.arguments
        if (first?.type === 'ObjectExpression') {
          for (const p of first.properties) {
            if (p.type === 'ObjectProperty' && SCROLL_EVENTS.has(keyName(p.key) ?? '')) reportScroll(fs, path, p.value)
            else if (p.type === 'ObjectMethod' && SCROLL_EVENTS.has(keyName(p.key) ?? '')) reportScroll(fs, path, p)
          }
        } else reportScroll(fs, path, first)
        return
      }

      // withSpring(…) → _kfvAnim(withSpring, site, …)
      const fn = fs.animLocals.get(name)
      if (fn && isModuleBinding(path, name) && node.loc) {
        const at = { line: node.loc.start.line, column: node.loc.start.column }
        node.arguments.forEach(markWorklet)
        const call = t.callExpression(helper(fs, path, '__kfvAnim'), [t.identifier(name), site(state, fs, at, fn, enclosingName(path), propOf(path)), ...node.arguments])
        fs.wrapped.add(call)
        path.replaceWith(call)
        return
      }

      // The inspector got there first: _kfAnim(withSpring, isite, …) → _kfvAnimVia(_kfAnim, site, withSpring, isite, …)
      const viaLocal = fs.inspector.get('__kfAnim')
      const [first, isite, ...rest] = node.arguments
      if (viaLocal && name === viaLocal && first?.type === 'Identifier' && fs.animLocals.has(first.name) && isModuleBinding(path, first.name)) {
        const at = inspectorPosition(isite) ?? (node.loc ? { line: node.loc.start.line, column: node.loc.start.column } : null)
        if (!at || !isite) return
        const call = t.callExpression(helper(fs, path, '__kfvAnimVia'), [
          t.identifier(name),
          site(state, fs, at, fs.animLocals.get(first.name)!, enclosingName(path), propOf(path)),
          first,
          isite as BabelTypes.Expression,
          ...(rest as BabelTypes.Expression[]),
        ])
        fs.wrapped.add(call)
        path.replaceWith(call)
      }
    },

    JSXOpeningElement(path, state) {
      const { fs } = state
      const el = path.node
      const attr = (n: string) =>
        el.attributes.find((a): a is BabelTypes.JSXAttribute => a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && a.name.name === n)
      const value = (a: BabelTypes.JSXAttribute | undefined) =>
        a?.value?.type === 'JSXExpressionContainer' && a.value.expression.type !== 'JSXEmptyExpression' ? a.value.expression : null
      // A new attribute goes before the first spread: a `ref` or `onLayout` the app passes in `{...props}`
      // (React 19 passes refs as props) must still reach the view. Then the app's wins and ours only
      // misses that element's mount, instead of the app's ref silently staying empty.
      const setAttr = (n: string, expr: BabelTypes.Expression) => {
        const a = attr(n)
        if (a) {
          a.value = t.jsxExpressionContainer(expr)
          return
        }
        const added = t.jsxAttribute(t.jsxIdentifier(n), t.jsxExpressionContainer(expr))
        const spread = el.attributes.findIndex((x) => x.type === 'JSXSpreadAttribute')
        if (spread >= 0) el.attributes.splice(spread, 0, added)
        else el.attributes.push(added)
      }

      // entering / exiting / layout: remembered when rendered, started when the view mounts, goes or moves.
      const loc = el.loc
      if (loc) {
        const at = { line: loc.start.line, column: loc.start.column + 1 }
        const component = enclosingName(path)
        const kinds: Partial<Record<(typeof LAYOUT_PROPS)[number], BabelTypes.Expression>> = {}
        for (const kind of LAYOUT_PROPS) {
          const a = attr(kind)
          const v = value(a)
          if (!a || !v || isHelper(fs, v, '__kfvLayout')) continue
          const s = site(state, fs, at, kind, component, null)
          kinds[kind] = s
          a.value = t.jsxExpressionContainer(t.callExpression(helper(fs, path, '__kfvLayout'), [v, t.stringLiteral(kind), s]))
        }
        if (kinds.entering || kinds.exiting) {
          const prev = value(attr('ref'))
          setAttr('ref', t.callExpression(helper(fs, path, '__kfvMotionRef'), [kinds.entering ? t.cloneNode(kinds.entering) : t.nullLiteral(), kinds.exiting ? t.cloneNode(kinds.exiting) : t.nullLiteral(), ...(prev ? [prev] : [])]))
        }
        if (kinds.layout) {
          const prev = value(attr('onLayout'))
          setAttr('onLayout', t.callExpression(helper(fs, path, '__kfvLayoutMoved'), [t.cloneNode(kinds.layout), ...(prev ? [prev] : [])]))
        }
      }

      // A plain JS onScroll (a ScrollView or a list without a worklet handler) opens scroll windows.
      const onScroll = attr('onScroll')
      const v = value(onScroll)
      if (!onScroll || !v || isHelper(fs, v, '__kfvScrollJs')) return
      if (v.type !== 'Identifier' && v.type !== 'MemberExpression' && v.type !== 'ArrowFunctionExpression' && v.type !== 'FunctionExpression' && v.type !== 'CallExpression') return
      if (v.type === 'Identifier' && v.name === 'undefined') return
      // A useAnimatedScrollHandler result runs on the UI thread and reports from there.
      const callOf = (e: BabelTypes.Node): BabelTypes.Node | null | undefined => {
        if (e.type !== 'Identifier') return e
        const decl = path.scope.getBinding(e.name)?.path.node
        return decl?.type === 'VariableDeclarator' ? decl.init : null
      }
      const init = callOf(v)
      if (init?.type === 'CallExpression' && init.callee.type === 'Identifier' && fs.scrollHookLocals.has(init.callee.name)) return
      onScroll.value = t.jsxExpressionContainer(t.callExpression(helper(fs, path, '__kfvScrollJs'), [v]))
    },
  }

  const run = (program: NodePath<BabelTypes.Program>, state: State) => {
    if (state.done) return
    state.done = true
    const fs: FileState = {
      file: relativeFile(state),
      animLocals: new Map(),
      scrollHookLocals: new Set(),
      inspector: new Map(),
      helpers: new Map(),
      ordinals: new Map(),
      wrapped: new WeakSet(),
      sites: {},
    }
    for (const stmt of program.node.body) {
      if (stmt.type !== 'ImportDeclaration' || stmt.importKind === 'type') continue
      for (const spec of stmt.specifiers) {
        if (spec.type !== 'ImportSpecifier') continue
        const imported = spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value
        if (stmt.source.value === REANIMATED) {
          if (ANIMATION_FNS.has(imported)) fs.animLocals.set(spec.local.name, imported)
          if (imported === 'useAnimatedScrollHandler') fs.scrollHookLocals.add(spec.local.name)
        } else if (stmt.source.value === INSPECTOR_RUNTIME) fs.inspector.set(imported, spec.local.name)
      }
    }
    if (!fs.animLocals.size && !fs.scrollHookLocals.size && !/\b(entering|exiting|layout|onScroll)\s*=/.test(state.file.code ?? '')) return
    program.traverse(nodes, Object.assign(state, { fs }))
    if (fs.helpers.size) {
      const specifiers = [...fs.helpers].map(([exported, local]) => t.importSpecifier(local, t.identifier(exported)))
      program.unshiftContainer('body', t.importDeclaration(specifiers, t.stringLiteral(RUNTIME_MODULE)))
      // The imports are new bindings: the worklets plugin looks them up to capture them.
      program.scope.crawl()
    }
    if (state.opts.hashSites) {
      const root = state.opts.root ?? state.cwd ?? process.cwd()
      if (Object.keys(fs.sites).length || existsSync(manifestPath(root, state.opts))) {
        writeManifest(manifestPath(root, state.opts), fs.file, fs.sites, appIdentity(root, state.opts))
      }
    }
  }

  return {
    name: PLUGIN_NAME,
    visitor: {
      Program: {
        enter(program, state) {
          const file = (state.filename ?? '').replace(/\\/g, '/')
          state.skip = (!state.opts.includeNodeModules && file.includes('/node_modules/')) || /\/packages\/vitals\/(src|dist)\//.test(file)
          state.done = false
          state.program = program
          if (state.skip) {
            state.pending = false
            return
          }
          // The inspector's plugin, listed after this one, wraps in its own Program enter, which runs
          // after this one: wait for the first node below Program, when it has (and before any other
          // plugin's visitors reach that node, as long as this plugin is listed before them).
          const keys = ((state.file.opts as { plugins?: Array<{ key?: string }> }).plugins ?? []).map((p) => p.key)
          const me = keys.indexOf(PLUGIN_NAME)
          const inspector = keys.indexOf(INSPECTOR_PLUGIN)
          state.pending = me >= 0 && inspector > me
          if (!state.pending) run(program, state)
        },
      },
      // Program's first child is a directive or a statement (Babel allows no catch-all visitor).
      'Statement|Directive'(_path: NodePath, state: State) {
        if (!state.pending) return
        state.pending = false
        if (state.program) run(state.program, state)
      },
    },
  }
}
