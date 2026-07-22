/**
 * MessageBubble — extended behavior coverage.
 * @vitest-environment jsdom
 *
 * Scope: text rendering with WA formats, image/media branches, reply-quote,
 * DeliveryStatus states (optimistic pk<0 / failed pk===-1 / persisted pk>0),
 * incoming vs outgoing layout, sender label + createContact button,
 * hover-detail card, animate class, onRetry handler, type badge,
 * keyboard alternative (DD-18r: focus-reveal, Escape dismiss, edge placement).
 *
 * NOT covered here (see message-bubble.test.tsx):
 *   - display-safe timestamp regressions (null/invalid timestamp → "—" marker)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Message } from '../../console/src/types'

// ── Mocks ──────────────────────────────────────────────────────────────────

// Mock lucide-react icons to predictable testid spans so assertions don't
// depend on internal SVG structure.
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

// Dynamic import after mocks are in place.
const { default: MessageBubble } = await import('../../console/src/components/MessageBubble')

// ── Fixtures ───────────────────────────────────────────────────────────────

/** Base message factory — incoming text, persisted. */
function msg(overrides: Partial<Message> = {}): Message {
  return {
    pk: 1,
    conversationKey: 'chat-1',
    senderName: 'Alice',
    senderJid: '155501230001@s.whatsapp.net',
    content: 'Hello',
    timestamp: '2026-04-05T19:30:45.000Z',
    fromMe: false,
    type: 'text',
    ...overrides,
  }
}

/** Outgoing persisted message. */
function outgoing(overrides: Partial<Message> = {}): Message {
  return msg({ fromMe: true, senderName: 'You', pk: 10, ...overrides })
}

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

// ── Text rendering ─────────────────────────────────────────────────────────

describe('text rendering', () => {
  it('renders plain text content', () => {
    render(<MessageBubble msg={msg({ content: 'Hello world' })} />)
    expect(screen.getByText('Hello world')).toBeDefined()
  })

  it('null content on text-type renders em-dash placeholder (F-043)', () => {
    // F-043 fix: MessageContent now splits the guard so type=text with null content
    // renders an em-dash placeholder <em> instead of falling through to RichMedia.
    // The bubble is visible and carries the right structure.
    render(<MessageBubble msg={msg({ type: 'text', content: null })} />)
    // Bubble is mounted
    expect(document.querySelector('.c-msg-bubble')).toBeDefined()
    // Em-dash placeholder is rendered
    expect(screen.getByText('—')).toBeDefined()
    // isMedia is false for type='text' → no type-badge span in the footer
    const footer = document.querySelector('.font-mono') as HTMLElement
    const spans = Array.from(footer.querySelectorAll('span'))
    expect(spans.every(s => s.textContent !== 'text')).toBe(true)
  })

  it('renders WA bold (*word*) as <strong>', () => {
    render(<MessageBubble msg={msg({ content: 'Hello *world* ok' })} />)
    const strong = document.querySelector('strong')
    expect(strong).toBeDefined()
    expect(strong!.textContent).toBe('world')
  })

  it('renders WA italic (_word_) as <em>', () => {
    render(<MessageBubble msg={msg({ content: '_emphasis_' })} />)
    const em = document.querySelector('em')
    expect(em).toBeDefined()
    expect(em!.textContent).toBe('emphasis')
  })

  it('renders WA code (`word`) as <code>', () => {
    render(<MessageBubble msg={msg({ content: '`inline code`' })} />)
    const code = document.querySelector('code')
    expect(code).toBeDefined()
    expect(code!.textContent).toBe('inline code')
  })

  it('renders WA strikethrough (~word~) as <s>', () => {
    render(<MessageBubble msg={msg({ content: '~strike~' })} />)
    const s = document.querySelector('s')
    expect(s).toBeDefined()
    expect(s!.textContent).toBe('strike')
  })

  it('renders URLs as anchor tags', () => {
    render(<MessageBubble msg={msg({ content: 'See https://example.com here' })} />)
    const a = document.querySelector('a')
    expect(a).toBeDefined()
    expect(a!.href).toContain('https://example.com')
  })

  it('highlights query text with <mark>', () => {
    render(<MessageBubble msg={msg({ content: 'Find the needle here' })} highlightQuery="needle" />)
    const mark = document.querySelector('mark')
    expect(mark).toBeDefined()
    expect(mark!.textContent).toBe('needle')
  })

  it('does not insert extra marks when query is absent', () => {
    render(<MessageBubble msg={msg({ content: 'No highlight' })} />)
    expect(document.querySelector('mark')).toBeNull()
  })
})

