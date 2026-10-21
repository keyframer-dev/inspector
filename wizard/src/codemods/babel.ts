/**
 * The Babel plugins, as the docs set them up (getting-started/react-native.md, vitals/react-native.md):
 * `@keyframerdev/inspector/babel` in development only, `@keyframerdev/vitals/babel` in every build,
 * both before the worklets plugin, which stays last. Expo's preset adds the worklets plugin itself,
 * after the app's plugins; bare React Native lists it.
 *
 * A config it recognises is edited in place (only the lines that change); a new app without one gets
 * the docs' file; anything else (a function with branches, JSON with comments, plugins built in code)
 * is left alone, with the snippet to paste.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type * as t from '@babel/types'
import type { Product, Project } from '../types'
import { detectStyle, end, indentAt, leadingStart, parseSource, quoted, reindent, semi, Splicer, start, visit, type Fn, type Node, type Style } from './source'

export const INSPECTOR_PLUGIN = '@keyframerdev/inspector/babel'
export const VITALS_PLUGIN = '@keyframerdev/vitals/babel'
export const WORKLETS_PLUGIN = 'react-native-worklets/plugin'
const WORKLETS = /^react-native-(worklets|reanimated)\/plugin$/

export type BabelPlan =
  /** Everything is in place. */
  | { kind: 'ok'; file: string; notes: string[] }
  | { kind: 'create' | 'edit'; file: string; before: string | null; after: string; notes: string[] }
  /** Not edited: `snippet` is what to change, by hand. */
  | { kind: 'manual'; file: string; reason: string; snippet: string; notes: string[] }

type Want = { inspector: boolean; vitals: boolean }

/** The config the docs show for this kind of app, with these plugins. */
export function docsConfig(expo: boolean, want: Want): string {
  const q = (s: string) => `'${s}'`
  const ins = `...(dev ? [${q(INSPECTOR_PLUGIN)}] : [])`
  if (expo) {
    if (!want.inspector) {
      return [
        'module.exports = function (api) {',
        '  api.cache(true)',
        '  return {',
        "    presets: ['babel-preset-expo'],",
        `    plugins: [${want.vitals ? q(VITALS_PLUGIN) : ''}],`,
        '  }',
        '}',
        '',
      ].join('\n')
    }
    const plugins = want.vitals ? `[${ins}, ${q(VITALS_PLUGIN)}]` : `dev ? [${q(INSPECTOR_PLUGIN)}] : []`
    return [
      'module.exports = function (api) {',
      '  api.cache.using(() => process.env.NODE_ENV)',
      "  const dev = process.env.NODE_ENV !== 'production'",
      '  return {',
      "    presets: ['babel-preset-expo'],",
      `    plugins: ${plugins},`,
      '  }',
      '}',
      '',
    ].join('\n')
  }
  if (!want.inspector) {
    return [
      'module.exports = {',
      "  presets: ['module:@react-native/babel-preset'],",
      `  plugins: [${want.vitals ? `${q(VITALS_PLUGIN)}, ` : ''}${q(WORKLETS_PLUGIN)}],`,
      '}',
      '',
    ].join('\n')
  }
  return [
    'module.exports = function (api) {',
    "  const dev = api.env('development')",
    '  return {',
    "    presets: ['module:@react-native/babel-preset'],",
    `    plugins: [${ins}, ${want.vitals ? `${q(VITALS_PLUGIN)}, ` : ''}${q(WORKLETS_PLUGIN)}],`,
    '  }',
    '}',
    '',
  ].join('\n')
}

/** What to do with the app's Babel config for these products. */
export function planBabel(project: Project, products: Product[]): BabelPlan {
  const want: Want = { inspector: products.includes('inspector'), vitals: products.includes('vitals') }
  const expo = !!project.expo
  const file = project.babelConfig
  if (!file) {
    const pkg = readPkg(project.root)
    const name = pkg?.type === 'module' ? 'babel.config.cjs' : 'babel.config.js'
    const target = path.join(project.root, name)
    if (pkg?.babel) {
      return {
        kind: 'manual',
        file: path.join(project.root, 'package.json'),
        reason: 'Your Babel config is the "babel" key in package.json. Move it to a babel.config.js like this one, with your own plugins added:',
        snippet: docsConfig(expo, want),
        notes: [],
      }
    }
    const notes = expo ? ['babel-preset-expo becomes a dev dependency: a new babel.config.js needs it at the top level, or Metro fails to start.'] : []
    return { kind: 'create', file: target, before: null, after: docsConfig(expo, want), notes }
  }
  const code = readFileSync(file, 'utf8')
  const base = path.basename(file)
  if (base.endsWith('.json') || base === '.babelrc') return planJson(file, code, expo, want)
  try {
    return planJs(file, code, expo, want)
  } catch (e) {
    if (e instanceof Manual) return manual(file, e.message, expo, want)
    if (e instanceof SyntaxError) return manual(file, `${base} doesn't parse (${e.message}), so it was left as it is.`, expo, want)
    throw e
  }
}

