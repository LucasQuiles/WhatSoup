import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTokenWindowReport,
  parseArgs,
  parseWindowSeconds,
  readTokenWindow,
} from '../../scripts/token-window.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const scriptPath = path.join(repoRoot, 'scripts/token-window.ts');
const packageJson = JSON.parse(
  execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify(require("./package.json")))'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }),
) as { scripts: Record<string, string> };

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-token-window-'));
  tempRoots.push(root);
  return root;
}

function makeInstance(name = 'target bot'): { root: string; instancePath: string; dbPath: string } {
  const root = makeTempRoot();
  const instancePath = path.join(root, name);
  mkdirSync(instancePath, { recursive: true });
  return { root, instancePath, dbPath: path.join(instancePath, 'bot.db') };
}

function createTokenDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE agent_sessions (
      id INTEGER PRIMARY KEY,
      session_id TEXT,
      claude_pid INTEGER,
      started_in_directory TEXT,
      transcript_path TEXT,
      started_at TEXT NOT NULL,
      last_message_at TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE agent_token_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_session_id INTEGER NOT NULL REFERENCES agent_sessions(id),
      timestamp INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX idx_agent_token_events_ts ON agent_token_events(timestamp);
    CREATE INDEX idx_agent_token_events_session_ts ON agent_token_events(agent_session_id, timestamp);
  `);
  db.prepare(`
    INSERT INTO agent_sessions (id, claude_pid, started_in_directory, started_at, status)
    VALUES (1, 123, '/tmp', datetime('now'), 'active')
  `).run();
  return db;
}

function insertTokenEvent(
  db: DatabaseSync,
  timestamp: number,
  inputTokens: number,
  outputTokens: number,
): void {
  db.prepare(`
    INSERT INTO agent_token_events (agent_session_id, timestamp, input_tokens, output_tokens)
    VALUES (1, ?, ?, ?)
  `).run(timestamp, inputTokens, outputTokens);
}

function runTokenWindow(instancePath: string, window = '5h'): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, [
    '--experimental-strip-types',
    scriptPath,
    '--instance',
    instancePath,
    '--window',
    window,
    '--json',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

function makeWritableRecursive(targetPath: string): void {
  chmodSync(targetPath, 0o700);
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    const entryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      makeWritableRecursive(entryPath);
    } else {
      chmodSync(entryPath, 0o600);
    }
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    makeWritableRecursive(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('token-window helper', () => {
  it('is exposed through the package scripts', () => {
    expect(packageJson.scripts['token-window']).toBe(
      'bash scripts/run-with-pinned-node.sh scripts/token-window.ts',
    );
  });

  it('covers the importable report path against the real SQLite query', () => {
    const { instancePath, dbPath } = makeInstance('direct fixture');
    const nowSec = Math.floor(Date.now() / 1000);
    const db = createTokenDb(dbPath);
    insertTokenEvent(db, nowSec - 10, 11, 2);
    insertTokenEvent(db, nowSec - 20, 13, 4);
    db.close();

    expect(parseArgs(['--instance', instancePath, '--window', '5m', '--json'])).toEqual({
      instance: instancePath,
      window: '5m',
      json: true,
    });
    expect(parseWindowSeconds('5m')).toBe(300);
    expect(readTokenWindow(dbPath, 300)).toMatchObject({
      input_tokens: 24,
      output_tokens: 6,
      event_count: 2,
    });
    expect(buildTokenWindowReport(instancePath, '5m')).toMatchObject({
      instance: 'direct fixture',
      window_seconds: 300,
      total_tokens: 30,
      input_tokens: 24,
      output_tokens: 6,
      event_count: 2,
    });
  });

  it('returns the v1 JSON shape reconciled with a direct SQLite sum', () => {
    const { instancePath, dbPath } = makeInstance('target bot');
    const nowSec = Math.floor(Date.now() / 1000);
    const db = createTokenDb(dbPath);
    insertTokenEvent(db, nowSec - 60, 1000, 100);
    insertTokenEvent(db, nowSec - 120, 2000, 200);
    insertTokenEvent(db, nowSec - (6 * 60 * 60), 9000, 900);
    db.close();

    const output = runTokenWindow(instancePath, '5h');
    const directDb = new DatabaseSync(dbPath, { readOnly: true });
    const direct = directDb.prepare(`
      SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COUNT(*) AS event_count,
             MIN(timestamp) AS earliest_ts,
             MAX(timestamp) AS latest_ts
        FROM agent_token_events
       WHERE timestamp >= ?
    `).get(nowSec - (5 * 60 * 60)) as {
      input_tokens: number;
      output_tokens: number;
      event_count: number;
      earliest_ts: number;
      latest_ts: number;
    };
    directDb.close();

    expect(output).toEqual({
      instance: 'target bot',
      window_seconds: 18_000,
      total_tokens: direct.input_tokens + direct.output_tokens,
      input_tokens: direct.input_tokens,
      output_tokens: direct.output_tokens,
      event_count: direct.event_count,
      sources: {
        whatsoup_db: {
          available: true,
          earliest_ts: direct.earliest_ts,
          latest_ts: direct.latest_ts,
        },
      },
    });
    expect(output).not.toHaveProperty('by_tool');
    expect(output).not.toHaveProperty('estimated_cost_usd');
  });

  it('counts already-normalized cache-token input exactly once', () => {
    const { instancePath, dbPath } = makeInstance('cache fixture');
    const nowSec = Math.floor(Date.now() / 1000);
    const db = createTokenDb(dbPath);

    // Parser fixture shape: input_tokens=2000, cache_creation=1000,
    // cache_read=500. Persistence stores the normalized total only.
    insertTokenEvent(db, nowSec - 30, 3500, 25);
    const stored = db.prepare(`
      SELECT input_tokens FROM agent_token_events LIMIT 1
    `).get() as { input_tokens: number };
    db.close();

    const output = runTokenWindow(instancePath, '5h');

    expect(stored.input_tokens).toBe(3500);
    expect(output.input_tokens).toBe(3500);
    expect(output.output_tokens).toBe(25);
    expect(output.total_tokens).toBe(3525);
    expect(output.event_count).toBe(1);
  });

  it('opens the database read-only', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }
    const { root, instancePath, dbPath } = makeInstance('read only');
    const nowSec = Math.floor(Date.now() / 1000);
    const db = createTokenDb(dbPath);
    insertTokenEvent(db, nowSec - 30, 40, 2);
    db.close();
    chmodSync(dbPath, 0o444);
    chmodSync(instancePath, 0o555);
    chmodSync(root, 0o555);

    const output = runTokenWindow(instancePath, '5h');

    expect(output.sources).toEqual({
      whatsoup_db: {
        available: true,
        earliest_ts: nowSec - 30,
        latest_ts: nowSec - 30,
      },
    });
    expect(output.total_tokens).toBe(42);
  });

  it('exits non-zero when the instance directory is missing', () => {
    const missingPath = path.join(makeTempRoot(), 'missing-instance');

    expect(() => runTokenWindow(missingPath, '5h')).toThrow(/missing instance directory/);
  });

  it('exits non-zero when bot.db is missing', () => {
    const { instancePath } = makeInstance('no db');

    expect(() => runTokenWindow(instancePath, '5h')).toThrow(/missing bot\.db/);
  });

  it('parses windows strictly', () => {
    const { instancePath, dbPath } = makeInstance('window fixture');
    const db = createTokenDb(dbPath);
    db.close();

    expect(runTokenWindow(instancePath, '10s').window_seconds).toBe(10);
    expect(runTokenWindow(instancePath, '30m').window_seconds).toBe(1800);
    expect(runTokenWindow(instancePath, '5h').window_seconds).toBe(18_000);

    for (const invalid of ['5', '5d', '0h', '-1h', '1.5h', 'abc']) {
      expect(() => runTokenWindow(instancePath, invalid)).toThrow(/invalid window/);
    }
  });

  it('returns a 10000-event local fixture in under one second', () => {
    const { instancePath, dbPath } = makeInstance('perf fixture');
    const nowSec = Math.floor(Date.now() / 1000);
    const db = createTokenDb(dbPath);
    const insert = db.prepare(`
      INSERT INTO agent_token_events (agent_session_id, timestamp, input_tokens, output_tokens)
      VALUES (1, ?, ?, ?)
    `);
    db.exec('BEGIN');
    for (let i = 0; i < 10_000; i += 1) {
      insert.run(nowSec - (i % 3600), 3, 1);
    }
    db.exec('COMMIT');
    db.close();

    const started = performance.now();
    const output = runTokenWindow(instancePath, '5h');
    const elapsedMs = performance.now() - started;

    expect(output.event_count).toBe(10_000);
    expect(output.input_tokens).toBe(30_000);
    expect(output.output_tokens).toBe(10_000);
    expect(elapsedMs).toBeLessThan(1000);
  });
});
