/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

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
  document.body.replaceChildren()
})

function makeScrollContainer(opts: {
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

async function loadHook() {
  return import('../../console/src/hooks/use-virtual-messages.ts')
}

describe('useVirtualMessages virtualizer integration', () => {
  it('returns zero virtual items and zero total size for an empty message list', async () => {
    const { useVirtualMessages } = await loadHook()
    const container = makeScrollContainer()

    const { result } = renderHook(() =>
      useVirtualMessages({ messages: [], getScrollElement: () => container }),
    )

    expect(result.current.getVirtualItems()).toHaveLength(0)
    expect(result.current.getTotalSize()).toBe(0)
  })

  it('exposes a single virtual item for a one-message list', async () => {
    const { useVirtualMessages } = await loadHook()
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

  it('returns all 20 virtual items when viewport is larger than total content height', async () => {
    const { useVirtualMessages } = await loadHook()
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

  it('keeps virtual rows ordered, spaced, and inside the reported total size', async () => {
    const { useVirtualMessages } = await loadHook()
    const container = makeScrollContainer({ offsetHeight: 10_000 })

    const messages = [
      msg(1, { content: 'short' }),
      msg(2, { content: 'x'.repeat(90) }),
      msg(3, { type: 'image', fromMe: false }),
    ]
    const { result } = renderHook(() =>
      useVirtualMessages({ messages, getScrollElement: () => container }),
    )

    const items = result.current.getVirtualItems()

    expect(items).toHaveLength(3)
    expect(items[0]?.start).toBe(0)
    expect(items[1]?.start).toBeGreaterThan(items[0]!.end)
    expect(items[2]?.start).toBeGreaterThan(items[1]!.end)
    expect(result.current.getTotalSize()).toBeGreaterThanOrEqual(items[2]!.end)
  })

  it('buffers more rows by default than when overscan is disabled', async () => {
    const { useVirtualMessages } = await loadHook()
    const messages = Array.from({ length: 50 }, (_, i) => msg(i + 1))
    const defaultContainer = makeScrollContainer({ offsetHeight: 160 })
    const noOverscanContainer = makeScrollContainer({ offsetHeight: 160 })

    const defaultHook = renderHook(() =>
      useVirtualMessages({ messages, getScrollElement: () => defaultContainer }),
    )
    const noOverscanHook = renderHook(() =>
      useVirtualMessages({
        messages,
        getScrollElement: () => noOverscanContainer,
        overscan: 0,
      }),
    )

    expect(defaultHook.result.current.getVirtualItems().length).toBeGreaterThan(
      noOverscanHook.result.current.getVirtualItems().length,
    )
  })

  it('updates row size from measured DOM height and ignores zero-height measurement', async () => {
    const { useVirtualMessages } = await loadHook()
    const container = makeScrollContainer({ offsetHeight: 300 })

    const { result } = renderHook(() =>
      useVirtualMessages({
        messages: [msg(1), msg(2)],
        getScrollElement: () => container,
      }),
    )

    const measuredRow = document.createElement('div')
    measuredRow.setAttribute('data-index', '0')
    vi.spyOn(measuredRow, 'getBoundingClientRect').mockReturnValue({
      height: 93.4,
      top: 0,
      left: 0,
      right: 0,
      bottom: 93.4,
      width: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect)

    const zeroRow = document.createElement('div')
    zeroRow.setAttribute('data-index', '1')
    vi.spyOn(zeroRow, 'getBoundingClientRect').mockReturnValue({
      height: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect)

    await act(async () => {
      result.current.measureElement(measuredRow)
      result.current.measureElement(zeroRow)
    })

    const items = result.current.getVirtualItems()
    expect(items.find((item) => item.index === 0)?.size).toBe(94)
    expect(items.find((item) => item.index === 1)?.size).toBeGreaterThan(0)
  })

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

    messages = [msg(7), msg(8)]
    await act(async () => {
      rerender({ msgs: messages })
    })

    const keys2 = result.current.getVirtualItems().map((v) => v.key)

    expect(keys2).toEqual(keys1)
    expect(keys1).toEqual([7, 8])
  })
})
