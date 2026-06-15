/**
 * ChatList — listbox contract and roving-tabindex coverage (DD-17).
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ChatList from '../../console/src/components/ChatList'
import type { ChatItem } from '../../console/src/types'

afterEach(() => cleanup())

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function chat(overrides: Partial<ChatItem> & { conversationKey: string }): ChatItem {
  return {
    name: `Chat ${overrides.conversationKey}`,
    lastMessagePreview: 'preview',
    lastMessageAt: '2026-04-05T12:00:00.000Z',
    unreadCount: 0,
    isGroup: false,
    ...overrides,
  }
}

function makeChats(count: number): ChatItem[] {
  return Array.from({ length: count }, (_, i) =>
    chat({ conversationKey: `conv-${i + 1}` }),
  )
}

// ---------------------------------------------------------------------------
// Listbox role and accessible name
// ---------------------------------------------------------------------------

describe('ChatList — listbox role', () => {
  it('renders a listbox with the label "Chat conversations"', () => {
    render(<ChatList chats={makeChats(3)} selectedChat={null} onSelect={() => {}} />)
    const listbox = screen.getByRole('listbox', { name: 'Chat conversations' })

    expect(listbox.getAttribute('aria-label')).toBe('Chat conversations')
  })

  it('renders each chat as a listbox option', () => {
    render(<ChatList chats={makeChats(4)} selectedChat={null} onSelect={() => {}} />)
    const options = screen.getAllByRole('option')

    expect(options.length).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe('ChatList — empty state', () => {
  it('renders the empty-state message and a listbox with no options when chats is empty', () => {
    render(<ChatList chats={[]} selectedChat={null} onSelect={() => {}} />)

    expect(screen.getByRole('listbox', { name: 'Chat conversations' })).toBeDefined()
    expect(screen.queryAllByRole('option').length).toBe(0)
    expect(screen.getByText('No chats found')).toBeDefined()
  })

  it('arrow keys no-op on an empty list', () => {
    const onSelect = vi.fn()
    render(<ChatList chats={[]} selectedChat={null} onSelect={onSelect} />)
    const listbox = screen.getByRole('listbox')

    fireEvent.keyDown(listbox, { key: 'ArrowDown' })
    fireEvent.keyDown(listbox, { key: 'ArrowUp' })

    // The no-op contract: nothing selected, list still empty.
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.queryAllByRole('option').length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Roving tabindex — exactly one tab stop
// ---------------------------------------------------------------------------

describe('ChatList — roving tabindex: exactly one stop', () => {
  it('gives tabIndex=0 to the first row when nothing is selected', () => {
    const chats = makeChats(5)
    render(<ChatList chats={chats} selectedChat={null} onSelect={() => {}} />)
    const options = screen.getAllByRole('option')

    expect(options[0].getAttribute('tabIndex')).toBe('0')
    for (let i = 1; i < options.length; i++) {
      expect(options[i].getAttribute('tabIndex')).toBe('-1')
    }
  })

  it('gives tabIndex=0 to the selected row and -1 to all others', () => {
    const chats = makeChats(5)
    render(<ChatList chats={chats} selectedChat="conv-3" onSelect={() => {}} />)
    const options = screen.getAllByRole('option')

    // conv-3 is the third item (index 2)
    expect(options[2].getAttribute('tabIndex')).toBe('0')
    const others = [0, 1, 3, 4]
    for (const i of others) {
      expect(options[i].getAttribute('tabIndex')).toBe('-1')
    }
  })

  it('exactly one option has tabIndex=0 in a long list of 20+ rows', () => {
    render(<ChatList chats={makeChats(22)} selectedChat="conv-11" onSelect={() => {}} />)
    const options = screen.getAllByRole('option')
    const stopCount = options.filter(o => o.getAttribute('tabIndex') === '0').length

    expect(stopCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// ArrowDown / ArrowUp — move focus without changing selection
// ---------------------------------------------------------------------------

describe('ChatList — arrow navigation does not change selection', () => {
  it('ArrowDown moves focus to the next row without firing onSelect', () => {
    const onSelect = vi.fn()
    render(<ChatList chats={makeChats(5)} selectedChat="conv-1" onSelect={onSelect} />)
    const listbox = screen.getByRole('listbox')

    fireEvent.keyDown(listbox, { key: 'ArrowDown' })

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('ArrowUp moves focus to the previous row without firing onSelect', () => {
    const onSelect = vi.fn()
    render(<ChatList chats={makeChats(5)} selectedChat="conv-3" onSelect={onSelect} />)
    const listbox = screen.getByRole('listbox')

    fireEvent.keyDown(listbox, { key: 'ArrowUp' })

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('aria-selected values are unchanged after arrow key traversal', () => {
    render(<ChatList chats={makeChats(5)} selectedChat="conv-2" onSelect={() => {}} />)
    const listbox = screen.getByRole('listbox')
    const options = screen.getAllByRole('option')

    fireEvent.keyDown(listbox, { key: 'ArrowDown' })
    fireEvent.keyDown(listbox, { key: 'ArrowDown' })

    // conv-2 (index 1) must still be the only selected row
    expect(options[1].getAttribute('aria-selected')).toBe('true')
    for (const i of [0, 2, 3, 4]) {
      expect(options[i].getAttribute('aria-selected')).toBe('false')
    }
  })
})

// ---------------------------------------------------------------------------
// Clamp at ends
// ---------------------------------------------------------------------------

describe('ChatList — clamping at list boundaries', () => {
  it('ArrowDown at the last row stays on the last row', () => {
    const onSelect = vi.fn()
    render(<ChatList chats={makeChats(3)} selectedChat="conv-3" onSelect={onSelect} />)
    const listbox = screen.getByRole('listbox')

    fireEvent.keyDown(listbox, { key: 'ArrowDown' })
    fireEvent.keyDown(listbox, { key: 'ArrowDown' })

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('ArrowUp at the first row stays on the first row', () => {
    const onSelect = vi.fn()
    render(<ChatList chats={makeChats(3)} selectedChat="conv-1" onSelect={onSelect} />)
    const listbox = screen.getByRole('listbox')

    fireEvent.keyDown(listbox, { key: 'ArrowUp' })
    fireEvent.keyDown(listbox, { key: 'ArrowUp' })

    expect(onSelect).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Home / End
// ---------------------------------------------------------------------------

describe('ChatList — Home and End keys', () => {
  it('Home moves the roving stop to the first row', () => {
    render(<ChatList chats={makeChats(5)} selectedChat="conv-4" onSelect={() => {}} />)
    const listbox = screen.getByRole('listbox')
    const options = screen.getAllByRole('option')

    // The roving stop starts at conv-4 (index 3); Home should move it to index 0
    fireEvent.keyDown(listbox, { key: 'Home' })

    // After Home the tab stop is on the first row
    expect(options[0].getAttribute('tabIndex')).toBe('0')
  })

  it('End moves the roving stop to the last row', () => {
    render(<ChatList chats={makeChats(5)} selectedChat="conv-1" onSelect={() => {}} />)
    const listbox = screen.getByRole('listbox')
    const options = screen.getAllByRole('option')

    fireEvent.keyDown(listbox, { key: 'End' })

    expect(options[4].getAttribute('tabIndex')).toBe('0')
  })
})

// ---------------------------------------------------------------------------
// Enter / Space on a focused row selects it
// ---------------------------------------------------------------------------

describe('ChatList — Enter and Space activate selection', () => {
  it('Enter on a row fires onSelect with its conversationKey', () => {
    const onSelect = vi.fn()
    render(<ChatList chats={makeChats(3)} selectedChat={null} onSelect={onSelect} />)
    const options = screen.getAllByRole('option')

    fireEvent.keyDown(options[1], { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith('conv-2')
  })

  it('Space on a row fires onSelect with its conversationKey', () => {
    const onSelect = vi.fn()
    render(<ChatList chats={makeChats(3)} selectedChat={null} onSelect={onSelect} />)
    const options = screen.getAllByRole('option')

    fireEvent.keyDown(options[0], { key: ' ' })

    expect(onSelect).toHaveBeenCalledWith('conv-1')
  })
})

// ---------------------------------------------------------------------------
// Focus survival across chats-array reorder
// ---------------------------------------------------------------------------

describe('ChatList — focus survival on reorder and removal', () => {
  it('reorder keeps the roving stop on the same conversationKey', () => {
    const chats = makeChats(4)
    const { rerender } = render(
      <ChatList chats={chats} selectedChat="conv-2" onSelect={() => {}} />,
    )

    // conv-2 is at index 1; now reorder so conv-2 is at index 2
    const reordered = [chats[0], chats[2], chats[1], chats[3]]
    rerender(<ChatList chats={reordered} selectedChat="conv-2" onSelect={() => {}} />)

    const options = screen.getAllByRole('option')
    // conv-2 is now at index 2 in the reordered array
    expect(options[2].getAttribute('tabIndex')).toBe('0')
    expect(options[2].getAttribute('data-conv-key')).toBe('conv-2')
  })

  it('when the focused chat is removed the stop falls back to the selected row', () => {
    const chats = makeChats(4)
    const { rerender } = render(
      // "focus" is on conv-3 (via selectedChat); remove conv-3 but keep conv-1 selected
      <ChatList chats={chats} selectedChat="conv-3" onSelect={() => {}} />,
    )

    const without = chats.filter(c => c.conversationKey !== 'conv-3')
    rerender(<ChatList chats={without} selectedChat="conv-1" onSelect={() => {}} />)

    const options = screen.getAllByRole('option')
    // conv-1 is now the selected row; it should own the tab stop
    expect(options[0].getAttribute('tabIndex')).toBe('0')
    expect(options[0].getAttribute('data-conv-key')).toBe('conv-1')
  })

  it('when the focused chat is removed and no selection exists, falls back to the first row', () => {
    const chats = makeChats(3)
    const { rerender } = render(
      <ChatList chats={chats} selectedChat="conv-2" onSelect={() => {}} />,
    )

    const without = chats.filter(c => c.conversationKey !== 'conv-2')
    rerender(<ChatList chats={without} selectedChat={null} onSelect={() => {}} />)

    const options = screen.getAllByRole('option')
    expect(options[0].getAttribute('tabIndex')).toBe('0')
  })
})

// ---------------------------------------------------------------------------
// Typing-indicator rows remain navigable
// ---------------------------------------------------------------------------

describe('ChatList — typing-indicator rows', () => {
  it('typing rows show the typing indicator and remain navigable options', () => {
    const chats = makeChats(3)
    const typingKeys = new Set(['conv-2'])
    render(
      <ChatList
        chats={chats}
        selectedChat={null}
        onSelect={() => {}}
        typingKeys={typingKeys}
      />,
    )

    expect(screen.getByText('typing')).toBeDefined()
    const options = screen.getAllByRole('option')
    expect(options.length).toBe(3)
  })
})
