/**
 * The wizard as an animated terminal, for the top of the README: the site's MCP terminal
 * (apps/web/src/components/McpTerminal.tsx) drawn as an SVG, since a README can show an SVG but run no
 * script. The command types itself, the wizard's own questions come in with the cursor moving through
 * the options, answered questions collapse to their answer the way clack collapses them, spinners turn,
 * and the window scrolls as the transcript grows. It plays once and settles on the finished transcript,
 * which is also what reduced motion (and anything that doesn't animate SVG) shows.
 *
 *   bun scripts/terminal-svg.ts      →   assets/wizard-terminal.svg, and the docs' copy for the wizard's page
 */
import { writeFileSync } from 'node:fs'

/** McpTerminal's palette, by value. */
const C = { bg: '#0f0e18', line: '#2c2b3d', text: '#b8b7c4', bright: '#f0eff4', faint: '#58576a', accent: '#e8622c', ok: '#5fc4a0', del: '#d95040', amber: '#d4a530' }

const W = 860
const H = 520
const FONT = 14.5
const ROW = 24
const CHAR = FONT * 0.6
const PAD = { x: 26, top: 66 }
const VIEW = H - PAD.top - 18

// ---------------------------------------------------------------------------
// The script: what appears, when (seconds)

type Span = { t: string; c?: keyof typeof C; b?: boolean }
type Option = { label: string; hint?: string }
type Item =
  | { kind: 'line'; at: number; gutter: Span; spans: Span[] }
  | { kind: 'prompt'; at: number; q: string; options: Option[]; multi?: boolean; cursor: Array<[number, number]>; ticked?: Array<[number, number[]]>; submit: number; answer: string }
  | { kind: 'confirm'; at: number; q: string; submit: number }
  | { kind: 'spin'; at: number; label: string; done: number; result: string }

const COMMAND = 'npx @keyframerdev/wizard'
const TYPE_AT = 0.4
const CPS = 20
const T0 = TYPE_AT + COMMAND.length / CPS + 0.5

const bar: Span = { t: '│', c: 'line' }
const ok: Span = { t: '◇', c: 'ok' }
const done: Span = { t: '◆', c: 'ok' }
const s = (t: string, c?: keyof typeof C, b?: boolean): Span => ({ t, c, b })

