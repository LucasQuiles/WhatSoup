/**
 * Drift classifier (rider P1) — path set in, drift class + invalidated evidence out.
 *
 * The classifier's whole value is that it says NO in the right places, so the tests that
 * matter are the escalation and the refusal cases, not the happy path. Three properties in
 * particular would rot silently if only example-based tests existed, and each gets an
 * explicit test below:
 *
 *   1. `candidate-only` must appear in NO invalidation set. If it ever does, every
 *      candidate-local receipt starts being discarded on unrelated drift, and nothing else
 *      in the suite would notice.
 *   2. Escalation must be MAX, not last-wins. A path set of [docs, workflow] is a policy
 *      stop; a classifier that returned the last match would call it metadata.
 *   3. An unrecognised path must force UNKNOWN. Defaulting it to DISJOINT_CODE is exactly
 *      how a new policy surface gets treated as inert.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { changedPaths, main, parseArgs } from '../../scripts/drift-classify.ts';

import {
  DRIFT_CLASSES,
  DRIFT_MATRIX,
  EXIT_CONTINUE,
  EXIT_INCONCLUSIVE,
  EXIT_STOP,
  RECEIPT_TAG_EXAMPLES,
  SENSITIVITY_TAGS,
  classifyDrift,
  exitCodeFor,
  receiptSurvives,
  worstOf,
} from '../../scripts/lib/drift-classifier.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('drift classifier — structural invariants', () => {
  it('every drift class has a matrix entry with a substantive reason', () => {
    for (const d of DRIFT_CLASSES) {
      const spec = DRIFT_MATRIX[d];
      expect(spec, `${d} missing from DRIFT_MATRIX`).toBeDefined();
      expect(spec.why.length, `${d} needs a real reason`).toBeGreaterThan(30);
    }
  });

  it('every invalidated tag is a REAL sensitivity tag (no typos silently never matching)', () => {
    // A typo'd tag would invalidate nothing and read as a narrower blast radius than intended.
    for (const d of DRIFT_CLASSES) {
      for (const tag of DRIFT_MATRIX[d].invalidates) {
        expect(SENSITIVITY_TAGS, `${d} invalidates unknown tag ${tag}`).toContain(tag);
      }
    }
  });

  it('candidate-only is invalidated by NOTHING — the property the tag exists for', () => {
    // Property 1. A receipt depending only on the candidate OID cannot be invalidated by
    // anything happening on main.
    for (const d of DRIFT_CLASSES) {
      expect(
        DRIFT_MATRIX[d].invalidates,
        `${d} invalidates candidate-only, which defeats the tag`,
      ).not.toContain('candidate-only');
    }
    for (const d of DRIFT_CLASSES) {
      expect(receiptSurvives(['candidate-only'], d), `candidate-only died on ${d}`).toBe(true);
    }
  });

  it('escalation is monotonic — more severe classes invalidate a superset', () => {
    // POLICY_OR_WORKFLOW must invalidate everything DISJOINT_METADATA does, or a worse
    // drift could preserve evidence a milder one discarded.
    const mild = new Set(DRIFT_MATRIX.DISJOINT_METADATA.invalidates);
    for (const tag of mild) {
      expect(DRIFT_MATRIX.POLICY_OR_WORKFLOW.invalidates).toContain(tag);
      expect(DRIFT_MATRIX.UNKNOWN.invalidates).toContain(tag);
    }
  });
});

describe('classifyDrift — path classification', () => {
  it('no changed paths means NONE, and NONE is a real verdict', () => {
    const v = classifyDrift([]);
    expect(v.drift).toBe('NONE');
    expect(v.invalidates).toEqual([]);
    expect(exitCodeFor(v.drift)).toBe(EXIT_CONTINUE);
  });

  it.each([
    ['.github/workflows/quality.yml', 'POLICY_OR_WORKFLOW'],
    ['.husky/pre-push', 'POLICY_OR_WORKFLOW'],
    ['package.json', 'POLICY_OR_WORKFLOW'],
    ['scripts/lib/fitness/registry.ts', 'POLICY_OR_WORKFLOW'],
    ['scripts/no-destructive-git-guard.ts', 'POLICY_OR_WORKFLOW'],
    // Both guard-script naming conventions in this repo. The `check-*` form was missed by
    // the first draft and fell through to UNKNOWN — found by running the classifier
    // against real drift, not by inspection.
    ['scripts/check-insecure-tempfile.ts', 'POLICY_OR_WORKFLOW'],
    ['scripts/import-boundary-check.ts', 'POLICY_OR_WORKFLOW'],
    ['scripts/check-unit-drift.sh', 'POLICY_OR_WORKFLOW'],
    ['package-lock.json', 'DEPENDENCY'],
    ['.nvmrc', 'DEPENDENCY'],
    ['src/lib/phone.ts', 'SHARED_RUNTIME'],
    ['src/core/database.ts', 'SHARED_RUNTIME'],
    ['docs/runbook.md', 'DISJOINT_METADATA'],
    ['src/runtimes/agent/runtime.ts', 'DISJOINT_CODE'],
    ['tests/core/foo.test.ts', 'DISJOINT_CODE'],
  ])('%s classifies as %s', (path, expected) => {
    expect(classifyDrift([path]).drift).toBe(expected);
  });

  it('policy patterns win over the generic ones they also match', () => {
    // `.github/workflows/x.yml` is not source and not docs; without ordering it could fall
    // through to a milder rule. Same for package.json, which the DEPENDENCY rule would
    // otherwise claim.
    expect(classifyDrift(['.github/workflows/x.yml']).drift).toBe('POLICY_OR_WORKFLOW');
    expect(classifyDrift(['package.json']).drift).toBe('POLICY_OR_WORKFLOW');
  });

  it('escalates to the MOST invalidating class, not the last one seen', () => {
    // Property 2. Order the input so a last-wins implementation would answer differently.
    const v = classifyDrift(['.github/workflows/quality.yml', 'docs/runbook.md']);
    expect(v.drift).toBe('POLICY_OR_WORKFLOW');

    const reversed = classifyDrift(['docs/runbook.md', '.github/workflows/quality.yml']);
    expect(reversed.drift).toBe('POLICY_OR_WORKFLOW');
    expect(reversed.drift).toBe(v.drift);
  });

  it('a path the candidate ALSO edits is a CONFLICT needing an integrator', () => {
    const v = classifyDrift(['src/runtimes/agent/runtime.ts'], {
      candidatePaths: ['src/runtimes/agent/runtime.ts'],
    });
    expect(v.drift).toBe('CONFLICT');
    expect(v.behavior).toBe('integrator-intervention');
    expect(exitCodeFor(v.drift)).toBe(EXIT_STOP);
  });

  it('reports per-path detail so a verdict is explainable, not just asserted', () => {
    const v = classifyDrift(['docs/a.md', 'src/lib/b.ts']);
    expect(v.classifications).toHaveLength(2);
    expect(v.classifications.map((c) => c.path)).toEqual(['docs/a.md', 'src/lib/b.ts']);
    for (const c of v.classifications) expect(c.rule.length).toBeGreaterThan(5);
  });
});

describe('classifyDrift — refuses rather than guesses', () => {
  it('an unrecognised path forces UNKNOWN and names the offender', () => {
    // Property 3. Defaulting an unknown path to DISJOINT_CODE is how a new policy surface
    // gets treated as inert.
    const v = classifyDrift(['some/brand/new/surface.bin']);
    expect(v.drift).toBe('UNKNOWN');
    expect(v.behavior).toBe('inconclusive');
    expect(v.unclassified).toEqual(['some/brand/new/surface.bin']);
    expect(v.why).toMatch(/refusing to guess/);
    expect(exitCodeFor(v.drift)).toBe(EXIT_INCONCLUSIVE);
  });

  it('one unrecognised path poisons an otherwise-understood set', () => {
    // The dangerous shape: 99 known paths and one unknown must NOT average out to a verdict.
    const v = classifyDrift(['docs/a.md', 'src/lib/b.ts', 'weird/thing.xyz']);
    expect(v.drift).toBe('UNKNOWN');
    expect(v.unclassified).toEqual(['weird/thing.xyz']);
  });

  it('failed path enumeration is UNKNOWN, distinct from "nothing changed"', () => {
    const failed = classifyDrift([], { analysisFailed: true });
    expect(failed.drift).toBe('UNKNOWN');
    expect(exitCodeFor(failed.drift)).toBe(EXIT_INCONCLUSIVE);

    const empty = classifyDrift([]);
    expect(empty.drift).toBe('NONE');
    expect(exitCodeFor(empty.drift)).toBe(EXIT_CONTINUE);

    // The distinction is the entire point: "I looked and saw nothing" vs "I could not look".
    expect(failed.drift).not.toBe(empty.drift);
  });
});

describe('receipt sensitivity — reuse becomes mechanical', () => {
  it('an integration suite receipt dies on any drift that moves the merge result', () => {
    expect(receiptSurvives(['merge-sensitive'], 'NONE')).toBe(true);
    expect(receiptSurvives(['merge-sensitive'], 'DISJOINT_METADATA')).toBe(false);
    expect(receiptSurvives(['merge-sensitive'], 'POLICY_OR_WORKFLOW')).toBe(false);
  });

  it('a workflow policy check survives code drift but not policy drift', () => {
    expect(receiptSurvives(['policy-sensitive'], 'DISJOINT_CODE')).toBe(true);
    expect(receiptSurvives(['policy-sensitive'], 'POLICY_OR_WORKFLOW')).toBe(false);
  });

  it('a dependency install survives docs drift but not a lockfile change', () => {
    expect(receiptSurvives(['base-sensitive', 'toolchain-sensitive'], 'DISJOINT_METADATA')).toBe(false);
    expect(receiptSurvives(['toolchain-sensitive'], 'DISJOINT_METADATA')).toBe(true);
    expect(receiptSurvives(['toolchain-sensitive'], 'DEPENDENCY')).toBe(false);
  });

  it('every rider worked example uses only real tags', () => {
    for (const [label, tags] of Object.entries(RECEIPT_TAG_EXAMPLES)) {
      expect(tags.length, `${label} has no tags`).toBeGreaterThan(0);
      for (const t of tags) expect(SENSITIVITY_TAGS, `${label} -> ${t}`).toContain(t);
    }
  });

  it('UNKNOWN invalidates everything except candidate-only', () => {
    for (const tag of SENSITIVITY_TAGS) {
      const expected = tag === 'candidate-only';
      expect(receiptSurvives([tag], 'UNKNOWN'), `${tag} under UNKNOWN`).toBe(expected);
    }
  });
});

describe('worstOf and exit codes', () => {
  it('worstOf is commutative and picks the more invalidating class', () => {
    expect(worstOf('NONE', 'POLICY_OR_WORKFLOW')).toBe('POLICY_OR_WORKFLOW');
    expect(worstOf('POLICY_OR_WORKFLOW', 'NONE')).toBe('POLICY_OR_WORKFLOW');
    expect(worstOf('DISJOINT_METADATA', 'DISJOINT_CODE')).toBe('DISJOINT_CODE');
    expect(worstOf('UNKNOWN', 'POLICY_OR_WORKFLOW')).toBe('UNKNOWN');
  });

  it('only continue-class drifts exit 0; UNKNOWN is 2, never 1', () => {
    expect(exitCodeFor('NONE')).toBe(EXIT_CONTINUE);
    expect(exitCodeFor('DISJOINT_METADATA')).toBe(EXIT_CONTINUE);
    expect(exitCodeFor('DISJOINT_CODE')).toBe(EXIT_CONTINUE);
    expect(exitCodeFor('AFFECTED_COMPONENT')).toBe(EXIT_STOP);
    expect(exitCodeFor('POLICY_OR_WORKFLOW')).toBe(EXIT_STOP);
    // Distinct from STOP on purpose: "could not determine" must not send an operator
    // hunting for a violation that was never established.
    expect(exitCodeFor('UNKNOWN')).toBe(EXIT_INCONCLUSIVE);
  });

  it('every drift class maps to exactly one of the three exit codes', () => {
    for (const d of DRIFT_CLASSES) {
      expect([EXIT_CONTINUE, EXIT_STOP, EXIT_INCONCLUSIVE]).toContain(exitCodeFor(d));
    }
  });
});

describe('drift-classify CLI — the IO boundary', () => {
  it('parses flags and defaults observed to origin/main', () => {
    expect(parseArgs(['--base', 'abc'])).toMatchObject({ base: 'abc', observed: 'origin/main', json: false });
    expect(parseArgs(['--base', 'abc', '--observed', 'upstream/main', '--json'])).toMatchObject({
      base: 'abc',
      observed: 'upstream/main',
      json: true,
    });
  });

  it('returns null — not [] — when git cannot answer', () => {
    // The distinction the whole three-outcome discipline rests on: an empty array means
    // "nothing changed", null means "I could not look".
    expect(changedPaths('does-not-exist-aaa', 'does-not-exist-bbb', repoRoot)).toBeNull();
  });

  it('returns a real path list for a range that exists', () => {
    const paths = changedPaths('HEAD~1', 'HEAD', repoRoot);
    expect(paths).not.toBeNull();
    expect(Array.isArray(paths)).toBe(true);
  });

  it('exits INCONCLUSIVE when --base is missing rather than assuming a base', () => {
    expect(main([], repoRoot)).toBe(EXIT_INCONCLUSIVE);
  });

  it('exits INCONCLUSIVE when the diff cannot be computed', () => {
    expect(main(['--base', 'totally-not-a-ref-zzz'], repoRoot)).toBe(EXIT_INCONCLUSIVE);
  });
});
