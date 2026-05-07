/**
 * ChatPicker — display-safe chat row regressions.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPicker } from '../../console/src/components/shared/ChatPicker'
import type { ChatItem } from '../../console/src/types'

afterEach(() => cleanup())

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

    fireEvent.change(screen.getByLabelText('Search chats...'), {
      target: { value: 'family' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'family_at_g.us' }))

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
})
