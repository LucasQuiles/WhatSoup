/**
 * FallbackChain — the provider-fallback chain's per-window eligibility/failure state.
 *
 * Third slice of the provider-fallback subsystem decomposition. Owns the chain
 * bookkeeping that the selection + observability paths read and write: the set of
 * entry keys that have failed during the current window, the per-entry eligibility
 * computed at the last selection, the stable entry-key function, and the derived
 * snapshot / exhausted queries.
 *
 * The selection DECISION stays in AgentRuntime (selectFallbackEntryForWindow needs
 * credential lookups + alerting; markActiveFallbackFailed needs the session +
 * active-entry, which is window-lifecycle state) — those methods drive this state
 * (write chainState, add/clear failedKeys) and read entryKey here. The configured
 * fallbacks (agentFallbacks) also stay in AgentRuntime and are passed into snapshot /
 * isExhausted, so this class holds only per-window chain state, not config.
 *
 * Behavior is identical to the previous inline fields/methods — see the chain
 * characterization coverage (provider-fallback.test.ts, fallback-chain-selection.test.ts,
 * fallback-usage-limit-cascade.test.ts).
 */
import type { AgentFallbackEntry } from '../../core/fallback-chain.ts';

export class FallbackChain {
  /**
   * Keys of fallback entries that have failed during the current window. Public:
   * AgentRuntime's select / markActiveFallbackFailed / deactivate drive it, and the
   * chain characterization tests assert on it directly.
   */
  readonly failedKeys = new Set<string>();
  /**
   * Per-entry eligibility computed at the last window selection (empty until the
   * first selection). Written by AgentRuntime.selectFallbackEntryForWindow; read by
   * snapshot().
   */
  chainState: Array<AgentFallbackEntry & { eligible: boolean }> = [];

  /** Stable identity key for a fallback entry (provider + model). */
  entryKey(entry: AgentFallbackEntry): string {
    return `${entry.provider}\u0000${entry.model ?? ''}`;
  }

  /**
   * Snapshot of the chain with eligibility — the last selection's computed state if
   * present, else the configured entries with unknown (null) eligibility.
   */
  snapshot(
    agentFallbacks: AgentFallbackEntry[],
  ): Array<AgentFallbackEntry & { eligible: boolean | null }> {
    if (this.chainState.length > 0) {
      return this.chainState.map((entry) => ({ ...entry }));
    }
    return agentFallbacks.map((entry) => ({ ...entry, eligible: null }));
  }

  /**
   * True when every configured fallback entry has failed during the current window —
   * the terminal "nothing left to fall back to" condition.
   */
  isExhausted(agentFallbacks: AgentFallbackEntry[]): boolean {
    if (agentFallbacks.length === 0) return false;
    return agentFallbacks.every((entry) => this.failedKeys.has(this.entryKey(entry)));
  }
}
