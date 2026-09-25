// close-continuity-gap: preview on a static snapshot, apply under a writer
// reservation. All identifiers, messages and media bytes are fabricated.
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';

import { runCloseContinuityGapCli } from '../../scripts/close-continuity-gap.ts';
import { runRecordContinuityManifestCli } from '../../scripts/record-continuity-manifest.ts';
import { Database } from '../../src/core/database.ts';
import {
  readContinuityGapHealth,
  readContinuityGapLedger,
} from '../../src/core/continuity-gap-ledger.ts';
import { fakeClock } from '../../src/lib/clock.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('whatsoup-close-gap-', { base: realpathSync(tmpdir()) });
const NOW = Date.parse('2026-09-25T01:00:00.000Z');

const CONVERSATION = 'fixture-conversation';
const CHANNEL = 'fixture-channel@g.us';
const SENDER = 'fixture-sender@s.whatsapp.net';
const OWNER = 'fixture-owner@s.whatsapp.net';
const STRANGER = 'fixture-stranger@s.whatsapp.net';

function sha(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function writePrivate(path: string, content: string | Buffer): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return sha(content);
}

interface Fixture {
  root: string;
  dbPath: string;
  evidenceRoot: string;
  originalSha: string;
  planIds: Record<1 | 2 | 3, string>;
  receiptFingerprints: Record<1 | 2 | 3, string>;
  destinationFingerprint: string;
  seqs: Record<'live' | 'liveNoReply' | 'liveElsewhere' | 'decline' | 'declineElsewhere'
    | 'owner' | 'stranger', number>;
  files: Record<'context' | 'media' | 'transcript' | 'resolution', { path: string; sha256: string }>;
}

function insertMessage(
  raw: DatabaseSync,
  input: {
    messageId: string;
    sender: string;
    content: string;
    timestamp: number;
    conversation?: string;
    channel?: string;
    inbound?: boolean;
  },
): number {
  raw.prepare(`
    INSERT INTO messages (
      chat_jid, conversation_key, sender_jid, message_id, content,
      content_type, is_from_me, timestamp
    ) VALUES (?, ?, ?, ?, ?, 'text', 0, ?)
  `).run(
    input.channel ?? CHANNEL,
    input.conversation ?? CONVERSATION,
    input.sender,
    input.messageId,
    input.content,
    input.timestamp,
  );
  if (input.inbound === false) return 0;
  return Number(raw.prepare(`
    INSERT INTO inbound_events (
      message_id, conversation_key, chat_jid, processing_status, completed_at, terminal_reason
    ) VALUES (?, ?, ?, 'complete', datetime('now'), 'response_sent')
  `).run(
    input.messageId,
    input.conversation ?? CONVERSATION,
    input.channel ?? CHANNEL,
  ).lastInsertRowid);
}

function installEchoedReply(raw: DatabaseSync, seq: number, conversation = CONVERSATION,
  channel = CHANNEL): void {
  const opId = Number(raw.prepare(`
    INSERT INTO outbound_ops (
      conversation_key, chat_jid, op_type, payload, status, source_inbound_seq,
      is_terminal, replay_policy, submitted_at, echoed_at, wa_message_id
    ) VALUES (?, ?, 'text', '{"text":"done"}', 'echoed', ?, 1, 'unsafe',
      datetime('now'), datetime('now'), ?)
  `).run(conversation, channel, seq, `fixture-reply-${seq}`).lastInsertRowid);
  raw.prepare(`
    INSERT INTO turn_terminal_records (
      scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
      logical_turn_id, manager_id, generation, attempt_kind,
      inbound_disposition, delivery_kind, delivery_op_id, reply_guarantee_disarmed
    ) VALUES ('per_chat', ?, ?, ?, ?, ?, 'manager', 1, 'replied',
      'finalized_replied', 'echoed', ?, 1)
  `).run(conversation, channel, seq, seq, `fixture-turn-${seq}`, opId);
}

