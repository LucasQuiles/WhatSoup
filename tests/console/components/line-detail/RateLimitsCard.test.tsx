/**
 * RateLimitsCard — render contract for the per-line throttle surface
 * (D-5, PDR-5 corrected: sender-throttle, not provider quota).
 * Spec: oc-re/specs/2026-07-19-rate-limits-surface-spec.md
 * The card self-fetches via useRateLimits (mocked here, soup-kitchen
 * idiom) — states are driven entirely through the hook mock.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

const useRateLimitsMock = vi.hoisted(() => vi.fn())

vi.mock('../../../../console/src/hooks/use-fleet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../console/src/hooks/use-fleet')>()
  return { ...actual, useRateLimits: useRateLimitsMock }
})

import { RateLimitsCard } from '../../../../console/src/components/line-detail/RateLimitsCard'
import type { RateLimitsPayload } from '../../../../console/src/types'
import type { Freshness } from '../../../../console/src/lib/freshness'

const FRESH: Freshness = { observedAt: Date.now(), stale: false }
const STALE: Freshness = { observedAt: Date.now() - 10 * 60_000, stale: true }

function payload(overrides: Partial<RateLimitsPayload> = {}): RateLimitsPayload {
  return {
    observedAt: '2026-07-19T04:00:00Z',
    supported: true,
    limit: 45,
    limitSource: 'default',
    windowMs: 3_600_000,
    throttled: 2,
    nearLimit: 1,
    topSenders: [
      { senderJid: '15550000001@s.whatsapp.net', count: 47 },
      { senderJid: '15550000002@s.whatsapp.net', count: 45 },
    ],
    windowedResponses: 120,
    windowedAttempts: 150,
    excessAttempts: 30,
    ...overrides,
  }
}

function hookReturn(overrides: Record<string, unknown> = {}) {
  return {
    data: payload(),
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    freshness: FRESH,
    ...overrides,
  }
}

afterEach(cleanup)

describe('RateLimitsCard', () => {
  it('renders the pill row with counts and severity tones — crit/warn only when nonzero', () => {
    useRateLimitsMock.mockReturnValue(hookReturn())
    render(<RateLimitsCard lineName="chat-line" />)
    expect(screen.getByText('Throttled 2')).toBeTruthy()
    expect(screen.getByText('Near limit 1')).toBeTruthy()
    expect(screen.getByText('Excess attempts 30')).toBeTruthy()
    // nonzero → crit/warn tones (tone classes on the pills)
    expect(document.querySelector('.soup-pill--crit')).not.toBeNull()
    expect(document.querySelector('.soup-pill--warn')).not.toBeNull()
  })

  it('renders neutral pills and the quiet zero-state when nothing is near the limit', () => {
    useRateLimitsMock.mockReturnValue(hookReturn({
      data: payload({ throttled: 0, nearLimit: 0, excessAttempts: 0, topSenders: [] }),
    }))
    render(<RateLimitsCard lineName="chat-line" />)
    expect(document.querySelector('.soup-pill--crit')).toBeNull()
    expect(document.querySelector('.soup-pill--warn')).toBeNull()
    expect(screen.getByText(/No senders near the limit/)).toBeTruthy()
  })

  it('renders the top senders with count/limit and the limit source', () => {
    useRateLimitsMock.mockReturnValue(hookReturn())
    render(<RateLimitsCard lineName="chat-line" />)
    expect(screen.getByText(/47\/45/)).toBeTruthy()
    expect(screen.getByText(/45\/45/)).toBeTruthy()
    expect(screen.getByText(/default 45\/h/)).toBeTruthy()
  })

  it('fails closed on readError — error panel, no pills, Retry wired to refetch', () => {
    const refetch = vi.fn()
    useRateLimitsMock.mockReturnValue(hookReturn({
      data: payload({ readError: true }),
      refetch,
    }))
    render(<RateLimitsCard lineName="chat-line" />)
    expect(screen.getByText(/Rate-limit data unavailable/)).toBeTruthy()
    expect(document.querySelector('.soup-pill')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }))
    expect(refetch).toHaveBeenCalled()
  })

  it('renders nothing when the instance tables are unsupported (legacy DB)', () => {
    useRateLimitsMock.mockReturnValue(hookReturn({
      data: payload({ supported: false }),
    }))
    const { container } = render(<RateLimitsCard lineName="chat-line" />)
    expect(container.innerHTML).toBe('')
  })

  it('marks the freshness stale when the observation is carried', () => {
    useRateLimitsMock.mockReturnValue(hookReturn({ freshness: STALE }))
    render(<RateLimitsCard lineName="chat-line" />)
    const marker = screen.getByText(/\(stale\)/)
    expect(marker.className).toContain('text-s-warn')
  })

  it('shows a loading skeleton, never fake-zero pills', () => {
    useRateLimitsMock.mockReturnValue(hookReturn({ data: undefined, isLoading: true }))
    render(<RateLimitsCard lineName="chat-line" />)
    expect(document.querySelector('.soup-pill')).toBeNull()
    expect(screen.getByText(/Loading…/)).toBeTruthy()
  })
})
