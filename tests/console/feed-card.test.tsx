/**
 * FeedCard - focused behavior coverage for presentation and quick actions.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import FeedCard from '../../console/src/components/FeedCard'
import type { FeedEvent } from '../../console/src/types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function event(overrides: Partial<FeedEvent> = {}): FeedEvent {
  return {
    time: '2026-04-05T12:00:00.000Z',
    mode: 'chat',
    text: 'line-a: generic event',
    instance: 'line-a',
    detail: { type: 'generic' },
    ...overrides,
  }
}

function installClipboard(result: 'resolve' | 'reject' = 'resolve') {
  const writeText = vi.fn()
  if (result === 'resolve') {
    writeText.mockResolvedValue(undefined)
  } else {
    writeText.mockRejectedValue(new Error('denied'))
  }
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  return writeText
}

function renderInsideParent(props: Parameters<typeof FeedCard>[0]) {
  const onParentClick = vi.fn()
  const result = render(
    <div onClick={onParentClick}>
      <FeedCard {...props} />
    </div>,
  )
  return { ...result, onParentClick }
}

describe('FeedCard generic presentation', () => {
  it('strips instance and component prefixes, renders provider fallback, metadata, and mode class', () => {
    const { container } = render(
      <FeedCard
        event={event({
          text: 'line-a: [sync] imported data',
          component: 'sync',
          provider: 'unknown-provider',
        })}
      />,
    )

    expect(screen.getByText('event')).toBeDefined()
    expect(screen.getByText('imported data')).toBeDefined()
    expect(screen.getByText('unknown-provider')).toBeDefined()
    expect(screen.getByText('line-a').className).toContain('fc-inst--chat')
    expect(container.querySelector('.fc-meta')?.textContent).toBe(
      'time:2026-04-05T12:00:00.000Z \u00b7 component:sync',
    )
  })

  it('falls back to the em dash sentinel when no detail is present and text is blank', () => {
    render(<FeedCard event={event({ text: '   ', detail: undefined })} />)

    expect(screen.getByText('event')).toBeDefined()
    expect(screen.getByText('\u2014')).toBeDefined()
  })

  it('omits optional instance, provider, and metadata rows when those fields are absent', () => {
    const { container } = render(
      <FeedCard
        event={event({
          time: '',
          instance: undefined,
          provider: undefined,
          text: 'standalone event',
        })}
      />,
    )

    expect(screen.getByText('standalone event')).toBeDefined()
    expect(screen.queryByText('line-a')).toBeNull()
    expect(container.querySelector('.fc-meta')).toBeNull()
  })

  it('treats malformed unknown detail payloads as generic events', () => {
    render(
      <FeedCard
        event={event({
          detail: { type: 'unknown-detail' } as unknown as FeedEvent['detail'],
          text: 'line-a: unknown detail payload',
        })}
      />,
    )

    expect(screen.getByText('event')).toBeDefined()
    expect(screen.getByText('unknown detail payload')).toBeDefined()
  })
})

describe('FeedCard connection states', () => {
  const cases: Array<[
    string,
    Extract<NonNullable<FeedEvent['detail']>, { type: 'connection' }>,
    { badge: string; headline: string; context?: string; edge: string; tone: string },
  ]> = [
    [
      'connected',
      { type: 'connection', state: 'connected' },
      { badge: 'conn', headline: 'connected', edge: 'var(--color-s-ok)', tone: 'fc-headline--ok' },
    ],
    [
      'reconnected with status',
      { type: 'connection', state: 'connected', statusCode: 515 },
      {
        badge: '515',
        headline: 'reconnected',
        context: 'status 515',
        edge: 'var(--color-s-ok)',
        tone: 'fc-headline--ok',
      },
    ],
    [
      'connecting',
      { type: 'connection', state: 'connecting' },
      { badge: 'conn', headline: 'connecting', edge: 'var(--color-s-warn)', tone: 'fc-headline--warn' },
    ],
    [
      'reconnecting',
      { type: 'connection', reconnecting: true },
      {
        badge: 'conn',
        headline: 'reconnecting',
        context: 'retry scheduled',
        edge: 'var(--color-s-warn)',
        tone: 'fc-headline--warn',
      },
    ],
    [
      'disconnected with mapped reason',
      { type: 'connection', state: 'disconnected', reason: 'loggedOut' },
      {
        badge: 'conn',
        headline: 'disconnected',
        context: 'logged out',
        edge: 'var(--color-s-crit)',
        tone: 'fc-headline--crit',
      },
    ],
    [
      'issue with unmapped reason',
      { type: 'connection', reason: 'custom-offline' },
      {
        badge: 'conn',
        headline: 'connection issue',
        context: 'custom-offline',
        edge: 'var(--b2)',
        tone: 'fc-headline--neutral',
      },
    ],
    [
      'unclassified connection detail',
      { type: 'connection' },
      {
        badge: 'conn',
        headline: 'generic event',
        edge: 'var(--b2)',
        tone: 'fc-headline--neutral',
      },
    ],
  ]

  it.each(cases)('renders %s state from real connection detail', (_, detail, expected) => {
    const { container } = render(<FeedCard event={event({ detail })} />)

    expect(screen.getByText(expected.badge)).toBeDefined()
    const headline = screen.getByText(expected.headline)
    expect(headline.className).toContain(expected.tone)
    if (expected.context) {
      expect(screen.getByText(expected.context)).toBeDefined()
    }
    expect(container.querySelector('.fc')?.getAttribute('style') ?? '').toContain(expected.edge)
  })
})

describe('FeedCard message behavior', () => {
  it('renders inbound media metadata, navigates to an encoded conversation, and copies the preview', async () => {
    const writeText = installClipboard()
    const onNavigate = vi.fn()
    const onCopyResult = vi.fn()
    const { onParentClick } = renderInsideParent({
      event: event({
        instance: 'line one',
        text: 'line one: messages \u00d73',
        detail: {
          type: 'message',
          direction: 'inbound',
          senderName: 'Ana',
          chatJid: '15551234567@s.whatsapp.net',
          messageId: 'wamid.42',
          contentType: 'image',
          conversationKey: 'chat/one?two',
          preview: 'needs a reply',
        },
      }),
      onNavigate,
      onCopyResult,
    })

    expect(screen.getByText('recv \u00d73')).toBeDefined()
    expect(screen.getByText('Ana')).toBeDefined()
    expect(screen.getByText('51234567 \u00b7 [image]')).toBeDefined()
    expect(screen.getByText('needs a reply')).toBeDefined()
    expect(screen.getByText(/id:wamid\.42/)).toBeDefined()
    expect(screen.getByText(/15551234567@s\.whatsapp\.net/)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Open conversation' }))

    expect(onNavigate).toHaveBeenCalledWith('/inbox?line=line%20one&chat=chat%2Fone%3Ftwo')
    expect(onParentClick).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))

    await waitFor(() => expect(onCopyResult).toHaveBeenCalledWith(true))
    expect(writeText).toHaveBeenCalledWith('needs a reply')
    expect(onParentClick).not.toHaveBeenCalled()
  })

  it('falls back to direction labels and media placeholders when message names and previews are absent', () => {
    render(
      <FeedCard
        event={event({
          text: 'line-a: sent media',
          detail: {
            type: 'message',
            direction: 'outbound',
            contentType: 'audio',
          },
        })}
      />,
    )

    expect(screen.getByText('sent')).toBeDefined()
    expect(screen.getByText('outgoing')).toBeDefined()
    const placeholders = screen.getAllByText('[audio]')
    expect(placeholders.length).toBeGreaterThanOrEqual(1)
  })

  it('does not append a collapsed count badge when the parsed count is one', () => {
    render(
      <FeedCard
        event={event({
          text: 'line-a: message \u00d71',
          detail: {
            type: 'message',
            direction: 'inbound',
            preview: 'single message',
          },
        })}
      />,
    )

    expect(screen.getByText('recv')).toBeDefined()
    expect(screen.queryByText('recv \u00d71')).toBeNull()
  })
})

describe('FeedCard quick actions', () => {
  it('restarts and stops errored connections, reports clipboard failures, and does not bubble action clicks', async () => {
    const writeText = installClipboard('reject')
    const onRestart = vi.fn()
    const onStop = vi.fn()
    const onCopyResult = vi.fn()
    const { container, onParentClick } = renderInsideParent({
      event: event({
        isError: true,
        detail: {
          type: 'connection',
          state: 'disconnected',
          statusCode: 401,
          reason: 'loggedOut',
          reconnecting: true,
        },
      }),
      onRestart,
      onStop,
      onCopyResult,
    })

    expect(container.querySelector('.fc')?.className).toContain('fc--error')
    expect(screen.getByText('401')).toBeDefined()
    expect(screen.getByText('logged out')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Restart line-a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop line-a instance' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))

    expect(onRestart).toHaveBeenCalledWith('line-a')
    expect(onStop).toHaveBeenCalledWith('line-a')
    expect(onParentClick).not.toHaveBeenCalled()
    expect(writeText.mock.calls[0]?.[0]).toContain('401 logged out')
    expect(writeText.mock.calls[0]?.[0]).toContain('reconnecting')
    await waitFor(() => expect(onCopyResult).toHaveBeenCalledWith(false))
  })

  it('exposes restart and stop actions for unreachable health events and copies health state text', async () => {
    const writeText = installClipboard()
    const onRestart = vi.fn()
    const onStop = vi.fn()
    const onCopyResult = vi.fn()
    render(
      <FeedCard
        event={event({
          detail: { type: 'health', status: 'unreachable', error: 'socket down' },
        })}
        onRestart={onRestart}
        onStop={onStop}
        onCopyResult={onCopyResult}
      />,
    )

    expect(screen.getByText('health')).toBeDefined()
    expect(screen.getByText('connection lost')).toBeDefined()
    expect(screen.getByText('socket down')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Restart line-a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop line-a instance' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))

    expect(onRestart).toHaveBeenCalledWith('line-a')
    expect(onStop).toHaveBeenCalledWith('line-a')
    await waitFor(() => expect(onCopyResult).toHaveBeenCalledWith(true))
    expect(writeText).toHaveBeenCalledWith('connection lost')
  })

  it('copies online and degraded health summaries without showing restart controls', async () => {
    const writeText = installClipboard()
    const onRestart = vi.fn()
    const onCopyResult = vi.fn()
    const { rerender } = render(
      <FeedCard
        event={event({ detail: { type: 'health', status: 'online' } })}
        onRestart={onRestart}
        onCopyResult={onCopyResult}
      />,
    )

    expect(screen.getByText('came online')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Restart line-a' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('came online'))

    rerender(
      <FeedCard
        event={event({ detail: { type: 'health', status: 'degraded', error: 'slow poll' } })}
        onRestart={onRestart}
        onCopyResult={onCopyResult}
      />,
    )

    expect(screen.getByText('degraded')).toBeDefined()
    expect(screen.getByText('slow poll')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Restart line-a' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('degraded \u2014 slow poll'))
    expect(onRestart).not.toHaveBeenCalled()
  })
})

describe('FeedCard detail-specific rendering', () => {
  it('renders tool errors with error detail styling, tool metadata, and copy text', async () => {
    const writeText = installClipboard()
    const onCopyResult = vi.fn()
    const { container } = render(
      <FeedCard
        event={event({
          detail: {
            type: 'tool_error',
            toolName: 'sendMessage',
            toolId: 'tool-call-123',
            error: 'rate limited',
          },
        })}
        onCopyResult={onCopyResult}
      />,
    )

    expect(screen.getByText('sendMessage')).toBeDefined()
    expect(screen.getByText('tool failed')).toBeDefined()
    expect(screen.getByText('rate limited')).toBeDefined()
    expect(container.querySelector('.fc-detail')?.className).toContain('fc-detail--error')
    expect(screen.getByText(/tool-call-123/)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))

    await waitFor(() => expect(onCopyResult).toHaveBeenCalledWith(true))
    expect(writeText).toHaveBeenCalledWith('rate limited')
  })

  it('renders tool use, session, and import summaries from their payloads', () => {
    const { rerender, container } = render(
      <FeedCard
        event={event({
          detail: { type: 'tool_use', toolName: '', toolId: 'tool-call-456' },
        })}
      />,
    )

    expect(screen.getByText('tool')).toBeDefined()
    expect(screen.getByText('tool used')).toBeDefined()
    expect(screen.getByText(/tool-call-456/)).toBeDefined()

    rerender(
      <FeedCard
        event={event({
          detail: {
            type: 'session',
            action: 'handoff',
            sessionId: 'abcdef1234567890',
            chatJid: 'session-chat@s.whatsapp.net',
            reason: 'operator requested',
          },
        })}
      />,
    )

    expect(screen.getByText('session')).toBeDefined()
    expect(screen.getByText('handoff')).toBeDefined()
    expect(screen.getByText('#abcdef12')).toBeDefined()
    expect(screen.getByText('\u2014 operator requested')).toBeDefined()
    expect(screen.getByText(/session-chat@s\.whatsapp\.net/)).toBeDefined()
    expect(container.querySelector('.fc-detail')?.className).toContain('fc-detail--muted')

    rerender(<FeedCard event={event({ detail: { type: 'import', table: 'messages', count: 42 } })} />)

    expect(screen.getByText('import')).toBeDefined()
    expect(screen.getByText('messages')).toBeDefined()
    expect(screen.getByText('42 rows')).toBeDefined()

    rerender(<FeedCard event={event({ detail: { type: 'import', skipped: true } })} />)

    expect(screen.getByText('data')).toBeDefined()
    expect(screen.getByText('skipped')).toBeDefined()
  })

  it('renders empty tool-error, errored session, and import-without-context fallbacks', () => {
    const { rerender, container } = render(
      <FeedCard
        event={event({
          detail: {
            type: 'tool_error',
            toolName: '',
            error: '',
          },
        })}
      />,
    )

    expect(screen.getByText('tool')).toBeDefined()
    expect(screen.getByText('tool failed')).toBeDefined()
    expect(screen.getByText('\u2014')).toBeDefined()

    rerender(
      <FeedCard
        event={event({
          isError: true,
          detail: {
            type: 'session',
            action: 'failed',
          },
        })}
      />,
    )

    expect(screen.getByText('failed').className).toContain('fc-headline--crit')
    expect(container.querySelector('.fc-detail')).toBeNull()

    rerender(<FeedCard event={event({ detail: { type: 'import' } })} />)

    expect(screen.getByText('import')).toBeDefined()
    expect(screen.getByText('data')).toBeDefined()
    expect(container.querySelector('.fc-context')).toBeNull()
  })

  it('uses registered provider short names when available', () => {
    render(<FeedCard event={event({ mode: 'agent', provider: 'codex-cli' })} />)

    expect(screen.getByText('CDX')).toBeDefined()
    expect(screen.getByText('line-a').className).toContain('fc-inst--agent')
  })

  it('keeps a compact action bar with only copy when optional callbacks are absent', () => {
    const { container } = render(
      <FeedCard
        event={event({
          detail: {
            type: 'message',
            direction: 'inbound',
            conversationKey: 'chat-1',
            preview: 'hello',
          },
        })}
      />,
    )

    const actions = container.querySelector('.fc-actions')
    expect(actions).toBeDefined()
    expect(within(actions as HTMLElement).getByRole('button', { name: 'Copy to clipboard' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Open conversation' })).toBeNull()
  })
})
