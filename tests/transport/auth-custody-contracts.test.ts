import { describe, it, expect } from 'vitest';
import {
  parseAccountScopeId,
  parseCoordinationLease,
  parseAuthGenerationReceiptV2,
  parseBackupCandidateManifest,
  parsePairingOperation,
  isPairingStateTransitionAllowed,
  PAIRING_OPERATION_STATES,
} from '../../src/transport/auth-custody-contracts.ts';

// Golden fixtures. Every parser test derives from these via spread-and-override,
// so a fixture drift is caught in exactly one place.
const SCOPE = 'scope:line-a-wa';

const LEASE = {
  v: 1,
  scopeId: SCOPE,
  operationId: 'op-9f2c1b7a44',
  hostId: 'host-a',
  bootId: 'boot-1f9d8c7b6a5e4d3c',
  processBirthToken: 'birth-217651-1755500000',
  pid: 217651,
  acquiredAt: '2026-08-18T18:00:00.000Z',
  renewedAt: '2026-08-18T18:05:00.000Z',
  expiresAt: '2026-08-18T18:10:00.000Z',
  fencingToken: 7,
  mode: 'pairing',
} as const;

const GEN_RECEIPT = {
  v: 2,
  scopeId: SCOPE,
  generationId: 'gen-3aa1c2d9e8f7b6a5c4d3',
  operationId: 'op-9f2c1b7a44',
  credentialTreeDigest: 'a'.repeat(64),
  createdAt: '2026-08-18T19:00:00.000Z',
  persistedAt: '2026-08-18T19:00:01.000Z',
  effectiveClient: { packageVersion: '7.0.0-rc12', provenance: 'pinned' },
  actorOperationId: 'actor-op-1122',
  advisoryAuthRootHash: 'b'.repeat(40),
} as const;

const MANIFEST = {
  v: 2,
  snapshotId: 'snap-20260818T190500Z-01',
  sourceGenerationId: 'gen-3aa1c2d9e8f7b6a5c4d3',
  credentialTreeDigest: 'a'.repeat(64),
  snapshotAt: '2026-08-18T19:05:00.000Z',
  inventoryDigest: 'c'.repeat(64),
} as const;

const PAIRING_OP = {
  v: 1,
  idempotencyKey: 'idem-77aa88bb99cc',
  host: 'host-a',
  instance: 'line-a',
  scopeId: SCOPE,
  expectedCurrentGenerationId: null,
  method: 'pairing_code',
  authorizationId: 'auth-g4-0001',
  state: 'requested',
  fencingToken: 7,
  requestedAt: '2026-08-18T20:00:00.000Z',
  updatedAt: '2026-08-18T20:00:00.000Z',
  errorClass: null,
  resultGenerationId: null,
} as const;

describe('parseAccountScopeId', () => {
  it('accepts the canonical opaque configured form', () => {
    expect(parseAccountScopeId(SCOPE)).toBe(SCOPE);
  });

  it('rejects non-strings', () => {
    expect(parseAccountScopeId(42)).toBeNull();
    expect(parseAccountScopeId(null)).toBeNull();
    expect(parseAccountScopeId(undefined)).toBeNull();
    expect(parseAccountScopeId({})).toBeNull();
  });

  it('rejects a value without the scope: prefix', () => {
    expect(parseAccountScopeId('line-a-wa')).toBeNull();
  });

  it('rejects path-shaped values', () => {
    expect(parseAccountScopeId('scope:/var/lib/wa/auth')).toBeNull();
    expect(parseAccountScopeId('scope:instances/line-a/auth')).toBeNull();
  });

  it('rejects JID-shaped values', () => {
    expect(parseAccountScopeId('scope:15550001234@s.whatsapp.net')).toBeNull();
  });

  it('rejects phone-shaped values (digits-only tail and plus)', () => {
    expect(parseAccountScopeId('scope:+15550001234')).toBeNull();
    expect(parseAccountScopeId('scope:15550001234')).toBeNull();
  });

  it('rejects uppercase, empty tail, too-short and too-long tails', () => {
    expect(parseAccountScopeId('scope:Line-A')).toBeNull();
    expect(parseAccountScopeId('scope:')).toBeNull();
    expect(parseAccountScopeId('scope:abc')).toBeNull();
    expect(parseAccountScopeId(`scope:a${'b'.repeat(70)}`)).toBeNull();
  });
});