function buildFixture(): Fixture {
  const root = tmp.make('fixture');
  const dbPath = join(root, 'bot.db');
  const evidenceRoot = join(root, 'evidence');
  mkdirSync(evidenceRoot, { mode: 0o700 });

  const db = new Database(dbPath);
  db.open();
  // Receipt 3 has a local message that does not match exactly: ambiguous.
  insertMessage(db.raw, {
    messageId: 'fixture-src-3', sender: SENDER, content: 'altered', timestamp: 1_750_000_003,
    inbound: false,
  });
  db.close();

  const receipts = [1, 2, 3].map((ordinal) => ({
    ordinal,
    messageId: `fixture-src-${ordinal}`,
    sentAt: 1_750_000_000 + ordinal,
    senderFingerprint: sha(SENDER),
    contentHash: sha(`fixture-body-${ordinal}`),
    contentType: ordinal === 2 ? 'audio' : 'text',
  }));
  const original = {
    schemaVersion: 1,
    source: 'independent_participant_history',
    manifestId: 'fixture-manifest',
    evidenceRef: 'fixture-evidence-ref',
    destination: { conversationKey: CONVERSATION, channelFingerprint: sha(CHANNEL) },
    receipts,
  };
  const originalPath = join(evidenceRoot, 'original', 'manifest.json');
  const originalSha = writePrivate(originalPath, `${JSON.stringify(original)}\n`);
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    expect(runRecordContinuityManifestCli([
      '--db', dbPath, '--manifest', originalPath, '--confirm-record',
    ])).toBe(2);
  } finally {
    write.mockRestore();
  }

  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA foreign_keys = ON');
  const ledger = readContinuityGapLedger(raw);
  const byOrdinal = (n: number) => ledger.find((entry) => entry.observation.ordinal === n)!;
  const live = insertMessage(raw, {
    messageId: 'fixture-live-1', sender: SENDER, content: 'please redo', timestamp: 1_750_000_100,
  });
  installEchoedReply(raw, live);
  const liveNoReply = insertMessage(raw, {
    messageId: 'fixture-live-2', sender: SENDER, content: 'again', timestamp: 1_750_000_110,
  });
  const liveElsewhere = insertMessage(raw, {
    messageId: 'fixture-live-3', sender: SENDER, content: 'elsewhere', timestamp: 1_750_000_120,
    conversation: 'fixture-other-conversation', channel: 'fixture-other@g.us',
  });
  installEchoedReply(raw, liveElsewhere, 'fixture-other-conversation', 'fixture-other@g.us');
  const decline = insertMessage(raw, {
    messageId: 'fixture-decline-1', sender: SENDER, content: 'never mind', timestamp: 1_750_000_200,
  });
  const declineElsewhere = insertMessage(raw, {
    messageId: 'fixture-decline-2', sender: SENDER, content: 'never mind', timestamp: 1_750_000_210,
    conversation: 'fixture-other-conversation', channel: 'fixture-other@g.us',
  });
  const owner = insertMessage(raw, {
    messageId: 'fixture-owner-1', sender: OWNER, content: 'drop it', timestamp: 1_750_000_300,
    conversation: 'fixture-owner-dm', channel: OWNER,
  });
  const stranger = insertMessage(raw, {
    messageId: 'fixture-stranger-1', sender: STRANGER, content: 'drop it', timestamp: 1_750_000_310,
  });
  raw.close();

  const file = (rel: string, content: string | Buffer) => ({
    path: rel,
    sha256: writePrivate(join(evidenceRoot, rel), content),
  });
  return {
    root,
    dbPath,
    evidenceRoot,
    originalSha,
    planIds: { 1: byOrdinal(1).planId, 2: byOrdinal(2).planId, 3: byOrdinal(3).planId },
    receiptFingerprints: {
      1: byOrdinal(1).observation.receiptFingerprint,
      2: byOrdinal(2).observation.receiptFingerprint,
      3: byOrdinal(3).observation.receiptFingerprint,
    },
    destinationFingerprint: byOrdinal(1).observation.destinationFingerprint,
    seqs: { live, liveNoReply, liveElsewhere, decline, declineElsewhere, owner, stranger },
    files: {
      context: file('witness/context-1.json', '{"fixture":"context witness"}\n'),
      media: file('audio/media-2.ogg', Buffer.from([0x4f, 0x67, 0x67, 0x53, 1, 2, 3])),
      transcript: file('audio/transcript-2.txt', 'fixture transcript\n'),
      resolution: file('witness/resolution-3.json', '{"fixture":"resolved candidate"}\n'),
    },
  };
}

type Ordinal = 1 | 2 | 3;

