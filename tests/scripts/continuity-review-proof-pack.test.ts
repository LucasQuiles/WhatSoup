import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import { run } from '../../scripts/continuity-review-proof-pack.ts';

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = path.join(tmpdir(), `whatsoup-review-proof-pack-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

function makeMigratedDb(dbPath: string): { db: Database; engine: DurabilityEngine } {
  const db = new Database(dbPath);
  db.open();
  return { db, engine: new DurabilityEngine(db) };
}

function seedReviewIntent(engine: DurabilityEngine): void {
  const seq = engine.journalInbound('pack-proof-msg', 'pack-proof-key', 'pack-proof-jid', 'agent');
  engine.markContinuityCandidateIfNoTerminalOutbound(
    seq,
    'runtime_fault_no_terminal_outbound',
    'runtime_fault_disarm',
  );
  expect(engine.enqueueContinuityReviewIntents()).toEqual({ inserted: 1 });
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('continuity-review-proof-pack', () => {
  it('writes a proof artifact plus a redaction-safe manifest without DB paths or raw row values', () => {
    const root = makeRoot();
    const dbPath = path.join(root, 'bot.db');
    const outDir = path.join(root, 'pack');
    const { db, engine } = makeMigratedDb(dbPath);
    seedReviewIntent(engine);
    db.close();

    const pack = run(['--db', dbPath, '--out-dir', outDir], root);

    expect(process.exitCode).toBeUndefined();
    expect(pack).not.toBeNull();
    const proofPath = path.join(outDir, 'continuity-review-proof.json');
    const manifestPath = path.join(outDir, 'manifest.json');
    expect(existsSync(proofPath)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);

    const proofText = readFileSync(proofPath, 'utf8');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      schemaVersion: number;
      payloadType: string;
      artifacts: Array<{ path: string; sha256: string; sizeBytes: number; secretScan: string }>;
    };
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      payloadType: 'continuity-review-proof-pack',
      artifacts: [
        {
          path: 'continuity-review-proof.json',
          sha256: sha256(proofText),
          sizeBytes: Buffer.byteLength(proofText),
          secretScan: 'pass',
        },
      ],
    });

    const serialized = `${proofText}\n${JSON.stringify(manifest)}`;
    expect(serialized).not.toContain(dbPath);
    expect(serialized).not.toContain('pack-proof-key');
    expect(serialized).not.toContain('pack-proof-jid');
    expect(serialized).not.toContain('pack-proof-msg');
  });

  it('fails closed without writing a partial pack for an unmigrated database', () => {
    const root = makeRoot();
    const dbPath = path.join(root, 'empty.db');
    const outDir = path.join(root, 'pack');
    const raw = new DatabaseSync(dbPath);
    raw.close();
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const pack = run(['--db', dbPath, '--out-dir', outDir], root);

    expect(pack).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(existsSync(path.join(outDir, 'continuity-review-proof.json'))).toBe(false);
    expect(existsSync(path.join(outDir, 'manifest.json'))).toBe(false);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('schema_migrations'));
  });
});