// ── Media type branch ──────────────────────────────────────────────────────

describe('media type branch', () => {
  it('image without rawMessage shows image icon (fallback MediaIndicator)', () => {
    render(<MessageBubble msg={msg({ type: 'image', content: null })} />)
    expect(screen.getByTestId('icon-image')).toBeDefined()
  })

  it('image with base64 thumbnail renders <img> with data URI', () => {
    const rawMessage = JSON.stringify({
      message: {
        imageMessage: {
          jpegThumbnail: 'abc123==',
        },
      },
    })
    render(<MessageBubble msg={msg({ type: 'image', content: 'A photo', rawMessage })} />)
    const img = document.querySelector('img') as HTMLImageElement | null
    expect(img).toBeDefined()
    expect(img!.src).toContain('data:image/jpeg;base64,abc123==')
    expect(img!.alt).toBe('A photo')
  })

  it('image with caption (no thumbnail) shows caption text', () => {
    render(<MessageBubble msg={msg({ type: 'image', content: 'A caption' })} />)
    // MediaIndicator renders caption in fallback path
    expect(screen.getByText('A caption')).toBeDefined()
  })

  it('audio without rawMessage shows audio icon', () => {
    render(<MessageBubble msg={msg({ type: 'audio', content: null })} />)
    expect(screen.getByTestId('icon-file-audio')).toBeDefined()
  })

  it('audio PTT with duration shows "Voice note · M:SS"', () => {
    const rawMessage = JSON.stringify({
      message: {
        audioMessage: { ptt: true, seconds: 75 },
      },
    })
    render(<MessageBubble msg={msg({ type: 'audio', content: null, rawMessage })} />)
    // 75s = 1:15
    expect(screen.getByText(/Voice note\s*·\s*1:15/)).toBeDefined()
  })

  it('audio non-PTT shows "Audio · duration"', () => {
    const rawMessage = JSON.stringify({
      message: {
        audioMessage: { ptt: false, seconds: 30 },
      },
    })
    render(<MessageBubble msg={msg({ type: 'audio', content: null, rawMessage })} />)
    expect(screen.getByText(/Audio\s*·\s*0:30/)).toBeDefined()
  })

  it('document shows file name and extension + size', () => {
    const rawMessage = JSON.stringify({
      message: {
        documentMessage: { fileName: 'report.pdf', fileLength: 2097152 },
      },
    })
    render(<MessageBubble msg={msg({ type: 'document', content: null, rawMessage })} />)
    expect(screen.getByText('report.pdf')).toBeDefined()
    expect(screen.getByText(/PDF\s*·\s*2\.0 MB/)).toBeDefined()
  })

  it('video with thumbnail renders <img> with data URI', () => {
    const rawMessage = JSON.stringify({
      message: {
        videoMessage: { jpegThumbnail: 'vid64==', seconds: 90 },
      },
    })
    render(<MessageBubble msg={msg({ type: 'video', content: null, rawMessage })} />)
    const img = document.querySelector('img') as HTMLImageElement | null
    expect(img).toBeDefined()
    expect(img!.src).toContain('data:image/jpeg;base64,vid64==')
    // Duration badge: 1:30
    expect(screen.getByText('1:30')).toBeDefined()
  })

  it('GIF video shows "GIF" badge', () => {
    const rawMessage = JSON.stringify({
      message: {
        videoMessage: { jpegThumbnail: 'gif64==', gifPlayback: true, seconds: 3 },
      },
    })
    render(<MessageBubble msg={msg({ type: 'video', content: null, rawMessage })} />)
    expect(screen.getByText('GIF')).toBeDefined()
  })

  it('sticker falls back to "Sticker" label', () => {
    render(<MessageBubble msg={msg({ type: 'sticker', content: null })} />)
    expect(screen.getByText('Sticker')).toBeDefined()
  })

  it('unknown media type falls back to type label string', () => {
    render(<MessageBubble msg={msg({ type: 'unknown', content: null })} />)
    expect(screen.getByText('Message')).toBeDefined()
  })

  it('non-text message shows type badge in footer', () => {
    render(<MessageBubble msg={msg({ type: 'image', content: null })} />)
    // The footer renders msg.type in a <span> when isMedia is true.
    const footer = document.querySelector('.font-mono') as HTMLElement
    const badgeTexts = Array.from(footer.querySelectorAll('span')).map(s => s.textContent)
    expect(badgeTexts).toContain('image')
  })

  it('text message does NOT show type badge in footer', () => {
    render(<MessageBubble msg={msg({ type: 'text', content: 'hi' })} />)
    // The "text" string must not appear as a badge
    expect(screen.queryByText('text')).toBeNull()
  })
})

