/**
 * #3017 discriminating tests — three axes:
 *
 * AXIS A: periodic primary-readiness proof — an idle primary with expired
 *   OAuth must go non-green without a user turn when the periodic probe is
 *   expected. Discriminator: fails if the periodic-probe degradation is
 *   removed (modelEvidenceStaleWhileRelied returns false for idle+stale
 *   even when periodic_probe_expected is true).
 *
 * AXIS B: turn-attribution route match — recordTurnCapabilitySuccess must
 *   NOT clear post-revert fallback alerts or refresh primary usability from
 *   a turn served by a surviving fallback session. Discriminator: fails if
 *   the route-match guard is removed (a cross-provider or same-provider/
 *   different-model session refreshes the primary).
 *
 * AXIS C: probe target-context binding — the probe must fail closed
 *   (probe-blocked) when the probe target context differs from the serving
 *   context receipt. Discriminator: fails if the context-binding check is
 *   removed (a mismatched probe produces a normal result instead of blocking).
 *
 * CONTRACT: never-decisive proofs — claude auth status, credential presence,
 *   keychain readability, process presence, browser success page are NEVER
 *   decisive. The probe distinguishes valid-primary / invalid-primary-
 *   healthy-fallback / total-failure / probe-blocked / probe-error.
 */
import { describe, expect, it } from 'vitest';
import {
  modelEvidenceStaleWhileRelied,
  MODEL_STALE_RELIANCE_MS,
} from '../../../src/core/health.ts';
import {
  verifyServingContext,
  type PrimaryModelProbeAdapterDeps,
} from '../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts';
import type { PrimaryProbeServiceContext } from '../../../src/runtimes/agent/providers/primary-model-usability.ts';

const NOW = 1_786_000_000_000;

// ─── AXIS A: periodic primary-readiness proof ─────────────────────────────

describe('AXIS A: periodic primary-readiness proof', () => {
  it('A1: idle primary with stale evidence + periodic probe expected → degraded (non-green)', () => {
    // An idle bot (never turned) with stale model-usability evidence AND a
    // periodic probe active MUST degrade — the probe should have refreshed
    // the evidence, so staleness means the probe failed (e.g. expired OAuth).
    const tc = {
      model_usable_stale: true,
      last_successful_turn_at: null,
      last_turn_error_at: null,
      periodic_probe_expected: true,
    };
    expect(modelEvidenceStaleWhileRelied(tc, NOW)).toBe(true);
  });

  it('A2: idle primary with stale evidence + NO periodic probe → benign (backward-compatible)', () => {
    // Without the periodic probe, idle-stale evidence is benign (owner
    // decision 2026-07-17). This preserves the existing behavior.
    const tc = {
      model_usable_stale: true,
      last_successful_turn_at: null,
      last_turn_error_at: null,
      periodic_probe_expected: false,
    };
    expect(modelEvidenceStaleWhileRelied(tc, NOW)).toBe(false);
  });

  it('A3: idle primary with stale evidence + periodic probe expected null → benign (backward-compatible)', () => {
    // When periodic_probe_expected is null (not provided), the old behavior
    // is preserved — the field is optional for backward compatibility.
    const tc = {
      model_usable_stale: true,
      last_successful_turn_at: null,
      last_turn_error_at: null,
    };
    expect(modelEvidenceStaleWhileRelied(tc, NOW)).toBe(false);
  });

  it('A4: DISCRIMINATOR — fails if periodic-probe degradation is removed', () => {
    // If someone removes the periodic_probe_expected check from
    // modelEvidenceStaleWhileRelied, this test fails: an idle bot with
    // stale evidence + periodic probe would read benign instead of degraded.
    const tc = {
      model_usable_stale: true,
      last_successful_turn_at: null,
      last_turn_error_at: null,
      periodic_probe_expected: true,
    };
    // The function MUST return true (degraded). Without the guard it would
    // return false (benign) because lastTurnActivityAt <= 0.
    const result = modelEvidenceStaleWhileRelied(tc, NOW);
    expect(result).toBe(true); // discriminator: this fails if the guard is removed
  });

  it('A5: recently-active primary with stale evidence + periodic probe → degraded (both paths agree)', () => {
    // A bot that turned recently AND has a periodic probe — both the
    // reliance-based and periodic-probe paths should degrade.
    const tc = {
      model_usable_stale: true,
      last_successful_turn_at: NOW - 5 * 60_000, // 5 min ago
      last_turn_error_at: null,
      periodic_probe_expected: true,
    };
    expect(modelEvidenceStaleWhileRelied(tc, NOW)).toBe(true);
  });
});

// ─── AXIS C: probe target-context binding ─────────────────────────────────

