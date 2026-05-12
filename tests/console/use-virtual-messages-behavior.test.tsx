/**
 * use-virtual-messages — end-to-end virtualizer integration tests.
 *
 * Tests the real @tanstack/react-virtual integration (not mocked) by:
 *   - Stubbing ResizeObserver (jsdom lacks it)
 *   - Wiring a real HTMLDivElement as the scroll container
 *   - Asserting getVirtualItems(), getTotalSize(), measureElement, and
 *     key stability under re-render
 *
 * Source surprise: @tanstack/virtual-core's observeElementRect calls
 * getRect(el) = { width: el.offsetWidth, height: el.offsetHeight } — NOT
 * getBoundingClientRect() and NOT scrollHeight/clientHeight. jsdom returns 0
 * for these by default, so tests must patch offsetHeight/offsetWidth via
 * Object.defineProperty to give the virtualizer a usable viewport rect.
 *
 * Scope vs existing coverage:
 *   - virtual-messages.test.ts: structural/export checks + createVirtualMessagesOptions
 *     shape; mocks @tanstack/react-virtual entirely — does NOT exercise the
 *     real virtualizer path
 *   - inbox-virtualization.test.ts: selectVirtualMessageRows / toChronologicalMessages
 *     pure-function helpers only
 *   - THIS FILE: exercises the real useVirtualizer path end-to-end via renderHook
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

// ── ResizeObserver stub ───────────────────────────────────────────────────────
// jsdom does not implement ResizeObserver; @tanstack/virtual-core's
// observeElementRect checks for it. Stub it so it doesn't throw, but note that
// the virtualizer already calls getRect(el) synchronously BEFORE setting up
// the ResizeObserver listener — so the stub just needs to be non-throwing.
class ResizeObserverStub {
  constructor(_callback: ResizeObserverCallback) {}
  observe(_target: Element, _options?: ResizeObserverOptions) {}
  unobserve(_target: Element) {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  // Remove any scroll-container divs appended by makeScrollContainer.
  // RTL cleanup() unmounts React trees but does not remove manually-appended nodes.
  document.body.replaceChildren()
})

// ── scroll container helpers ──────────────────────────────────────────────────

/**
 * Create a fake scroll container with jsdom-compatible geometry.
 *
 * The virtualizer's observeElementRect uses getRect(el) = el.offsetWidth /
 * el.offsetHeight (NOT scrollHeight/clientHeight). We patch these via
 * Object.defineProperty (PR #569 use-sticky-scroll pattern).
 */
function makeScrollContainer(opts: {
  /** Viewport height used by virtual-core for range calculation. Default 600. */
  offsetHeight?: number
  offsetWidth?: number
  scrollTop?: number
} = {}): HTMLDivElement {
  const el = document.createElement('div')
  const { offsetHeight = 600, offsetWidth = 800, scrollTop = 0 } = opts

  Object.defineProperty(el, 'offsetHeight', {
    configurable: true,
    get: () => offsetHeight,
  })
  Object.defineProperty(el, 'offsetWidth', {
    configurable: true,
    get: () => offsetWidth,
  })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    writable: true,
    value: scrollTop,
  })

  document.body.appendChild(el)
  return el
}

// ── message factory ───────────────────────────────────────────────────────────

type VirtualMessage = { pk: number; content: string | null; type: string; fromMe: boolean }

function msg(
  pk: number,
  opts: { content?: string; type?: string; fromMe?: boolean } = {},
): VirtualMessage {
  return {
    pk,
    content: opts.content ?? 'hello',
    type: opts.type ?? 'text',
    fromMe: opts.fromMe ?? true,
  }
}

// ── import hook ───────────────────────────────────────────────────────────────

async function loadHook() {
  return import('../../console/src/hooks/use-virtual-messages.ts')
}

// ─────────────────────────────────────────────────────────────────────────────

