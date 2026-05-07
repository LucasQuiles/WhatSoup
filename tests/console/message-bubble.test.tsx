/**
 * MessageBubble — display-safe timestamp regressions.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import MessageBubble from '../../console/src/components/MessageBubble'
import type { Message } from '../../console/src/types'

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

function message(overrides: Partial<Message> = {}): Message {
  return {
    pk: 42,
    conversationKey: 'chat-1',
    senderName: 'Alice',
    senderJid: 'alice-fixture-jid',
    content: 'Hello',
    timestamp: '2026-04-05T19:30:45.000Z',
    fromMe: false,
    type: 'text',
    ...overrides,
  }
}

describe('MessageBubble timestamp rendering', () => {
  it('uses the empty timestamp marker in both bubble and detail surfaces', () => {
    vi.useFakeTimers()

    render(<MessageBubble msg={message({ timestamp: null as unknown as string })} />)

    const bubbleTime = screen.getByText('\u2014')
    expect(bubbleTime).toBeDefined()

    fireEvent.mouseEnter(screen.getByText('Hello').closest('.relative')!)
    act(() => {
      vi.advanceTimersByTime(500)
    })

    const detailRows = screen.getAllByText('\u2014')
    expect(detailRows).toHaveLength(2)
    expect(screen.queryByText(/Dec 31|Jan 1|Invalid Date/i)).toBeNull()
  })
})
