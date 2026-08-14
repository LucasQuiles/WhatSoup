/**
 * capability-obligation-drain-now (round-22 AE1 trigger): the operator CLI is
 * dry-run by default, schema-guarded, and its --confirm writes EXACTLY one
 * drop-file request that the live runtime's scan services. The CLI's gate
 * previews are ADVISORY — the runtime re-checks everything — but they must
 * mirror the runtime's refusals so an operator cannot drop a request that is
 * certain to be refused.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityObligationStore } from '../../src/core/capability-obligation-store.ts';
import { Database } from '../../src/core/database.ts';
import { withTransaction } from '../../src/core/db-tx.ts';
import {
  drainNowRequestSchema,
} from '../../src/runtimes/agent/capability-obligation-drain-now-service.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { parseDrainNowArgs, runDrainNowCli } from '../../scripts/capability-obligation-drain-now.ts';

const CLI_PATH = fileURLToPath(new URL('../../scripts/capability-obligation-drain-now.ts', import.meta.url));
const tmp = trackTmpDirs('drain-now-cli-', { base: realpathSync(tmpdir()) });

const GROUP_JID = 'test-group-alpha@g.us';
const LIVE = {
  destinationJid: GROUP_JID, releaseSha: 'rel-live-1', manifestDigest: 'md-live-1',
  drainRunId: 'drain-run-live-1', attestationDigest: 'att-digest-live-1',
};

let dbFile: string;
let requestDir: string;

beforeEach(() => {
  const dir = tmp.make('db');
  dbFile = join(dir, 'bot.db');
  requestDir = join(dir, 'capability-drain-now');
});
afterEach(() => { /* trackTmpDirs cleans up */ });

function withFileDb<T>(fn: (db: Database, store: CapabilityObligationStore) => T): T {
  const db = new Database(dbFile);
  db.open();
  try {
    return fn(db, new CapabilityObligationStore(db));
  } finally {
    db.close();
  }
}

function seedObligation(over: Partial<Record<string, unknown>> = {}): number {
  return withFileDb((db, store) => {
    let id = 0;
    withTransaction(db, () => {
      id = store.applyDecisionWithinCallerTransaction({
        auditEvent: { action: 'obligation.create', actorType: 'runtime', reasonCode: 'conclusive_no_effect' },
        obligation: {
          sourceInboundSeq: (over.sourceInboundSeq as number) ?? 9101,
          sourceMessageId: (over.sourceMessageId as string) ?? 'TESTMSG-DRAINNOW-1',
          conversationKey: 'conv-drain-now', deliveryJid: (over.deliveryJid as string) ?? GROUP_JID,
          senderJid: 'test-sender@s.whatsapp.net', senderName: 'S',
          isGroup: (over.isGroup as boolean) ?? true, groupName: 'Test Group Alpha',
          scope: 'per_chat', originRecoveryJobId: null, replayText: 'https://youtu.be/abc',
          contentTypeHint: 'text', contractVersion: 'c/1', requiredCapability: 'child_process_tools',
          capabilityParams: '{"skill":"watch"}', inputDigest: 'ab'.repeat(32), sourceDigest: 'bb'.repeat(32),
          sourceToken: 'https://youtu.be/abc', retainedMedia: null, creationReason: 'typed_deferral_signal',
        },
      }).obligationId!;
    });
    return id;
  });
}

/** Arm a seeded GROUP obligation (waiting_approval → waiting_capability) with a live approval. */
function armGroup(id: number): number {
  return withFileDb((db, store) => {
    const approvalId = Number(
      db.raw
        .prepare(
          `INSERT INTO capability_drain_approvals
             (obligation_id, destination_jid, scope, release_sha, attestation_digest, manifest_digest, drain_run_id, approver, approved_at, expires_at)
           VALUES (?, ?, 'group', ?, ?, ?, ?, 'owner', datetime('now'), datetime('now','+1 hour'))`,
        )
        .run(id, LIVE.destinationJid, LIVE.releaseSha, LIVE.attestationDigest, LIVE.manifestDigest, LIVE.drainRunId)
        .lastInsertRowid,
    );
    expect(store.consumeGroupDrainApproval(id, LIVE).applied).toBe(true);
    return approvalId;
  });
}

describe('parseDrainNowArgs', () => {
  it('parses the full flag set', () => {
    expect(parseDrainNowArgs(['--db', '/x.db', '--obligation-id', '7', '--requested-by', 'op', '--json', '--confirm']))
      .toEqual({ dbPath: '/x.db', obligationId: 7, requestedBy: 'op', json: true, confirm: true });
  });
  it('rejects unknown flags, missing values, and bad ids', () => {
    expect(() => parseDrainNowArgs(['--nope'])).toThrow(/unknown flag/);
    expect(() => parseDrainNowArgs(['--db'])).toThrow(/requires a value/);
    expect(() => parseDrainNowArgs(['--db', '/x.db', '--requested-by', 'op'])).toThrow(/--obligation-id is required/);
    expect(() => parseDrainNowArgs(['--db', '/x.db', '--obligation-id', '0', '--requested-by', 'op'])).toThrow(/positive integer/);
    expect(() => parseDrainNowArgs(['--db', '/x.db', '--obligation-id', '2147483648', '--requested-by', 'op'])).toThrow(/out of range/);
  });
});