// ── Reply quote ────────────────────────────────────────────────────────────

describe('reply-quote bar', () => {
  it('renders quoted text in reply bar', () => {
    const rawMessage = JSON.stringify({
      message: {
        extendedTextMessage: {
          text: 'My reply',
          contextInfo: {
            quotedMessage: { conversation: 'Original message' },
            participant: '155509990001@s.whatsapp.net',
          },
        },
      },
    })
    render(<MessageBubble msg={msg({ type: 'text', content: 'My reply', rawMessage })} />)
    expect(screen.getByText('Original message')).toBeDefined()
    // Participant JID stripped of @domain
    expect(screen.getByText('155509990001')).toBeDefined()
  })

  it('renders photo placeholder for quoted image', () => {
    const rawMessage = JSON.stringify({
      message: {
        extendedTextMessage: {
          text: 'Look',
          contextInfo: {
            quotedMessage: { imageMessage: {} },
          },
        },
      },
    })
    render(<MessageBubble msg={msg({ content: 'Look', rawMessage })} />)
    expect(screen.getByText('📷 Photo')).toBeDefined()
  })

  it('renders no reply bar when no contextInfo present', () => {
    render(<MessageBubble msg={msg({ content: 'Plain' })} />)
    // QuotedReplyBar has a distinctive border-left-style inline style.
    // jsdom serialises camelCase React style objects as kebab-case attribute strings.
    const bars = document.querySelectorAll('[style*="border-left-style"]')
    expect(bars).toHaveLength(0)
  })
})

// ── DeliveryStatus states ──────────────────────────────────────────────────

describe('DeliveryStatus', () => {
  it('persisted outgoing message (pk>0) shows green Check icon', () => {
    render(<MessageBubble msg={outgoing({ pk: 5 })} />)
    const check = screen.getByTestId('icon-check')
    expect(check).toBeDefined()
    // Green class
    expect(check.className).toContain('text-s-ok')
  })

  it('optimistic outgoing message (pk<0, not -1) shows muted Check icon', () => {
    render(<MessageBubble msg={outgoing({ pk: -2 })} />)
    const check = screen.getByTestId('icon-check')
    expect(check).toBeDefined()
    // Muted / soft opacity
    expect(check.className).toContain('text-text-3')
  })

  it('failed outgoing message (pk===-1) shows X icon', () => {
    render(<MessageBubble msg={outgoing({ pk: -1 })} />)
    expect(screen.getByTestId('icon-x')).toBeDefined()
    expect(screen.queryByTestId('icon-check')).toBeNull()
  })

  it('failed message shows retry button when onRetry provided', () => {
    const onRetry = vi.fn()
    render(<MessageBubble msg={outgoing({ pk: -1 })} onRetry={onRetry} />)
    const btn = screen.getByRole('button', { name: /retry send/i })
    expect(btn).toBeDefined()
    fireEvent.click(btn)
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('failed message with no onRetry hides retry button', () => {
    render(<MessageBubble msg={outgoing({ pk: -1 })} />)
    expect(screen.queryByRole('button', { name: /retry send/i })).toBeNull()
  })

  it('incoming message shows no DeliveryStatus icons', () => {
    render(<MessageBubble msg={msg({ fromMe: false })} />)
    expect(screen.queryByTestId('icon-check')).toBeNull()
    expect(screen.queryByTestId('icon-x')).toBeNull()
  })
})

// ── Optimistic message (PR #561 pattern) ──────────────────────────────────

describe('optimistic message (pk < 0, senderName: You)', () => {
  it('outgoing optimistic (pk=-2) uses muted check — not persisted check', () => {
    render(<MessageBubble msg={outgoing({ pk: -2, senderName: 'You' })} />)
    const check = screen.getByTestId('icon-check')
    // soft opacity signals "not yet persisted"
    expect((check as HTMLElement).style.opacity).toBe('var(--opacity-soft)')
  })

  it('detail card shows "sending" for optimistic pk<0 (not -1) (F-044)', () => {
    // F-044 fix: pk=-2 means optimistic-sending (not the failed sentinel pk=-1).
    // DetailCard now shows "sending" for pk<0 and "failed" only for pk===-1.
    vi.useFakeTimers()
    render(<MessageBubble msg={outgoing({ pk: -2 })} />)
    fireEvent.mouseEnter(document.querySelector('.soup-hovercard')!)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByText('sending')).toBeDefined()
    expect(screen.queryByText('pending')).toBeNull()
  })

  it('detail card shows "failed" for failed-sentinel pk===-1 (F-044)', () => {
    // F-044 fix: pk=-1 is the dedicated failed-message sentinel.
    // DetailCard shows "failed" for pk===-1, matching the retry-button gate.
    vi.useFakeTimers()
    render(<MessageBubble msg={outgoing({ pk: -1 })} />)
    fireEvent.mouseEnter(document.querySelector('.soup-hovercard')!)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByText('failed')).toBeDefined()
    expect(screen.queryByText('sending')).toBeNull()
    expect(screen.queryByText('pending')).toBeNull()
  })

  it('detail card shows "pk:N" for persisted positive pk', () => {
    vi.useFakeTimers()
    render(<MessageBubble msg={outgoing({ pk: 42 })} />)
    fireEvent.mouseEnter(document.querySelector('.soup-hovercard')!)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByText('pk:42')).toBeDefined()
  })
})

