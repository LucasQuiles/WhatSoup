import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  chmodSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import {
  parseAuditContinuityManifestArgs,
  runAuditContinuityManifestCli,
} from '../../scripts/audit-continuity-manifest.ts';
import {
  parseRecordContinuityManifestArgs,
  runRecordContinuityManifestCli,
} from '../../scripts/record-continuity-manifest.ts';

const packageJson = JSON.parse(readFileSync(
  new URL('../../package.json', import.meta.url),
  'utf8',
)) as { scripts: Record<string, string> };

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-continuity-audit-'));
  tempRoots.push(root);
  return root;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface ReceiptInput {
  ordinal: number;
  messageId: string;
  sentAt: number;
  senderFingerprint: string;
  contentHash: string;
  contentType: string;
}

interface ManifestInput {
  schemaVersion: number;
  source: string;
  manifestId: string;
  evidenceRef: string;
  destination: {
    conversationKey: string;
    channelFingerprint: string;
  };
  receipts: ReceiptInput[];
}

function receipt(
  ordinal: number,
  messageId: string,
  overrides: Partial<ReceiptInput> = {},
): ReceiptInput {
  return {
    ordinal,
    messageId,
    sentAt: 1_750_000_000 + ordinal,
    senderFingerprint: digest(`sender-${ordinal}`),
    contentHash: digest(`body-${ordinal}`),
    contentType: 'text',
    ...overrides,
  };
}

function manifest(receipts: ReceiptInput[]): ManifestInput {
  return {
    schemaVersion: 1,
    source: 'independent_participant_history',
    manifestId: 'audit-fixture-v1',
    evidenceRef: 'evidence://private-reference',
    destination: {
      conversationKey: 'conversation-private',
      channelFingerprint: digest('private-channel@g.us'),
    },
    receipts,
  };
}

