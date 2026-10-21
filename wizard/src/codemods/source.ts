/**
 * Source files as the codemods see them: parsed by recast with @babel/parser (TypeScript and JSX),
 * edited by splicing text at the nodes' offsets, so only what changed is printed and everything else
 * (comments, blank lines, the file's semicolons and quotes) stays as it was written.
 */
import { parse as babelParse } from '@babel/parser'
import type * as t from '@babel/types'
import * as recast from 'recast'

export type Node = t.Node & { start?: number | null; end?: number | null }

/** How a file writes code: new lines follow it. */
/** `braces`: the space inside `{ a }` in imports ('' for `{a}`). */
export type Style = { semi: boolean; quote: "'" | '"'; indent: string; braces: ' ' | '' }

const parser = {
  parse: (code: string) =>
    babelParse(code, { sourceType: 'module', allowReturnOutsideFunction: true, plugins: ['typescript', 'jsx'], tokens: true }),
}

/** The file's AST (a Babel File). Throws a SyntaxError for code it can't read. */
export function parseSource(code: string): t.File {
  // recast parses a copy of the text with its indentation tabs expanded (to tabWidth) and its line
  // ends made one kind: a tab width of 1 and the file's own line end keep every offset the same.
  const lineTerminator = code.includes('\r\n') ? '\r\n' : '\n'
  const ast = recast.parse(code, { parser, tabWidth: 1, lineTerminator }) as t.File & { end?: number | null }
  // Offsets are what the edits splice at: if they drifted anyway (mixed line ends), Babel's own tree.
  if (ast.end != null && ast.end !== code.length) return parser.parse(code) as unknown as t.File
  return ast
}

/** Whether `code` parses: what the tests check every output with. */
export function parses(code: string): boolean {
  try {
    parseSource(code)
    return true
  } catch {
    return false
  }
}

export function start(n: Node): number {
  return n.start ?? 0
}
export function end(n: Node): number {
  return n.end ?? 0
}

/** Semicolons and quotes by majority (ties: semicolons, single quotes), indentation from the first indented line. */
export function detectStyle(code: string, ast: t.File): Style {
  let semi = 0
  let bare = 0
  let single = 0
  let double = 0
  visit(ast.program, (n, parent) => {
    if (
      n.type === 'ImportDeclaration' ||
      n.type === 'ExpressionStatement' ||
      n.type === 'VariableDeclaration' ||
      n.type === 'ReturnStatement' ||
      n.type === 'ExportNamedDeclaration'
    ) {
      if (n.type === 'VariableDeclaration' && parent && /^For/.test(parent.type)) return
      if (n.type === 'ExportNamedDeclaration' && n.declaration && n.declaration.type !== 'VariableDeclaration') return
      if (code[end(n) - 1] === ';') semi++
      else bare++
    }
    if (n.type === 'StringLiteral' && parent?.type !== 'JSXAttribute') {
      const q = code[start(n)]
      if (q === "'") single++
      else if (q === '"') double++
    }
  })
  // The smallest indentation of code lines (not comment lines) is one level.
  let indent = '  '
  const levels = code
    .split('\n')
    .map((l) => l.match(/^([ \t]+)[^\s*]/)?.[1])
    .filter((s): s is string => !!s)
  if (levels.some((s) => s.startsWith('\t'))) indent = '\t'
  else if (levels.length) {
    const min = Math.min(...levels.map((s) => s.length))
    if (min === 4) indent = '    '
  }
  // Named imports: `{ a }` or `{a}`, by the first one.
  const named = imports(ast).find((d) => d.specifiers.some((s) => s.type === 'ImportSpecifier'))
  const braces = named && /^import\s*(type\s+)?(\w+\s*,\s*)?\{\S/.test(code.slice(start(named), end(named))) ? '' : ' '
  return { semi: semi >= bare, quote: double > single ? '"' : "'", indent, braces }
}

/** Every node below `root`, depth first. `fn` returning false skips the node's children. */
export function visit(root: Node, fn: (n: Node, parent: Node | null) => void | false): void {
  const walk = (n: Node, parent: Node | null) => {
    if (fn(n, parent) === false) return
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'tokens' || key === 'comments' || key === 'leadingComments' || key === 'trailingComments' || key === 'original' || key === 'extra') continue
      const v = (n as unknown as Record<string, unknown>)[key]
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c === 'object' && typeof (c as Node).type === 'string') walk(c as Node, n)
      } else if (v && typeof v === 'object' && typeof (v as Node).type === 'string') walk(v as Node, n)
    }
  }
  walk(root, null)
}

