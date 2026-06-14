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
 *     The open=false effect cleanup cancels any in-flight timer/listener.
 *     open=true renders force phase='open' immediately, then the open effect
 *     clears the stale closing dwell bit before the next close cycle.
 *
 *   Instant path (C-B5-1):
 *     jsdom: no stylesheet → empty animationDuration → instant synchronous unmount.
 *     All existing consumer suites remain byte-stable.
 *     reduced-motion: animation:none → 0s → instant.
 *
 *   No stale closing phase on re-open:
 *     mounted and phase both key off open=true first. The reopened shell cannot
 *     render data-state="closing" while the cleanup-state reset is committing.
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
  // open=true renders derive phase from open first, then the open effect clears
  // any stale dwell bit after the open=false cleanup has cancelled callbacks.
  const [closingActive, setClosingActive] = useState(false);

  const animNameRef = useRef(animName);
  useEffect(() => {
    animNameRef.current = animName;
  });

  useEffect(() => {
    if (open) {
      // Re-open (or initial mount): the previous open=false effect cleanup has
      // already cancelled any in-flight timer/listener before this effect runs.
      // Clear the stale dwell bit so a later zero-duration close can unmount.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- waiver:WVR-015 reopen must clear stale close dwell after callbacks are cancelled; expires 2026-12-31
      setClosingActive(false);
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
      if (timerId !== null) clearTimeout(timerId);
      shell!.removeEventListener('animationend', handleAnimationEnd);
      setClosingActive(false);
    }

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
      cancelAnimationFrame(rafId);
      if (timerId !== null) clearTimeout(timerId);
      shell.removeEventListener('animationend', handleAnimationEnd);
      // Note: we do NOT call setClosingActive(false) in cleanup here.
      // On re-open, the open=true effect clears it after this cleanup has
      // cancelled callbacks. On unmount, the component is gone anyway.
      // StrictMode cleanup/re-setup: the second setup resets cancellation state.
    };
  }, [open, shellRef]);

  // Derive mounted from open (primary) and closingActive (dwell).
  // open=true → always mounted regardless of closingActive.
  // open=false + closingActive=true → mounted (dwell).
  // open=false + closingActive=false → not mounted.
  const mounted = open || closingActive;
  const phase: ExitPhase = open ? 'open' : closingActive ? 'closing' : 'open';

  return { mounted, phase };
}
