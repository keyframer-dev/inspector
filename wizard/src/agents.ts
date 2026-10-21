/**
 * The agent integrations: the Inspector's MCP server in Claude Code's and Cursor's MCP config, so an
 * agent can record and read the app.
 *
 * The config is project-scoped (Claude Code's .mcp.json, Cursor's .cursor/mcp.json), merged into what
 * is there: other servers are kept as they are, and a keyframer-inspector entry already there is left
 * alone. The server runs the way the agent plugin runs it (public/root/plugins/keyframer-inspector),
 * `npx -y @keyframerdev/inspector mcp`, which uses the project's own copy, with the flag for where the
 * app is seen: --relay for the desktop app, --metro or --code when the wizard knows them.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Choice, Io } from './io'
import type { AgentTool, InspectorView, Project, WizardOptions } from './types'

export const SERVER_NAME = 'keyframer-inspector'

/** The file system the step touches, injectable for tests. */
export type AgentsFs = {
  exists(path: string): boolean
  read(path: string): Promise<string | null>
  write(path: string, text: string): Promise<void>
}

const nodeFs: AgentsFs = {
  exists: existsSync,
  read: (path) => readFile(path, 'utf8').catch(() => null),
  write: async (path, text) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
  },
}

export type AgentsOptions = {
  project: Project
  options: WizardOptions
  io: Io
  /** Where the app is seen, for the server's flag. Default: options.inspectorView. */
  view?: InspectorView | null
  /** The desktop relay, Metro's URL or the room code, when known. */
  relay?: string | null
  metro?: string | null
  code?: string | null
  fs?: AgentsFs
}

const TOOLS: Record<AgentTool, { label: string; file: string }> = {
  'claude-code': { label: 'Claude Code', file: '.mcp.json' },
  cursor: { label: 'Cursor', file: join('.cursor', 'mcp.json') },
}

type McpServer = { command: string; args: string[] }

/** The server entry, matching where the app is seen. */
export function serverEntry(view: InspectorView | null | undefined, where: { relay?: string | null; metro?: string | null; code?: string | null } = {}): McpServer {
  const args = ['-y', '@keyframerdev/inspector', 'mcp']
  if (view === 'desktop') args.push('--relay', (where.relay ?? 'http://127.0.0.1:8790').replace(/^http(s?):/, 'ws$1:'))
  else if (view === 'editor' && where.code) args.push('--code', where.code)
  else if (view === 'devtools' && where.metro) args.push('--metro', where.metro)
  return { command: 'npx', args }
}

type Merge = { text: string; status: 'added' | 'kept' } | { error: string }

/** Adds the server to an MCP config's text (or a new one), keeping everything else. */
export function mergeConfig(existing: string | null, entry: McpServer): Merge {
  let config: Record<string, unknown> = {}
  if (existing && existing.trim()) {
    try {
      const parsed = JSON.parse(existing) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'it is not a JSON object' }
      config = parsed as Record<string, unknown>
    } catch {
      return { error: "it isn't valid JSON" }
    }
  }
  const servers = config.mcpServers
  if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) return { error: 'its mcpServers is not an object' }
  const map = (servers ?? {}) as Record<string, unknown>
  if (SERVER_NAME in map) return { text: existing ?? '', status: 'kept' }
  const next = { ...config, mcpServers: { ...map, [SERVER_NAME]: entry } }
  return { text: `${JSON.stringify(next, null, 2)}\n`, status: 'added' }
}

/** What was set up, in words ("Claude Code: the keyframer-inspector plugin"). */
export async function setupAgents(opts: AgentsOptions): Promise<string[]> {
  const { io, options, project } = opts
  if (options.agents === false) return []
  const fs = opts.fs ?? nodeFs
  const at = (p: string) => join(project.root, p)

  // Preselected when the project already uses the agent; under --yes, only what a flag asks for.
  const seen: AgentTool[] = []
  if (fs.exists(at('.mcp.json')) || fs.exists(at('.claude')) || fs.exists(at('CLAUDE.md'))) seen.push('claude-code')
  if (fs.exists(at('.cursor'))) seen.push('cursor')
  const choices: Choice<AgentTool>[] = (Object.keys(TOOLS) as AgentTool[]).map((t) => ({ value: t, label: TOOLS[t].label, hint: `${TOOLS[t].file} in this project` }))
  const initial = options.agentTools ?? (options.agents === true ? (Object.keys(TOOLS) as AgentTool[]) : io.interactive ? seen : [])
  const picked = options.agentTools ?? (await io.multiselect('Let a coding agent use the Inspector? It can record the app and read what dropped frames.', choices, { initial, flag: '--agents', required: false }))

  const entry = serverEntry(opts.view ?? options.inspectorView, { relay: opts.relay, metro: opts.metro, code: opts.code })
  const done: string[] = []
  for (const tool of picked) {
    const { label, file } = TOOLS[tool]
    const merged = mergeConfig(await fs.read(at(file)), entry)
    if ('error' in merged) {
      io.warn(`${label}: left ${file} alone, because ${merged.error}. Add the server yourself: ${entry.command} ${entry.args.join(' ')}`)
      continue
    }
    if (merged.status === 'kept') {
      io.info(`${label}: ${file} already has ${SERVER_NAME}, left as it is.`)
      done.push(`${label}: ${SERVER_NAME} in ${file} (already there)`)
      continue
    }
    if (options.dryRun) {
      io.note(merged.text.trimEnd(), `${file} (dry run, not written)`)
      done.push(`${label}: ${SERVER_NAME} in ${file} (dry run)`)
      continue
    }
    await fs.write(at(file), merged.text)
    io.success(`${label}: added ${SERVER_NAME} to ${file}`)
    done.push(`${label}: ${SERVER_NAME} in ${file}`)
  }
  return done
}
