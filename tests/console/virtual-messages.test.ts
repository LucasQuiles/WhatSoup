import { describe, expect, it, vi } from 'vitest'

/**
 * Structural tests for the virtual messages hook module.
 * The virtualizer dependency is explicit here because console dependencies
 * are installed separately from the root test runner in some environments.
 */

const virtualizer = vi.hoisted(() => ({
  useVirtualizer: vi.fn((options: unknown) => ({ options })),
}))

vi.mock('@tanstack/react-virtual', () => virtualizer)

describe('useVirtualMessages module', () => {
  it('exports the expected functions and constants', async () => {
    const mod = await import('../../console/src/hooks/use-virtual-messages.ts')
    expect(typeof mod.useVirtualMessages).toBe('function')
    expect(typeof mod.estimateMessageRowHeight).toBe('function')
    expect(typeof mod.createVirtualMessagesOptions).toBe('function')
    expect(mod.DEFAULT_MESSAGE_OVERSCAN).toBe(8)
  })

  it('builds stable virtualizer options from message content', async () => {
    const mod = await import('../../console/src/hooks/use-virtual-messages.ts')
    const messages = [
      { pk: 'm-1', content: 'short text', type: 'text', fromMe: true },
      { pk: 'm-2', content: 'x'.repeat(90), type: 'image', fromMe: false },
    ]
    const getScrollElement = () => null

    const options = mod.createVirtualMessagesOptions({
      messages,
      getScrollElement,
      overscan: 3,
    })

    expect(options.count).toBe(2)
    expect(options.getScrollElement).toBe(getScrollElement)
    expect(options.overscan).toBe(3)
    expect(options.gap).toBe(12)
    expect(options.getItemKey?.(0)).toBe('m-1')
    expect(options.getItemKey?.(99)).toBe(99)
    expect(options.estimateSize?.(0)).toBe(76)
    expect(options.estimateSize?.(1)).toBe(154)
  })

  it('estimates safely for stale or malformed history message rows', async () => {
    const mod = await import('../../console/src/hooks/use-virtual-messages.ts')

    expect(mod.estimateMessageRowHeight(null)).toBe(76)
    expect(mod.estimateMessageRowHeight(undefined)).toBe(76)
    expect(mod.estimateMessageRowHeight({ pk: 'm-1', content: null, type: 'text', fromMe: true })).toBe(76)
    expect(mod.estimateMessageRowHeight({ pk: 'm-2', content: { text: 'bad payload' }, type: 'text', fromMe: true })).toBe(76)
  })

  it('passes created options to the virtualizer hook', async () => {
    const mod = await import('../../console/src/hooks/use-virtual-messages.ts')
    const messages = [{ pk: 'm-1', content: '', type: 'text', fromMe: true }]

    const result = mod.useVirtualMessages({
      messages,
      getScrollElement: () => null,
    })

    expect(virtualizer.useVirtualizer).toHaveBeenCalledTimes(1)
    expect(virtualizer.useVirtualizer).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 1,
        overscan: 8,
      }),
    )
    expect(result).toEqual({
      options: expect.objectContaining({
        count: 1,
        overscan: 8,
      }),
    })
  })
})
