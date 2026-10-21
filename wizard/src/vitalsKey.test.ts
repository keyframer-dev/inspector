import { describe, expect, it } from 'vitest'
import { fakeFetch, loggedIo, testOptions as options, testProject as project } from './fakes'
import { NeedsAnswer } from './io'
import { checkFieldKey, getVitalsKey } from './vitalsKey'

const KEY = 'kfp_live_AbCdEfGhIjKlMnOpQrStUvWx'
const KEY2 = 'kfp_live_000000000000000000000000'

const config = { enabled: true, sampleRate: 0.1, collect: { reduceMotion: false, deviceModel: true, development: false }, ttlSec: 86400 }
const signIn = async () => 'tok_1'
const ws = (id: string, name: string, role = 'owner', kind = 'personal') => ({ id, name, role, kind, projectCount: 0 })
const fieldKey = (secret: string, revokedAt: string | null = null) => ({ id: 'k1', scope: 'field_ingest', revokedAt, secret })

describe('checkFieldKey', () => {
  it('takes a field key, and refuses the secret kinds without repeating them', () => {
    expect(checkFieldKey(KEY)).toBeUndefined()
    expect(checkFieldKey(` ${KEY} `)).toBeUndefined()
    expect(checkFieldKey('kft_secretsecretsecretsecretsecret12')).toMatch(/secret key/)
    expect(checkFieldKey('kft_secretsecretsecretsecretsecret12')).not.toContain('kft_secret')
    expect(checkFieldKey('kfw_x')).toMatch(/secret key/)
    expect(checkFieldKey('kf_abc')).toMatch(/API key/)
    expect(checkFieldKey('kfp_live_short')).toMatch(/24 letters and digits/)
    expect(checkFieldKey('')).toMatch(/Paste the key/)
  })
})