function installMessage(
  db: Database,
  row: ReceiptInput,
  options: {
    conversationKey?: string;
    chatJid?: string;
    senderJid?: string;
    content?: string;
    contentType?: string;
    timestamp?: number;
  } = {},
): void {
  db.raw.prepare(`
    INSERT INTO messages (
      chat_jid, conversation_key, sender_jid, message_id, content,
      content_type, is_from_me, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    options.chatJid ?? 'private-channel@g.us',
    options.conversationKey ?? 'conversation-private',
    options.senderJid ?? `sender-${row.ordinal}`,
    row.messageId,
    options.content ?? `body-${row.ordinal}`,
    options.contentType ?? row.contentType,
    options.timestamp ?? row.sentAt,
  );
}

function installInbound(
  db: Database,
  row: ReceiptInput,
  processingStatus: string,
  options: { conversationKey?: string; chatJid?: string } = {},
): number {
  return Number(db.raw.prepare(`
    INSERT INTO inbound_events (
      message_id, conversation_key, chat_jid, processing_status,
      completed_at, terminal_reason
    ) VALUES (?, ?, ?, ?,
      CASE WHEN ? IN ('complete', 'failed') THEN datetime('now') ELSE NULL END,
      CASE WHEN ? = 'complete' THEN 'response_sent'
           WHEN ? = 'failed' THEN 'error'
           ELSE NULL END)
  `).run(
    row.messageId,
    options.conversationKey ?? 'conversation-private',
    options.chatJid ?? 'private-channel@g.us',
    processingStatus,
    processingStatus,
    processingStatus,
    processingStatus,
  ).lastInsertRowid);
}

function installEchoedReply(db: Database, inboundSeq: number): void {
  const opId = Number(db.raw.prepare(`
    INSERT INTO outbound_ops (
      conversation_key, chat_jid, op_type, payload, status,
      source_inbound_seq, is_terminal, replay_policy, submitted_at,
      echoed_at, wa_message_id
    ) VALUES (
      'conversation-private', 'private-channel@g.us', 'text', '{"text":"ACK"}',
      'echoed', ?, 1, 'unsafe', datetime('now'), datetime('now'), 'reply-proof'
    )
  `).run(inboundSeq).lastInsertRowid);
  db.raw.prepare(`
    INSERT INTO turn_terminal_records (
      scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
      logical_turn_id, manager_id, generation, attempt_kind,
      inbound_disposition, delivery_kind, delivery_op_id,
      reply_guarantee_disarmed
    ) VALUES (
      'per_chat', 'conversation-private', 'private-channel@g.us', ?, ?,
      ?, 'manager', 1, 'replied', 'finalized_replied', 'echoed', ?, 1
    )
  `).run(inboundSeq, inboundSeq, `turn-${inboundSeq}`, opId);
}

function installFixture(): {
  dbPath: string;
  manifestPath: string;
  input: ManifestInput;
} {
  const root = makeTempRoot();
  const dbPath = path.join(root, 'bot.db');
  const manifestPath = path.join(root, 'manifest.json');
  const rows = [
    receipt(1, 'answered-private'),
    receipt(2, 'unanswered-private'),
    receipt(3, 'observed-private'),
    receipt(4, 'absent-private'),
    receipt(5, 'ambiguous-private'),
  ];
  const input = manifest(rows);
  const db = new Database(dbPath);
  db.open();

  installMessage(db, rows[0]);
  const answeredSeq = installInbound(db, rows[0], 'complete');
  installEchoedReply(db, answeredSeq);

  installMessage(db, rows[1]);
  installInbound(db, rows[1], 'processing');

  installMessage(db, rows[2]);

  installMessage(db, rows[4], { content: 'different-body' });
  installInbound(db, rows[4], 'complete');

  db.close();
  writeFileSync(manifestPath, `${JSON.stringify(input, null, 2)}\n`, { mode: 0o600 });
  return { dbPath, manifestPath, input };
}

function argsFor(fixture: { dbPath: string; manifestPath: string }): string[] {
  return ['--db', fixture.dbPath, '--manifest', fixture.manifestPath];
}

function captureRun(argv: string[]): {
  exitCode: number;
  output: Record<string, unknown>;
  text: string;
} {
  const write = vi.spyOn(process.stdout, 'write')
    .mockImplementation((() => true) as typeof process.stdout.write);
  try {
    const exitCode = runAuditContinuityManifestCli(argv);
    const text = write.mock.calls.map(([chunk]) => String(chunk)).join('');
    return { exitCode, output: JSON.parse(text) as Record<string, unknown>, text };
  } finally {
    write.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('audit-continuity-manifest CLI', () => {
  it('is exposed as a pinned, read-only package script', () => {
    expect(packageJson.scripts['audit-continuity-manifest']).toBe(
      'bash scripts/run-with-pinned-node.sh scripts/audit-continuity-manifest.ts',
    );
  });

  it('parses each known path flag exactly once and has no confirm mode', () => {
    const fixture = installFixture();
    expect(parseAuditContinuityManifestArgs(argsFor(fixture))).toEqual({
      dbPath: fixture.dbPath,
      manifestPath: fixture.manifestPath,
    });
    expect(() => parseAuditContinuityManifestArgs([...argsFor(fixture), '--unknown']))
      .toThrow('Unknown argument: --unknown');
    expect(() => parseAuditContinuityManifestArgs([
      ...argsFor(fixture),
      '--db',
      fixture.dbPath,
    ])).toThrow('Duplicate argument: --db');
    expect(() => parseAuditContinuityManifestArgs([...argsFor(fixture), '--confirm']))
      .toThrow('Unknown argument: --confirm');
  });

  it('classifies exact receipts and emits only content-free ordinals and states', () => {
    const fixture = installFixture();
    const before = readFileSync(fixture.dbPath);

    const result = captureRun(argsFor(fixture));

    expect(result.exitCode).toBe(2);
    expect(result.output).toMatchObject({
      ok: true,
      dryRun: true,
      state: 'continuity_gap_detected',
      counts: {
        total: 5,
        present: 2,
        answered: 1,
        unanswered: 1,
        missing: 2,
        ambiguous: 1,
        replayRequired: 3,
      },
      receipts: [
        {
          ordinal: 1,
          classification: 'present_answered',
          action: 'none',
        },
        {
          ordinal: 2,
          classification: 'present_unanswered',
          action: 'existing_inbound_recovery',
        },
        {
          ordinal: 3,
          classification: 'observed_not_admitted',
          action: 'operator_catchup',
        },
        {
          ordinal: 4,
          classification: 'absent',
          action: 'operator_catchup',
        },
        {
          ordinal: 5,
          classification: 'ambiguous',
          action: 'manual_review',
        },
      ],
    });
    expect(result.text).not.toContain(fixture.input.manifestId);
    expect(result.text).not.toContain(fixture.input.evidenceRef);
    expect(result.text).not.toContain(fixture.input.destination.conversationKey);
    expect(result.text).not.toContain('private-channel');
    for (const row of fixture.input.receipts) {
      expect(result.text).not.toContain(row.messageId);
      expect(result.text).not.toContain(row.senderFingerprint);
      expect(result.text).not.toContain(row.contentHash);
    }
    expect(readFileSync(fixture.dbPath)).toEqual(before);
  });

  it('returns a clean state only when every exact receipt has echoed reply proof', () => {
    const root = makeTempRoot();
    const dbPath = path.join(root, 'bot.db');
    const manifestPath = path.join(root, 'manifest.json');
    const row = receipt(1, 'clean-private');
    const db = new Database(dbPath);
    db.open();
    installMessage(db, row);
    const inboundSeq = installInbound(db, row, 'complete');
    installEchoedReply(db, inboundSeq);
    db.close();
    writeFileSync(manifestPath, JSON.stringify(manifest([row])), { mode: 0o600 });

    expect(captureRun(['--db', dbPath, '--manifest', manifestPath])).toMatchObject({
      exitCode: 0,
      output: {
        ok: true,
        dryRun: true,
        state: 'clear',
        counts: {
          total: 1,
          present: 1,
          answered: 1,
          unanswered: 0,
          missing: 0,
          ambiguous: 0,
          replayRequired: 0,
        },
      },
    });
  });

  it('rejects missing files without creating a database', () => {
    const fixture = installFixture();
    const missingDb = path.join(makeTempRoot(), 'missing.db');
    const missingManifest = path.join(makeTempRoot(), 'missing.json');

    expect(() => runAuditContinuityManifestCli([
      '--db',
      missingDb,
      '--manifest',
      fixture.manifestPath,
    ])).toThrow('existing regular file');
    expect(existsSync(missingDb)).toBe(false);
    expect(() => runAuditContinuityManifestCli([
      '--db',
      fixture.dbPath,
      '--manifest',
      missingManifest,
    ])).toThrow('existing regular file');
  });

  it('rejects raw content, unknown fields, malformed hashes, and non-contiguous order', () => {
    const fixture = installFixture();
    const invalidCases: unknown[] = [
      { ...fixture.input, rawContent: 'must never be accepted' },
      {
        ...fixture.input,
        receipts: [{ ...fixture.input.receipts[0], content: 'must never be accepted' }],
      },
      {
        ...fixture.input,
        receipts: [{ ...fixture.input.receipts[0], contentHash: 'not-a-hash' }],
      },
      {
        ...fixture.input,
        receipts: [
          { ...fixture.input.receipts[0], ordinal: 2 },
          { ...fixture.input.receipts[1], ordinal: 3 },
        ],
      },
    ];

    for (const [index, invalid] of invalidCases.entries()) {
      const manifestPath = path.join(makeTempRoot(), `invalid-${index}.json`);
      writeFileSync(manifestPath, JSON.stringify(invalid), { mode: 0o600 });
      expect(() => runAuditContinuityManifestCli([
        '--db',
        fixture.dbPath,
        '--manifest',
        manifestPath,
      ])).toThrow();
    }
  });

  it('refuses a manifest that is readable outside its owner', () => {
    const fixture = installFixture();
    chmodSync(fixture.manifestPath, 0o644);

    expect(() => runAuditContinuityManifestCli(argsFor(fixture)))
      .toThrow('must not be group- or world-readable');
  });

  it('requires contiguous schema receipts without migrating the inspected database', () => {
    const fixture = installFixture();
    const raw = new DatabaseSync(fixture.dbPath);
    raw.prepare('DELETE FROM schema_migrations WHERE version = 43').run();
    raw.close();

    expect(() => runAuditContinuityManifestCli(argsFor(fixture)))
      .toThrow('contiguous schema 43+ receipts');

    const check = new DatabaseSync(fixture.dbPath, { readOnly: true });
    expect(check.prepare('SELECT version FROM schema_migrations WHERE version = 43').get())
      .toBeUndefined();
    check.close();
  });
});

describe('record-continuity-manifest CLI', () => {
  it('requires an explicit recording confirmation and keeps the audit command read-only', () => {
    const fixture = installFixture();
    expect(packageJson.scripts['record-continuity-manifest']).toBe(
      'bash scripts/run-with-pinned-node.sh scripts/record-continuity-manifest.ts',
    );
    expect(() => parseRecordContinuityManifestArgs(argsFor(fixture)))
      .toThrow('--confirm-record is required exactly once');
    expect(parseRecordContinuityManifestArgs([
      ...argsFor(fixture),
      '--confirm-record',
    ])).toEqual({
      dbPath: fixture.dbPath,
      manifestPath: fixture.manifestPath,
    });
    expect(() => parseAuditContinuityManifestArgs([
      ...argsFor(fixture),
      '--confirm-record',
    ])).toThrow('Unknown argument: --confirm-record');

    const raw = new DatabaseSync(fixture.dbPath, { readOnly: true });
    expect(raw.prepare(`
      SELECT COUNT(*) AS count
      FROM recovery_plans
      WHERE actor = 'continuity_manifest_recorder'
    `).get()).toEqual({ count: 0 });
    raw.close();
  });

  it('records only missing or ambiguous receipts with idempotent content-free output', () => {
    const fixture = installFixture();
    const argv = [...argsFor(fixture), '--confirm-record'];
    const write = vi.spyOn(process.stdout, 'write')
      .mockImplementation((() => true) as typeof process.stdout.write);
    let firstText: string;
    let secondText: string;
    try {
      expect(runRecordContinuityManifestCli(argv)).toBe(2);
      firstText = write.mock.calls.map(([chunk]) => String(chunk)).join('');
      write.mockClear();
      expect(runRecordContinuityManifestCli(argv)).toBe(2);
      secondText = write.mock.calls.map(([chunk]) => String(chunk)).join('');
    } finally {
      write.mockRestore();
    }

    expect(JSON.parse(firstText)).toMatchObject({
      ok: true,
      recorded: true,
      ledger: {
        created: 3,
        existing: 0,
        unresolved: 2,
        ambiguous: 1,
      },
    });
    expect(JSON.parse(secondText)).toMatchObject({
      ok: true,
      recorded: true,
      ledger: {
        created: 0,
        existing: 3,
        unresolved: 2,
        ambiguous: 1,
      },
    });
    for (const text of [firstText, secondText]) {
      expect(text).not.toContain(fixture.input.manifestId);
      expect(text).not.toContain(fixture.input.evidenceRef);
      expect(text).not.toContain(fixture.input.destination.conversationKey);
      for (const row of fixture.input.receipts) {
        expect(text).not.toContain(row.messageId);
        expect(text).not.toContain(row.senderFingerprint);
        expect(text).not.toContain(row.contentHash);
      }
    }

    const raw = new DatabaseSync(fixture.dbPath, { readOnly: true });
    expect(raw.prepare(`
      SELECT COUNT(*) AS count
      FROM recovery_plans
      WHERE actor = 'continuity_manifest_recorder'
    `).get()).toEqual({ count: 3 });
    expect(raw.prepare(`
      SELECT COUNT(*) AS count
      FROM recovery_runs
      WHERE trigger LIKE 'continuity_gap_%'
    `).get()).toEqual({ count: 3 });
    raw.close();
  });
});
