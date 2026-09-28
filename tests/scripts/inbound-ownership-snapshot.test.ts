import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInboundOwnershipSnapshotCli } from '../../scripts/inbound-ownership-snapshot.ts';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import { shortHash } from '../../src/lib/short-hash.ts';

const NOW_SECONDS = Math.floor(Date.now() / 1000);
const CHAT_KEY = 'SENTINEL-CONVERSATION-KEY';
const CHAT_JID = 'SENTINEL-CHAT-JID@s.whatsapp.net';

const tempRoots: string[] = [];
const writers: Database[] = [];

/** The writer stays open (as on a live instance) so the WAL sidecars exist for the read-only open. */
function seedDatabase(): { root: string; dbPath: string; seq: number } {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-ownership-cli-'));
  tempRoots.push(root);
  const dbPath = path.join(root, 'bot.db');
  const db = new Database(dbPath);
  db.open();
  writers.push(db);
  const seq = new DurabilityEngine(db).journalInbound(
    'SENTINEL-MESSAGE-ID', CHAT_KEY, CHAT_JID, 'agent', NOW_SECONDS - 40 * 60,
  );
  return { root, dbPath, seq };
}

function activeTurnProviderExecution(): Record<string, unknown> {
  return {
    active: true,
    activeWorkKind: 'turn',
    activeScopeHash: shortHash(CHAT_JID),
    activeAgeMs: 60_000,
    activePhase: 'executing',
    progressAgeMs: 500,
    pending: 0,
    oldestPendingWorkKind: null,
    oldestPendingScopeHash: null,
    oldestWaitMs: 0,
    totalWaits: 0,
    maxPending: 0,
    lastWaitMs: 0,
    abortedWaits: 0,
    pressureActive: false,
  };
}

const STALE_SECONDS = NOW_SECONDS - 10 * 60;

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * Writes a capture file with a pinned mtime. The mtime is set deliberately so
 * tests can prove it is NOT the freshness source: a copied, touched or re-saved
 * file must not make an old body look fresh.
 */
function writeCapture(filePath: string, body: unknown, mtimeSeconds = NOW_SECONDS): void {
  writeFileSync(filePath, JSON.stringify(body));
  utimesSync(filePath, mtimeSeconds, mtimeSeconds);
}

/** A saved /health body: its own `generated_at` dates the capture. */
function healthBody(generatedAtSeconds: number): Record<string, unknown> {
  return {
    status: 'healthy',
    generated_at: iso(generatedAtSeconds),
    runtime: { agent: { providerExecution: activeTurnProviderExecution() } },
  };
}

interface CliSnapshot {
  providerExecutionEvidence: string;
  providerCaptureTimeSource: string;
  healthy: boolean;
  rows: unknown[];
}

function run(argv: string[]): { code: number; output: string } {
  let output = '';
  const code = runInboundOwnershipSnapshotCli(argv, (chunk) => { output += chunk; }, NOW_SECONDS * 1000);
  return { code, output };
}