const ITEMS: Item[] = [
  { kind: 'line', at: T0, gutter: s('┌', 'accent'), spans: [s('Keyframer setup', 'bright', true)] },
  { kind: 'line', at: T0 + 0.3, gutter: ok, spans: [s('Your app', 'bright', true), s('  Expo SDK 57 · expo-router · npm', 'faint')] },
  {
    kind: 'prompt',
    at: T0 + 0.8,
    q: 'What do you want to set up?',
    multi: true,
    options: [
      { label: 'Inspector', hint: 'a motion debugger for development' },
      { label: 'Motion Vitals', hint: 'slow frames and janky animations from production' },
    ],
    cursor: [[0, 0], [T0 + 1.7, 1]],
    ticked: [[0, [0]], [T0 + 2.3, [0, 1]]],
    submit: T0 + 3.0,
    answer: 'Inspector, Motion Vitals',
  },
  {
    kind: 'prompt',
    at: T0 + 3.4,
    q: 'Where do you want to see the Inspector?',
    options: [
      { label: "Expo's dev tools", hint: 'shift+m in Metro, no account' },
      { label: 'The Keyframer Inspector desktop app' },
      { label: 'The Keyframer editor', hint: 'with a pairing code' },
    ],
    cursor: [[0, 0], [T0 + 4.2, 1], [T0 + 4.7, 0]],
    submit: T0 + 5.2,
    answer: "Expo's dev tools",
  },
  {
    kind: 'prompt',
    at: T0 + 5.6,
    q: 'How do you want to get the Motion Vitals key?',
    options: [{ label: 'Sign in with the browser', hint: 'picks or creates the project for you' }, { label: 'Paste a key from the dashboard' }],
    cursor: [[0, 0]],
    submit: T0 + 6.5,
    answer: 'Sign in with the browser',
  },
  { kind: 'spin', at: T0 + 6.8, label: 'Waiting for you to approve the code in the browser', done: T0 + 8.2, result: 'Field key for my-app: kfp_live_7Hq2…' },
  { kind: 'line', at: T0 + 8.6, gutter: ok, spans: [s('babel.config.js', 'bright'), s('  new file', 'faint')] },
  { kind: 'line', at: T0 + 8.75, gutter: bar, spans: [s("+ plugins: [...(dev ? ['@keyframerdev/inspector/babel'] : []),", 'ok')] },
  { kind: 'line', at: T0 + 8.85, gutter: bar, spans: [s("+   '@keyframerdev/vitals/babel'],", 'ok')] },
  { kind: 'confirm', at: T0 + 9.3, q: 'Create babel.config.js?', submit: T0 + 10.0 },
  { kind: 'line', at: T0 + 10.3, gutter: ok, spans: [s('src/app/_layout.tsx', 'bright'), s('  +3 -1', 'faint')] },
  { kind: 'line', at: T0 + 10.45, gutter: bar, spans: [s("+ import { useKeyframer } from '../keyframer';", 'ok')] },
  { kind: 'line', at: T0 + 10.55, gutter: bar, spans: [s('+   const navigationRef = useNavigationContainerRef();', 'ok')] },
  { kind: 'line', at: T0 + 10.65, gutter: bar, spans: [s('+   useKeyframer(navigationRef);', 'ok')] },
  { kind: 'confirm', at: T0 + 11.1, q: 'Change src/app/_layout.tsx?', submit: T0 + 11.8 },
  { kind: 'spin', at: T0 + 12.1, label: 'Installing @keyframerdev/inspector, @keyframerdev/vitals', done: T0 + 13.7, result: 'Installed @keyframerdev/inspector, @keyframerdev/vitals' },
  { kind: 'line', at: T0 + 14.0, gutter: ok, spans: [s('Check that it works', 'bright', true), s('  start the app: npx expo start', 'faint')] },
  { kind: 'spin', at: T0 + 14.4, label: 'Waiting for my-app to say hello', done: T0 + 15.8, result: 'Inspector: hello from my-app on iPhone 16 Pro' },
  { kind: 'spin', at: T0 + 16.0, label: 'Waiting for the first Motion Vitals session', done: T0 + 17.0, result: 'Motion Vitals: the first session arrived' },
  { kind: 'line', at: T0 + 17.4, gutter: s('└', 'faint'), spans: [s('Keyframer is set up.', 'bright')] },
]
const END = T0 + 17.6

// ---------------------------------------------------------------------------
// Layout: every item at its settled height; an open prompt draws its options into the rows below it
// before anything else arrives there.

const settled = (it: Item) => (it.kind === 'prompt' || it.kind === 'confirm' ? 2 : 1)
const open = (it: Item) => (it.kind === 'prompt' ? 1 + it.options.length : settled(it))
const startRow = 1.5 // the typed command, and a gap
const rowOf: number[] = []
{
  let r = startRow
  for (const it of ITEMS) {
    rowOf.push(r)
    r += settled(it)
  }
}
const submitOf = (it: Item) => (it.kind === 'prompt' || it.kind === 'confirm' ? it.submit : null)

/** Rows in use at time t: the last item that has arrived, open or settled. */
function bottomAt(t: number): number {
  let bottom = 1
  ITEMS.forEach((it, i) => {
    if (t < it.at) return
    const sub = submitOf(it)
    bottom = Math.max(bottom, rowOf[i]! + (sub !== null && t < sub ? open(it) : settled(it)))
  })
  return bottom
}
const scrollAt = (t: number) => Math.max(0, bottomAt(t) * ROW - VIEW + 6)

// ---------------------------------------------------------------------------
// CSS: one animation per thing that changes, all over the same timeline, played once

