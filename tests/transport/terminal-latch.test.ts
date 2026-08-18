import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, statSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseTerminalLatch,
  parseLatchTransition,
  readTerminalLatchJournal,
  appendLatchTransition,
  decideRestoreFromCandidate,
  terminalLatchJournalPath,
  type TerminalLatchV1,
  type LatchTransitionV1,
  type LatchJournalState,
} from '../../src/transport/terminal-latch.ts';
import {
  parseAccountScopeId,
  type AuthGenerationReceiptV2,
  type BackupCandidateManifestV2,
} from '../../src/transport/auth-custody-contracts.ts';

const SCOPE = parseAccountScopeId('scope:line-a-wa')!;
const REVOKED_DIGEST = 'd'.repeat(64);
const FRESH_DIGEST = 'e'.repeat(64);

const LATCH: TerminalLatchV1 = {
  v: 1,
  scopeId: SCOPE,
  latchedGenerationId: null,
  latchedCredentialTreeDigest: REVOKED_DIGEST,
  reason: 'serverside_logout_irreversible',
  evidenceDigest: 'f'.repeat(64),
  latchedAt: '2026-08-18T12:00:00.000Z',
};

function createdTransition(overrides: Partial<LatchTransitionV1> = {}): LatchTransitionV1 {
  const revision = overrides.revision ?? 1;
  return {
    v: 1,
    scopeId: SCOPE,
    kind: 'latch_created',
    revision,
    expectedPriorRevision: revision - 1,
    at: '2026-08-18T12:00:00.000Z',
    operationId: `latch-op-${revision}`,
    ownerAuthorizationId: null,
    latch: LATCH,
    supersededByGenerationId: null,
    ...overrides,
  };
}

const NEWER_RECEIPT: AuthGenerationReceiptV2 = {
  v: 2,
  scopeId: SCOPE,
  generationId: 'gen-new-aa11bb22cc33',
  operationId: 'op-fresh-01',
  credentialTreeDigest: FRESH_DIGEST,
  createdAt: '2026-08-18T15:00:00.000Z',
  persistedAt: '2026-08-18T15:00:01.000Z',
  effectiveClient: null,
  actorOperationId: null,
  advisoryAuthRootHash: null,
};

const NEWER_MANIFEST: BackupCandidateManifestV2 = {
  v: 2,
  snapshotId: 'snap-fresh-01',
  sourceGenerationId: 'gen-new-aa11bb22cc33',
  credentialTreeDigest: FRESH_DIGEST,
  snapshotAt: '2026-08-18T15:10:00.000Z',
  inventoryDigest: '1'.repeat(64),
};

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'terminal-latch-test-'));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

describe('parseTerminalLatch / parseLatchTransition', () => {
  it('accepts the golden latch and rejects unknown keys and versions', () => {
    expect(parseTerminalLatch({ ...LATCH })).toEqual(LATCH);
    expect(parseTerminalLatch({ ...LATCH, v: 2 })).toBeNull();
    expect(parseTerminalLatch({ ...LATCH, extra: true })).toBeNull();
  });

  it('rejects a latch with an unknown reason or malformed digests', () => {
    expect(parseTerminalLatch({ ...LATCH, reason: 'because' })).toBeNull();
    expect(parseTerminalLatch({ ...LATCH, latchedCredentialTreeDigest: 'short' })).toBeNull();
    expect(parseTerminalLatch({ ...LATCH, evidenceDigest: 'Z'.repeat(64) })).toBeNull();
  });

  it('enforces kind-specific payload invariants on transitions', () => {
    expect(parseLatchTransition(createdTransition())).toEqual(createdTransition());
    expect(parseLatchTransition(createdTransition({ latch: null }))).toBeNull();
    expect(
      parseLatchTransition(createdTransition({ ownerAuthorizationId: 'auth-1' })),
    ).toBeNull();
    expect(
      parseLatchTransition(createdTransition({ supersededByGenerationId: 'gen-x' })),
    ).toBeNull();
    expect(
      parseLatchTransition({
        ...createdTransition({ kind: 'owner_released', revision: 2, expectedPriorRevision: 1 }),
        latch: null,
        ownerAuthorizationId: null,
      }),
    ).toBeNull();
    expect(
      parseLatchTransition({
        ...createdTransition({ kind: 'generation_superseded', revision: 2, expectedPriorRevision: 1 }),
        latch: null,
        supersededByGenerationId: null,
      }),
    ).toBeNull();
  });

  it('rejects a transition whose revision is not expectedPriorRevision + 1', () => {
    expect(
      parseLatchTransition(createdTransition({ revision: 3, expectedPriorRevision: 0 })),
    ).toBeNull();
  });

  it('rejects a transition without an operation id', () => {
    const { operationId: _drop, ...rest } = createdTransition();
    expect(parseLatchTransition(rest)).toBeNull();
    expect(parseLatchTransition(createdTransition({ operationId: '' }))).toBeNull();
  });
});

