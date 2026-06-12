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
import { cleanup, render, screen } from '@testing-library/react'
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

// react-router-dom: useSearchParams returns empty params; setSearchParams is a no-op.
vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}))

// use-fleet hooks: mutable state so individual tests can override.
let mockLines: Array<{ name: string; mode: string; status: string }> = []
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

vi.mock('../../console/src/hooks/use-fleet', () => ({
  useLines: () => ({ data: mockLines }),
  useChats: () => ({ data: mockChats }),
  useMessages: () => ({ data: mockMessages }),
  useTyping: () => ({ data: mockTyping }),
}))

// use-virtual-messages: surface all messages as virtual items (jsdom has no scroll).
vi.mock('../../console/src/hooks/use-virtual-messages', () => ({
  useVirtualMessages: ({ messages }: { messages: Array<{ pk: number }> }) => ({
    getVirtualItems: () =>
      messages.map((_, i) => ({ index: i, key: i, start: i * 80, size: 80 })),
    getTotalSize: () => messages.length * 80,
    measureElement: () => {},
  }),
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

// toast context: stub — layout tests do not assert on toasts.
vi.mock('../../console/src/hooks/toast-context', () => ({
  ToastContext: {
    Provider: ({ children }: { children?: ReactNode }) => children,
  },
  useToast: () => ({
    toast: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
    clear: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Dynamic import (after vi.mock declarations)
// ---------------------------------------------------------------------------
import Inbox from '../../console/src/pages/Inbox'

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

  it('legacy --panel-chat-list token reference is absent', () => {
    const { container } = renderInbox()
    const legacyChats = container.querySelector('.w-\\[var\\(--panel-chat-list\\)\\]')

    expect(legacyChats).toBeNull()
  })

  it('legacy --panel-contact token reference is absent', () => {
    const { container } = renderInbox()
    const legacyContact = container.querySelector('.w-\\[var\\(--panel-contact\\)\\]')

    expect(legacyContact).toBeNull()
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
})
