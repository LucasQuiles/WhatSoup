/**
 * One condition, one cross-reference: every `degradation_causes` entry must
 * name the `status_reasons` twin(s) that the SAME condition raises, or carry an
 * explicit `no_reason_twin` annotation.
 *
 * The motivating gap: `runtimeTurnRecoveryIsDegraded` reaches status_reasons
 * as `runtime.turn_finalization_debt` and degradation_causes as
 * `turn_recovery_degraded`, with nothing tying the two names together.
 * `ensureStatusReasonFloor` (#3316) only guarantees a reason EXISTS; it does
 * not say which reason a cause corresponds to. This registry does, and the
 * tests below keep it total (every cause has an entry) and honest (every named
 * reason is a literal the emitting source actually pushes).
 *
 * Live strings are never renamed here — the soak baseline depends on them.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HEALTH_DEGRADATION_CAUSES,
  HEALTH_DEGRADATION_CAUSE_REASON_TWINS,
  HEALTH_DEGRADATION_CAUSE_REGISTRY,
  NO_REASON_TWIN,
} from '../../src/core/health.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function collectTsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => resolve(entry.parentPath || dir, entry.name));
}

function emittingSource(): string {
  const files = [
    resolve(repoRoot, 'src/core/health.ts'),
    ...collectTsFiles(resolve(repoRoot, 'src/runtimes')),
  ];
  return files.map((file) => readFileSync(file, 'utf8')).join('\n');
}

describe('HEALTH_DEGRADATION_CAUSE_REASON_TWINS — cause -> status_reason cross-reference', () => {
  it('is total: exactly one entry per registered degradation cause, no extras', () => {
    expect(Object.keys(HEALTH_DEGRADATION_CAUSE_REASON_TWINS).sort())
      .toEqual([...HEALTH_DEGRADATION_CAUSES].sort());
  });

  it('is a derived view of the production cause registry, not a second table', () => {
    // The registry is what health.ts derives HEALTH_DEGRADATION_CAUSES from at
    // module load, so the cross-reference lives in the production import graph
    // (orphan-reachability guard, invariant C) rather than beside it.
    expect(Object.keys(HEALTH_DEGRADATION_CAUSE_REGISTRY).sort())
      .toEqual([...HEALTH_DEGRADATION_CAUSES].sort());
    for (const cause of HEALTH_DEGRADATION_CAUSES) {
      expect(HEALTH_DEGRADATION_CAUSE_REASON_TWINS[cause], cause)
        .toBe(HEALTH_DEGRADATION_CAUSE_REGISTRY[cause].reasonTwins);
    }
  });

  it('every entry is either a non-empty reason list or the explicit no_reason_twin annotation', () => {
    for (const cause of HEALTH_DEGRADATION_CAUSES) {
      const twins = HEALTH_DEGRADATION_CAUSE_REASON_TWINS[cause];
      if (twins === NO_REASON_TWIN) continue;
      expect(Array.isArray(twins), `${cause} twins shape`).toBe(true);
      expect(twins.length, `${cause} must name >=1 reason`).toBeGreaterThan(0);
      for (const reason of twins) {
        expect(typeof reason, `${cause} twin type`).toBe('string');
        expect(reason.length, `${cause} twin nonempty`).toBeGreaterThan(0);
      }
    }
  });

  it('names runtime.turn_finalization_debt as the reason twin of turn_recovery_degraded (the one-condition-two-names gap)', () => {
    expect(HEALTH_DEGRADATION_CAUSE_REASON_TWINS.turn_recovery_degraded)
      .toContain('runtime.turn_finalization_debt');
    // Both causes are raised from the same runtimeTurnRecoveryIsDegraded
    // predicate family, so both share the twin.
    expect(HEALTH_DEGRADATION_CAUSE_REASON_TWINS.turn_finalization_degraded)
      .toContain('runtime.turn_finalization_debt');
  });

  it('keeps the live strings the soak baseline depends on', () => {
    expect(HEALTH_DEGRADATION_CAUSE_REASON_TWINS.delivery_identity_debt)
      .toContain('runtime.completed_delivery_identity_debt');
    expect(HEALTH_DEGRADATION_CAUSE_REASON_TWINS.turn_capability_evidence_stale)
      .toContain('turn_capability_degraded');
    expect(HEALTH_DEGRADATION_CAUSES).toContain('turn_recovery_degraded');
    expect(HEALTH_DEGRADATION_CAUSES).toContain('turn_capability_evidence_stale');
  });

  it('every exact reason twin is a literal the emitting source actually pushes (no phantom reasons)', () => {
    const source = emittingSource();
    for (const cause of HEALTH_DEGRADATION_CAUSES) {
      const twins = HEALTH_DEGRADATION_CAUSE_REASON_TWINS[cause];
      if (twins === NO_REASON_TWIN) continue;
      for (const reason of twins) {
        // `prefix.*` twins name a family (auth_failure.<class>,
        // memory_readiness_<state>); check the stable prefix instead.
        const literal = reason.endsWith('*')
          ? reason.slice(0, -1)
          : reason.startsWith('runtime.')
            ? `'${reason.slice('runtime.'.length)}'`
            : `'${reason}'`;
        expect(source.includes(literal), `${cause} -> ${reason}: literal ${literal} not found in emitting source`)
          .toBe(true);
      }
    }
  });

  it('the no_reason_twin annotation is reserved for causes the status_reasons vector genuinely never names', () => {
    const annotated = HEALTH_DEGRADATION_CAUSES.filter(
      (cause) => HEALTH_DEGRADATION_CAUSE_REASON_TWINS[cause] === NO_REASON_TWIN,
    );
    // Pinned so a new annotation is a deliberate, reviewed choice rather than
    // the path of least resistance.
    expect(annotated.sort()).toEqual([
      'continuity_gap_open',
      'continuity_gap_unreadable',
      'fallback_chain_exhausted',
      'fallback_entry_failures',
    ]);
  });
});
