/**
 * MessageBubble — DD-8 Option B ink-tier evidence.
 * @vitest-environment jsdom
 *
 * Asserts that the timestamp row and media-type badge carry text-text-2 (AA ink)
 * after the DD-8 essential-text correction. Mirrors the decision-package
 * classification:
 *   - package §2.1 "MessageBubble timestamp + type row" — ESSENTIAL, sole
 *     at-rest rendering of message time; Option B promotes to text-text-2.
 *   - Sites: footer div className (text-text-2 on the row); media-type span
 *     className (text-text-2 on the badge); formatTime span carries no explicit
 *     ink class (inherits from the row).
 *
 * Positive-control pattern for negatives: text-text-3 absence assertions are
 * each paired with a text-text-2 presence assertion on the same element so a
 * broken selector cannot produce a vacuous pass.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { Message } from '../../console/src/types'

// ── Mocks ──────────────────────────────────────────────────────────────────
vi.mock('lucide-react', () => ({
  UserPlus:  (p: Record<string, unknown>) => <span data-testid="icon-user-plus" {...p} />,
  Check:     (p: Record<string, unknown>) => <span data-testid="icon-check" {...p} />,
  X:         (p: Record<string, unknown>) => <span data-testid="icon-x" {...p} />,
  RotateCw:  (p: Record<string, unknown>) => <span data-testid="icon-rotate-cw" {...p} />,
  Image:     (p: Record<string, unknown>) => <span data-testid="icon-image" {...p} />,
  Film:      (p: Record<string, unknown>) => <span data-testid="icon-film" {...p} />,
  FileAudio: (p: Record<string, unknown>) => <span data-testid="icon-file-audio" {...p} />,
  FileText:  (p: Record<string, unknown>) => <span data-testid="icon-file-text" {...p} />,
  HelpCircle:(p: Record<string, unknown>) => <span data-testid="icon-help-circle" {...p} />,
}))

const { default: MessageBubble } = await import('../../console/src/components/MessageBubble')

// ── Fixtures ───────────────────────────────────────────────────────────────

function msg(overrides: Partial<Message> = {}): Message {
  return {
    pk: 1,
    conversationKey: 'chat-fixture',
    senderName: 'Alice',
    senderJid: '155501230001@s.whatsapp.net',
    content: 'Hello',
    timestamp: '2026-04-05T19:30:45.000Z',
    fromMe: false,
    type: 'text',
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

// ---------------------------------------------------------------------------
// DD-8 — timestamp row ink tier (package §2.1 "MessageBubble timestamp + type row")
// Classification: ESSENTIAL — sole at-rest rendering of message time.
// Option B: text-text-3 → text-text-2 (7.60:1 dark / 6.03:1 light on every bed).
// ---------------------------------------------------------------------------

describe('MessageBubble DD-8 — timestamp row carries text-text-2 not text-text-3 (Option B)', () => {
  it('timestamp row has text-text-2 class (AA ink — package §2.1)', () => {
    render(<MessageBubble msg={msg()} />)
    const footer = document.querySelector('.font-mono') as HTMLElement
    // Positive control: text-text-2 must be present.
    expect(footer.className).toContain('text-text-2')
  })

  it('timestamp row does NOT carry text-text-3 (ghost tier must be absent — DD-8 §2.1)', () => {
    render(<MessageBubble msg={msg()} />)
    const footer = document.querySelector('.font-mono') as HTMLElement
    // Positive control above proved the selector found the element.
    // This assertion catches regression to the pre-Option-B ghost tier.
    expect(footer.className).not.toContain('text-text-3')
  })

  it('timestamp row ink-tier assertion is not vacuous (positive-control guard)', () => {
    // The footer must be present; this guards against a broken querySelector
    // that would make the absence assertions above trivially pass on null.
    render(<MessageBubble msg={msg()} />)
    const footer = document.querySelector('.font-mono')
    expect(footer).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// DD-8 — media-type badge ink tier (package §2.1 "MessageBubble ... :232 media type")
// Classification: ESSENTIAL — sole rendering of the media-type label in the footer.
// Option B: text-text-3 → text-text-2 on the <span> that holds msg.type.
// ---------------------------------------------------------------------------

describe('MessageBubble DD-8 — media-type badge carries text-text-2 not text-text-3 (Option B)', () => {
  it('media-type span has text-text-2 class when message is media type (AA ink)', () => {
    render(<MessageBubble msg={msg({ type: 'image', content: null })} />)
    const footer = document.querySelector('.font-mono') as HTMLElement
    // The media-type span is inside the footer; look for a child with text-text-2.
    const typeSpans = Array.from(footer.querySelectorAll('span'))
      .filter(s => s.className.includes('text-text-2') && s.textContent === 'image')
    // Positive control: at least one text-text-2 span with the type label must exist.
    expect(typeSpans.length).toBeGreaterThan(0)
  })

  it('media-type span does NOT carry text-text-3 (ghost tier absent on media badge)', () => {
    render(<MessageBubble msg={msg({ type: 'image', content: null })} />)
    const footer = document.querySelector('.font-mono') as HTMLElement
    // Positive control: the type label renders somewhere in the footer.
    const typeSpansAll = Array.from(footer.querySelectorAll('span'))
      .filter(s => s.textContent === 'image')
    expect(typeSpansAll.length).toBeGreaterThan(0)
    // Ghost-tier absence: none of those spans carries text-text-3.
    const ghostSpans = typeSpansAll.filter(s => s.className.includes('text-text-3'))
    expect(ghostSpans.length).toBe(0)
  })

  it('text-type message has no media-type span (positive control for above absence)', () => {
    // text-type messages never render isMedia=true, so no type-badge span.
    // This verifies the media-type test above is exercising a real code branch.
    render(<MessageBubble msg={msg({ type: 'text', content: 'hi' })} />)
    const footer = document.querySelector('.font-mono') as HTMLElement
    const typeSpans = Array.from(footer.querySelectorAll('span'))
      .filter(s => s.textContent === 'text')
    expect(typeSpans.length).toBe(0)
  })
})
