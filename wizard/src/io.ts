/**
 * Everything the wizard says and asks goes through an Io: the terminal one draws it with clack
 * (ioClack.ts), tests and agents script it. Non-interactive (--yes, or no terminal), a question takes
 * its initial answer, and one without an initial answer throws NeedsAnswer naming the flag to pass.
 */

export type Choice<T> = { value: T; label: string; hint?: string }

export type Spinner = { update(message: string): void; stop(message?: string, ok?: boolean): void }

export type TextOptions = { placeholder?: string; initial?: string; validate?: (value: string) => string | undefined; flag?: string }

export interface Io {
  /** False under --yes or without a terminal: questions take their initial answers. */
  readonly interactive: boolean
  intro(title: string): void
  outro(message: string): void
  /** A section heading: "Babel", "Vitals key". */
  step(message: string): void
  info(message: string): void
  warn(message: string): void
  success(message: string): void
  error(message: string): void
  /** A box: a snippet to paste, a diff, a summary. */
  note(body: string, title?: string): void
  /** `flag`: the command-line flag that answers it, named when it can't be asked. */
  select<T>(message: string, choices: Choice<T>[], opts?: { initial?: T; flag?: string }): Promise<T>
  /** `required`: at least one must be picked (default true); false lets the person pick none. */
  multiselect<T>(message: string, choices: Choice<T>[], opts?: { initial?: T[]; flag?: string; required?: boolean }): Promise<T[]>
  text(message: string, opts?: TextOptions): Promise<string>
  /** Like text, without echoing what is typed. */
  secret(message: string, opts?: TextOptions): Promise<string>
  confirm(message: string, opts?: { initial?: boolean; flag?: string }): Promise<boolean>
  /** `onCancel`: ctrl+c while it spins (the terminal Io stops the spinner, then calls it). */
  spinner(message: string, opts?: { onCancel?: () => void }): Spinner
  /** Opens a URL in the browser; false when it couldn't (the URL is printed either way). */
  open(url: string): Promise<boolean>
}

/** A question that can't be asked (non-interactive) and has no default. */
export class NeedsAnswer extends Error {
  constructor(
    readonly question: string,
    readonly flag?: string,
  ) {
    super(flag ? `${question} (pass ${flag})` : question)
    this.name = 'NeedsAnswer'
  }
}

/** The person stopped the wizard (ctrl+c, escape). */
export class Cancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'Cancelled'
  }
}

export type Said = { kind: 'intro' | 'outro' | 'step' | 'info' | 'warn' | 'success' | 'error' | 'note' | 'spinner' | 'open'; text: string }

/**
 * An Io for tests and scripts: each question takes the next answer from `answers` (by its message's
 * first matching key, a substring or a RegExp source), else its initial answer, else NeedsAnswer.
 * Everything said is kept in `said`, and every question asked in `asked`.
 */
export function scriptedIo(answers: Array<[string | RegExp, unknown]> = [], opts: { interactive?: boolean; open?: (url: string) => boolean } = {}) {
  const queue = [...answers]
  const said: Said[] = []
  const asked: string[] = []
  const take = <T>(message: string, initial: T | undefined, flag?: string): T => {
    asked.push(message)
    const i = queue.findIndex(([k]) => (typeof k === 'string' ? message.includes(k) : k.test(message)))
    if (i >= 0) return queue.splice(i, 1)[0]![1] as T
    if (initial !== undefined) return initial
    throw new NeedsAnswer(message, flag)
  }
  const say = (kind: Said['kind']) => (text: string) => void said.push({ kind, text })
  const io: Io & { said: Said[]; asked: string[]; unused(): Array<[string | RegExp, unknown]> } = {
    interactive: opts.interactive ?? true,
    said,
    asked,
    unused: () => queue,
    intro: say('intro'),
    outro: say('outro'),
    step: say('step'),
    info: say('info'),
    warn: say('warn'),
    success: say('success'),
    error: say('error'),
    note: (body, title) => void said.push({ kind: 'note', text: title ? `${title}\n${body}` : body }),
    select: async (message, _choices, o) => take(message, o?.initial, o?.flag),
    multiselect: async (message, _choices, o) => take(message, o?.initial, o?.flag),
    text: async (message, o) => {
      const v = take<string>(message, o?.initial, o?.flag)
      const bad = o?.validate?.(v)
      if (bad) throw new Error(`${message}: ${bad}`)
      return v
    },
    secret: async (message, o) => io.text(message, o),
    confirm: async (message, o) => take(message, o?.initial, o?.flag),
    spinner: (message) => {
      said.push({ kind: 'spinner', text: message })
      return { update: (m) => void said.push({ kind: 'spinner', text: m }), stop: (m) => void (m && said.push({ kind: 'spinner', text: m })) }
    },
    open: async (url) => {
      said.push({ kind: 'open', text: url })
      return opts.open?.(url) ?? true
    },
  }
  return io
}
