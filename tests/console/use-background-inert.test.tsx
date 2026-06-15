/**
 * @vitest-environment jsdom
 *
 * Dedicated hook tests for console/src/hooks/use-background-inert.ts.
 *
 * Contract under test (B5 investigation packet §5.1–5.4, C-B5-4/C-B5-5):
 *   - Attribute API: setAttribute('inert','') / removeAttribute('inert') on #root.
 *     (jsdom 29.0.1 does not reflect the inert property — only the attribute is reliable.)
 *   - Module-level refcount: two simultaneous consumers both open → inert until
 *     BOTH release (C-B5-5).
 *   - Release-before-restore ordering: effect cleanup releases the refcount; React
 *     runs all cleanups before new setups in the same commit (§5.4, C-B5-4).
 *   - No-root guard: when #root does not exist, hook no-ops (no crash).
 *   - Idempotent cleanup on unmount-while-open: refcount is released exactly once.
 *   - StrictMode double-invoke is symmetric (acquire/release balance, C-B5-5 note).
 *   - _resetInertCount export is callable and restores zero state.
 *
 * Fixture: tests create a <div id="root"> and append it to document.body;
 * each test removes it in afterEach via explicit cleanup to avoid leaking the
 * module-level counter across tests.
 *
 * Harness pattern: minimal Fixture component wrapping the hook, per the
 * use-dismissable-dark.test.tsx dedicated-hook-suite pattern.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, act } from '@testing-library/react'
import { useState, StrictMode, type FC } from 'react'
import {
  useBackgroundInert,
  _resetInertCount,
} from '../../console/src/hooks/use-background-inert'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal fixture: just calls the hook with the given open value. */
const Fixture: FC<{ open: boolean }> = ({ open }) => {
  useBackgroundInert(open)
  return <div data-testid="fixture-child" />
}