const pct = (t: number) => `${((Math.max(0, Math.min(END, t)) / END) * 100).toFixed(3)}%`
let n = 0
const css: string[] = []
/** A class shown over [from, to) (to = Infinity: shown to the end). Its settled state is its base style. */
function window(from: number, to = Infinity): string {
  const id = `w${n++}`
  const finalShown = to === Infinity
  const k = finalShown
    ? `0%,${pct(from - 0.001)}{opacity:0}${pct(from + 0.12)},100%{opacity:1}`
    : `0%,${pct(from - 0.001)}{opacity:0}${pct(from + 0.08)},${pct(to - 0.001)}{opacity:1}${pct(to)},100%{opacity:0}`
  css.push(`.${id}{opacity:${finalShown ? 1 : 0};animation:${id} ${END}s linear 1 both}@keyframes ${id}{${k}}`)
  return id
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const y = (row: number) => PAD.top + row * ROW + ROW * 0.72
const xText = PAD.x + 3 * CHAR

function spans(list: Span[]): string {
  return list.map((p) => `<tspan fill="${C[p.c ?? 'text']}"${p.b ? ' font-weight="600"' : ''}>${esc(p.t)}</tspan>`).join('')
}
function text(row: number, inner: string, cls?: string, x = xText): string {
  return `<text x="${x}" y="${y(row)}"${cls ? ` class="${cls}"` : ''}>${inner}</text>`
}
const gutter = (row: number, g: Span, cls?: string) => text(row, spans([g]), cls, PAD.x)

const out: string[] = []

// The command, typed one character at a time; the drawn cursor rides along, then goes.
{
  out.push(text(0, `<tspan fill="${C.faint}">›</tspan>`, undefined, PAD.x))
  const chars = [...COMMAND].map((ch, i) => `<tspan class="${window(TYPE_AT + i / CPS)}" fill="${C.text}">${esc(ch)}</tspan>`).join('')
  out.push(text(0, chars, undefined, PAD.x + 2 * CHAR))
  const id = `cur${n++}`
  const steps = COMMAND.length
  css.push(
    `.${id}{opacity:0;animation:${id}m ${END}s steps(1) 1 both}@keyframes ${id}m{` +
      Array.from({ length: steps + 1 }, (_, i) => `${pct(TYPE_AT + i / CPS)}{opacity:1;transform:translateX(${(i * CHAR).toFixed(2)}px)}`).join('') +
      `${pct(T0 - 0.2)}{opacity:0;transform:translateX(${(steps * CHAR).toFixed(2)}px)}100%{opacity:0}}`,
  )
  out.push(`<rect class="${id}" x="${PAD.x + 2 * CHAR + 1}" y="${y(0) - FONT * 0.82}" width="${CHAR * 0.9}" height="${FONT * 1.05}" fill="${C.accent}"/>`)
}

ITEMS.forEach((it, i) => {
  const r = rowOf[i]!
  if (it.kind === 'line') {
    const cls = window(it.at)
    out.push(gutter(r, it.gutter, cls), text(r, spans(it.spans), cls))
    return
  }
  if (it.kind === 'spin') {
    const spinning = window(it.at, it.done)
    const after = window(it.done)
    // The spinner's four frames, turning while it waits.
    const frames = ['◒', '◐', '◓', '◑']
    const turn = `spin${n++}`
    css.push(`@keyframes ${turn}{0%,24.9%{opacity:1}25%,100%{opacity:0}}`)
    out.push(
      `<g class="${spinning}">` +
        frames.map((f, k) => `<text x="${PAD.x}" y="${y(r)}" fill="${C.accent}" style="animation:${turn} 0.6s linear ${(k * 0.15).toFixed(2)}s infinite;opacity:0">${f}</text>`).join('') +
        text(r, spans([s(`${it.label}…`, 'bright')])) +
        `</g>`,
    )
    out.push(gutter(r, done, after), text(r, spans([s(it.result), s('  ✓', 'ok')]), after))
    return
  }
  if (it.kind === 'confirm') {
    const asking = window(it.at, it.submit)
    const answered = window(it.submit)
    const arrived = window(it.at)
    out.push(gutter(r, s('◆', 'accent'), asking), gutter(r, ok, answered), text(r, spans([s(it.q, 'bright')]), arrived))
    const yesW = 3 * CHAR + 10
    out.push(`<g class="${asking}"><text x="${PAD.x}" y="${y(r + 1)}" fill="${C.accent}">│</text><rect x="${xText + 2 * CHAR - 5}" y="${y(r + 1) - FONT * 0.95}" width="${yesW}" height="${FONT * 1.35}" rx="4" fill="${C.accent}" fill-opacity="0.16"/>${text(r + 1, spans([s('● ', 'ok'), s('Yes', 'bright'), s(' / ○ No', 'faint')]))}</g>`)
    out.push(gutter(r + 1, bar, answered), text(r + 1, spans([s('Yes', 'faint')]), answered))
    return
  }
  // A prompt: the question, its options with a highlighted cursor while it is open, then its answer.
  const asking = window(it.at, it.submit)
  const answered = window(it.submit)
  const arrived = window(it.at)
  out.push(gutter(r, s('◆', 'accent'), asking), gutter(r, ok, answered), text(r, spans([s(it.q, 'bright')]), arrived))
  const optsCls = asking
  // Where the cursor rests, and from when to when: each option highlights its own mark and label then.
  const rests = it.cursor.map(([at, idx], j) => [at === 0 ? it.at : at, Math.min(it.cursor[j + 1]?.[0] ?? Infinity, it.submit), idx] as const)
  const parts: string[] = [`<g class="${optsCls}">`]
  for (const [from, to, idx] of rests) {
    const o = it.options[idx]!
    parts.push(`<rect class="${window(from, to)}" x="${xText - 6}" y="${y(r + 1 + idx) - FONT * 0.95}" width="${(o.label.length + 2) * CHAR + 12}" height="${FONT * 1.35}" rx="4" fill="${C.accent}" fill-opacity="0.15"/>`)
  }
  it.options.forEach((o, k) => {
    const row = r + 1 + k
    parts.push(`<text x="${PAD.x}" y="${y(row)}" fill="${C.accent}">│</text>`)
    if (it.multi) {
      const tickedAt = (it.ticked ?? []).find(([, set]) => set.includes(k))?.[0] ?? Infinity
      if (tickedAt === 0) parts.push(text(row, spans([s('◼', 'ok')])))
      else {
        parts.push(text(row, spans([s('◻', 'faint')]), window(it.at, tickedAt)))
        parts.push(text(row, spans([s('◼', 'ok')]), window(tickedAt)))
      }
    } else {
      // The dot follows the cursor.
      for (const [from, to, idx] of rests) parts.push(text(row, spans([s(idx === k ? '●' : '○', idx === k ? 'ok' : 'faint')]), window(from, to)))
    }
    parts.push(text(row, spans([s(o.label, 'bright'), ...(o.hint ? [s(`  ${o.hint}`, 'faint')] : [])]), undefined, xText + 2 * CHAR))
  })
  parts.push('</g>')
  out.push(parts.join(''))
  out.push(gutter(r + 1, bar, answered), text(r + 1, spans([s(it.answer, 'faint')]), answered))
})

// Scrolling: the transcript moves up whenever its bottom row would leave the window.
{
  const times = [0, ...ITEMS.flatMap((it) => [it.at, ...(submitOf(it) !== null ? [submitOf(it)!] : [])])].sort((a, b) => a - b)
  const keys: string[] = []
  let last = 0
  for (const t of times) {
    const v = scrollAt(t + 0.01)
    if (v === last) continue
    // Hold where it was until the row arrives, then glide up in 0.3 s.
    keys.push(`${pct(t)}{transform:translateY(${(-last).toFixed(1)}px)}`, `${pct(t + 0.3)}{transform:translateY(${(-v).toFixed(1)}px)}`)
    last = v
  }
  css.push(`.scroll{transform:translateY(${(-scrollAt(END)).toFixed(1)}px);animation:scroll ${END}s cubic-bezier(.2,.8,.2,1) 1 both}@keyframes scroll{0%{transform:translateY(0)}${keys.join('')}100%{transform:translateY(${(-scrollAt(END)).toFixed(1)}px)}}`)
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="npx @keyframerdev/wizard: it asks what to set up, where to see the Inspector and how to get the Motion Vitals key, shows each change as a diff, installs, then waits for the app's first message">
<style>
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;font-size:${FONT}px;white-space:pre}
${css.join('\n')}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
<rect x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}" rx="14" fill="${C.bg}" stroke="${C.line}" stroke-width="1.5"/>
<circle cx="26" cy="24" r="6" fill="#d95040"/><circle cx="46" cy="24" r="6" fill="#d4a530"/><circle cx="66" cy="24" r="6" fill="#5fc4a0"/>
<line x1="0.75" y1="47" x2="${W - 0.75}" y2="47" stroke="${C.line}" stroke-width="1.5"/>
<clipPath id="body"><rect x="0" y="48" width="${W}" height="${H - 49}" rx="0"/></clipPath>
<g clip-path="url(#body)"><g class="scroll">
${out.join('\n')}
</g></g>
</svg>
`
writeFileSync(new URL('../assets/wizard-terminal.svg', import.meta.url), svg)
// The same file beside the wizard's docs page (docs/getting-started/wizard.md shows it).
writeFileSync(new URL('../../../public/root/docs/getting-started/wizard-terminal.svg', import.meta.url), svg)
console.log(`assets/wizard-terminal.svg  ${(svg.length / 1024).toFixed(1)} KB, ${END.toFixed(1)} s`)
