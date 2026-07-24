/**
 * use-exit-presence.ts — deferred-unmount hook for CSS keyframe exit animations.
 *
 * Implements the presence machine described in the B5 investigation packet (§4.2):
 *   Phase: 'open' | 'closing', plus unmounted (mounted=false).
 *
 *   On open true→false:
 *     1. Retain the previously-present shell and render phase="closing".
 *     2. Read getComputedStyle(shell).animationDuration.
 *     3. If empty / 0 → unmount immediately (instant path, C-B5-1).
 *     4. Otherwise unmount on FIRST of:
 *        (a) animationend on the shell (C-B5-6 guarded).
 *        (b) fallback timer: computed duration + FALLBACK_BUFFER_MS.
 *
 *   On open false→true (re-open during closing):
 *     The open=false effect cleanup cancels any in-flight timer/listener.
 *     open=true forces phase='open' immediately, then records the shell as
 *     present for the next close cycle.
 *
 *   Instant path (C-B5-1):
 *     jsdom: no stylesheet → empty animationDuration → instant synchronous unmount.
 *     All existing consumer suites remain byte-stable.
 *     reduced-motion: animation:none → 0s → instant.
 *
 *   No stale closing phase on re-open:
 *     mounted and phase both key off open=true first. The reopened shell cannot
 *     render data-state="closing" while prior callbacks are being cancelled.
 *
 *   StrictMode safe: effects have symmetric cleanup. No module-level state.
 *
 * C-B5-6: animationend guard:
 *   Browser: e.target===shell AND e.animationName===expected.
 *   jsdom: AnimationEvent unavailable → e.animationName===undefined → target-only guard.
 *
 * C-B5-9 (duration-stub seam): tests set inline animation-duration on the shell element.
 */
import { useState, useEffect, useLayoutEffect, useRef } from 'react';
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
  // Presence starts with the controlled open state. On a true→false transition,
  // the prior true value retains the shell for the closing render so the effect
  // can inspect its exit animation instead of losing shellRef before it runs.
  const [present, setPresent] = useState(open);

  const animNameRef = useRef(animName);
  useEffect(() => {
    animNameRef.current = animName;
  });

  useLayoutEffect(() => {
    if (open) {
      // Re-open (or initial mount): the previous open=false effect cleanup has
      // already cancelled any in-flight timer/listener before this effect runs.
      // Record presence so the next falling edge retains this shell.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- waiver:WVR-015 presence must follow controlled reopen after callbacks are cancelled; expires 2026-12-31
      setPresent(true);
      return;
    }

    // Initial open=false (or a completed close) has no shell to retain.
    if (!present) return;

    // open became false.
    const shell = shellRef.current;

    // No shell → complete the close rather than retaining phantom presence.
    if (!shell) {
      setPresent(false);
      return;
    }

    // Read current animation duration.
    // jsdom: '' → 0 → instant path (C-B5-1).
    const initialDuration = parseDurationMs(getComputedStyle(shell).animationDuration);

    if (initialDuration === 0) {
      // Instant path: no closing dwell.
      setPresent(false);
      return;
    }

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    function unmount() {
      if (cancelled) return;
      cancelled = true;
      if (timerId !== null) clearTimeout(timerId);
      shell!.removeEventListener('animationend', handleAnimationEnd);
      setPresent(false);
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
      // Cleanup cancels callbacks but does not clear presence. A re-open owns
      // the shell through open=true; a completed exit clears it in unmount().
      // StrictMode cleanup/re-setup: the second setup resets cancellation state.
    };
  }, [open, present, shellRef]);

  // Derive mounted from open (primary) and retained presence (dwell).
  // open=true → always mounted regardless of retained presence.
  // open=false + present=true → mounted (dwell).
  // open=false + present=false → not mounted.
  const mounted = open || present;
  const phase: ExitPhase = open ? 'open' : present ? 'closing' : 'open';

  return { mounted, phase };
}
