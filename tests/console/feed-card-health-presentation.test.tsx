/**
 * FeedCard health presentation contract (#2523).
 *
 * The health feed detail already carries `reason`, `confidence` and `evidence`
 * (console/src/types.ts). Before this contract the card read only `status` and
 * `error`, so a confirmed bounded cause reached the operator as a bare severity
 * word and copied as "degraded — unknown".
 *
 * These cases pin the operator-facing projection: a registered reason renders a
 * human label plus confidence, the clipboard carries exactly the text the card
 * presents, an unregistered code fails closed, and raw error/evidence text never
 * becomes the label, the accessible name, a tooltip, or clipboard content.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import FeedCard from '../../console/src/components/FeedCard'
import type { FeedEvent } from '../../console/src/types'

const _origNavClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (_origNavClipboard) {
    Object.defineProperty(navigator, 'clipboard', _origNavClipboard)
  } else {
    delete (navigator as unknown as Record<string, unknown>).clipboard
  }
})

function event(overrides: Partial<FeedEvent> = {}): FeedEvent {
  return {
    time: '2026-04-05T12:00:00.000Z',
    mode: 'chat',
    text: 'line-a: health changed',
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

/** The card's own visible projection: headline plus the classification context. */
function presentedText(container: HTMLElement): string {
  const headline = container.querySelector('.fc-headline')?.textContent ?? ''
  const context = container.querySelector('.fc-context')?.textContent
  return context ? `${headline} — ${context}` : headline
}

describe('FeedCard health presentation — registered reason codes', () => {
  it('shows a human reason label and the confidence for a confirmed health_body_unhealthy event', () => {
    render(
      <FeedCard
        event={event({
          detail: {
            type: 'health',
            status: 'degraded',
            confidence: 'confirmed',
            reason: 'health_body_unhealthy',
          },
        })}
      />,
    )

    const context = document.querySelector('.fc-context')!.textContent!
    expect(context).toContain('health response reports unhealthy')
    expect(context).toContain('health_body_unhealthy')
    expect(context).toContain('confirmed')
  })

  it('distinguishes an ambiguous degraded event from a confirmed one in text, not colour alone', () => {
    const { container: confirmed } = render(
      <FeedCard
        event={event({
          detail: {
            type: 'health',
            status: 'degraded',
            confidence: 'confirmed',
            reason: 'health_body_unhealthy',
          },
        })}
      />,
    )
    const confirmedText = confirmed.querySelector('.fc-context')!.textContent!
    cleanup()

    const { container: ambiguous } = render(
      <FeedCard
        event={event({
          detail: {
            type: 'health',
            status: 'degraded',
            confidence: 'ambiguous',
            reason: 'health_body_unrecognized',
          },
        })}
      />,
    )
    const ambiguousText = ambiguous.querySelector('.fc-context')!.textContent!

    expect(confirmedText).toContain('confirmed')
    expect(ambiguousText).toContain('ambiguous')
    expect(ambiguousText).not.toBe(confirmedText)
  })

  it('labels an observation-availability failure distinctly from domain unhealthiness', () => {
    const { container } = render(
      <FeedCard
        event={event({
          detail: {
            type: 'health',
            status: 'degraded',
            confidence: 'ambiguous',
            reason: 'health_probe_timeout_under_proxy_load',
          },
        })}
      />,
    )

    expect(container.querySelector('.fc-context')!.textContent).toContain('observation unavailable')
  })
})

