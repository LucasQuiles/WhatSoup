/**
 * SOUP v3 post-cutover a11y closeout — regression guards for the ARIA fixes
 * landed on fix/soup-v3-a11y-closeout (window-1 audit findings).
 * Plain getAttribute assertions (no jest-dom dep) to match the suite style.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import AlertBanner from '../../console/src/components/AlertBanner'
import ChatListItem from '../../console/src/components/ChatListItem'
import type { ChatItem, ScheduledMessage } from '../../console/src/types'
import { Table, TableHeader, TableHeaderCell } from '../../console/src/components/primitives/Table'

const { ScheduledMessageRow } = await import(
  '../../console/src/components/line-detail/ScheduledMessageRow'
)

afterEach(() => cleanup())

function chat(overrides: Partial<ChatItem> = {}): ChatItem {
  return {
    conversationKey: 'conv-a11y-1',
    name: 'Sample Conversation',
    lastMessagePreview: 'hello',
    lastMessageAt: '2026-04-05T12:00:00.000Z',
    unreadCount: 0,
    isGroup: false,
    ...overrides,
  }
}

function scheduled(overrides: Partial<ScheduledMessage> = {}): ScheduledMessage {
  return {
    id: 77,
    chatJid: 'jid',
    chatName: 'Alice',
    contentType: 'text',
    payload: { text: 'hi' },
    scheduledAt: 1_700_000_000,
    runCount: 0,
    status: 'pending',
    createdAt: 1_699_000_000,
    retryCount: 1, // > 0 forces the expand/collapse control to render
    ...overrides,
  }
}

describe('a11y closeout — AlertBanner', () => {
  it('exposes role=alert with an assertive live region', () => {
    render(<AlertBanner alerts={[{ line: 'L1', message: 'connection-lost' }]} />)
    const alert = screen.getByRole('alert')
    expect(alert.getAttribute('aria-live')).toBe('assertive')
  })
})

describe('a11y closeout — ChatListItem unread', () => {
  it('folds the unread count into the row accessible name and hides the badge', () => {
    render(<ChatListItem chat={chat({ unreadCount: 5 })} isSelected={false} onClick={() => {}} />)
    expect(screen.getByRole('option').getAttribute('aria-label')).toContain('5 unread')
    expect(screen.getByText('5').getAttribute('aria-hidden')).toBe('true')
  })

  it('omits the unread suffix when there are no unread messages', () => {
    render(<ChatListItem chat={chat({ unreadCount: 0 })} isSelected={false} onClick={() => {}} />)
    expect(screen.getByRole('option').getAttribute('aria-label')).not.toContain('unread')
  })
})

describe('a11y closeout — ScheduledMessageRow disclosure', () => {
  it('wires aria-expanded + aria-controls on the details toggle', () => {
    render(
      <ScheduledMessageRow
        message={scheduled()}
        onCancel={vi.fn()}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        cancelling={null}
      />,
    )
    const toggle = screen.getByRole('button', { name: /expand details/i })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-controls')).toBe('sched-details-77')
    fireEvent.click(toggle)
    const expanded = screen.getByRole('button', { name: /collapse details/i })
    expect(expanded.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById('sched-details-77')).not.toBeNull()
  })
})

describe('a11y closeout — Table sort button', () => {
  it('gives the sort control an explicit action label', () => {
    render(
      <Table>
        <TableHeader>
          <tr>
            <TableHeaderCell sortKey="name" sort={{ key: 'name', dir: 'none' }} onSort={vi.fn()}>
              Name
            </TableHeaderCell>
          </tr>
        </TableHeader>
      </Table>,
    )
    expect(screen.getByRole('button').getAttribute('aria-label')).toMatch(/^Sort by Name/)
  })
})
