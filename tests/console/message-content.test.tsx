/**
 * MessageContent — malformed quoted-message metadata regressions.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import MessageContent from '../../console/src/components/MessageContent'
import type { Message } from '../../console/src/types'

afterEach(() => cleanup())

function message(overrides: Partial<Message> = {}): Message {
  return {
    pk: 42,
    conversationKey: 'chat-1',
    senderName: 'Alice',
    senderJid: 'sender-fixture-jid',
    content: 'Reply body',
    timestamp: '2026-04-05T19:30:45.000Z',
    fromMe: false,
    type: 'text',
    ...overrides,
  }
}

describe('MessageContent quoted metadata', () => {
  it('ignores non-string quoted participants from raw history payloads', () => {
    const rawMessage = JSON.stringify({
      message: {
        extendedTextMessage: {
          text: 'Reply body',
          contextInfo: {
            participant: 12345,
            quotedMessage: { conversation: 'Quoted preview' },
          },
        },
      },
    })

    render(<MessageContent msg={message({ rawMessage })} />)

    expect(screen.getByText('Quoted preview')).toBeDefined()
    expect(screen.getByText('Reply body')).toBeDefined()
    expect(screen.queryByText('12345')).toBeNull()
  })
})

describe('MessageContent document metadata', () => {
  it('falls back when raw document file names are not strings', () => {
    const rawMessage = JSON.stringify({
      message: {
        documentMessage: {
          fileName: 12345,
          fileLength: 2048,
        },
      },
    })

    render(<MessageContent msg={message({ type: 'document', content: null, rawMessage })} />)

    expect(screen.getByText('Document')).toBeDefined()
    expect(screen.getByText('2.0 KB')).toBeDefined()
  })
})
