/**
 * FeedCard action and presentation regressions.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import FeedCard from '../../console/src/components/FeedCard'
import type { FeedEvent } from '../../console/src/types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function event(overrides: Partial<FeedEvent> = {}): FeedEvent {
  return {
    time: '2026-04-05T12:00:00.000Z',
    mode: 'chat',
    text: 'line-a: activity',
    instance: 'line-a',
    detail: { type: 'generic' },
    ...overrides,
  }
}

function installClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  return writeText
}

describe('FeedCard action handling', () => {
  it('renders inbound message metadata, provider badge, navigation, and copy content', async () => {
    const writeText = installClipboard()
    const onCopyResult = vi.fn()
    const onNavigate = vi.fn()

    render(
      <FeedCard
        event={event({
          provider: 'anthropic-api',
          text: 'line-a: collapsed \u00d73',
          detail: {
            type: 'message',
            direction: 'inbound',
            senderName: 'Alex',
            chatJid: '15551234567@s.whatsapp.net',
            messageId: 'wamid.123',
            preview: '*hello* _there_',
            conversationKey: 'chat key/1',
          },
        })}
        onCopyResult={onCopyResult}
        onNavigate={onNavigate}
      />,
    )

    expect(screen.getByText('recv \u00d73')).toBeDefined()
    expect(screen.getByText('Anth')).toBeDefined()
    expect(screen.getByText('Alex')).toBeDefined()
    expect(screen.getByText('51234567')).toBeDefined()
    expect(screen.getByText('hello')).toBeDefined()
    expect(screen.getByText('there')).toBeDefined()
    expect(screen.getByText(/id:wamid\.123/)).toBeDefined()
    expect(screen.getByText(/15551234567@s\.whatsapp\.net/)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Open conversation' }))
    expect(onNavigate).toHaveBeenCalledWith('/inbox?line=line-a&chat=chat%20key%2F1')

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('*hello* _there_')
      expect(onCopyResult).toHaveBeenCalledWith(true)
    })
  })

  it('renders outbound non-text messages without sender metadata', () => {
    render(
      <FeedCard
        event={event({
          text: 'line-a: media event',
          detail: {
            type: 'message',
            direction: 'outbound',
            chatJid: '15557654321@s.whatsapp.net',
            messageId: 'wamid.image',
            contentType: 'image',
          },
        })}
      />,
    )

    expect(screen.getByText('sent')).toBeDefined()
    expect(screen.getByText('57654321')).toBeDefined()
    expect(screen.getAllByText('[image]').length).toBeGreaterThan(0)
    expect(screen.getByText(/id:wamid\.image/)).toBeDefined()
    expect(screen.getByText(/15557654321@s\.whatsapp\.net/)).toBeDefined()
  })

  it('reports clipboard failures for plain events without detail payloads', async () => {
    const writeText = installClipboard(vi.fn().mockRejectedValue(new Error('clipboard denied')))
    const onCopyResult = vi.fn()

    render(
      <FeedCard
        event={event({ text: 'raw incident line', detail: undefined })}
        onCopyResult={onCopyResult}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('raw incident line')
      expect(onCopyResult).toHaveBeenCalledWith(false)
    })
  })

  it('guards the copy button against an insecure context (no clipboard API)', () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    const onCopyResult = vi.fn()

    render(
      <FeedCard
        event={event({ text: 'raw incident line', detail: undefined })}
        onCopyResult={onCopyResult}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))

    expect(onCopyResult).toHaveBeenCalledWith(false)
  })

  it('copies generic detail payloads through the fallback path', async () => {
    const writeText = installClipboard()

    render(<FeedCard event={event({ text: 'line-a: generic copy text' })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('line-a: generic copy text')
    })
  })

  it('falls back to generic presentation for unknown detail payloads', () => {
    render(
      <FeedCard
        event={event({
          text: 'line-a: unknown detail event',
          detail: { type: 'unexpected' } as unknown as FeedEvent['detail'],
        })}
      />,
    )

    expect(screen.getByText('event')).toBeDefined()
    expect(screen.getByText('unknown detail event')).toBeDefined()
  })

  it('renders critical connection recovery actions and copies the recovery trail', async () => {
    const writeText = installClipboard()
    const onRestart = vi.fn()
    const onStop = vi.fn()
    const onCopyResult = vi.fn()

    render(
      <FeedCard
        event={event({
          instance: 'q',
          isError: true,
          text: 'q: connection lost',
          detail: {
            type: 'connection',
            statusCode: 428,
            reason: 'connectionLost',
            reconnecting: true,
            state: 'connected',
          },
        })}
        onRestart={onRestart}
        onStop={onStop}
        onCopyResult={onCopyResult}
      />,
    )

    expect(screen.getByText('428')).toBeDefined()
    expect(screen.getByText('reconnected')).toBeDefined()
    expect(screen.getByText('connection lost')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Restart q' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop q instance' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))

    expect(onRestart).toHaveBeenCalledWith('q')
    expect(onStop).toHaveBeenCalledWith('q')
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('428 connection lost \u2192 reconnecting \u2192 reconnected')
      expect(onCopyResult).toHaveBeenCalledWith(true)
    })
  })

  it('labels non-terminal connection states and strips instance/component prefixes', () => {
    render(
      <FeedCard
        event={event({
          text: 'line-a: [baileys] raw connection notice',
          component: 'baileys',
          detail: { type: 'connection' },
        })}
      />,
    )
    expect(screen.getByText('raw connection notice')).toBeDefined()
    cleanup()

    render(<FeedCard event={event({ detail: { type: 'connection', state: 'connected' } })} />)
    expect(screen.getByText('connected')).toBeDefined()
    cleanup()

    render(<FeedCard event={event({ detail: { type: 'connection', state: 'connecting' } })} />)
    expect(screen.getByText('connecting')).toBeDefined()
    cleanup()

    render(
      <FeedCard
        event={event({
          detail: { type: 'connection', reconnecting: true, statusCode: 503 },
        })}
      />,
    )
    expect(screen.getByText('reconnecting')).toBeDefined()
    expect(screen.getByText('status 503')).toBeDefined()
    cleanup()

    render(
      <FeedCard
        event={event({
          detail: { type: 'connection', state: 'disconnected', reason: 'connectionReplaced' },
        })}
      />,
    )
    expect(screen.getByText('disconnected')).toBeDefined()
    expect(screen.getByText('replaced by another session')).toBeDefined()
    cleanup()

    render(<FeedCard event={event({ detail: { type: 'connection', statusCode: 502 } })} />)
    expect(screen.getByText('connection issue')).toBeDefined()
    expect(screen.getByText('status 502')).toBeDefined()
  })

  it('renders tool, session, and import details with their metadata', async () => {
    const writeText = installClipboard()
    const onCopyResult = vi.fn()

    render(
      <FeedCard
        event={event({
          detail: {
            type: 'tool_error',
            toolName: 'search',
            toolId: 'tool-err-1',
            error: 'lookup failed',
          },
        })}
        onCopyResult={onCopyResult}
      />,
    )
    expect(screen.getByText('search')).toBeDefined()
    expect(screen.getByText('tool failed')).toBeDefined()
    expect(screen.getByText('lookup failed')).toBeDefined()
    expect(screen.getByText(/tool-err-1/)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('lookup failed'))
    cleanup()

    render(
      <FeedCard
        event={event({
          detail: { type: 'tool_use', toolName: 'browser', toolId: 'tool-use-1' },
        })}
      />,
    )
    expect(screen.getByText('browser')).toBeDefined()
    expect(screen.getByText('tool used')).toBeDefined()
    expect(screen.getByText(/tool-use-1/)).toBeDefined()
    cleanup()

    render(
      <FeedCard
        event={event({
          detail: {
            type: 'session',
            action: 'resume',
            sessionId: '1234567890',
          },
        })}
      />,
    )
    expect(screen.getByText('resume')).toBeDefined()
    expect(screen.getByText('#12345678')).toBeDefined()
    cleanup()

    render(
      <FeedCard
        event={event({
          isError: true,
          detail: {
            type: 'session',
            action: 'handoff',
            sessionId: 'abcdef123456',
            chatJid: '15559876543@s.whatsapp.net',
            reason: 'escalated',
          },
        })}
      />,
    )
    expect(screen.getByText('handoff')).toBeDefined()
    expect(screen.getByText('#abcdef12')).toBeDefined()
    expect(screen.getByText('\u2014 escalated')).toBeDefined()
    expect(screen.getByText(/15559876543@s\.whatsapp\.net/)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('handoff \u2014 escalated'))
    cleanup()

    render(<FeedCard event={event({ detail: { type: 'import', table: 'messages', count: 12 } })} />)
    expect(screen.getByText('import')).toBeDefined()
    expect(screen.getByText('messages')).toBeDefined()
    expect(screen.getByText('12 rows')).toBeDefined()
    cleanup()

    render(<FeedCard event={event({ detail: { type: 'import', table: 'contacts', skipped: true } })} />)
    expect(screen.getByText('contacts')).toBeDefined()
    expect(screen.getByText('skipped')).toBeDefined()
  })

  it('copies health recovery, critical, and degraded summaries', async () => {
    const onlineWrite = installClipboard()
    render(<FeedCard event={event({ detail: { type: 'health', status: 'online' } })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
    await waitFor(() => expect(onlineWrite).toHaveBeenCalledWith('came online'))
    cleanup()

    const criticalWrite = installClipboard()
    render(<FeedCard event={event({ detail: { type: 'health', status: 'config_error' } })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
    await waitFor(() => expect(criticalWrite).toHaveBeenCalledWith('configuration error'))
    cleanup()

    const degradedWrite = installClipboard()
    render(<FeedCard event={event({ detail: { type: 'health', status: 'degraded' } })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
    await waitFor(() => expect(degradedWrite).toHaveBeenCalledWith('degraded \u2014 unknown'))
  })
})
