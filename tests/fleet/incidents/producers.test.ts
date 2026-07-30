import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openIncidentDb } from '../../../src/fleet/incidents/db.ts';
import { ProducerStore } from '../../../src/fleet/incidents/producers.ts';

let dir: string;
let db: ReturnType<typeof openIncidentDb>;
let store: ProducerStore;

const NOW = new Date('2026-07-28T12:00:00.000Z');

function registration(overrides: Record<string, unknown> = {}) {
  return {
    producerId: 'prod-selfcheck-alpha',
    producerDomainId: 'dom-selfcheck',
    allowedKinds: ['heartbeat_observed', 'condition_observed', 'condition_recovered'] as const,
    allowedConditionClasses: ['selfcheck_drift'],
    allowedSubjects: ['host:alpha'],
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whatsoup-producers-'));
  db = openIncidentDb(join(dir, 'incidents.db'));
  store = new ProducerStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function enroll(): { credential: string } {
  const reg = store.register(registration(), NOW);
  if (!reg.ok) throw new Error('setup: registration failed');
  const ex = store.exchangeEnrollmentSecret('prod-selfcheck-alpha', reg.enrollmentSecret, NOW);
  if (!ex.ok) throw new Error('setup: exchange failed');
  return { credential: ex.credential };
}

describe('ProducerStore', () => {
  it('registers a producer and the minted secret exchanges for a working credential', () => {
    const reg = store.register(registration(), NOW);
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    const ex = store.exchangeEnrollmentSecret('prod-selfcheck-alpha', reg.enrollmentSecret, NOW);
    expect(ex.ok).toBe(true);
    if (!ex.ok) return;

    const producer = store.authenticate(ex.credential, NOW);
    expect(producer?.producerId).toBe('prod-selfcheck-alpha');
    expect(producer?.allowedSubjects).toEqual(['host:alpha']);
  });

  it('rejects re-registration of an existing producerId', () => {
    store.register(registration(), NOW);
    const again = store.register(registration(), NOW);
    expect(again).toEqual({ ok: false, reason: 'producer_exists' });
  });

  it('enrollment secrets are single-use', () => {
    const reg = store.register(registration(), NOW);
    if (!reg.ok) throw new Error('setup failed');
    const first = store.exchangeEnrollmentSecret('prod-selfcheck-alpha', reg.enrollmentSecret, NOW);
    expect(first.ok).toBe(true);
    const second = store.exchangeEnrollmentSecret('prod-selfcheck-alpha', reg.enrollmentSecret, NOW);
    expect(second.ok).toBe(false);
  });

  it('enrollment secrets expire (default 10 minutes)', () => {
    const reg = store.register(registration(), NOW);
    if (!reg.ok) throw new Error('setup failed');
    const late = new Date(NOW.getTime() + 11 * 60_000);
    expect(store.exchangeEnrollmentSecret('prod-selfcheck-alpha', reg.enrollmentSecret, late).ok).toBe(false);
  });

  it('clamps the enrollment ttl to the 30-minute hard maximum', () => {
    const reg = store.register(registration({ enrollmentTtlMs: 120 * 60_000 }), NOW);
    if (!reg.ok) throw new Error('setup failed');
    const at31 = new Date(NOW.getTime() + 31 * 60_000);
    expect(store.exchangeEnrollmentSecret('prod-selfcheck-alpha', reg.enrollmentSecret, at31).ok).toBe(false);
  });

  it('a wrong secret does not burn the real one, but three mismatches do', () => {
    const reg = store.register(registration(), NOW);
    if (!reg.ok) throw new Error('setup failed');
    expect(store.exchangeEnrollmentSecret('prod-selfcheck-alpha', 'nope-1', NOW).ok).toBe(false);
    expect(store.exchangeEnrollmentSecret('prod-selfcheck-alpha', reg.enrollmentSecret, NOW).ok).toBe(true);

    const reg2 = store.register(
      registration({ producerId: 'prod-selfcheck-beta', allowedSubjects: ['host:beta'] }),
      NOW,
    );
    if (!reg2.ok) throw new Error('setup failed');
    for (const guess of ['a', 'b', 'c']) {
      expect(store.exchangeEnrollmentSecret('prod-selfcheck-beta', guess, NOW).ok).toBe(false);
    }
    expect(store.exchangeEnrollmentSecret('prod-selfcheck-beta', reg2.enrollmentSecret, NOW).ok).toBe(false);
  });

  it('rotation issues a new credential and honors the overlap window for the old one', () => {
    const { credential } = enroll();
    const rotated = store.rotateCredential('prod-selfcheck-alpha', credential, NOW);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    const withinOverlap = new Date(NOW.getTime() + 60_000);
    expect(store.authenticate(rotated.credential, withinOverlap)?.producerId).toBe('prod-selfcheck-alpha');
    expect(store.authenticate(credential, withinOverlap)?.producerId).toBe('prod-selfcheck-alpha');

    const afterOverlap = new Date(NOW.getTime() + 25 * 60 * 60_000);
    expect(store.authenticate(credential, afterOverlap)).toBeNull();
    expect(store.authenticate(rotated.credential, afterOverlap)?.producerId).toBe('prod-selfcheck-alpha');
  });

  it('revocation kills both live and overlap credentials', () => {
    const { credential } = enroll();
    const rotated = store.rotateCredential('prod-selfcheck-alpha', credential, NOW);
    if (!rotated.ok) throw new Error('setup failed');
    expect(store.revoke('prod-selfcheck-alpha')).toBe(true);
    expect(store.authenticate(credential, NOW)).toBeNull();
    expect(store.authenticate(rotated.credential, NOW)).toBeNull();
  });

  it('authenticate returns uniform null across failure modes', () => {
    const { credential } = enroll();
    expect(store.authenticate('sha256-shaped-but-wrong', NOW)).toBeNull();
    expect(store.authenticate('', NOW)).toBeNull();
    const expired = new Date(NOW.getTime() + 366 * 24 * 60 * 60_000);
    expect(store.authenticate(credential, expired)).toBeNull();
  });

  it('rejects non-positive, fractional, and non-finite enrollment TTLs as invalid_input', () => {
    const bad = [-5, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
    for (const ttl of bad) {
      const result = store.register(
        registration({ producerId: `prod-ttl-${String(ttl)}`, enrollmentTtlMs: ttl }),
        NOW,
      );
      expect(result).toEqual({ ok: false, reason: 'invalid_input' });
    }
  });

  it('rotation overlap never extends beyond the old credential expiry', () => {
    const shortDb = openIncidentDb(join(dir, 'short-ttl.db'));
    const shortLived = new ProducerStore(shortDb, {
      credentialTtlMs: 60 * 60_000,
    });
    const reg = shortLived.register(registration(), NOW);
    if (!reg.ok) throw new Error('setup: registration failed');
    const ex = shortLived.exchangeEnrollmentSecret('prod-selfcheck-alpha', reg.enrollmentSecret, NOW);
    if (!ex.ok) throw new Error('setup: exchange failed');
    const oldCredentialExpiry = Date.parse(ex.credentialExpiresAt);

    const rotatedAt = new Date(NOW.getTime() + 30 * 60_000);
    const rotated = shortLived.rotateCredential('prod-selfcheck-alpha', ex.credential, rotatedAt);
    expect(rotated.ok).toBe(true);

    // Before the OLD credential's original expiry: overlap valid.
    const beforeOldExpiry = new Date(oldCredentialExpiry - 60_000);
    expect(shortLived.authenticate(ex.credential, beforeOldExpiry)).not.toBeNull();
    // After the old expiry: the 24h default overlap must NOT extend the
    // retired credential past its own lifetime.
    const afterOldExpiry = new Date(oldCredentialExpiry + 60_000);
    expect(shortLived.authenticate(ex.credential, afterOldExpiry)).toBeNull();
    shortDb.close();
  });

  it('exchange failures carry a closed internal reason vocabulary', () => {
    expect(store.exchangeEnrollmentSecret('prod-unknown', 'whatever', NOW)).toEqual({
      ok: false,
      reason: 'no_active_enrollment',
    });

    const reg = store.register(registration(), NOW);
    if (!reg.ok) throw new Error('setup: registration failed');

    const lateBy11Min = new Date(NOW.getTime() + 11 * 60_000);
    expect(store.exchangeEnrollmentSecret('prod-selfcheck-alpha', reg.enrollmentSecret, lateBy11Min)).toEqual({
      ok: false,
      reason: 'enrollment_expired',
    });

    const reg2 = store.register(registration({ producerId: 'prod-reasons' }), NOW);
    if (!reg2.ok) throw new Error('setup: registration failed');
    expect(store.exchangeEnrollmentSecret('prod-reasons', 'wrong-secret', NOW)).toEqual({
      ok: false,
      reason: 'secret_mismatch',
    });
    expect(store.exchangeEnrollmentSecret('prod-reasons', 'wrong-secret', NOW)).toEqual({
      ok: false,
      reason: 'secret_mismatch',
    });
    expect(store.exchangeEnrollmentSecret('prod-reasons', 'wrong-secret', NOW)).toEqual({
      ok: false,
      reason: 'enrollment_burned',
    });
    expect(store.exchangeEnrollmentSecret('prod-reasons', reg2.enrollmentSecret, NOW)).toEqual({
      ok: false,
      reason: 'no_active_enrollment',
    });
  });

  it('authorize enforces kind, condition-class, and subject scopes', () => {
    const { credential } = enroll();
    const producer = store.authenticate(credential, NOW);
    if (!producer) throw new Error('setup failed');

    expect(store.authorize(producer, { kind: 'heartbeat_observed', subject: 'host:alpha' })).toBeNull();
    expect(
      store.authorize(producer, {
        kind: 'condition_observed',
        conditionClass: 'selfcheck_drift',
        subject: 'host:alpha',
      }),
    ).toBeNull();
    expect(store.authorize(producer, { kind: 'notice_recorded', subject: 'host:alpha' })).toBe('kind_not_allowed');
    expect(
      store.authorize(producer, {
        kind: 'condition_observed',
        conditionClass: 'other_class',
        subject: 'host:alpha',
      }),
    ).toBe('condition_class_not_allowed');
    expect(store.authorize(producer, { kind: 'heartbeat_observed', subject: 'host:beta' })).toBe('subject_not_allowed');
  });
});