// ── Incoming vs outgoing layout ────────────────────────────────────────────

describe('incoming vs outgoing layout', () => {
  it('outgoing bubble has self-end flex alignment', () => {
    const { container } = render(<MessageBubble msg={outgoing()} />)
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('self-end')
  })

  it('incoming bubble has self-start flex alignment', () => {
    const { container } = render(<MessageBubble msg={msg({ fromMe: false })} />)
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('self-start')
  })

  it('outgoing bubble has custom outgoingBg style', () => {
    render(<MessageBubble msg={outgoing()} outgoingBg="var(--custom-color)" />)
    const bubble = document.querySelector('.c-msg-bubble') as HTMLElement
    expect(bubble.style.background).toBe('var(--custom-color)')
  })

  it('outgoing bubble defaults outgoingBg to var(--m-cht-soft)', () => {
    render(<MessageBubble msg={outgoing()} />)
    const bubble = document.querySelector('.c-msg-bubble') as HTMLElement
    expect(bubble.style.background).toBe('var(--m-cht-soft)')
  })

  it('incoming bubble has bg-surface-raised class', () => {
    render(<MessageBubble msg={msg({ fromMe: false })} />)
    const bubble = document.querySelector('.c-msg-bubble') as HTMLElement
    expect(bubble.className).toContain('bg-surface-raised')
  })

  it('outgoing bubble does NOT have bg-surface-raised class', () => {
    render(<MessageBubble msg={outgoing()} />)
    const bubble = document.querySelector('.c-msg-bubble') as HTMLElement
    expect(bubble.className).not.toContain('bg-surface-raised')
  })

  it('footer is right-aligned for outgoing messages', () => {
    render(<MessageBubble msg={outgoing()} />)
    // The footer div gets "justify-end" when fromMe
    const footer = document.querySelector('.font-mono') as HTMLElement
    expect(footer.className).toContain('justify-end')
  })

  it('footer is not right-aligned for incoming messages', () => {
    render(<MessageBubble msg={msg({ fromMe: false })} />)
    const footer = document.querySelector('.font-mono') as HTMLElement
    expect(footer.className).not.toContain('justify-end')
  })
})

// ── Sender label (incoming) ────────────────────────────────────────────────

describe('sender label', () => {
  it('incoming message shows sender name label', () => {
    render(<MessageBubble msg={msg({ senderName: 'Bob' })} />)
    expect(screen.getByText('Bob')).toBeDefined()
  })

  it('outgoing message does NOT show sender label', () => {
    render(<MessageBubble msg={outgoing({ senderName: 'You' })} />)
    // "You" should not appear as a separate sender label for outgoing
    const labels = document.querySelectorAll('.c-label')
    for (const label of labels) {
      expect(label.textContent).not.toBe('You')
    }
  })

  it('incoming raw-JID senderName shows "Save as contact" button when onCreateContact provided', () => {
    const onCreate = vi.fn()
    // Raw JID = all digits, 5+ chars
    render(<MessageBubble msg={msg({ senderName: '155501234567' })} onCreateContact={onCreate} />)
    const btn = screen.getByRole('button', { name: /save as contact/i })
    expect(btn).toBeDefined()
    fireEvent.click(btn)
    expect(onCreate).toHaveBeenCalledOnce()
  })

  it('incoming alphabetic senderName does NOT show "Save as contact" button', () => {
    render(<MessageBubble msg={msg({ senderName: 'Alice' })} onCreateContact={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /save as contact/i })).toBeNull()
  })

  it('incoming without onCreateContact never shows "Save as contact" button', () => {
    render(<MessageBubble msg={msg({ senderName: '155509876543' })} />)
    expect(screen.queryByRole('button', { name: /save as contact/i })).toBeNull()
  })
})

