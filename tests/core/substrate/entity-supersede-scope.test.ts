/**
 * QR-040: observation supersede must be ENTITY-SCOPED (defense in depth).
 *
 * Before the fix, getProfile's (and the activity feed's) supersede-exclusion
 * subquery was GLOBAL — a superseding observation belonging to ANY entity hid
 * the target — and captureObservation wrote a caller-supplied
 * supersedesObservationId with no check that the target belonged to the same
 * entity. So an observation captured under entity Y could supersede (and hide)
 * an observation belonging to a DIFFERENT entity Z, poisoning Z's profile.
 *
 * Two-layer fix verified here:
 *   - WRITE: captureObservation rejects a missing or cross-entity supersede target.
 *   - READ:  getProfile scopes the supersede NOT EXISTS to s.entity_id = o.entity_id,
 *            so even a forced cross-entity supersede row cannot hide an observation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { Database } from '../../../src/core/database.ts';
import { upsertEntity, captureObservation, getProfile } from '../../../src/core/substrate/entities.ts';

function tmpFile() { return join(tmpdir(), `qr040-${randomBytes(8).toString('hex')}.db`); }

describe('QR-040 — entity-scoped observation supersede', () => {
  let path: string; let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('WRITE: captureObservation REJECTS a supersedesObservationId belonging to a DIFFERENT entity', () => {
    const z = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Zoe' });
    const y = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Yan' });
    const zObs = captureObservation(db.raw, { entityRef: { entityId: z.id }, kind: 'contact_info', text: 'Z fact', confidence: 0.9, sourceKind: 'manual' });

    expect(() => captureObservation(db.raw, {
      entityRef: { entityId: y.id },
      kind: 'contact_info', text: 'poison', confidence: 0.95, sourceKind: 'manual',
      supersedesObservationId: zObs.id, // cross-entity target
    })).toThrow(/cross-entity supersede rejected/);

    // Z's observation is untouched and still visible.
    expect(getProfile(db.raw, { entityId: z.id })?.observations.map(o => o.id)).toEqual([zObs.id]);
  });

  it('WRITE: captureObservation REJECTS a supersedesObservationId that does not exist', () => {
    const e = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Eve' });
    expect(() => captureObservation(db.raw, {
      entityRef: { entityId: e.id },
      kind: 'contact_info', text: 'x', confidence: 0.9, sourceKind: 'manual',
      supersedesObservationId: 999999,
    })).toThrow(/not found/);
  });

  it('READ: getProfile IGNORES a forced cross-entity supersede row (read-scope defense in depth)', () => {
    const z = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Zed' });
    const y = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Yara' });
    const zObs = captureObservation(db.raw, { entityRef: { entityId: z.id }, kind: 'contact_info', text: 'Z fact', confidence: 0.9, sourceKind: 'manual' });

    // Force a cross-entity superseder row directly (bypassing the write-reject)
    // to prove the READ-side scoping independently protects Z's profile.
    db.raw.prepare(
      `INSERT INTO entity_observations (entity_id, kind, text, confidence, source_kind, supersedes_observation_id, created_at, metadata_json)
       VALUES (?, 'contact_info', 'forced poison', 0.99, 'manual', ?, ?, '{}')`
    ).run(y.id, zObs.id, Math.floor(Date.now() / 1000));

    // Z's observation must STILL be visible (the cross-entity superseder is ignored).
    expect(getProfile(db.raw, { entityId: z.id })?.observations.map(o => o.id)).toEqual([zObs.id]);
  });

  it('REGRESSION: a SAME-entity supersede still hides the superseded observation', () => {
    const e = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Ada' });
    const o1 = captureObservation(db.raw, { entityRef: { entityId: e.id }, kind: 'contact_info', text: 'lives in NYC', confidence: 0.9, sourceKind: 'manual' });
    const o2 = captureObservation(db.raw, { entityRef: { entityId: e.id }, kind: 'contact_info', text: 'lives in SF', confidence: 0.95, sourceKind: 'manual', supersedesObservationId: o1.id });
    expect(getProfile(db.raw, { entityId: e.id })?.observations.map(o => o.id)).toEqual([o2.id]);
  });
});