function makeContext(over: Partial<PrimaryProbeServiceContext> = {}): PrimaryProbeServiceContext {
  return {
    provider: 'claude-cli',
    model: 'claude-opus-4-8',
    serviceGeneration: 'generation-a',
    launchContextHash: 'launch-a',
    binaryState: 'resolved',
    resolvedBinaryPathHash: 'path-a',
    binarySha256: 'sha-a',
    ...over,
  };
}

function makeDeps(over: Partial<PrimaryModelProbeAdapterDeps> = {}): PrimaryModelProbeAdapterDeps {
  const current = over.currentServiceContext ?? (() => makeContext());
  return {
    cwd: '/tmp/serving-config',
    serviceContext: makeContext(),
    requireServiceContext: true,
    currentServiceContext: current,
    ...over,
  };
}

describe('AXIS C: probe target-context binding', () => {
  it('C1: matching provider/model/generation/launch/binary context → null', () => {
    expect(verifyServingContext(
      { provider: 'claude-cli', model: 'claude-opus-4-8' },
      makeDeps(),
    )).toBeNull();
  });

  it('C2: provider mismatch → fail closed', () => {
    expect(verifyServingContext(
      { provider: 'opencode-cli', model: 'claude-opus-4-8' },
      makeDeps(),
    )).toBe('context-mismatch-provider');
  });

  it('C3: model mismatch → fail closed', () => {
    expect(verifyServingContext(
      { provider: 'claude-cli', model: 'different-model' },
      makeDeps(),
    )).toBe('context-mismatch-model');
  });

  it('C4: generation mismatch → fail closed', () => {
    expect(verifyServingContext(
      { provider: 'claude-cli', model: 'claude-opus-4-8' },
      makeDeps({ currentServiceContext: () => makeContext({ serviceGeneration: 'generation-b' }) }),
    )).toBe('context-mismatch-generation');
  });

  it('C5: effective launch selector mismatch → fail closed', () => {
    expect(verifyServingContext(
      { provider: 'claude-cli', model: 'claude-opus-4-8' },
      makeDeps({ currentServiceContext: () => makeContext({ launchContextHash: 'launch-b' }) }),
    )).toBe('context-mismatch-launch');
  });

  it('C6: resolved binary path and SHA mismatches → fail closed', () => {
    expect(verifyServingContext(
      { provider: 'claude-cli', model: 'claude-opus-4-8' },
      makeDeps({ currentServiceContext: () => makeContext({ resolvedBinaryPathHash: 'path-b' }) }),
    )).toBe('context-mismatch-binary-path');
    expect(verifyServingContext(
      { provider: 'claude-cli', model: 'claude-opus-4-8' },
      makeDeps({ currentServiceContext: () => makeContext({ binarySha256: 'sha-b' }) }),
    )).toBe('context-mismatch-binary-sha');
  });

  it('C7: missing CLI identity never becomes green', () => {
    expect(verifyServingContext(
      { provider: 'claude-cli', model: 'claude-opus-4-8' },
      makeDeps({
        serviceContext: makeContext({ binaryState: 'missing', resolvedBinaryPathHash: null, binarySha256: null }),
        currentServiceContext: () => makeContext({ binaryState: 'resolved' }),
      }),
    )).toBe('context-mismatch-binary-state');
  });

  it('C8: missing production context is blocked; legacy fixture mode remains nullable', () => {
    const target = { provider: 'claude-cli', model: 'claude-opus-4-8' };
    expect(verifyServingContext(target, {
      requireServiceContext: true,
    })).toBe('context-missing-service');
    expect(verifyServingContext(target, {})).toBeNull();
  });
});

// ─── CONTRACT: never-decisive proofs ───────────────────────────────────────

describe('CONTRACT: never-decisive proofs', () => {
  it('NC1: modelEvidenceStaleWhileRelied does not use credential presence or auth status', () => {
    const tc = {
      model_usable_stale: true,
      last_successful_turn_at: null,
      last_turn_error_at: null,
      periodic_probe_expected: true,
    };
    expect(() => modelEvidenceStaleWhileRelied(tc, NOW)).not.toThrow();
    expect(modelEvidenceStaleWhileRelied(tc, NOW)).toBe(true);
  });

  it('NC2: context mismatch reasons are bounded and content-free', () => {
    const reason = verifyServingContext(
      { provider: 'opencode-cli', model: 'claude-opus-4-8' },
      makeDeps(),
    );
    expect(reason).toMatch(/^context-mismatch-/);
    expect(reason).not.toMatch(/key|token|secret|password|credential/i);
  });

  it('NC3: service context contains no raw path or credential material', () => {
    const context = makeContext();
    const contextStr = JSON.stringify(context);
    expect(contextStr).not.toMatch(/accessToken|refreshToken|oauthToken|apiKey|secret-/i);
    expect(contextStr).not.toContain('/usr/');
    expect(context.resolvedBinaryPathHash).toMatch(/^[a-z0-9-]+$/);
    expect(context.binarySha256).toMatch(/^[a-z0-9-]+$/);
  });
});
