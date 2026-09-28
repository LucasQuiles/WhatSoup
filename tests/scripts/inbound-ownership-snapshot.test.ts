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

/** The CLI dates a capture by its file mtime; pin it so the freshness check is deterministic. */
function writeCapture(filePath: string, body: unknown, capturedAtSeconds = NOW_SECONDS): void {
  writeFileSync(filePath, JSON.stringify(body));
  utimesSync(filePath, capturedAtSeconds, capturedAtSeconds);
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
    writeCapture(healthPath, {
      status: 'healthy',
      runtime: { agent: { providerExecution: activeTurnProviderExecution() } },
    });

    const { code, output } = run(['--db', dbPath, '--provider-execution-json', healthPath]);

    expect(code).toBe(0);
    const snapshot = JSON.parse(output) as { providerExecutionEvidence: string; rows: unknown[] };
    expect(snapshot.providerExecutionEvidence).toBe('supplied');
    expect(snapshot.rows).toEqual([
      expect.objectContaining({ inboundSeq: seq, classification: 'executing', healthy: true }),
    ]);
    expect(output).not.toContain('SENTINEL');
    expect(output).not.toContain(root);
  });

  it('refuses a capture file older than the freshness bound as an execution owner and exits 3', () => {
    const { root, dbPath, seq } = seedDatabase();
    const healthPath = path.join(root, 'health.json');
    writeCapture(healthPath, {
      runtime: { agent: { providerExecution: activeTurnProviderExecution() } },
    }, NOW_SECONDS - 10 * 60);

    const { code, output } = run(['--db', dbPath, '--provider-execution-json', healthPath]);

    const snapshot = JSON.parse(output) as { providerExecutionEvidence: string; rows: unknown[] };
    expect(snapshot.providerExecutionEvidence).toBe('stale');
    expect(snapshot.rows).toEqual([
      expect.objectContaining({ inboundSeq: seq, classification: 'no_owner', healthy: false }),
    ]);
    expect(code).toBe(3);
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

  it('accepts a bare providerExecution object and refuses an invalid capture or a missing database', () => {
    const { root, dbPath } = seedDatabase();
    const barePath = path.join(root, 'provider-execution.json');
    writeCapture(barePath, activeTurnProviderExecution());
    const invalidPath = path.join(root, 'invalid.json');
    writeCapture(invalidPath, { active: 'yes' });

    const bare = run(['--db', dbPath, '--provider-execution-json', barePath]);
    expect(bare.code).toBe(0);
    expect(JSON.parse(bare.output)).toMatchObject({ providerExecutionEvidence: 'supplied', healthy: true });

    const invalid = run(['--db', dbPath, '--provider-execution-json', invalidPath]);
    expect(invalid.code).toBe(2);
    expect(JSON.parse(invalid.output)).toEqual({ schemaVersion: 1, ok: false, reason: 'provider_execution_invalid' });

    const missing = run(['--db', path.join(root, 'absent.db')]);
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.output)).toEqual({ schemaVersion: 1, ok: false, reason: 'database_missing' });
  });
});
