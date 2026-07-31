import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { OUTBOUND_FAILURE_EVIDENCE_CODES } from '../../src/core/outbound-failure-disposition.ts';

let tmpRoot = '';

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

type FixtureRow = {
  id: number;
  status?: string;
  error: string | null;
  disposition?: string;
  coverage?: string;
  waMessageId?: string;
};

function evidence(
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schema: 'whatsoup-outbound-failure-v1',
    failure_code: 'outbound.unsafe_delivery_unconfirmed',
    stage: 'runtime',
    mutation_state: 'ambiguous',
    retryable: false,
    retry_decision: 'stop',
    retry_not_before: null,
    retry_owner: 'none',
    attempt_budget_disposition: 'stop',
    logical_attempt_count: 1,
    provider_submission_count: 1,
    first_failure_at: '2026-07-30T00:00:00.000Z',
    last_failure_at: '2026-07-30T00:00:00.000Z',
    evidence_coverage: 'complete',
    ...overrides,
  });
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sqlString(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
}

function createDb(rows: FixtureRow[], filename = 'bot.db') {
  const db = join(tmpRoot, filename);
  const inserts = rows.map((row) => `
    INSERT INTO outbound_ops
      (id, conversation_key, chat_jid, op_type, payload, status, error, wa_message_id,
       replay_policy, is_terminal, quarantine_disposition, quarantine_evidence_coverage,
       quarantined_at)
    VALUES
      (${row.id}, 'conv', 'chat@g.us', 'text', '{"text":"unit"}',
       ${sqlString(row.status ?? 'quarantined')}, ${sqlString(row.error)},
       ${sqlString(row.waMessageId ?? `WA-${row.id}`)}, 'unsafe', 0,
       ${sqlString(row.disposition ?? 'delivery_ambiguous_unsafe')},
       ${sqlString(row.coverage ?? 'complete')}, datetime('now'));
  `).join('\n');
  const createResult = spawnSync('python3', ['-c', `
import sqlite3
con = sqlite3.connect(${JSON.stringify(db)})
con.executescript("""
CREATE TABLE outbound_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_key TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  op_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  echoed_at TEXT,
  wa_message_id TEXT,
  error TEXT,
  source_inbound_seq INTEGER,
  retry_count INTEGER DEFAULT 0,
  is_terminal INTEGER DEFAULT 0,
  replay_policy TEXT NOT NULL DEFAULT 'unsafe',
  quarantine_disposition TEXT NOT NULL DEFAULT 'legacy_unclassified',
  quarantine_evidence_coverage TEXT NOT NULL DEFAULT 'legacy_unclassified',
  quarantine_evidence_sha256 TEXT,
  quarantined_at TEXT
);
CREATE TABLE outbound_quarantine_retirements (
  outbound_op_id INTEGER PRIMARY KEY,
  quarantine_disposition TEXT NOT NULL,
  acknowledgement TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  retired_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (outbound_op_id) REFERENCES outbound_ops(id) ON DELETE CASCADE
);
${inserts}
""")
con.commit()
`], { encoding: 'utf8' });
  if (createResult.status !== 0) throw new Error(createResult.stderr);
  return db;
}

function runRetire(db: string, args: string[] = []) {
  return spawnSync('python3', [
    'deploy/scripts/retire-outbound-quarantine.py',
    '--db',
    db,
    '--op-id',
    '42',
    ...args,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, BOT_ERRORS_STATE_DIR: tmpRoot },
    encoding: 'utf8',
  });
}

