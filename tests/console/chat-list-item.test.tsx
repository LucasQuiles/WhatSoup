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
    expect(row.getAttribute('tabIndex')).toBe('0')
  })
})
