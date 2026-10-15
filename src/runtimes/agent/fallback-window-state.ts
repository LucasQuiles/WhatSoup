import { type AgentFallbackEntry } from '../../core/fallback-chain.ts';
import type { FallbackRecoveryState, FallbackRecoveryTerminalReason } from './fallback-state-db.ts';
import type { FallbackRestoreUnavailableReason } from './fallback-restore.ts';

/**
 * FallbackWindowState — lifecycle scalars for the provider-fallback window.
 *
 * Slice of the provider-fallback subsystem decomposition (sibling to
 * FallbackWindowMetrics). Owns the six window-lifecycle scalars the fallback
 * machinery arms / extends / reverts together: the active-until deadline, the
 * first-activation timestamp, the original arm reason, the reset deadline, the
 * recovery-probe-required flag, and the active fallback entry. isActive() carries
 * the only read logic (deadline vs now); all orchestration (arm / activate /
 * deactivate / revert / probe / restore) stays in AgentRuntime and pokes these
 * fields directly, exactly as before — this is a pure field-relocation, no
 * behavior change.
 *
 * Public mutable fields, NOT TS parameter-properties: Node's
 * --experimental-strip-types rejects parameter-properties (see
 * tests/strip-types-compat.test.ts). Mirrors the FallbackWindowMetrics /
 * AutoCompactController public-field pattern.
 */
export class FallbackWindowState {
  /**
   * Epoch ms until which new sessions route to the fallback provider, or null
   * when the primary provider is active.
   */
  activeUntil: number | null = null;
  /**
   * Epoch ms when the current fallback window was first activated. Preserved
   * across extensions so the original engagement time is never overwritten.
   */
  activatedAt: number | null = null;
  /**
   * The ORIGINAL cause that first armed the current window. Set once on first
   * activation and preserved across extensions and restores so the root cause
   * is never overwritten by a later extension or restart.
   */
  armReason: string | null = null;
  /** Epoch ms reset deadline for the current window, or null. */
  resetAt: number | null = null;
  /** Whether a recovery probe must succeed before the window can clear. */
  recoveryProbeRequired = false;
  /** The fallback entry serving the active window, or null. */
  activeEntry: AgentFallbackEntry | null = null;
  /** Recovery is active until a terminal or explicit operator hold stops
   *  automatic primary probes. A terminal/held fallback remains the effective
   *  route until an operator records fresh primary proof. */
  recoveryState: FallbackRecoveryState | 'unavailable' = 'active';
  recoveryTerminalReason: FallbackRecoveryTerminalReason | FallbackRestoreUnavailableReason | null = null;
  /** The start of the current recovery episode. This changes only on an
   *  explicit retry; `activatedAt` continues to describe the fallback window. */
  recoveryEpisodeStartedAt: number | null = null;
  /** A crash between claiming a primary probe and recording its outcome is
   *  ambiguous. Restore converts it to an operator hold before any replay. */
  recoveryProbeInFlight = false;

  /**
   * True while an armed fallback route remains eligible. Passing its deadline
   * starts a proof-gated recovery attempt; it cannot route new work to primary
   * until that proof commits. Unavailable is admission-quarantined separately.
   */
  isActive(): boolean {
    return this.activeUntil !== null
      && this.recoveryState !== 'unavailable';
  }
}
