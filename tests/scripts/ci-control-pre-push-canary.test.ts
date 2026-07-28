import { describe, expect, it } from 'vitest';

import {
  evaluatePrePushExactRefSetReportOnlyCanary,
  refPolicyObservationDigest,
  type PrePushExactRefSetInputObservationV1,
} from '../../scripts/lib/ci-control/pre-push-canary.ts';
import {
  ZERO_OID,
  evaluateOutgoingRefPolicy,
  normalizeRemoteIdentity,
  parsePrePushInput,
  type OutgoingRefPolicyV1,
  type RefGraphFactV1,
  type RefPolicyReceiptV1,
  type RefUpdateV1,
} from '../../scripts/lib/ci-control/ref-policy.ts';
import {
  digestControlManifest,
  loadControlManifest,
} from '../../scripts/lib/ci-control/manifest.ts';

const A = 'a111111111111111111111111111111111111111';
const B = 'b222222222222222222222222222222222222222';
const C = 'c333333333333333333333333333333333333333';
const DIGEST = `sha256:${'d'.repeat(64)}`;
const manifest = loadControlManifest(process.cwd());
const policy: OutgoingRefPolicyV1 = manifest.outgoingRefPolicy!;
const MANIFEST_DIGEST = digestControlManifest(manifest);

const remote = normalizeRemoteIdentity('origin', ['git', 'github.com:LucasQuiles/WhatSoup.git'].join('@'));

function graph(localRefOid: string | null, overrides: Partial<RefGraphFactV1> = {}): RefGraphFactV1 {
  return {
    objectFormat: 'sha1',
    toolDigest: DIGEST,
    localObjectType: localRefOid === null ? 'unavailable' : 'commit',
    relation: 'fast-forward',
    peeledCommitOid: null,
    trustedBaseAncestor: true,
    localRefOid,
    remoteObjectAvailable: true,
    ...overrides,
  };
}

function receiptFor(
  updates: readonly RefUpdateV1[],
  facts: readonly RefGraphFactV1[],
): RefPolicyReceiptV1 {
  return evaluateOutgoingRefPolicy(policy, remote, updates, facts, MANIFEST_DIGEST, new Date('2026-07-21T12:00:00.000Z'));
}

function observationsFor(
  updates: readonly RefUpdateV1[],
  receipt: RefPolicyReceiptV1,
): PrePushExactRefSetInputObservationV1[] {
  return updates.map((update, updateIndex) => ({
    updateIndex,
    update: structuredClone(update),
    refPolicyObservationDigest: refPolicyObservationDigest(receipt.observations[updateIndex]),
    refPolicyReceiptDigest: receipt.evidenceDigest,
  }));
}

function evaluateCanary(
  updates: unknown,
  receipt: unknown,
  observations: unknown,
  resolveLocalRef: (localRef: string) => string | null,
) {
  return evaluatePrePushExactRefSetReportOnlyCanary(
    updates,
    receipt,
    observations,
    manifest,
    resolveLocalRef,
  );
}