describe('getVitalsKey with --key', () => {
  it('wins, checked against the server', async () => {
    const f = fakeFetch([['GET', `/v1/config/${KEY}`, { body: config }]])
    expect(await getVitalsKey({ project, options: options({ vitalsKey: KEY }), io: loggedIo(), fetch: f })).toEqual({ key: KEY, projectId: null, workspaceId: null, token: null })
  })
  it('a bad format or a deleted project stops; an unknown key only warns (a new key takes a minute to spread)', async () => {
    const f = fakeFetch([
      ['GET', `/v1/config/${KEY}`, { status: 410, body: config }],
      ['GET', `/v1/config/${KEY2}`, { status: 401, body: config }],
    ])
    await expect(getVitalsKey({ project, options: options({ vitalsKey: 'kfp_live_nope' }), io: loggedIo(), fetch: f })).rejects.toThrow('--key: A field key is')
    await expect(getVitalsKey({ project, options: options({ vitalsKey: KEY }), io: loggedIo(), fetch: f })).rejects.toThrow('was deleted')
    const io = loggedIo()
    expect((await getVitalsKey({ project, options: options({ vitalsKey: KEY2 }), io, fetch: f })).key).toBe(KEY2)
    expect(io.log[0]).toMatch(/^warn: keyframer.dev doesn't know this key/)
  })
})

describe('getVitalsKey, pasted', () => {
  it('opens the dashboard and takes a pasted key', async () => {
    const io = loggedIo([
      ['How do you want', 'paste'],
      ['Paste the field key', KEY],
    ])
    const f = fakeFetch([['GET', '/v1/config/', { body: config }]])
    expect(await getVitalsKey({ project, options: options(), io, fetch: f, signIn })).toEqual({ key: KEY, projectId: null, workspaceId: null, token: null })
    expect(io.log).toContain('open: https://app.test/app/vitals')
  })

  it('asks again when the server does not know it and the person says not to use it', async () => {
    const io = loggedIo([
      ['Paste the field key', KEY2],
      ['Use it anyway', false],
      ['Paste the field key', KEY],
    ])
    const f = fakeFetch([
      ['GET', `/v1/config/${KEY2}`, { status: 401, body: config }],
      ['GET', `/v1/config/${KEY}`, { body: config }],
    ])
    expect((await getVitalsKey({ project, options: options({ vitalsAuth: 'paste' }), io, fetch: f })).key).toBe(KEY)
  })

  it('non-interactive: names --key', async () => {
    const err = await getVitalsKey({ project, options: options({ vitalsAuth: 'paste', yes: true }), io: loggedIo([], { interactive: false }), fetch: fakeFetch([]) }).catch((e) => e)
    expect(err).toBeInstanceOf(NeedsAnswer)
    expect(err.flag).toBe('--key')
  })
})

describe('getVitalsKey, signed in through the browser', () => {
  it('no Motion Vitals access: says so, links the beta, and offers the paste path', async () => {
    const io = loggedIo([['Paste the field key', KEY]])
    const f = fakeFetch([
      ['GET', '/api/vitals/access', { body: { allowed: false } }],
      ['GET', '/v1/config/', { body: config }],
    ])
    expect(await getVitalsKey({ project, options: options({ vitalsAuth: 'browser' }), io, fetch: f, signIn })).toEqual({ key: KEY, projectId: null, workspaceId: null, token: 'tok_1' })
    expect(io.log).toContain('info: Apply at https://app.test/vitals#apply. If a teammate shares their project\'s field key with you, you can paste it now.')
    expect(f.calls.some((c) => c.url.includes('/workspaces'))).toBe(false)
  })

  it('no access and nobody to ask: names --key', async () => {
    const f = fakeFetch([['GET', '/api/vitals/access', { body: { allowed: false } }]])
    const err = await getVitalsKey({ project, options: options({ yes: true }), io: loggedIo([], { interactive: false }), fetch: f, signIn }).catch((e) => e)
    expect(err).toBeInstanceOf(NeedsAnswer)
  })

  it('no workspace yet: creates one, and a project named after the app; its key comes with it', async () => {
    const io = loggedIo([['Name the new workspace', 'Acme']])
    const f = fakeFetch([
      ['GET', '/api/vitals/access', { body: { allowed: true } }],
      ['GET', '/api/vitals/workspaces', { body: [] }],
      ['POST', '/api/vitals/workspaces', { status: 201, body: ws('w2', 'Acme', 'owner', 'team') }],
      ['GET', '/api/vitals/workspaces/w2/projects', { body: [] }],
      ['POST', '/api/vitals/workspaces/w2/projects', { status: 201, body: { id: 'p9', workspaceId: 'w2', code: 'ACME', name: 'Acme Shop', platform: 'react-native' } }],
      ['GET', '/api/vitals/projects/p9/keys', { body: [fieldKey(KEY)] }],
    ])
    expect(await getVitalsKey({ project, options: options({ vitalsAuth: 'browser' }), io, fetch: f, signIn })).toEqual({ key: KEY, projectId: 'p9', workspaceId: 'w2', token: 'tok_1' })
    expect(f.calls.find((c) => c.method === 'POST' && c.url.endsWith('/workspaces'))!.body).toEqual({ name: 'Acme' })
    expect(f.calls.find((c) => c.method === 'POST' && c.url.endsWith('/projects'))!.body).toEqual({ name: 'Acme Shop', platform: 'react-native' })
    expect(f.calls.every((c) => !c.url.includes('/api/vitals') || c.headers.authorization === 'Bearer tok_1')).toBe(true)
  })

  it('picks the existing project with the app name, and creates a field key when it has none live', async () => {
    const io = loggedIo()
    const f = fakeFetch([
      ['GET', '/api/vitals/access', { body: { allowed: true } }],
      ['GET', '/api/vitals/workspaces', { body: [ws('w1', 'Ada')] }],
      ['GET', '/api/vitals/workspaces/w1/projects', { body: [{ id: 'p0', workspaceId: 'w1', code: 'OTHER', name: 'Other', platform: 'ios' }, { id: 'p1', workspaceId: 'w1', code: 'SHOP', name: 'acme shop', platform: 'react-native' }] }],
      ['GET', '/api/vitals/projects/p1/keys', { body: [fieldKey(KEY2, '2026-10-01T00:00:00Z'), { id: 'k2', scope: 'test_upload', revokedAt: null }] }],
      ['POST', '/api/vitals/projects/p1/keys', { status: 201, body: fieldKey(KEY) }],
    ])
    const got = await getVitalsKey({ project, options: options({ vitalsAuth: 'browser' }), io, fetch: f, signIn })
    expect(got).toEqual({ key: KEY, projectId: 'p1', workspaceId: 'w1', token: 'tok_1' })
    expect(io.log).toContain('ask: Which project should this app report to? → "p1"')
    expect(f.calls.find((c) => c.method === 'POST')!.body).toEqual({ scope: 'field_ingest' })
  })

  it("a member who can't make a field key is sent to an admin, and can paste one", async () => {
    const io = loggedIo([['Paste the field key', KEY]])
    const f = fakeFetch([
      ['GET', '/api/vitals/access', { body: { allowed: true } }],
      ['GET', '/api/vitals/workspaces', { body: [ws('w1', 'Team', 'member', 'team')] }],
      ['GET', '/api/vitals/workspaces/w1/projects', { body: [{ id: 'p1', workspaceId: 'w1', code: 'SHOP', name: 'Acme Shop', platform: 'react-native' }] }],
      ['GET', '/api/vitals/projects/p1/keys', { body: [] }],
      ['POST', '/api/vitals/projects/p1/keys', { status: 403, body: { error: 'Only owners and admins manage field keys.' } }],
      ['GET', '/v1/config/', { body: config }],
    ])
    expect((await getVitalsKey({ project, options: options({ vitalsAuth: 'browser' }), io, fetch: f, signIn })).key).toBe(KEY)
    expect(io.log.some((l) => l.includes('Only owners and admins can make a field key'))).toBe(true)
  })

  it('--yes --auth browser: the first workspace, the project named after the app (made when missing), no questions it cannot answer', async () => {
    const io = loggedIo([], { interactive: false })
    const f = fakeFetch([
      ['GET', '/api/vitals/access', { body: { allowed: true } }],
      ['GET', '/api/vitals/workspaces', { body: [ws('w1', 'Ada'), ws('w2', 'Team', 'admin', 'team')] }],
      ['GET', '/api/vitals/workspaces/w1/projects', { body: [{ id: 'p0', workspaceId: 'w1', code: 'OTHER', name: 'Other', platform: 'react-native' }] }],
      ['POST', '/api/vitals/workspaces/w1/projects', { status: 201, body: { id: 'p2', workspaceId: 'w1', code: 'ACME', name: 'Acme Shop', platform: 'react-native' } }],
      ['GET', '/api/vitals/projects/p2/keys', { body: [fieldKey(KEY)] }],
    ])
    expect((await getVitalsKey({ project, options: options({ yes: true, vitalsAuth: 'browser' }), io, fetch: f, signIn })).projectId).toBe('p2')
  })
})
