/**
 * ChatListItem — behavior coverage for the inbox row primitive.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ChatListItem from '../../console/src/components/ChatListItem'
import type { ChatItem } from '../../console/src/types'

afterEach(() => cleanup())

function chat(overrides: Partial<ChatItem> = {}): ChatItem {
  return {
    conversationKey: 'conv-fixture-1',
    name: 'Sample Conversation',
    lastMessagePreview: 'hello world',
    lastMessageAt: '2026-04-05T12:00:00.000Z',
    unreadCount: 0,
    isGroup: false,
    ...overrides,
  }
}

describe('ChatListItem', () => {
  it('renders the chat name, preview, and avatar initials', () => {
    render(<ChatListItem chat={chat()} isSelected={false} onClick={() => {}} />)

    expect(screen.getByText('Sample Conversation')).toBeDefined()
    expect(screen.getByText('hello world')).toBeDefined()
    expect(screen.getByText('SC')).toBeDefined()
  })

  it.each([
    ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@signal', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
    ['owner@example.com@imessage', 'owner@example.com'],
    ['iMessage;+;chat123@imessage', 'iMessage;+;chat123'],
    ['+15550003333evil@sms', '+15550003333evil@sms'],
  ])('renders a transport conversation fallback without phone coercion', (name, expected) => {
    render(<ChatListItem chat={chat({ name })} isSelected={false} onClick={() => {}} />)

    expect(screen.getByText(expected)).toBeDefined()
    expect(screen.getByRole('option').getAttribute('aria-label')).toBe(`Open conversation with ${expected}`)
  })

  it('renders bidi controls as visible escapes in the label and accessible name', () => {
    render(<ChatListItem chat={chat({ name: 'safe\u202Eevil@signal' })} isSelected={false} onClick={() => {}} />)

    expect(screen.getByText('safe\\u202Eevil@signal')).toBeDefined()
    expect(screen.getByRole('option').getAttribute('aria-label')).toBe(
      'Open conversation with safe\\u202Eevil@signal',
    )
  })

  it.each([
    ['safe\\u202Eevil@signal', 'safe\\\\u202Eevil@signal'],
    ['\nevil@signal', '\\u000Aevil@signal'],
    ['safe\u200Bevil@signal', 'safe\\u200Bevil@signal'],
    ['safe\u2028evil@signal', 'safe\\u2028evil@signal'],
  ])('keeps literal and boundary control text unambiguous in rendered labels', (name, expected) => {
    render(<ChatListItem chat={chat({ name })} isSelected={false} onClick={() => {}} />)

    expect(screen.getByText(expected)).toBeDefined()
    expect(screen.getByRole('option').getAttribute('aria-label')).toBe(`Open conversation with ${expected}`)
  })

  it('strips markdown from the preview line', () => {
    render(
      <ChatListItem
        chat={chat({ lastMessagePreview: '**bold** and _italic_ text' })}
        isSelected={false}
        onClick={() => {}}
      />,
    )

    expect(screen.getByText('bold and italic text')).toBeDefined()
    expect(screen.queryByText('**bold** and _italic_ text')).toBeNull()
  })

  it('renders an empty-string preview as blank without crashing', () => {
    render(
      <ChatListItem
        chat={chat({ lastMessagePreview: '' })}
        isSelected={false}
        onClick={() => {}}
      />,
    )
    const row = screen.getByRole('option')

    expect(row).toBeDefined()
    expect(screen.queryByText('hello world')).toBeNull()
  })

  it('hides the unread badge when unreadCount is zero', () => {
    const { container } = render(
      <ChatListItem chat={chat({ unreadCount: 0 })} isSelected={false} onClick={() => {}} />,
    )
    const badges = container.querySelectorAll('.bg-m-cht')

    expect(badges.length).toBe(0)
  })

  it('shows the unread badge with the exact count when unreadCount > 0', () => {
    render(
      <ChatListItem chat={chat({ unreadCount: 7 })} isSelected={false} onClick={() => {}} />,
    )

    expect(screen.getByText('7')).toBeDefined()
  })

  it('applies the active class and an accent border when selected', () => {
    render(<ChatListItem chat={chat()} isSelected onClick={() => {}} />)
    const row = screen.getByRole('option')

    expect(row.className).toContain('active')
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(row.getAttribute('style')).toContain('border-left')
  })

  it('carries the c-chat-item class that owns the row focus-visible ring', () => {
    render(<ChatListItem chat={chat()} isSelected={false} onClick={() => {}} tabIndex={0} />)
    const row = screen.getByRole('option')

    expect(row.classList.contains('c-chat-item')).toBe(true)
    expect(row.getAttribute('tabIndex')).toBe('0')
    expect(row.getAttribute('role')).toBe('option')
  })

  it('omits the active class and inline style when not selected', () => {
    render(<ChatListItem chat={chat()} isSelected={false} onClick={() => {}} />)
    const row = screen.getByRole('option')

    expect(row.className).not.toContain('active')
    expect(row.getAttribute('aria-selected')).toBe('false')
    expect(row.getAttribute('style')).toBeNull()
  })

  it('fires onClick when the row is clicked', () => {
    const onClick = vi.fn()
    render(<ChatListItem chat={chat()} isSelected={false} onClick={onClick} />)

    fireEvent.click(screen.getByRole('option'))

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('fires onClick for Enter and Space keyboard activation', () => {
    const onClick = vi.fn()
    render(<ChatListItem chat={chat()} isSelected={false} onClick={onClick} />)
    const row = screen.getByRole('option')

    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.keyDown(row, { key: ' ' })

    expect(onClick).toHaveBeenCalledTimes(2)
  })

  it('ignores unrelated keys', () => {
    const onClick = vi.fn()
    render(<ChatListItem chat={chat()} isSelected={false} onClick={onClick} />)

    fireEvent.keyDown(screen.getByRole('option'), { key: 'Tab' })
    fireEvent.keyDown(screen.getByRole('option'), { key: 'a' })

    expect(onClick).not.toHaveBeenCalled()
  })

  it('renders the typing indicator instead of the preview when isTyping is true', () => {
    const { container } = render(
      <ChatListItem chat={chat()} isSelected={false} onClick={() => {}} isTyping />,
    )

    expect(screen.getByText('typing')).toBeDefined()
    expect(screen.queryByText('hello world')).toBeNull()
    expect(container.querySelectorAll('.typing-dot').length).toBe(3)
  })

  it('falls back to the em-dash sentinel when lastMessageAt is empty', () => {
    render(
      <ChatListItem
        chat={chat({ lastMessageAt: '' })}
        isSelected={false}
        onClick={() => {}}
      />,
    )

    expect(screen.getByText('—')).toBeDefined()
  })

  it('uses an accessible aria-label that references the resolved display name', () => {
    render(<ChatListItem chat={chat({ name: 'Friendly Group' })} isSelected={false} onClick={() => {}} />)
    const row = screen.getByRole('option')

    expect(row.getAttribute('aria-label')).toBe('Open conversation with Friendly Group')
  })

  it('accepts tabIndex prop: tabIndex=0 when the row is the roving stop', () => {
    // Roving tabindex is owned by ChatList; ChatListItem is a pure row.
    // When ChatList passes tabIndex=0 the row is the current keyboard stop.
    render(<ChatListItem chat={chat()} isSelected={false} onClick={() => {}} tabIndex={0} />)
    const row = screen.getByRole('option')

    expect(row.getAttribute('tabIndex')).toBe('0')
  })

  it('accepts tabIndex prop: tabIndex=-1 when the row is not the roving stop', () => {
    // All non-stop rows receive tabIndex=-1 from ChatList, removing them from
    // the tab sequence while keeping them reachable via arrow keys.
    render(<ChatListItem chat={chat()} isSelected={false} onClick={() => {}} tabIndex={-1} />)
    const row = screen.getByRole('option')

    expect(row.getAttribute('tabIndex')).toBe('-1')
  })

  it('defaults tabIndex to 0 when no prop is provided (standalone use)', () => {
    // The default keeps ChatListItem usable outside ChatList without breaking.
    render(<ChatListItem chat={chat()} isSelected={false} onClick={() => {}} />)
    const row = screen.getByRole('option')

    expect(row.getAttribute('tabIndex')).toBe('0')
  })
})
