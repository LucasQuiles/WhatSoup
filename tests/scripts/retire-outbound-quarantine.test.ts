import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let tmpRoot = '';

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

function createDb(rows: Array<{ id: number; status: string; error?: string }>) {
  const db = join(tmpRoot, 'bot.db');
  const inserts = rows.map((row) => `
    INSERT INTO outbound_ops
      (id, conversation_key, chat_jid, op_type, payload, status, error, wa_message_id, replay_policy, is_terminal)
    VALUES
      (${row.id}, 'conv', 'chat@g.us', 'text', '{"text":"unit"}', '${row.status}', ${JSON.stringify(row.error ?? null)}, 'WA-${row.id}', 'unsafe', 0);
  `).join('\n');
  execFileSync('python3', ['-c', `
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
  replay_policy TEXT NOT NULL DEFAULT 'unsafe'
);
${inserts}
""")
con.commit()
`]);
  return db;
}

function runRetire(db: string, args: string[] = []) {
  return execFileSync('python3', [
    'deploy/scripts/retire-outbound-quarantine.py',
    '--db',
    db,
    '--instance',
    'primary',
    '--op-id',
    '42',
    '--reason',
    'unit reviewed unsafe replay; retire without replay',
    ...args,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, BOT_ERRORS_STATE_DIR: tmpRoot },
    encoding: 'utf8',
  });
}

function queryRow(db: string) {
  return JSON.parse(execFileSync('sqlite3', ['-json', db, 'select id, status, error, is_terminal from outbound_ops where id=42'], {
    encoding: 'utf8',
  }))[0] as { id: number; status: string; error: string; is_terminal: number };
}

describe('retire-outbound-quarantine', () => {
  it('dry-runs without mutating the op or writing a clear event', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'retire-outbound-'));
    const db = createDb([{ id: 42, status: 'quarantined', error: 'echo_timeout' }]);

    const output = JSON.parse(runRetire(db, ['--dry-run']));

    expect(output).toMatchObject({
      ok: true,
      action: 'dry_run',
      quarantinedBefore: 1,
      wouldClear: true,
    });
    expect(queryRow(db)).toMatchObject({ status: 'quarantined', error: 'echo_timeout', is_terminal: 0 });
    expect(existsSync(join(tmpRoot, 'outbox'))).toBe(false);
  });

  it('retires a reviewed quarantined op, creates a backup, and emits one clear when the lane is empty', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'retire-outbound-'));
    const db = createDb([{ id: 42, status: 'quarantined', error: 'echo_timeout' }]);

    const output = JSON.parse(runRetire(db));

    expect(output).toMatchObject({
      ok: true,
      action: 'retired',
      instance: 'primary',
      opId: 42,
      remainingQuarantined: 0,
    });
    expect(existsSync(output.backup)).toBe(true);
    expect(queryRow(db)).toMatchObject({ status: 'failed_permanent', is_terminal: 1 });
    expect(queryRow(db).error).toContain('retired_quarantine_reason=unit reviewed unsafe replay; retire without replay');

    const files = readdirSync(join(tmpRoot, 'outbox'));
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(tmpRoot, 'outbox', files[0]!), 'utf8')) as Record<string, unknown>;
    expect(event).toMatchObject({
      eventType: 'clear',
      severity: 'info',
      instance: 'primary',
      source: 'outbound_quarantined',
      summary: 'outbound quarantine retired for whatsoup@primary',
    });
    expect(String(event.evidence)).toContain('remaining_quarantined=0');
  });

  it('does not emit a clear while another quarantined op remains', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'retire-outbound-'));
    const db = createDb([
      { id: 42, status: 'quarantined', error: 'echo_timeout' },
      { id: 43, status: 'quarantined', error: 'echo_timeout' },
    ]);

    const output = JSON.parse(runRetire(db));

    expect(output).toMatchObject({ ok: true, action: 'retired', remainingQuarantined: 1, clearEvent: null });
    expect(queryRow(db)).toMatchObject({ status: 'failed_permanent', is_terminal: 1 });
    expect(existsSync(join(tmpRoot, 'outbox'))).toBe(false);
  });
});