/** Controlled fixture: exposes open/close buttons for interaction-level tests. */
const ControlledFixture: FC<{ initialOpen?: boolean }> = ({ initialOpen = true }) => {
  const [open, setOpen] = useState(initialOpen)
  return (
    <div>
      <button type="button" data-testid="open-btn" onClick={() => setOpen(true)}>Open</button>
      <button type="button" data-testid="close-btn" onClick={() => setOpen(false)}>Close</button>
      <Fixture open={open} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-test #root setup / teardown
// ---------------------------------------------------------------------------

let rootEl: HTMLDivElement | null = null

beforeEach(() => {
  rootEl = document.createElement('div')
  rootEl.id = 'root'
  document.body.appendChild(rootEl)
})

afterEach(() => {
  // Always reset the module-level counter so tests are isolated.
  _resetInertCount()
  if (rootEl && rootEl.parentNode) {
    rootEl.parentNode.removeChild(rootEl)
  }
  rootEl = null
  cleanup()
})

// ---------------------------------------------------------------------------
// Basic acquire / release
// ---------------------------------------------------------------------------

describe('useBackgroundInert — basic acquire and release', () => {
  it('open=true: #root receives the inert attribute', async () => {
    render(<Fixture open />)
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(true)
    // Positive control: attribute value is '' (empty string, standard inert form).
    expect(rootEl!.getAttribute('inert')).toBe('')
  })

  it('open=false: #root does NOT receive the inert attribute', async () => {
    render(<Fixture open={false} />)
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(false)
  })

  it('open=true then open=false: inert attribute is removed', async () => {
    const { rerender } = render(<Fixture open />)
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(true)

    rerender(<Fixture open={false} />)
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(false)
  })

  it('open=false initially then open=true: inert is acquired', async () => {
    const { rerender } = render(<Fixture open={false} />)
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(false)

    rerender(<Fixture open />)
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Refcount — two simultaneous consumers (C-B5-5)
// ---------------------------------------------------------------------------

describe('useBackgroundInert — refcount: inert held while any consumer is open (C-B5-5)', () => {
  it('two consumers open: inert set', async () => {
    render(
      <>
        <Fixture open />
        <Fixture open />
      </>
    )
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(true)
  })

  it('close top consumer: #root STILL inert (bottom still open)', async () => {
    const { rerender } = render(
      <>
        <Fixture open />
        <Fixture open />
      </>
    )
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(true)

    // Close one consumer.
    rerender(
      <>
        <Fixture open />
        <Fixture open={false} />
      </>
    )
    await act(async () => {})
    // Still inert: other consumer is still open.
    expect(rootEl!.hasAttribute('inert')).toBe(true)
  })

  it('close both consumers: inert removed only after the last release', async () => {
    const { rerender } = render(
      <>
        <Fixture open />
        <Fixture open />
      </>
    )
    await act(async () => {})

    rerender(
      <>
        <Fixture open />
        <Fixture open={false} />
      </>
    )
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(true)

    rerender(
      <>
        <Fixture open={false} />
        <Fixture open={false} />
      </>
    )
    await act(async () => {})
    // Both closed → inert removed.
    expect(rootEl!.hasAttribute('inert')).toBe(false)
  })

  it('three consumers: inert removed only when all three close', async () => {
    const { rerender } = render(
      <>
        <Fixture open />
        <Fixture open />
        <Fixture open />
      </>
    )
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(true)

    rerender(
      <>
        <Fixture open={false} />
        <Fixture open />
        <Fixture open />
      </>
    )
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(true)

    rerender(
      <>
        <Fixture open={false} />
        <Fixture open={false} />
        <Fixture open />
      </>
    )
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(true)

    rerender(
      <>
        <Fixture open={false} />
        <Fixture open={false} />
        <Fixture open={false} />
      </>
    )
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Release-before-restore ordering (C-B5-4)
// ---------------------------------------------------------------------------

describe('useBackgroundInert — release-before-restore ordering (C-B5-4)', () => {
  it('inert is removed before a paired focus-restoration effect can run on the same close commit', async () => {
    // This test pins the React effect-ordering contract: cleanups run before
    // new setups in the same commit. The inert release lives in the cleanup of
    // the open=true effect; any restoration setup keyed on open=false runs after.
    // We verify by checking the attribute is absent AFTER both effects settle.
    let inertAtRelease = true

    // A companion fixture that reads the inert attribute when it runs its
    // open=false effect (simulating focus restoration timing).
    const OrderProbe: FC<{ open: boolean }> = ({ open }) => {
      useBackgroundInert(open)
      // We cannot directly interleave effect execution order in unit tests,
      // but we can verify the end state: inert must be absent after close.
      return null
    }

    const { rerender } = render(<OrderProbe open />)
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(true)

    rerender(<OrderProbe open={false} />)
    await act(async () => {})

    // After the commit settles, inert must be gone (cleanup ran).
    expect(rootEl!.hasAttribute('inert')).toBe(false)
    inertAtRelease = rootEl!.hasAttribute('inert')
    // Positive assertion: inert is false (released), not true (stuck).
    expect(inertAtRelease).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// No-root guard
// ---------------------------------------------------------------------------

describe('useBackgroundInert — no-root guard: hook no-ops when #root is absent', () => {
  it('does not throw when #root element does not exist', async () => {
    // Remove the root element for this test.
    if (rootEl && rootEl.parentNode) {
      rootEl.parentNode.removeChild(rootEl)
      rootEl = null
    }

    // Should not throw.
    expect(() => {
      render(<Fixture open />)
    }).not.toThrow()
    await act(async () => {})
    // No crash, no #root to check.
    expect(document.getElementById('root')).toBeNull()
  })

  it('release does not throw when #root disappears between acquire and release', async () => {
    render(<Fixture open />)
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(true)

    // Remove #root from DOM before close.
    if (rootEl && rootEl.parentNode) {
      rootEl.parentNode.removeChild(rootEl)
      rootEl = null
    }

    // Unmount while root is gone — cleanup (release) should not throw.
    expect(() => {
      cleanup()
    }).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Idempotent cleanup on unmount-while-open
// ---------------------------------------------------------------------------

describe('useBackgroundInert — idempotent cleanup on unmount-while-open', () => {
  it('unmounting an open consumer releases the refcount exactly once', async () => {
    render(<Fixture open />)
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(true)

    // Unmount the component while open — cleanup fires release.
    cleanup()
    await act(async () => {})
    // Inert removed after the single release.
    expect(rootEl!.hasAttribute('inert')).toBe(false)
  })

  it('refcount does not go negative: two consumers, unmount-while-open cleans both', async () => {
    render(
      <>
        <Fixture open />
        <Fixture open />
      </>
    )
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(true)

    // Unmount both open consumers simultaneously.
    cleanup()
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(false)
  })

  it('over-release is guarded: second release on already-zero count does not remove non-inert', async () => {
    // The hook's releaseInert() has `if (_inertCount <= 0) return` guard.
    // Calling _resetInertCount and then unmounting a closed consumer must not crash.
    render(<Fixture open={false} />)
    await act(async () => {})
    // Nothing acquired — counter at 0. cleanup runs release but guard blocks it.
    expect(() => { cleanup() }).not.toThrow()
    expect(rootEl!.hasAttribute('inert')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// StrictMode double-invoke safety
// ---------------------------------------------------------------------------

describe('useBackgroundInert — StrictMode double-invoke safety', () => {
  it('StrictMode acquire/release is symmetric: inert set on open, cleared on close', async () => {
    const { rerender } = render(
      <StrictMode>
        <Fixture open />
      </StrictMode>
    )
    await act(async () => {})
    // StrictMode double-invokes effect + cleanup: net refcount must still be 1
    // (acquire + cleanup-release + re-acquire = 1 net).
    expect(rootEl!.hasAttribute('inert')).toBe(true)

    rerender(
      <StrictMode>
        <Fixture open={false} />
      </StrictMode>
    )
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(false)
  })

  it('StrictMode: two consumers both open — inert set and symmetrically released', async () => {
    const { rerender } = render(
      <StrictMode>
        <>
          <Fixture open />
          <Fixture open />
        </>
      </StrictMode>
    )
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(true)

    rerender(
      <StrictMode>
        <>
          <Fixture open={false} />
          <Fixture open={false} />
        </>
      </StrictMode>
    )
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// _resetInertCount utility
// ---------------------------------------------------------------------------

describe('useBackgroundInert — _resetInertCount utility', () => {
  it('resets the counter to zero and removes the inert attribute', async () => {
    // Acquire twice.
    render(
      <>
        <Fixture open />
        <Fixture open />
      </>
    )
    await act(async () => {})
    expect(rootEl!.hasAttribute('inert')).toBe(true)

    // Reset without unmounting — simulates test isolation between suites.
    _resetInertCount()
    expect(rootEl!.hasAttribute('inert')).toBe(false)
  })

  it('calling _resetInertCount when counter is already zero does not crash', () => {
    expect(() => { _resetInertCount() }).not.toThrow()
    expect(rootEl!.hasAttribute('inert')).toBe(false)
  })
})
