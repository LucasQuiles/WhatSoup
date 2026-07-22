/**
 * FeedCard — display-safe feed payload regressions.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import FeedCard from '../../console/src/components/FeedCard'
import type { FeedEvent } from '../../console/src/types'

afterEach(() => cleanup())

function event(overrides: Partial<FeedEvent> = {}): FeedEvent {
  return {
    time: '2026-04-05T12:00:00.000Z',
    mode: 'chat',
    text: 'line-a: message received',
    instance: 'line-a',
    detail: { type: 'generic' },
    ...overrides,
  }
}

describe('FeedCard malformed payload rendering', () => {
  it('renders generic events whose text is missing', () => {
    render(<FeedCard event={event({ text: null as unknown as string })} />)

    expect(screen.getByText('event')).toBeDefined()
    expect(screen.getByText('\u2014')).toBeDefined()
  })

  it('renders message events whose preview is not a string', () => {
    render(
      <FeedCard
        event={event({
          text: 'line-a: message received',
          detail: {
            type: 'message',
            direction: 'inbound',
            senderName: 'Alex',
            preview: 12345 as unknown as string,
          },
        })}
      />,
    )

    expect(screen.getByText('recv')).toBeDefined()
    expect(screen.getByText('Alex')).toBeDefined()
    expect(screen.queryByText('12345')).toBeNull()
  })

  it.each([
    ['safe\u202Eevil@signal', 'safe\\u202Eevil@signal'],
    ['safe\\u202Eevil@signal', 'safe\\\\u202Eevil@signal'],
    ['\nowner@example.com', '\\u000Aowner@example.com'],
  ])('renders provider-controlled sender names as unambiguous visible and accessible text %#', (senderName, expected) => {
    const { container } = render(
      <FeedCard
        event={event({
          detail: {
            type: 'message',
            direction: 'inbound',
            senderName,
            preview: 'hello',
          },
        })}
      />,
    )

    const headline = container.querySelector('.fc-headline')
    expect(headline?.textContent).toBe(expected)
    expect(headline?.getAttribute('title')).toBe(expected)
    expect(headline?.getAttribute('aria-label')).toBe(expected)
  })

  it('escapes an iMessage chat identity in the headline and metadata without changing the raw event', () => {
    const rawChatJid = 'owner\u202E@example.com@imessage'
    const { container } = render(
      <FeedCard
        event={event({
          detail: {
            type: 'message',
            direction: 'inbound',
            chatJid: rawChatJid,
            messageId: 'imessage-1',
          },
        })}
      />,
    )

    expect(container.querySelector('.fc-headline')?.textContent).toBe('owner\\u202E@example.com')
    expect(container.querySelector('.fc-meta')?.textContent).toContain('owner\\u202E@example.com@imessage')
    expect(container.textContent).not.toContain('\u202E')
  })

  it('renders logged-out health events as critical actionable incidents', () => {
    render(
      <FeedCard
        event={event({
          detail: { type: 'health', status: 'logged_out' },
          text: 'line-a: logged out',
        })}
        onRestart={() => undefined}
        onStop={() => undefined}
      />,
    )

    expect(screen.getByText('logged out')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Restart line-a' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Stop line-a instance' })).toBeDefined()
  })

  it('renders unknown health events as warning-level non-actionable incidents', () => {
    render(
      <FeedCard
        event={event({
          detail: { type: 'health', status: 'unknown' },
          text: 'line-a: awaiting health signal',
        })}
        onRestart={() => undefined}
        onStop={() => undefined}
      />,
    )

    expect(screen.getByText('awaiting health signal')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Restart line-a' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop line-a instance' })).toBeNull()
  })

  it('does not let a generic isError flag make unknown health actionable', () => {
    render(
      <FeedCard
        event={event({
          detail: { type: 'health', status: 'unknown' },
          isError: true,
          text: 'line-a: awaiting health signal',
        })}
        onRestart={() => undefined}
        onStop={() => undefined}
      />,
    )

    expect(screen.getByText('awaiting health signal')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Restart line-a' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop line-a instance' })).toBeNull()
  })

  it('keeps degraded health events warning-level even if an upstream payload sets isError', () => {
    const { container } = render(
      <FeedCard
        event={event({
          isError: true,
          detail: { type: 'health', status: 'degraded', error: 'ambiguous reconnect hint' },
          text: 'line-a: degraded',
        })}
        onRestart={() => undefined}
        onStop={() => undefined}
      />,
    )

    const headline = screen.getByText('degraded')
    expect(headline.className).toContain('fc-headline--warn')
    expect(headline.className).not.toContain('fc-headline--crit')
    expect(container.querySelector('.fc')?.className).not.toContain('fc--error')
    expect(screen.queryByRole('button', { name: 'Restart line-a' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop line-a instance' })).toBeNull()
  })
})

describe('FeedCard transport formatting', () => {
  it('passes iMessage previews through instead of applying WhatsApp markdown', () => {
    const { container } = render(
      <FeedCard
        transport="imessage"
        event={event({
          detail: {
            type: 'message',
            direction: 'inbound',
            senderName: 'Alex',
            preview: '*literal* _still-literal_ https://example.com',
          },
        })}
      />,
    )

    expect(container.querySelector('strong, em, s, code')).toBeNull()
    expect(container.textContent).toContain('*literal* _still-literal_')
    expect(screen.getByRole('link', { name: 'https://example.com' })).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Degraded-state mapper tests (FeedCard.tsx lines 116–263)
// One case per mapper, one per representative tone, asserting rendered
// status text and severity class — not just presence.
// ---------------------------------------------------------------------------

describe('FeedCard — connectionTone / connectionPresentation (lines 116–201)', () => {
  it('connected state renders "conn" badge with ok tone and "connected" headline', () => {
    render(
      <FeedCard
        event={event({
          detail: { type: 'connection', state: 'connected' },
          text: 'line-a: connected',
        })}
      />,
    )

    expect(screen.getByText('conn')).toBeDefined()
    const headline = screen.getByText('connected')
    expect(headline.className).toContain('fc-headline--ok')
  })

  it('reconnecting flag (without connected/connecting state) renders "reconnecting" headline with warn tone', () => {
    // reconnecting=true without state='connecting' or state='connected' hits the
    // `else if (d.reconnecting)` branch in connectionPresentation
    render(
      <FeedCard
        event={event({
          detail: { type: 'connection', reconnecting: true, reason: 'connectionLost' },
          text: 'line-a: reconnecting',
        })}
      />,
    )

    const headline = screen.getByText('reconnecting')
    expect(headline.className).toContain('fc-headline--warn')
    // reason label is shown as context
    expect(screen.getByText('connection lost')).toBeDefined()
  })

  it('disconnected state renders "disconnected" headline with crit tone', () => {
    render(
      <FeedCard
        event={event({
          detail: { type: 'connection', state: 'disconnected' },
          text: 'line-a: disconnected',
        })}
      />,
    )

    const headline = screen.getByText('disconnected')
    expect(headline.className).toContain('fc-headline--crit')
  })

  it('connection with isError flag renders crit tone on both badge and headline', () => {
    render(
      <FeedCard
        event={event({
          isError: true,
          detail: { type: 'connection', state: 'disconnected', reason: 'timedOut' },
          text: 'line-a: timed out',
        })}
      />,
    )

    const badge = screen.getByText('conn')
    expect(badge.className).toContain('fc-badge--crit')
    const headline = screen.getByText('disconnected')
    expect(headline.className).toContain('fc-headline--crit')
  })

  it('reconnected path (connected + statusCode) renders "reconnected" headline', () => {
    render(
      <FeedCard
        event={event({
          detail: { type: 'connection', state: 'connected', statusCode: 411 },
          text: 'line-a: reconnected',
        })}
      />,
    )

    expect(screen.getByText('reconnected')).toBeDefined()
    expect(screen.getByText('411')).toBeDefined()
  })
})

describe('FeedCard — toolErrorPresentation (line 223)', () => {
  it('renders badge with toolName, "tool failed" headline in crit tone, and error detail', () => {
    render(
      <FeedCard
        event={event({
          detail: {
            type: 'tool_error',
            toolName: 'send_message',
            error: 'socket timeout',
          },
          text: 'line-a: tool failed',
        })}
      />,
    )

    // badge = toolName
    const badge = screen.getByText('send_message')
    expect(badge.className).toContain('fc-badge--crit')

    // headline
    const headline = screen.getByText('tool failed')
    expect(headline.className).toContain('fc-headline--crit')

    // error detail text
    expect(screen.getByText('socket timeout')).toBeDefined()
  })

  it('falls back to "tool" badge when toolName is empty string', () => {
    render(
      <FeedCard
        event={event({
          detail: {
            type: 'tool_error',
            toolName: '',
            error: 'some error',
          },
          text: 'line-a: tool failed',
        })}
      />,
    )

    expect(screen.getByText('tool')).toBeDefined()
  })
})

describe('FeedCard — sessionPresentation (line 234)', () => {
  it('renders "session" badge with agent tone and action as headline', () => {
    render(
      <FeedCard
        event={event({
          detail: {
            type: 'session',
            action: 'started',
            sessionId: 'abc12345-0000-0000-0000-000000000000',
          },
          text: 'line-a: session started',
        })}
      />,
    )

    const badge = screen.getByText('session')
    expect(badge.className).toContain('fc-badge--agent')
    expect(screen.getByText('started')).toBeDefined()
    // context = first 8 chars of sessionId prefixed with #
    expect(screen.getByText('#abc12345')).toBeDefined()
  })

  it('renders crit headline tone when session event has isError=true', () => {
    render(
      <FeedCard
        event={event({
          isError: true,
          detail: {
            type: 'session',
            action: 'crashed',
            reason: 'OOM',
          },
          text: 'line-a: session crashed',
        })}
      />,
    )

    const headline = screen.getByText('crashed')
    expect(headline.className).toContain('fc-headline--crit')
    // reason appears as detail
    expect(screen.getByText('— OOM')).toBeDefined()
  })

  it('renders no context span when sessionId is absent', () => {
    const { container } = render(
      <FeedCard
        event={event({
          detail: {
            type: 'session',
            action: 'ended',
          },
          text: 'line-a: session ended',
        })}
      />,
    )

    expect(screen.getByText('ended')).toBeDefined()
    expect(container.querySelector('.fc-context')).toBeNull()
  })
})

describe('FeedCard — importPresentation (line 257)', () => {
  it('renders "import" badge, table name as headline, and row count as context', () => {
    render(
      <FeedCard
        event={event({
          detail: {
            type: 'import',
            table: 'messages',
            count: 1024,
          },
          text: 'line-a: import done',
        })}
      />,
    )

    expect(screen.getByText('import')).toBeDefined()
    expect(screen.getByText('messages')).toBeDefined()
    expect(screen.getByText('1024 rows')).toBeDefined()
  })

  it('renders "skipped" context when import.skipped is true', () => {
    render(
      <FeedCard
        event={event({
          detail: {
            type: 'import',
            table: 'contacts',
            skipped: true,
          },
          text: 'line-a: import skipped',
        })}
      />,
    )

    expect(screen.getByText('contacts')).toBeDefined()
    expect(screen.getByText('skipped')).toBeDefined()
  })

  it('renders "data" headline when table is absent', () => {
    render(
      <FeedCard
        event={event({
          detail: { type: 'import' },
          text: 'line-a: import',
        })}
      />,
    )

    expect(screen.getByText('data')).toBeDefined()
  })
})
