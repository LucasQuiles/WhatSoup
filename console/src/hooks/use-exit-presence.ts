/**
 * use-exit-presence.ts — deferred-unmount hook for CSS keyframe exit animations.
 *
 * Implements the presence machine described in the B5 investigation packet (§4.2):
 *   Phase: 'open' | 'closing', plus unmounted (mounted=false).
 *
 *   On open true→false:
 *     1. Read getComputedStyle(shell).animationDuration.
 *     2. If empty / 0 → unmount synchronously (instant path, C-B5-1).
 *     3. Otherwise → phase → 'closing'; unmount on FIRST of:
 *        (a) animationend on the shell (C-B5-6 guarded).
 *        (b) fallback timer: computed duration + FALLBACK_BUFFER_MS.
 *
 *   On open false→true (re-open during closing):
 *     Cancels any in-flight closing dwell. The cancel ref is checked in the
 *     open=false effect's cleanup — no extra state update on open=true renders.
 *
 *   Instant path (C-B5-1):
 *     jsdom: no stylesheet → empty animationDuration → instant synchronous unmount.
 *     All existing consumer suites remain byte-stable.
 *     reduced-motion: animation:none → 0s → instant.
 *
 *   No extra render cycle for open=true:
 *     The 'mounted' state uses a separate boolean that is only set to false on close.
 *     On open=true, mounted is derived from (open=true) without needing a state update,
 *     preserving the useDismissable focus effect on the same render as Modal mounts.
 *
 *   StrictMode safe: effects have symmetric cleanup. No module-level state.
 *
 * C-B5-6: animationend guard:
 *   Browser: e.target===shell AND e.animationName===expected.
 *   jsdom: AnimationEvent unavailable → e.animationName===undefined → target-only guard.
 *
 * C-B5-9 (duration-stub seam): tests set inline animation-duration on the shell element.
 */
import { useState, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExitPhase = 'open' | 'closing';

export interface UseExitPresenceResult {
  mounted: boolean;
  phase: ExitPhase;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FALLBACK_BUFFER_MS = 50;

// ---------------------------------------------------------------------------
// Duration parser
// ---------------------------------------------------------------------------

function parseDurationMs(raw: string): number {
  if (!raw || raw === '0s' || raw === '0ms') return 0;
  const n = parseFloat(raw);
  if (isNaN(n) || n <= 0) return 0;
  return raw.endsWith('ms') ? n : n * 1000;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useExitPresence(
  open: boolean,
  shellRef: RefObject<HTMLElement | null>,
  animName: string,
): UseExitPresenceResult {
  // closingActive tracks the deferred-unmount dwell.
  // ONLY set to true on close; reset to false when the dwell ends or open resumes.
  // On open=true renders this is always false → no state update needed.
  const [closingActive, setClosingActive] = useState(false);

  const animNameRef = useRef(animName);
  useEffect(() => {
    animNameRef.current = animName;
  });

  // A ref storing the cancel function for any in-flight closing dwell.
  // Checked on open=false→true without needing an effect for the open=true path.
  const cancelClosingRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (open) {
      // Re-open (or initial mount): cancel any in-flight closing dwell.
      // This does NOT require a separate setClosingActive(false) call here —
      // the cancel function already calls setClosingActive(false).
      if (cancelClosingRef.current) {
        cancelClosingRef.current();
        cancelClosingRef.current = null;
      }
      return;
    }

    // open became false.
    const shell = shellRef.current;

    // No shell → already not mounted (closingActive=false → not mounted since open=false).
    if (!shell) return;

    // Read current animation duration.
    // jsdom: '' → 0 → instant path (C-B5-1).
    const initialDuration = parseDurationMs(getComputedStyle(shell).animationDuration);

    if (initialDuration === 0) {
      // Instant path: no closing dwell.
      return;
    }

    // Closing dwell: enter the closing phase.
    setClosingActive(true);

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    function unmount() {
      if (cancelled) return;
      cancelled = true;
      cancelClosingRef.current = null;
      if (timerId !== null) clearTimeout(timerId);
      shell!.removeEventListener('animationend', handleAnimationEnd);
      setClosingActive(false);
    }

    cancelClosingRef.current = () => {
      cancelled = true;
      cancelClosingRef.current = null;
      if (timerId !== null) clearTimeout(timerId);
      shell!.removeEventListener('animationend', handleAnimationEnd);
      setClosingActive(false);
    };

    function handleAnimationEnd(e: AnimationEvent) {
      if (e.target !== shell) return;
      if (e.animationName !== undefined && e.animationName !== animNameRef.current) return;
      unmount();
    }

    shell.addEventListener('animationend', handleAnimationEnd);

    const rafId = requestAnimationFrame(() => {
      if (cancelled) return;
      const closingDuration = parseDurationMs(getComputedStyle(shell).animationDuration);
      if (!closingDuration || closingDuration <= 0) {
        unmount();
        return;
      }
      timerId = setTimeout(unmount, closingDuration + FALLBACK_BUFFER_MS);
    });

    return () => {
      cancelled = true;
      cancelClosingRef.current = null;
      cancelAnimationFrame(rafId);
      if (timerId !== null) clearTimeout(timerId);
      shell.removeEventListener('animationend', handleAnimationEnd);
      // Note: we do NOT call setClosingActive(false) in cleanup here.
      // The cleanup runs on unmount (component tree removal), at which point
      // the component is gone anyway. StrictMode cleanup/re-setup: the second
      // setup resets cancellation state.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional open-only dependency: the exit machinery must re-arm exactly on open transitions, not when ref-stable callbacks re-render; expires 2026-12-31
  }, [open]);

  // Derive mounted from open (primary) and closingActive (dwell).
  // open=true → always mounted regardless of closingActive.
  // open=false + closingActive=true → mounted (dwell).
  // open=false + closingActive=false → not mounted.
  const mounted = open || closingActive;
  const phase: ExitPhase = closingActive ? 'closing' : 'open';

  return { mounted, phase };
}
