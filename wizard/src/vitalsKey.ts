/**
 * The Motion Vitals ingest key (kfp_live_…) for this app: --key, pasted from the dashboard, or found
 * by signing in through the browser (a workspace and a project picked or created, its key read or
 * created), as the person chooses.
 *
 * Only the project's field key is ever read or shown: it is public (it ships in the app). The secret
 * kinds (kft_ CI uploads, kfw_ workspace reads) are refused when pasted and never asked for.
 */
import { signIn } from './account'
import { NeedsAnswer, type Choice, type Io } from './io'
import { requestJson, trimUrl, type Fetch } from './http'
import type { Project, VitalsKey, WizardOptions } from './types'

export type VitalsKeyOptions = { project: Project; options: WizardOptions; io: Io; fetch?: typeof fetch; signIn?: typeof signIn }

export const VITALS_ENDPOINT = 'https://vitals.keyframer.dev'

/** apps/api/src/vitals/keys.ts: a field key is kfp_live_ and 24 base62 characters. */
export const FIELD_KEY_PATTERN = /^kfp_live_[0-9A-Za-z]{24}$/

/** Why this is not a field key, or undefined when it looks like one. Never repeats a secret back. */
export function checkFieldKey(value: string): string | undefined {
  const v = value.trim()
  if (!v) return 'Paste the key: it starts with kfp_live_.'
  if (v.startsWith('kft_') || v.startsWith('kfw_')) return "That's a secret key (for CI or reading data), not the app's. The app needs the field key, kfp_live_…"
  if (v.startsWith('kf_')) return "That's a Keyframer API key. The app needs the project's field key, kfp_live_…"
  if (!FIELD_KEY_PATTERN.test(v)) return 'A field key is kfp_live_ and 24 letters and digits. Copy it again from the Setup page.'
  return undefined
}

type KeyState = 'known' | 'unknown' | 'deleted' | 'unreachable'

/** What the ingest Worker says about a field key, through the config route every SDK reads. */
export async function fieldKeyState(endpoint: string, key: string, fetchImpl: Fetch = fetch): Promise<KeyState> {
  const res = await requestJson<unknown>(fetchImpl, `${trimUrl(endpoint)}/v1/config/${encodeURIComponent(key)}`)
  if (res.status === 200) return 'known'
  if (res.status === 401) return 'unknown'
  if (res.status === 410) return 'deleted'
  return 'unreachable'
}

// What the API's Vitals routes return, as much as the wizard reads.
type Workspace = { id: string; kind: 'personal' | 'team'; name: string; role: 'owner' | 'admin' | 'member' | 'viewer'; projectCount: number }
type ProjectRow = { id: string; workspaceId: string; code: string; name: string; platform: string; frameworkLabel?: string }
type KeyRow = { id: string; scope: string; revokedAt: string | null; secret?: string }

const NEW = '__new__'

export async function getVitalsKey(opts: VitalsKeyOptions): Promise<VitalsKey> {
  const { io, options } = opts
  const fetchImpl = opts.fetch ?? fetch
  const endpoint = options.vitalsEndpoint ?? VITALS_ENDPOINT
  const dashboard = `${trimUrl(options.app)}/app/vitals`

  if (options.vitalsKey) {
    const key = options.vitalsKey.trim()
    const bad = checkFieldKey(key)
    if (bad) throw new Error(`--key: ${bad}`)
    const state = await fieldKeyState(endpoint, key, fetchImpl)
    if (state === 'deleted') throw new Error("--key: this key's project was deleted. Use the key of a live project.")
    if (state === 'unknown') io.warn("keyframer.dev doesn't know this key. A key made in the last minute may not have reached every region yet; a revoked one never will.")
    return { key, projectId: null, workspaceId: null, token: null }
  }

  // Unattended (--yes, an agent, CI) nobody may be there to approve a sign-in: only an explicit
  // --auth browser tries it, anything else needs the key.
  if (!options.vitalsAuth && !io.interactive) throw new NeedsAnswer('The Motion Vitals field key (or --auth browser, to sign in)', '--key')
  const auth =
    options.vitalsAuth ??
    (await io.select(
      'How do you want to get the Motion Vitals key?',
      [
        { value: 'browser' as const, label: 'Sign in with the browser', hint: 'picks or creates the project for you' },
        { value: 'paste' as const, label: 'Paste a key from the dashboard', hint: "the project's Setup page" },
      ],
      { initial: 'browser', flag: '--auth' },
    ))
  if (auth === 'paste') return pasteKey(io, endpoint, dashboard, fetchImpl, null)

  const token = await (opts.signIn ?? signIn)({ api: options.api, app: options.app, io, fetch: fetchImpl, flag: '--key' })
  return browserKey(opts, token, endpoint, dashboard, fetchImpl)
}

/** Asks for the key until one looks right and the server does not refuse it. */
async function pasteKey(io: Io, endpoint: string, dashboard: string, fetchImpl: Fetch, token: string | null): Promise<VitalsKey> {
  if (!io.interactive) throw new NeedsAnswer('The Motion Vitals field key', '--key')
  io.info(`The field key is on your project's Setup page: ${dashboard}`)
  await io.open(dashboard)
  for (;;) {
    const key = (await io.text('Paste the field key', { placeholder: 'kfp_live_…', validate: checkFieldKey, flag: '--key' })).trim()
    const state = await fieldKeyState(endpoint, key, fetchImpl)
    if (state === 'deleted') {
      io.error("This key's project was deleted. Paste the key of a live project.")
      continue
    }
    if (state === 'unknown') {
      io.warn("keyframer.dev doesn't know this key. A key made in the last minute may not have reached every region yet; a revoked one never will.")
      if (!(await io.confirm('Use it anyway?', { initial: false }))) continue
    }
    if (state === 'unreachable') io.warn(`Couldn't reach ${endpoint} to check the key. Using it as it is.`)
    return { key, projectId: null, workspaceId: null, token }
  }
}

