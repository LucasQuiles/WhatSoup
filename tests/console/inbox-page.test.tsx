/**
 * Inbox page — v3.5 surface contract harness (T5 b-07; mockup inbox.html SSOT).
 *
 * DISPOSITION RECORD (this file previously pinned the v3 page — 27 tests):
 *   SURVIVED (re-pinned against the v3.5 anatomy):
 *   - load-older pagination (success / end-of-history / failure-toast)
 *   - composer send (trim, optimistic, invalidate) + send failure toast
 *   - mark-read (now fires on OPEN per the unified-inbox model, same real route)
 *   - deep-link selection (?line=&chat=)
 *   REMOVED per the mockup SSOT (not test-signal weakening — the features left
 *   the surface; dispositions recorded in the b-07 PR):
 *   - in-conversation search row (mockup has no search lane; global search is
 *     not an inbox-bead concern)
 *   - Allow/Block/Save-Contact actions (not in the mockup; access control
 *     lives on the line-detail Access surface. The v3 DM path was also broken
 *     — it posted subjectType 'number' against the 'phone'|'group' validator)
 *   - per-line picker (the v3.5 inbox is one unified plane across lines)
 *   NEW coverage: channel chips honesty, seg filter, unified merge, takeover
 *   end-to-end (local-only honesty), context cards honesty, composer caps.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ReactNode } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { LineInstance } from '../../console/src/types'

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// use-fleet: keep the real query-option factories (the page composes per-line
// chats queries through them); stub only the data hooks.
let mockLines: LineInstance[] = []
let mockMessages: Array<Record<string, unknown>> = []

vi.mock('../../console/src/hooks/use-fleet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../console/src/hooks/use-fleet')>()
  return {
    ...actual,
    useLines: () => ({ data: mockLines }),
    useMessages: () => ({ data: mockMessages }),
  }
})

// use-virtual-messages: surface all messages as virtual items (jsdom has no scroll).
vi.mock('../../console/src/hooks/use-virtual-messages', () => ({
  useVirtualMessages: ({
    messages,
    getScrollElement,
  }: {
    messages: Array<{ pk: number }>
    getScrollElement: () => Element | null
  }) => {
    getScrollElement()
    return {
      getVirtualItems: () =>
        messages.map((_, i) => ({ index: i, key: i, start: i * 80, size: 80 })),
      getTotalSize: () => messages.length * 80,
      measureElement: () => {},
    }
  },
}))

// use-sticky-scroll: static stub — no scroll state in jsdom.
vi.mock('../../console/src/hooks/use-sticky-scroll', () => ({
  useStickyScroll: () => ({
    scrollRef: { current: null },
    showJump: false,
    handleScroll: vi.fn(),
    jumpToBottom: vi.fn(),
  }),
}))

// api: stub — contract tests drive the mocked surface, never the network.
vi.mock('../../console/src/lib/api', () => ({
  api: {
    getChats: vi.fn().mockResolvedValue([]),
    getMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    markRead: vi.fn().mockResolvedValue(undefined),
    getCheckpoints: vi.fn().mockResolvedValue({ observedAt: '', checkpoints: [] }),
  },
}))

// toast context: stable spy object so workflow tests can assert user feedback.
const toastMock = {
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
  clear: vi.fn(),
}
vi.mock('../../console/src/hooks/toast-context', () => ({
  ToastContext: {
    Provider: ({ children }: { children?: ReactNode }) => children,
  },
  useToast: () => toastMock,
}))

// ---------------------------------------------------------------------------
// Dynamic import (after vi.mock declarations)
// ---------------------------------------------------------------------------
import Inbox from '../../console/src/pages/Inbox'
import { api } from '../../console/src/lib/api'

const getChatsMock = api.getChats as unknown as ReturnType<typeof vi.fn>
const getMessagesMock = api.getMessages as unknown as ReturnType<typeof vi.fn>
const sendMessageMock = api.sendMessage as unknown as ReturnType<typeof vi.fn>
const markReadMock = api.markRead as unknown as ReturnType<typeof vi.fn>
const getCheckpointsMock = api.getCheckpoints as unknown as ReturnType<typeof vi.fn>

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLine(name: string, overrides: Record<string, unknown> = {}): LineInstance {
  return {
    name,
    phone: '+10000000000',
    mode: 'chat',
    status: 'running',
    accessMode: 'allowlist',
    healthPort: 4000,
    uptime: '1h',
    messagesTotal: 0,
    health: {
      status: 'ok',
      uptime_seconds: 60,
      messages_total: 0,
      whatsapp: { connected: true, connection: { state: 'connected' } },
      transport: { kind: 'baileys', connected: true, selfId: '1000' },
      sqlite: { messages_total: 0, schema_version: 1 },
    },
    heartbeat: [],
    lastActive: '',
    error: null,
    ...overrides,
  } as LineInstance
}

function makeChat(conversationKey: string, overrides: Record<string, unknown> = {}) {
  return {
    conversationKey,
    name: `Chat ${conversationKey}`,
    lastMessagePreview: 'preview text',
    lastMessageAt: '2026-07-23T12:00:00.000Z',
    unreadCount: 0,
    isGroup: false,
    ...overrides,
  }
}

function makeMessage(pk: number, content: string | null, overrides: Record<string, unknown> = {}) {
  return {
    pk,
    conversationKey: 'conv-a',
    senderName: 'Fixture Sender',
    senderJid: '',
    content,
    timestamp: '2026-07-23T12:00:00.000Z',
    fromMe: false,
    type: 'text',
    ...overrides,
  }
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function renderInbox(initialEntries: string[] = ['/inbox']) {
  const qc = makeClient()
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <Inbox />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...view, qc }
}

beforeEach(() => {
  mockLines = [makeLine('personal')]
  mockMessages = []
  getChatsMock.mockReset().mockResolvedValue([makeChat('conv-a')])
  getMessagesMock.mockReset().mockResolvedValue([])
  sendMessageMock.mockReset().mockResolvedValue(undefined)
  markReadMock.mockReset().mockResolvedValue(undefined)
  getCheckpointsMock.mockReset().mockResolvedValue({ observedAt: '', checkpoints: [] })
  Object.values(toastMock).forEach((fn) => fn.mockClear())
})

afterEach(cleanup)

// ---------------------------------------------------------------------------
// Anatomy — chips, seg, list
// ---------------------------------------------------------------------------

describe('v3.5 inbox — surface anatomy', () => {
  it('owns exactly one h1 (single-h1 law; chrome title is an aria-hidden span)', async () => {
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelector('.inbox-citem')).not.toBeNull())
    const h1s = container.querySelectorAll('h1')
    expect(h1s.length).toBe(1)
    expect(h1s[0]!.textContent).toBe('Inbox')
  })

  it('renders channel chips for real channels only, with honest counts', async () => {
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelector('.inbox-citem')).not.toBeNull())
    const chips = [...container.querySelectorAll('.inbox-chip')]
    // All + WhatsApp (the one line's baileys transport) — never Signal/iMessage/…
    expect(chips.length).toBe(2)
    expect(chips[0]!.textContent).toContain('All')
    expect(chips[0]!.querySelector('.inbox-chip__c')!.textContent).toBe('1')
    expect(chips[1]!.textContent).toContain('WhatsApp')
    expect(chips[1]!.querySelector('.inbox-chip__glyph')).not.toBeNull()
  })

  it('channel chip filters the list to that channel', async () => {
    getChatsMock.mockResolvedValue([makeChat('conv-a')])
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelectorAll('.inbox-citem').length).toBe(1))
    const chips = [...container.querySelectorAll('.inbox-chip')]
    fireEvent.click(chips[1]!) // WhatsApp
    expect(container.querySelectorAll('.inbox-citem').length).toBe(1)
  })

  it('conversation item anatomy: avatar initials, channel glyph badge, name, time, preview', async () => {
    getChatsMock.mockResolvedValue([makeChat('conv-a', { name: 'Lucas Quiles' })])
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelector('.inbox-citem')).not.toBeNull())
    const item = container.querySelector('.inbox-citem')!
    expect(item.querySelector('.inbox-ava')!.textContent).toContain('LQ')
    expect(item.querySelector('.inbox-ava__glyph')).not.toBeNull()
    expect(item.querySelector('.inbox-citem__nm')!.textContent).toBe('Lucas Quiles')
    expect(item.querySelector('.inbox-citem__tm')).not.toBeNull()
    expect(item.querySelector('.inbox-citem__pv')!.textContent).toBe('preview text')
  })

  it('seg control splits direct from rooms; rooms get the group avatar shape', async () => {
    getChatsMock.mockResolvedValue([
      makeChat('conv-a'),
      makeChat('120363001_at_g.us', { isGroup: true, name: 'WHATSOUP' }),
    ])
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelectorAll('.inbox-citem').length).toBe(1))
    // switch to rooms
    const roomsBtn = [...container.querySelectorAll('.inbox-seg button')].find(
      (b) => b.textContent === 'Rooms',
    )!
    fireEvent.click(roomsBtn)
    const items = container.querySelectorAll('.inbox-citem')
    expect(items.length).toBe(1)
    expect(items[0]!.querySelector('.inbox-ava--grp')).not.toBeNull()
    expect(items[0]!.querySelector('.inbox-citem__nm')!.textContent).toBe('WHATSOUP')
  })

  it('renders the honest empty list state when a filter has no conversations', async () => {
    getChatsMock.mockResolvedValue([])
    const { container, getByTestId } = renderInbox()
    await waitFor(() => expect(getByTestId('inbox-list-empty')).toBeDefined())
    expect(container.querySelector('.inbox-citem')).toBeNull()
  })

  it('unread badge renders the count; zero-unread renders no badge', async () => {
    getChatsMock.mockResolvedValue([
      makeChat('conv-a', { unreadCount: 3 }),
      makeChat('conv-b', { name: 'Ben' }),
    ])
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelectorAll('.inbox-citem').length).toBe(2))
    const badges = container.querySelectorAll('.inbox-ub')
    expect(badges.length).toBe(1)
    expect(badges[0]!.textContent).toBe('3')
  })
})

// ---------------------------------------------------------------------------
// Selection + thread
// ---------------------------------------------------------------------------

describe('v3.5 inbox — thread', () => {
  it('empty thread state when nothing is selected', async () => {
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelector('.inbox-thread')).not.toBeNull())
    expect(container.querySelector('.inbox-thread__empty')).not.toBeNull()
    expect(container.querySelector('.inbox-thead')).toBeNull()
  })

  it('selecting a conversation renders the thread head with line · channel · kind sub', async () => {
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelector('.inbox-citem')).not.toBeNull())
    fireEvent.click(container.querySelector('.inbox-citem')!)
    await waitFor(() => expect(container.querySelector('.inbox-thead')).not.toBeNull())
    expect(container.querySelector('.inbox-thead__sub')!.textContent).toContain('personal')
    expect(container.querySelector('.inbox-thead__sub')!.textContent).toContain('WhatsApp')
    expect(container.querySelector('.inbox-thead__sub')!.textContent).toContain('direct')
  })

  it('renders incoming rows with sender avatar; fromMe rows right-aligned without avatar', async () => {
    mockMessages = [
      makeMessage(2, 'newest', { fromMe: true }),
      makeMessage(1, 'oldest'),
    ]
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelector('.inbox-citem')).not.toBeNull())
    fireEvent.click(container.querySelector('.inbox-citem')!)
    await waitFor(() => expect(container.querySelectorAll('.inbox-mrow').length).toBe(2))
    const me = container.querySelector('.inbox-mrow--me')!
    expect(me.querySelector('.inbox-ma')).toBeNull()
    const them = container.querySelector('.inbox-mrow:not(.inbox-mrow--me)')!
    expect(them.querySelector('.inbox-ma')!.textContent).toBe('F')
    // DM: no sender-name label (the who lane is rooms-only)
    expect(them.querySelector('.inbox-bub__who')).toBeNull()
  })

  it('rooms label the real sender name on incoming bubbles', async () => {
    getChatsMock.mockResolvedValue([makeChat('120363001_at_g.us', { isGroup: true, name: 'WHATSOUP' })])
    mockMessages = [makeMessage(1, 'hello', { senderName: 'Quinn' })]
    const { container } = renderInbox()
    // the only fixture is a room — the default Direct seg is empty by design
    await waitFor(() => expect(container.querySelector('.inbox-seg')).not.toBeNull())
    const roomsBtn = [...container.querySelectorAll('.inbox-seg button')].find(
      (b) => b.textContent === 'Rooms',
    )!
    fireEvent.click(roomsBtn)
    await waitFor(() => expect(container.querySelector('.inbox-citem')).not.toBeNull())
    fireEvent.click(container.querySelector('.inbox-citem')!)
    await waitFor(() => expect(container.querySelector('.inbox-bub__who')).not.toBeNull())
    expect(container.querySelector('.inbox-bub__who')!.textContent).toBe('Quinn')
  })

  it('media messages with null content render an honest type placeholder', async () => {
    mockMessages = [makeMessage(1, null, { type: 'image' })]
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelector('.inbox-citem')).not.toBeNull())
    fireEvent.click(container.querySelector('.inbox-citem')!)
    await waitFor(() => expect(container.querySelector('.inbox-bub')).not.toBeNull())
    expect(container.querySelector('.inbox-bub')!.textContent).toContain('[image]')
  })
})

// ---------------------------------------------------------------------------
// Mark-read on open (real route; the v3 manual button became automatic)
// ---------------------------------------------------------------------------

describe('v3.5 inbox — mark-read on open', () => {
  it('marks an unread conversation read when opened', async () => {
    getChatsMock.mockResolvedValue([makeChat('conv-a', { unreadCount: 2 })])
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelector('.inbox-citem')).not.toBeNull())
    fireEvent.click(container.querySelector('.inbox-citem')!)
    await waitFor(() => expect(markReadMock).toHaveBeenCalledWith('personal', 'conv-a'))
  })

  it('does not call mark-read for an already-read conversation', async () => {
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelector('.inbox-citem')).not.toBeNull())
    fireEvent.click(container.querySelector('.inbox-citem')!)
    await waitFor(() => expect(container.querySelector('.inbox-thead')).not.toBeNull())
    expect(markReadMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Takeover — end-to-end, honest local state (no runtime endpoint exists)
// ---------------------------------------------------------------------------

describe('v3.5 inbox — takeover (local-only honesty)', () => {
  it('toggle carries the no-endpoint disclosure to assistive tech', async () => {
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelector('.inbox-citem')).not.toBeNull())
    fireEvent.click(container.querySelector('.inbox-citem')!)
    await waitFor(() => expect(container.querySelector('.inbox-tgl')).not.toBeNull())
    const tgl = container.querySelector('.inbox-tgl')!
    expect(tgl.getAttribute('role')).toBe('switch')
    expect(tgl.getAttribute('aria-checked')).toBe('false')
    expect(tgl.getAttribute('aria-description')).toContain('no runtime pause endpoint')
  })

  it('enabling takeover flips the whole surface state: pill, placeholder, badge, card', async () => {
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelector('.inbox-citem')).not.toBeNull())
    fireEvent.click(container.querySelector('.inbox-citem')!)
    await waitFor(() => expect(container.querySelector('.inbox-tgl')).not.toBeNull())

    fireEvent.click(container.querySelector('.inbox-tgl')!)

    await waitFor(() => {
      expect(container.querySelector('.inbox-tgl')!.getAttribute('aria-checked')).toBe('true')
      // sys pill — labeled local-only, never claims the agent paused
      const sys = container.querySelector('.inbox-sys')!
      expect(sys.textContent).toContain('takeover enabled')
      expect(sys.textContent).toContain('local only')
      // composer placeholder switches to the takeover copy (real: sends as the line)
      expect(container.querySelector('.inbox-input')!.getAttribute('placeholder')).toContain(
        'takeover',
      )
      // conversation list badge
      expect(container.querySelector('.inbox-take')).not.toBeNull()
      // agent card notes takeover as local
      expect(container.querySelector('.inbox-agcard')!.textContent).toContain('takeover (local)')
    })

    // toggle back off — every trace leaves
    fireEvent.click(container.querySelector('.inbox-tgl')!)
    await waitFor(() => {
      expect(container.querySelector('.inbox-sys')).toBeNull()
      expect(container.querySelector('.inbox-take')).toBeNull()
      expect(container.querySelector('.inbox-agcard')!.textContent).not.toContain('takeover')
    })
  })
})

// ---------------------------------------------------------------------------
// Composer — caps honesty, uniform height class contract, send workflows
// ---------------------------------------------------------------------------

describe('v3.5 inbox — composer', () => {
  it('media/voice/poll caps are disabled with no-fleet-route notes; schedule cap navigates', async () => {
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelector('.inbox-citem')).not.toBeNull())
    fireEvent.click(container.querySelector('.inbox-citem')!)
    await waitFor(() => expect(container.querySelectorAll('.inbox-cap').length).toBe(4))
    const caps = [...container.querySelectorAll<HTMLButtonElement>('.inbox-cap')]
    const byLabel = (s: string) => caps.find((c) => c.getAttribute('aria-label') === s)!
    expect(byLabel('Send image').disabled).toBe(true)
    expect(byLabel('Send image').title).toContain('No fleet media endpoint')
    expect(byLabel('Send voice note').disabled).toBe(true)
    expect(byLabel('Send poll').disabled).toBe(true)
    expect(byLabel('Send poll').title).toContain('no fleet route')
    expect(byLabel('Open scheduled messages for this line').disabled).toBe(false)
  })

  it('composer controls share the uniform-height token (bead acceptance)', async () => {
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelector('.inbox-citem')).not.toBeNull())
    fireEvent.click(container.querySelector('.inbox-citem')!)
    await waitFor(() => expect(container.querySelector('.inbox-composer')).not.toBeNull())
    // class contract: all three consume var(--inbox-composer-h) in inbox.css
    // (computed-height proof lives in tests/browser/viewport-matrix.test.tsx)
    expect(container.querySelector('.inbox-cap')).not.toBeNull()
    expect(container.querySelector('.inbox-input')).not.toBeNull()
    expect(container.querySelector('.inbox-send')).not.toBeNull()
  })

  it('sends trimmed text and invalidates the message query', async () => {
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelector('.inbox-citem')).not.toBeNull())
    fireEvent.click(container.querySelector('.inbox-citem')!)
    const input = (await waitFor(() => container.querySelector('.inbox-input')!)) as HTMLInputElement
    fireEvent.change(input, { target: { value: '  hello there  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(sendMessageMock).toHaveBeenCalledWith('personal', 'conv-a', 'hello there'),
    )
  })

  it('reports a failed send via toast and drops the optimistic bubble', async () => {
    sendMessageMock.mockRejectedValue(new Error('boom'))
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelector('.inbox-citem')).not.toBeNull())
    fireEvent.click(container.querySelector('.inbox-citem')!)
    const input = (await waitFor(() => container.querySelector('.inbox-input')!)) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'will fail' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
    expect(toastMock.error.mock.calls[0]![0]).toContain('boom')
  })
})

// ---------------------------------------------------------------------------
// Load-older pagination (before_pk cursor contract)
// ---------------------------------------------------------------------------

describe('v3.5 inbox — load older', () => {
  it('loads older messages from the oldest loaded pk and hides the control at end of history', async () => {
    mockMessages = [makeMessage(5, 'newest'), makeMessage(3, 'oldest')]
    getMessagesMock.mockResolvedValue([]) // no older pages remain
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelector('.inbox-citem')).not.toBeNull())
    fireEvent.click(container.querySelector('.inbox-citem')!)
    const older = (await waitFor(() => container.querySelector('.inbox-older')!)) as HTMLButtonElement
    fireEvent.click(older)
    await waitFor(() => expect(getMessagesMock).toHaveBeenCalledWith('personal', 'conv-a', 3))
    await waitFor(() => expect(container.querySelector('.inbox-older')).toBeNull())
  })

  it('reports older-message load failures without dropping the control', async () => {
    mockMessages = [makeMessage(5, 'newest'), makeMessage(3, 'oldest')]
    getMessagesMock.mockRejectedValue(new Error('disk gone'))
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelector('.inbox-citem')).not.toBeNull())
    fireEvent.click(container.querySelector('.inbox-citem')!)
    const older = (await waitFor(() => container.querySelector('.inbox-older')!)) as HTMLButtonElement
    fireEvent.click(older)
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
    expect(container.querySelector('.inbox-older')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Context pane — person / agent / line cards, honest empties
// ---------------------------------------------------------------------------

describe('v3.5 inbox — context cards', () => {
  it('person card carries identity rows with the real conversation key and line', async () => {
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelector('.inbox-citem')).not.toBeNull())
    fireEvent.click(container.querySelector('.inbox-citem')!)
    await waitFor(() => expect(container.querySelector('.inbox-pcard')).not.toBeNull())
    const card = container.querySelector('.inbox-pcard')!
    expect(card.textContent).toContain('Chat conv-a')
    expect(card.textContent).toContain('WhatsApp')
    expect(card.textContent).toContain('conv-a')
    expect(card.textContent).toContain('personal')
  })

  it('agent card renders the honest empty when the checkpoint registry has no session', async () => {
    const { container, getByTestId } = renderInbox()
    await waitFor(() => expect(container.querySelector('.inbox-citem')).not.toBeNull())
    fireEvent.click(container.querySelector('.inbox-citem')!)
    await waitFor(() => expect(getByTestId('inbox-agent-card')).toBeDefined())
    expect(getByTestId('inbox-agent-card').textContent).toContain('no agent session recorded')
  })

  it('agent card renders the real session status when a checkpoint exists', async () => {
    getCheckpointsMock.mockResolvedValue({
      observedAt: '',
      checkpoints: [
        {
          conversationKey: 'conv-a',
          sessionId: 'sess-1',
          sessionStatus: 'active',
          checkpointVersion: 1,
          claudePid: 1234,
          workspacePath: null,
          createdAt: '',
          updatedAt: '',
          completedScope: null,
          completedDeliveryJid: null,
          completedLogicalTurnId: null,
          resumable: true,
        },
      ],
    })
    const { container, getByTestId } = renderInbox()
    await waitFor(() => expect(container.querySelector('.inbox-citem')).not.toBeNull())
    fireEvent.click(container.querySelector('.inbox-citem')!)
    await waitFor(() =>
      expect(getByTestId('inbox-agent-card').textContent).toContain('session active'),
    )
    expect(getByTestId('inbox-agent-card').textContent).toContain('resumable')
  })

  it('line card renders live state, transport, access mode, and mode', async () => {
    const { container } = renderInbox()
    await waitFor(() => expect(container.querySelector('.inbox-citem')).not.toBeNull())
    fireEvent.click(container.querySelector('.inbox-citem')!)
    await waitFor(() => expect(container.querySelector('.inbox-badge')).not.toBeNull())
    const badges = [...container.querySelectorAll('.inbox-pcard')]
    const lineCard = badges[badges.length - 1]!
    expect(lineCard.textContent).toContain('live')
    expect(lineCard.textContent).toContain('WhatsApp')
    expect(lineCard.textContent).toContain('allowlist')
    expect(lineCard.textContent).toContain('chat')
  })
})

// ---------------------------------------------------------------------------
// Deep links (?line=&chat=) — same contract the v3 page honored
// ---------------------------------------------------------------------------

describe('v3.5 inbox — deep links', () => {
  it('selects the linked conversation once', async () => {
    const { container } = renderInbox(['/inbox?line=personal&chat=conv-a'])
    await waitFor(() => expect(container.querySelector('.inbox-thead')).not.toBeNull())
    expect(container.querySelector('.inbox-thead__nm')!.textContent).toBe('Chat conv-a')
  })
})
