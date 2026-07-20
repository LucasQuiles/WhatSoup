/**
 * Line-detail card shells — structural tests for design-system primitives.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { GroupCard } from '../../console/src/components/line-detail/GroupCard'
import { ScheduledMessageRow } from '../../console/src/components/line-detail/ScheduledMessageRow'
import type { GroupInfo, ScheduledMessage } from '../../console/src/types'

afterEach(() => cleanup())

describe('GroupCard', () => {
  it('uses the shared soup-card shell', () => {
    const group: GroupInfo = {
      id: '120363400000000000@g.us',
      subject: 'Deployments',
      participants: [{ id: '15551234567@s.whatsapp.net', admin: 'admin' }, { id: '15557654321@s.whatsapp.net' }],
      desc: 'release coordination',
    }

    render(<GroupCard group={group} onSelect={vi.fn()} myJid="15551234567@s.whatsapp.net" />)

    const card = screen.getByRole('button', { name: /deployments/i }) as HTMLButtonElement
    expect(card.className).toContain('soup-card')
    expect(card.textContent).toContain('2 participants')
  })
})

describe('ScheduledMessageRow', () => {
  it('uses the shared soup-card shell', () => {
    const message: ScheduledMessage = {
      id: 42,
      chatJid: '15551234567@s.whatsapp.net',
      chatName: 'Alice',
      contentType: 'text',
      payload: { text: 'Follow up on launch checklist' },
      scheduledAt: 1_775_000_000,
      runCount: 0,
      status: 'pending',
      createdAt: 1_774_999_000,
      retryCount: 0,
    }

    const { container } = render(
      <ScheduledMessageRow
        message={message}
        onCancel={vi.fn()}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        cancelling={null}
      />,
    )

    const card = container.firstElementChild as HTMLDivElement | null
    expect(card).toBeDefined()
    expect(card?.className).toContain('soup-card')
    expect(screen.getByLabelText('Edit scheduled message')).toBeDefined()
  })
})
