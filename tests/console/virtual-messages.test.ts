import { describe, expect, it } from 'vitest'

/**
 * Structural tests for the virtual messages hook module.
 * These verify exports and pure function behavior without importing
 * @tanstack/react-virtual (which is in console/node_modules only).
 */

describe('useVirtualMessages module', () => {
  it('exports the expected functions and constants', async () => {
    const mod = await import('../../console/src/hooks/use-virtual-messages.ts')
    expect(typeof mod.useVirtualMessages).toBe('function')
    expect(typeof mod.estimateMessageRowHeight).toBe('function')
    expect(typeof mod.createVirtualMessagesOptions).toBe('function')
    expect(mod.DEFAULT_MESSAGE_OVERSCAN).toBe(8)
  })
})