// ── Hover detail card ──────────────────────────────────────────────────────

describe('hover detail card', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('does not show detail card before hover', () => {
    render(<MessageBubble msg={msg()} />)
    expect(screen.queryByText('Sender')).toBeNull()
  })

  it('shows detail card after the 500ms hover reveal on the bubble', () => {
    render(<MessageBubble msg={msg({ senderJid: '155501230001@s.whatsapp.net' })} />)
    fireEvent.mouseEnter(document.querySelector('.soup-hovercard')!)
    act(() => { vi.advanceTimersByTime(499) })
    expect(screen.queryByText('Sender')).toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.getByText('Sender')).toBeDefined()
  })

  it('hides detail card after mouse leave (once the close debounce elapses)', () => {
    render(<MessageBubble msg={msg()} />)
    const rel = document.querySelector('.soup-hovercard')!
    fireEvent.mouseEnter(rel)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByText('Sender')).toBeDefined()
    act(() => {
      fireEvent.mouseLeave(rel)
      vi.advanceTimersByTime(180)
    })
    expect(screen.queryByText('Sender')).toBeNull()
  })

  it('detail card shows JID row when senderJid is provided', () => {
    render(<MessageBubble msg={msg({ senderJid: '155501230001@s.whatsapp.net' })} />)
    fireEvent.mouseEnter(document.querySelector('.soup-hovercard')!)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByText('JID')).toBeDefined()
    expect(screen.getByText('155501230001@s.whatsapp.net')).toBeDefined()
  })

  it('shows an unsafe sender JID as literal escaped detail text', () => {
    render(<MessageBubble msg={msg({ senderJid: 'owner\u202E@example.com@imessage' })} />)
    fireEvent.mouseEnter(document.querySelector('.soup-hovercard')!)
    act(() => { vi.advanceTimersByTime(500) })

    const jid = screen.getByTitle('owner\\u202E@example.com@imessage')
    expect(jid.textContent).toBe('owner\\u202E@example.com@imessage')
    expect(jid.textContent).not.toContain('\u202E')
  })

  it('detail card shows Direction as Inbound for incoming', () => {
    render(<MessageBubble msg={msg({ fromMe: false })} />)
    fireEvent.mouseEnter(document.querySelector('.soup-hovercard')!)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByText('Inbound')).toBeDefined()
  })

  it('detail card shows Direction as Outbound for outgoing', () => {
    render(<MessageBubble msg={outgoing()} />)
    fireEvent.mouseEnter(document.querySelector('.soup-hovercard')!)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByText('Outbound')).toBeDefined()
  })

  it('cancels hover timer on quick mouse leave before 500ms', () => {
    render(<MessageBubble msg={msg()} />)
    const rel = document.querySelector('.soup-hovercard')!
    fireEvent.mouseEnter(rel)
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.mouseLeave(rel)
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.queryByText('Sender')).toBeNull()
  })
})

// ── Animate prop ───────────────────────────────────────────────────────────

describe('animate prop', () => {
  it('adds msg-slide-in class when animate=true', () => {
    const { container } = render(<MessageBubble msg={msg()} animate={true} />)
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('msg-slide-in')
  })

  it('does NOT add msg-slide-in when animate is absent', () => {
    const { container } = render(<MessageBubble msg={msg()} />)
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).not.toContain('msg-slide-in')
  })

  it('does NOT add msg-slide-in when animate=false', () => {
    const { container } = render(<MessageBubble msg={msg()} animate={false} />)
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).not.toContain('msg-slide-in')
  })
})

// ── Media padding ──────────────────────────────────────────────────────────