describe('parseCoordinationLease', () => {
  it('accepts the golden lease', () => {
    expect(parseCoordinationLease({ ...LEASE })).toEqual(LEASE);
  });

  it('rejects a missing key', () => {
    const { fencingToken: _drop, ...rest } = LEASE;
    expect(parseCoordinationLease(rest)).toBeNull();
  });

  it('rejects an unknown extra key', () => {
    expect(parseCoordinationLease({ ...LEASE, extra: 1 })).toBeNull();
  });

  it('rejects a wrong version', () => {
    expect(parseCoordinationLease({ ...LEASE, v: 2 })).toBeNull();
  });

  it('rejects boolean posing as an integer', () => {
    expect(parseCoordinationLease({ ...LEASE, pid: true })).toBeNull();
    expect(parseCoordinationLease({ ...LEASE, fencingToken: true })).toBeNull();
  });

  it('rejects non-positive pid and fencing token', () => {
    expect(parseCoordinationLease({ ...LEASE, pid: 0 })).toBeNull();
    expect(parseCoordinationLease({ ...LEASE, pid: -3 })).toBeNull();
    expect(parseCoordinationLease({ ...LEASE, fencingToken: 0 })).toBeNull();
  });

  it('rejects non-integer pid and fencing token', () => {
    expect(parseCoordinationLease({ ...LEASE, pid: 1.5 })).toBeNull();
    expect(parseCoordinationLease({ ...LEASE, fencingToken: 2.7 })).toBeNull();
  });

  it('rejects an unknown mode', () => {
    expect(parseCoordinationLease({ ...LEASE, mode: 'banana' })).toBeNull();
  });

  it('rejects unparseable timestamps', () => {
    expect(parseCoordinationLease({ ...LEASE, acquiredAt: '2026-13-45T00:00:00Z' })).toBeNull();
    expect(parseCoordinationLease({ ...LEASE, expiresAt: 'soon' })).toBeNull();
  });

  it('rejects renewedAt earlier than acquiredAt', () => {
    expect(
      parseCoordinationLease({ ...LEASE, renewedAt: '2026-08-18T17:59:59.000Z' }),
    ).toBeNull();
  });

  it('rejects expiresAt not after renewedAt', () => {
    expect(parseCoordinationLease({ ...LEASE, expiresAt: LEASE.renewedAt })).toBeNull();
  });

  it('rejects an invalid scope id inside the lease', () => {
    expect(parseCoordinationLease({ ...LEASE, scopeId: 'scope:+15551234567' })).toBeNull();
  });
});

describe('parseAuthGenerationReceiptV2', () => {
  it('accepts the golden receipt', () => {
    expect(parseAuthGenerationReceiptV2({ ...GEN_RECEIPT })).toEqual(GEN_RECEIPT);
  });

  it('accepts null effectiveClient and null actorOperationId', () => {
    const fixture = {
      ...GEN_RECEIPT,
      effectiveClient: null,
      actorOperationId: null,
      advisoryAuthRootHash: null,
    };
    expect(parseAuthGenerationReceiptV2(fixture)).toEqual(fixture);
  });

  it('rejects the v1 receipt shape (cross-version rejection)', () => {
    expect(parseAuthGenerationReceiptV2({ ...GEN_RECEIPT, v: 1 })).toBeNull();
  });

  it('rejects a missing credentialTreeDigest', () => {
    const { credentialTreeDigest: _drop, ...rest } = GEN_RECEIPT;
    expect(parseAuthGenerationReceiptV2(rest)).toBeNull();
  });

  it('rejects a digest that is not 64 lowercase hex chars', () => {
    expect(parseAuthGenerationReceiptV2({ ...GEN_RECEIPT, credentialTreeDigest: 'xyz' })).toBeNull();
    expect(
      parseAuthGenerationReceiptV2({ ...GEN_RECEIPT, credentialTreeDigest: 'A'.repeat(64) }),
    ).toBeNull();
  });

  it('rejects persistedAt earlier than createdAt', () => {
    expect(
      parseAuthGenerationReceiptV2({ ...GEN_RECEIPT, persistedAt: '2026-08-18T18:59:59.000Z' }),
    ).toBeNull();
  });

  it('rejects an unknown extra key', () => {
    expect(parseAuthGenerationReceiptV2({ ...GEN_RECEIPT, bondCreatedAt: 'x' })).toBeNull();
  });

  it('rejects an oversized effectiveClient subtree (bounded, never unbounded unknown)', () => {
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 600; i++) big[`k${i}`] = 'v'.repeat(20);
    expect(parseAuthGenerationReceiptV2({ ...GEN_RECEIPT, effectiveClient: big })).toBeNull();
  });

  it('rejects a too-deep effectiveClient subtree', () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    expect(parseAuthGenerationReceiptV2({ ...GEN_RECEIPT, effectiveClient: deep })).toBeNull();
  });

  it('rejects function-bearing effectiveClient values', () => {
    expect(
      parseAuthGenerationReceiptV2({ ...GEN_RECEIPT, effectiveClient: { f: () => 1 } }),
    ).toBeNull();
  });
});

