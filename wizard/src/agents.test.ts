import { describe, expect, it } from 'vitest'
import { mergeConfig, serverEntry, setupAgents, type AgentsFs } from './agents'
import { loggedIo, testOptions, testProject } from './fakes'

/** A project folder in memory. */
function folder(files: Record<string, string> = {}, dirs: string[] = []) {
  const map = new Map(Object.entries(files).map(([k, v]) => [`/work/shop/${k}`, v]))
  const written: string[] = []
  const fs: AgentsFs = {
    exists: (p) => map.has(p) || dirs.some((d) => p === `/work/shop/${d}`),
    read: async (p) => map.get(p) ?? null,
    write: async (p, text) => {
      written.push(p)
      map.set(p, text)
    },
  }
  return { fs, written, file: (p: string) => JSON.parse(map.get(`/work/shop/${p}`)!) }
}

const plugin = { command: 'npx', args: ['-y', '@keyframerdev/inspector', 'mcp'] }

describe('serverEntry', () => {
  it("is the plugin's command, with the flag for where the app is seen", () => {
    expect(serverEntry('devtools')).toEqual(plugin)
    expect(serverEntry('devtools', { metro: 'http://localhost:8082' }).args).toEqual([...plugin.args, '--metro', 'http://localhost:8082'])
    expect(serverEntry('desktop').args).toEqual([...plugin.args, '--relay', 'ws://127.0.0.1:8790'])
    expect(serverEntry('editor', { code: 'ABC234' }).args).toEqual([...plugin.args, '--code', 'ABC234'])
  })
})

describe('mergeConfig', () => {
  it('a new file, or added beside the servers already there', () => {
    expect(JSON.parse((mergeConfig(null, plugin) as { text: string }).text)).toEqual({ mcpServers: { 'keyframer-inspector': plugin } })
    const before = JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } }, other: true })
    expect(JSON.parse((mergeConfig(before, plugin) as { text: string }).text)).toEqual({ mcpServers: { github: { command: 'gh-mcp' }, 'keyframer-inspector': plugin }, other: true })
  })
  it('an entry already there is left exactly as it is; a file it cannot read is not touched', () => {
    const before = '{ "mcpServers": { "keyframer-inspector": { "command": "node", "args": ["mine.js"] } } }'
    expect(mergeConfig(before, plugin)).toEqual({ text: before, status: 'kept' })
    expect(mergeConfig('{ nope', plugin)).toEqual({ error: "it isn't valid JSON" })
    expect(mergeConfig('[]', plugin)).toEqual({ error: 'it is not a JSON object' })
  })
})

describe('setupAgents', () => {
  it('writes .mcp.json and .cursor/mcp.json for the agents picked, keeping other servers', async () => {
    const f = folder({ '.cursor/mcp.json': JSON.stringify({ mcpServers: { linear: { url: 'https://mcp.linear.app/sse' } } }) }, ['.cursor'])
    const io = loggedIo([['Let a coding agent', ['claude-code', 'cursor']]])
    const done = await setupAgents({ project: testProject, options: testOptions({ inspectorView: 'desktop' }), io, fs: f.fs })
    expect(done).toEqual(['Claude Code: keyframer-inspector in .mcp.json', 'Cursor: keyframer-inspector in .cursor/mcp.json'])
    const desktop = { command: 'npx', args: [...plugin.args, '--relay', 'ws://127.0.0.1:8790'] }
    expect(f.file('.mcp.json')).toEqual({ mcpServers: { 'keyframer-inspector': desktop } })
    expect(f.file('.cursor/mcp.json')).toEqual({ mcpServers: { linear: { url: 'https://mcp.linear.app/sse' }, 'keyframer-inspector': desktop } })
    expect(io.log.some((l) => l.includes('/plugin'))).toBe(false)
  })

  it('an existing keyframer-inspector entry stays unchanged', async () => {
    const mine = '{"mcpServers":{"keyframer-inspector":{"command":"npx","args":["keyframer-inspect","mcp"]}}}'
    const f = folder({ '.mcp.json': mine })
    const io = loggedIo([['Let a coding agent', ['claude-code']]])
    expect(await setupAgents({ project: testProject, options: testOptions(), io, fs: f.fs })).toEqual(['Claude Code: keyframer-inspector in .mcp.json (already there)'])
    expect(f.written).toEqual([])
  })

  it('preselects the agents the project already uses; --yes picks none unless asked', async () => {
    const io = loggedIo()
    const f = folder({ 'CLAUDE.md': '# hi' })
    await setupAgents({ project: testProject, options: testOptions(), io, fs: f.fs })
    expect(io.log[0]).toBe('ask: Let a coding agent use the Inspector? It can record the app and read what dropped frames. → ["claude-code"]')
    const quiet = folder()
    expect(await setupAgents({ project: testProject, options: testOptions({ yes: true }), io: loggedIo([], { interactive: false }), fs: quiet.fs })).toEqual([])
    expect(quiet.written).toEqual([])
    const both = folder()
    await setupAgents({ project: testProject, options: testOptions({ yes: true, agents: true }), io: loggedIo([], { interactive: false }), fs: both.fs })
    expect(both.written).toEqual(['/work/shop/.mcp.json', '/work/shop/.cursor/mcp.json'])
    const one = folder()
    await setupAgents({ project: testProject, options: testOptions({ yes: true, agentTools: ['cursor'] }), io: loggedIo([], { interactive: false }), fs: one.fs })
    expect(one.written).toEqual(['/work/shop/.cursor/mcp.json'])
    expect(await setupAgents({ project: testProject, options: testOptions({ agents: false }), io: loggedIo(), fs: folder().fs })).toEqual([])
  })

  it('a dry run shows the file instead of writing it; a broken file is left alone', async () => {
    const io = loggedIo([['Let a coding agent', ['claude-code', 'cursor']]])
    const f = folder({ '.cursor/mcp.json': '{ broken' })
    const done = await setupAgents({ project: testProject, options: testOptions({ dryRun: true }), io, fs: f.fs })
    expect(f.written).toEqual([])
    expect(done).toEqual(['Claude Code: keyframer-inspector in .mcp.json (dry run)'])
    expect(io.log.some((l) => l.startsWith('note (.mcp.json (dry run, not written))'))).toBe(true)
    expect(io.log.some((l) => l.startsWith("warn: Cursor: left .cursor/mcp.json alone, because it isn't valid JSON."))).toBe(true)
  })
})
