/**
 * Evidence reuse — which receipts survive a drift.
 *
 * The one property that matters more than all the others: an UNRECOGNISED invocation must
 * never be reused. The tempting default, `candidate-only`, survives every drift class by
 * construction, so defaulting to it would silently reuse every receipt nobody had got round
 * to classifying — a false green that grows as the repo adds invocations. That property gets
 * tested from three directions below, because it is the one that would be quietly lost.
 */
import { describe, expect, it } from 'vitest';

import { DRIFT_CLASSES, SENSITIVITY_TAGS } from '../../scripts/lib/drift-classifier.ts';
import {
  MAXIMALLY_SENSITIVE,
  partitionReceipts,
  reuseDecision,
  tagsForInvocation,
} from '../../scripts/lib/evidence-reuse.ts';

const withBase = (invocation: string) => ({
  invocation,
  base: { baseOid: 'a'.repeat(40), mergeBaseOid: null },
});

describe('tagsForInvocation', () => {
  it.each([
    ['format:check', ['candidate-only']],
    ['typecheck:all', ['candidate-only', 'toolchain-sensitive']],
    ['integration:suite', ['merge-sensitive']],
    ['guard:branch-protection-drift', ['policy-sensitive']],
  ])('%s resolves to the rider tags', (invocation, expected) => {
    expect([...tagsForInvocation(invocation).tags]).toEqual(expected);
  });

  it('prefers the LONGEST matching prefix, so specific rules beat generic ones', () => {
    // `guard:lint:src` matches both `guard:` and `guard:lint`. Without longest-match it
    // would inherit the generic gate tags and lose `candidate-only`, making every lint
    // receipt un-reusable on any base drift.
    const lint = tagsForInvocation('guard:lint:src');
    expect(lint.tags).toContain('candidate-only');
    expect(lint.tags).not.toContain('base-sensitive');

    const generic = tagsForInvocation('guard:something-else');
    expect(generic.tags).toContain('base-sensitive');
  });

  it('every emitted tag is a real sensitivity tag', () => {
    for (const inv of ['format', 'typecheck', 'guard:x', 'release:artifact', 'totally-unknown']) {
      for (const t of tagsForInvocation(inv).tags) expect(SENSITIVITY_TAGS).toContain(t);
    }
  });
});

describe('the fail-closed default — the property most worth protecting', () => {
  it('an unrecognised invocation is MAXIMALLY sensitive, not candidate-only', () => {
    const r = tagsForInvocation('some-new-step-nobody-classified');
    expect(r.recognised).toBe(false);
    expect([...r.tags].sort()).toEqual([...MAXIMALLY_SENSITIVE].sort());
    // The specific trap: candidate-only survives every drift class, so defaulting to it
    // would make unknown receipts ALWAYS reusable.
    expect(r.tags).not.toContain('candidate-only');
  });

  it('MAXIMALLY_SENSITIVE is every tag except candidate-only — no accidental omission', () => {
    expect([...MAXIMALLY_SENSITIVE].sort()).toEqual(
      SENSITIVITY_TAGS.filter((t) => t !== 'candidate-only').sort(),
    );
  });

  it('an unrecognised receipt is never reusable under ANY drift class except NONE', () => {
    for (const d of DRIFT_CLASSES) {
      const decision = reuseDecision(withBase('unknown-invocation-xyz'), d);
      if (d === 'NONE') {
        // NONE invalidates nothing at all, so even a maximally-sensitive receipt survives —
        // correctly, because by definition nothing changed.
        expect(decision.reusable, `NONE should preserve everything`).toBe(true);
      } else {
        expect(decision.reusable, `unrecognised receipt was reused under ${d}`).toBe(false);
      }
    }
  });

  it('says WHY it refused, naming the invocation', () => {
    const d = reuseDecision(withBase('mystery-step'), 'DISJOINT_METADATA');
    expect(d.reason.length).toBeGreaterThan(20);
    expect(tagsForInvocation('mystery-step').why).toContain('mystery-step');
  });
});

