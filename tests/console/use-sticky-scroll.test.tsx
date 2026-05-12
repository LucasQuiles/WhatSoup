/**
 * Tests for console/src/hooks/use-sticky-scroll.ts
 *
 * The hook is pure DOM-ref behavior — no router, no query client — so we use
 * renderHook + @vitest-environment jsdom. The scroll element is a real div
 * whose scrollHeight / clientHeight / scrollTop are controlled via
 * Object.defineProperty on the instance (jsdom does not implement layout,
 * so these values stay 0 unless overridden).
 *
 * Key thresholds (from source):
 *   stuck  = gap <= 50      where gap = scrollHeight - scrollTop - clientHeight
 *   showJump = gap > 200
 *
 * Fake-timer note: the key-change effect calls queueMicrotask(() => setShowJump(false)).
 * Tests that exercise that path flush the microtask queue explicitly.
 *
 * Source surprises documented inline:
 *  S1 — wasAtBottomRef starts true, so useLayoutEffect auto-scrolls on first items render
 *  S2 — showJump threshold (> 200) is SEPARATE from stuck threshold (<= 50);
 *       a gap of 51-200 makes wasAtBottom false but showJump stays false
 *  S3 — jumpToBottom sets needsPinRef=false (stays pinned, does NOT re-force-scroll next items render)
 *  S4 — key change uses queueMicrotask for setShowJump, not synchronous — need microtask flush
 *  S5 — handleScroll is a no-op when scrollRef is not yet attached (ref is null)
 *  S6 — jumpToBottom is also a no-op when ref is not attached
 *  S7 — useLayoutEffect skips scroll when items is empty (length === 0 guard)
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useStickyScroll } from '../../console/src/hooks/use-sticky-scroll'

// ---------------------------------------------------------------------------
// Scroll-element helpers
// ---------------------------------------------------------------------------

/**
 * Build a div whose layout properties are controllable.
 * jsdom provides no layout engine so scrollHeight / clientHeight always read 0
 * unless we define them.
 */
function makeScrollEl(opts: {
  scrollHeight: number
  clientHeight: number
  scrollTop?: number
}): HTMLDivElement {
  const el = document.createElement('div')
  let _scrollTop = opts.scrollTop ?? 0
  Object.defineProperty(el, 'scrollHeight', {
    get: () => opts.scrollHeight,
    configurable: true,
  })
  Object.defineProperty(el, 'clientHeight', {
    get: () => opts.clientHeight,
    configurable: true,
  })
  Object.defineProperty(el, 'scrollTop', {
    get: () => _scrollTop,
    set: (v: number) => { _scrollTop = v },
    configurable: true,
  })
  return el
}