describe('useVirtualMessages — virtualizer integration', () => {
  // ── 1. empty list ──────────────────────────────────────────────────────────
  it('returns zero virtual items and zero total size for an empty message list', async () => {
    const { useVirtualMessages } = await loadHook()
    const container = makeScrollContainer()

    const { result } = renderHook(() =>
      useVirtualMessages({ messages: [], getScrollElement: () => container }),
    )

    expect(result.current.getVirtualItems()).toHaveLength(0)
    expect(result.current.getTotalSize()).toBe(0)
  })

  // ── 2. single item → at least one virtual item in window ──────────────────
  it('exposes a single virtual item for a one-message list', async () => {
    const { useVirtualMessages } = await loadHook()
    // offsetHeight tells virtual-core the viewport is 300px — enough to show the item
    const container = makeScrollContainer({ offsetHeight: 300 })

    const { result } = renderHook(() =>
      useVirtualMessages({
        messages: [msg(1)],
        getScrollElement: () => container,
      }),
    )

    const items = result.current.getVirtualItems()
    expect(items.length).toBeGreaterThanOrEqual(1)
    expect(items[0]).toMatchObject({ index: 0 })
  })

  // ── 3. all items visible when viewport exceeds estimated total size ─────────
  it('returns all 20 virtual items when viewport is larger than total content height', async () => {
    const { useVirtualMessages } = await loadHook()
    // 10 000px viewport — well above 20 × ~76px estimated row height
    const container = makeScrollContainer({ offsetHeight: 10_000 })

    const messages = Array.from({ length: 20 }, (_, i) => msg(i + 1))

    const { result } = renderHook(() =>
      useVirtualMessages({
        messages,
        getScrollElement: () => container,
        overscan: 0,
      }),
    )

    const items = result.current.getVirtualItems()
    expect(items.length).toBe(20)
    expect(items.map((v) => v.index)).toEqual(Array.from({ length: 20 }, (_, i) => i))
  })

  // ── 4. getTotalSize reflects estimated row heights + gaps ──────────────────
  it('computes a positive total size based on estimateMessageRowHeight + gap', async () => {
    const { useVirtualMessages, estimateMessageRowHeight, DEFAULT_MESSAGE_OVERSCAN } =
      await loadHook()
    const container = makeScrollContainer({ offsetHeight: 200 })
    const MESSAGE_GAP = 12 // mirrors the private constant in use-virtual-messages.ts

    const messages = [msg(1), msg(2), msg(3)]
    const { result } = renderHook(() =>
      useVirtualMessages({ messages, getScrollElement: () => container }),
    )

    // total = sum of estimated heights + gap × (count - 1)
    const expectedSize =
      messages.reduce((sum, m) => sum + estimateMessageRowHeight(m), 0) +
      MESSAGE_GAP * (messages.length - 1)

    // Allow ±2px rounding tolerance
    expect(result.current.getTotalSize()).toBeGreaterThanOrEqual(expectedSize - 2)
    expect(result.current.getTotalSize()).toBeLessThanOrEqual(expectedSize + 2)

    // DEFAULT_MESSAGE_OVERSCAN is 8 — confirmed via the exported constant
    expect(DEFAULT_MESSAGE_OVERSCAN).toBe(8)
  })

  // ── 5. overscan default ────────────────────────────────────────────────────
  it('applies DEFAULT_MESSAGE_OVERSCAN = 8 when overscan is omitted', async () => {
    const { useVirtualMessages, createVirtualMessagesOptions, DEFAULT_MESSAGE_OVERSCAN } =
      await loadHook()
    const container = makeScrollContainer()
    const messages = [msg(1)]

    const opts = createVirtualMessagesOptions({ messages, getScrollElement: () => container })

    expect(opts.overscan).toBe(DEFAULT_MESSAGE_OVERSCAN)

    const { result } = renderHook(() =>
      useVirtualMessages({ messages, getScrollElement: () => container }),
    )
    // Virtualizer exposes getVirtualItems and reports the one message
    const items = result.current.getVirtualItems()
    expect(items.length).toBeGreaterThanOrEqual(1)
    expect(items[0]).toMatchObject({ index: 0 })
  })

  // ── 6. custom overscan threads through ────────────────────────────────────
  it('respects a custom overscan value passed through createVirtualMessagesOptions', async () => {
    const { createVirtualMessagesOptions } = await loadHook()
    const container = makeScrollContainer()
    const messages = [msg(1), msg(2)]

    const opts = createVirtualMessagesOptions({
      messages,
      getScrollElement: () => container,
      overscan: 3,
    })

    expect(opts.overscan).toBe(3)
  })

  // ── 7. item key stability — pk used when present, index as fallback ────────
  it('uses message pk as item key and falls back to index for out-of-bounds access', async () => {
    const { createVirtualMessagesOptions } = await loadHook()
    const container = makeScrollContainer()
    const messages = [msg(10), msg(20), msg(30)]

    const opts = createVirtualMessagesOptions({ messages, getScrollElement: () => container })

    expect(opts.getItemKey?.(0)).toBe(10)
    expect(opts.getItemKey?.(1)).toBe(20)
    expect(opts.getItemKey?.(2)).toBe(30)
    // Out-of-bounds → messages[99] is undefined → fallback to index itself
    expect(opts.getItemKey?.(99)).toBe(99)
  })

  // ── 8. measureElement function exposed by real virtualizer ────────────────
  it('returns a callable measureElement from the real Virtualizer instance', async () => {
    const { useVirtualMessages } = await loadHook()
    const container = makeScrollContainer()

    const { result } = renderHook(() =>
      useVirtualMessages({
        messages: [msg(1)],
        getScrollElement: () => container,
      }),
    )

    expect(typeof result.current.measureElement).toBe('function')
  })

  // ── 9. custom measureElement option: ceil + fallback ──────────────────────
  it('rounds up bounding-box height and falls back to BASE_HEIGHT when box is zero', async () => {
    const { createVirtualMessagesOptions } = await loadHook()
    const MESSAGE_BASE_ROW_HEIGHT = 76 // mirrors private constant in source

    const opts = createVirtualMessagesOptions({
      messages: [msg(1)],
      getScrollElement: () => null,
    })

    const fakeEl = document.createElement('div')

    // Non-integer height → should be rounded up with Math.ceil
    vi.spyOn(fakeEl, 'getBoundingClientRect').mockReturnValue({
      height: 93.4,
      top: 0, left: 0, right: 0, bottom: 93.4,
      width: 300, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect)

    const measured = opts.measureElement!(fakeEl as HTMLDivElement)
    expect(measured).toBe(94) // Math.ceil(93.4)

    // Height = 0 (element not laid out, e.g. display:none) → fallback to base height
    vi.spyOn(fakeEl, 'getBoundingClientRect').mockReturnValue({
      height: 0,
      top: 0, left: 0, right: 0, bottom: 0,
      width: 0, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect)

    const fallback = opts.measureElement!(fakeEl as HTMLDivElement)
    expect(fallback).toBe(MESSAGE_BASE_ROW_HEIGHT)
  })

  // ── 10. key stability across re-render ────────────────────────────────────
  it('preserves item key identity when the messages array reference is replaced', async () => {
    const { useVirtualMessages } = await loadHook()
    const container = makeScrollContainer({ offsetHeight: 300 })

    let messages = [msg(7), msg(8)]

    const { result, rerender } = renderHook(
      ({ msgs }: { msgs: VirtualMessage[] }) =>
        useVirtualMessages({ messages: msgs, getScrollElement: () => container }),
      { initialProps: { msgs: messages } },
    )

    const keys1 = result.current.getVirtualItems().map((v) => v.key)

    // New reference, same pks
    messages = [msg(7), msg(8)]
    await act(async () => {
      rerender({ msgs: messages })
    })

    const keys2 = result.current.getVirtualItems().map((v) => v.key)

    // Keys are derived from pk — must be stable across reference changes
    expect(keys2).toEqual(keys1)
    // And they correspond to the pks, not array indices
    expect(keys1).toEqual([7, 8])
  })

  // ── 11. gap wired through to virtualizer options ──────────────────────────
  it('sets gap = 12 in the options object passed to useVirtualizer', async () => {
    const { createVirtualMessagesOptions } = await loadHook()
    const opts = createVirtualMessagesOptions({
      messages: [msg(1)],
      getScrollElement: () => null,
    })
    expect(opts.gap).toBe(12)
  })
})