class Manual extends Error {}

function manual(file: string, reason: string, expo: boolean, want: Want): BabelPlan {
  const add = [want.inspector ? `${INSPECTOR_PLUGIN} (development only)` : null, want.vitals ? VITALS_PLUGIN : null].filter(Boolean).join(' and ')
  return {
    kind: 'manual',
    file,
    reason: `${reason} Add ${add} to its plugins, before ${expo ? 'any' : 'the'} worklets plugin (which stays last). The docs' config for this app:`,
    snippet: docsConfig(expo, want),
    notes: [],
  }
}

function readPkg(root: string): { type?: string; babel?: unknown } | null {
  try {
    return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

function has(code: string, plugin: string): boolean {
  return code.includes(`'${plugin}'`) || code.includes(`"${plugin}"`) || code.includes(`\`${plugin}\``)
}

// ── JavaScript configs ──────────────────────────────────────────────────────────────

type Located = { obj: t.ObjectExpression; fn: Fn | null; exportValue: t.Node }

/** The config object: `module.exports = {…}`, a function returning one, or `export default` of either. */
function locate(ast: t.File): Located {
  let value: t.Node | null = null
  for (const s of ast.program.body) {
    if (s.type === 'ExpressionStatement' && s.expression.type === 'AssignmentExpression') {
      const l = s.expression.left
      if (l.type === 'MemberExpression' && l.object.type === 'Identifier' && l.object.name === 'module' && l.property.type === 'Identifier' && l.property.name === 'exports') value = s.expression.right
    }
    if (s.type === 'ExportDefaultDeclaration') value = s.declaration
  }
  if (!value) throw new Manual("It doesn't export a config the wizard recognises (module.exports = … or export default …).")
  if (value.type === 'Identifier') {
    const name = value.name
    const decl = ast.program.body.flatMap((s) => (s.type === 'VariableDeclaration' ? s.declarations : [])).find((d) => d.id.type === 'Identifier' && d.id.name === name)
    const fnDecl = ast.program.body.find((s): s is t.FunctionDeclaration => s.type === 'FunctionDeclaration' && s.id?.name === name)
    const target = fnDecl ?? decl?.init
    if (!target || target.type === 'ObjectExpression') throw new Manual(`Its config is the variable ${name}, which the wizard doesn't edit.`)
    value = target
  }
  if (value.type === 'ObjectExpression') return { obj: value, fn: null, exportValue: value }
  if (value.type === 'FunctionExpression' || value.type === 'ArrowFunctionExpression' || value.type === 'FunctionDeclaration') {
    const fn = value
    if (fn.body.type === 'ObjectExpression') throw new Manual('Its config is an arrow function returning an object directly.')
    if (fn.body.type !== 'BlockStatement') throw new Manual("Its config function doesn't return an object the wizard recognises.")
    const returns: t.ReturnStatement[] = []
    visit(fn.body, (n) => {
      if (n !== fn.body && (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'FunctionDeclaration' || n.type === 'ObjectMethod')) return false
      if (n.type === 'ReturnStatement') returns.push(n)
    })
    const ret = returns[0]
    if (returns.length !== 1 || !ret || !fn.body.body.includes(ret)) throw new Manual('Its config function has more than one way to return (branches the wizard would have to guess about).')
    let arg = ret.argument
    if (arg?.type === 'Identifier') {
      const name = arg.name
      const d = fn.body.body.flatMap((s) => (s.type === 'VariableDeclaration' ? s.declarations : [])).find((x) => x.id.type === 'Identifier' && x.id.name === name)
      arg = d?.init ?? null
    }
    if (arg?.type !== 'ObjectExpression') throw new Manual("Its config function doesn't return an object literal.")
    return { obj: arg, fn, exportValue: value }
  }
  throw new Manual("It doesn't export a config the wizard recognises.")
}

function propKey(p: t.ObjectExpression['properties'][number]): string | null {
  if (p.type !== 'ObjectProperty' || p.computed) return null
  return p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : null
}

function pluginName(el: t.Node | null): string | null {
  if (!el) return null
  if (el.type === 'StringLiteral') return el.value
  if (el.type === 'ArrayExpression' && el.elements[0]?.type === 'StringLiteral') return el.elements[0].value
  return null
}

/** Whether a plugins element mentions `plugin` (a string, `[name, opts]`, or inside a spread). */
function mentions(code: string, el: t.Node | null, plugin: string): boolean {
  return !!el && has(code.slice(start(el), end(el)), plugin)
}

/** Inserts `texts` into an array or object literal before item `at` (or after the last), in the list's own layout. */
export function insertIntoList(sp: Splicer, code: string, list: { start: number; end: number; items: Node[] }, at: number, texts: string[]): void {
  const { items } = list
  if (items.length === 0) {
    const isObject = code[list.start] === '{'
    sp.replace(list.start + 1, list.end - 1, isObject ? ` ${texts.join(', ')} ` : texts.join(', '))
    return
  }
  // One item per line when the first one starts on a line of its own.
  const multiline = code.slice(list.start + 1, leadingStart(code, items[0]!)).includes('\n')
  if (at < items.length) {
    const target = items[at]!
    const pos = leadingStart(code, target)
    if (multiline) sp.insert(pos, texts.map((x) => `${x},\n${indentAt(code, pos)}`).join(''))
    else sp.insert(pos, `${texts.join(', ')}, `)
    return
  }
  const last = items[items.length - 1]!
  if (multiline) {
    const ind = indentAt(code, start(last))
    sp.insert(end(last), texts.map((x) => `,\n${ind}${x}`).join(''))
  } else sp.insert(end(last), texts.map((x) => `, ${x}`).join(''))
}

const DEV_EXPRS = [/^process\.env\.NODE_ENV\s*!==?\s*['"]production['"]$/, /^process\.env\.NODE_ENV\s*===?\s*['"]development['"]$/, /^\w+\.env\(\s*['"]development['"]\s*\)$/]

/** A `const x = <is development>` already in the config function, to reuse. */
function existingDev(code: string, fn: Fn | null): string | null {
  if (!fn || fn.body.type !== 'BlockStatement') return null
  for (const s of fn.body.body) {
    if (s.type !== 'VariableDeclaration') continue
    for (const d of s.declarations) {
      if (d.id.type === 'Identifier' && d.init && DEV_EXPRS.some((re) => re.test(code.slice(start(d.init!), end(d.init!)).trim()))) return d.id.name
    }
  }
  return null
}

function boundNames(ast: t.File): Set<string> {
  const names = new Set<string>()
  visit(ast.program, (n) => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') names.add(n.id.name)
    if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') && n.params)
      for (const p of n.params) if (p.type === 'Identifier') names.add(p.name)
  })
  return names
}

