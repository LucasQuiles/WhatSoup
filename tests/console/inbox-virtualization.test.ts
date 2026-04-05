import { describe, expect, it } from 'vitest'

import {
  selectVirtualMessageRows,
  toChronologicalMessages,
} from '../../console/src/lib/inbox-virtualization.ts'
import type { Message } from '../../console/src/types.ts'

const makeMessage = (pk: number, content: string): Message => ({
  pk,
  conversationKey: 'chat-1',
  senderName: pk % 2 === 0 ? 'You' : 'Alex',
  senderJid: `jid-${pk}`,
  content,
  timestamp: `2026-04-05T12:00:0${pk}.000Z`,
  fromMe: pk % 2 === 0,
  type: 'text',
})

describe('Inbox virtualization helpers', () => {
  it('converts newest-first message arrays into chronological render order without mutating input', () => {
    const newestFirst = [makeMessage(3, 'third'), makeMessage(2, 'second'), makeMessage(1, 'first')]

    const chronological = toChronologicalMessages(newestFirst)

    expect(chronological.map((message) => message.pk)).toEqual([1, 2, 3])
    expect(newestFirst.map((message) => message.pk)).toEqual([3, 2, 1])
  })

  it('selects only the virtual rows that should render', () => {
    const chronological = [makeMessage(1, 'first'), makeMessage(2, 'second'), makeMessage(3, 'third')]

    const rows = selectVirtualMessageRows(chronological, [
      { index: 0, key: 'row-1', start: 0, size: 76 },
      { index: 2, key: 'row-3', start: 180, size: 94 },
    ])

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ key: 'row-1', index: 0, start: 0, size: 76, message: { pk: 1 } })
    expect(rows[1]).toMatchObject({ key: 'row-3', index: 2, start: 180, size: 94, message: { pk: 3 } })
  })
})