function baseManifest(fx: Fixture, ordinal: Ordinal): Record<string, unknown> {
  return {
    contract: 'continuity-closure-evidence.v1',
    planId: fx.planIds[ordinal],
    original: {
      manifest: { path: 'original/manifest.json', sha256: fx.originalSha },
      ordinal,
      receiptFingerprint: fx.receiptFingerprints[ordinal],
      contentType: ordinal === 2 ? 'audio' : 'text',
      conversationFingerprint: fx.destinationFingerprint,
    },
    actor: 'operator:fixture',
    authority: 'owner-request:fixture',
    observedAt: '2026-09-25T00:30:00.000Z',
    decidedAt: '2026-09-25T00:20:00.000Z',
    ambiguityResolution: ordinal === 3 ? fx.files.resolution : null,
  };
}

function addressed(fx: Fixture, ordinal: Ordinal, overrides: Record<string, unknown> = {}) {
  const audio = ordinal === 2;
  return {
    ...baseManifest(fx, ordinal),
    disposition: 'addressed',
    proofKind: 'live_reissue',
    liveInbound: { seq: fx.seqs.live, messageSha256: sha('fixture-live-1') },
    proofs: [
      { role: 'context_witness', ...fx.files.context },
      ...(audio
        ? [
          { role: 'original_media', ...fx.files.media },
          { role: 'transcript', ...fx.files.transcript },
        ]
        : []),
    ],
    audio: audio
      ? {
        mediaSha256: fx.files.media.sha256,
        transcriptSha256: fx.files.transcript.sha256,
        enrichmentComplete: true,
      }
      : null,
    decision: null,
    ...overrides,
  };
}

function decisionRecord(
  fx: Fixture,
  ordinal: Ordinal,
  messageId: string,
  content: string,
  name: string,
): { path: string; sha256: string } {
  const rel = `decisions/${name}.json`;
  const body = JSON.stringify({
    contract: 'continuity-closure-decision.v1',
    planId: fx.planIds[ordinal],
    receiptFingerprint: fx.receiptFingerprints[ordinal],
    decision: 'decline',
    inboundMessageSha256: sha(messageId),
    contentSha256: sha(content),
  });
  return { path: rel, sha256: writePrivate(join(fx.evidenceRoot, rel), `${body}\n`) };
}

function declined(
  fx: Fixture,
  ordinal: Ordinal,
  source: string,
  overrides: Record<string, unknown> = {},
) {
  const seqKey = source === 'owner_inbound' ? 'owner' : 'decline';
  const messageId = seqKey === 'owner' ? 'fixture-owner-1' : 'fixture-decline-1';
  const content = seqKey === 'owner' ? 'drop it' : 'never mind';
  return {
    ...baseManifest(fx, ordinal),
    disposition: 'declined',
    proofKind: source === 'owner_inbound' ? 'owner_declined' : 'sender_declined',
    liveInbound: null,
    proofs: [],
    audio: null,
    decision: {
      source,
      verifierVersion: 1,
      inboundSeq: fx.seqs[seqKey],
      messageSha256: sha(messageId),
      record: decisionRecord(fx, ordinal, messageId, content, `${source}-${ordinal}`),
    },
    ...overrides,
  };
}

function writeManifest(fx: Fixture, name: string, manifest: unknown): string {
  const rel = `closures/${name}.json`;
  writePrivate(join(fx.evidenceRoot, rel), `${JSON.stringify(manifest)}\n`);
  return rel;
}