async function browserKey(opts: VitalsKeyOptions, token: string, endpoint: string, dashboard: string, fetchImpl: Fetch): Promise<VitalsKey> {
  const { io, options, project } = opts
  const base = `${trimUrl(options.api)}/api/vitals`
  const call = <T>(path: string, init: { method?: string; body?: unknown } = {}) => requestJson<T>(fetchImpl, `${base}${path}`, { ...init, token })
  const failed = (what: string, r: { status: number; error: string | null }) =>
    new Error(r.status === 0 ? `Couldn't reach ${options.api} to ${what} (${r.error}).` : `Couldn't ${what}: ${r.error ?? r.status}.`)

  // Before launch, Motion Vitals is open to Keyframer admins and accepted beta applicants only.
  const access = await call<{ allowed: boolean }>('/access')
  if (!access.data) throw failed('check your Motion Vitals access', access)
  if (!access.data.allowed) {
    io.warn("Motion Vitals is in a private beta, and this account isn't in it yet.")
    io.info(`Apply at ${trimUrl(options.app)}/vitals#apply. If a teammate shares their project's field key with you, you can paste it now.`)
    return pasteKey(io, endpoint, dashboard, fetchImpl, token)
  }

  // A personal workspace is made on the first visit, so the list is rarely empty.
  const listed = await call<Workspace[]>('/workspaces')
  if (!listed.data) throw failed('list your workspaces', listed)
  const usable = listed.data.filter((w) => w.role !== 'viewer')
  const wsChoices: Choice<string>[] = [
    ...listed.data.map((w) => ({ value: w.id, label: w.name, hint: w.role === 'viewer' ? 'viewer: can\'t add projects' : `${w.kind === 'personal' ? 'personal' : 'team'}, ${w.projectCount} ${w.projectCount === 1 ? 'project' : 'projects'}` })),
    { value: NEW, label: 'Create a new workspace' },
  ]
  let wsId = listed.data.length ? await io.select('Which workspace is this app in?', wsChoices, { initial: usable[0]?.id ?? NEW }) : NEW
  if (wsId === NEW) {
    const name = await io.text('Name the new workspace', { initial: `${project.name} team`, validate: (v) => (v.trim() ? undefined : 'Give it a name.') })
    const made = await call<Workspace>('/workspaces', { method: 'POST', body: { name: name.trim().slice(0, 80) } })
    if (!made.data) throw failed('create the workspace', made)
    io.success(`Created the workspace ${made.data.name}`)
    wsId = made.data.id
  }

  const projects = await call<ProjectRow[]>(`/workspaces/${encodeURIComponent(wsId)}/projects`)
  if (!projects.data) throw failed('list the projects', projects)
  const appName = project.name.trim().slice(0, 80) || 'My app'
  const match = projects.data.find((p) => p.name.toLowerCase() === appName.toLowerCase() && p.platform === 'react-native')
  const projectChoices: Choice<string>[] = [
    ...projects.data.map((p) => ({ value: p.id, label: p.name, hint: [p.code, p.frameworkLabel].filter(Boolean).join(', ') })),
    { value: NEW, label: `Create a project named ${appName}` },
  ]
  let chosen: ProjectRow | undefined
  const projectId = projects.data.length ? await io.select('Which project should this app report to?', projectChoices, { initial: match?.id ?? NEW }) : NEW
  if (projectId === NEW) {
    const made = await call<ProjectRow>(`/workspaces/${encodeURIComponent(wsId)}/projects`, { method: 'POST', body: { name: appName, platform: 'react-native' } })
    if (!made.data) throw failed('create the project', made)
    chosen = made.data
    io.success(`Created the project ${chosen.name} (${chosen.code})`)
  } else chosen = projects.data.find((p) => p.id === projectId)
  if (!chosen) throw new Error('That project is gone. Run the wizard again.')
  const setupPage = `${dashboard}/${encodeURIComponent(wsId)}/${encodeURIComponent(chosen.id)}/setup`

  // Field keys are public and the API returns them whole; a project is made with one.
  const keys = await call<KeyRow[]>(`/projects/${encodeURIComponent(chosen.id)}/keys`)
  if (keys.status === 403) {
    io.warn(`Your role in this workspace can't read its keys. Ask an admin for the field key on ${setupPage}`)
    return pasteKey(io, endpoint, setupPage, fetchImpl, token)
  }
  if (!keys.data) throw failed('read the project keys', keys)
  let key = keys.data.find((k) => k.scope === 'field_ingest' && !k.revokedAt && k.secret && FIELD_KEY_PATTERN.test(k.secret))?.secret
  if (!key) {
    const made = await call<KeyRow>(`/projects/${encodeURIComponent(chosen.id)}/keys`, { method: 'POST', body: { scope: 'field_ingest' } })
    if (made.status === 403) {
      io.warn(`Only owners and admins can make a field key. Ask one to open ${setupPage}, then paste the key it shows.`)
      return pasteKey(io, endpoint, setupPage, fetchImpl, token)
    }
    if (!made.data?.secret) throw failed('create a field key', made)
    key = made.data.secret
  }
  io.success(`Field key for ${chosen.name}: ${key}`)
  return { key, projectId: chosen.id, workspaceId: wsId, token }
}
