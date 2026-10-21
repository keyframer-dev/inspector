/**
 * Line diffs for the plan: what each file looks like before and after, as `+` and `-` lines with a few
 * lines of context, like `git diff` without the headers. Files here are small (configs, entries,
 * layouts), so a plain longest-common-subsequence table is fast enough.
 */

export type DiffLine = { op: ' ' | '+' | '-'; text: string }

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  // Common head and tail first: an edit usually touches a few lines in the middle.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  const n = x.length
  const m = y.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const mid: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      mid.push({ op: ' ', text: x[i]! })
      i++
      j++
    } else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) mid.push({ op: '-', text: x[i++]! })
    else mid.push({ op: '+', text: y[j++]! })
  }
  return [...a.slice(0, head).map((text) => ({ op: ' ' as const, text })), ...mid, ...a.slice(a.length - tail).map((text) => ({ op: ' ' as const, text }))]
}

/** The changed lines with `context` lines around them; `…` where unchanged lines are left out. */
export function renderDiff(before: string | null, after: string, context = 2): string {
  if (before === null) return after.replace(/\n$/, '').split('\n').map((l) => `+ ${l}`).join('\n')
  const lines = diffLines(before, after)
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((l, k) => {
    if (l.op === ' ') return
    for (let c = Math.max(0, k - context); c <= Math.min(lines.length - 1, k + context); c++) keep[c] = true
  })
  const out: string[] = []
  let skipped = false
  lines.forEach((l, k) => {
    if (!keep[k]) {
      skipped = true
      return
    }
    if (skipped && out.length) out.push('  …')
    skipped = false
    out.push(`${l.op} ${l.text}`.trimEnd())
  })
  return out.join('\n')
}

/** Lines added and removed, for a summary ("+3 −1"). */
export function diffStat(before: string | null, after: string): { added: number; removed: number } {
  if (before === null) return { added: after.replace(/\n$/, '').split('\n').length, removed: 0 }
  const lines = diffLines(before, after)
  return { added: lines.filter((l) => l.op === '+').length, removed: lines.filter((l) => l.op === '-').length }
}
