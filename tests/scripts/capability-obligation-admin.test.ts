/**
 * capability-obligation-admin CLI — arg parsing, the schema guard (never
 * operate on a DB that isn't at the current schema), and dry-run vs --confirm
 * against a real file-backed SQLite instance.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityObligationStore } from '../../src/core/capability-obligation-store.ts';
import { Database } from '../../src/core/database.ts';
import { withTransaction } from '../../src/core/db-tx.ts';
import {
  parseAdminArgs,
  runCapabilityObligationAdmin,
  type AdminIo,
} from '../../scripts/capability-obligation-admin.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obl-admin-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedMigratedDbWithObligation(): { dbPath: string; id: number } {
  const dbPath = join(dir, 'instance.db');
  const db = new Database(dbPath);
  db.open();
  const store = new CapabilityObligationStore(db);
  let id = 0;
  withTransaction(db, () => {
    id = store.applyDecisionWithinCallerTransaction({
      auditEvent: { action: 'obligation.create', actorType: 'runtime', reasonCode: 'conclusive_no_effect' },
      obligation: {
        sourceInboundSeq: 7001,
        sourceMessageId: 'TESTMSG-CLI-1',
        conversationKey: 'conv-cli',
        deliveryJid: 'test-dm-cli@lid',
        senderJid: 'test-sender@s.whatsapp.net',
        senderName: 'Test Sender',
        isGroup: false,
        groupName: null,
        scope: 'per_chat',
        originRecoveryJobId: null,
        replayText: 'https://youtu.be/abc',
        contentTypeHint: 'text',
        contractVersion: 'test-contract/1',
        requiredCapability: 'child_process_tools',
        capabilityParams: '{"skill":"watch"}',
        inputDigest: 'aa'.repeat(32),
        sourceDigest: 'bb'.repeat(32),
        sourceToken: 'https://youtu.be/abc',
        retainedMedia: null,
        creationReason: 'harness_capability_gap',
      },
    }).obligationId!;
  });
  db.close();
  return { dbPath, id };
}

function captureIo(): { io: AdminIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

function stateOf(dbPath: string, id: number): string {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (raw.prepare('SELECT state FROM capability_obligations WHERE id=?').get(id) as { state: string }).state;
  } finally {
    raw.close();
  }
}

describe('parseAdminArgs', () => {
  it('rejects an unknown subcommand and a missing --db', () => {
    expect(() => parseAdminArgs(['frobnicate'])).toThrow(/inspect \| list \| cancel \| adjudicate/);
    expect(() => parseAdminArgs(['inspect', '--id', '1'])).toThrow(/--db/);
  });

  it('parses a confirm cancel with an idempotency key', () => {
    const args = parseAdminArgs(['cancel', '--db', '/x', '--id', '5', '--reason', 'r', '--run-id', 'run-1', '--idempotency-key', 'k', '--confirm']);
    expect(args).toMatchObject({ subcommand: 'cancel', dbPath: '/x', id: 5, reason: 'r', runId: 'run-1', idempotencyKey: 'k', confirm: true });
  });

  it('rejects a bad --action', () => {
    expect(() => parseAdminArgs(['adjudicate', '--db', '/x', '--action', 'explode'])).toThrow(/--action/);
  });
});

describe('schema guard', () => {
  it('refuses to operate on a database that is not at the current schema', () => {
    const dbPath = join(dir, 'stale.db');
    const raw = new DatabaseSync(dbPath);
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)');
    raw.exec('INSERT INTO schema_migrations (version, applied_at) VALUES (44, datetime(\'now\'))');
    raw.close();
    const { io } = captureIo();
    expect(() =>
      runCapabilityObligationAdmin(parseAdminArgs(['list', '--db', dbPath]), io),
    ).toThrow(/schema 44, expected 59/);
  });

  it('an absent schema_migrations table refuses cleanly as schema 0', () => {
    const dbPath = join(dir, 'empty.db');
    const raw = new DatabaseSync(dbPath);
    raw.exec('CREATE TABLE marker (x INTEGER)'); // valid sqlite, but no ledger
    raw.close();
    const { io } = captureIo();
    expect(() =>
      runCapabilityObligationAdmin(parseAdminArgs(['list', '--db', dbPath]), io),
    ).toThrow(/schema 0, expected 59/);
  });

  it('a non-schema read error (corrupt/locked DB) surfaces distinctly, NOT as schema 0', () => {
    const dbPath = join(dir, 'garbage.db');
    writeFileSync(dbPath, 'this is definitely not a sqlite database');
    const { io } = captureIo();
    // Must NOT be misdiagnosed as a stale schema — the operator needs to know
    // the read itself failed (e.g. the bot holds a lock), not "your DB is old".
    let message = '';
    try {
      runCapabilityObligationAdmin(parseAdminArgs(['list', '--db', dbPath]), io);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toMatch(/expected 59/);
    expect(message.length).toBeGreaterThan(0);
  });
});

describe('inspect / list / cancel', () => {
  it('inspects and lists an obligation as JSON', () => {
    const { dbPath, id } = seedMigratedDbWithObligation();
    const cap = captureIo();
    expect(runCapabilityObligationAdmin(parseAdminArgs(['inspect', '--db', dbPath, '--id', String(id), '--json']), cap.io)).toBe(0);
    const view = JSON.parse(cap.out[0]!) as { found: boolean; obligation: { state: string } };
    expect(view.found).toBe(true);
    expect(view.obligation.state).toBe('waiting_capability');

    const cap2 = captureIo();
    expect(runCapabilityObligationAdmin(parseAdminArgs(['list', '--db', dbPath, '--json']), cap2.io)).toBe(0);
    const list = JSON.parse(cap2.out[0]!) as { count: number; obligations: Array<{ id: number }> };
    expect(list.obligations.map((o) => o.id)).toContain(id);
  });

  it('DRY-RUN cancel previews without mutating; --confirm applies', () => {
    const { dbPath, id } = seedMigratedDbWithObligation();
    // dry-run
    const dry = captureIo();
    expect(runCapabilityObligationAdmin(
      parseAdminArgs(['cancel', '--db', dbPath, '--id', String(id), '--reason', 'op_retire', '--run-id', 'run-1', '--json']),
      dry.io,
    )).toBe(0);
    const dryResult = JSON.parse(dry.out[0]!) as { mode: string; wouldApply: boolean; applied: boolean };
    expect(dryResult).toMatchObject({ mode: 'dry-run', wouldApply: true, applied: false });
    expect(stateOf(dbPath, id)).toBe('waiting_capability'); // unchanged

    // confirm
    const conf = captureIo();
    expect(runCapabilityObligationAdmin(
      parseAdminArgs(['cancel', '--db', dbPath, '--id', String(id), '--reason', 'op_retire', '--run-id', 'run-1', '--json', '--confirm']),
      conf.io,
    )).toBe(0);
    const confResult = JSON.parse(conf.out[0]!) as { mode: string; applied: boolean; currentState: string };
    expect(confResult).toMatchObject({ mode: 'confirm', applied: true, currentState: 'cancelled' });
    expect(stateOf(dbPath, id)).toBe('cancelled');
  });

  it('exits non-zero when a mutation is refused (precondition mismatch)', () => {
    const { dbPath, id } = seedMigratedDbWithObligation();
    const cap = captureIo();
    const code = runCapabilityObligationAdmin(
      parseAdminArgs(['cancel', '--db', dbPath, '--id', String(id), '--reason', 'r', '--run-id', 'run-1', '--expect-state', 'blocked_ambiguous', '--confirm', '--json']),
      cap.io,
    );
    expect(code).toBe(1);
    expect(JSON.parse(cap.out[0]!)).toMatchObject({ refusedReason: 'precondition_mismatch' });
    expect(stateOf(dbPath, id)).toBe('waiting_capability');
  });
});
