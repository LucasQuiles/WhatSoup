/**
 * #3560 — ownership snapshot for inbounds stuck in `processing`.
 *
 * Real SQLite: the schema comes from the real migrations (Database#open), rows
 * are written through the real durability writers, and the snapshot reads the
 * file through a SECOND, read-only connection — the same shape the operator
 * script uses against a live instance database.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { shortHash } from '../../../src/lib/short-hash.ts';
import {
  readInboundOwnershipSnapshot,
  type InboundOwnershipRow,
  type InboundOwnershipSnapshot,
  type ProviderExecutionObservation,
} from '../../../src/runtimes/agent/inbound-ownership-snapshot.ts';

const NOW_SECONDS = Math.floor(Date.now() / 1000);
const NOW_MS = NOW_SECONDS * 1000;

interface Chat {
  readonly key: string;
  readonly jid: string;
}

const CHAT_A: Chat = { key: '15550100001', jid: '15550100001@s.whatsapp.net' };
const CHAT_B: Chat = { key: '15550100002', jid: '15550100002@s.whatsapp.net' };
const CHAT_C: Chat = { key: '15550100003', jid: '15550100003@s.whatsapp.net' };
const CHAT_D: Chat = { key: '15550100004', jid: '15550100004@s.whatsapp.net' };
const CHAT_E: Chat = { key: '15550100005', jid: '15550100005@s.whatsapp.net' };

const IDLE_PROVIDER: ProviderExecutionObservation = {
  active: false,
  activeWorkKind: null,
  activeScopeHash: null,
  activeAgeMs: 0,
  activePhase: 'executing',
  progressAgeMs: 0,
  pending: 0,
  oldestPendingWorkKind: null,
  oldestPendingScopeHash: null,
  oldestWaitMs: 0,
};

function activeTurnOn(jid: string): ProviderExecutionObservation {
  return {
    ...IDLE_PROVIDER,
    active: true,
    activeWorkKind: 'turn',
    activeScopeHash: shortHash(jid),
    activeAgeMs: 90_000,
    activePhase: 'executing',
    progressAgeMs: 1_234,
  };
}

interface Fixture {
  readonly dbPath: string;
  readonly db: Database;
  readonly engine: DurabilityEngine;
}

const tempRoots: string[] = [];
const writers: Database[] = [];
const readers: DatabaseSync[] = [];
let messageCounter = 0;

function openFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-inbound-ownership-'));
  tempRoots.push(root);
  const dbPath = path.join(root, 'bot.db');
  const db = new Database(dbPath);
  db.open();
  writers.push(db);
  return { dbPath, db, engine: new DurabilityEngine(db) };
}

/** A second connection that cannot write: any write the snapshot attempted would throw. */
function openReader(dbPath: string): DatabaseSync {
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  reader.exec('PRAGMA query_only = ON');
  readers.push(reader);
  return reader;
}

function journal(fixture: Fixture, chat: Chat, minutesAgo: number): number {
  messageCounter += 1;
  return fixture.engine.journalInbound(
    `wamid-ownership-${messageCounter}`,
    chat.key,
    chat.jid,
    'agent',
    NOW_SECONDS - minutesAgo * 60,
  );
}

function deferFollower(fixture: Fixture, chat: Chat, inboundSeq: number): void {
  fixture.engine.deferredTurns.enqueueDeferredObligation({
    scope: 'per_chat',
    conversationKey: chat.key,
    deliveryJid: chat.jid,
    inboundSeq,
    sourceMessageId: `wamid-deferred-${inboundSeq}`,
    receivedAtUnixSeconds: NOW_SECONDS - 30 * 60,
    replaySafe: true,
    senderJid: chat.jid,
    text: 'deferred follower',
    isGroup: false,
    contentType: 'text',
  });
}

function snapshotOf(
  fixture: Fixture,
  providerExecution: ProviderExecutionObservation | null,
): InboundOwnershipSnapshot {
  return readInboundOwnershipSnapshot(openReader(fixture.dbPath), {
    minAgeMinutes: 15,
    providerExecution,
    nowMs: NOW_MS,
  });
}

function rowFor(snapshot: InboundOwnershipSnapshot, seq: number): InboundOwnershipRow | undefined {
  return snapshot.rows.find((row) => row.inboundSeq === seq);
}