function planJs(file: string, code: string, expo: boolean, want: Want): BabelPlan {
  const notes: string[] = []
  const hasIns = has(code, INSPECTOR_PLUGIN)
  const hasVit = has(code, VITALS_PLUGIN)
  const needIns = want.inspector && !hasIns
  const needVit = want.vitals && !hasVit
  const ast = parseSource(code)
  const style = detectStyle(code, ast)
  const { obj, fn } = locate(ast)
  const pluginsProp = obj.properties.find((p): p is t.ObjectProperty => propKey(p) === 'plugins')
  const plugins = pluginsProp?.value

  // Order: the inspector's plugin before the worklets plugin (Expo's preset adds its own after the app's plugins).
  if (plugins?.type === 'ArrayExpression') {
    const els = plugins.elements
    const w = els.findIndex((e) => WORKLETS.test(pluginName(e) ?? ''))
    const i = els.findIndex((e) => mentions(code, e, INSPECTOR_PLUGIN))
    const v = els.findIndex((e) => mentions(code, e, VITALS_PLUGIN))
    if (w >= 0 && i > w) notes.push(`${path.basename(file)} lists ${INSPECTOR_PLUGIN} after ${pluginName(els[w]!)}: move it before, or the Inspector misses worklets.`)
    if (w >= 0 && v > w) notes.push(`${path.basename(file)} lists ${VITALS_PLUGIN} after ${pluginName(els[w]!)}: the worklets plugin should stay last.`)
    if (!expo && w < 0 && (hasIns || hasVit)) notes.push(`${path.basename(file)} has no ${WORKLETS_PLUGIN}: Reanimated 4 needs it, last in plugins.`)
  }
  if (!needIns && !needVit) return { kind: 'ok', file, notes }

  if (obj.properties.some((p) => p.type === 'SpreadElement') && !pluginsProp) throw new Manual('Its config object is spread from another one.')
  if (pluginsProp && pluginsProp.shorthand) throw new Manual('Its plugins come from a variable.')

  let devName = needIns ? existingDev(code, fn) : null
  const needDevDecl = needIns && !devName
  if (needDevDecl) {
    if (boundNames(ast).has('dev')) throw new Manual('It already has something called `dev` the wizard would have to guess about.')
    devName = 'dev'
  }
  const q = (s: string) => quoted(style, s)
  const insEl = `...(${devName} ? [${q(INSPECTOR_PLUGIN)}] : [])`
  const sp = new Splicer(code)

  // ── plugins ──
  if (!pluginsProp) {
    let value: string
    if (expo) value = needIns && !needVit && !hasVit ? `${devName} ? [${q(INSPECTOR_PLUGIN)}] : []` : `[${[needIns ? insEl : null, needVit ? q(VITALS_PLUGIN) : null].filter(Boolean).join(', ')}]`
    else value = `[${[needIns ? insEl : null, needVit ? q(VITALS_PLUGIN) : null, q(WORKLETS_PLUGIN)].filter(Boolean).join(', ')}]`
    if (!expo) notes.push(`Added ${WORKLETS_PLUGIN}, last: Reanimated 4 needs it.`)
    const props = obj.properties as Node[]
    const presets = obj.properties.findIndex((p) => propKey(p) === 'presets')
    insertIntoList(sp, code, { start: start(obj), end: end(obj), items: props }, presets >= 0 ? presets + 1 : props.length, [`plugins: ${value}`])
  } else if (plugins?.type === 'ArrayExpression') {
    const els = plugins.elements.filter((e): e is NonNullable<typeof e> => !!e) as Node[]
    const w = els.findIndex((e) => WORKLETS.test(pluginName(e as t.Node) ?? ''))
    const add = [needIns ? insEl : null, needVit ? q(VITALS_PLUGIN) : null].filter((x): x is string => !!x)
    if (!expo && w < 0) {
      add.push(q(WORKLETS_PLUGIN))
      notes.push(`Added ${WORKLETS_PLUGIN}, last: Reanimated 4 needs it.`)
    }
    insertIntoList(sp, code, { start: start(plugins), end: end(plugins), items: els }, w >= 0 ? w : els.length, add)
  } else if (plugins?.type === 'ConditionalExpression' && plugins.consequent.type === 'ArrayExpression' && plugins.alternate.type === 'ArrayExpression' && plugins.alternate.elements.length === 0 && !needIns && needVit) {
    // `dev ? ['@keyframerdev/inspector/babel'] : []`, from the docs: the Vitals plugin goes beside it, in every build.
    const text = code.slice(start(plugins), end(plugins))
    sp.replace(start(plugins), end(plugins), `[...(${text}), ${q(VITALS_PLUGIN)}${!expo ? `, ${q(WORKLETS_PLUGIN)}` : ''}]`)
  } else {
    throw new Manual('Its plugins are built in code the wizard would have to guess about.')
  }

  // ── `dev`, and a cache that follows NODE_ENV ──
  if (needDevDecl && fn) {
    if (fn.body.type !== 'BlockStatement') throw new Manual("Its config function isn't a block.")
    const api = fn.params[0]?.type === 'Identifier' ? fn.params[0].name : null
    if (!expo && !api) throw new Manual("Its config function doesn't take Babel's api.")
    const devExpr = expo ? `process.env.NODE_ENV !== ${q('production')}` : `${api}.env(${q('development')})`
    const body = fn.body.body
    const cache = body.find((s): s is t.ExpressionStatement => s.type === 'ExpressionStatement' && isCacheForever(code, s.expression))
    const ret = body.find((s) => s.type === 'ReturnStatement')!
    const ind = indentAt(code, start(ret))
    if (cache && api) {
      // api.cache(true) would keep the first build's answer for `dev` forever.
      sp.replace(start(cache.expression), end(cache.expression), `${api}.cache.using(() => process.env.NODE_ENV)`)
      sp.insert(end(cache), `\n${ind}const ${devName} = ${devExpr}${semi(style)}`)
      notes.push(`${api}.cache(true) became ${api}.cache.using(() => process.env.NODE_ENV), so the development-only plugin follows NODE_ENV.`)
    } else {
      sp.insert(start(ret), `const ${devName} = ${devExpr}${semi(style)}\n${ind}`)
    }
    return { kind: 'edit', file, before: code, after: sp.apply(), notes }
  }
  if (needDevDecl && !fn) {
    // An object config becomes a function, so the inspector's plugin can be development only.
    const once = sp.apply()
    return { kind: 'edit', file, before: code, after: objectToFunction(once, expo, style), notes: [...notes, 'The config object became a function of Babel\'s api, so the Inspector\'s plugin runs in development only.'] }
  }
  return { kind: 'edit', file, before: code, after: sp.apply(), notes }
}

