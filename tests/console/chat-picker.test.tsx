/**
 * ChatPicker — full combobox contract: display safety, open/close, keyboard
 * navigation, Escape-layering fix, empty-results, clear-selection.
 *
 * Escape-layering test (§6.3 ordering requirement): ChatPicker inside a
 * legacy-style dialog whose Escape handler runs in bubble phase. The Popover's
 * capture-phase handler fires first; only the panel closes — the dialog's
 * handler never receives the event.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from '@testing-library/react'
import { ChatPicker } from '../../console/src/components/shared/ChatPicker'
import type { ChatItem } from '../../console/src/types'

afterEach(() => cleanup())

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chat(overrides: Partial<ChatItem> = {}): ChatItem {
  return {
    conversationKey: 'family_at_g.us',
    name: 'Family',
    lastMessagePreview: 'hello',
    lastMessageAt: '2026-04-05T12:00:00.000Z',
    unreadCount: 0,
    isGroup: true,
    ...overrides,
  }
}

const allChats: ChatItem[] = [
  chat({ conversationKey: 'alice_at_s', name: 'Alice', isGroup: false }),
  chat({ conversationKey: 'bob_at_s', name: 'Bob', isGroup: false }),
  chat({ conversationKey: 'family_at_g.us', name: 'Family', isGroup: true }),
]

function getInput() {
  return screen.getByRole('combobox') as HTMLInputElement
}

// ---------------------------------------------------------------------------
// Display-safety (preserved from prior test)
// ---------------------------------------------------------------------------

describe('ChatPicker display-safe rows', () => {
  it('filters and renders chats whose names are nullish', () => {
    const onSelect = vi.fn()

    render(
      <ChatPicker
        chats={[chat({ name: null as unknown as string })]}
        selected={null}
        onSelect={onSelect}
        onClear={vi.fn()}
      />,
    )

    fireEvent.change(getInput(), { target: { value: 'family' } })
    fireEvent.mouseDown(screen.getByRole('option', { name: 'family_at_g.us' }))

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKey: 'family_at_g.us' }),
    )
  })

  it('falls back to conversation key for selected chats without names', () => {
    render(
      <ChatPicker
        chats={[]}
        selected={chat({ name: null as unknown as string, conversationKey: 'ops-chat' })}
        onSelect={vi.fn()}
        onClear={vi.fn()}
      />,
    )

    expect(screen.getByText('ops-chat')).toBeDefined()
  })

  it('keeps unsafe, literal-escape, and separator chat labels distinct for selection', async () => {
    const unsafe = chat({ conversationKey: 'unsafe-chat', name: 'safe\u202Eevil@signal' })
    const literal = chat({ conversationKey: 'literal-chat', name: 'safe\\u202Eevil@signal' })
    const separated = chat({ conversationKey: 'separated-chat', name: '\u2028evil@signal' })
    const onSelect = vi.fn()
    const { rerender } = render(
      <ChatPicker
        chats={[unsafe, literal, separated]}
        selected={null}
        onSelect={onSelect}
        onClear={vi.fn()}
      />,
    )

    fireEvent.focus(getInput())
    expect(await screen.findByRole('option', { name: 'safe\\u202Eevil@signal' })).toBeDefined()
    expect(screen.getByRole('option', { name: 'safe\\\\u202Eevil@signal' })).toBeDefined()
    expect(screen.getByRole('option', { name: '\\u2028evil@signal' })).toBeDefined()

    fireEvent.mouseDown(screen.getByRole('option', { name: 'safe\\u202Eevil@signal' }))
    expect(onSelect).toHaveBeenCalledWith(unsafe)

    rerender(
      <ChatPicker
        chats={[unsafe, literal, separated]}
        selected={unsafe}
        onSelect={onSelect}
        onClear={vi.fn()}
      />,
    )
    expect(screen.getByText('safe\\u202Eevil@signal').getAttribute('title')).toBe('safe\\u202Eevil@signal')
  })
})

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------

describe('ChatPicker open/close', () => {
  it('is closed initially — no listbox visible', () => {
    render(<ChatPicker chats={allChats} selected={null} onSelect={vi.fn()} onClear={vi.fn()} />)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(getInput().getAttribute('aria-expanded')).toBe('false')
  })

  it('opens listbox on focus', () => {
    render(<ChatPicker chats={allChats} selected={null} onSelect={vi.fn()} onClear={vi.fn()} />)
    fireEvent.focus(getInput())
    // With empty query all chats match — listbox present
    waitFor(() => expect(screen.queryByRole('listbox')).not.toBeNull())
  })

  it('opens listbox when query typed and options exist', async () => {
    render(<ChatPicker chats={allChats} selected={null} onSelect={vi.fn()} onClear={vi.fn()} />)
    fireEvent.change(getInput(), { target: { value: 'Ali' } })
    await waitFor(() => expect(screen.getByRole('listbox')).toBeDefined())
    expect(screen.getByRole('option', { name: 'Alice' })).toBeDefined()
  })

  it('shows no listbox when query matches nothing', async () => {
    render(<ChatPicker chats={allChats} selected={null} onSelect={vi.fn()} onClear={vi.fn()} />)
    fireEvent.change(getInput(), { target: { value: 'zzz' } })
    // options.length === 0 → Popover open=false → no listbox rendered
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
  })
})

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe('ChatPicker selection', () => {
  it('calls onSelect with the clicked chat and closes the panel', async () => {
    const onSelect = vi.fn()
    render(<ChatPicker chats={allChats} selected={null} onSelect={onSelect} onClear={vi.fn()} />)

    fireEvent.change(getInput(), { target: { value: 'Ali' } })
    await waitFor(() => screen.getByRole('option', { name: 'Alice' }))

    fireEvent.mouseDown(screen.getByRole('option', { name: 'Alice' }))

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKey: 'alice_at_s' }),
    )
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
  })

  it('renders selected-state display with labeled clear button', () => {
    const onClear = vi.fn()
    render(
      <ChatPicker
        chats={allChats}
        selected={allChats[0]}
        onSelect={vi.fn()}
        onClear={onClear}
      />,
    )

    expect(screen.getByText('Alice')).toBeDefined()
    const clearBtn = screen.getByRole('button', { name: 'Clear selection' })
    expect(clearBtn).toBeDefined()
    fireEvent.click(clearBtn)
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Keyboard contract
// ---------------------------------------------------------------------------

describe('ChatPicker keyboard navigation', () => {
  it('keeps distinct iMessage destinations bound to distinct active option ids', async () => {
    const onSelect = vi.fn()
    const first = chat({
      conversationKey: 'owner+ops_at_example.com@imessage',
      name: 'Owner Ops Plus',
      isGroup: false,
    })
    const second = chat({
      conversationKey: 'owner.ops_at_example.com@imessage',
      name: 'Owner Ops Dot',
      isGroup: false,
    })
    render(<ChatPicker chats={[first, second]} selected={null} onSelect={onSelect} onClear={vi.fn()} />)
    const input = getInput()
    fireEvent.focus(input)

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    await waitFor(() => expect(input.getAttribute('aria-activedescendant')).not.toBeNull())
    const firstId = input.getAttribute('aria-activedescendant')
    expect(document.getElementById(firstId!)?.textContent).toContain('Owner Ops Plus')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const secondId = input.getAttribute('aria-activedescendant')
    expect(secondId).not.toBe(firstId)
    expect(document.querySelectorAll(`[id="${secondId}"]`)).toHaveLength(1)
    expect(document.getElementById(secondId!)?.textContent).toContain('Owner Ops Dot')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith(second)
  })

  it('Down opens the panel and sets first option active', async () => {
    render(<ChatPicker chats={allChats} selected={null} onSelect={vi.fn()} onClear={vi.fn()} />)
    const input = getInput()
    // Type to produce options first (query must match something)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.focus(input)
    // Simulate Down
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    await waitFor(() => expect(input.getAttribute('aria-expanded')).toBe('true'))
    // aria-activedescendant is set
    expect(input.getAttribute('aria-activedescendant')).not.toBeNull()
  })

  it('Up does not crash when nothing is active', async () => {
    render(<ChatPicker chats={allChats} selected={null} onSelect={vi.fn()} onClear={vi.fn()} />)
    const input = getInput()
    fireEvent.change(input, { target: { value: 'Ali' } })
    await waitFor(() => screen.getByRole('listbox'))
    expect(() => fireEvent.keyDown(input, { key: 'ArrowUp' })).not.toThrow()
  })

  it('Enter selects the active option and closes', async () => {
    const onSelect = vi.fn()
    render(<ChatPicker chats={allChats} selected={null} onSelect={onSelect} onClear={vi.fn()} />)
    const input = getInput()

    // Open with a query
    fireEvent.change(input, { target: { value: 'Ali' } })
    await waitFor(() => screen.getByRole('listbox'))

    // Move to first option
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    await waitFor(() => expect(input.getAttribute('aria-activedescendant')).not.toBeNull())

    // Enter selects
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKey: 'alice_at_s' }),
    )
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
  })

  it('aria-expanded reflects open state', async () => {
    render(<ChatPicker chats={allChats} selected={null} onSelect={vi.fn()} onClear={vi.fn()} />)
    const input = getInput()
    expect(input.getAttribute('aria-expanded')).toBe('false')
    fireEvent.change(input, { target: { value: 'Ali' } })
    await waitFor(() => expect(input.getAttribute('aria-expanded')).toBe('true'))
  })

  it('aria-controls points to the listbox id when open', async () => {
    render(<ChatPicker chats={allChats} selected={null} onSelect={vi.fn()} onClear={vi.fn()} />)
    const input = getInput()
    fireEvent.change(input, { target: { value: 'Ali' } })
    await waitFor(() => screen.getByRole('listbox'))
    const controls = input.getAttribute('aria-controls')
    expect(controls).not.toBeNull()
    expect(document.getElementById(controls!)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Escape-layering defect fix (§6.3 / C-B2-6 ordering requirement)
//
// ChatPicker inside a dialog (formerly legacy-style with a bubble-phase Escape
// handler). First Escape must close ONLY the panel; any outer dialog handler
// must NOT fire for that keydown.
// NOTE (B3 wave 2): ScheduleComposerModal previously was the live example of the
// legacy bubble-phase pattern; it was migrated to the Modal primitive in wave 2
// and no longer uses a hand-rolled Escape handler. The stack-based ordering
// protection (capture-phase + stopPropagation) remains relevant for any future
// dialog that might re-introduce the anti-pattern.
// ---------------------------------------------------------------------------

describe('ChatPicker Escape-layering fix', () => {
  it('Escape closes panel only — legacy bubble-phase dialog handler does not fire', async () => {
    const dialogEscapeHandler = vi.fn()

    // Mount a container div that mimics a dialog with a bubble-phase document
    // keydown listener (the former ScheduleComposerModal anti-pattern).
    const container = document.createElement('div')
    document.body.appendChild(container)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') dialogEscapeHandler()
    })

    const { unmount } = render(
      <ChatPicker chats={allChats} selected={null} onSelect={vi.fn()} onClear={vi.fn()} />,
      { container },
    )

    const input = getInput()
    fireEvent.change(input, { target: { value: 'Ali' } })
    await waitFor(() => screen.getByRole('listbox'))

    // At this point the popover is registered on the useDismissable stack as
    // the topmost overlay. Its capture-phase Escape handler fires first and
    // calls stopPropagation(), so the bubble-phase listener never fires.
    fireEvent.keyDown(input, { key: 'Escape' })

    // Panel must close
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())

    // Dialog handler must NOT have fired — stopPropagation() in capture phase
    // prevents bubble-phase handlers from receiving the event.
    expect(dialogEscapeHandler).not.toHaveBeenCalled()

    unmount()
    document.body.removeChild(container)
  })
})

// ---------------------------------------------------------------------------
// combobox aria attributes
// ---------------------------------------------------------------------------

describe('ChatPicker combobox aria', () => {
  it('input has role=combobox, aria-haspopup=listbox, aria-autocomplete=list', () => {
    render(<ChatPicker chats={allChats} selected={null} onSelect={vi.fn()} onClear={vi.fn()} />)
    const input = getInput()
    expect(input.getAttribute('role')).toBe('combobox')
    expect(input.getAttribute('aria-haspopup')).toBe('listbox')
    expect(input.getAttribute('aria-autocomplete')).toBe('list')
  })
})