describe('parseBackupCandidateManifest', () => {
  it('accepts the golden manifest', () => {
    expect(parseBackupCandidateManifest({ ...MANIFEST })).toEqual(MANIFEST);
  });

  it('rejects wrong version, missing key, extra key', () => {
    expect(parseBackupCandidateManifest({ ...MANIFEST, v: 1 })).toBeNull();
    const { inventoryDigest: _drop, ...rest } = MANIFEST;
    expect(parseBackupCandidateManifest(rest)).toBeNull();
    expect(parseBackupCandidateManifest({ ...MANIFEST, note: 'x' })).toBeNull();
  });

  it('rejects empty snapshot and generation ids', () => {
    expect(parseBackupCandidateManifest({ ...MANIFEST, snapshotId: '' })).toBeNull();
    expect(parseBackupCandidateManifest({ ...MANIFEST, sourceGenerationId: '' })).toBeNull();
  });

  it('rejects malformed digests and timestamps', () => {
    expect(parseBackupCandidateManifest({ ...MANIFEST, credentialTreeDigest: 'nope' })).toBeNull();
    expect(parseBackupCandidateManifest({ ...MANIFEST, inventoryDigest: '' })).toBeNull();
    expect(parseBackupCandidateManifest({ ...MANIFEST, snapshotAt: 'yesterday' })).toBeNull();
  });
});

describe('parsePairingOperation', () => {
  it('accepts the golden operation', () => {
    expect(parsePairingOperation({ ...PAIRING_OP })).toEqual(PAIRING_OP);
  });

  it('rejects unknown state, method, and error class', () => {
    expect(parsePairingOperation({ ...PAIRING_OP, state: 'done' })).toBeNull();
    expect(parsePairingOperation({ ...PAIRING_OP, method: 'nfc' })).toBeNull();
    expect(parsePairingOperation({ ...PAIRING_OP, errorClass: 'oops' })).toBeNull();
  });

  it('rejects an empty idempotency key, host, instance, or authorization id', () => {
    expect(parsePairingOperation({ ...PAIRING_OP, idempotencyKey: '' })).toBeNull();
    expect(parsePairingOperation({ ...PAIRING_OP, host: '' })).toBeNull();
    expect(parsePairingOperation({ ...PAIRING_OP, instance: '' })).toBeNull();
    expect(parsePairingOperation({ ...PAIRING_OP, authorizationId: '' })).toBeNull();
  });

  it('rejects updatedAt earlier than requestedAt', () => {
    expect(
      parsePairingOperation({ ...PAIRING_OP, updatedAt: '2026-08-18T19:59:59.000Z' }),
    ).toBeNull();
  });

  it('requires errorClass exactly when state is failed', () => {
    expect(
      parsePairingOperation({
        ...PAIRING_OP,
        state: 'failed',
        errorClass: null,
      }),
    ).toBeNull();
    expect(
      parsePairingOperation({
        ...PAIRING_OP,
        state: 'failed',
        errorClass: 'receipt_write_failed',
      }),
    ).not.toBeNull();
    expect(
      parsePairingOperation({ ...PAIRING_OP, state: 'requested', errorClass: 'unknown' }),
    ).toBeNull();
  });

  it('requires resultGenerationId exactly when state is activated', () => {
    expect(parsePairingOperation({ ...PAIRING_OP, state: 'activated' })).toBeNull();
    expect(
      parsePairingOperation({
        ...PAIRING_OP,
        state: 'activated',
        resultGenerationId: 'gen-new-1',
      }),
    ).not.toBeNull();
    expect(
      parsePairingOperation({ ...PAIRING_OP, resultGenerationId: 'gen-early' }),
    ).toBeNull();
  });
});

describe('isPairingStateTransitionAllowed', () => {
  it('allows the forward saga path', () => {
    const path = [
      'requested',
      'service_stopped',
      'lease_acquired',
      'quarantined',
      'pairing',
      'receipt_persisted',
      'activated',
    ] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(isPairingStateTransitionAllowed(path[i], path[i + 1])).toBe(true);
    }
  });

  it('allows failure and abort from every non-terminal state', () => {
    for (const from of PAIRING_OPERATION_STATES) {
      if (from === 'activated' || from === 'failed' || from === 'aborted') continue;
      expect(isPairingStateTransitionAllowed(from, 'failed')).toBe(true);
      expect(isPairingStateTransitionAllowed(from, 'aborted')).toBe(true);
    }
  });

  it('refuses skipping the quarantine step', () => {
    expect(isPairingStateTransitionAllowed('service_stopped', 'pairing')).toBe(false);
  });

  it('refuses activation without a persisted receipt', () => {
    expect(isPairingStateTransitionAllowed('pairing', 'activated')).toBe(false);
    expect(isPairingStateTransitionAllowed('quarantined', 'activated')).toBe(false);
  });

  it('refuses leaving terminal states', () => {
    for (const to of PAIRING_OPERATION_STATES) {
      expect(isPairingStateTransitionAllowed('activated', to)).toBe(false);
      expect(isPairingStateTransitionAllowed('failed', to)).toBe(false);
      expect(isPairingStateTransitionAllowed('aborted', to)).toBe(false);
    }
  });

  it('refuses backward motion', () => {
    expect(isPairingStateTransitionAllowed('pairing', 'service_stopped')).toBe(false);
    expect(isPairingStateTransitionAllowed('receipt_persisted', 'pairing')).toBe(false);
  });
});