describe('media vs text padding', () => {
  it('media bubble uses compact padding var(--sp-2) var(--sp-3)', () => {
    render(<MessageBubble msg={msg({ type: 'image', content: null })} />)
    const bubble = document.querySelector('.c-msg-bubble') as HTMLElement
    expect(bubble.style.padding).toBe('var(--sp-2) var(--sp-3)')
  })

  it('text bubble uses full padding var(--sp-2h) var(--msg-pad-h)', () => {
    render(<MessageBubble msg={msg({ type: 'text', content: 'hi' })} />)
    const bubble = document.querySelector('.c-msg-bubble') as HTMLElement
    expect(bubble.style.padding).toBe('var(--sp-2h) var(--msg-pad-h)')
  })
})

// ── Keyboard alternative — focus reveal + Escape dismiss (DD-18r) ──────────
//
// Regression proof: the hover path must survive unchanged (all 10 hover-card
// tests above pass). These cases cover the additive keyboard/focus contract.

describe('keyboard alternative — focus reveal (DD-18r)', () => {
  // Fake timers: HoverCard debounces its close (closeDelay), so blur-to-close
  // resolves after the timer rather than synchronously like the old state machine.
  beforeEach(() => { vi.useFakeTimers() })

  it('trigger bubble is focusable (tabIndex=0)', () => {
    render(<MessageBubble msg={msg()} />)
    // The bubble itself is the HoverCard trigger now, so it carries tabIndex.
    const trigger = document.querySelector('.c-msg-bubble') as HTMLElement
    expect(trigger.getAttribute('tabIndex')).toBe('0')
  })

  it('trigger bubble carries accessible name "Message detail"', () => {
    render(<MessageBubble msg={msg()} />)
    const trigger = document.querySelector('.c-msg-bubble') as HTMLElement
    expect(trigger.getAttribute('aria-label')).toBe('Message detail')
  })

  it('focus reveals the detail card with no timer advance', () => {
    render(<MessageBubble msg={msg({ senderJid: '155501230001@s.whatsapp.net' })} />)
    const wrapper = document.querySelector('.soup-hovercard') as HTMLElement
    fireEvent.focus(wrapper)
    // No act + timer advance needed — focus reveal is instant
    expect(screen.getByText('Sender')).toBeDefined()
  })

  it('blur hides the detail card (after the close debounce)', () => {
    render(<MessageBubble msg={msg()} />)
    const wrapper = document.querySelector('.soup-hovercard') as HTMLElement
    act(() => { fireEvent.focus(wrapper) })
    expect(screen.getByText('Sender')).toBeDefined()
    act(() => {
      fireEvent.blur(wrapper)
      vi.advanceTimersByTime(180)
    })
    expect(screen.queryByText('Sender')).toBeNull()
  })

  it('Escape hides the card when shown via focus', () => {
    render(<MessageBubble msg={msg()} />)
    const wrapper = document.querySelector('.soup-hovercard') as HTMLElement
    fireEvent.focus(wrapper)
    expect(screen.getByText('Sender')).toBeDefined()
    fireEvent.keyDown(wrapper, { key: 'Escape' })
    expect(screen.queryByText('Sender')).toBeNull()
  })

  it('Escape stops propagation (one-layer law §2)', () => {
    const outerHandler = vi.fn()
    render(
      <div onKeyDown={outerHandler}>
        <MessageBubble msg={msg()} />
      </div>,
    )
    const wrapper = document.querySelector('.soup-hovercard') as HTMLElement
    fireEvent.focus(wrapper)
    fireEvent.keyDown(wrapper, { key: 'Escape' })
    // Escape consumed by the card; outer handler must not fire
    expect(outerHandler).not.toHaveBeenCalled()
  })

  it('Escape does NOT stop propagation when card is hidden', () => {
    const outerHandler = vi.fn()
    render(
      <div onKeyDown={outerHandler}>
        <MessageBubble msg={msg()} />
      </div>,
    )
    const wrapper = document.querySelector('.soup-hovercard') as HTMLElement
    // Do NOT focus — card is hidden
    fireEvent.keyDown(wrapper, { key: 'Escape' })
    expect(outerHandler).toHaveBeenCalledOnce()
  })
})

// ── Hover + focus OR semantics (§6.9) ─────────────────────────────────────