afterEach(() => {
  for (const writer of writers.splice(0)) writer.close();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('inbound-ownership-snapshot CLI (#3560)', () => {
  it('joins a saved health body and exits 0 when every stale row has an owner, printing no content', () => {
    const { root, dbPath, seq } = seedDatabase();
    const healthPath = path.join(root, 'health.json');
    writeCapture(healthPath, healthBody(NOW_SECONDS));

    const { code, output } = run(['--db', dbPath, '--provider-execution-json', healthPath]);

    expect(code).toBe(0);
    const snapshot = JSON.parse(output) as CliSnapshot;
    expect(snapshot.providerExecutionEvidence).toBe('supplied');
    expect(snapshot.rows).toEqual([
      expect.objectContaining({ inboundSeq: seq, classification: 'executing', healthy: true }),
    ]);
    expect(output).not.toContain('SENTINEL');
    expect(output).not.toContain(root);
  });

  it('judges freshness by the body generated_at, never the file mtime', () => {
    const { root, dbPath, seq } = seedDatabase();

    // An old body re-saved into a fresh file: still stale.
    const oldBodyFreshFile = path.join(root, 'old-body.json');
    writeCapture(oldBodyFreshFile, healthBody(STALE_SECONDS), NOW_SECONDS);
    const oldBody = run(['--db', dbPath, '--provider-execution-json', oldBodyFreshFile]);
    const oldSnapshot = JSON.parse(oldBody.output) as CliSnapshot;
    expect(oldSnapshot.providerExecutionEvidence).toBe('stale');
    expect(oldSnapshot.providerCaptureTimeSource).toBe('payload_generated_at');
    expect(oldSnapshot.rows).toEqual([
      expect.objectContaining({ inboundSeq: seq, classification: 'no_owner', healthy: false }),
    ]);
    expect(oldBody.code).toBe(3);

    // A fresh body in a file with an old mtime: fresh.
    const freshBodyOldFile = path.join(root, 'fresh-body.json');
    writeCapture(freshBodyOldFile, healthBody(NOW_SECONDS), STALE_SECONDS);
    const freshBody = run(['--db', dbPath, '--provider-execution-json', freshBodyOldFile]);
    const freshSnapshot = JSON.parse(freshBody.output) as CliSnapshot;
    expect(freshSnapshot.providerExecutionEvidence).toBe('supplied');
    expect(freshSnapshot.rows).toEqual([
      expect.objectContaining({ inboundSeq: seq, classification: 'executing', healthy: true }),
    ]);
    expect(freshBody.code).toBe(0);

    // The payload timestamp wins: a fresh operator flag cannot rescue an old body.
    const overridden = run([
      '--db', dbPath, '--provider-execution-json', oldBodyFreshFile, '--provider-captured-at', iso(NOW_SECONDS),
    ]);
    expect(overridden.code).toBe(3);
    expect(JSON.parse(overridden.output)).toMatchObject({
      providerExecutionEvidence: 'stale',
      providerCaptureTimeSource: 'payload_generated_at',
    });
  });

  it('dates a body without generated_at by --provider-captured-at, and treats an undated capture as stale', () => {
    const { root, dbPath, seq } = seedDatabase();
    const barePath = path.join(root, 'provider-execution.json');
    // Bare object: no generated_at. The old mtime proves the flag, not the file, dates it.
    writeCapture(barePath, activeTurnProviderExecution(), STALE_SECONDS);

    const flagged = run(['--db', dbPath, '--provider-execution-json', barePath, '--provider-captured-at', iso(NOW_SECONDS)]);
    expect(flagged.code).toBe(0);
    expect(JSON.parse(flagged.output)).toMatchObject({
      providerExecutionEvidence: 'supplied',
      providerCaptureTimeSource: 'operator_flag',
      healthy: true,
      rows: [expect.objectContaining({ inboundSeq: seq, classification: 'executing' })],
    });

    const oldFlag = run(['--db', dbPath, '--provider-execution-json', barePath, '--provider-captured-at', iso(STALE_SECONDS)]);
    expect(oldFlag.code).toBe(3);
    expect(JSON.parse(oldFlag.output)).toMatchObject({
      providerExecutionEvidence: 'stale',
      providerCaptureTimeSource: 'operator_flag',
    });

    // Neither a payload timestamp nor a flag: freshness is unknown, which is stale, even
    // in a file written this second.
    writeCapture(barePath, activeTurnProviderExecution(), NOW_SECONDS);
    const undated = run(['--db', dbPath, '--provider-execution-json', barePath]);
    expect(JSON.parse(undated.output)).toMatchObject({
      providerExecutionEvidence: 'stale',
      providerCaptureTimeSource: 'unknown',
      healthy: false,
      rows: [expect.objectContaining({ inboundSeq: seq, classification: 'no_owner', healthy: false })],
    });
    expect(undated.code).toBe(3);

    const malformed = run(['--db', dbPath, '--provider-execution-json', barePath, '--provider-captured-at', 'yesterday']);
    expect(malformed.code).toBe(2);
    expect(JSON.parse(malformed.output)).toEqual({ schemaVersion: 1, ok: false, reason: 'usage_error' });
  });

  it('exits 3 when a stale processing inbound has no attributable owner', () => {
    const { dbPath, seq } = seedDatabase();

    const { code, output } = run(['--db', dbPath, '--min-age-minutes', '15']);

    const snapshot = JSON.parse(output) as { healthy: boolean; rows: unknown[] };
    expect(snapshot.rows).toEqual([
      expect.objectContaining({ inboundSeq: seq, classification: 'no_owner', healthy: false }),
    ]);
    expect(snapshot.healthy).toBe(false);
    expect(code).toBe(3);
  });

  it('refuses an invalid capture or a missing database', () => {
    const { root, dbPath } = seedDatabase();
    const invalidPath = path.join(root, 'invalid.json');
    writeCapture(invalidPath, { active: 'yes' });

    const invalid = run(['--db', dbPath, '--provider-execution-json', invalidPath]);
    expect(invalid.code).toBe(2);
    expect(JSON.parse(invalid.output)).toEqual({ schemaVersion: 1, ok: false, reason: 'provider_execution_invalid' });

    const missing = run(['--db', path.join(root, 'absent.db')]);
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.output)).toEqual({ schemaVersion: 1, ok: false, reason: 'database_missing' });
  });
});