afterEach(() => {
  for (const reader of readers.splice(0)) reader.close();
  for (const writer of writers.splice(0)) writer.close();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('inbound ownership snapshot (#3560)', () => {
  it('T1: names the owner of every stale processing inbound under an idle provider and never omits a row', () => {
    const fixture = openFixture();
    const head = journal(fixture, CHAT_A, 40);
    const follower = journal(fixture, CHAT_A, 35);
    const deferred = journal(fixture, CHAT_B, 38);
    deferFollower(fixture, CHAT_B, deferred);
    const badClock = journal(fixture, CHAT_C, 45);
    fixture.db.raw.prepare(
      `UPDATE inbound_events SET received_at = 'not-a-timestamp' WHERE seq = ?`,
    ).run(badClock);
    const young = journal(fixture, CHAT_D, 1);

    const snapshot = snapshotOf(fixture, IDLE_PROVIDER);

    expect(snapshot.rows.map((row) => row.inboundSeq)).toEqual([head, follower, deferred, badClock]);
    expect(snapshot.counts).toEqual({
      processing: 5,
      reported: 4,
      queued: 1,
      deferred: 1,
      executing: 0,
      no_owner: 2,
    });
    expect(rowFor(snapshot, head)).toMatchObject({
      classification: 'no_owner',
      reason: 'no_attributable_owner',
      ageSeconds: 40 * 60,
      ageEvidence: 'valid',
      owner: { kind: 'none', inboundSeq: null },
      queue: { basis: 'persisted_open_inbounds', scope: 'per_chat', depth: 2, position: 1, headInboundSeq: head },
      providerExecution: { evidence: 'idle', pending: 0 },
    });
    expect(rowFor(snapshot, follower)).toMatchObject({
      classification: 'queued',
      reason: 'queued_behind_fifo_head',
      owner: { kind: 'fifo_head_inbound', inboundSeq: head },
      queue: { depth: 2, position: 2, headInboundSeq: head },
    });
    expect(rowFor(snapshot, deferred)).toMatchObject({
      classification: 'deferred',
      reason: 'deferred_obligation_open',
      owner: { kind: 'deferred_obligation' },
      deferredObligation: { status: 'pending', attemptCount: 0, claimEpoch: 0 },
    });
    expect(rowFor(snapshot, badClock)).toMatchObject({
      ageSeconds: null,
      ageEvidence: 'invalid_timestamp',
      classification: 'no_owner',
    });
    expect(rowFor(snapshot, young)).toBeUndefined();
  });

  it('T2: keeps no_owner distinct from queued and executing and never reports it healthy', () => {
    const fixture = openFixture();
    const orphanHead = journal(fixture, CHAT_A, 40);
    const behindOrphan = journal(fixture, CHAT_A, 30);
    const runningHead = journal(fixture, CHAT_E, 25);
    const behindRunning = journal(fixture, CHAT_E, 20);

    const snapshot = snapshotOf(fixture, activeTurnOn(CHAT_E.jid));

    expect(snapshot.rows.map((row) => row.inboundSeq))
      .toEqual([orphanHead, behindOrphan, runningHead, behindRunning]);
    expect(rowFor(snapshot, runningHead)).toMatchObject({
      classification: 'executing',
      reason: 'provider_execution_active',
      healthy: true,
      owner: { kind: 'provider_execution' },
      providerExecution: {
        evidence: 'active_this_scope',
        activePhase: 'executing',
        activeAgeMs: 90_000,
        progressAgeMs: 1_234,
      },
    });
    expect(rowFor(snapshot, behindRunning)).toMatchObject({
      classification: 'queued',
      healthy: true,
      owner: { kind: 'fifo_head_inbound', inboundSeq: runningHead },
    });
    expect(rowFor(snapshot, orphanHead)).toMatchObject({
      classification: 'no_owner',
      reason: 'no_attributable_owner',
      healthy: false,
      providerExecution: { evidence: 'active_other_scope' },
    });
    // Queued behind an orphan is still queued, but it is not healthy either.
    expect(rowFor(snapshot, behindOrphan)).toMatchObject({
      classification: 'queued',
      healthy: false,
      owner: { kind: 'fifo_head_inbound', inboundSeq: orphanHead },
    });
    const unowned = snapshot.rows.filter((row) => row.classification === 'no_owner');
    expect(unowned.map((row) => [row.inboundSeq, row.healthy])).toEqual([[orphanHead, false]]);
    expect(snapshot.counts).toMatchObject({ executing: 1, queued: 2, no_owner: 1 });
    expect(snapshot.healthy).toBe(false);
  });

  it('T2: without provider evidence an unowned head is no_owner, never executing and never healthy', () => {
    const fixture = openFixture();
    const head = journal(fixture, CHAT_E, 25);

    const snapshot = snapshotOf(fixture, null);

    expect(snapshot.providerExecutionEvidence).toBe('not_supplied');
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]).toMatchObject({
      inboundSeq: head,
      classification: 'no_owner',
      reason: 'no_persisted_owner_provider_not_observed',
      healthy: false,
      providerExecution: { evidence: 'not_supplied' },
    });
    expect(snapshot.healthy).toBe(false);
  });

  it('T2: a probe holding the provider lane never makes a chat row executing', () => {
    const fixture = openFixture();
    const head = journal(fixture, CHAT_E, 25);
    // Even a colliding scope hash must not attribute a probe hold to a chat turn.
    const probe: ProviderExecutionObservation = { ...activeTurnOn(CHAT_E.jid), activeWorkKind: 'probe' };

    const snapshot = snapshotOf(fixture, probe);

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]).toMatchObject({
      inboundSeq: head,
      classification: 'no_owner',
      healthy: false,
      providerExecution: { evidence: 'active_probe' },
    });
  });

  it('T3: output is content-free — no message text, message id, chat or sender identifier, or path', () => {
    const fixture = openFixture();
    const chat: Chat = { key: 'SENTINEL-CONVERSATION-KEY', jid: 'SENTINEL-CHAT-JID@s.whatsapp.net' };
    const head = fixture.engine.journalInbound(
      'SENTINEL-MESSAGE-ID-1', chat.key, chat.jid, 'agent', NOW_SECONDS - 40 * 60,
    );
    const follower = fixture.engine.journalInbound(
      'SENTINEL-MESSAGE-ID-2', chat.key, chat.jid, 'agent', NOW_SECONDS - 30 * 60,
    );
    fixture.engine.deferredTurns.enqueueDeferredObligation({
      scope: 'per_chat',
      conversationKey: chat.key,
      deliveryJid: chat.jid,
      inboundSeq: follower,
      sourceMessageId: 'SENTINEL-MESSAGE-ID-2',
      receivedAtUnixSeconds: NOW_SECONDS - 30 * 60,
      replaySafe: true,
      senderJid: 'SENTINEL-SENDER-JID@s.whatsapp.net',
      senderName: 'SENTINEL-SENDER-NAME',
      text: 'SENTINEL-MESSAGE-TEXT',
      isGroup: false,
      contentType: 'text',
    });
    fixture.engine.createOutboundOp({
      conversationKey: chat.key,
      chatJid: chat.jid,
      opType: 'text',
      payload: JSON.stringify({ text: 'SENTINEL-REPLY-TEXT' }),
      replayPolicy: 'safe',
      sourceInboundSeq: head,
      isTerminal: false,
    });

    const snapshot = snapshotOf(fixture, activeTurnOn(chat.jid));

    // Positive precondition first: the seeded rows and their evidence are present.
    expect(snapshot.rows.map((row) => row.inboundSeq)).toEqual([head, follower]);
    expect(rowFor(snapshot, head)).toMatchObject({
      chatScopeHash: shortHash(chat.jid),
      classification: 'executing',
      lastOutbound: { status: 'pending', isTerminal: false },
    });
    expect(rowFor(snapshot, follower)).toMatchObject({
      classification: 'deferred',
      deferredObligation: { status: 'pending' },
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('SENTINEL');
    expect(serialized).not.toContain(fixture.dbPath);
  });

  it('reads through a read-only connection and writes nothing', () => {
    const fixture = openFixture();
    const head = journal(fixture, CHAT_A, 40);
    const dataVersion = (): number =>
      (fixture.db.raw.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
    const versionBefore = dataVersion();
    const reader = openReader(fixture.dbPath);

    const snapshot = readInboundOwnershipSnapshot(reader, {
      minAgeMinutes: 15,
      providerExecution: IDLE_PROVIDER,
      nowMs: NOW_MS,
    });

    expect(snapshot.rows.map((row) => row.inboundSeq)).toEqual([head]);
    expect(reader.prepare('SELECT total_changes() AS n').get()).toEqual({ n: 0 });
    // data_version moves on this connection only when ANOTHER connection commits.
    expect(dataVersion()).toBe(versionBefore);
    expect(
      fixture.db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(head),
    ).toEqual({ processing_status: 'processing' });
  });
});