describe('readTerminalLatchJournal', () => {
  it('reports missing when no journal exists', () => {
    expect(readTerminalLatchJournal(stateRoot)).toEqual({ status: 'missing', revision: 0 });
  });

  it('folds created → active, superseded, released, and re-created', () => {
    expect(appendLatchTransition(stateRoot, createdTransition()).ok).toBe(true);
    let state = readTerminalLatchJournal(stateRoot);
    expect(state).toEqual({ status: 'active', revision: 1, latch: LATCH });

    const released = {
      ...createdTransition({ kind: 'owner_released', revision: 2, expectedPriorRevision: 1 }),
      latch: null,
      ownerAuthorizationId: 'owner-auth-0001',
    };
    expect(appendLatchTransition(stateRoot, released).ok).toBe(true);
    state = readTerminalLatchJournal(stateRoot);
    expect(state).toEqual({
      status: 'released',
      revision: 2,
      latch: LATCH,
      ownerAuthorizationId: 'owner-auth-0001',
    });

    const recreated = createdTransition({ revision: 3, expectedPriorRevision: 2 });
    expect(appendLatchTransition(stateRoot, recreated).ok).toBe(true);
    state = readTerminalLatchJournal(stateRoot);
    expect(state).toEqual({ status: 'active', revision: 3, latch: LATCH });

    const superseded = {
      ...createdTransition({ kind: 'generation_superseded', revision: 4, expectedPriorRevision: 3 }),
      latch: null,
      supersededByGenerationId: 'gen-new-aa11bb22cc33',
    };
    expect(appendLatchTransition(stateRoot, superseded).ok).toBe(true);
    state = readTerminalLatchJournal(stateRoot);
    expect(state).toEqual({
      status: 'superseded',
      revision: 4,
      latch: LATCH,
      supersededByGenerationId: 'gen-new-aa11bb22cc33',
    });
  });

  it('fails closed on a garbage line without destroying the journal bytes', () => {
    appendLatchTransition(stateRoot, createdTransition());
    const path = terminalLatchJournalPath(stateRoot);
    const before = readFileSync(path, 'utf-8');
    appendFileSync(path, 'not json\n');
    expect(readTerminalLatchJournal(stateRoot)).toEqual({ status: 'corrupt' });
    expect(readFileSync(path, 'utf-8')).toBe(before + 'not json\n');
  });

  it('fails closed on a truncated (partial JSON, unterminated) last line', () => {
    appendLatchTransition(stateRoot, createdTransition());
    appendFileSync(terminalLatchJournalPath(stateRoot), '{"v":1,"scopeId":');
    expect(readTerminalLatchJournal(stateRoot)).toEqual({ status: 'corrupt' });
  });

  it('fails closed on a revision gap and on a cross-version row', () => {
    appendLatchTransition(stateRoot, createdTransition());
    const gap = {
      ...createdTransition({ kind: 'owner_released', revision: 5, expectedPriorRevision: 4 }),
      latch: null,
      ownerAuthorizationId: 'owner-auth-0001',
    };
    appendFileSync(terminalLatchJournalPath(stateRoot), JSON.stringify(gap) + '\n');
    expect(readTerminalLatchJournal(stateRoot)).toEqual({ status: 'corrupt' });

    const other = mkdtempSync(join(tmpdir(), 'terminal-latch-v2-'));
    try {
      writeFileSync(
        terminalLatchJournalPath(other),
        JSON.stringify({ ...createdTransition(), v: 2 }) + '\n',
        { mode: 0o600 },
      );
      expect(readTerminalLatchJournal(other)).toEqual({ status: 'corrupt' });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('fails closed when the first transition is not latch_created', () => {
    const released = {
      ...createdTransition({ kind: 'owner_released' }),
      latch: null,
      ownerAuthorizationId: 'owner-auth-0001',
    };
    writeFileSync(terminalLatchJournalPath(stateRoot), JSON.stringify(released) + '\n', {
      mode: 0o600,
    });
    expect(readTerminalLatchJournal(stateRoot)).toEqual({ status: 'corrupt' });
  });
});

describe('appendLatchTransition', () => {
  it('writes the journal with private permissions', () => {
    expect(appendLatchTransition(stateRoot, createdTransition()).ok).toBe(true);
    const mode = statSync(terminalLatchJournalPath(stateRoot)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('refuses a payload that does not parse', () => {
    expect(appendLatchTransition(stateRoot, { nope: true })).toEqual({
      ok: false,
      refusal: 'invalid_payload',
    });
    expect(readTerminalLatchJournal(stateRoot)).toEqual({ status: 'missing', revision: 0 });
  });

  it('refuses a stale expectedPriorRevision (CAS) and leaves the journal unchanged', () => {
    expect(appendLatchTransition(stateRoot, createdTransition()).ok).toBe(true);
    const before = readFileSync(terminalLatchJournalPath(stateRoot), 'utf-8');
    // ABA: a second writer re-submits against the revision it read earlier.
    expect(appendLatchTransition(stateRoot, createdTransition())).toEqual({
      ok: false,
      refusal: 'revision_conflict',
    });
    expect(readFileSync(terminalLatchJournalPath(stateRoot), 'utf-8')).toBe(before);
  });

  it('refuses releasing or superseding when no latch is active', () => {
    const released = {
      ...createdTransition({ kind: 'owner_released' }),
      latch: null,
      ownerAuthorizationId: 'owner-auth-0001',
    };
    expect(appendLatchTransition(stateRoot, released)).toEqual({
      ok: false,
      refusal: 'invalid_transition',
    });
  });

  it('refuses creating a latch over an already-active latch', () => {
    expect(appendLatchTransition(stateRoot, createdTransition()).ok).toBe(true);
    const again = createdTransition({ revision: 2, expectedPriorRevision: 1 });
    expect(appendLatchTransition(stateRoot, again)).toEqual({
      ok: false,
      refusal: 'invalid_transition',
    });
  });

  it('refuses to append onto a corrupt journal and preserves the bytes', () => {
    writeFileSync(terminalLatchJournalPath(stateRoot), 'garbage\n', { mode: 0o600 });
    expect(appendLatchTransition(stateRoot, createdTransition())).toEqual({
      ok: false,
      refusal: 'journal_corrupt',
    });
    expect(readFileSync(terminalLatchJournalPath(stateRoot), 'utf-8')).toBe('garbage\n');
  });

  it('refuses while another writer holds the journal lock', () => {
    const fd = openSync(`${terminalLatchJournalPath(stateRoot)}.lock`, 'wx');
    try {
      expect(appendLatchTransition(stateRoot, createdTransition())).toEqual({
        ok: false,
        refusal: 'journal_lock_held',
      });
    } finally {
      closeSync(fd);
    }
  });

  it('refuses replaying an operation id that already appended (single-use)', () => {
    expect(appendLatchTransition(stateRoot, createdTransition()).ok).toBe(true);
    const released = {
      ...createdTransition({ kind: 'owner_released', revision: 2, expectedPriorRevision: 1 }),
      operationId: 'latch-op-1',
      latch: null,
      ownerAuthorizationId: 'owner-auth-0001',
    };
    expect(appendLatchTransition(stateRoot, released)).toEqual({
      ok: false,
      refusal: 'operation_replayed',
    });
  });

  it('refuses a transition whose scope does not match the active latch scope', () => {
    expect(appendLatchTransition(stateRoot, createdTransition()).ok).toBe(true);
    const otherScope = parseAccountScopeId('scope:line-b-wa')!;
    const released = {
      ...createdTransition({ kind: 'owner_released', revision: 2, expectedPriorRevision: 1 }),
      scopeId: otherScope,
      latch: null,
      ownerAuthorizationId: 'owner-auth-0001',
    };
    expect(appendLatchTransition(stateRoot, released)).toEqual({
      ok: false,
      refusal: 'invalid_transition',
    });
  });
});

describe('decideRestoreFromCandidate', () => {
  function activeState(): LatchJournalState {
    appendLatchTransition(stateRoot, createdTransition());
    return readTerminalLatchJournal(stateRoot);
  }

  const boundCandidate = {
    manifest: NEWER_MANIFEST,
    generationReceipt: NEWER_RECEIPT,
    observedTreeDigest: FRESH_DIGEST,
  } as const;

  it('allows when no latch was ever recorded', () => {
    expect(
      decideRestoreFromCandidate({ status: 'missing', revision: 0 }, boundCandidate),
    ).toEqual({ allow: true, basis: 'no_latch_recorded' });
  });

  it('allows after owner release or generation supersession (latch not active)', () => {
    const released: LatchJournalState = {
      status: 'released',
      revision: 2,
      latch: LATCH,
      ownerAuthorizationId: 'owner-auth-0001',
    };
    expect(decideRestoreFromCandidate(released, boundCandidate)).toEqual({
      allow: true,
      basis: 'latch_not_active',
    });
    const superseded: LatchJournalState = {
      status: 'superseded',
      revision: 2,
      latch: LATCH,
      supersededByGenerationId: 'gen-new-aa11bb22cc33',
    };
    expect(decideRestoreFromCandidate(superseded, boundCandidate)).toEqual({
      allow: true,
      basis: 'latch_not_active',
    });
  });

  it('refuses everything when the latch state is corrupt', () => {
    expect(decideRestoreFromCandidate({ status: 'corrupt' }, boundCandidate)).toEqual({
      allow: false,
      refusal: 'latch_state_corrupt',
    });
  });

  it('allows a fully bound, strictly newer, digest-matching candidate', () => {
    expect(decideRestoreFromCandidate(activeState(), boundCandidate)).toEqual({
      allow: true,
      basis: 'candidate_bound_newer_generation',
    });
  });

  it('refuses an unbound legacy candidate while the latch is active', () => {
    expect(
      decideRestoreFromCandidate(activeState(), { ...boundCandidate, manifest: 'missing' }),
    ).toEqual({ allow: false, refusal: 'latch_active_unbound_candidate' });
    expect(
      decideRestoreFromCandidate(activeState(), {
        ...boundCandidate,
        generationReceipt: 'missing',
      }),
    ).toEqual({ allow: false, refusal: 'latch_active_unbound_candidate' });
  });

  it('refuses corrupt candidate evidence without falling through to allow', () => {
    expect(
      decideRestoreFromCandidate(activeState(), { ...boundCandidate, manifest: 'corrupt' }),
    ).toEqual({ allow: false, refusal: 'candidate_manifest_corrupt' });
    expect(
      decideRestoreFromCandidate(activeState(), {
        ...boundCandidate,
        generationReceipt: 'corrupt',
      }),
    ).toEqual({ allow: false, refusal: 'generation_receipt_corrupt' });
  });

  it('refuses when a newer global receipt is offered for an older backup (binding break)', () => {
    // The manifest still names the OLD generation; the receipt is the newer
    // global one. Exact candidate binding must refuse — this is the exact
    // "newer global receipt cannot authorize an older backup" rule.
    const oldManifest: BackupCandidateManifestV2 = {
      ...NEWER_MANIFEST,
      snapshotId: 'snap-old-01',
      sourceGenerationId: 'gen-old-000000000000',
      credentialTreeDigest: REVOKED_DIGEST,
    };
    expect(
      decideRestoreFromCandidate(activeState(), {
        manifest: oldManifest,
        generationReceipt: NEWER_RECEIPT,
        observedTreeDigest: REVOKED_DIGEST,
      }),
    ).toEqual({ allow: false, refusal: 'latch_active_unbound_candidate' });
  });

  it('refuses the exact revoked candidate (digest matches the latched digest)', () => {
    const revokedManifest: BackupCandidateManifestV2 = {
      ...NEWER_MANIFEST,
      credentialTreeDigest: REVOKED_DIGEST,
    };
    const revokedReceipt: AuthGenerationReceiptV2 = {
      ...NEWER_RECEIPT,
      credentialTreeDigest: REVOKED_DIGEST,
    };
    expect(
      decideRestoreFromCandidate(activeState(), {
        manifest: revokedManifest,
        generationReceipt: revokedReceipt,
        observedTreeDigest: REVOKED_DIGEST,
      }),
    ).toEqual({ allow: false, refusal: 'latch_active_matches_latched_digest' });
  });

  it('refuses when the observed bytes do not match the manifest digest', () => {
    expect(
      decideRestoreFromCandidate(activeState(), {
        ...boundCandidate,
        observedTreeDigest: '9'.repeat(64),
      }),
    ).toEqual({ allow: false, refusal: 'latch_active_digest_mismatch' });
    expect(
      decideRestoreFromCandidate(activeState(), { ...boundCandidate, observedTreeDigest: null }),
    ).toEqual({ allow: false, refusal: 'latch_active_digest_mismatch' });
  });

  it('refuses a candidate that is not strictly newer than the latch', () => {
    const olderReceipt: AuthGenerationReceiptV2 = {
      ...NEWER_RECEIPT,
      createdAt: '2026-08-18T11:59:59.000Z',
      persistedAt: '2026-08-18T11:59:59.500Z',
    };
    expect(
      decideRestoreFromCandidate(activeState(), {
        ...boundCandidate,
        generationReceipt: olderReceipt,
      }),
    ).toEqual({ allow: false, refusal: 'latch_active_candidate_not_newer' });
    const equalReceipt: AuthGenerationReceiptV2 = {
      ...NEWER_RECEIPT,
      createdAt: LATCH.latchedAt,
    };
    expect(
      decideRestoreFromCandidate(activeState(), {
        ...boundCandidate,
        generationReceipt: equalReceipt,
      }),
    ).toEqual({ allow: false, refusal: 'latch_active_candidate_not_newer' });
  });

  it('refuses a candidate claiming the latched generation id', () => {
    const latchWithGen: TerminalLatchV1 = { ...LATCH, latchedGenerationId: 'gen-dead-01' };
    appendLatchTransition(stateRoot, createdTransition({ latch: latchWithGen }));
    const state = readTerminalLatchJournal(stateRoot);
    const sameGenReceipt: AuthGenerationReceiptV2 = {
      ...NEWER_RECEIPT,
      generationId: 'gen-dead-01',
    };
    const sameGenManifest: BackupCandidateManifestV2 = {
      ...NEWER_MANIFEST,
      sourceGenerationId: 'gen-dead-01',
    };
    expect(
      decideRestoreFromCandidate(state, {
        manifest: sameGenManifest,
        generationReceipt: sameGenReceipt,
        observedTreeDigest: FRESH_DIGEST,
      }),
    ).toEqual({ allow: false, refusal: 'latch_active_candidate_not_newer' });
  });

  it('is total and never allows through a corrupt or ambiguous combination', () => {
    const latchStates: LatchJournalState[] = [
      { status: 'missing', revision: 0 },
      { status: 'corrupt' },
      { status: 'active', revision: 1, latch: LATCH },
      { status: 'released', revision: 2, latch: LATCH, ownerAuthorizationId: 'owner-auth-0001' },
    ];
    const manifests = [NEWER_MANIFEST, 'missing', 'corrupt'] as const;
    const receipts = [NEWER_RECEIPT, 'missing', 'corrupt'] as const;
    const digests = [FRESH_DIGEST, '9'.repeat(64), null] as const;
    for (const latchState of latchStates) {
      for (const manifest of manifests) {
        for (const generationReceipt of receipts) {
          for (const observedTreeDigest of digests) {
            const decision = decideRestoreFromCandidate(latchState, {
              manifest,
              generationReceipt,
              observedTreeDigest,
            });
            expect(typeof decision.allow).toBe('boolean');
            const anyCorrupt =
              latchState.status === 'corrupt' || manifest === 'corrupt' || generationReceipt === 'corrupt';
            if (anyCorrupt) {
              expect(decision.allow).toBe(false);
            }
            if (latchState.status === 'active' && decision.allow) {
              expect(decision).toEqual({
                allow: true,
                basis: 'candidate_bound_newer_generation',
              });
              expect(manifest).toEqual(NEWER_MANIFEST);
              expect(generationReceipt).toEqual(NEWER_RECEIPT);
              expect(observedTreeDigest).toBe(FRESH_DIGEST);
            }
          }
        }
      }
    }
  });
});
