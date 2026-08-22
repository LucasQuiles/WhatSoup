import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import {
  CONTRACT_DIR,
  checkObservationContract,
} from '../../scripts/observation-contract-guard.ts';
import { BRANCH_STEPS } from '../../scripts/push-gate.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const tmp = trackTmpDirs('whatsoup-observation-contract-');

function makeRoot(): string {
  const root = tmp.make('contract');
  cpSync(path.join(repoRoot, CONTRACT_DIR), path.join(root, CONTRACT_DIR), { recursive: true });
  return root;
}

function patchJson(root: string, rel: string, mutate: (data: any) => void): void {
  const p = path.join(root, CONTRACT_DIR, rel);
  const data = JSON.parse(readFileSync(p, 'utf8'));
  mutate(data);
  writeFileSync(p, JSON.stringify(data, null, 2));
}

describe('observation contract guard', () => {
  it('accepts the tracked contract set with zero findings', () => {
    const result = checkObservationContract(repoRoot);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.counts.claims).toBeGreaterThanOrEqual(20);
    expect(result.counts.adapters).toBeGreaterThanOrEqual(10);
    expect(result.counts.surfaces).toBe(8);
    expect(result.counts.validFixtures).toBeGreaterThanOrEqual(5);
    expect(result.counts.invalidFixtures).toBeGreaterThanOrEqual(6);
  });

  it('is wired into the branch push gate', () => {
    const names = BRANCH_STEPS.map((step) => step.name);
    expect(names).toContain('guard:observation-contract');
  });

  it('rejects an unsupported schema_version on any data document', () => {
    const root = makeRoot();
    patchJson(root, 'claim-catalog.json', (data) => {
      data.schema_version = '999';
    });
    const result = checkObservationContract(root);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain('unsupported-schema-version');
  });

  it('rejects malformed registry members instead of silently filtering them', () => {
    const root = makeRoot();
    patchJson(root, 'adapter-registry.json', (data) => {
      data.adapters[0].can_establish.push(42);
    });
    const result = checkObservationContract(root);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain('malformed-entry');
  });

  it('rejects contract bytes that are not valid UTF-8', () => {
    const root = makeRoot();
    const p = path.join(root, CONTRACT_DIR, 'authority-lattice.json');
    const raw = readFileSync(p);
    const brace = raw.indexOf(0x7b);
    writeFileSync(
      p,
      Buffer.concat([
        raw.subarray(0, brace + 1),
        Buffer.from('"probe": "', 'utf8'),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('", ', 'utf8'),
        raw.subarray(brace + 1),
      ]),
    );
    const result = checkObservationContract(root);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain('contract-unreadable');
  });

  it('converts reader rejections into findings (duplicate authority tier)', () => {
    // The guard must never bless a structure the strict readers reject.
    const root = makeRoot();
    patchJson(root, 'authority-lattice.json', (data) => {
      data.tiers.push({ ...data.tiers[0] });
    });
    const result = checkObservationContract(root);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain('reader-rejected');
  });

  it('converts reader rejections into findings (empty adapter id)', () => {
    const root = makeRoot();
    patchJson(root, 'adapter-registry.json', (data) => {
      data.adapters.push({ adapter_id: '', can_establish: [], cannot_establish: [] });
    });
    const result = checkObservationContract(root);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain('reader-rejected');
  });

  it('rejects an unknown min_projection value', () => {
    const root = makeRoot();
    patchJson(root, 'claim-catalog.json', (data) => {
      data.claims[0].min_projection = 'diagnotic';
    });
    const result = checkObservationContract(root);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain('malformed-entry');
  });

  it('reports malformed governed scalars as findings instead of crashing (guard-path parity)', () => {
    // Round 7 parity fence — NOT a falsifier, and deliberately recorded as
    // such. This test passes both before and after the round-7 fix, because
    // the guard's reader call is wrapped in an UNQUALIFIED `catch (err)` that
    // converts any throw — ObservationContractPortError or raw TypeError alike
    // — into a `reader-rejected` finding. So the taxonomy defect's blast radius
    // was the DIRECT-READER path only; the guard path was already structured.
    // What this fence buys: the guard keeps reporting these as findings after
    // the reader's error class changed, and it pins the guard-vs-reader parity
    // the lockstep matrix asserts on the direct path.
    // (That the guard cannot distinguish a contract defect from a reader BUG is
    // a separate masking concern — registered, not fixed here.)
    const cases: Array<[string, (data: Record<string, never>) => void]> = [
      ['min_projection', (d) => {
        (d as never as { claims: Array<Record<string, unknown>> }).claims[0]!['min_projection'] = { a: 1 };
      }],
      ['authority_tier', (d) => {
        (d as never as { claims: Array<Record<string, unknown>> }).claims[0]!['authority_tier'] = [1];
      }],
      ['generation_binding', (d) => {
        (d as never as { claims: Array<Record<string, unknown>> }).claims[0]!['generation_binding'] = { a: 1 };
      }],
    ];
    for (const [field, mutate] of cases) {
      const root = makeRoot();
      patchJson(root, 'claim-catalog.json', mutate as (data: Record<string, never>) => void);
      const result = checkObservationContract(root);
      expect(result.ok, field).toBe(false);
      const codes = result.findings.map((f) => f.code);
      expect(codes.some((c) => c === 'reader-rejected' || c === 'malformed-entry'), `${field}: ${codes.join(',')}`).toBe(true);
    }

    for (const [field, value] of [
      ['projection_scope', { a: 1 }],
      ['status', [1]],
    ] as Array<[string, unknown]>) {
      const root = makeRoot();
      patchJson(root, 'adapter-registry.json', (data) => {
        (data as never as { adapters: Array<Record<string, unknown>> }).adapters[0]![field] = value;
      });
      const result = checkObservationContract(root);
      expect(result.ok, field).toBe(false);
      const codes = result.findings.map((f) => f.code);
      expect(codes.some((c) => c === 'reader-rejected' || c === 'malformed-entry'), `${field}: ${codes.join(',')}`).toBe(true);
    }
  });

  it('rejects overlapping can_establish/cannot_establish on one adapter', () => {
    const root = makeRoot();
    patchJson(root, 'adapter-registry.json', (data) => {
      const adapter = data.adapters[0];
      adapter.cannot_establish.push(adapter.can_establish[0]);
    });
    const result = checkObservationContract(root);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain('authority-overlap');
  });

  it('rejects a claim requirement cycle', () => {
    const root = makeRoot();
    patchJson(root, 'claim-catalog.json', (data) => {
      const first = data.claims[0];
      first.requires = [...(first.requires ?? []), first.claim_id];
    });
    const result = checkObservationContract(root);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain('requires-cycle');
  });

  it('rejects a BOM-prefixed contract document', () => {
    const root = makeRoot();
    const p = path.join(root, CONTRACT_DIR, 'claim-catalog.json');
    writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(p)]));
    const result = checkObservationContract(root);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain('contract-unreadable');
  });

  it('rejects a canonical outcome missing from the envelope schema enum', () => {
    const root = makeRoot();
    patchJson(root, 'outcome-projections.json', (data) => {
      data.canonical_outcomes.push('healthy');
    });
    const result = checkObservationContract(root);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain('canonical-vocab-mismatch');
  });

  it('rejects a projection table that no longer covers its declared domain', () => {
    const root = makeRoot();
    patchJson(root, 'outcome-projections.json', (data) => {
      data.surfaces.watchdog_wd_rank.rows = data.surfaces.watchdog_wd_rank.rows.filter(
        (row: { legacy_value: string }) => row.legacy_value !== 'CREDENTIAL-DEAD',
      );
    });
    const result = checkObservationContract(root);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain('projection-domain-incomplete');
  });

  it('rejects a schema legacy surface with no projection table (C1 closure)', () => {
    const root = makeRoot();
    patchJson(root, 'outcome-projections.json', (data) => {
      delete data.surfaces.bot_errors_event;
    });
    const result = checkObservationContract(root);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain('legacy-surface-unknown');
  });

  it('rejects a projection table for a surface the schema enum does not admit', () => {
    const root = makeRoot();
    patchJson(root, 'outcome-projections.json', (data) => {
      data.surfaces.rogue_surface = {
        source: 'test',
        domain: ['x'],
        rows: [{ legacy_value: 'x', canonical: 'pass', lossy: false }],
      };
    });
    const result = checkObservationContract(root);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain('legacy-surface-unknown');
  });

  it('rejects an adapter declaring a claim the catalog does not define', () => {
    const root = makeRoot();
    patchJson(root, 'adapter-registry.json', (data) => {
      data.adapters[0].can_establish.push('made_up.claim');
    });
    const result = checkObservationContract(root);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain('unknown-claim-reference');
  });

  it('fails when a golden fixture violates the min-projection rule (F01)', () => {
    const root = makeRoot();
    patchJson(root, 'fixtures/valid/diagnostic-auth-bond-pass.json', (data) => {
      data.projection = { scope: 'public', authorization: 'no_token' };
    });
    const result = checkObservationContract(root);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain('valid-fixture-rejected');
  });

  it('fails when a counterexample fixture is silently accepted', () => {
    const root = makeRoot();
    patchJson(root, 'fixtures/invalid/additional-property.json', (data) => {
      delete data.surprise_field;
    });
    const result = checkObservationContract(root);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain('invalid-fixture-accepted');
  });

  it('rejects an unresolved-alias envelope carrying a verdict (amendment 1)', () => {
    const root = makeRoot();
    patchJson(root, 'fixtures/valid/alias-unresolved-context-mismatch.json', (data) => {
      data.outcome = 'pass';
      delete data.unobserved_reason;
    });
    const result = checkObservationContract(root);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain('valid-fixture-rejected');
  });
});
