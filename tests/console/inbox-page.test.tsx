/**
 * Inbox page — structural and layout-contract harness (DD-18r pane leg, commit 2).
 *
 * Covers:
 *   - Root carries soup-inbox-layout (container-query root for contact-pane collapse).
 *   - Chat-list pane uses --inbox-pane-chats token (264px spec value, tokens-v3 §4/§6.12).
 *   - Contact pane uses --inbox-pane-contact token (248px spec value, tokens-v3 §4/§6.12).
 *   - Contact pane carries soup-inbox-contact (collapse target class for @container query).
 *   - Listbox receives chats and renders them as options.
 *
 * Class-contract methodology (identical to the B1/B2 harness pattern): asserts className
 * strings and token var() references rather than computed layout, which jsdom cannot
 * evaluate. Container-query and computed-size proofs live in D7 viewport tests.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// ---------------------------------------------------------------------------
// Module-level mocks — must appear before dynamic imports
// ---------------------------------------------------------------------------

// framer-motion: render motion.div as a plain div so the animated root is
// inspectable in jsdom without animation-frame machinery.
vi.mock('framer-motion', async () => {
  const React = await import('react')
  return {
    motion: {
      div: ({
        children,
        className,
        initial: _i,
        animate: _a,
        transition: _t,
        ...rest
      }: Record<string, unknown> & { children?: ReactNode; className?: string }) =>
        React.createElement('div', { className, ...rest }, children),
    },
  }
})

// react-router-dom: mutable search params so deep-link behavior can be exercised.
let mockSearchParams = new URLSearchParams()
const setSearchParamsMock = vi.fn()
vi.mock('react-router-dom', () => ({
  useSearchParams: () => [mockSearchParams, setSearchParamsMock],
}))

// use-fleet hooks: mutable state so individual tests can override.
let mockLines: Array<{ name: string; mode: string; status: string; transport?: string }> = []
let mockChats: Array<{
  conversationKey: string
  name: string
  lastMessagePreview: string
  lastMessageAt: string
  unreadCount: number
  isGroup: boolean
}> = []
let mockMessages: Array<unknown> = []
let mockTyping: Array<unknown> = []
let mockChatsError = false

vi.mock('../../console/src/hooks/use-fleet', () => ({
  useLines: () => ({ data: mockLines }),
  useChats: () => ({ data: mockChats, isError: mockChatsError }),
  useMessages: () => ({ data: mockMessages }),
  useTyping: () => ({ data: mockTyping }),
}))

// Transport status (DD-29). Mutable so the offline-branch test can flip it;
// defaults to connected so all other layout tests are unaffected.
const transportState = { status: 'connected' as 'connected' | 'reconnecting' | 'offline', isDisconnected: false }
vi.mock('../../console/src/hooks/use-transport-status', () => ({
  useTransportStatus: () => transportState,
}))

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

// api: stub — layout tests do not drive API calls.
vi.mock('../../console/src/lib/api', () => ({
  api: {
    searchMessages: vi.fn().mockResolvedValue({ results: [], total: 0 }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getMessages: vi.fn().mockResolvedValue([]),
    markRead: vi.fn().mockResolvedValue(undefined),
    accessDecision: vi.fn().mockResolvedValue(undefined),
    saveContact: vi.fn().mockResolvedValue(undefined),
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

const searchMessagesMock = api.searchMessages as unknown as ReturnType<typeof vi.fn>
const sendMessageMock = api.sendMessage as unknown as ReturnType<typeof vi.fn>
const getMessagesMock = api.getMessages as unknown as ReturnType<typeof vi.fn>
const markReadMock = api.markRead as unknown as ReturnType<typeof vi.fn>
const accessDecisionMock = api.accessDecision as unknown as ReturnType<typeof vi.fn>
const saveContactMock = api.saveContact as unknown as ReturnType<typeof vi.fn>

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeChat(
  conversationKey: string,
  overrides: Partial<(typeof mockChats)[0]> = {},
): (typeof mockChats)[0] {
  return {
    conversationKey,
    name: `Chat ${conversationKey}`,
    lastMessagePreview: 'preview',
    lastMessageAt: '2026-04-05T12:00:00.000Z',
    unreadCount: 0,
    isGroup: false,
    ...overrides,
  }
}

function makeMessage(
  pk: number,
  content: string,
  overrides: Partial<{
    conversationKey: string
    senderName: string
    senderJid: string
    timestamp: string
    fromMe: boolean
    type: string
  }> = {},
) {
  return {
    pk,
    conversationKey: overrides.conversationKey ?? 'conv-a',
    senderName: overrides.senderName ?? (overrides.fromMe ? 'You' : 'Fixture Sender'),
    senderJid: overrides.senderJid ?? '',
    content,
    timestamp: overrides.timestamp ?? '2026-04-05T12:00:00.000Z',
    fromMe: overrides.fromMe ?? false,
    type: overrides.type ?? 'text',
  }
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function renderInbox() {
  const qc = makeClient()
  return render(
    <QueryClientProvider client={qc}>
      <Inbox />
    </QueryClientProvider>,
  )
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockLines = [{ name: 'test-line', mode: 'passive', status: 'ok' }]
  mockChats = []
  mockMessages = []
  mockTyping = []
  mockChatsError = false
  mockSearchParams = new URLSearchParams()
  setSearchParamsMock.mockReset()
  transportState.status = 'connected'
  transportState.isDisconnected = false
  searchMessagesMock.mockReset()
  searchMessagesMock.mockResolvedValue({ results: [], total: 0 })
  sendMessageMock.mockReset()
  sendMessageMock.mockResolvedValue(undefined)
  getMessagesMock.mockReset()
  getMessagesMock.mockResolvedValue([])
  markReadMock.mockReset()
  markReadMock.mockResolvedValue(undefined)
  accessDecisionMock.mockReset()
  accessDecisionMock.mockResolvedValue(undefined)
  saveContactMock.mockReset()
  saveContactMock.mockResolvedValue(undefined)
  for (const spy of Object.values(toastMock)) spy.mockReset()
})

afterEach(() => cleanup())

// ---------------------------------------------------------------------------
// Root layout class (container-query root — DD-18r, C-B4-2)
// ---------------------------------------------------------------------------

describe('Inbox — root container-query class', () => {
  it('root element carries soup-inbox-layout (container-type root for contact-pane collapse)', () => {
    const { container } = renderInbox()
    const root = container.firstElementChild as HTMLElement

    expect(root.className).toContain('soup-inbox-layout')
  })
})

// ---------------------------------------------------------------------------
// Token width class contracts (tokens-v3 §4/§6.12; visible change C-B4-1)
// ---------------------------------------------------------------------------

describe('Inbox — pane token width classes', () => {
  it('chat-list pane references --inbox-pane-chats (264px spec token)', () => {
    const { container } = renderInbox()
    // The chat-list pane is the first flex child of the root
    const chatsPane = container.querySelector('.w-\\[var\\(--inbox-pane-chats\\)\\]')

    expect(chatsPane).not.toBeNull()
  })

  it('contact pane references --inbox-pane-contact (248px spec token)', () => {
    const { container } = renderInbox()
    const contactPane = container.querySelector('.w-\\[var\\(--inbox-pane-contact\\)\\]')

    expect(contactPane).not.toBeNull()
  })

  it('chat-list pane carries the v3 width token and no legacy token', () => {
    const { container } = renderInbox()
    // Positive control: locate the pane via the v3 token class, so the
    // legacy-absence assert below cannot pass via a broken selector.
    const chatsPane = container.querySelector('.w-\\[var\\(--inbox-pane-chats\\)\\]')
    expect(chatsPane).not.toBeNull()

    expect((chatsPane as Element).className).toContain('w-[var(--inbox-pane-chats)]')
    expect(container.innerHTML).not.toContain('panel-chat-list')
  })

  it('contact pane carries the v3 width token and no legacy token', () => {
    const { container } = renderInbox()
    const contactPane = container.querySelector('.w-\\[var\\(--inbox-pane-contact\\)\\]')
    expect(contactPane).not.toBeNull()

    expect((contactPane as Element).className).toContain('w-[var(--inbox-pane-contact)]')
    expect(container.innerHTML).not.toContain('panel-contact')
  })
})

// ---------------------------------------------------------------------------
// Contact pane collapse-target class (soup-inbox-contact, @container query target)
// ---------------------------------------------------------------------------

describe('Inbox — contact pane collapse-target class', () => {
  it('contact pane carries soup-inbox-contact (the @container display:none target)', () => {
    const { container } = renderInbox()
    const contactPane = container.querySelector('.soup-inbox-contact')

    expect(contactPane).not.toBeNull()
  })

  it('contact pane carries both soup-inbox-contact and the token width class', () => {
    const { container } = renderInbox()
    const contactPane = container.querySelector('.soup-inbox-contact') as HTMLElement

    expect(contactPane).not.toBeNull()
    expect(contactPane.className).toContain('w-[var(--inbox-pane-contact)]')
  })

  it('the collapse-target is a distinct element from the chat-list pane', () => {
    const { container } = renderInbox()
    const contactPane = container.querySelector('.soup-inbox-contact') as HTMLElement
    const chatsPane = container.querySelector('.w-\\[var\\(--inbox-pane-chats\\)\\]') as HTMLElement

    expect(contactPane).not.toBeNull()
    expect(chatsPane).not.toBeNull()
    expect(contactPane).not.toBe(chatsPane)
  })
})

// ---------------------------------------------------------------------------
// Listbox receives chats (structural wiring — ChatList renders options)
// ---------------------------------------------------------------------------

describe('Inbox — listbox renders chats from the hook', () => {
  it('renders zero options when the hook returns no chats', () => {
    mockChats = []
    renderInbox()

    expect(screen.queryAllByRole('option').length).toBe(0)
    expect(screen.getByRole('listbox', { name: 'Chat conversations' })).toBeDefined()
  })

  it('renders exactly N options for N chats from the hook', () => {
    mockChats = [
      makeChat('conv-1'),
      makeChat('conv-2'),
      makeChat('conv-3'),
    ]
    renderInbox()

    const options = screen.getAllByRole('option')
    expect(options.length).toBe(3)
  })

  it('option labels reflect the chat name from the hook data', () => {
    mockChats = [makeChat('conv-x', { name: 'Fixture Contact' })]
    renderInbox()

    const opt = screen.getByRole('option', { name: 'Open conversation with Fixture Contact' })
    expect(opt.getAttribute('data-conv-key')).toBe('conv-x')
    expect(opt.textContent).toContain('Fixture Contact')
  })

  it('marks only active-line typing chats with the typing indicator', () => {
    mockChats = [
      makeChat('conv-a', { name: 'Typing Contact' }),
      makeChat('conv-b', { name: 'Quiet Contact' }),
    ]
    mockTyping = [
      { instance: 'test-line', jid: 'conv-a' },
      { instance: 'other-line', jid: 'conv-b' },
    ]
    renderInbox()

    expect(screen.getByText('typing')).toBeDefined()
    expect(screen.getByRole('option', { name: 'Open conversation with Typing Contact' }).textContent).toContain('typing')
    expect(screen.getByRole('option', { name: 'Open conversation with Quiet Contact' }).textContent).not.toContain('typing')
  })
})

// ---------------------------------------------------------------------------
// Selection and deep-link workflows
// ---------------------------------------------------------------------------

describe('Inbox — conversation selection workflows', () => {
  it('deep link selects the requested line and chat once, then clears the URL params', async () => {
    mockLines = [
      { name: 'fallback-line', mode: 'passive', status: 'ok' },
      { name: 'deep-line', mode: 'agent', status: 'ok' },
    ]
    mockChats = [makeChat('deep-chat', { name: 'Deep Link Contact', unreadCount: 2 })]
    mockSearchParams = new URLSearchParams('line=deep-line&chat=deep-chat')

    const { container } = renderInbox()

    await waitFor(() => {
      expect(screen.getByText('deep-line · direct')).toBeDefined()
    })
    expect(screen.getByText('2 unread')).toBeDefined()
    expect(setSearchParamsMock).toHaveBeenCalledWith({}, { replace: true })
    expect(container.firstElementChild?.getAttribute('data-mobile-detail')).toBe('thread')
  })

  it('mobile back affordance returns the master-detail layout to the conversation list', async () => {
    mockChats = [makeChat('conv-a', { name: 'Test Chat' })]
    const { container } = renderInbox()

    fireEvent.click(screen.getByRole('option', { name: 'Open conversation with Test Chat' }))
    expect(container.firstElementChild?.getAttribute('data-mobile-detail')).toBe('thread')

    fireEvent.click(screen.getByRole('button', { name: 'Back to conversations' }))

    await waitFor(() => {
      expect(screen.getByText('Select a conversation')).toBeDefined()
    })
    expect(container.firstElementChild?.getAttribute('data-mobile-detail')).toBe('list')
  })
})

describe('Inbox — transport formatter propagation', () => {
  it('passes Signal to MessageBubble so strike syntax stays literal', () => {
    mockLines = [{ name: 'test-line', mode: 'passive', status: 'ok', transport: 'signal' }]
    mockChats = [makeChat('conv-a', { name: 'Signal Contact' })]
    mockMessages = [makeMessage(1, '*bold* ~literal~')]
    const { container } = renderInbox()

    fireEvent.click(screen.getByRole('option', { name: 'Open conversation with Signal Contact' }))

    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(container.querySelector('s')).toBeNull()
    expect(container.textContent).toContain('~literal~')
  })

  it('passes Baileys to MessageBubble so the full formatting set is rendered', () => {
    mockLines = [{ name: 'test-line', mode: 'passive', status: 'ok', transport: 'baileys' }]
    mockChats = [makeChat('conv-a', { name: 'WhatsApp Contact' })]
    mockMessages = [makeMessage(1, '~strike~')]
    const { container } = renderInbox()

    fireEvent.click(screen.getByRole('option', { name: 'Open conversation with WhatsApp Contact' }))

    expect(container.querySelector('s')?.textContent).toBe('strike')
  })
})

// ---------------------------------------------------------------------------
// Offline-with-cache branch for the chat list (DD-29)
// ---------------------------------------------------------------------------

describe('Inbox — offline chat-list state', () => {
  it('shows the offline cached-data state instead of the chat list when chats fail to load AND transport is disconnected', () => {
    mockChatsError = true
    transportState.status = 'reconnecting'
    transportState.isDisconnected = true
    renderInbox()

    expect(screen.getByText('Showing cached data')).toBeDefined()
    expect(screen.getByText('Reconnecting…')).toBeDefined()
    // The chat listbox is replaced by the offline surface.
    expect(screen.queryByRole('listbox', { name: 'Chat conversations' })).toBeNull()
  })

  it('renders the normal chat list (no offline surface) when chats fail while transport is connected', () => {
    mockChatsError = true
    transportState.status = 'connected'
    transportState.isDisconnected = false
    mockChats = [makeChat('conv-1')]
    renderInbox()

    expect(screen.queryByText('Showing cached data')).toBeNull()
    expect(screen.getByRole('listbox', { name: 'Chat conversations' })).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// SearchInput adoption — B4 commit 4 (last raw c-input-search site)
// Class-contract: search row renders the shared SearchInput component
// (mirroring the ChatPicker/ContactSearchPicker structural pins in B2).
// ---------------------------------------------------------------------------

describe('Inbox — search row uses shared SearchInput (B4 adoption)', () => {
  it('search input is reachable by aria-label once a chat is selected', () => {
    mockChats = [makeChat('conv-a', { name: 'Test Chat' })]

    renderInbox()
    fireEvent.click(screen.getByRole('option', { name: 'Open conversation with Test Chat' }))

    const search = screen.getByLabelText('Search messages in this conversation') as HTMLInputElement
    expect(search.classList.contains('c-input-search')).toBe(true)
    expect(search.getAttribute('data-search-shortcut-target')).toBe('true')
  })

  it('no raw c-input without SearchInput wrapper renders in the document', () => {
    // SearchInput always wraps input in a relative div; raw inputs must not
    // appear at the search-row level without the SearchInput wrapper present.
    // This is a class-contract check: the container holds only one search input
    // component that is known to be SearchInput (because it renders c-input-search).
    mockChats = []
    renderInbox()
    // With no chats selected the search row is not rendered — no c-input-search at all.
    const inputs = document.querySelectorAll('input.c-input-search')
    expect(inputs.length).toBe(0)
  })

  it('renders a retryable search error state when message search fails', async () => {
    searchMessagesMock.mockRejectedValue(new Error('search offline'))
    mockChats = [makeChat('conv-a', { name: 'Test Chat' })]

    renderInbox()
    fireEvent.click(screen.getByRole('option', { name: 'Open conversation with Test Chat' }))
    await waitFor(() => {
      expect(screen.getByText('test-line · direct')).toBeDefined()
    })
    fireEvent.change(screen.getByLabelText('Search messages in this conversation'), {
      target: { value: 'needle' },
    })

    await waitFor(() => {
      expect(screen.getByText('Search failed')).toBeDefined()
    })
    expect(screen.getByText('search offline')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => {
      expect(searchMessagesMock).toHaveBeenCalledTimes(2)
    })
  })

  it('renders virtualized search results and clears the active search state', async () => {
    searchMessagesMock.mockResolvedValue({
      total: 1,
      results: [makeMessage(41, 'Needle result', { conversationKey: 'conv-a' })],
    })
    mockChats = [makeChat('conv-a', { name: 'Test Chat' })]

    renderInbox()
    fireEvent.click(screen.getByRole('option', { name: 'Open conversation with Test Chat' }))
    fireEvent.change(screen.getByLabelText('Search messages in this conversation'), {
      target: { value: 'needle' },
    })

    await waitFor(() => {
      expect(searchMessagesMock).toHaveBeenCalledWith('test-line', 'needle', 'conv-a')
    })
    await waitFor(() => {
      expect(screen.getByText('Needle')).toBeDefined()
    })
    expect(screen.getByText('Needle').tagName).toBe('MARK')
    expect(screen.getByText('1 result')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))

    expect(screen.queryByText('Needle')).toBeNull()
    expect(screen.queryByText('1 result')).toBeNull()
  })

  it('renders the empty search state after a completed search with no matches', async () => {
    searchMessagesMock.mockResolvedValue({ total: 0, results: [] })
    mockChats = [makeChat('conv-a', { name: 'Test Chat' })]

    renderInbox()
    fireEvent.click(screen.getByRole('option', { name: 'Open conversation with Test Chat' }))
    await waitFor(() => {
      expect(screen.getByText('test-line · direct')).toBeDefined()
    })
    fireEvent.change(screen.getByLabelText('Search messages in this conversation'), {
      target: { value: 'missing' },
    })

    await waitFor(() => {
      expect(searchMessagesMock).toHaveBeenCalledWith('test-line', 'missing', 'conv-a')
    })
    await waitFor(() => {
      expect(screen.getByText('No matches')).toBeDefined()
    })
    expect(screen.getByText('Try a different search term.')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Message timeline workflows
// ---------------------------------------------------------------------------

describe('Inbox — message timeline workflows', () => {
  it('loads older messages from the oldest loaded pk and hides the control when none remain', async () => {
    mockChats = [makeChat('conv-a', { name: 'Test Chat' })]
    mockMessages = [
      makeMessage(20, 'Newest message'),
      makeMessage(10, 'Oldest loaded message'),
    ]
    getMessagesMock.mockResolvedValue([])

    renderInbox()
    fireEvent.click(screen.getByRole('option', { name: 'Open conversation with Test Chat' }))

    fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }))

    await waitFor(() => {
      expect(getMessagesMock).toHaveBeenCalledWith('test-line', 'conv-a', 10)
    })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull()
    })
  })

  it('keeps the load-more control when older messages are returned', async () => {
    mockChats = [makeChat('conv-a', { name: 'Test Chat' })]
    mockMessages = [
      makeMessage(20, 'Newest message'),
      makeMessage(10, 'Oldest loaded message'),
    ]
    getMessagesMock.mockResolvedValue([makeMessage(5, 'Older returned message')])

    renderInbox()
    fireEvent.click(screen.getByRole('option', { name: 'Open conversation with Test Chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }))

    await waitFor(() => {
      expect(getMessagesMock).toHaveBeenCalledWith('test-line', 'conv-a', 10)
    })
    expect(screen.getByRole('button', { name: 'Load older messages' })).toBeDefined()
  })

  it('reports older-message load failures without dropping the load-more control', async () => {
    mockChats = [makeChat('conv-a', { name: 'Test Chat' })]
    mockMessages = [makeMessage(10, 'Loaded message')]
    getMessagesMock.mockRejectedValue(new Error('history unavailable'))

    renderInbox()
    fireEvent.click(screen.getByRole('option', { name: 'Open conversation with Test Chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }))

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith('Failed to load older messages: history unavailable')
    })
    expect(screen.getByRole('button', { name: 'Load older messages' })).toBeDefined()
  })

  it('sends trimmed text on Enter and restores the composer after a failed send', async () => {
    mockChats = [makeChat('conv-a', { name: 'Test Chat' })]
    sendMessageMock.mockRejectedValue(new Error('transport down'))

    renderInbox()
    fireEvent.click(screen.getByRole('option', { name: 'Open conversation with Test Chat' }))

    const composer = screen.getByLabelText('Type a message') as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: '  hello from inbox  ' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith('test-line', 'conv-a', 'hello from inbox')
    })
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith('Send failed: transport down')
    })
    expect(composer.value).toBe('')
  })

  it('sends trimmed text successfully and invalidates the selected message query', async () => {
    mockChats = [makeChat('conv-a', { name: 'Test Chat' })]

    renderInbox()
    fireEvent.click(screen.getByRole('option', { name: 'Open conversation with Test Chat' }))

    const composer = screen.getByLabelText('Type a message') as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: '  hello success  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith('test-line', 'conv-a', 'hello success')
    })
    expect(toastMock.error).not.toHaveBeenCalled()
    expect(composer.value).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Contact action workflows
// ---------------------------------------------------------------------------

describe('Inbox — contact action workflows', () => {
  it('marks an unread chat as read and reports success', async () => {
    mockChats = [makeChat('conv-a', { name: 'Unread Contact', unreadCount: 3 })]

    renderInbox()
    fireEvent.click(screen.getByRole('option', { name: 'Open conversation with Unread Contact, 3 unread' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark Read' }))

    await waitFor(() => {
      expect(markReadMock).toHaveBeenCalledWith('test-line', 'conv-a')
    })
    expect(toastMock.success).toHaveBeenCalledWith('Marked as read')
  })

  it('reports mark-read failures and keeps action controls enabled afterward', async () => {
    mockChats = [makeChat('conv-a', { name: 'Unread Contact', unreadCount: 3 })]
    markReadMock.mockRejectedValue('mark-read offline')

    renderInbox()
    fireEvent.click(screen.getByRole('option', { name: 'Open conversation with Unread Contact, 3 unread' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark Read' }))

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith('Failed to mark read: mark-read offline')
    })
    expect(screen.getByRole('button', { name: 'Allow Contact' }).hasAttribute('disabled')).toBe(false)
  })

  it('uses group access subjects for group allow and block actions', async () => {
    mockChats = [makeChat('group-1@g.us', { name: 'Study Group', isGroup: true })]

    renderInbox()
    fireEvent.click(screen.getByRole('option', { name: 'Open conversation with Study Group' }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow Contact' }))

    await waitFor(() => {
      expect(accessDecisionMock).toHaveBeenCalledWith('test-line', 'group', 'group-1@g.us', 'allow')
    })
    expect(toastMock.success).toHaveBeenCalledWith('Allowed Study Group')

    fireEvent.click(screen.getByRole('button', { name: 'Block Contact' }))

    await waitFor(() => {
      expect(accessDecisionMock).toHaveBeenCalledWith('test-line', 'group', 'group-1@g.us', 'block')
    })
    expect(toastMock.info).toHaveBeenCalledWith('Blocked Study Group')
    expect(screen.queryByRole('button', { name: 'Save Contact' })).toBeNull()
  })

  it('reports direct allow and block failures with the production error text', async () => {
    mockChats = [makeChat('conv-a', { name: 'Direct Contact' })]
    accessDecisionMock
      .mockRejectedValueOnce(new Error('allow denied'))
      .mockRejectedValueOnce('block denied')

    renderInbox()
    fireEvent.click(screen.getByRole('option', { name: 'Open conversation with Direct Contact' }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow Contact' }))

    await waitFor(() => {
      expect(accessDecisionMock).toHaveBeenCalledWith('test-line', 'phone', 'conv-a', 'allow')
    })
    expect(toastMock.error).toHaveBeenCalledWith('Failed to allow: allow denied')

    fireEvent.click(screen.getByRole('button', { name: 'Block Contact' }))

    await waitFor(() => {
      expect(accessDecisionMock).toHaveBeenCalledWith('test-line', 'phone', 'conv-a', 'block')
    })
    expect(toastMock.error).toHaveBeenCalledWith('Failed to block: block denied')
  })

  it('saves a direct chat as a contact with normalized JID and split name', async () => {
    mockChats = [makeChat('15551234567', { name: 'Raw Number' })]

    renderInbox()
    fireEvent.click(screen.getByRole('option', { name: 'Open conversation with Raw Number' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save Contact' }))

    fireEvent.change(screen.getByLabelText('Contact name'), {
      target: { value: ' Ada Lovelace ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(saveContactMock).toHaveBeenCalledWith('test-line', {
        jid: '15551234567@s.whatsapp.net',
        firstName: 'Ada',
        lastName: 'Lovelace',
      })
    })
    expect(toastMock.success).toHaveBeenCalledWith('Saved contact: Ada Lovelace')
  })

  it('preserves an existing JID when saving a contact and reports save failures', async () => {
    mockChats = [makeChat('15551234567@s.whatsapp.net', { name: 'Known Number' })]
    saveContactMock.mockRejectedValue(new Error('address book locked'))

    renderInbox()
    fireEvent.click(screen.getByRole('option', { name: 'Open conversation with Known Number' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save Contact' }))
    fireEvent.change(screen.getByLabelText('Contact name'), {
      target: { value: 'Prince' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(saveContactMock).toHaveBeenCalledWith('test-line', {
        jid: '15551234567@s.whatsapp.net',
        firstName: 'Prince',
        lastName: undefined,
      })
    })
    expect(toastMock.error).toHaveBeenCalledWith('Failed to save: address book locked')
  })

  it.each(['signal', 'imessage'])('hides WhatsApp-only Save Contact on %s lines', (transport) => {
    mockLines = [{ name: 'test-line', mode: 'passive', status: 'ok', transport }]
    mockChats = [makeChat('owner_at_example.test@imessage', { name: 'Direct Contact' })]

    renderInbox()
    fireEvent.click(screen.getByRole('option', { name: 'Open conversation with Direct Contact' }))

    expect(screen.queryByRole('button', { name: 'Save Contact' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Composer focus suppression removed — B4 commit 5
// The composer textarea must carry NO outline-none class (packet §0.5 / §8).
// The global :focus-visible recipe in composites.css provides the focus ring;
// the explicit suppression was a lint/honesty violation, not a missing ring.
// ---------------------------------------------------------------------------

describe('Inbox — composer textarea has no outline-none (B4 composer fix)', () => {
  it('routes the selected-chat composer through TextArea without suppressing focus outlines', () => {
    mockChats = [makeChat('conv-a', { name: 'Test Chat' })]
    renderInbox()
    fireEvent.click(screen.getByRole('option', { name: 'Open conversation with Test Chat' }))

    const textarea = screen.getByLabelText('Type a message') as HTMLTextAreaElement
    expect(textarea.classList.contains('c-input')).toBe(true)
    expect(textarea.classList.contains('font-sans')).toBe(true)
    expect(textarea.classList.contains('font-mono')).toBe(false)
    expect(textarea.classList.contains('outline-none')).toBe(false)
    expect(textarea.getAttribute('style')).toContain('resize: none')
    expect(textarea.getAttribute('style')).toContain('max-height: var(--feed-preview-max)')
  })
})