/** Attach a pre-built div to the ref returned by the hook. */
function attachRef(ref: React.RefObject<HTMLDivElement | null>, el: HTMLDivElement): void {
  Object.defineProperty(ref, 'current', {
    get: () => el,
    set: () => { /* noop — React would normally set this */ },
    configurable: true,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('useStickyScroll — initial state', () => {
  it('returns the expected API surface', () => {
    const { result } = renderHook(() => useStickyScroll([], 'chat-1'))
    expect(typeof result.current.scrollRef).toBe('object')
    expect(typeof result.current.showJump).toBe('boolean')
    expect(typeof result.current.handleScroll).toBe('function')
    expect(typeof result.current.jumpToBottom).toBe('function')
  })

  it('showJump starts false', () => {
    const { result } = renderHook(() => useStickyScroll([], 'chat-1'))
    expect(result.current.showJump).toBe(false)
  })

  it('scrollRef.current is null before a DOM element is attached', () => {
    const { result } = renderHook(() => useStickyScroll([], 'chat-1'))
    // useRef starts null — handleScroll and jumpToBottom must tolerate it without throwing
    expect(result.current.scrollRef.current).toBeNull()
    expect(() => act(() => { result.current.handleScroll() })).not.toThrow()
    expect(() => act(() => { result.current.jumpToBottom() })).not.toThrow()
    expect(result.current.showJump).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// handleScroll — stuck / showJump thresholds
// ---------------------------------------------------------------------------

describe('useStickyScroll — handleScroll threshold behavior', () => {
  it('keeps showJump false when gap is 0 (scrolled to bottom)', () => {
    const { result } = renderHook(() => useStickyScroll(['a'], 'chat-1'))
    const el = makeScrollEl({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 })
    attachRef(result.current.scrollRef, el)

    // gap = 1000 - 600 - 400 = 0
    act(() => { result.current.handleScroll() })

    expect(result.current.showJump).toBe(false)
  })

  it('keeps showJump false when gap is exactly 50 (edge of stuck threshold)', () => {
    const { result } = renderHook(() => useStickyScroll(['a'], 'chat-1'))
    const el = makeScrollEl({ scrollHeight: 1000, clientHeight: 400, scrollTop: 550 })
    attachRef(result.current.scrollRef, el)

    // gap = 1000 - 550 - 400 = 50 → wasAtBottom true, showJump false
    act(() => { result.current.handleScroll() })

    expect(result.current.showJump).toBe(false)
  })

  it('does NOT show jump when gap is in 51-200 band (not stuck, not jump zone)', () => {
    const { result } = renderHook(() => useStickyScroll(['a'], 'chat-1'))
    const el = makeScrollEl({ scrollHeight: 1000, clientHeight: 400, scrollTop: 500 })
    attachRef(result.current.scrollRef, el)

    // gap = 1000 - 500 - 400 = 100 → wasAtBottom false, showJump false (> 200 required)
    act(() => { result.current.handleScroll() })

    expect(result.current.showJump).toBe(false)
  })

  it('shows jump when gap is exactly 201 (one above threshold)', () => {
    const { result } = renderHook(() => useStickyScroll(['a'], 'chat-1'))
    const el = makeScrollEl({ scrollHeight: 1000, clientHeight: 400, scrollTop: 399 })
    attachRef(result.current.scrollRef, el)

    // gap = 1000 - 399 - 400 = 201
    act(() => { result.current.handleScroll() })

    expect(result.current.showJump).toBe(true)
  })

  it('shows jump when user scrolls far up (gap >> 200)', () => {
    const { result } = renderHook(() => useStickyScroll(['a'], 'chat-1'))
    const el = makeScrollEl({ scrollHeight: 2000, clientHeight: 500, scrollTop: 0 })
    attachRef(result.current.scrollRef, el)

    // gap = 2000 - 0 - 500 = 1500
    act(() => { result.current.handleScroll() })

    expect(result.current.showJump).toBe(true)
  })

  it('gap exactly 200 does NOT show jump (boundary: > 200 required)', () => {
    const { result } = renderHook(() => useStickyScroll(['a'], 'chat-1'))
    const el = makeScrollEl({ scrollHeight: 1000, clientHeight: 400, scrollTop: 400 })
    attachRef(result.current.scrollRef, el)

    // gap = 1000 - 400 - 400 = 200 → NOT > 200
    act(() => { result.current.handleScroll() })

    expect(result.current.showJump).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// handleScroll — scroll-up then scroll-back-to-bottom
// ---------------------------------------------------------------------------

describe('useStickyScroll — scroll-up then return to bottom', () => {
  it('scroll up makes showJump true; scroll back to bottom clears it', () => {
    const { result } = renderHook(() => useStickyScroll(['a'], 'chat-1'))
    const el = makeScrollEl({ scrollHeight: 2000, clientHeight: 500, scrollTop: 0 })
    attachRef(result.current.scrollRef, el)

    // Scroll up — gap = 1500
    act(() => { result.current.handleScroll() })
    expect(result.current.showJump).toBe(true)

    // Scroll back to bottom — gap = 0
    el.scrollTop = 1500
    act(() => { result.current.handleScroll() })
    expect(result.current.showJump).toBe(false)
  })

  it('wasAtBottom tracks correctly across multiple scroll events', () => {
    const items = ['a', 'b', 'c']
    const { result } = renderHook(() => useStickyScroll(items, 'chat-1'))
    const el = makeScrollEl({ scrollHeight: 2000, clientHeight: 500, scrollTop: 1500 })
    attachRef(result.current.scrollRef, el)

    // At bottom (gap = 0): wasAtBottom true
    act(() => { result.current.handleScroll() })
    expect(result.current.showJump).toBe(false)

    // Scroll up to gap=300: wasAtBottom false, showJump true
    el.scrollTop = 1200
    act(() => { result.current.handleScroll() })
    expect(result.current.showJump).toBe(true)

    // Scroll part way back — gap=100, no jump
    el.scrollTop = 1400
    act(() => { result.current.handleScroll() })
    expect(result.current.showJump).toBe(false)
  })

  it('repeated handleScroll calls with same scrollTop are idempotent', () => {
    // Start empty so force-pin fires without a ref (no-op), then attach and add items.
    const el = makeScrollEl({ scrollHeight: 2000, clientHeight: 500, scrollTop: 0 })
    const { result, rerender } = renderHook(
      ({ items }: { items: string[] }) => useStickyScroll(items, 'chat-1'),
      { initialProps: { items: [] } },
    )
    attachRef(result.current.scrollRef, el)

    // Add items → force-pin fires → scrollTop = scrollHeight = 2000; needsPinRef = false
    act(() => { rerender({ items: ['a'] }) })

    // Simulate user scrolling to top (far from bottom)
    el.scrollTop = 0
    act(() => { result.current.handleScroll() }) // gap = 1500 → showJump = true
    const firstShowJump = result.current.showJump

    // Repeat with same scrollTop — result must be identical
    act(() => { result.current.handleScroll() })
    act(() => { result.current.handleScroll() })

    expect(result.current.showJump).toBe(firstShowJump)
    expect(result.current.showJump).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// handleScroll — null ref guard (S5)
// ---------------------------------------------------------------------------

describe('useStickyScroll — null ref guard', () => {
  it('handleScroll is a no-op when scrollRef is not attached', () => {
    const { result } = renderHook(() => useStickyScroll(['a'], 'chat-1'))
    // ref.current stays null — never attached
    expect(() => {
      act(() => { result.current.handleScroll() })
    }).not.toThrow()
    expect(result.current.showJump).toBe(false)
  })

  it('jumpToBottom is a no-op when scrollRef is not attached', () => {
    const { result } = renderHook(() => useStickyScroll(['a'], 'chat-1'))
    expect(() => {
      act(() => { result.current.jumpToBottom() })
    }).not.toThrow()
    expect(result.current.showJump).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// jumpToBottom
// ---------------------------------------------------------------------------

describe('useStickyScroll — jumpToBottom', () => {
  it('sets scrollTop to scrollHeight', () => {
    const { result } = renderHook(() => useStickyScroll(['a'], 'chat-1'))
    const el = makeScrollEl({ scrollHeight: 2000, clientHeight: 500, scrollTop: 0 })
    attachRef(result.current.scrollRef, el)

    act(() => { result.current.jumpToBottom() })

    expect(el.scrollTop).toBe(2000)
  })

  it('clears showJump after jumpToBottom', () => {
    const { result } = renderHook(() => useStickyScroll(['a'], 'chat-1'))
    const el = makeScrollEl({ scrollHeight: 2000, clientHeight: 500, scrollTop: 0 })
    attachRef(result.current.scrollRef, el)

    // First scroll up to show jump button
    act(() => { result.current.handleScroll() })
    expect(result.current.showJump).toBe(true)

    // Jump to bottom — should clear it
    act(() => { result.current.jumpToBottom() })
    expect(result.current.showJump).toBe(false)
  })

  it('jumpToBottom scrolls even when already at bottom', () => {
    const { result } = renderHook(() => useStickyScroll(['a'], 'chat-1'))
    const el = makeScrollEl({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 })
    attachRef(result.current.scrollRef, el)

    act(() => { result.current.jumpToBottom() })

    // scrollTop should equal scrollHeight
    expect(el.scrollTop).toBe(1000)
    expect(result.current.showJump).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// useLayoutEffect — auto-scroll on items change
// ---------------------------------------------------------------------------

describe('useStickyScroll — useLayoutEffect auto-scroll on items', () => {
  it('auto-scrolls to bottom when items arrive after ref is attached (force-pin path)', () => {
    // Start with no items so useLayoutEffect is a no-op on first render.
    // Attach the ref, THEN add items — the layout effect fires with a live ref
    // and the force-pin branch (needsPin=true) sets scrollTop = scrollHeight.
    const el = makeScrollEl({ scrollHeight: 1000, clientHeight: 400, scrollTop: 0 })

    const { result, rerender } = renderHook(
      ({ items }: { items: string[] }) => useStickyScroll(items, 'chat-1'),
      { initialProps: { items: [] } },
    )
    attachRef(result.current.scrollRef, el)

    // Add items — useLayoutEffect runs, ref is attached, needsPin=true → scrollTop = scrollHeight
    act(() => {
      rerender({ items: ['msg-1'] })
    })

    expect(el.scrollTop).toBe(1000)
  })

  it('skips auto-scroll when items array is empty', () => {
    const el = makeScrollEl({ scrollHeight: 1000, clientHeight: 400, scrollTop: 0 })
    const { result } = renderHook(
      ({ items }: { items: string[] }) => useStickyScroll(items, 'chat-1'),
      { initialProps: { items: [] } },
    )
    attachRef(result.current.scrollRef, el)

    // With empty items, useLayoutEffect returns early — scrollTop stays 0
    // Verify by checking it doesn't throw and hook stays stable
    expect(result.current.showJump).toBe(false)
  })

  it('follows new content when wasAtBottom is true (wasAtBottom tracking path)', () => {
    // Correct setup: start empty → attach ref → add items (consumes force-pin) →
    // scroll to bottom (wasAtBottom=true) → add more items → expect auto-follow.
    const el = makeScrollEl({ scrollHeight: 1000, clientHeight: 400, scrollTop: 0 })
    const { result, rerender } = renderHook(
      ({ items }: { items: string[] }) => useStickyScroll(items, 'chat-1'),
      { initialProps: { items: [] } },
    )
    attachRef(result.current.scrollRef, el)

    // Consume force-pin: add first batch of items (needsPin=true → scrollTop=1000, needsPin=false)
    act(() => { rerender({ items: ['msg-1'] }) })
    expect(el.scrollTop).toBe(1000) // force-pin fired

    // Scroll to bottom (gap=0 → wasAtBottom=true) — marks wasAtBottom flag
    act(() => { result.current.handleScroll() })

    // New content arrives (scrollHeight grows) — wasAtBottom=true → should follow down
    Object.defineProperty(el, 'scrollHeight', { get: () => 1500, configurable: true })
    act(() => { rerender({ items: ['msg-1', 'msg-2'] }) })

    expect(el.scrollTop).toBe(1500)
  })

  it('stays put when wasAtBottom is false and new content arrives', () => {
    // Correct setup: consume force-pin first, then scroll up, then add items.
    const el = makeScrollEl({ scrollHeight: 1000, clientHeight: 400, scrollTop: 0 })
    const { result, rerender } = renderHook(
      ({ items }: { items: string[] }) => useStickyScroll(items, 'chat-1'),
      { initialProps: { items: [] } },
    )
    attachRef(result.current.scrollRef, el)

    // Consume force-pin with first batch of items
    act(() => { rerender({ items: ['msg-1'] }) })
    // needsPinRef is now false; scrollTop = 1000

    // Scroll user to top — gap=1000-0-400=600 > 50 → wasAtBottom=false
    el.scrollTop = 0
    // gap = 1000 - 0 - 400 = 600 > 200 → wasAtBottom=false, showJump=true
    act(() => { result.current.handleScroll() })
    expect(result.current.showJump).toBe(true)

    // New content arrives — wasAtBottom=false → useLayoutEffect should NOT move scrollTop
    const scrollTopBefore = el.scrollTop // 0
    Object.defineProperty(el, 'scrollHeight', { get: () => 2000, configurable: true })
    act(() => { rerender({ items: ['msg-1', 'msg-2', 'msg-3'] }) })

    expect(el.scrollTop).toBe(scrollTopBefore)
  })
})

// ---------------------------------------------------------------------------
// key change — reset behavior (S4)
// ---------------------------------------------------------------------------

describe('useStickyScroll — key change resets scroll state', () => {
  it('showJump is cleared when key changes', async () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useStickyScroll(['a', 'b'], key),
      { initialProps: { key: 'chat-1' } },
    )
    const el = makeScrollEl({ scrollHeight: 2000, clientHeight: 500, scrollTop: 0 })
    attachRef(result.current.scrollRef, el)

    // Scroll up to show jump
    act(() => { result.current.handleScroll() })
    expect(result.current.showJump).toBe(true)

    // Key change — effect fires, queueMicrotask schedules setShowJump(false)
    act(() => {
      rerender({ key: 'chat-2' })
    })
    // Flush microtask queue: queueMicrotask runs inside act when timers advance
    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.showJump).toBe(false)
  })

  it('null key does not crash the hook', () => {
    const { result } = renderHook(() => useStickyScroll(['a'], null))
    expect(result.current.showJump).toBe(false)
    expect(typeof result.current.handleScroll).toBe('function')
  })

  it('switching from null key to string key is handled', async () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string | null }) => useStickyScroll(['a'], key),
      { initialProps: { key: null as string | null } },
    )
    act(() => {
      rerender({ key: 'chat-1' })
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.showJump).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// sticky threshold: off-by-one at 50
// ---------------------------------------------------------------------------

describe('useStickyScroll — sticky threshold off-by-one at 50px', () => {
  it('gap = 50: wasAtBottom true (stuck); gap = 51: wasAtBottom false', () => {
    const { result } = renderHook(() => useStickyScroll(['a'], 'chat-1'))

    // gap = 50 → stuck; showJump stays false (50 ≤ 50, 50 not > 200)
    const el50 = makeScrollEl({ scrollHeight: 1000, clientHeight: 400, scrollTop: 550 })
    attachRef(result.current.scrollRef, el50)
    act(() => { result.current.handleScroll() })
    expect(result.current.showJump).toBe(false)

    // gap = 51 → not stuck; showJump still false (51 not > 200)
    const el51 = makeScrollEl({ scrollHeight: 1000, clientHeight: 400, scrollTop: 549 })
    attachRef(result.current.scrollRef, el51)
    act(() => { result.current.handleScroll() })
    expect(result.current.showJump).toBe(false)
  })

  it('gap = 200: showJump false; gap = 201: showJump true', () => {
    const { result } = renderHook(() => useStickyScroll(['a'], 'chat-1'))

    const el200 = makeScrollEl({ scrollHeight: 1000, clientHeight: 400, scrollTop: 400 })
    attachRef(result.current.scrollRef, el200)
    act(() => { result.current.handleScroll() })
    // gap = 200 → NOT > 200
    expect(result.current.showJump).toBe(false)

    const el201 = makeScrollEl({ scrollHeight: 1000, clientHeight: 400, scrollTop: 399 })
    attachRef(result.current.scrollRef, el201)
    act(() => { result.current.handleScroll() })
    // gap = 201 → > 200
    expect(result.current.showJump).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// jumpToBottom — sets needsPinRef false (S3)
// ---------------------------------------------------------------------------

describe('useStickyScroll — jumpToBottom does not re-trigger force-pin', () => {
  it('after jumpToBottom, needsPin is false so new items use wasAtBottom tracking', () => {
    const el = makeScrollEl({ scrollHeight: 1000, clientHeight: 400, scrollTop: 0 })
    const { result, rerender } = renderHook(
      ({ items }: { items: string[] }) => useStickyScroll(items, 'chat-1'),
      { initialProps: { items: ['msg-1'] } },
    )
    attachRef(result.current.scrollRef, el)

    // jumpToBottom: scrollTop = 1000, needsPin = false, wasAtBottom = true
    act(() => { result.current.jumpToBottom() })
    expect(el.scrollTop).toBe(1000)
    expect(result.current.showJump).toBe(false)

    // New content — wasAtBottom=true so layoutEffect should auto-scroll
    Object.defineProperty(el, 'scrollHeight', { get: () => 1500, configurable: true })
    act(() => {
      rerender({ items: ['msg-1', 'msg-2'] })
    })
    expect(el.scrollTop).toBe(1500)
  })
})