describe('FeedCard health presentation — clipboard parity', () => {
  it('copies exactly the classification the card presents for a confirmed bounded reason', async () => {
    const writeText = installClipboard()
    const { container } = render(
      <FeedCard
        event={event({
          detail: {
            type: 'health',
            status: 'degraded',
            confidence: 'confirmed',
            reason: 'health_body_unhealthy',
          },
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(writeText).toHaveBeenCalledWith(presentedText(container))
  })

  it('never copies "degraded — unknown" when the event supplied a bounded reason', async () => {
    const writeText = installClipboard()
    render(
      <FeedCard
        event={event({
          detail: {
            type: 'health',
            status: 'degraded',
            confidence: 'confirmed',
            reason: 'health_body_unhealthy',
          },
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    const copied = writeText.mock.calls[0]![0] as string
    expect(copied).not.toBe('degraded — unknown')
    expect(copied).toContain('health response reports unhealthy')
  })
})

describe('FeedCard health presentation — fail-closed unsupported codes', () => {
  it('renders an unregistered reason code as an explicit unsupported state', () => {
    const { container } = render(
      <FeedCard
        event={event({
          detail: {
            type: 'health',
            status: 'degraded',
            confidence: 'confirmed',
            reason: 'totally_made_up_reason',
          },
        })}
      />,
    )

    expect(container.querySelector('.fc-context')!.textContent).toContain('unsupported reason code')
  })

  it('does not echo the unregistered reason string as trusted prose', () => {
    const { container } = render(
      <FeedCard
        event={event({
          detail: {
            type: 'health',
            status: 'degraded',
            confidence: 'confirmed',
            reason: 'totally_made_up_reason',
          },
        })}
      />,
    )

    expect(container.textContent).not.toContain('totally_made_up_reason')
  })
})

describe('FeedCard health presentation — raw error and evidence containment', () => {
  // Distinct sentinels so a leak names its own source, and every sink is
  // exercised: visible text, attributes and accessible names, and the clipboard.
  const ERROR_SENTINEL = 'ECONNREFUSED 127.0.0.1:4001 while reading /var/run/whatsoup.sock'
  const EVIDENCE_SENTINEL = 'EVIDENCESENTINEL-raw_stack=Error: boom'

  function leakyEvent() {
    return event({
      detail: {
        type: 'health',
        status: 'degraded',
        confidence: 'confirmed',
        reason: 'health_body_unhealthy',
        error: ERROR_SENTINEL,
        evidence: ['health_body_status=unhealthy', EVIDENCE_SENTINEL],
      },
    })
  }

  it('keeps both sentinels out of the visible text, tooltips and accessible names', () => {
    const { container } = render(
      <FeedCard event={leakyEvent()} onRestart={() => undefined} onStop={() => undefined} />,
    )

    expect(container.textContent).not.toContain(ERROR_SENTINEL)
    expect(container.textContent).not.toContain(EVIDENCE_SENTINEL)
    for (const el of container.querySelectorAll('[title], [aria-label]')) {
      const attrs = `${el.getAttribute('title') ?? ''} ${el.getAttribute('aria-label') ?? ''}`
      expect(attrs).not.toContain(ERROR_SENTINEL)
      expect(attrs).not.toContain(EVIDENCE_SENTINEL)
    }
  })

  it('keeps both sentinels out of the copied text', async () => {
    const writeText = installClipboard()
    render(<FeedCard event={leakyEvent()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    const copied = writeText.mock.calls[0]![0] as string
    expect(copied).not.toContain(ERROR_SENTINEL)
    expect(copied).not.toContain(EVIDENCE_SENTINEL)
    expect(copied).toBe(
      'degraded — health response reports unhealthy (health_body_unhealthy) · confidence confirmed',
    )
  })

  it('cannot be used to smuggle raw text through the confidence field', async () => {
    const writeText = installClipboard()
    const forged = 'CONFIDENCESENTINEL raw leak'
    const { container } = render(
      <FeedCard
        event={event({
          detail: {
            type: 'health',
            status: 'degraded',
            reason: 'health_body_unhealthy',
            confidence: forged as unknown as 'confirmed',
          },
        })}
      />,
    )

    expect(container.textContent).not.toContain(forged)
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(writeText.mock.calls[0]![0] as string).not.toContain(forged)
  })
})

describe('FeedCard health presentation — next-action metadata is not mutation authority', () => {
  it('does not enable restart or stop for a confirmed degraded event whose class suggests a restart', () => {
    render(
      <FeedCard
        event={event({
          detail: {
            type: 'health',
            status: 'degraded',
            confidence: 'confirmed',
            reason: 'health_body_unhealthy',
          },
        })}
        onRestart={() => undefined}
        onStop={() => undefined}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Restart line-a' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop line-a instance' })).toBeNull()
  })
})
