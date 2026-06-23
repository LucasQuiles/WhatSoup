// src/lib/fleet-health-gate.ts
import { createChildLogger } from '../logger.ts';
import { proveAuthRecovery } from './genuine-recovery.ts';
import {
  loadBreakerState,
  saveBreakerState,
  registerOnset,
  recordAttempt,
  attemptsInWindow,
  clearIncident,
} from './incident-breaker.ts';

const log = createChildLogger('fleet-health-gate');

export type GateMode = 'off' | 'shadow' | 'warn' | 'enforce';

const VALID_MODES: GateMode[] = ['off', 'shadow', 'warn', 'enforce'];

/** Read the rollout mode from FLEET_HEALTH_VERIFY_GATE; default 'off' (current behavior). */
export function gateMode(): GateMode {
  const raw = process.env['FLEET_HEALTH_VERIFY_GATE']?.trim().toLowerCase();
  return (VALID_MODES as string[]).includes(raw ?? '') ? (raw as GateMode) : 'off';
}

export interface GateDeps {
  /** current time, sqlite 'YYYY-MM-DD HH:MM:SS' UTC format. */
  now(): string;
  /** directory holding durable breaker state. */
  stateDir: string;
  /** genuine-recovery lookback window. */
  recentWindowSeconds: number;
  /** sliding window for counting remediation attempts. */
  attemptWindowSeconds: number;
  /** attempts-in-window at/above which the breaker trips (enforce only). */
  tripThreshold: number;
  confirmedOutboundWithinSeconds(seconds: number): boolean;
  emitClear(): void;
  emitEscalation(evidence: string): void;
  emitGateFailure?(evidence: string): void;
}

export interface GateDecision {
  action: 'clear' | 'clear_shadow' | 'suppress_and_escalate';
  mode: GateMode;
  tripped: boolean;
  evidence: string;
}

/**
 * Decide whether the outbound_quarantined clear is genuine. Replaces the
 * unconditional clear at the end of postConnectRecovery.
 *
 * - off:     emit the clear unconditionally (legacy behavior).
 * - proof passes (any active mode): emit the clear, close the incident.
 * - proof fails:
 *     - shadow:  still emit the clear; record the would-suppress decision.
 *     - warn:    suppress the clear; raise exactly one escalation. No trip.
 *     - enforce: suppress the clear; raise exactly one escalation; trip the
 *                breaker once attempts-in-window >= tripThreshold.
 */
export function gateQuarantineClear(host: string, deps: GateDeps): GateDecision {
  const mode = gateMode();
  if (mode === 'off') {
    deps.emitClear();
    return { action: 'clear', mode, tripped: false, evidence: 'mode=off' };
  }

  try {
    const now = deps.now();
    const state = loadBreakerState(deps.stateDir, host, 'auth_terminal');
    const proof = proveAuthRecovery(
      { confirmedOutboundWithinSeconds: deps.confirmedOutboundWithinSeconds },
      deps.recentWindowSeconds,
    );

    if (proof.recovered) {
      clearIncident(state);
      saveBreakerState(deps.stateDir, state);
      deps.emitClear();
      return { action: 'clear', mode, tripped: false, evidence: proof.evidence };
    }

    // Proof failed -> this is a cosmetic clear over a still-broken fault.
    registerOnset(state, now);
    recordAttempt(state, now);
    const attempts = attemptsInWindow(state, now, deps.attemptWindowSeconds);

    if (mode === 'shadow') {
      saveBreakerState(deps.stateDir, state);
      deps.emitClear(); // shadow never changes behavior
      log.warn({ host, attempts, proof: proof.evidence }, 'fleet-health-gate: would suppress cosmetic clear (shadow)');
      return { action: 'clear_shadow', mode, tripped: false, evidence: proof.evidence };
    }

    if (mode === 'enforce' && attempts >= deps.tripThreshold) state.tripped = true;

    const escalationEvidence = `${proof.evidence} onset=${state.onset} attempts=${attempts} tripped=${state.tripped}`;
    if (!state.escalated) {
      state.escalated = true;
      deps.emitEscalation(escalationEvidence);
    }
    saveBreakerState(deps.stateDir, state);
    return { action: 'suppress_and_escalate', mode, tripped: state.tripped, evidence: escalationEvidence };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.emitGateFailure?.(`mode=${mode} error=${message}`);
    throw err;
  }
}