describe('reuseDecision', () => {
  it('a formatter receipt survives even a policy stop', () => {
    // candidate-only is invalidated by nothing; this is the whole point of the tag.
    expect(reuseDecision(withBase('format:check'), 'POLICY_OR_WORKFLOW').reusable).toBe(true);
  });

  it('an integration receipt dies on unrelated documentation drift', () => {
    // Counter-intuitive but correct: docs drift moves the merge result, and integration
    // evidence is merge-sensitive.
    expect(reuseDecision(withBase('integration:suite'), 'DISJOINT_METADATA').reusable).toBe(false);
  });

  it('a typecheck receipt survives docs drift but not a dependency change', () => {
    expect(reuseDecision(withBase('typecheck:all'), 'DISJOINT_METADATA').reusable).toBe(true);
    expect(reuseDecision(withBase('typecheck:all'), 'DEPENDENCY').reusable).toBe(false);
  });

  it('a receipt with NO base OID is never reusable, whatever its tags', () => {
    // Even candidate-only, which survives every drift class: without a recorded base,
    // "has the base drifted since" is unanswerable, and unanswerable must not mean yes.
    const noBase = { invocation: 'format:check' };
    for (const d of DRIFT_CLASSES) {
      expect(reuseDecision(noBase, d).reusable, `reused a baseless receipt under ${d}`).toBe(false);
    }
    expect(reuseDecision(noBase, 'NONE').reason).toMatch(/no base OID/);
  });

  it('accepts mergeBaseOid when baseOid is absent', () => {
    const r = { invocation: 'format:check', base: { baseOid: null, mergeBaseOid: 'b'.repeat(40) } };
    expect(reuseDecision(r, 'NONE').reusable).toBe(true);
  });

  it('explains the decision in terms of the overlap, not just a verdict', () => {
    const d = reuseDecision(withBase('integration:suite'), 'SHARED_RUNTIME');
    expect(d.reason).toMatch(/merge-sensitive/);
    expect(d.reason).toMatch(/SHARED_RUNTIME/);
  });
});

describe('partitionReceipts', () => {
  const receipts = [
    withBase('format:check'),
    withBase('typecheck:all'),
    withBase('integration:suite'),
    withBase('brand-new-unclassified-step'),
  ];

  it('splits a real set correctly under documentation drift', () => {
    const p = partitionReceipts(receipts, 'DISJOINT_METADATA');
    expect(p.reusable.map((d) => d.invocation)).toEqual(['format:check', 'typecheck:all']);
    expect(p.mustReEarn.map((d) => d.invocation)).toEqual([
      'integration:suite',
      'brand-new-unclassified-step',
    ]);
  });

  it('reports unrecognised separately from mustReEarn, because the fixes differ', () => {
    // Both are conservative outcomes, but mustReEarn means the work really must run again,
    // while unrecognised means the pessimism is avoidable by classifying the invocation.
    const p = partitionReceipts(receipts, 'DISJOINT_METADATA');
    expect(p.unrecognised.map((d) => d.invocation)).toEqual(['brand-new-unclassified-step']);
    expect(p.mustReEarn.map((d) => d.invocation)).toContain('brand-new-unclassified-step');
  });

  it('under NONE everything is reusable — drift that changed nothing invalidates nothing', () => {
    const p = partitionReceipts(receipts, 'NONE');
    expect(p.mustReEarn).toEqual([]);
    expect(p.reusable).toHaveLength(receipts.length);
  });

  it('under UNKNOWN only candidate-only receipts survive', () => {
    const p = partitionReceipts(receipts, 'UNKNOWN');
    expect(p.reusable.map((d) => d.invocation)).toEqual(['format:check']);
  });

  it('an empty receipt set partitions to empty, not to a spurious pass', () => {
    const p = partitionReceipts([], 'POLICY_OR_WORKFLOW');
    expect(p.reusable).toEqual([]);
    expect(p.mustReEarn).toEqual([]);
    expect(p.unrecognised).toEqual([]);
  });
});