/** A string literal in the file's quotes. */
export function quoted(style: Style, value: string): string {
  const q = style.quote
  return q + value.replaceAll('\\', '\\\\').replaceAll(q, `\\${q}`) + q
}

/** A statement's end in the file's style. */
export function semi(style: Style): string {
  return style.semi ? ';' : ''
}

/** The whitespace that starts the line `pos` is on. */
export function indentAt(code: string, pos: number): string {
  const lineStart = code.lastIndexOf('\n', pos - 1) + 1
  return code.slice(lineStart).match(/^[ \t]*/)![0]
}

/** 1-based line of `pos`. */
export function lineAt(code: string, pos: number): number {
  let line = 1
  for (let i = 0; i < pos && i < code.length; i++) if (code.charCodeAt(i) === 10) line++
  return line
}

/** Every line after the first of `text`, indented by `by` more. */
export function reindent(text: string, by: string): string {
  return text
    .split('\n')
    .map((l, i) => (i === 0 || l.trim() === '' ? l : by + l))
    .join('\n')
}

/** Text edits at offsets of the original, applied together. */
type Edit = { start: number; end: number; text: string; order: number; wrap?: (inner: string) => string }

/**
 * Text edits at offsets of the original, applied together. Inserts and replaces must not overlap; a
 * `wrap` may contain other edits, which are applied to its text before it is wrapped (VitalsRoot
 * around JSX that also gets a ref).
 */
export class Splicer {
  private edits: Edit[] = []
  constructor(readonly code: string) {}
  insert(at: number, text: string): this {
    return this.replace(at, at, text)
  }
  replace(from: number, to: number, text: string): this {
    this.edits.push({ start: from, end: to, text, order: this.edits.length })
    return this
  }
  /** Replaces `from`..`to` with `fn` of its text, the edits inside it applied first. */
  wrap(from: number, to: number, fn: (inner: string) => string): this {
    this.edits.push({ start: from, end: to, text: '', order: this.edits.length, wrap: fn })
    return this
  }
  get changed(): boolean {
    return this.edits.length > 0
  }
  apply(): string {
    return applyEdits(this.code, 0, this.edits)
  }
}

function inside(e: Edit, w: Edit): boolean {
  if (e === w) return false
  const empty = e.start === e.end
  return empty ? w.start < e.start && e.start < w.end : w.start <= e.start && e.end <= w.end
}

/** `edits` (offsets into the whole file) on `code`, the part of the file that starts at `base`. */
function applyEdits(code: string, base: number, edits: Edit[]): string {
  const wraps = edits.filter((e) => e.wrap)
  const nested = new Set(edits.filter((e) => wraps.some((w) => inside(e, w))))
  // Front to back over the original; at one offset, inserts (in the order they were made) before a replace.
  const top = edits.filter((e) => !nested.has(e)).sort((a, b) => a.start - b.start || +(a.end > a.start) - +(b.end > b.start) || a.order - b.order)
  let out = ''
  let at = 0
  for (const e of top) {
    const from = e.start - base
    const to = e.end - base
    const text = e.wrap ? e.wrap(applyEdits(code.slice(from, to), e.start, edits.filter((x) => nested.has(x) && inside(x, e)))) : e.text
    out += code.slice(at, from) + text
    at = Math.max(at, to)
  }
  return out + code.slice(at)
}

// ── Imports ─────────────────────────────────────────────────────────────────────────

export function imports(ast: t.File): t.ImportDeclaration[] {
  return ast.program.body.filter((s): s is t.ImportDeclaration => s.type === 'ImportDeclaration')
}

/** The local name `source` exports `name` as, when the file imports it (values, not `import type`). */
export function importedAs(ast: t.File, source: string | ((s: string) => boolean), name: string): string | null {
  const match = typeof source === 'string' ? (s: string) => s === source : source
  for (const d of imports(ast)) {
    if (!match(d.source.value) || d.importKind === 'type') continue
    for (const s of d.specifiers) {
      if (s.type === 'ImportSpecifier' && s.importKind !== 'type' && (s.imported.type === 'Identifier' ? s.imported.name : s.imported.value) === name) return s.local.name
      if (name === 'default' && s.type === 'ImportDefaultSpecifier') return s.local.name
    }
  }
  return null
}