function writePolicy(fx: Fixture, overrides: Record<string, unknown> = {}, mode = 0o600): string {
  const path = join(fx.root, 'policy', 'closure-authority.json');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({
    contract: 'continuity-closure-authority.v1',
    policyVersion: 'fixture-policy-1',
    instanceId: 'fixture-instance',
    ownerIdentityFingerprints: [sha(OWNER)],
    acceptedDecisionSources: [
      { verifierId: 'original_sender_inbound', version: 1 },
      { verifierId: 'owner_inbound', version: 1 },
    ],
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    effectiveUntil: null,
    approvedBy: sha(OWNER),
    approvedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  })}\n`);
  chmodSync(path, mode);
  return path;
}

/** Static copy produced the way the runbook instructs, with a live writer attached. */
function makeSnapshot(fx: Fixture): string {
  const dir = join(fx.root, 'snapshot');
  mkdirSync(dir, { mode: 0o700 });
  const snapshot = join(dir, 'bot.snapshot.db');
  const writer = new DatabaseSync(fx.dbPath);
  try {
    writer.exec('PRAGMA journal_mode = WAL');
    writer.exec("INSERT INTO chat_aliases (alias, chat_jid) VALUES ('fixture-alias', 'fixture@lid')");
    expect(existsSync(`${fx.dbPath}-wal`)).toBe(true);
    const copier = new DatabaseSync(fx.dbPath, { readOnly: true });
    try {
      copier.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
    } finally {
      copier.close();
    }
  } finally {
    writer.close();
  }
  return snapshot;
}

interface CliResult {
  code: number;
  output: Record<string, unknown>;
}

function run(fx: Fixture, mode: { snapshot: string } | 'apply', evidence: string,
  extra: string[] = []): CliResult {
  const lines: string[] = [];
  const target = mode === 'apply' ? ['--db', fx.dbPath, '--apply'] : ['--snapshot', mode.snapshot];
  const code = runCloseContinuityGapCli(
    ['--evidence-root', fx.evidenceRoot, '--evidence', evidence, ...target, ...extra],
    { stdout: (line) => lines.push(line), clock: fakeClock(NOW) },
  );
  expect(lines).toHaveLength(1);
  return { code, output: JSON.parse(lines[0]) as Record<string, unknown> };
}

function apply(fx: Fixture, name: string, manifest: unknown, extra: string[] = []): CliResult {
  return run(fx, 'apply', writeManifest(fx, name, manifest), extra);
}

function policyArgs(policyPath: string): string[] {
  return ['--policy', policyPath, '--instance', 'fixture-instance'];
}

function closures(fx: Fixture): number {
  const raw = new DatabaseSync(fx.dbPath, { readOnly: true });
  try {
    return Number((raw.prepare('SELECT COUNT(*) AS n FROM continuity_gap_closures')
      .get() as { n: number }).n);
  } finally {
    raw.close();
  }
}

function expectRejected(result: CliResult, kind: 'blocked' | 'conflict', condition: string): void {
  expect(result.output).toMatchObject({
    ok: false,
    decision: kind,
    code: kind === 'blocked' ? 'CLOSURE_BLOCKED' : 'CLOSURE_PROOF_CONFLICT',
    condition,
  });
  expect(result.code).toBe(kind === 'blocked' ? 2 : 3);
}

describe('close-continuity-gap arguments', () => {
  it('is registered as an npm script and a public surface', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['close-continuity-gap'])
      .toBe('bash scripts/run-with-pinned-node.sh scripts/close-continuity-gap.ts');
    const surface = readFileSync(new URL('../../docs/public-surface.md', import.meta.url), 'utf8');
    expect(surface).toContain('`cli:npm.close-continuity-gap`');
  });

  it('rejects ambiguous or unsafe mode combinations', () => {
    const io = { stdout: () => undefined, clock: fakeClock(NOW) };
    const base = ['--evidence-root', '/nonexistent', '--evidence', 'x.json'];
    expect(() => runCloseContinuityGapCli([...base], io)).toThrow(/--snapshot is required/);
    expect(() => runCloseContinuityGapCli([...base, '--db', '/x.db'], io))
      .toThrow(/--db requires --apply/);
    expect(() => runCloseContinuityGapCli([...base, '--apply'], io)).toThrow(/--db is required/);
    expect(() => runCloseContinuityGapCli([...base, '--apply', '--db', '/x', '--snapshot', '/y'], io))
      .toThrow(/--snapshot cannot be combined with --apply/);
    expect(() => runCloseContinuityGapCli([...base, '--snapshot', '/y', '--bogus'], io))
      .toThrow(/Unknown argument/);
    expect(() => runCloseContinuityGapCli([...base, '--snapshot', '/y', '--policy', '/p'], io))
      .toThrow(/--instance is required with --policy/);
  });
});

describe('close-continuity-gap preview', () => {
  it('previews an addressed closure on a static snapshot without writing anything', () => {
    const fx = buildFixture();
    const snapshot = makeSnapshot(fx);
    const before = sha(readFileSync(snapshot));
    const rel = writeManifest(fx, 'text-addressed', addressed(fx, 1));
    const result = run(fx, { snapshot }, rel);
    expect(result.output).toMatchObject({
      ok: true,
      mode: 'preview',
      decision: 'ready',
      code: null,
      condition: null,
      planId: fx.planIds[1],
      disposition: 'addressed',
    });
    expect(result.output.operationId).toMatch(/^[a-f0-9]{64}$/);
    expect(result.output.checks).toEqual(expect.arrayContaining([
      'snapshot_static', 'evidence_manifest', 'original_receipt', 'live_inbound',
      'terminal_proof', 'context_witness', 'gap_open',
    ]));
    expect(result.code).toBe(0);
    expect(sha(readFileSync(snapshot))).toBe(before);
    expect(readdirSync(dirname(snapshot))).toEqual(['bot.snapshot.db']);
    expect(closures(fx)).toBe(0);
  });

  it('reads a WAL-mode static copy without creating a shared-memory or WAL file', () => {
    const fx = buildFixture();
    const dir = join(fx.root, 'copy');
    mkdirSync(dir, { mode: 0o700 });
    const copy = join(dir, 'bot.copy.db');
    // Every connection is closed, so the WAL is checkpointed into the main
    // file; the copy keeps the WAL-mode header (bytes 18-19 = 2).
    writeFileSync(copy, readFileSync(fx.dbPath));
    expect([...readFileSync(copy).subarray(18, 20)]).toEqual([2, 2]);
    const before = sha(readFileSync(copy));
    const result = run(fx, { snapshot: copy }, writeManifest(fx, 'copy', addressed(fx, 1)));
    expect(result.output).toMatchObject({ ok: true, decision: 'ready' });
    expect(sha(readFileSync(copy))).toBe(before);
    expect(readdirSync(dir)).toEqual(['bot.copy.db']);
  });

  it('refuses a snapshot that still has a WAL sidecar', () => {
    const fx = buildFixture();
    const snapshot = makeSnapshot(fx);
    writeFileSync(`${snapshot}-wal`, '');
    const result = run(fx, { snapshot }, writeManifest(fx, 'wal', addressed(fx, 1)));
    expectRejected(result, 'blocked', 'snapshot_not_static');
  });

  it('reports schema_not_migrated for a snapshot without the closure ledger', () => {
    const fx = buildFixture();
    const raw = new DatabaseSync(fx.dbPath);
    raw.exec('DROP TABLE continuity_gap_closures');
    raw.prepare('DELETE FROM schema_migrations WHERE version = 65').run();
    raw.close();
    const snapshot = makeSnapshot(fx);
    const result = run(fx, { snapshot }, writeManifest(fx, 'old', addressed(fx, 1)));
    expectRejected(result, 'blocked', 'schema_not_migrated');
  });

  it('blocks an originally ambiguous gap until a resolution proof is supplied', () => {
    const fx = buildFixture();
    const snapshot = makeSnapshot(fx);
    const unresolved = run(fx, { snapshot },
      writeManifest(fx, 'amb-1', addressed(fx, 3, { ambiguityResolution: null })));
    expectRejected(unresolved, 'blocked', 'ambiguity_unresolved');
    const resolved = run(fx, { snapshot }, writeManifest(fx, 'amb-2', addressed(fx, 3)));
    expect(resolved.output).toMatchObject({ decision: 'ready' });
  });
});

describe('close-continuity-gap apply: addressed', () => {
  it('appends one closure, then returns the recorded outcome for the same operation', () => {
    const fx = buildFixture();
    const first = apply(fx, 'text', addressed(fx, 1));
    expect(first.output).toMatchObject({ ok: true, mode: 'apply', decision: 'applied' });
    expect(first.code).toBe(0);
    const again = run(fx, 'apply', 'closures/text.json');
    expect(again.output).toMatchObject({
      ok: true, decision: 'already_closed', operationId: first.output.operationId,
    });
    expect(closures(fx)).toBe(1);
    const raw = new DatabaseSync(fx.dbPath, { readOnly: true });
    try {
      expect(readContinuityGapHealth(raw)).toMatchObject({
        total: 3, open: 2, closed: 1, addressed: 1, declined: 0, ambiguous_total: 1,
      });
    } finally {
      raw.close();
    }
  });

  it('rejects a conflicting retry for the same gap without writing', () => {
    const fx = buildFixture();
    apply(fx, 'text', addressed(fx, 1));
    const policy = writePolicy(fx);
    const conflict = apply(fx, 'text-declined', declined(fx, 1, 'original_sender_inbound'),
      policyArgs(policy));
    expectRejected(conflict, 'conflict', 'closure_changed');
    expect(closures(fx)).toBe(1);
  });

  it('closes an audio receipt only with bound media and transcript proofs', () => {
    const fx = buildFixture();
    const result = apply(fx, 'audio', addressed(fx, 2));
    expect(result.output).toMatchObject({ decision: 'applied' });
  });

  it.each([
    ['audio section missing', { audio: null }, 'blocked', 'audio_evidence_missing'],
    ['enrichment incomplete', 'incomplete', 'blocked', 'media_not_ready'],
    ['caller claims text for an audio receipt', 'text-claim', 'conflict', 'content_type_mismatch'],
    ['transcript hash differs from the manifest', 'transcript-hash', 'conflict', 'transcript_changed'],
  ] as const)('audio: %s', (_label, change, kind, condition) => {
    const fx = buildFixture();
    let manifest: Record<string, unknown> = addressed(fx, 2);
    if (change === 'incomplete') {
      manifest = { ...manifest, audio: { ...(manifest.audio as object), enrichmentComplete: false } };
    } else if (change === 'text-claim') {
      manifest = {
        ...manifest,
        original: { ...(manifest.original as object), contentType: 'text' },
        audio: null,
      };
    } else if (change === 'transcript-hash') {
      manifest = { ...manifest, audio: { ...(manifest.audio as object), transcriptSha256: sha('x') } };
    } else {
      manifest = { ...manifest, ...change };
    }
    expectRejected(apply(fx, 'audio-bad', manifest), kind, condition);
    expect(closures(fx)).toBe(0);
  });

  it('fails without writing when the transcript bytes change after the manifest was written', () => {
    const fx = buildFixture();
    const rel = writeManifest(fx, 'audio', addressed(fx, 2));
    writeFileSync(join(fx.evidenceRoot, fx.files.transcript.path), 'edited transcript\n');
    expectRejected(run(fx, 'apply', rel), 'conflict', 'digest_mismatch');
    expect(closures(fx)).toBe(0);
  });

  it.each([
    ['live inbound in another conversation', 'liveElsewhere', 'conflict', 'wrong_conversation'],
    ['live inbound without a terminal delivery proof', 'liveNoReply', 'blocked', 'terminal_proof_missing'],
  ] as const)('%s', (_label, seqKey, kind, condition) => {
    const fx = buildFixture();
    const ids = { liveElsewhere: 'fixture-live-3', liveNoReply: 'fixture-live-2' } as const;
    const manifest = addressed(fx, 1, {
      liveInbound: { seq: fx.seqs[seqKey], messageSha256: sha(ids[seqKey]) },
    });
    expectRejected(apply(fx, 'live-bad', manifest), kind, condition);
    expect(closures(fx)).toBe(0);
  });

  it.each(['external_action', 'owner_session_declined', 'anything_else'])(
    'rejects unsupported proof kind %s as Blocked with a named condition',
    (proofKind) => {
      const fx = buildFixture();
      expectRejected(apply(fx, `kind-${proofKind}`, addressed(fx, 1, { proofKind })),
        'blocked', 'proof_kind_unsupported');
      expect(closures(fx)).toBe(0);
    },
  );

  it('rejects a live inbound whose message hash does not match', () => {
    const fx = buildFixture();
    const manifest = addressed(fx, 1, {
      liveInbound: { seq: fx.seqs.live, messageSha256: sha('fixture-other') },
    });
    expectRejected(apply(fx, 'live-hash', manifest), 'conflict', 'live_inbound_mismatch');
  });

  it.each([
    ['original manifest digest', (m: Record<string, any>) => {
      m.original.manifest.sha256 = sha('other');
    }, 'conflict', 'digest_mismatch'],
    ['receipt fingerprint', (m: Record<string, any>) => {
      m.original.receiptFingerprint = sha('other');
    }, 'conflict', 'stale_fingerprint'],
    ['original ordinal', (m: Record<string, any>) => {
      m.original.ordinal = 2;
    }, 'conflict', 'original_receipt_mismatch'],
    ['conversation fingerprint', (m: Record<string, any>) => {
      m.original.conversationFingerprint = sha('other');
    }, 'conflict', 'wrong_conversation'],
    ['context witness digest', (m: Record<string, any>) => {
      m.proofs[0].sha256 = sha('other');
    }, 'conflict', 'digest_mismatch'],
    ['context witness missing', (m: Record<string, any>) => {
      m.proofs = [];
    }, 'blocked', 'context_witness_missing'],
    ['decision time before the original receipt', (m: Record<string, any>) => {
      m.decidedAt = '2020-01-01T00:00:00.000Z';
    }, 'conflict', 'invalid_time'],
    ['observation time in the future', (m: Record<string, any>) => {
      m.observedAt = '2027-01-01T00:00:00.000Z';
    }, 'conflict', 'invalid_time'],
  ])('altered %s is rejected atomically', (_label, alter, kind, condition) => {
    const fx = buildFixture();
    const manifest = addressed(fx, 1) as Record<string, any>;
    alter(manifest);
    expectRejected(apply(fx, 'altered', manifest), kind as 'blocked' | 'conflict', condition);
    expect(closures(fx)).toBe(0);
  });

  it('resolves evidence only beneath the protected root', () => {
    const fx = buildFixture();
    const missing = addressed(fx, 1, {
      proofs: [{ role: 'context_witness', path: 'witness/absent.json', sha256: sha('x') }],
    });
    expectRejected(apply(fx, 'missing', missing), 'blocked', 'evidence_missing');

    const dotdot = addressed(fx, 1, {
      proofs: [{ role: 'context_witness', path: '../bot.db', sha256: sha('x') }],
    });
    expectRejected(apply(fx, 'dotdot', dotdot), 'conflict', 'evidence_path_invalid');

    writePrivate(join(fx.root, 'outside.json'), '{}\n');
    symlinkSync(join(fx.root, 'outside.json'), join(fx.evidenceRoot, 'witness', 'escape.json'));
    const escape = addressed(fx, 1, {
      proofs: [{ role: 'context_witness', path: 'witness/escape.json', sha256: sha('{}\n') }],
    });
    expectRejected(apply(fx, 'escape', escape), 'conflict', 'evidence_path_escape');
    expect(closures(fx)).toBe(0);
  });

  it('refuses an evidence root other users can write', () => {
    const fx = buildFixture();
    const rel = writeManifest(fx, 'text', addressed(fx, 1));
    chmodSync(fx.evidenceRoot, 0o777);
    try {
      expectRejected(run(fx, 'apply', rel), 'blocked', 'evidence_root_unprotected');
    } finally {
      chmodSync(fx.evidenceRoot, 0o700);
    }
  });
});

describe('close-continuity-gap apply: declined', () => {
  it('is Blocked without an owner-approved authority policy', () => {
    const fx = buildFixture();
    expectRejected(apply(fx, 'no-policy', declined(fx, 1, 'original_sender_inbound')),
      'blocked', 'policy_unavailable');
    expect(closures(fx)).toBe(0);
  });

  it('accepts the original sender declining their own receipt in the same conversation', () => {
    const fx = buildFixture();
    const policy = writePolicy(fx);
    const result = apply(fx, 'sender', declined(fx, 1, 'original_sender_inbound'),
      policyArgs(policy));
    expect(result.output).toMatchObject({ ok: true, decision: 'applied', disposition: 'declined' });
    const raw = new DatabaseSync(fx.dbPath, { readOnly: true });
    try {
      expect(raw.prepare('SELECT policy_sha256, policy_version, decision_source FROM continuity_gap_closures')
        .get()).toEqual({
        policy_sha256: sha(readFileSync(policy)),
        policy_version: 'fixture-policy-1',
        decision_source: 'original_sender_inbound@1',
      });
    } finally {
      raw.close();
    }
  });

  it('accepts a named owner declining an explicitly listed receipt', () => {
    const fx = buildFixture();
    const result = apply(fx, 'owner', declined(fx, 2, 'owner_inbound'), policyArgs(writePolicy(fx)));
    expect(result.output).toMatchObject({ ok: true, decision: 'applied' });
  });

  it('rejects an unrelated sender', () => {
    const fx = buildFixture();
    const manifest = declined(fx, 1, 'original_sender_inbound') as Record<string, any>;
    manifest.decision.inboundSeq = fx.seqs.stranger;
    manifest.decision.messageSha256 = sha('fixture-stranger-1');
    manifest.decision.record = decisionRecord(fx, 1, 'fixture-stranger-1', 'drop it', 'stranger');
    expectRejected(apply(fx, 'stranger', manifest, policyArgs(writePolicy(fx))),
      'conflict', 'decision_actor_mismatch');
  });

  it('rejects the correct actor deciding in the wrong conversation', () => {
    const fx = buildFixture();
    const manifest = declined(fx, 1, 'original_sender_inbound') as Record<string, any>;
    manifest.decision.inboundSeq = fx.seqs.declineElsewhere;
    manifest.decision.messageSha256 = sha('fixture-decline-2');
    manifest.decision.record = decisionRecord(fx, 1, 'fixture-decline-2', 'never mind', 'elsewhere');
    expectRejected(apply(fx, 'elsewhere', manifest, policyArgs(writePolicy(fx))),
      'conflict', 'wrong_conversation');
  });

  it('rejects a stale policy', () => {
    const fx = buildFixture();
    const policy = writePolicy(fx, { effectiveUntil: '2026-09-20T00:00:00.000Z' });
    expectRejected(apply(fx, 'stale', declined(fx, 1, 'original_sender_inbound'), policyArgs(policy)),
      'blocked', 'policy_not_effective');
  });

  it('rejects a fabricated operator role claiming owner authority', () => {
    const fx = buildFixture();
    const manifest = declined(fx, 1, 'owner_inbound', {
      actor: 'owner:self-asserted',
      authority: 'owner',
    }) as Record<string, any>;
    manifest.decision.inboundSeq = fx.seqs.stranger;
    manifest.decision.messageSha256 = sha('fixture-stranger-1');
    manifest.decision.record = decisionRecord(fx, 1, 'fixture-stranger-1', 'drop it', 'fabricated');
    expectRejected(apply(fx, 'fabricated', manifest, policyArgs(writePolicy(fx))),
      'conflict', 'decision_actor_not_owner');
  });

  it('rejects changed decision bytes', () => {
    const fx = buildFixture();
    const manifest = declined(fx, 1, 'original_sender_inbound') as Record<string, any>;
    manifest.decision.record = decisionRecord(fx, 1, 'fixture-decline-1', 'something else', 'edited');
    expectRejected(apply(fx, 'edited', manifest, policyArgs(writePolicy(fx))),
      'conflict', 'decision_bytes_changed');

    const tampered = declined(fx, 1, 'original_sender_inbound') as Record<string, any>;
    writeFileSync(join(fx.evidenceRoot, tampered.decision.record.path), '{"tampered":true}\n');
    expectRejected(apply(fx, 'tampered', tampered, policyArgs(writePolicy(fx))),
      'conflict', 'digest_mismatch');
  });

  it('keeps an owner session export Blocked: no independent verifier exists', () => {
    const fx = buildFixture();
    expectRejected(
      apply(fx, 'export', declined(fx, 1, 'owner_session_export'), policyArgs(writePolicy(fx))),
      'blocked',
      'decision_source_unverified',
    );
  });

  it('blocks a decision source the policy does not accept', () => {
    const fx = buildFixture();
    const policy = writePolicy(fx, {
      acceptedDecisionSources: [{ verifierId: 'owner_inbound', version: 1 }],
    });
    expectRejected(apply(fx, 'unaccepted', declined(fx, 1, 'original_sender_inbound'),
      policyArgs(policy)), 'blocked', 'decision_source_not_accepted');
  });

  it('blocks a policy for another instance or readable by other users', () => {
    const fx = buildFixture();
    const other = writePolicy(fx, { instanceId: 'other-instance' });
    expectRejected(apply(fx, 'instance', declined(fx, 1, 'original_sender_inbound'),
      policyArgs(other)), 'blocked', 'instance_mismatch');
    const readable = writePolicy(fx, {}, 0o644);
    expectRejected(apply(fx, 'readable', declined(fx, 1, 'original_sender_inbound'),
      policyArgs(readable)), 'blocked', 'policy_unprotected');
    expect(closures(fx)).toBe(0);
  });

  it('refuses a decline that claims a transcript or a live reissue', () => {
    const fx = buildFixture();
    const policy = policyArgs(writePolicy(fx));
    expectRejected(apply(fx, 'decline-audio', declined(fx, 2, 'original_sender_inbound', {
      audio: { mediaSha256: fx.files.media.sha256, transcriptSha256: fx.files.transcript.sha256,
        enrichmentComplete: true },
    }), policy), 'conflict', 'invalid_proof_shape');
    expectRejected(apply(fx, 'decline-live', declined(fx, 1, 'original_sender_inbound', {
      liveInbound: { seq: fx.seqs.live, messageSha256: sha('fixture-live-1') },
    }), policy), 'conflict', 'invalid_proof_shape');
    expect(closures(fx)).toBe(0);
  });
});
