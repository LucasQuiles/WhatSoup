import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { runMigration61 } from '../../src/core/database-migration-61.ts';
import {
  expireOverdueCompletedDeliveryIdentityAdmissions,
  IDENTITY_ADMISSION_EXPIRY_SECONDS,
} from '../../src/core/durability.ts';

/**
 * Reliability program 4.1 — bounded TERMINALIZATION of frozen
 * completed-delivery identity debt (mirrors the #2384 overdue-proposal sweep).
 *
 * Five bots sat permanently degraded because a quarantined identity-admission
 * clears only on operator action or a resolving fresh inbound — nothing ages
 * it out, so debt whose peer never writes again pins `degraded` forever
 * (ml-bot: unresolvedCount 11, oldest 4d, nextAction fresh_inbound). The fix
 * is NOT a silent age-out: an overdue admission moves to an explicit terminal
 * 'expired' state with a PRESERVED RECEIPT (the row keeps target, reason,
 * created_at, last_transition_at; expired_at stamps the terminalization), and
 * health carries DUAL counters — active/window (drives degraded, clears when
 * the condition genuinely clears) + monotonic lifetime (audit history).
 */

const DAY_S = 86_400;

function legacyAdmissionTable(raw: DatabaseSync): void {
  // The migration-54 shape (CHECK admits only quarantined|resolved).
  raw.exec(`
    CREATE TABLE completed_delivery_identity_admissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_kind TEXT NOT NULL
        CHECK (target_kind IN ('checkpoint', 'agent_session')),
      target_id INTEGER NOT NULL
        CHECK (typeof(target_id) = 'integer' AND target_id > 0),
      state TEXT NOT NULL DEFAULT 'quarantined'
        CHECK (state IN ('quarantined', 'resolved')),
      reason TEXT NOT NULL
        CHECK (reason IN ('missing', 'invalid', 'scope_mismatch')),
      attempts INTEGER NOT NULL DEFAULT 1
        CHECK (typeof(attempts) = 'integer' AND attempts = 1),
      owner TEXT NOT NULL DEFAULT 'fresh_inbound'
        CHECK (owner IN ('fresh_inbound', 'operator')),
      next_action TEXT NOT NULL DEFAULT 'fresh_inbound'
        CHECK (next_action IN ('fresh_inbound', 'operator')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_transition_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      CHECK (
        (state = 'quarantined' AND resolved_at IS NULL)
        OR (state = 'resolved' AND resolved_at IS NOT NULL)
      )
    );
    CREATE INDEX idx_completed_delivery_identity_admissions_open_transition
      ON completed_delivery_identity_admissions(state, last_transition_at)
      WHERE state = 'quarantined';
    CREATE UNIQUE INDEX idx_completed_delivery_identity_admissions_one_open_target
      ON completed_delivery_identity_admissions(target_kind, target_id)
      WHERE state = 'quarantined';
  `);
}

function insertQuarantined(raw: DatabaseSync, targetId: number, transitionAgoSeconds: number): void {
  raw.prepare(`
    INSERT INTO completed_delivery_identity_admissions
      (target_kind, target_id, state, reason, last_transition_at)
    VALUES ('checkpoint', ?, 'quarantined', 'missing', datetime('now', ?))
  `).run(targetId, `-${transitionAgoSeconds} seconds`);
}

describe('migration 61 — expired terminal state for identity admissions', () => {
  it('rebuilds the legacy table preserving rows, admits expired, and is idempotent', () => {
    const raw = new DatabaseSync(':memory:');
    legacyAdmissionTable(raw);
    insertQuarantined(raw, 101, 10 * DAY_S);
    raw.prepare(`
      INSERT INTO completed_delivery_identity_admissions
        (target_kind, target_id, state, reason, resolved_at)
      VALUES ('agent_session', 202, 'resolved', 'invalid', datetime('now'))
    `).run();

    runMigration61(raw);
    runMigration61(raw); // idempotent — a second run must be a no-op

    const rows = raw.prepare(
      'SELECT target_id, state, expired_at FROM completed_delivery_identity_admissions ORDER BY target_id',
    ).all() as Array<{ target_id: number; state: string; expired_at: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ target_id: 101, state: 'quarantined', expired_at: null });
    expect(rows[1]).toMatchObject({ target_id: 202, state: 'resolved' });

    // the rebuilt CHECK admits the terminal state (with its consistency rule)
    raw.prepare(`
      UPDATE completed_delivery_identity_admissions
      SET state = 'expired', expired_at = datetime('now')
      WHERE target_id = 101
    `).run();
    const expired = raw.prepare(
      "SELECT expired_at FROM completed_delivery_identity_admissions WHERE target_id = 101",
    ).get() as { expired_at: string | null };
    expect(expired.expired_at).not.toBeNull();

    // partial unique index still guards one OPEN row per target: a fresh
    // quarantined row for the expired target must be admissible again.
    insertQuarantined(raw, 101, 0);

    // expired without expired_at is rejected (receipt stamp is mandatory)
    expect(() => raw.prepare(`
      UPDATE completed_delivery_identity_admissions
      SET state = 'expired', expired_at = NULL
      WHERE target_id = 202
    `).run()).toThrow();
    raw.close();
  });
});

