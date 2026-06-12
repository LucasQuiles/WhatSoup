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