function isCacheForever(code: string, e: t.Expression): boolean {
  if (e.type !== 'CallExpression') return false
  const callee = code.slice(start(e.callee), end(e.callee)).replace(/\s/g, '')
  if (/^\w+\.cache\.forever$/.test(callee)) return true
  return /^\w+\.cache$/.test(callee) && e.arguments.length === 1 && e.arguments[0]!.type === 'BooleanLiteral' && e.arguments[0]!.value === true
}

function objectToFunction(code: string, expo: boolean, style: Style): string {
  const ast = parseSource(code)
  const { obj } = locate(ast)
  const i = style.indent
  const q = (s: string) => quoted(style, s)
  const s = semi(style)
  const head = expo
    ? `${i}api.cache.using(() => process.env.NODE_ENV)${s}\n${i}const dev = process.env.NODE_ENV !== ${q('production')}${s}\n`
    : `${i}const dev = api.env(${q('development')})${s}\n`
  const text = `function (api) {\n${head}${i}return ${reindent(code.slice(start(obj), end(obj)), i)}${s}\n}`
  return code.slice(0, start(obj)) + text + code.slice(end(obj))
}

// ── JSON configs ────────────────────────────────────────────────────────────────────

type JsonConfig = { plugins?: unknown[]; env?: Record<string, { plugins?: unknown[] }>; [k: string]: unknown }

