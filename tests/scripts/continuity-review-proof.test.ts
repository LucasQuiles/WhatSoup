import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import { run } from '../../scripts/continuity-review-proof.ts';

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = path.join(tmpdir(), `whatsoup-review-proof-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

function makeMigratedDb(dbPath: string): { db: Database; engine: DurabilityEngine } {
  const db = new Database(dbPath);
  db.open();
  return { db, engine: new DurabilityEngine(db) };
}

function seedReviewIntents(engine: DurabilityEngine): void {
  const pending = engine.journalInbound('proof-pending-msg', 'proof-key-pending', 'proof-jid-pending', 'agent');
  const resolved = engine.journalInbound('proof-resolved-msg', 'proof-key-resolved', 'proof-jid-resolved', 'agent');
  const dismissed = engine.journalInbound('proof-dismissed-msg', 'proof-key-dismissed', 'proof-jid-dismissed', 'agent');

  for (const seq of [pending, resolved, dismissed]) {
    engine.markContinuityCandidateIfNoTerminalOutbound(
      seq,
      'runtime_fault_no_terminal_outbound',
      'runtime_fault_disarm',
    );
  }
  expect(engine.enqueueContinuityReviewIntents()).toEqual({ inserted: 3 });

  engine.createOutboundOp({
    conversationKey: 'proof-key-resolved',
    chatJid: 'proof-jid-resolved',
    opType: 'text',
    payload: '{"text":"resolved body must stay out"}',
    replayPolicy: 'unsafe',
    sourceInboundSeq: resolved,
    isTerminal: true,
  });
  expect(engine.resolveContinuityReviewIntent(resolved, {
    actor: 'operator-secret-actor',
    reason: 'resolved reason mentions proof-key-resolved',
  })).toEqual({ updated: true, terminalOutboundExists: true });
  expect(engine.dismissContinuityReviewIntent(dismissed, {
    actor: 'operator-secret-actor',
    reason: 'dismissal reason mentions proof-jid-dismissed',
  })).toEqual({ updated: true });
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('continuity-review-proof', () => {
  it('writes a safe review-intent proof artifact from an already-migrated database', () => {
    const root = makeRoot();
    const dbPath = path.join(root, 'bot.db');
    const out = path.join(root, 'review-proof.json');
    const { db, engine } = makeMigratedDb(dbPath);
    seedReviewIntents(engine);
    db.close();

    const proof = run(['--db', dbPath, '--out', out], root);

    expect(process.exitCode).toBeUndefined();
    expect(proof).not.toBeNull();
    expect(existsSync(out)).toBe(true);
    const written = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    expect(written).toMatchObject({
      proof_class: 'probe',
      source_layer: 'durability',
      payload_type: 'continuity-review-intent-proof',
      payload: {
        verdict: 'pass',
        counts: {
          total: 3,
          pending_review: 1,
          resolved: 1,
          dismissed: 1,
          terminal_outbound_exists: 1,
          action_audited: 2,
        },
      },
    });
    const serialized = JSON.stringify(written);
    expect(serialized).not.toContain(dbPath);
    expect(serialized).not.toContain('proof-key-pending');
    expect(serialized).not.toContain('proof-key-resolved');
    expect(serialized).not.toContain('proof-key-dismissed');
    expect(serialized).not.toContain('proof-jid-pending');
    expect(serialized).not.toContain('proof-jid-resolved');
    expect(serialized).not.toContain('proof-jid-dismissed');
    expect(serialized).not.toContain('resolved body must stay out');
    expect(serialized).not.toContain('operator-secret-actor');
    expect(serialized).not.toContain('dismissal reason');
  });

  it('fails closed instead of migrating or writing proof for an unmigrated database', () => {
    const root = makeRoot();
    const dbPath = path.join(root, 'empty.db');
    const out = path.join(root, 'review-proof.json');
    const raw = new DatabaseSync(dbPath);
    raw.close();
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const proof = run(['--db', dbPath, '--out', out], root);

    expect(proof).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(existsSync(out)).toBe(false);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('schema_migrations'));
    const verify = new DatabaseSync(dbPath, { readOnly: true });
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
    verify.close();
  });
});