describe('runDrainNowCli', () => {
  it('dry-run previews a drainable DM and writes NOTHING', () => {
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm@lid' });
    const result = runDrainNowCli({ dbPath: dbFile, obligationId: id, requestedBy: 'op', json: false, confirm: false });
    expect(result).toMatchObject({
      ok: true, mode: 'dry-run',
      obligation: { state: 'waiting_capability', isGroup: false, deliveryJid: 'test-dm@lid' },
      requestPath: join(requestDir, `${id}.json`),
    });
    expect(existsSync(requestDir)).toBe(false); // FALSIFIER: dry-run creates nothing
  });

  it('--confirm writes exactly one schema-valid request file', () => {
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm@lid' });
    const result = runDrainNowCli({ dbPath: dbFile, obligationId: id, requestedBy: 'op', json: false, confirm: true });
    expect(result).toMatchObject({ ok: true, mode: 'confirm', requestPath: join(requestDir, `${id}.json`) });
    expect(readdirSync(requestDir)).toEqual([`${id}.json`]);
    const payload = drainNowRequestSchema.parse(JSON.parse(readFileSync(join(requestDir, `${id}.json`), 'utf8')));
    expect(payload.obligationId).toBe(id);
    expect(payload.requestedBy).toBe('op');
  });

  it('refuses a second pending request for the same obligation', () => {
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm@lid' });
    expect(runDrainNowCli({ dbPath: dbFile, obligationId: id, requestedBy: 'op', json: false, confirm: true }).ok).toBe(true);
    expect(() =>
      runDrainNowCli({ dbPath: dbFile, obligationId: id, requestedBy: 'op', json: false, confirm: true }),
    ).toThrow(/already exists/);
  });

  it('refuses an unknown obligation and a group still in waiting_approval', () => {
    const id = seedObligation(); // group, waiting_approval — also creates the DB file
    expect(runDrainNowCli({ dbPath: dbFile, obligationId: 9999, requestedBy: 'op', json: false, confirm: true }))
      .toMatchObject({ ok: false, reason: 'not_found' });
    const result = runDrainNowCli({ dbPath: dbFile, obligationId: id, requestedBy: 'op', json: false, confirm: true });
    expect(result).toMatchObject({ ok: false, reason: 'not_drainable', obligation: { state: 'waiting_approval' } });
    expect(existsSync(requestDir)).toBe(false);
  });

  it('mirrors the runtime group gate: a REVOKED approval refuses (advisory) and writes nothing', () => {
    const id = seedObligation();
    const approvalId = armGroup(id);
    withFileDb((db) => {
      db.raw.prepare("UPDATE capability_drain_approvals SET revoked_at = datetime('now') WHERE id = ?").run(approvalId);
    });
    const result = runDrainNowCli({ dbPath: dbFile, obligationId: id, requestedBy: 'op', json: false, confirm: true });
    expect(result).toMatchObject({
      ok: false, reason: 'group_approval_required',
      obligation: { state: 'waiting_capability', isGroup: true, groupApprovalLive: false },
    });
    expect(existsSync(requestDir)).toBe(false);
  });

  it('an ARMED group with a live approval is requestable', () => {
    const id = seedObligation();
    armGroup(id);
    const result = runDrainNowCli({ dbPath: dbFile, obligationId: id, requestedBy: 'op', json: false, confirm: true });
    expect(result).toMatchObject({ ok: true, obligation: { isGroup: true, groupApprovalLive: true } });
    expect(readdirSync(requestDir)).toEqual([`${id}.json`]);
  });
});

describe('drain-now CLI main block (subprocess)', () => {
  function runCli(extra: readonly string[]): ReturnType<typeof spawnSync> {
    return spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', CLI_PATH, ...extra],
      { encoding: 'utf8' },
    );
  }

  it('--confirm writes the request file through the real main block', () => {
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm@lid' });
    const result = runCli(['--db', dbFile, '--obligation-id', String(id), '--requested-by', 'op-subproc', '--confirm']);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/REQUESTED drain-now/);
    expect(readdirSync(requestDir)).toEqual([`${id}.json`]);
  }, 30_000);

  it('SCHEMA GUARD: refuses a database that is not at the current schema', () => {
    const dir = tmp.make('wrong-schema');
    const emptyDb = join(dir, 'empty.db');
    // A bare sqlite file with no schema_migrations table reads as version 0.
    const seed = spawnSync('sqlite3', [emptyDb, 'CREATE TABLE t (x);'], { encoding: 'utf8' });
    expect(seed.status).toBe(0);
    const result = runCli(['--db', emptyDb, '--obligation-id', '1', '--requested-by', 'op']);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/refusing to operate: database is at schema 0/);
  }, 30_000);
});