/** Whether the file imports `source` at all (a side-effect import counts). */
export function importsSource(ast: t.File, source: string | ((s: string) => boolean)): boolean {
  const match = typeof source === 'string' ? (s: string) => s === source : source
  return imports(ast).some((d) => match(d.source.value))
}

/** Names bound at the top of the module: imports, declarations. */
export function moduleNames(ast: t.File): Set<string> {
  const names = new Set<string>()
  for (const s of ast.program.body) {
    const decl = s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration' ? s.declaration : s
    if (!decl) continue
    if (decl.type === 'ImportDeclaration') for (const sp of decl.specifiers) names.add(sp.local.name)
    if (decl.type === 'VariableDeclaration') for (const d of decl.declarations) for (const n of patternNames(d.id)) names.add(n)
    if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id) names.add(decl.id.name)
  }
  return names
}

export function patternNames(p: t.Node): string[] {
  if (p.type === 'Identifier') return [p.name]
  if (p.type === 'ObjectPattern') return p.properties.flatMap((q) => (q.type === 'RestElement' ? patternNames(q.argument) : patternNames(q.value)))
  if (p.type === 'ArrayPattern') return p.elements.flatMap((e) => (e ? patternNames(e) : []))
  if (p.type === 'AssignmentPattern') return patternNames(p.left)
  if (p.type === 'RestElement') return patternNames(p.argument)
  return []
}

/**
 * Adds `{ name }` from `source`: into an existing named import of it when there is one, else as a new
 * import after the last one (or at the top). Nothing when it is imported already. Returns the local name.
 */
export function addNamedImport(sp: Splicer, ast: t.File, style: Style, source: string, name: string): string {
  const have = importedAs(ast, source, name)
  if (have) return have
  const existing = imports(ast).find(
    (d) => d.source.value === source && d.importKind !== 'type' && d.specifiers.length > 0 && d.specifiers.every((s) => s.type === 'ImportSpecifier'),
  )
  if (existing) {
    const last = existing.specifiers[existing.specifiers.length - 1]!
    sp.insert(end(last), `, ${name}`)
    return name
  }
  const b = style.braces
  addImportLine(sp, ast, `import {${b}${name}${b}} from ${quoted(style, source)}${semi(style)}`)
  return name
}

/** `import './keyframer'` and the like: after the last import, or at the very top. */
export function addImportLine(sp: Splicer, ast: t.File, line: string): void {
  const all = imports(ast)
  const last = all[all.length - 1]
  if (last) sp.insert(end(last), `\n${line}`)
  else {
    // Above the first statement, after a leading comment block or directive ('use client').
    const first = ast.program.body[0]
    const directive = ast.program.directives?.[ast.program.directives.length - 1]
    if (directive) sp.insert(end(directive), `\n${line}`)
    else if (first) sp.insert(start(first), `${line}\n\n`)
    else sp.insert(0, `${line}\n`)
  }
}

/** The import path from `fromFile` to `toFile`, without its extension: `../keyframer`, `./src/keyframer`. */
export function relativeImport(fromFile: string, toFile: string): string {
  const fromDir = fromFile.replace(/[/\\][^/\\]*$/, '')
  const from = fromDir.split(/[/\\]/)
  const to = toFile.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '').split(/[/\\]/)
  let i = 0
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++
  const up = from.length - i
  const rest = to.slice(i).join('/')
  return up === 0 ? `./${rest}` : `${'../'.repeat(up)}${rest}`
}

/** Whether an import path names the wizard's file (`./keyframer`, `../src/keyframer`, `@/keyframer`). */
export function isKeyframerImport(source: string): boolean {
  return /(^|\/)keyframer(\.(tsx?|jsx?))?$/.test(source) && (source.startsWith('.') || source.startsWith('@/') || source.startsWith('~/'))
}

// ── Functions and components ────────────────────────────────────────────────────────

export type Fn = t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression

/** The default-exported component of a file: `export default function`, or `export default Name` of a function. */
export function defaultExportFunction(ast: t.File): Fn | null {
  for (const s of ast.program.body) {
    if (s.type !== 'ExportDefaultDeclaration') continue
    const d = s.declaration
    if (d.type === 'FunctionDeclaration' || d.type === 'ArrowFunctionExpression' || d.type === 'FunctionExpression') return d
    if (d.type === 'Identifier') return topLevelFunction(ast, d.name)
  }
  return null
}

