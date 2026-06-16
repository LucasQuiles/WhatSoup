/**
 * Addl coverage for console/src/lib/inbox-virtualization.ts.
 *
 * Existing tests in tests/console/inbox-virtualization.test.ts cover:
 *   - toChronologicalMessages (reverse + non-mutating)
 *   - selectVirtualMessageRows happy-path (index hits)
 *
 * Uncovered:
 *   s[4] / b[0] line 24 — the `if (!message) return []` flatMap guard.
 *   b[0] counts=[0, 218] means the truthy (message present) branch is hit 218x
 *   but the falsy branch (out-of-bounds index → !message) is never exercised.
 *
 * Pure Node — no jsdom required.
 */
import { describe, expect, it } from 'vitest'

import {
  selectVirtualMessageRows,
  toChronologicalMessages,
} from '../../console/src/lib/inbox-virtualization.ts'
import type { Message } from '../../console/src/types.ts'

function makeMessage(pk: number): Message {
  return {
    pk,
    conversationKey: 'chat-1',
    senderName: 'Alex',
    senderJid: `jid-${pk}`,
    content: `message-${pk}`,
    timestamp: `2026-04-05T12:00:0${pk}.000Z`,
    fromMe: false,
    type: 'text',
  }
}

// ---------------------------------------------------------------------------
// Out-of-bounds index → !message guard (s[4], b[0] false branch)
// ---------------------------------------------------------------------------

describe('selectVirtualMessageRows — out-of-bounds index guard', () => {
  it('skips virtual items whose index exceeds the messages array length', () => {
    const messages = [makeMessage(1), makeMessage(2)]

    // index 5 is beyond messages.length (2) — messages[5] is undefined → flatMap [] guard
    const rows = selectVirtualMessageRows(messages, [
      { index: 0, key: 'row-0', start: 0, size: 76 },
      { index: 5, key: 'row-5', start: 400, size: 76 }, // out-of-bounds
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'row-0', message: { pk: 1 } })
  })

  it('returns an empty array when all virtual items are out-of-bounds', () => {
    const messages = [makeMessage(1)]

    const rows = selectVirtualMessageRows(messages, [
      { index: 10, key: 'row-10', start: 0, size: 76 },
      { index: 20, key: 'row-20', start: 76, size: 76 },
    ])

    expect(rows).toHaveLength(0)
  })

  it('returns an empty array when no virtual items are provided', () => {
    const messages = [makeMessage(1), makeMessage(2)]
    const rows = selectVirtualMessageRows(messages, [])
    expect(rows).toHaveLength(0)
  })

  it('returns an empty array when the messages array is empty', () => {
    const rows = selectVirtualMessageRows([], [
      { index: 0, key: 'row-0', start: 0, size: 76 },
    ])
    expect(rows).toHaveLength(0)
  })

  it('handles a mix of in-bounds and out-of-bounds indices in one call', () => {
    const messages = [makeMessage(10), makeMessage(20), makeMessage(30)]

    const rows = selectVirtualMessageRows(messages, [
      { index: 0, key: 'a', start: 0, size: 80 },
      { index: 99, key: 'b', start: 80, size: 80 },   // out-of-bounds
      { index: 2, key: 'c', start: 160, size: 80 },
    ])

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ key: 'a', message: { pk: 10 } })
    expect(rows[1]).toMatchObject({ key: 'c', message: { pk: 30 } })
  })
})

// ---------------------------------------------------------------------------
// toChronologicalMessages — additional edge cases
// ---------------------------------------------------------------------------

describe('toChronologicalMessages — edge cases', () => {
  it('returns an empty array unchanged for an empty input', () => {
    expect(toChronologicalMessages([])).toEqual([])
  })

  it('returns a single-element array unchanged', () => {
    const msgs = [makeMessage(1)]
    expect(toChronologicalMessages(msgs)).toEqual([makeMessage(1)])
  })
})
