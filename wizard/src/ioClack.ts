/**
 * The terminal Io, drawn with @clack/prompts. ctrl+c (or escape) in a question throws Cancelled.
 * Non-interactive (--yes, or stdin or stdout not a terminal), questions take their initial answers,
 * and a question without one throws NeedsAnswer naming the flag that answers it.
 */
import { spawn } from 'node:child_process'
import { styleText } from 'node:util'
import * as p from '@clack/prompts'
import { Cancelled, NeedsAnswer, type Choice, type Io, type Spinner, type TextOptions } from './io'

type Color = 'green' | 'red' | 'dim' | 'cyan' | 'bold' | 'yellow' | 'gray'

export function color(c: Color, s: string, enabled = colorsOn()): string {
  return enabled ? styleText(c, s) : s
}

function colorsOn(): boolean {
  return !process.env.NO_COLOR && !!process.stdout.isTTY
}

/** A diff's lines in green and red. */
export function colorDiff(body: string): string {
  return body
    .split('\n')
    .map((l) => (l.startsWith('+') ? color('green', l) : l.startsWith('-') ? color('red', l) : color('dim', l)))
    .join('\n')
}

/**
 * Wraps at spaces to `width` columns, so a long line breaks between words instead of mid-word at the
 * terminal's edge (clack draws its boxes to the terminal's width, not its log lines). A word longer
 * than the width (a URL) stays whole.
 */
export function wrapWords(text: string, width: number): string {
  if (width < 20) return text
  return text
    .split('\n')
    .map((line) => {
      const out: string[] = []
      let cur = ''
      for (const word of line.split(' ')) {
        if (cur && cur.length + 1 + word.length > width) {
          out.push(cur)
          cur = word
        } else cur = cur ? `${cur} ${word}` : word
      }
      out.push(cur)
      return out.join('\n')
    })
    .join('\n')
}

function isDiff(body: string): boolean {
  const lines = body.split('\n').filter((l) => l !== '')
  return lines.length > 0 && lines.every((l) => /^([+\- ] |[+\- ]$|  …)/.test(l)) && lines.some((l) => l.startsWith('+') || l.startsWith('-'))
}

export type ClackIoOptions = { yes: boolean; stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream; platform?: NodeJS.Platform }

export function clackIo(opts: ClackIoOptions): Io {
  const stdin = opts.stdin ?? process.stdin
  const stdout = opts.stdout ?? process.stdout
  const interactive = !opts.yes && !!stdin.isTTY && !!stdout.isTTY
  const platform = opts.platform ?? process.platform

  const answer = <T>(v: T | symbol): T => {
    if (p.isCancel(v)) throw new Cancelled()
    return v as T
  }
  const initialOr = <T>(message: string, initial: T | undefined, flag?: string): T => {
    if (initial === undefined) throw new NeedsAnswer(message, flag)
    p.log.step(`${fit(message)} ${color('dim', String(Array.isArray(initial) ? initial.join(', ') : initial))}`)
    return initial
  }
  // clack's gutter ("│  ", "◆  ") takes 3 columns.
  const fit = (s: string) => wrapWords(s, (stdout.columns || 100) - 3)
  const options = <T>(choices: Choice<T>[]) => choices.map((c) => ({ value: c.value, label: c.label, hint: c.hint })) as never

  const io: Io = {
    interactive,
    intro: (title) => p.intro(color('bold', title)),
    outro: (message) => p.outro(message),
    step: (message) => p.log.step(color('bold', fit(message))),
    info: (message) => p.log.info(fit(message)),
    warn: (message) => p.log.warn(fit(message)),
    success: (message) => p.log.success(fit(message)),
    error: (message) => p.log.error(fit(message)),
    // A diff (every line `+ `, `- `, `  ` or `…`) in green and red; anything else as it is.
    note: (body, title) => p.note(isDiff(body) ? colorDiff(body) : body, title, { format: (l) => l }),
    async select<T>(message: string, choices: Choice<T>[], o?: { initial?: T; flag?: string }) {
      if (!interactive) return initialOr(message, o?.initial, o?.flag)
      return answer<T>(await p.select<T>({ message, options: options(choices), initialValue: o?.initial }))
    },
    async multiselect<T>(message: string, choices: Choice<T>[], o?: { initial?: T[]; flag?: string; required?: boolean }) {
      if (!interactive) return initialOr(message, o?.initial, o?.flag)
      return answer<T[]>(await p.multiselect<T>({ message, options: options(choices), initialValues: o?.initial, required: o?.required ?? true }))
    },
    async text(message: string, o?: TextOptions) {
      if (!interactive) {
        const v = initialOr(message, o?.initial, o?.flag)
        const bad = o?.validate?.(v)
        if (bad) throw new NeedsAnswer(`${message}: ${bad}`, o?.flag)
        return v
      }
      return answer<string>(await p.text({ message, placeholder: o?.placeholder, initialValue: o?.initial, validate: o?.validate ? (v) => o.validate!(v ?? '') : undefined }))
    },
    async secret(message: string, o?: TextOptions) {
      if (!interactive) return io.text(message, o)
      return answer<string>(await p.password({ message, validate: o?.validate ? (v) => o.validate!(v ?? '') : undefined }))
    },
    async confirm(message: string, o?: { initial?: boolean; flag?: string }) {
      if (!interactive) return initialOr(message, o?.initial, o?.flag)
      return answer<boolean>(await p.confirm({ message, initialValue: o?.initial ?? true }))
    },
    spinner(message: string, o?: { onCancel?: () => void }): Spinner {
      if (!interactive) {
        // No terminal to redraw: a line when it starts and one when it stops.
        p.log.step(fit(message))
        return { update: () => undefined, stop: (m, ok = true) => void (m && (ok ? p.log.success(fit(m)) : p.log.warn(fit(m)))) }
      }
      // clack takes over ctrl+c while it spins: without a handler of the step's own, stop the wizard
      // (every file is written whole or not at all, so there is nothing to undo).
      const s = p.spinner({
        onCancel:
          o?.onCancel ??
          (() => {
            p.cancel('Stopped.')
            process.exit(130)
          }),
      })
      s.start(message)
      return {
        update: (m) => s.message(m),
        // A spinner's last line has no gutter of its own past the first row: give its wrapped rows clack's.
        stop: (m, ok = true) => {
          const text = m && fit(m).replace(/\n/g, `\n${color('gray', '│')}  `)
          return ok ? s.stop(text) : s.error(text)
        },
      }
    },
    async open(url: string) {
      p.log.info(`Open ${color('cyan', url)}`)
      return openUrl(url, platform)
    },
  }
  return io
}

/** `open`, `xdg-open` or `start`; false when none of them ran. */
export function openUrl(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const [cmd, args] = platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]]
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true })
      child.once('error', () => resolve(false))
      child.once('spawn', () => {
        child.unref()
        resolve(true)
      })
    } catch {
      resolve(false)
    }
  })
}