function planJson(file: string, code: string, expo: boolean, want: Want): BabelPlan {
  const base = path.basename(file)
  let cfg: JsonConfig
  try {
    cfg = JSON.parse(code) as JsonConfig
  } catch {
    return manual(file, `${base} isn't plain JSON (comments?), so it was left as it is.`, expo, want)
  }
  const hasIns = has(code, INSPECTOR_PLUGIN)
  const hasVit = has(code, VITALS_PLUGIN)
  const needIns = want.inspector && !hasIns
  const needVit = want.vitals && !hasVit
  if (!needIns && !needVit) return { kind: 'ok', file, notes: [] }
  const plugins = Array.isArray(cfg.plugins) ? [...cfg.plugins] : cfg.plugins === undefined ? [] : null
  if (!plugins) return manual(file, `${base} has plugins the wizard doesn't recognise.`, expo, want)
  const name = (p: unknown) => (typeof p === 'string' ? p : Array.isArray(p) && typeof p[0] === 'string' ? p[0] : '')
  const w = plugins.findIndex((p) => WORKLETS.test(name(p)))
  // JSON can't say "development only" except through env.development, whose plugins Babel adds after
  // the others: fine for Expo (its preset's worklets plugin runs after the app's), wrong when the
  // worklets plugin is listed here.
  if (needIns && (w >= 0 || !expo)) return manual(file, `${base} can't run the Inspector's plugin in development only, before the worklets plugin. Replace it with a babel.config.js:`, expo, want)
  const out: JsonConfig = { ...cfg }
  if (needVit) {
    plugins.splice(w >= 0 ? w : plugins.length, 0, VITALS_PLUGIN)
    out.plugins = plugins
  }
  if (needIns) {
    const env = { ...(cfg.env ?? {}) }
    const dev = { ...(env.development ?? {}) }
    dev.plugins = [...(Array.isArray(dev.plugins) ? dev.plugins : []), INSPECTOR_PLUGIN]
    env.development = dev
    out.env = env
  }
  const indent = code.match(/^([ \t]+)"/m)?.[1] ?? '  '
  const notes = needIns ? ['In JSON, development only is env.development: the Inspector\'s plugin is listed there.'] : []
  return { kind: 'edit', file, before: code, after: `${JSON.stringify(out, null, indent)}\n`, notes }
}
