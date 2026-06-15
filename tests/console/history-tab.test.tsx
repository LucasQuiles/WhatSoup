/**
 * HistoryTab — chat-list rendering, empty/no-selection state, message panel,
 * send happy path + error rollback, optimistic update, load-older pagination,
 * Enter-key send, and typing-indicator pass-through.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// ---------------------------------------------------------------------------
// Mocks — must appear before dynamic imports
// ---------------------------------------------------------------------------

vi.mock('../../console/src/lib/api', () => ({
  api: {
    getMessages: vi.fn(),
    sendMessage: vi.fn(),
  },
}))

// SOURCE SURPRISE §1: useVirtualMessages / useStickyScroll use ResizeObserver and
// scrollHeight which don't exist in jsdom. Mock the entire virtualization hook to
// return a simple stub virtualizer that surfaces all messages as virtual items.
vi.mock('../../console/src/hooks/use-virtual-messages', () => ({
  useVirtualMessages: ({ messages }: { messages: Array<{ pk: number }> }) => ({
    getVirtualItems: () => messages.map((_, i) => ({ index: i, key: i, start: i * 80, size: 80 })),
    getTotalSize: () => messages.length * 80,
    measureElement: () => {},
  }),
}))

// SOURCE SURPRISE §2: useStickyScroll uses useLayoutEffect + ResizeObserver.
// Mock it so tests can control showJump visibility without JSDOM scroll state.
const stickyScrollState = {
  showJump: false,
}
vi.mock('../../console/src/hooks/use-sticky-scroll', () => ({
  useStickyScroll: () => ({
    scrollRef: { current: null },
    showJump: stickyScrollState.showJump,
    handleScroll: vi.fn(),
    jumpToBottom: vi.fn(),
  }),
}))

import { HistoryTab } from '../../console/src/components/line-detail/HistoryTab'
import { api } from '../../console/src/lib/api'
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context'
import type { ChatItem, Message } from '../../console/src/types'

const getMessagesMock = api.getMessages as unknown as ReturnType<typeof vi.fn>
const sendMessageMock = api.sendMessage as unknown as ReturnType<typeof vi.fn>

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Repo convention: 1555-prefixed phone JIDs / short 120363NNN group JIDs.
function makeChat(overrides: Partial<ChatItem> = {}): ChatItem {
  return {
    conversationKey: '15555550001@s.whatsapp.net',
    name: 'Alice',
    lastMessagePreview: 'Hey!',
    lastMessageAt: '2026-05-12T10:00:00Z',
    unreadCount: 0,
    isGroup: false,
    ...overrides,
  }
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    pk: 1,
    conversationKey: '15555550001@s.whatsapp.net',
    senderName: 'Alice',
    senderJid: '15555550001@s.whatsapp.net',
    content: 'Hello!',
    timestamp: '2026-05-12T10:00:00Z',
    fromMe: false,
    type: 'text',
    ...overrides,
  }
}

const CHAT_A = makeChat({ conversationKey: '15555550001@s.whatsapp.net', name: 'Alice' })
const CHAT_B = makeChat({ conversationKey: '15555550002@s.whatsapp.net', name: 'Bob', isGroup: false })
const GROUP_CHAT = makeChat({ conversationKey: '120363001@g.us', name: 'Team Chat', isGroup: true })

const MSG_1 = makeMessage({ pk: 101, content: 'Hi there', fromMe: false })
const MSG_2 = makeMessage({ pk: 102, content: 'How are you?', fromMe: true })

let toastValue: ToastContextValue

function makeToast(): ToastContextValue {
  return {
    toast: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
    clear: vi.fn(),
  }
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function withProviders(node: ReactElement, client?: QueryClient) {
  const qc = client ?? makeClient()
  return (
    <QueryClientProvider client={qc}>
      <ToastContext.Provider value={toastValue}>{node}</ToastContext.Provider>
    </QueryClientProvider>
  )
}

function defaultProps(overrides: Partial<Parameters<typeof HistoryTab>[0]> = {}) {
  return {
    chats: [CHAT_A, CHAT_B],
    messages: [MSG_1, MSG_2],
    selectedChat: CHAT_A.conversationKey,
    onSelectChat: vi.fn(),
    mode: 'passive' as const,
    lineName: 'demo-line',
    typingJids: new Set<string>(),
    ...overrides,
  }
}

function getChatOption(name: string) {
  return screen.getByRole('option', { name: `Open conversation with ${name}` })
}

function getRenderedBubble(container: HTMLElement, text: string) {
  const bubble = screen.getByText(text).closest('.c-msg-bubble')
  expect(bubble).not.toBeNull()
  expect(container.contains(bubble)).toBe(true)
  return bubble as HTMLElement
}

function getLoadOlderButton() {
  return screen.getByRole('button', { name: 'Load older messages' })
}

beforeEach(() => {
  getMessagesMock.mockReset()
  sendMessageMock.mockReset()
  toastValue = makeToast()
  stickyScrollState.showJump = false
})

afterEach(() => cleanup())

// ---------------------------------------------------------------------------
// 1. Chat list rendering
// ---------------------------------------------------------------------------

describe('HistoryTab — chat list', () => {
  it('renders a ChatListItem for each chat in the list', () => {
    render(withProviders(<HistoryTab {...defaultProps()} />))

    const items = screen.getAllByRole('option')
    expect(items).toHaveLength(2)
    expect(getChatOption('Alice')).toBeDefined()
    expect(getChatOption('Bob')).toBeDefined()
  })

  it('shows "Conversations" heading and chat count in the sidebar', () => {
    render(withProviders(<HistoryTab {...defaultProps({ chats: [CHAT_A, CHAT_B, GROUP_CHAT] })} />))

    expect(screen.getByText('Conversations')).toBeDefined()
    expect(screen.getByText('3 chats')).toBeDefined()
  })

  it('marks the selected chat with data-selected=true and all others as false', () => {
    render(withProviders(<HistoryTab {...defaultProps({ selectedChat: CHAT_B.conversationKey })} />))

    expect(getChatOption('Alice').getAttribute('aria-selected')).toBe('false')
    expect(getChatOption('Bob').getAttribute('aria-selected')).toBe('true')
  })

  it('calls onSelectChat with the conversationKey when a chat item is clicked', () => {
    const onSelectChat = vi.fn()
    render(withProviders(<HistoryTab {...defaultProps({ onSelectChat })} />))

    fireEvent.click(screen.getByText('Bob'))

    expect(onSelectChat).toHaveBeenCalledTimes(1)
    expect(onSelectChat).toHaveBeenCalledWith(CHAT_B.conversationKey)
  })

  it('renders an empty list without errors when chats=[]', () => {
    render(withProviders(<HistoryTab {...defaultProps({ chats: [], selectedChat: null })} />))

    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText('0 chats')).toBeDefined()
  })

  it('passes isTyping=true to ChatListItem when the jid is in typingJids', () => {
    const typingJids = new Set([CHAT_A.conversationKey])
    render(withProviders(<HistoryTab {...defaultProps({ typingJids })} />))

    const aliceItem = getChatOption('Alice')
    const bobItem = getChatOption('Bob')

    expect(aliceItem.textContent).toContain('typing')
    expect(aliceItem.textContent).not.toContain(CHAT_A.lastMessagePreview)
    expect(bobItem.textContent).not.toContain('typing')
    expect(bobItem.textContent).toContain(CHAT_B.lastMessagePreview)
  })

  it('handles group JIDs correctly alongside phone JIDs', () => {
    const onSelectChat = vi.fn()
    render(withProviders(<HistoryTab {...defaultProps({ chats: [CHAT_A, GROUP_CHAT], onSelectChat })} />))

    const items = screen.getAllByRole('option')
    expect(items).toHaveLength(2)
    fireEvent.click(getChatOption('Team Chat'))
    expect(onSelectChat).toHaveBeenCalledWith('120363001@g.us')
  })
})

// ---------------------------------------------------------------------------
// 2. No-selection empty state
// ---------------------------------------------------------------------------

describe('HistoryTab — no-selection empty state', () => {
  it('renders the EmptyState when selectedChat is null', () => {
    render(withProviders(<HistoryTab {...defaultProps({ selectedChat: null })} />))

    expect(screen.getByText('No messages yet')).toBeDefined()
    expect(screen.getByText('Select a conversation from the list to view messages.')).toBeDefined()
  })

  it('does not render a textarea or Send button when selectedChat is null', () => {
    render(withProviders(<HistoryTab {...defaultProps({ selectedChat: null })} />))

    expect(screen.queryByPlaceholderText('Type a reply...')).toBeNull()
    expect(screen.queryByRole('button', { name: /Send/i })).toBeNull()
  })

  it('renders the message panel when a chat is selected', () => {
    render(withProviders(<HistoryTab {...defaultProps()} />))

    expect(screen.queryByText('No messages yet')).toBeNull()
    expect(screen.getByPlaceholderText('Type a reply...')).toBeDefined()
  })

  it('routes the reply composer through TextArea without suppressing focus outlines', () => {
    render(withProviders(<HistoryTab {...defaultProps()} />))

    const textarea = screen.getByPlaceholderText('Type a reply...') as HTMLTextAreaElement

    expect(textarea.classList.contains('c-input')).toBe(true)
    expect(textarea.classList.contains('font-sans')).toBe(true)
    expect(textarea.classList.contains('outline-none')).toBe(false)
    expect(textarea.getAttribute('style')).toContain('resize: none')
    expect(textarea.getAttribute('style')).toContain('max-height: var(--feed-preview-max)')
  })
})

// ---------------------------------------------------------------------------
// 3. Message rendering
// ---------------------------------------------------------------------------

describe('HistoryTab — message rendering', () => {
  it('renders a MessageBubble for each message in the messages prop', () => {
    const { container } = render(withProviders(<HistoryTab {...defaultProps()} />))

    const bubbles = container.querySelectorAll('.c-msg-bubble')
    expect(bubbles).toHaveLength(2)
  })

  it('renders incoming and outgoing messages with their visible bubble styles', () => {
    const { container } = render(withProviders(<HistoryTab {...defaultProps()} />))

    const incomingBubble = getRenderedBubble(container, 'Hi there')
    const outgoingBubble = getRenderedBubble(container, 'How are you?')

    expect(incomingBubble.className).toContain('bg-d3')
    expect(incomingBubble.getAttribute('style') ?? '').toContain('border-bottom-left-radius')
    expect(outgoingBubble.className).not.toContain('bg-d3')
    expect(outgoingBubble.getAttribute('style') ?? '').toContain('background: var(--m-cht-soft)')
  })

  it('renders message content text in each bubble', () => {
    render(withProviders(<HistoryTab {...defaultProps()} />))

    expect(screen.getByText('Hi there')).toBeDefined()
    expect(screen.getByText('How are you?')).toBeDefined()
  })

  it('renders no bubbles when messages=[]', () => {
    const { container } = render(withProviders(<HistoryTab {...defaultProps({ messages: [] })} />))

    expect(container.querySelectorAll('.c-msg-bubble')).toHaveLength(0)
  })

  it('does not show "Load older messages" when messages list is empty', () => {
    render(withProviders(<HistoryTab {...defaultProps({ messages: [] })} />))

    expect(screen.queryByText('Load older messages')).toBeNull()
  })

  it('shows "Load older messages" button when messages list is non-empty', () => {
    render(withProviders(<HistoryTab {...defaultProps()} />))

    expect(getLoadOlderButton()).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 4. outgoingBg by mode
// ---------------------------------------------------------------------------

describe('HistoryTab — outgoing background by mode', () => {
  it('uses agent soft color for outgoing messages in agent mode', () => {
    const { container } = render(withProviders(<HistoryTab {...defaultProps({ mode: 'agent' })} />))

    const outgoingBubble = getRenderedBubble(container, 'How are you?')
    expect(outgoingBubble.getAttribute('style') ?? '').toContain('background: var(--m-agt-soft)')
  })

  it('uses chat soft color for outgoing messages in passive and chat modes', () => {
    const { container, rerender } = render(withProviders(<HistoryTab {...defaultProps({ mode: 'passive' })} />))

    expect(getRenderedBubble(container, 'How are you?').getAttribute('style') ?? '').toContain('background: var(--m-cht-soft)')

    rerender(withProviders(<HistoryTab {...defaultProps({ mode: 'chat' })} />))

    expect(getRenderedBubble(container, 'How are you?').getAttribute('style') ?? '').toContain('background: var(--m-cht-soft)')
  })
})

// ---------------------------------------------------------------------------
// 5. Send message — happy path with optimistic update
// ---------------------------------------------------------------------------

describe('HistoryTab — send message happy path', () => {
  it('clears the input and calls api.sendMessage after clicking Send', async () => {
    sendMessageMock.mockResolvedValue({ sent: true })

    const client = makeClient()
    render(withProviders(<HistoryTab {...defaultProps()} />, client))

    const textarea = screen.getByPlaceholderText('Type a reply...') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'Hey Bob!' } })
    expect(textarea.value).toBe('Hey Bob!')

    const sendBtn = screen.getByRole('button', { name: /Send/i })
    await act(async () => {
      fireEvent.click(sendBtn)
    })

    expect(sendMessageMock).toHaveBeenCalledTimes(1)
    expect(sendMessageMock).toHaveBeenCalledWith('demo-line', CHAT_A.conversationKey, 'Hey Bob!')
    expect(textarea.value).toBe('')
  })

  it('injects an optimistic message into the query cache before the API call resolves', async () => {
    let resolveApi!: () => void
    sendMessageMock.mockReturnValue(new Promise<{ sent: boolean }>(resolve => {
      resolveApi = () => resolve({ sent: true })
    }))

    const client = makeClient()
    // Pre-seed the query cache with existing messages
    client.setQueryData(['messages', 'demo-line', CHAT_A.conversationKey], [MSG_1])

    render(withProviders(<HistoryTab {...defaultProps()} />, client))

    const textarea = screen.getByPlaceholderText('Type a reply...')
    fireEvent.change(textarea, { target: { value: 'Optimistic!' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send/i }))
    })

    // Check that the optimistic message was injected (negative pk)
    const cached = client.getQueryData<Message[]>(['messages', 'demo-line', CHAT_A.conversationKey])
    expect(cached).toBeDefined()
    const optimistic = cached!.find(m => m.content === 'Optimistic!')
    expect(optimistic).toBeDefined()
    expect(optimistic!.pk).toBeLessThan(0) // negative pk = optimistic
    expect(optimistic!.fromMe).toBe(true)
    expect(optimistic!.senderName).toBe('You')

    resolveApi()
  })

  it('invalidates the query after api.sendMessage resolves', async () => {
    sendMessageMock.mockResolvedValue({ sent: true })

    const client = makeClient()
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries')

    render(withProviders(<HistoryTab {...defaultProps()} />, client))

    const textarea = screen.getByPlaceholderText('Type a reply...')
    fireEvent.change(textarea, { target: { value: 'Hello!' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send/i }))
    })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['messages', 'demo-line', CHAT_A.conversationKey],
      })
    })
  })

  it('sends the message when Enter is pressed without Shift', async () => {
    sendMessageMock.mockResolvedValue({ sent: true })

    render(withProviders(<HistoryTab {...defaultProps()} />))

    const textarea = screen.getByPlaceholderText('Type a reply...')
    fireEvent.change(textarea, { target: { value: 'Enter send test' } })

    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    })

    expect(sendMessageMock).toHaveBeenCalledTimes(1)
    expect(sendMessageMock).toHaveBeenCalledWith('demo-line', CHAT_A.conversationKey, 'Enter send test')
  })

  it('does NOT send when Shift+Enter is pressed', async () => {
    render(withProviders(<HistoryTab {...defaultProps()} />))

    const textarea = screen.getByPlaceholderText('Type a reply...')
    fireEvent.change(textarea, { target: { value: 'No send' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it('Send button is disabled when textarea is empty', () => {
    render(withProviders(<HistoryTab {...defaultProps()} />))

    const sendBtn = screen.getByRole('button', { name: /Send/i }) as HTMLButtonElement
    expect(sendBtn.disabled).toBe(true)
  })

  it('Send button becomes enabled when textarea has non-whitespace content', () => {
    render(withProviders(<HistoryTab {...defaultProps()} />))

    const textarea = screen.getByPlaceholderText('Type a reply...')
    fireEvent.change(textarea, { target: { value: 'x' } })

    const sendBtn = screen.getByRole('button', { name: /Send/i }) as HTMLButtonElement
    expect(sendBtn.disabled).toBe(false)
  })

  it('does not send when textarea contains only whitespace', async () => {
    render(withProviders(<HistoryTab {...defaultProps()} />))

    const textarea = screen.getByPlaceholderText('Type a reply...')
    fireEvent.change(textarea, { target: { value: '   ' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    expect(sendMessageMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 6. Send message — error rollback
// ---------------------------------------------------------------------------

describe('HistoryTab — send message error rollback', () => {
  it('removes the optimistic message from cache and calls toast.error on API failure', async () => {
    sendMessageMock.mockRejectedValue(new Error('network down'))

    const client = makeClient()
    client.setQueryData(['messages', 'demo-line', CHAT_A.conversationKey], [MSG_1])

    render(withProviders(<HistoryTab {...defaultProps()} />, client))

    const textarea = screen.getByPlaceholderText('Type a reply...')
    fireEvent.change(textarea, { target: { value: 'Fail me' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send/i }))
    })

    await waitFor(() => {
      expect(toastValue.error).toHaveBeenCalledWith('Send failed: network down')
    })

    // Optimistic message must be rolled back
    const cached = client.getQueryData<Message[]>(['messages', 'demo-line', CHAT_A.conversationKey])
    expect(cached?.every(m => m.pk >= 0)).toBe(true)
    expect(cached?.find(m => m.content === 'Fail me')).toBeUndefined()
  })

  it('stringifies non-Error rejection into the toast message', async () => {
    sendMessageMock.mockRejectedValue('plain string error')

    render(withProviders(<HistoryTab {...defaultProps()} />))

    const textarea = screen.getByPlaceholderText('Type a reply...')
    fireEvent.change(textarea, { target: { value: 'Fail2' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send/i }))
    })

    await waitFor(() => {
      expect(toastValue.error).toHaveBeenCalledWith('Send failed: plain string error')
    })
  })
})

// ---------------------------------------------------------------------------
// 7. Load older messages
// ---------------------------------------------------------------------------

describe('HistoryTab — load older messages', () => {
  it('calls api.getMessages with lineName, selectedChat, and the oldest pk when "Load older" is clicked', async () => {
    const olderMsg = makeMessage({ pk: 50, content: 'Older', fromMe: false })
    getMessagesMock.mockResolvedValue([olderMsg])

    render(withProviders(<HistoryTab {...defaultProps()} />))

    // MSG_1.pk=101, MSG_2.pk=102. Oldest positive pk = 101.
    await act(async () => {
      fireEvent.click(getLoadOlderButton())
    })

    expect(getMessagesMock).toHaveBeenCalledTimes(1)
    expect(getMessagesMock).toHaveBeenCalledWith('demo-line', CHAT_A.conversationKey, 101)
  })

  it('shows the older message after loading', async () => {
    const olderMsg = makeMessage({ pk: 50, content: 'Older message here', fromMe: false })
    getMessagesMock.mockResolvedValue([olderMsg])

    render(withProviders(<HistoryTab {...defaultProps()} />))

    await act(async () => {
      fireEvent.click(getLoadOlderButton())
    })

    await waitFor(() => {
      expect(screen.getByText('Older message here')).toBeDefined()
    })
  })

  it('shows "No more messages" and hides the load button after an empty response', async () => {
    getMessagesMock.mockResolvedValue([])

    render(withProviders(<HistoryTab {...defaultProps()} />))

    await act(async () => {
      fireEvent.click(getLoadOlderButton())
    })

    await waitFor(() => {
      expect(screen.getByText('No more messages')).toBeDefined()
      expect(screen.queryByText('Load older messages')).toBeNull()
    })
  })

  it('shows toast.error when getMessages rejects', async () => {
    getMessagesMock.mockRejectedValue(new Error('fetch failed'))

    render(withProviders(<HistoryTab {...defaultProps()} />))

    await act(async () => {
      fireEvent.click(getLoadOlderButton())
    })

    await waitFor(() => {
      expect(toastValue.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load older messages: fetch failed'),
      )
    })
  })

  it('deduplicates messages with matching pks (no phantom rows)', async () => {
    // Return MSG_1 again as "older" — should be deduped
    getMessagesMock.mockResolvedValue([MSG_1])

    render(withProviders(<HistoryTab {...defaultProps()} />))

    await act(async () => {
      fireEvent.click(getLoadOlderButton())
    })

    await waitFor(() => {
      // Only 2 unique pks (101, 102); not 3
      expect(screen.getAllByText('Hi there')).toHaveLength(1)
      expect(screen.getAllByText('How are you?')).toHaveLength(1)
    })
  })

  it('resets olderMessages and hasMore when selectedChat changes', async () => {
    getMessagesMock.mockResolvedValue([])

    const { rerender } = render(withProviders(<HistoryTab {...defaultProps()} />))

    await act(async () => {
      fireEvent.click(getLoadOlderButton())
    })
    await waitFor(() => expect(screen.getByText('No more messages')).toBeDefined())

    // Switch to a different chat
    rerender(
      withProviders(
        <HistoryTab
          {...defaultProps({ selectedChat: CHAT_B.conversationKey, messages: [MSG_1] })}
        />,
      ),
    )

    // The load button should be back (reset from "no more messages")
    await waitFor(() => {
      expect(getLoadOlderButton()).toBeDefined()
      expect(screen.queryByText('No more messages')).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// 8. Jump to bottom button
// ---------------------------------------------------------------------------

describe('HistoryTab — jump to bottom button', () => {
  it('is hidden by default (showJump=false from mock)', () => {
    render(withProviders(<HistoryTab {...defaultProps()} />))

    expect(screen.queryByRole('button', { name: /Jump to newest/i })).toBeNull()
  })

  it('appears when stickyScroll reports showJump=true', () => {
    stickyScrollState.showJump = true

    render(withProviders(<HistoryTab {...defaultProps()} />))

    expect(screen.getByRole('button', { name: /Jump to newest/i })).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 9. Input clear on conversation switch
// ---------------------------------------------------------------------------

describe('HistoryTab — input cleared on chat switch', () => {
  it('clears the textarea content when selectedChat prop changes', () => {
    const { rerender } = render(withProviders(<HistoryTab {...defaultProps()} />))

    const textarea = screen.getByPlaceholderText('Type a reply...') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'draft message' } })
    expect(textarea.value).toBe('draft message')

    // Switch to a different chat
    rerender(
      withProviders(
        <HistoryTab
          {...defaultProps({ selectedChat: CHAT_B.conversationKey })}
        />,
      ),
    )

    const newTextarea = screen.getByPlaceholderText('Type a reply...') as HTMLTextAreaElement
    expect(newTextarea.value).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 10. Mode-specific outgoingBg variants (structural pin)
// ---------------------------------------------------------------------------

describe('HistoryTab — mode variants (structural pin)', () => {
  it('renders with passive mode without errors', () => {
    render(withProviders(<HistoryTab {...defaultProps({ mode: 'passive' })} />))
    expect(screen.getByText('Conversations')).toBeDefined()
  })

  it('renders with agent mode without errors', () => {
    render(withProviders(<HistoryTab {...defaultProps({ mode: 'agent' })} />))
    expect(screen.getByText('Conversations')).toBeDefined()
  })

  it('renders with chat mode without errors', () => {
    render(withProviders(<HistoryTab {...defaultProps({ mode: 'chat' })} />))
    expect(screen.getByText('Conversations')).toBeDefined()
  })
})
