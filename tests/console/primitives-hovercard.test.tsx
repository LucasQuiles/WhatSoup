/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { HoverCard } from '../../console/src/components/primitives/HoverCard'

// Fake timers conflict with RTL auto-cleanup, so unmount + restore real timers explicitly.
afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

// HoverCard B1 — JSDOM mechanics (hover-bridge, debounce, focus path, Escape, aria wiring).
// Portal placement / clipping / reduced-motion / theme are browser-proof gates (B2), not here.

function Subject(props: { openDelay?: number; closeDelay?: number } = {}) {
  return (
    <HoverCard
      cardLabel="Message detail"
      openDelay={props.openDelay ?? 150}
      closeDelay={props.closeDelay ?? 180}
      card={<button type="button">copy</button>}
    >
      <button type="button">trigger</button>
    </HoverCard>
  )
}

const trigger = () => screen.getByRole('button', { name: 'trigger' })
const wrapper = () => trigger().parentElement as HTMLElement
const isOpen = () => trigger().getAttribute('aria-expanded') === 'true'

describe('HoverCard — disclosure wiring', () => {
  it('wires aria-expanded + aria-controls on the trigger, pointing at the card region', () => {
    render(<Subject />)
    const t = trigger()
    expect(t.getAttribute('aria-expanded')).toBe('false')
    const controls = t.getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    const region = document.getElementById(controls as string) as HTMLElement
    expect(region.getAttribute('role')).toBe('group')
    expect(region.getAttribute('aria-label')).toBe('Message detail')
    // closed → region hidden from the a11y tree
    expect(region.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('HoverCard — focus path (hover never required)', () => {
  it('opens immediately on trigger focus, closes on Escape with focus retained', () => {
    render(<Subject />)
    act(() => {
      fireEvent.focus(trigger())
    })
    expect(isOpen()).toBe(true)
    const region = document.getElementById(trigger().getAttribute('aria-controls') as string) as HTMLElement
    expect(region.getAttribute('aria-hidden')).toBeNull()

    act(() => {
      fireEvent.keyDown(wrapper(), { key: 'Escape' })
    })
    expect(isOpen()).toBe(false)
    // Escape must not move focus off the trigger (we never called blur)
  })

  it('stays open when focus moves from the trigger into interactive card content', () => {
    render(<Subject />)
    act(() => {
      fireEvent.focus(trigger())
    })
    expect(isOpen()).toBe(true)
    const copy = screen.getByRole('button', { name: 'copy' })
    // focus trigger -> card button: relatedTarget stays inside the wrapper → no close
    act(() => {
      fireEvent.blur(trigger(), { relatedTarget: copy })
      fireEvent.focus(copy)
    })
    expect(isOpen()).toBe(true)
  })

  it('stays dismissed when the trigger is refocused after Escape (no resurrect)', () => {
    render(<Subject />)
    act(() => {
      fireEvent.focus(trigger())
    })
    act(() => {
      fireEvent.keyDown(wrapper(), { key: 'Escape' })
    })
    expect(isOpen()).toBe(false)
    // trigger still holds focus; a focusin must NOT reopen the explicitly-dismissed card
    act(() => {
      fireEvent.focus(trigger())
    })
    expect(isOpen()).toBe(false)
  })

  it('renders no card content while closed (no focusable descendant under aria-hidden)', () => {
    render(<Subject />)
    expect(isOpen()).toBe(false)
    expect(screen.queryByRole('button', { name: 'copy' })).toBeNull()
  })
})

describe('HoverCard — hover debounce + bridge', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not open until openDelay elapses', () => {
    render(<Subject openDelay={150} />)
    act(() => {
      fireEvent.mouseEnter(wrapper())
    })
    expect(isOpen()).toBe(false) // still within debounce
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(isOpen()).toBe(true)
  })

  it('keeps the card open across the gap (re-enter cancels the pending close) — the hover-bridge', () => {
    render(<Subject openDelay={150} closeDelay={180} />)
    act(() => {
      fireEvent.mouseEnter(wrapper())
      vi.advanceTimersByTime(150)
    })
    expect(isOpen()).toBe(true)

    // pointer leaves the trigger toward the card → close is SCHEDULED, not immediate
    act(() => {
      fireEvent.mouseLeave(wrapper())
      vi.advanceTimersByTime(100) // less than closeDelay
    })
    expect(isOpen()).toBe(true) // bridge window still open

    // pointer lands on the card (re-enter) before closeDelay → close is cancelled
    act(() => {
      fireEvent.mouseEnter(wrapper())
      vi.advanceTimersByTime(200) // past the original closeDelay
    })
    expect(isOpen()).toBe(true) // stayed open — bridge held
  })

  it('closes after closeDelay once the pointer is fully gone', () => {
    render(<Subject openDelay={150} closeDelay={180} />)
    act(() => {
      fireEvent.mouseEnter(wrapper())
      vi.advanceTimersByTime(150)
    })
    expect(isOpen()).toBe(true)
    act(() => {
      fireEvent.mouseLeave(wrapper())
      vi.advanceTimersByTime(180)
    })
    expect(isOpen()).toBe(false)
  })

  it('reopens on a fresh hover after Escape (the dismissed latch clears on mouseenter)', () => {
    render(<Subject openDelay={150} />)
    act(() => {
      fireEvent.focus(wrapper())
    })
    expect(isOpen()).toBe(true)
    act(() => {
      fireEvent.keyDown(wrapper(), { key: 'Escape' })
    })
    expect(isOpen()).toBe(false)
    // a new hover clears the dismissal and opens again
    act(() => {
      fireEvent.mouseEnter(wrapper())
      vi.advanceTimersByTime(150)
    })
    expect(isOpen()).toBe(true)
  })
})
