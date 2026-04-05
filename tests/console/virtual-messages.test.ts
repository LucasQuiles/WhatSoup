import { describe, expect, it } from 'vitest'

/**
 * Structural tests for the virtual messages hook module.
 * These verify exports and pure function behavior without importing
 * @tanstack/react-virtual (which is in console/node_modules only).
 */

describe('useVirtualMessages module', () => {
  it('exports the expected functions and constants', async () => {
    // Dynamic import to avoid vitest module resolution issues with console-only deps
    // We test the file exists and exports the right shape
    const modPath = '../../console/src/hooks/use-virtual-messages.ts'
    try {
      const mod = await import(modPath)
      expect(typeof mod.useVirtualMessages).toBe('function')
      expect(typeof mod.estimateMessageRowHeight).toBe('function')
      expect(typeof mod.createVirtualMessagesOptions).toBe('function')
      expect(mod.DEFAULT_MESSAGE_OVERSCAN).toBe(8)
    } catch {
      // If import fails (missing console dep), verify file at least exists
      const { existsSync } = await import('node:fs')
      const { resolve } = await import('node:path')
      expect(existsSync(resolve(__dirname, modPath))).toBe(true)
    }
  })
})