describe('hover + focus OR semantics (§6.9)', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('mouse leave while focused keeps the card visible', () => {
    render(<MessageBubble msg={msg()} />)
    const wrapper = document.querySelector('.soup-hovercard') as HTMLElement
    // Focus first — card shows instantly
    fireEvent.focus(wrapper)
    expect(screen.getByText('Sender')).toBeDefined()
    // Mouse leave — card stays because focus holds it
    fireEvent.mouseLeave(wrapper)
    expect(screen.getByText('Sender')).toBeDefined()
  })

  it('blur while hovered keeps the card visible', () => {
    render(<MessageBubble msg={msg()} />)
    const wrapper = document.querySelector('.soup-hovercard') as HTMLElement
    // Hover to show card
    fireEvent.mouseEnter(wrapper)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByText('Sender')).toBeDefined()
    // Blur — card stays because hover holds it
    fireEvent.blur(wrapper)
    expect(screen.getByText('Sender')).toBeDefined()
  })

  it('both cleared — card hides', () => {
    render(<MessageBubble msg={msg()} />)
    const wrapper = document.querySelector('.soup-hovercard') as HTMLElement
    // Hover and focus both active
    fireEvent.mouseEnter(wrapper)
    act(() => { vi.advanceTimersByTime(500) })
    fireEvent.focus(wrapper)
    expect(screen.getByText('Sender')).toBeDefined()
    // Clear hover first — card stays
    fireEvent.mouseLeave(wrapper)
    expect(screen.getByText('Sender')).toBeDefined()
    // Clear focus too — the card hides once the close debounce elapses
    act(() => {
      fireEvent.blur(wrapper)
      vi.advanceTimersByTime(180)
    })
    expect(screen.queryByText('Sender')).toBeNull()
  })
})

// ── Edge placement — data-placement + rect flip (§6.7) ────────────────────
//
// jsdom getBoundingClientRect returns all zeros by default — this exercises
// the no-clip path (placement='above', left-anchored) for free, which matches
// the existing hover tests. Stubbed rects prove the flip branches.

describe('edge placement — data-placement attribute', () => {
  it('defaults to data-placement="above" with jsdom zero rects', () => {
    vi.useFakeTimers()
    render(<MessageBubble msg={msg()} />)
    const wrapper = document.querySelector('.soup-hovercard') as HTMLElement
    fireEvent.mouseEnter(wrapper)
    act(() => { vi.advanceTimersByTime(500) })
    const card = document.querySelector('[data-placement]') as HTMLElement
    expect(card.getAttribute('data-placement')).toBe('above')
  })

  it('flips to data-placement="below" when card would clip the viewport top', () => {
    render(<MessageBubble msg={msg()} />)
    const wrapper = document.querySelector('.soup-hovercard') as HTMLElement
    // Stub: wrapper is near the top — card height (160px) exceeds rect.top
    vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({
      top: 50,
      left: 200,
      right: 400,
      bottom: 80,
      width: 200,
      height: 30,
      x: 200,
      y: 50,
      toJSON: () => ({}),
    })
    fireEvent.focus(wrapper)
    const card = document.querySelector('[data-placement]') as HTMLElement
    expect(card.getAttribute('data-placement')).toBe('below')
  })

  it('right-anchors the card when left + estimatedWidth would exceed viewport width', () => {
    // Default jsdom window.innerWidth is 1024 in most env; override to a known value
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 800 })
    render(<MessageBubble msg={msg()} />)
    const wrapper = document.querySelector('.soup-hovercard') as HTMLElement
    // Stub: wrapper starts at left=700; card width 220 → 700+220=920 > 800
    vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({
      top: 400,
      left: 700,
      right: 850,
      bottom: 430,
      width: 150,
      height: 30,
      x: 700,
      y: 400,
      toJSON: () => ({}),
    })
    fireEvent.focus(wrapper)
    const card = document.querySelector('[data-placement]') as HTMLElement
    // Right-anchored: HoverCard pins the panel via data-align + the --align-right CSS
    // class (right:0 lives in the stylesheet, not as an inline style).
    expect(card.getAttribute('data-align')).toBe('right')
    // Restore
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 })
  })

  it('unmount while focused leaves no card and does not throw (§6.3)', () => {
    const { unmount } = render(<MessageBubble msg={msg()} />)
    const wrapper = document.querySelector('.soup-hovercard') as HTMLElement
    fireEvent.focus(wrapper)
    expect(screen.getByText('Sender')).toBeDefined()
    // Unmount — should not throw; card disappears with the component
    expect(() => unmount()).not.toThrow()
    expect(document.querySelector('[data-placement]')).toBeNull()
  })
})