function queryRow(db: string) {
  const result = spawnSync('sqlite3', [
    '-json',
    db,
    `select id, status, error, is_terminal, quarantine_disposition,
            quarantine_evidence_sha256
       from outbound_ops where id=42`,
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout)[0] as {
    id: number;
    status: string;
    error: string | null;
    is_terminal: number;
    quarantine_disposition: string;
    quarantine_evidence_sha256: string | null;
  };
}

function queryRetirement(db: string) {
  const result = spawnSync('sqlite3', [
    '-json',
    db,
    `SELECT outbound_op_id, quarantine_disposition, acknowledgement, evidence_sha256
       FROM outbound_quarantine_retirements
      WHERE outbound_op_id = 42`,
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout)[0] as {
    outbound_op_id: number;
    quarantine_disposition: string;
    acknowledgement: string;
    evidence_sha256: string;
  } | undefined;
}

function parseSuccess(result: ReturnType<typeof runRetire>): Record<string, unknown> {
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function scriptKnownFailureCodes(): string[] {
  const script = join(process.cwd(), 'deploy/scripts/retire-outbound-quarantine.py');
  const result = spawnSync('python3', ['-c', `
import json
import runpy
namespace = runpy.run_path(${JSON.stringify(script)})
print(json.dumps(sorted(namespace['KNOWN_FAILURE_CODES'])))
`], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout) as string[];
}

describe('retire-outbound-quarantine', () => {
  it('keeps CLI evidence-code validation in parity with the durable evidence contract', () => {
    expect(scriptKnownFailureCodes()).toEqual([...OUTBOUND_FAILURE_EVIDENCE_CODES].sort());
  });

  it('inspects only bounded metadata and never exposes stored evidence or message identifiers', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'retire-outbound-'));
    const stored = evidence();
    const db = createDb([{
      id: 42,
      error: stored,
      waMessageId: 'WA_PRIVATE_MARKER',
    }]);

    const result = runRetire(db);
    const output = parseSuccess(result);

    expect(output).toMatchObject({
      ok: true,
      schemaVersion: 1,
      action: 'inspect',
      op: {
        id: 42,
        status: 'quarantined',
        disposition: 'delivery_ambiguous_unsafe',
        evidenceSha256: digest(stored),
        evidenceDigestAvailable: true,
        eligibility: 'retirable',
        contributors: { total: 1, sameDisposition: 1 },
      },
      clear: { candidate: false, requiresRecoveryProof: true },
    });
    expect(result.stdout).not.toContain('WA_PRIVATE_MARKER');
    expect(result.stdout).not.toContain(stored);
    expect(queryRow(db)).toMatchObject({ status: 'quarantined', error: stored, is_terminal: 0 });
    expect(existsSync(join(tmpRoot, 'outbox'))).toBe(false);
  });

  it('requires an exact digest and bounded acknowledgement, preserves evidence, and never clears directly', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'retire-outbound-'));
    const stored = evidence();
    const db = createDb([{
      id: 42,
      error: stored,
      waMessageId: 'WA_PRIVATE_MARKER',
    }]);

    const output = parseSuccess(runRetire(db, [
      '--apply',
      '--confirm-op-id', '42',
      '--expected-disposition', 'delivery_ambiguous_unsafe',
      '--acknowledgement', 'delivery-risk-reviewed',
      '--expect-evidence-sha256', digest(stored),
    ]));

    expect(output).toMatchObject({
      ok: true,
      schemaVersion: 1,
      action: 'retired',
      op: {
        id: 42,
        disposition: 'delivery_ambiguous_unsafe',
        remainingQuarantined: 0,
      },
      backupCreated: true,
      clear: { candidate: false, requiresRecoveryProof: true },
    });
    expect(readdirSync(tmpRoot).some((name) => name.includes('.pre-outbound-quarantine-retire-')))
      .toBe(true);
    const backup = readdirSync(tmpRoot).find((name) => name.includes('.pre-outbound-quarantine-retire-'));
    expect(backup).toBeDefined();
    expect(statSync(join(tmpRoot, backup!)).mode & 0o777).toBe(0o600);
    expect(queryRow(db)).toMatchObject({
      status: 'failed_permanent',
      error: stored,
      is_terminal: 1,
      quarantine_disposition: 'delivery_ambiguous_unsafe',
      quarantine_evidence_sha256: digest(stored),
    });
    expect(queryRetirement(db)).toEqual({
      outbound_op_id: 42,
      quarantine_disposition: 'delivery_ambiguous_unsafe',
      acknowledgement: 'delivery-risk-reviewed',
      evidence_sha256: digest(stored),
    });
    expect(resultText(output)).not.toContain('WA_PRIVATE_MARKER');
    expect(existsSync(join(tmpRoot, 'outbox'))).toBe(false);
  });

  it('fails closed for malformed evidence without creating a backup or mutating the row', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'retire-outbound-'));
    const rawMarker = 'private malformed error marker';
    const db = createDb([{
      id: 42,
      error: rawMarker,
      disposition: 'legacy_unclassified',
      coverage: 'legacy_unclassified',
    }]);

    const result = runRetire(db, [
      '--apply',
      '--confirm-op-id', '42',
      '--expected-disposition', 'delivery_ambiguous_unsafe',
      '--acknowledgement', 'delivery-risk-reviewed',
      '--expect-evidence-sha256', digest(rawMarker),
    ]);

    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stderr)).toEqual({ ok: false, error: 'retirement_not_eligible' });
    expect(result.stderr).not.toContain(rawMarker);
    expect(queryRow(db)).toMatchObject({ status: 'quarantined', error: rawMarker, is_terminal: 0 });
    expect(readdirSync(tmpRoot).some((name) => name.includes('.pre-outbound-quarantine-retire-')))
      .toBe(false);
    expect(existsSync(join(tmpRoot, 'outbox'))).toBe(false);
  });

  it('reads and backs up the literal database path when its name contains URI metacharacters', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'retire-outbound-'));
    const stored = evidence();
    const db = createDb([{
      id: 42,
      error: stored,
    }], 'bot?#%.db');

    const output = parseSuccess(runRetire(db, [
      '--apply',
      '--confirm-op-id', '42',
      '--expected-disposition', 'delivery_ambiguous_unsafe',
      '--acknowledgement', 'delivery-risk-reviewed',
      '--expect-evidence-sha256', digest(stored),
    ]));

    expect(output).toMatchObject({ ok: true, action: 'retired' });
    expect(queryRow(db)).toMatchObject({
      status: 'failed_permanent',
      quarantine_evidence_sha256: digest(stored),
    });
    expect(readdirSync(tmpRoot).some((name) => name.includes('.pre-outbound-quarantine-retire-')))
      .toBe(true);
  });

  it('does not expose a digest or an inconsistent contributor count for malformed private evidence', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'retire-outbound-'));
    const rawMarker = 'private malformed evidence marker';
    const db = createDb([{
      id: 42,
      error: rawMarker,
      disposition: 'future-private-disposition',
      coverage: 'legacy_unclassified',
    }]);

    const result = runRetire(db);
    const output = parseSuccess(result);

    expect(output).toMatchObject({
      op: {
        id: 42,
        disposition: 'legacy_unclassified',
        evidenceDigestAvailable: false,
        eligibility: 'not_retirable',
        contributors: { total: 1, sameDisposition: 1 },
      },
    });
    expect((output.op as Record<string, unknown>).evidenceSha256).toBeUndefined();
    expect(result.stdout).not.toContain(rawMarker);
  });

  it('does not digest evidence with an unregistered private failure code', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'retire-outbound-'));
    const stored = evidence({ failure_code: 'PRIVATE_CANARY' });
    const db = createDb([{
      id: 42,
      error: stored,
      disposition: 'future-private-disposition',
      coverage: 'legacy_unclassified',
    }]);

    const result = runRetire(db);
    const output = parseSuccess(result);

    expect(output).toMatchObject({
      op: {
        id: 42,
        disposition: 'legacy_unclassified',
        evidenceDigestAvailable: false,
        eligibility: 'not_retirable',
      },
    });
    expect((output.op as Record<string, unknown>).evidenceSha256).toBeUndefined();
    expect(result.stdout).not.toContain('PRIVATE_CANARY');
  });

  it('does not echo private invalid argument values', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'retire-outbound-'));
    const result = runRetire(join(tmpRoot, 'unused.db'), [
      '--apply',
      '--expected-disposition', 'PRIVATE_ARG_CANARY',
    ]);

    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stderr)).toEqual({ ok: false, error: 'invalid_arguments' });
    expect(result.stderr).not.toContain('PRIVATE_ARG_CANARY');
  });

  it('fails closed without mutation if a private backup cannot be created securely', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'retire-outbound-'));
    const stored = evidence();
    const db = createDb([{ id: 42, error: stored }]);
    chmodSync(tmpRoot, 0o500);
    try {
      const result = runRetire(db, [
        '--apply',
        '--confirm-op-id', '42',
        '--expected-disposition', 'delivery_ambiguous_unsafe',
        '--acknowledgement', 'delivery-risk-reviewed',
        '--expect-evidence-sha256', digest(stored),
      ]);
      expect(result.status).not.toBe(0);
      expect(JSON.parse(result.stderr)).toEqual({ ok: false, error: 'backup_failed' });
    } finally {
      chmodSync(tmpRoot, 0o700);
    }
    expect(queryRow(db)).toMatchObject({ status: 'quarantined', error: stored, is_terminal: 0 });
  });

  it('treats malformed JSON field types as ineligible instead of exposing an internal error', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'retire-outbound-'));
    const stored = evidence({ stage: ['runtime'] });
    const db = createDb([{
      id: 42,
      error: stored,
      disposition: 'legacy_unclassified',
      coverage: 'legacy_unclassified',
    }]);

    const result = runRetire(db, [
      '--apply',
      '--confirm-op-id', '42',
      '--expected-disposition', 'delivery_ambiguous_unsafe',
      '--acknowledgement', 'delivery-risk-reviewed',
      '--expect-evidence-sha256', digest(stored),
    ]);

    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stderr)).toEqual({ ok: false, error: 'retirement_not_eligible' });
    expect(queryRow(db)).toMatchObject({ status: 'quarantined', error: stored, is_terminal: 0 });
    expect(readdirSync(tmpRoot).some((name) => name.includes('.pre-outbound-quarantine-retire-')))
      .toBe(false);
  });

  it('rejects a mismatched disposition before mutating a classified quarantine', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'retire-outbound-'));
    const stored = evidence({
      failure_code: 'outbound.pending_replay_unreconstructable',
      stage: 'admission',
      mutation_state: 'not_started',
      provider_submission_count: 0,
    });
    const db = createDb([{
      id: 42,
      error: stored,
      disposition: 'record_unreconstructable',
    }]);

    const result = runRetire(db, [
      '--apply',
      '--confirm-op-id', '42',
      '--expected-disposition', 'delivery_ambiguous_unsafe',
      '--acknowledgement', 'delivery-risk-reviewed',
      '--expect-evidence-sha256', digest(stored),
    ]);

    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stderr)).toEqual({ ok: false, error: 'retirement_precondition_failed' });
    expect(queryRow(db)).toMatchObject({ status: 'quarantined', error: stored, is_terminal: 0 });
  });

  it('allows the reconstruction-review acknowledgement only for a matching no-send record', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'retire-outbound-'));
    const stored = evidence({
      failure_code: 'outbound.pending_replay_unreconstructable',
      stage: 'admission',
      mutation_state: 'not_started',
      provider_submission_count: 0,
    });
    const db = createDb([{
      id: 42,
      error: stored,
      disposition: 'record_unreconstructable',
    }]);

    const output = parseSuccess(runRetire(db, [
      '--apply',
      '--confirm-op-id', '42',
      '--expected-disposition', 'record_unreconstructable',
      '--acknowledgement', 'record-reconstruction-reviewed',
      '--expect-evidence-sha256', digest(stored),
    ]));

    expect(output).toMatchObject({
      action: 'retired',
      op: { disposition: 'record_unreconstructable', remainingQuarantined: 0 },
    });
    expect(queryRow(db)).toMatchObject({
      status: 'failed_permanent',
      error: stored,
      is_terminal: 1,
    });
  });

  it('retires a proved no-send deferral with the explicit none acknowledgement', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'retire-outbound-'));
    const stored = evidence({
      failure_code: 'outbound.deferral_limit_exceeded',
      stage: 'admission',
      mutation_state: 'not_started',
      provider_submission_count: 0,
    });
    const db = createDb([{
      id: 42,
      error: stored,
      disposition: 'delivery_not_attempted',
    }]);

    const output = parseSuccess(runRetire(db, [
      '--apply',
      '--confirm-op-id', '42',
      '--expected-disposition', 'delivery_not_attempted',
      '--acknowledgement', 'none',
      '--expect-evidence-sha256', digest(stored),
    ]));

    expect(output).toMatchObject({
      action: 'retired',
      op: { disposition: 'delivery_not_attempted', remainingQuarantined: 0 },
    });
    expect(queryRetirement(db)).toEqual({
      outbound_op_id: 42,
      quarantine_disposition: 'delivery_not_attempted',
      acknowledgement: 'none',
      evidence_sha256: digest(stored),
    });
  });

  it('retires a stale-status discard only with the explicit none acknowledgement', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'retire-outbound-'));
    const stored = evidence({
      failure_code: 'outbound.status_ping_expired',
      stage: 'runtime',
      mutation_state: 'not_started',
      provider_submission_count: 0,
    });
    const db = createDb([{
      id: 42,
      error: stored,
      disposition: 'stale_status_discarded',
    }]);

    const output = parseSuccess(runRetire(db, [
      '--apply',
      '--confirm-op-id', '42',
      '--expected-disposition', 'stale_status_discarded',
      '--acknowledgement', 'none',
      '--expect-evidence-sha256', digest(stored),
    ]));

    expect(output).toMatchObject({
      action: 'retired',
      op: { disposition: 'stale_status_discarded', remainingQuarantined: 0 },
    });
    expect(queryRetirement(db)).toEqual({
      outbound_op_id: 42,
      quarantine_disposition: 'stale_status_discarded',
      acknowledgement: 'none',
      evidence_sha256: digest(stored),
    });
  });
});

function resultText(output: Record<string, unknown>): string {
  return JSON.stringify(output);
}
