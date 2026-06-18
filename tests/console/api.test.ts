import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function stubFleetToken(token: string | null): void {
  vi.stubGlobal('document', {
    querySelector: (selector: string) => {
      if (selector !== 'meta[name="fleet-token"]' || token === null) return null
      return { content: token }
    },
  })
}

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
  } as Response
}

function fetchInit(fetchMock: ReturnType<typeof vi.fn>, index: number): RequestInit {
  const init = fetchMock.mock.calls[index]?.[1]
  expect(init).toBeDefined()
  return init as RequestInit
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, index: number): unknown {
  const body = fetchInit(fetchMock, index).body
  return typeof body === 'string' ? JSON.parse(body) : body
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('console api behavior coverage', () => {
  it('fetches fallback-backed read endpoints with encoded paths and query strings', async () => {
    stubFleetToken(null)
    const responses = new Map<string, unknown>([
      ['/api/lines', []],
      ['/api/lines/line%20a', { name: 'line a', status: 'online' }],
      [
        '/api/lines/line%20a/messages?conversation_key=chat%2Fone&before_pk=41',
        [{ pk: 42, conversationKey: 'chat/one', senderName: 'Ana', senderJid: 'ana', content: 'hi', timestamp: 'now', fromMe: false, type: 'text', rawMessage: '{}' }],
      ],
      ['/api/lines/line%20a/metrics?range=30d', { range: '30d', messageVolume: [] }],
      ['/api/metrics?range=7d', { range: '7d', meta: { instancesQueried: 1 } }],
      ['/api/lines/line%20a/access', [{ subjectType: 'phone', subjectId: '+1' }]],
      ['/api/lines/line%20a/logs', [{ timestamp: 'now', level: 'info', msg: 'ok', source: 'test' }]],
      ['/api/feed', [{ time: 'now', mode: 'chat', text: 'feed' }]],
      ['/api/typing', [{ instance: 'line a', jid: 'chat', since: 1 }]],
      ['/api/lines/line%20a/scheduled', { count: 0, messages: [] }],
      ['/api/lines/line%20a/scheduled?status=pending', { count: 1, messages: [{ id: 7 }] }],
      ['/api/lines/line%20a/groups', { groups: [{ id: 'group', subject: 'Ops', participants: [] }] }],
      ['/api/lines/line%20a/contacts/search?q=a%2Bb', { contacts: [{ jid: '123@s.whatsapp.net', name: 'Ana' }] }],
      ['/api/lines/line%20a/groups/group%2Fjid', { id: 'group/jid', subject: 'Ops', participants: [] }],
    ])
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const key = String(url)
      if (!responses.has(key)) {
        throw new Error(`unexpected fetch ${key}`)
      }
      return jsonResponse(responses.get(key))
    })
    vi.stubGlobal('fetch', fetchMock)

    const { api } = await import('../../console/src/lib/api.ts')

    await expect(api.getLine('line a')).resolves.toEqual({ name: 'line a', status: 'online' })
    await expect(api.getMessages('line a', 'chat/one', 41)).resolves.toEqual([
      {
        pk: 42,
        conversationKey: 'chat/one',
        senderName: 'Ana',
        senderJid: 'ana',
        content: 'hi',
        timestamp: 'now',
        fromMe: false,
        type: 'text',
        rawMessage: '{}',
      },
    ])
    await expect(api.getMetrics('line a', '30d')).resolves.toEqual({ range: '30d', messageVolume: [] })
    await expect(api.getFleetMetrics('7d')).resolves.toEqual({ range: '7d', meta: { instancesQueried: 1 } })
    await expect(api.getAccess('line a')).resolves.toEqual([{ subjectType: 'phone', subjectId: '+1' }])
    await expect(api.getLogs('line a')).resolves.toEqual([{ timestamp: 'now', level: 'info', msg: 'ok', source: 'test' }])
    await expect(api.getFeed()).resolves.toEqual([{ time: 'now', mode: 'chat', text: 'feed' }])
    await expect(api.getTyping()).resolves.toEqual([{ instance: 'line a', jid: 'chat', since: 1 }])
    await expect(api.getScheduled('line a')).resolves.toEqual({ count: 0, messages: [] })
    await expect(api.getScheduled('line a', 'pending')).resolves.toEqual({ count: 1, messages: [{ id: 7 }] })
    await expect(api.getGroups('line a')).resolves.toEqual({ groups: [{ id: 'group', subject: 'Ops', participants: [] }] })
    await expect(api.searchContacts('line a', 'a+b')).resolves.toEqual({ contacts: [{ jid: '123@s.whatsapp.net', name: 'Ana' }] })
    await expect(api.getGroupDetail('line a', 'group/jid')).resolves.toEqual({ id: 'group/jid', subject: 'Ops', participants: [] })

    expect(fetchMock).toHaveBeenCalledWith('/api/lines', expect.objectContaining({ headers: {} }))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/lines/line%20a/messages?conversation_key=chat%2Fone&before_pk=41',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
    )
  })

  it('normalizes search responses without a conversation filter', async () => {
    stubFleetToken(null)
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      results: [{ pk: 5, conversationKey: 'chat', content: 'match', fromMe: true, type: 'text' }],
    }))
    vi.stubGlobal('fetch', fetchMock)

    const { api } = await import('../../console/src/lib/api.ts')

    await expect(api.searchMessages('line a', 'hello world')).resolves.toEqual({
      results: [
        {
          pk: 5,
          conversationKey: 'chat',
          senderName: '',
          senderJid: '',
          content: 'match',
          timestamp: '',
          fromMe: true,
          type: 'text',
          rawMessage: undefined,
        },
      ],
      total: 1,
      query: '',
    })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/lines/line%20a/messages/search?q=hello%20world')
  })

  it('normalizes a non-object search response as an empty result set', async () => {
    stubFleetToken(null)
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(null))
    vi.stubGlobal('fetch', fetchMock)

    const { api } = await import('../../console/src/lib/api.ts')

    await expect(api.searchMessages('line a', 'empty')).resolves.toEqual({
      results: [],
      total: 0,
      query: '',
    })
  })

  it('shares one in-flight availability probe across concurrent fallback reads', async () => {
    stubFleetToken(null)
    const probe = deferred<Response>()
    const fetchMock = vi.fn((url: RequestInfo | URL) => {
      if (String(url) !== '/api/lines') {
        throw new Error(`unexpected fetch ${String(url)}`)
      }
      if (fetchMock.mock.calls.length === 1) {
        return probe.promise
      }
      return Promise.resolve(jsonResponse([]))
    })
    vi.stubGlobal('fetch', fetchMock)

    const { api } = await import('../../console/src/lib/api.ts')

    const first = api.getLines()
    const second = api.getLines()
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    probe.resolve(jsonResponse([]))

    await expect(Promise.all([first, second])).resolves.toEqual([[], []])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('sends write and group operations with their pinned methods, paths, and JSON bodies', async () => {
    stubFleetToken(null)
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, success: true, ticket: 'ok' }))
    vi.stubGlobal('fetch', fetchMock)

    const { api } = await import('../../console/src/lib/api.ts')

    const operations: Array<{
      run: () => Promise<unknown>
      path: string
      method?: string
      body?: unknown
    }> = [
      { run: () => api.stopInstance('line a'), path: '/api/lines/line%20a/stop', method: 'POST' },
      { run: () => api.deleteLine('line a'), path: '/api/lines/line%20a', method: 'DELETE' },
      { run: () => api.sendMessage('line a', 'chat/jid', 'hello'), path: '/api/lines/line%20a/send', method: 'POST', body: { chatJid: 'chat/jid', text: 'hello' } },
      { run: () => api.accessDecision('line a', 'group', 'g1', 'block'), path: '/api/lines/line%20a/access', method: 'POST', body: { subjectType: 'group', subjectId: 'g1', action: 'block' } },
      { run: () => api.markRead('line a', 'chat/jid'), path: '/api/lines/line%20a/mark-read', method: 'POST', body: { conversation_key: 'chat/jid' } },
      { run: () => api.updateConfig('line a', { mode: 'agent' }), path: '/api/lines/line%20a/config', method: 'PATCH', body: { mode: 'agent' } },
      { run: () => api.createLine({ name: 'new line' }), path: '/api/lines', method: 'POST', body: { name: 'new line' } },
      { run: () => api.checkExists('line a'), path: '/api/lines/line%20a/exists' },
      { run: () => api.checkDirectory('/tmp/line a'), path: '/api/directories/check?path=%2Ftmp%2Fline%20a' },
      { run: () => api.getVersion(), path: '/api/version' },
      { run: () => api.cancelScheduled('line a', 7), path: '/api/lines/line%20a/scheduled/7', method: 'DELETE' },
      { run: () => api.createScheduled('line a', { text: 'later' }), path: '/api/lines/line%20a/scheduled', method: 'POST', body: { text: 'later' } },
      { run: () => api.updateScheduled('line a', 7, { text: 'updated' }), path: '/api/lines/line%20a/scheduled/7', method: 'PUT', body: { text: 'updated' } },
      { run: () => api.getScheduledById('line a', 7), path: '/api/lines/line%20a/scheduled/7' },
      { run: () => api.createGroup('line a', 'Ops', ['a@s.whatsapp.net']), path: '/api/lines/line%20a/groups', method: 'POST', body: { subject: 'Ops', participants: ['a@s.whatsapp.net'] } },
      { run: () => api.leaveGroup('line a', 'group/jid'), path: '/api/lines/line%20a/groups/group%2Fjid', method: 'DELETE' },
      { run: () => api.updateGroupSubject('line a', 'group/jid', 'New Ops'), path: '/api/lines/line%20a/groups/group%2Fjid/subject', method: 'PUT', body: { subject: 'New Ops' } },
      { run: () => api.updateGroupDescription('line a', 'group/jid', undefined), path: '/api/lines/line%20a/groups/group%2Fjid/description', method: 'PUT', body: {} },
      { run: () => api.updateGroupParticipants('line a', 'group/jid', ['a'], 'promote'), path: '/api/lines/line%20a/groups/group%2Fjid/participants', method: 'POST', body: { participants: ['a'], action: 'promote' } },
      { run: () => api.updateGroupSettings('line a', 'group/jid', 'announcement'), path: '/api/lines/line%20a/groups/group%2Fjid/settings', method: 'PUT', body: { setting: 'announcement' } },
      { run: () => api.getGroupInviteLink('line a', 'group/jid'), path: '/api/lines/line%20a/groups/group%2Fjid/invite' },
      { run: () => api.revokeGroupInvite('line a', 'group/jid'), path: '/api/lines/line%20a/groups/group%2Fjid/invite/revoke', method: 'POST' },
      { run: () => api.updateGroupEphemeral('line a', 'group/jid', 86400), path: '/api/lines/line%20a/groups/group%2Fjid/ephemeral', method: 'PUT', body: { expiration: 86400 } },
      { run: () => api.updateGroupMemberAddMode('line a', 'group/jid', 'admin_add'), path: '/api/lines/line%20a/groups/group%2Fjid/member-add-mode', method: 'PUT', body: { mode: 'admin_add' } },
      { run: () => api.updateGroupJoinApproval('line a', 'group/jid', 'on'), path: '/api/lines/line%20a/groups/group%2Fjid/join-approval', method: 'PUT', body: { mode: 'on' } },
    ]

    for (const [index, operation] of operations.entries()) {
      await operation.run()
      expect(fetchMock.mock.calls[index]?.[0]).toBe(operation.path)
      const init = fetchInit(fetchMock, index)
      expect(init.method).toBe(operation.method)
      if ('body' in operation) {
        expect(requestBody(fetchMock, index)).toEqual(operation.body)
      }
    }
  })

  it('rejects malformed ticket mint responses and websocket ticket failures', async () => {
    stubFleetToken('root-token')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ticket: '' }))
      .mockResolvedValueOnce(jsonResponse('ws down', 503))
    vi.stubGlobal('fetch', fetchMock)

    const { api, getApiTicket } = await import('../../console/src/lib/api.ts')

    await expect(getApiTicket('api')).rejects.toThrow('auth-ticket api: malformed server response')
    await expect(api.getWsTicket()).rejects.toThrow('API 503: ws down')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/ws-ticket')
    expect(fetchInit(fetchMock, 1).headers).toEqual({ Authorization: 'Bearer root-token' })
  })

  it('continues in dev without Authorization when ticket minting fails before saveContact', async () => {
    stubFleetToken('root-token')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse('ticket service down', 503))
      .mockResolvedValueOnce(jsonResponse({ saved: true }))
    vi.stubGlobal('fetch', fetchMock)

    const { api } = await import('../../console/src/lib/api.ts')

    await expect(api.saveContact('line a', { jid: '123@s.whatsapp.net', firstName: 'Ana' })).resolves.toEqual({ saved: true })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth-ticket')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/lines/line%20a/contacts')
    expect(fetchInit(fetchMock, 1).headers).toEqual({ 'Content-Type': 'application/json' })
    expect(requestBody(fetchMock, 1)).toEqual({ jid: '123@s.whatsapp.net', firstName: 'Ana' })
  })

  it('omits websocket Authorization when no root fleet token is present', async () => {
    stubFleetToken(null)
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ticket: 'ws-ticket', expiresIn: 60 }))
    vi.stubGlobal('fetch', fetchMock)

    const { api } = await import('../../console/src/lib/api.ts')

    await expect(api.getWsTicket()).resolves.toEqual({ ticket: 'ws-ticket', expiresIn: 60 })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/ws-ticket')
    expect(fetchInit(fetchMock, 0).headers).toEqual({})
  })

  it('falls back to mock data in dev when the availability probe succeeds but the read fails', async () => {
    stubFleetToken(null)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse('service unavailable', 503))
    vi.stubGlobal('fetch', fetchMock)

    const { api } = await import('../../console/src/lib/api.ts')

    await expect(api.getLines()).resolves.toEqual(expect.any(Array))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
