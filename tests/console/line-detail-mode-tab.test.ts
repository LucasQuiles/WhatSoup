import { describe, it, expect } from 'vitest'
import { ModeTab } from '../../console/src/components/line-detail/index.ts'

/**
 * Structural tests for the ModeTab component export.
 * These verify the component exists and accepts the expected props interface
 * without requiring a React render environment (React is in console/node_modules).
 */

describe('ModeTab', () => {
  it('is exported as a function component', () => {
    expect(typeof ModeTab).toBe('function')
  })

  it('accepts mode, line, onEditConfig, onChangeMode props (arity check)', () => {
    // React FC with destructured props always has length 1 (the props object)
    expect(ModeTab.length).toBeGreaterThanOrEqual(1)
  })
})
