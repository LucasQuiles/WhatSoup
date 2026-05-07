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
})