describe('report-only exact pre-push ref-set canary', () => {
  it('caps a validated safe exact set at inconclusive without transport authority', () => {
    const updates = parsePrePushInput(Buffer.from(`refs/heads/topic ${B} refs/heads/topic ${A}\n`));
    const receipt = receiptFor(updates, [graph(B)]);
    const resolverCalls: string[] = [];

    const result = evaluateCanary(
      updates,
      receipt,
      observationsFor(updates, receipt),
      (localRef) => {
        resolverCalls.push(localRef);
        return B;
      },
    );

    expect(result).toEqual({
      authorization: 'report-only',
      outcome: 'inconclusive',
      exitCode: 2,
      code: 'ci.refs.transport-authority-unavailable',
      refPolicyReceiptDigest: receipt.evidenceDigest,
      updateCount: 1,
      revalidatedLocalRefCount: 1,
      limitationCodes: [
        'ci.refs.report-only',
        'ci.refs.private-binding-unavailable',
      ],
    });
    expect(resolverCalls).toEqual(['refs/heads/topic']);
    expect(JSON.stringify(result)).not.toContain('refs/heads/topic');
    expect(JSON.stringify(result)).not.toContain(A);
    expect(JSON.stringify(result)).not.toContain(B);
  });

  it('preserves validated deterministic block and inconclusive native causes with exact exits', () => {
    const updates = parsePrePushInput(Buffer.from(`refs/heads/topic ${B} refs/heads/topic ${A}\n`));
    const blocked = receiptFor(updates, [graph(B, { relation: 'non-fast-forward' })]);
    const unavailable = receiptFor(updates, [graph(B, { relation: 'unavailable' })]);

    expect(evaluateCanary(
      updates, blocked, observationsFor(updates, blocked), () => B,
    )).toMatchObject({ outcome: 'block', exitCode: 1, code: 'ci.refs.force-update-prohibited' });
    expect(evaluateCanary(
      updates, unavailable, observationsFor(updates, unavailable), () => B,
    )).toMatchObject({ outcome: 'inconclusive', exitCode: 2, code: 'ci.refs.graph-unavailable' });
  });

  it('accepts an exact ordered multi-ref set and revalidates every non-delete ref', () => {
    const updates = parsePrePushInput(Buffer.from([
      `refs/heads/one ${B} refs/heads/one ${A}`,
      `refs/heads/two ${C} refs/heads/two ${A}`,
      '',
    ].join('\n')));
    const receipt = receiptFor(updates, [graph(B), graph(C)]);
    const observed = new Map([['refs/heads/one', B], ['refs/heads/two', C]]);

    expect(evaluateCanary(
      updates, receipt, observationsFor(updates, receipt), (ref) => observed.get(ref) ?? null,
    )).toMatchObject({
      outcome: 'inconclusive', exitCode: 2, code: 'ci.refs.transport-authority-unavailable',
      updateCount: 2, revalidatedLocalRefCount: 2,
    });
  });

  it.each([
    ['dropped', (rows: PrePushExactRefSetInputObservationV1[]) => rows.slice(0, 1)],
    ['duplicated', (rows: PrePushExactRefSetInputObservationV1[]) => [rows[0]!, rows[0]!]],
    ['reordered', (rows: PrePushExactRefSetInputObservationV1[]) => [rows[1]!, rows[0]!]],
    ['ref substituted', (rows: PrePushExactRefSetInputObservationV1[]) => rows.map((row, index) => index === 0
      ? { ...row, update: { ...row.update, remoteRef: 'refs/heads/substitute' } }
      : row)],
    ['policy observation digest substituted', (rows: PrePushExactRefSetInputObservationV1[]) => rows.map((row, index) => index === 0
      ? { ...row, refPolicyObservationDigest: `sha256:${'0'.repeat(64)}` }
      : row)],
    ['receipt digest substituted', (rows: PrePushExactRefSetInputObservationV1[]) => rows.map((row, index) => index === 0
      ? { ...row, refPolicyReceiptDigest: `sha256:${'0'.repeat(64)}` }
      : row)],
  ])('rejects an exact-set %s before resolving local refs', (_name, mutate) => {
    const updates = parsePrePushInput(Buffer.from([
      `refs/heads/one ${B} refs/heads/one ${A}`,
      `refs/heads/two ${C} refs/heads/two ${A}`,
      '',
    ].join('\n')));
    const receipt = receiptFor(updates, [graph(B), graph(C)]);
    let resolverCalls = 0;

    expect(evaluateCanary(
      updates,
      receipt,
      mutate(observationsFor(updates, receipt)),
      () => {
        resolverCalls += 1;
        return B;
      },
    )).toMatchObject({ outcome: 'inconclusive', exitCode: 2, code: 'ci.refs.exact-set-mismatch', revalidatedLocalRefCount: 0 });
    expect(resolverCalls).toBe(0);
  });

  it.each([
    ['moved', () => A],
    ['missing', () => null],
    ['invalid', () => 'not-an-oid'],
    ['throwing', () => { throw new Error('private ref lookup failure'); }],
  ])('rejects a %s local ref without leaking resolver details', (_name, resolver) => {
    const rawRef = 'refs/heads/private-topic';
    const updates = parsePrePushInput(Buffer.from(`${rawRef} ${B} ${rawRef} ${A}\n`));
    const receipt = receiptFor(updates, [graph(B)]);
    const result = evaluateCanary(
      updates, receipt, observationsFor(updates, receipt), resolver,
    );

    expect(result).toMatchObject({ outcome: 'inconclusive', exitCode: 2, code: 'ci.refs.local-ref-moved', revalidatedLocalRefCount: 0 });
    expect(JSON.stringify(result)).not.toContain(rawRef);
    expect(JSON.stringify(result)).not.toContain('private ref lookup failure');
  });

  it('does not resolve deletion rows and preserves their deterministic block', () => {
    const updates = parsePrePushInput(Buffer.from(`(delete) ${ZERO_OID} refs/heads/main ${A}\n`));
    const receipt = receiptFor(updates, [graph(null)]);
    let resolverCalls = 0;
    const result = evaluateCanary(
      updates, receipt, observationsFor(updates, receipt), () => {
        resolverCalls += 1;
        return null;
      },
    );

    expect(result).toMatchObject({ outcome: 'block', exitCode: 1, code: 'ci.refs.delete-prohibited', revalidatedLocalRefCount: 0 });
    expect(resolverCalls).toBe(0);
  });

  it('fails closed on an invalid receipt before resolver use', () => {
    const updates = parsePrePushInput(Buffer.from(`refs/heads/topic ${B} refs/heads/topic ${A}\n`));
    const receipt = receiptFor(updates, [graph(B)]);
    const invalid = { ...receipt, evidenceDigest: `sha256:${'0'.repeat(64)}` };
    let resolverCalls = 0;

    expect(evaluateCanary(
      updates, invalid, observationsFor(updates, receipt), () => {
        resolverCalls += 1;
        return B;
      },
    )).toMatchObject({ outcome: 'inconclusive', exitCode: 2, code: 'ci.refs.input-malformed', revalidatedLocalRefCount: 0 });
    expect(resolverCalls).toBe(0);
  });

  it('rejects a valid receipt whose observation belongs to a different exact update', () => {
    const branchUpdates = parsePrePushInput(Buffer.from(`refs/heads/different-target ${B} refs/heads/different-target ${A}\n`));
    const receiptUpdates = parsePrePushInput(Buffer.from(`refs/heads/receipt-source ${B} refs/heads/receipt-source ${A}\n`));
    const receipt = receiptFor(receiptUpdates, [graph(B, { relation: 'non-fast-forward' })]);

    expect(evaluateCanary(
      branchUpdates,
      receipt,
      observationsFor(branchUpdates, receipt),
      () => B,
    )).toMatchObject({
      outcome: 'inconclusive',
      exitCode: 2,
      code: 'ci.refs.exact-set-mismatch',
      revalidatedLocalRefCount: 0,
    });
  });

  it('requires the native same-process exact-ref binding instead of accepting a cloned public receipt', () => {
    const updates = parsePrePushInput(Buffer.from(`refs/heads/topic ${B} refs/heads/topic ${A}\n`));
    const receipt = receiptFor(updates, [graph(B)]);

    expect(evaluateCanary(
      updates,
      structuredClone(receipt),
      observationsFor(updates, receipt),
      () => B,
    )).toMatchObject({
      outcome: 'inconclusive', exitCode: 2, code: 'ci.refs.exact-set-mismatch', revalidatedLocalRefCount: 0,
    });
  });

  it('rejects mutated receipt bytes even when the original object retains its exact-ref identity', () => {
    const updates = parsePrePushInput(Buffer.from(`refs/heads/topic ${B} refs/heads/topic ${A}\n`));
    const passReceipt = receiptFor(updates, [graph(B)]);
    const blockReceipt = receiptFor(updates, [graph(B, { relation: 'non-fast-forward' })]);
    Object.assign(passReceipt, structuredClone(blockReceipt));
    let resolverCalls = 0;

    expect(evaluateCanary(
      updates,
      passReceipt,
      observationsFor(updates, blockReceipt),
      () => {
        resolverCalls += 1;
        return B;
      },
    )).toMatchObject({
      outcome: 'inconclusive', exitCode: 2, code: 'ci.refs.exact-set-mismatch', revalidatedLocalRefCount: 0,
    });
    expect(resolverCalls).toBe(0);
  });

  it('clones before validation so time-varying receipt accessors cannot forge a result', () => {
    const updates = parsePrePushInput(Buffer.from(`refs/heads/topic ${B} refs/heads/topic ${A}\n`));
    const receipt = receiptFor(updates, [graph(B)]);
    const inputObservations = observationsFor(updates, receipt);
    const deceptive = receipt as unknown as Record<string, unknown>;
    const original = {
      outcome: receipt.outcome,
      exitCode: receipt.exitCode,
      code: receipt.code,
      evidenceDigest: receipt.evidenceDigest,
    };
    let armed = false;
    let evidenceReads = 0;
    Object.defineProperties(deceptive, {
      outcome: { enumerable: true, get: () => armed ? 'block' : original.outcome },
      exitCode: { enumerable: true, get: () => armed ? 1 : original.exitCode },
      code: { enumerable: true, get: () => armed ? 'ci.refs.delete-prohibited' : original.code },
      evidenceDigest: {
        enumerable: true,
        get: () => {
          evidenceReads += 1;
          if (evidenceReads >= 2) armed = true;
          return original.evidenceDigest;
        },
      },
    });

    expect(evaluateCanary(
      updates,
      deceptive,
      inputObservations,
      () => B,
    )).toMatchObject({
      outcome: 'inconclusive', exitCode: 2, code: 'ci.refs.transport-authority-unavailable', revalidatedLocalRefCount: 1,
    });
  });

  it('derives its result from an immutable receipt snapshot across resolver callbacks', () => {
    const updates = parsePrePushInput(Buffer.from(`refs/heads/topic ${B} refs/heads/topic ${A}\n`));
    const receipt = receiptFor(updates, [graph(B)]);

    const result = evaluateCanary(
      updates,
      receipt,
      observationsFor(updates, receipt),
      () => {
        Object.assign(receipt, {
          outcome: 'block',
          exitCode: 1,
          code: 'ci.refs.delete-prohibited',
          evidenceDigest: `sha256:${'0'.repeat(64)}`,
        });
        return B;
      },
    );

    expect(result).toMatchObject({
      outcome: 'inconclusive',
      exitCode: 2,
      code: 'ci.refs.transport-authority-unavailable',
      refPolicyReceiptDigest: expect.not.stringMatching(/^sha256:0{64}$/u),
    });
  });

  it('revalidates an immutable exact-update snapshot across resolver callbacks', () => {
    const updates = parsePrePushInput(Buffer.from([
      `refs/heads/one ${B} refs/heads/one ${A}`,
      `refs/heads/two ${C} refs/heads/two ${A}`,
      '',
    ].join('\n')));
    const receipt = receiptFor(updates, [graph(B), graph(C)]);
    const resolvedRefs: string[] = [];

    const result = evaluateCanary(
      updates,
      receipt,
      observationsFor(updates, receipt),
      (localRef) => {
        resolvedRefs.push(localRef);
        if (resolvedRefs.length === 1) {
          updates[1]!.localRef = 'refs/heads/substituted';
          updates[1]!.localOid = B;
        }
        return localRef === 'refs/heads/one' ? B : C;
      },
    );

    expect(result).toMatchObject({
      outcome: 'inconclusive',
      exitCode: 2,
      code: 'ci.refs.transport-authority-unavailable',
      updateCount: 2,
      revalidatedLocalRefCount: 2,
    });
    expect(resolvedRefs).toEqual(['refs/heads/one', 'refs/heads/two']);
  });

  it.each([null, {}, 'not-an-array'])('fails closed on malformed runtime observation collection %j', (observations) => {
    const updates = parsePrePushInput(Buffer.from(`refs/heads/topic ${B} refs/heads/topic ${A}\n`));
    const receipt = receiptFor(updates, [graph(B)]);

    expect(evaluateCanary(
      updates,
      receipt,
      observations as never,
      () => B,
    )).toMatchObject({ outcome: 'inconclusive', exitCode: 2, code: 'ci.refs.exact-set-mismatch' });
  });

  it.each([null, {}, 'not-an-array'])('fails closed on malformed runtime update collection %j', (updates) => {
    const validUpdates = parsePrePushInput(Buffer.from(`refs/heads/topic ${B} refs/heads/topic ${A}\n`));
    const receipt = receiptFor(validUpdates, [graph(B)]);

    expect(evaluateCanary(
      updates,
      receipt,
      observationsFor(validUpdates, receipt),
      () => B,
    )).toMatchObject({ outcome: 'inconclusive', exitCode: 2, code: 'ci.refs.exact-set-mismatch', revalidatedLocalRefCount: 0 });
  });

  it('rejects a structurally valid manifest whose digest does not bind the receipt policy', () => {
    const updates = parsePrePushInput(Buffer.from(`refs/heads/topic ${B} refs/heads/topic ${A}\n`));
    const receipt = receiptFor(updates, [graph(B)]);
    const changedManifest = structuredClone(manifest);
    changedManifest.outgoingRefPolicy!.releaseBranches = ['refs/heads/release'];

    expect(evaluatePrePushExactRefSetReportOnlyCanary(
      updates,
      receipt,
      observationsFor(updates, receipt),
      changedManifest,
      () => B,
    )).toMatchObject({ outcome: 'inconclusive', exitCode: 2, code: 'ci.refs.exact-set-mismatch', revalidatedLocalRefCount: 0 });
  });

  it('returns deeply frozen output without mutating its inputs', () => {
    const updates = parsePrePushInput(Buffer.from(`refs/heads/topic ${B} refs/heads/topic ${A}\n`));
    const receipt = receiptFor(updates, [graph(B)]);
    const inputObservations = observationsFor(updates, receipt);
    const before = structuredClone({ updates, receipt, inputObservations });
    const result = evaluateCanary(updates, receipt, inputObservations, () => B);

    expect({ updates, receipt, inputObservations }).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.limitationCodes)).toBe(true);
    expect(() => (result.limitationCodes as string[]).push('ci.refs.pass')).toThrow();
    expect(() => Object.assign(result, { exitCode: 0 })).toThrow();
  });
});