/** A top-level `function Name` or `const Name = () => …` / `function () …`. */
export function topLevelFunction(ast: t.File, name: string): Fn | null {
  for (const s of ast.program.body) {
    const decl = s.type === 'ExportNamedDeclaration' ? s.declaration : s
    if (!decl) continue
    if (decl.type === 'FunctionDeclaration' && decl.id?.name === name) return decl
    if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id.type === 'Identifier' && d.id.name === name && d.init && (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression')) return d.init
      }
    }
  }
  return null
}

/** The innermost function around offset `pos`, and the name it is declared under (null when anonymous). */
export function enclosingFunction(ast: t.File, pos: number): { fn: Fn; name: string | null; isDefault: boolean } | null {
  let best: { fn: Fn; name: string | null; isDefault: boolean } | null = null
  const names = new Map<Node, string>()
  const defaults = new Set<Node>()
  visit(ast.program, (n, parent) => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init) names.set(n.init, n.id.name)
    if (n.type === 'ExportDefaultDeclaration') defaults.add(n.declaration)
    if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') && start(n) <= pos && pos < end(n)) {
      const name = n.type === 'FunctionDeclaration' ? (n.id?.name ?? null) : (names.get(n) ?? null)
      best = { fn: n, name, isDefault: defaults.has(n) || (parent?.type === 'ExportDefaultDeclaration') }
    }
  })
  return best
}

/** Whether a function looks like a component: a capitalised name, or the default export. */
export function isComponent(f: { name: string | null; isDefault: boolean }): boolean {
  return f.isDefault || (!!f.name && /^[A-Z]/.test(f.name))
}

/**
 * Where a hook call goes in a component: the start of its body (or after `afterNode`, a statement of
 * the body), with the body's indentation. Null for an arrow with an expression body.
 */
export function hookSlot(code: string, fn: Fn, afterNode?: Node | null): { at: number; indent: string; first: boolean } | null {
  if (fn.body.type !== 'BlockStatement') return null
  const body = fn.body.body
  if (afterNode) return { at: end(afterNode), indent: indentAt(code, start(afterNode)), first: false }
  const first = body[0]
  if (first) {
    const at = leadingStart(code, first)
    return { at, indent: indentAt(code, at), first: true }
  }
  return null
}

/** Where a node's text starts, with the comments on the lines just above it. */
export function leadingStart(code: string, n: Node): number {
  // Babel's leadingComments, or recast's comments marked leading.
  const any = n as { leadingComments?: Array<{ start?: number }>; comments?: Array<{ start?: number; leading?: boolean }> }
  const c = any.leadingComments?.[0] ?? any.comments?.find((x) => x.leading)
  if (c?.start != null && /^\s*$/.test(code.slice(code.lastIndexOf('\n', c.start - 1) + 1, c.start))) return c.start
  return start(n)
}

/** Top-level statements of a block body that declare `name` (`const name = …`). */
export function declarationIn(fn: Fn, name: string): t.VariableDeclaration | null {
  if (fn.body.type !== 'BlockStatement') return null
  for (const s of fn.body.body) if (s.type === 'VariableDeclaration' && s.declarations.some((d) => patternNames(d.id).includes(name))) return s
  return null
}

/** The module-level declarator of `name`, if any. */
export function moduleDeclarator(ast: t.File, name: string): t.VariableDeclarator | null {
  for (const s of ast.program.body) {
    const decl = s.type === 'ExportNamedDeclaration' ? s.declaration : s
    if (decl?.type !== 'VariableDeclaration') continue
    for (const d of decl.declarations) if (d.id.type === 'Identifier' && d.id.name === name) return d
  }
  return null
}

/** `callee(...)`'s name when `n` is a call of an identifier or a member (`React.useRef` → useRef). */
export function calleeName(n: t.Node | null | undefined): string | null {
  if (!n) return null
  if (n.type === 'TSAsExpression' || n.type === 'TSNonNullExpression') return calleeName(n.expression)
  if (n.type !== 'CallExpression') return null
  const c = n.callee
  if (c.type === 'Identifier') return c.name
  if (c.type === 'MemberExpression' && c.property.type === 'Identifier') return c.property.name
  return null
}

/** Whether the file calls `name(` anywhere. */
export function callsFunction(ast: t.File, name: string): boolean {
  let found = false
  visit(ast.program, (n) => {
    if (found) return false
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === name) found = true
  })
  return found
}
