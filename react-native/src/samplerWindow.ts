/**
 * Which rows of a UI sampler count, per shared value, while recording.
 *
 * A sampler reads the shared values it was started with. A screen that remounts registers new ones
 * under the same ids, and the old sampler keeps delivering rows (until it is restarted, and rows
 * already on their way after that): those rows are the old instance's and must not land under the id
 * after the new one mounted, or a value's history shows a jump that never happened on screen.
 */

/**
 * The part of a recording one UI sampler's rows count for, per value: from when the instance it
 * samples mounted (`since`) until that id was registered again or went away, or the sampler stopped
 * (`until`). Outside it a row is another instance's under the same id, or the next sampler's.
 */
export type SamplerWindow = { ids: string[]; since: number[]; until: Map<string, number> }

export function samplerWindow(ids: string[], movedAt: ReadonlyMap<string, number>): SamplerWindow {
  return { ids, since: ids.map((id) => movedAt.get(id) ?? -Infinity), until: new Map() }
}

export function inSamplerWindow(w: SamplerWindow, i: number, t: number): boolean {
  return t >= w.since[i]! && t < (w.until.get(w.ids[i]!) ?? Infinity)
}

export function closeSamplerWindow(w: SamplerWindow, t: number): void {
  for (const id of w.ids) if (!w.until.has(id)) w.until.set(id, t)
}