describe('expireOverdueCompletedDeliveryIdentityAdmissions (the #2384 mirror)', () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'identity-terminalization-'));
    db = new Database(join(dir, 'bot.db'));
    db.open();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('terminalizes only rows older than the bound, preserving the receipt', () => {
    insertQuarantined(db.raw, 1, 10 * DAY_S); // overdue → expires
    insertQuarantined(db.raw, 2, 1 * DAY_S);  // fresh → stays

    const result = expireOverdueCompletedDeliveryIdentityAdmissions(db.raw, IDENTITY_ADMISSION_EXPIRY_SECONDS);
    expect(result.expired).toBe(1);

    const rows = db.raw.prepare(`
      SELECT target_id, state, reason, created_at, last_transition_at, expired_at
      FROM completed_delivery_identity_admissions ORDER BY target_id
    `).all() as Array<Record<string, unknown>>;
    // receipt preserved: what was owed, why, and when — only the state moved
    expect(rows[0]).toMatchObject({ target_id: 1, state: 'expired', reason: 'missing' });
    expect(rows[0]!['expired_at']).not.toBeNull();
    expect(rows[0]!['created_at']).not.toBeNull();
    expect(rows[1]).toMatchObject({ target_id: 2, state: 'quarantined', expired_at: null });
  });

  it('is bounded, batched, and restartable (limit rows per call)', () => {
    for (let i = 1; i <= 5; i++) insertQuarantined(db.raw, i, 10 * DAY_S);
    expect(expireOverdueCompletedDeliveryIdentityAdmissions(db.raw, IDENTITY_ADMISSION_EXPIRY_SECONDS, 2).expired).toBe(2);
    expect(expireOverdueCompletedDeliveryIdentityAdmissions(db.raw, IDENTITY_ADMISSION_EXPIRY_SECONDS, 2).expired).toBe(2);
    expect(expireOverdueCompletedDeliveryIdentityAdmissions(db.raw, IDENTITY_ADMISSION_EXPIRY_SECONDS, 2).expired).toBe(1);
    expect(expireOverdueCompletedDeliveryIdentityAdmissions(db.raw, IDENTITY_ADMISSION_EXPIRY_SECONDS, 2).expired).toBe(0);
  });

  it('never touches resolved rows', () => {
    db.raw.prepare(`
      INSERT INTO completed_delivery_identity_admissions
        (target_kind, target_id, state, reason, resolved_at, last_transition_at)
      VALUES ('checkpoint', 7, 'resolved', 'missing', datetime('now'), datetime('now', '-30 days'))
    `).run();
    expect(expireOverdueCompletedDeliveryIdentityAdmissions(db.raw, IDENTITY_ADMISSION_EXPIRY_SECONDS).expired).toBe(0);
  });
});

describe('dual counters — active drives health, lifetime preserves audit', () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'identity-dual-counter-'));
    db = new Database(join(dir, 'bot.db'));
    db.open();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('unresolvedCount clears on terminalization while expiredCount records lifetime debt', async () => {
    const { DurabilityEngine } = await import('../../src/core/durability.ts');
    const durability = new DurabilityEngine(db);
    insertQuarantined(db.raw, 11, 10 * DAY_S);
    insertQuarantined(db.raw, 12, 10 * DAY_S);

    const before = durability.getCompletedDeliveryIdentityAdmissionHealth();
    expect(before.unresolvedCount).toBe(2);
    expect(before.expiredCount).toBe(0);

    expireOverdueCompletedDeliveryIdentityAdmissions(db.raw, IDENTITY_ADMISSION_EXPIRY_SECONDS);

    const after = durability.getCompletedDeliveryIdentityAdmissionHealth();
    // the permanent-degraded floor lifts…
    expect(after.unresolvedCount).toBe(0);
    expect(after.nextAction).toBeNull();
    // …and the lifetime record remains (the debt is auditable, not erased)
    expect(after.expiredCount).toBe(2);
  });
});
