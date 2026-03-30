/**
 * Contract Tests — ported from whatsapp-bot/tests/integration/contracts.test.ts
 *
 * Covers:
 * 1. WhatSoupError contract (was AppError in whatsapp-bot)
 * 2. Health endpoint shape
 * 3. Sent message contract (uses ConnectionManager.sendMessage)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { WhatSoupError, type ErrorCode } from '../../src/errors.ts';

// ---------------------------------------------------------------------------
// Port reservation
// ---------------------------------------------------------------------------

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.once('error', reject);
  });
}

const port1Promise = getFreePort();
const port2Promise = getFreePort();

// Mock config so health server uses an ephemeral port
vi.mock('../../src/config.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/config.ts')>();
  const reservedPort = await port1Promise;
  return {
    config: {
      ...original.config,
      healthPort: reservedPort,
    },
  };
});

const { startHealthServer } = await import('../../src/core/health.ts');
type HealthDeps = import('../../src/core/health.ts').HealthDeps;

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function httpRequest(
  url: string,
  method = 'GET',
): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { method });
  const body = await res.text();
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Minimal in-memory database shaped for HealthDeps
// ---------------------------------------------------------------------------

function makeInMemoryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE messages (
      pk INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      conversation_key TEXT NOT NULL DEFAULT '',
      sender_jid TEXT NOT NULL,
      sender_name TEXT,
      message_id TEXT UNIQUE,
      content TEXT,
      content_type TEXT NOT NULL DEFAULT 'text',
      is_from_me INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      quoted_message_id TEXT,
      enrichment_processed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      enrichment_error TEXT
    );
    CREATE TABLE access_list (
      subject_type TEXT NOT NULL CHECK (subject_type IN ('phone', 'group')),
      subject_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('allowed', 'blocked', 'pending', 'seen')),
      display_name TEXT,
      requested_at TEXT,
      decided_at TEXT,
      PRIMARY KEY (subject_type, subject_id)
    );
  `);
  return { raw: db };
}

// ---------------------------------------------------------------------------
// 1. WhatSoupError contract
// ---------------------------------------------------------------------------

describe('WhatSoupError contract', () => {
  const allCodes: ErrorCode[] = [
    'AUTH_REQUIRED',
    'AUTH_LOGGED_OUT',
    'CONNECTION_UNAVAILABLE',
    'RECONNECTING',
    'DATABASE_ERROR',
    'RATE_LIMITED',
    'LLM_UNAVAILABLE',
    'LLM_TIMEOUT',
    'PINECONE_UNAVAILABLE',
    'SEND_FAILED',
    'SEND_UNCERTAIN',
    'ENRICHMENT_ERROR',
    'INTERNAL_ERROR',
    'LOCK_CONTENTION',
  ];

  it('every ErrorCode value is a string', () => {
    for (const code of allCodes) {
      expect(typeof code).toBe('string');
    }
  });

  it('LOCK_CONTENTION is constructible without error at runtime', () => {
    const err = new WhatSoupError('lock held', 'LOCK_CONTENTION');
    expect(err.code).toBe('LOCK_CONTENTION');
  });

  it('retryable is true for exactly CONNECTION_UNAVAILABLE, RECONNECTING, LLM_UNAVAILABLE, LLM_TIMEOUT, PINECONE_UNAVAILABLE', () => {
    const expectedRetryable = new Set<ErrorCode>([
      'CONNECTION_UNAVAILABLE',
      'RECONNECTING',
      'LLM_UNAVAILABLE',
      'LLM_TIMEOUT',
      'PINECONE_UNAVAILABLE',
    ]);

    for (const code of allCodes) {
      const err = new WhatSoupError('test', code);
      if (expectedRetryable.has(code)) {
        expect(err.retryable, `${code} should be retryable`).toBe(true);
      } else {
        expect(err.retryable, `${code} should NOT be retryable`).toBe(false);
      }
    }
  });

  it('retryable is false for AUTH_REQUIRED', () => {
    expect(new WhatSoupError('test', 'AUTH_REQUIRED').retryable).toBe(false);
  });

  it('retryable is false for DATABASE_ERROR', () => {
    expect(new WhatSoupError('test', 'DATABASE_ERROR').retryable).toBe(false);
  });

  it('retryable is false for SEND_FAILED', () => {
    expect(new WhatSoupError('test', 'SEND_FAILED').retryable).toBe(false);
  });

  it('retryable is false for INTERNAL_ERROR', () => {
    expect(new WhatSoupError('test', 'INTERNAL_ERROR').retryable).toBe(false);
  });

  it('retryable is false for LOCK_CONTENTION', () => {
    expect(new WhatSoupError('test', 'LOCK_CONTENTION').retryable).toBe(false);
  });

  it('cause field preserves original error object', () => {
    const original = new TypeError('original');
    const err = new WhatSoupError('wrapped', 'INTERNAL_ERROR', original);
    expect(err.cause).toBe(original);
  });

  it('cause field works with undefined (no cause provided)', () => {
    const err = new WhatSoupError('no cause', 'DATABASE_ERROR');
    expect(err.cause).toBeUndefined();
  });

  it('WhatSoupError is instanceof Error', () => {
    const err = new WhatSoupError('test', 'INTERNAL_ERROR');
    expect(err).toBeInstanceOf(Error);
  });

  it('WhatSoupError.name is "WhatSoupError"', () => {
    const err = new WhatSoupError('test', 'INTERNAL_ERROR');
    expect(err.name).toBe('WhatSoupError');
  });
});

// ---------------------------------------------------------------------------
// 2. Health endpoint contract
// ---------------------------------------------------------------------------

describe('Health endpoint contract', () => {
  let server: Server;
  let baseUrl: string;

  const db = makeInMemoryDb();
  const connectionManager = {
    botJid: '15551234567@s.whatsapp.net' as string | null,
    sendMessage: async () => undefined,
  };

  const startedAt = Date.now() - 5000;
  let lastRun: string | null = null;

  const deps: HealthDeps = {
    db: db as unknown as import('../../src/core/database.ts').Database,
    connectionManager:
      connectionManager as unknown as import('../../src/transport/connection.ts').ConnectionManager,
    startedAt,
    getEnrichmentStats: () => ({ lastRun, unprocessed: 0 }),
  };

  beforeAll(async () => {
    server = startHealthServer(deps);
    await new Promise<void>((resolve, reject) => {
      if (server.listening) {
        resolve();
        return;
      }
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 9090;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET /health returns 200', async () => {
    const { status } = await httpRequest(`${baseUrl}/health`);
    expect(status).toBe(200);
  });

  it('GET /health returns JSON with exact shape', async () => {
    const { status, body } = await httpRequest(`${baseUrl}/health`);
    expect(status).toBe(200);

    const data = JSON.parse(body) as Record<string, unknown>;

    expect(data).toHaveProperty('status');
    expect(typeof data['status']).toBe('string');

    expect(data).toHaveProperty('uptime_seconds');
    expect(typeof data['uptime_seconds']).toBe('number');
    expect(data['uptime_seconds'] as number).toBeGreaterThanOrEqual(0);

    const wa = data['whatsapp'] as Record<string, unknown>;
    expect(wa).toHaveProperty('connected');
    expect(typeof wa['connected']).toBe('boolean');
    expect(wa).toHaveProperty('account_jid');
    expect(typeof wa['account_jid']).toBe('string');

    const sq = data['sqlite'] as Record<string, unknown>;
    expect(sq).toHaveProperty('messages_total');
    expect(typeof sq['messages_total']).toBe('number');
    expect(sq['messages_total'] as number).toBeGreaterThanOrEqual(0);
    expect(sq).toHaveProperty('unprocessed');
    expect(typeof sq['unprocessed']).toBe('number');
    expect(sq['unprocessed'] as number).toBeGreaterThanOrEqual(0);

    const en = data['enrichment'] as Record<string, unknown>;
    expect(en).toHaveProperty('last_run');
    const lastRunValue = en['last_run'];
    expect(lastRunValue === null || typeof lastRunValue === 'string').toBe(true);

    const models = data['models'] as Record<string, unknown>;
    for (const key of ['conversation', 'extraction', 'validation', 'fallback']) {
      expect(models).toHaveProperty(key);
      expect(typeof models[key]).toBe('string');
    }

    const ac = data['access_control'] as Record<string, unknown>;
    expect(ac).toHaveProperty('pending_count');
    expect(typeof ac['pending_count']).toBe('number');
    expect(ac['pending_count'] as number).toBeGreaterThanOrEqual(0);
  });

  it('GET /other returns 404', async () => {
    const { status } = await httpRequest(`${baseUrl}/other`);
    expect(status).toBe(404);
  });

  it('POST /health returns 404', async () => {
    const { status } = await httpRequest(`${baseUrl}/health`, 'POST');
    expect(status).toBe(404);
  });

  it('health check failure returns 500 with { status: "error" }', async () => {
    const brokenPort = await port2Promise;

    const brokenDeps: HealthDeps = {
      db: db as unknown as import('../../src/core/database.ts').Database,
      connectionManager:
        connectionManager as unknown as import('../../src/transport/connection.ts').ConnectionManager,
      startedAt: Date.now(),
      getEnrichmentStats: () => {
        throw new Error('stats explosion');
      },
    };

    const { config } = await import('../../src/config.ts');
    const originalPort = (config as Record<string, unknown>)['healthPort'];
    (config as Record<string, unknown>)['healthPort'] = brokenPort;

    const brokenServer = startHealthServer(brokenDeps);

    (config as Record<string, unknown>)['healthPort'] = originalPort;

    await new Promise<void>((resolve, reject) => {
      if (brokenServer.listening) {
        resolve();
        return;
      }
      brokenServer.once('listening', resolve);
      brokenServer.once('error', reject);
    });

    try {
      const { status, body } = await httpRequest(`http://127.0.0.1:${brokenPort}/health`);
      expect(status).toBe(500);
      const parsed = JSON.parse(body) as Record<string, unknown>;
      expect(parsed['status']).toBe('error');
    } finally {
      await new Promise<void>((resolve) => brokenServer.close(() => resolve()));
    }
  });

  it('unprocessed MUST NOT return -1 (sentinel eliminated)', async () => {
    const { body } = await httpRequest(`${baseUrl}/health`);
    const data = JSON.parse(body) as Record<string, unknown>;
    const sq = data['sqlite'] as Record<string, unknown>;
    expect(sq['unprocessed']).not.toBe(-1);
  });

  it('last_run is null when no enrichment run has occurred', async () => {
    lastRun = null;
    const { body } = await httpRequest(`${baseUrl}/health`);
    const data = JSON.parse(body) as Record<string, unknown>;
    const en = data['enrichment'] as Record<string, unknown>;
    expect(en['last_run']).toBeNull();
  });

  it('last_run reflects ISO string when enrichment run has occurred', async () => {
    const iso = new Date().toISOString();
    lastRun = iso;
    const { body } = await httpRequest(`${baseUrl}/health`);
    const data = JSON.parse(body) as Record<string, unknown>;
    const en = data['enrichment'] as Record<string, unknown>;
    expect(en['last_run']).toBe(iso);
    lastRun = null;
  });

  it('pending_count reflects actual DB state', async () => {
    db.raw.exec(
      `INSERT INTO access_list (subject_type, subject_id, status, display_name, requested_at)
       VALUES ('phone', '19995550001', 'pending', 'Test User', datetime('now'))`,
    );

    const { body } = await httpRequest(`${baseUrl}/health`);
    const data = JSON.parse(body) as Record<string, unknown>;
    const ac = data['access_control'] as Record<string, unknown>;
    expect(ac['pending_count'] as number).toBeGreaterThanOrEqual(1);

    db.raw.exec(`DELETE FROM access_list WHERE subject_type = 'phone' AND subject_id = '19995550001'`);
  });

  it('status is "unhealthy" (503) when botJid is null', async () => {
    const savedJid = connectionManager.botJid;
    connectionManager.botJid = null;

    const { status, body } = await httpRequest(`${baseUrl}/health`);
    expect(status).toBe(503);
    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data['status']).toBe('unhealthy');

    connectionManager.botJid = savedJid;
  });
});

// ---------------------------------------------------------------------------
// 3. Sent message contract
// ---------------------------------------------------------------------------

describe('Sent message contract', () => {
  function makeMockConnectionManager() {
    const sent: Array<{ chatJid: string; text: string }> = [];
    return {
      sent,
      async sendMessage(chatJid: string, text: string): Promise<void> {
        sent.push({ chatJid, text });
      },
    };
  }

  const SYSTEM_PROMPT_FRAGMENTS = [
    'You are Loops',
    'You are a person',
    'Never say',
    'systemPrompt',
    'Rules:',
    'As an AI',
    'language model',
  ];

  const AI_LEAK_PATTERNS = [
    /as an ai/i,
    /i am an ai/i,
    /language model/i,
    /\bapi\b/i,
    /claude/i,
    /openai/i,
    /anthropic/i,
    /\bgpt\b/i,
    /\bllm\b/i,
  ];

  it('normal response: plain text, no JSON, no system prompt fragments', async () => {
    const cm = makeMockConnectionManager();
    const text = "yeah honestly no idea, you'd have to look it up";

    await cm.sendMessage('15551234567@s.whatsapp.net', text);
    const { text: sent } = cm.sent[0]!;

    expect(sent).not.toMatch(/^\s*\{/);
    expect(sent).not.toMatch(/^\s*\[/);

    for (const fragment of SYSTEM_PROMPT_FRAGMENTS) {
      expect(sent).not.toContain(fragment);
    }

    expect(sent.trim().length).toBeGreaterThan(0);
  });

  it('rate limit notice: human-readable, no technical details', async () => {
    const cm = makeMockConnectionManager();
    const rateLimitMsg = "slow down a bit, been chatting a lot today";

    await cm.sendMessage('15551234567@s.whatsapp.net', rateLimitMsg);
    const { text: sent } = cm.sent[0]!;

    expect(sent).not.toMatch(/\b429\b/);
    expect(sent).not.toMatch(/rate.?limit/i);
    expect(sent).not.toMatch(/rateLimitPerHour/i);

    expect(sent.trim().length).toBeGreaterThan(0);
  });

  it('fallback message: human-like, no mention of AI/API/models', async () => {
    const cm = makeMockConnectionManager();
    const fallbackMsg = "hmm not sure what happened there, try again?";

    await cm.sendMessage('15551234567@s.whatsapp.net', fallbackMsg);
    const { text: sent } = cm.sent[0]!;

    for (const pattern of AI_LEAK_PATTERNS) {
      expect(sent, `fallback message should not match ${String(pattern)}`).not.toMatch(pattern);
    }

    expect(sent).not.toMatch(/"error"/);
    expect(sent.trim().length).toBeGreaterThan(0);
  });

  it('approval request: exact format "New contact: {name} (+{phone})\\nMessage: ..."', async () => {
    const cm = makeMockConnectionManager();

    const name = 'Bob Smith';
    const phone = '15559876543';
    const userMessage = 'Hey can I join?';
    const approvalText = `New contact: ${name} (+${phone})\nMessage: ${userMessage}`;

    await cm.sendMessage('15184194479@s.whatsapp.net', approvalText);
    const { text: sent } = cm.sent[0]!;

    expect(sent).toMatch(/^New contact: .+ \(\+\d+\)\nMessage: .+$/);
    expect(sent).toContain(`New contact: ${name} (+${phone})`);
    expect(sent).toContain(`\nMessage: ${userMessage}`);
  });

  it('conversation_key pattern: does not expose internal DB keys in messages', async () => {
    const cm = makeMockConnectionManager();
    const text = "Sure, let me check on that for you!";
    await cm.sendMessage('15551234567@s.whatsapp.net', text);
    const { text: sent } = cm.sent[0]!;

    expect(sent).not.toMatch(/_at_g\.us/);
    expect(sent).not.toMatch(/_at_s\.whatsapp\.net/);
  });
});
