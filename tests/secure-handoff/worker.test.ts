import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMigration68 } from '../../src/core/database-migration-68.ts';
import { CURRENT_SCHEMA_MIGRATION } from '../../src/core/database-schema-version.ts';
import {
  createSecureHandoffWorker,
  type SecureHandoffWorkerConfig,
  validateDatabase,
} from '../../src/secure-handoff/worker.ts';
import { parseSecureHandoffWorkerConfig } from '../../src/secure-handoff/worker-config.ts';
import {
  TEST_DELIVERY_HOST,
  TEST_LINK_HOST,
  TEST_PROTECTED_DELIVERY_PINS,
} from '../helpers/protected-delivery-pins.ts';

// The worker re-parses its configuration with the production default pins,
// swapped here for the neutral test pins.
vi.mock('../../src/core/protected-delivery-pins.ts', async (importOriginal) =>
  (await import('../helpers/protected-delivery-pins.ts')).mockProtectedDeliveryPins(importOriginal));

const INTAKE_ID = 'I'.repeat(22);
const RECEIPT = 'R'.repeat(43);
const SECRET = 'dummy-secret-kept-inside-the-fixed-consumer';
const NOW = '2026-10-30T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const LINKS_BASE_URL = `https://${TEST_LINK_HOST}/s/api/v1`;

const directories: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, 'close');
  }));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type RemoteState = 'awaiting_input' | 'submitted' | 'consuming' | 'succeeded' | 'failed' | 'expired' | 'revoked' | 'ambiguous' | 'cancelled';
type Intake = { id: string; resourceId: string; action: string; kind: 'password' | 'mfa'; state: RemoteState; expiresAt?: string };

function makeDatabase(rows: Array<{
  intakeId: string; principal?: string; resourceId?: string; action?: string | null;
  kind?: 'password' | 'mfa'; state?: 'awaiting_input' | 'submitted' | 'consuming' | 'cancelled'; expiresAt?: string;
}>): string {
  const directory = mkdtempSync(join(tmpdir(), 'secure-handoff-worker-'));
  directories.push(directory);
  const path = join(directory, 'bot.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(CURRENT_SCHEMA_MIGRATION);
  runMigration68(db);
  for (const [index, row] of rows.entries()) {
    db.prepare(`INSERT INTO protected_secret_inputs (
      create_operation_id, resolve_operation_id, intake_id, principal, recipient_jid,
      resource_id, kind, purpose, account_label, consumer_label, action, save_allowed,
      input_state, delivery_status, whatsapp_message_id, expires_at, issued_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'fixed sign in', 'Dummy', 'Fixed consumer', ?, 0, ?, 'submitted', ?, ?, ?)`)
      .run(
        `create-${index}`, `resolve-${index}`, row.intakeId, row.principal ?? 'alice', 'alice@example.test',
        row.resourceId ?? 'dummy-login', row.kind ?? 'password', row.action ?? 'sign_in', row.state ?? 'awaiting_input',
        `message-${index}`, row.expiresAt ?? '2026-10-30T13:00:00.000Z', NOW,
      );
  }
  db.close();
  return path;
}

function config(databasePath: string): SecureHandoffWorkerConfig {
  return parseSecureHandoffWorkerConfig({
    databasePath,
    linksBaseUrl: LINKS_BASE_URL,
    pollIntervalMs: 60_000,
    adapters: [{
      kind: 'password', resourceId: 'dummy-login', principal: 'alice', action: 'sign_in',
      endpoint: 'https://fixed-dummy.invalid/login', username: 'dummy-user',
    }],
  });
}

function pairedConfig(databasePath: string): SecureHandoffWorkerConfig {
  return parseSecureHandoffWorkerConfig({
    databasePath,
    linksBaseUrl: LINKS_BASE_URL,
    pollIntervalMs: 60_000,
    adapters: [
      {
        kind: 'password', resourceId: 'dummy-password', principal: 'alice', action: 'Verify password for two-step sign-in',
        endpoint: 'https://fixed-dummy.invalid/password', username: 'dummy-user',
        mfaTransition: { resourceId: 'dummy-mfa', account: 'dummy-account' },
      },
      {
        kind: 'mfa', resourceId: 'dummy-mfa', principal: 'alice', action: 'confirm_mfa',
        endpoint: 'https://fixed-dummy.invalid/mfa', username: 'dummy-user', account: 'dummy-account', operationMode: 'links_registered',
      },
    ],
  });
}

function environment(): Record<string, string> {
  return {
    LINKS_MANAGED_TRANSPORT_TOKEN: 'transport-only-token',
    LINKS_MANAGED_CONSUMER_TOKEN: 'consumer-only-token',
  };
}

function metadata(input: Intake, accountLabel = 'Dummy'): Record<string, unknown> {
  return {
    id: input.id, resourceId: input.resourceId, accountLabel, consumerLabel: 'Fixed consumer',
    action: input.action, kind: input.kind, saveAllowed: false,
    expiresAt: input.expiresAt ?? '2026-10-30T13:00:00.000Z', state: input.state,
  };
}

function consumed(id: string): Record<string, unknown> {
  return {
    id, resourceId: 'dummy-login', principal: 'alice', kind: 'password', action: 'sign_in',
    operationId: null, value: SECRET, save: false, receipt: RECEIPT,
  };
}

async function loginFixture(): Promise<{ endpoint: string; accepted: Array<Record<string, unknown>> }> {
  const accepted: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const value = JSON.parse(body) as Record<string, unknown>;
      if (request.method !== 'POST' || request.url !== '/login' || value.username !== 'dummy-user' || value.password !== SECRET) {
        response.writeHead(401).end();
        return;
      }
      accepted.push(value);
      response.writeHead(204).end();
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind TCP');
  return { endpoint: `http://127.0.0.1:${address.port}/login`, accepted };
}

function fetchFixture(
  loginEndpoint: string,
  intakes: Map<string, Intake>,
  calls: string[],
  completions: Array<Record<string, unknown>> = [],
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'fixed-dummy.invalid') return fetch(loginEndpoint, init);
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    const id = url.pathname.split('/')[5];
    if (init?.method === 'GET' && id) {
      const intake = intakes.get(id);
      return intake ? new Response(JSON.stringify(metadata(intake)), { status: 200 }) : new Response('{}', { status: 404 });
    }
    if (init?.method === 'POST' && url.pathname.endsWith('/consume') && id) {
      return new Response(JSON.stringify(consumed(id)), { status: 200 });
    }
    if (init?.method === 'POST' && url.pathname.endsWith('/complete') && id) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      completions.push(body);
      return new Response(JSON.stringify({ id, state: 'succeeded', operationResult: body.operationResult ?? null }), { status: 200 });
    }
    if (init?.method === 'POST' && url.pathname.endsWith('/ambiguous') && id) {
      return new Response(JSON.stringify({ id, state: 'ambiguous' }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
}

describe('secure handoff worker', () => {
  it('accepts only fixed registered adapter JSON and reserved environment credentials', () => {
    const parsed = parseSecureHandoffWorkerConfig({
      databasePath: '/var/lib/whatsoup/bot.db', linksBaseUrl: LINKS_BASE_URL, pollIntervalMs: 60_000,
      adapters: [
        {
          kind: 'password', resourceId: 'dummy-password', principal: 'alice', action: 'sign_in', endpoint: 'https://fixed.test/login', username: 'dummy',
          saveStore: { name: 'dummy-password-store', endpoint: 'https://fixed.test/credential', authorizationEnv: 'LINKS_MANAGED_DUMMY_STORE_AUTH' },
        },
        { kind: 'token', resourceId: 'dummy-token', principal: 'alice', action: 'api_access', endpoint: 'https://fixed.test/token' },
        { kind: 'mfa', resourceId: 'dummy-mfa', principal: 'alice', action: 'confirm', endpoint: 'https://fixed.test/mfa', username: 'dummy', operationId: 'fixture-login-step-1' },
      ],
    });
    expect(parsed.adapters.map((adapter) => adapter.kind)).toEqual(['password', 'token', 'mfa']);
    expect(parsed.adapters[0]).toMatchObject({ username: 'dummy', saveStore: { name: 'dummy-password-store', authorizationEnv: 'LINKS_MANAGED_DUMMY_STORE_AUTH' } });
    expect(() => parseSecureHandoffWorkerConfig({
      databasePath: '/var/lib/whatsoup/bot.db', linksBaseUrl: 'https://other.example.test/s/api/v1', pollIntervalMs: 60_000,
      adapters: [{ kind: 'password', resourceId: 'dummy-login', principal: 'alice', action: 'sign_in', endpoint: 'https://fixed.test/login', username: 'dummy' }],
    })).toThrow('secure handoff worker configuration is invalid');
    expect(() => parseSecureHandoffWorkerConfig({
      databasePath: '/var/lib/whatsoup/bot.db', linksBaseUrl: LINKS_BASE_URL, pollIntervalMs: 60_000,
      adapters: [{ kind: 'password', resourceId: 'dummy-login', principal: 'alice', action: 'sign_in', endpoint: 'https://fixed.test/login', username: 'dummy' }],
      command: 'exfiltrate',
    })).toThrow('secure handoff worker configuration is invalid');
    expect(() => parseSecureHandoffWorkerConfig({
      databasePath: '/var/lib/whatsoup/bot.db', linksBaseUrl: 'http://links.example.test/s/api/v1', pollIntervalMs: 60_000,
      adapters: [],
    })).toThrow('secure handoff worker configuration is invalid');
    expect(() => parseSecureHandoffWorkerConfig({
      databasePath: '/var/lib/whatsoup/bot.db', linksBaseUrl: LINKS_BASE_URL, pollIntervalMs: 60_000,
      adapters: [{
        kind: 'mfa', resourceId: 'dummy-mfa', principal: 'alice', action: 'confirm_mfa',
        endpoint: 'https://fixed.test/mfa', username: 'dummy', account: 'dummy-account', operationMode: 'links_registered',
      }],
    })).toThrow('secure handoff worker configuration is invalid');
  });

  it('admits a password-to-MFA pair only when its fixed account, principal, and target origin agree', () => {
    const parsed = parseSecureHandoffWorkerConfig({
      databasePath: '/var/lib/whatsoup/bot.db', linksBaseUrl: LINKS_BASE_URL, pollIntervalMs: 60_000,
      adapters: [
        {
          kind: 'password', resourceId: 'dummy-password', principal: 'alice', action: 'Verify password for two-step sign-in',
          endpoint: 'https://fixed.test/login', username: 'dummy',
          mfaTransition: { resourceId: 'dummy-mfa', account: 'dummy-account' },
        },
        {
          kind: 'mfa', resourceId: 'dummy-mfa', principal: 'alice', action: 'confirm_mfa',
          endpoint: 'https://fixed.test/mfa', username: 'dummy', account: 'dummy-account', operationMode: 'links_registered',
        },
      ],
    });

    expect(parsed.adapters[0]).toMatchObject({
      action: 'Verify password for two-step sign-in',
      mfaTransition: { resourceId: 'dummy-mfa', account: 'dummy-account' },
    });
    expect(() => parseSecureHandoffWorkerConfig({
      databasePath: '/var/lib/whatsoup/bot.db', linksBaseUrl: LINKS_BASE_URL, pollIntervalMs: 60_000,
      adapters: [
        {
          kind: 'password', resourceId: 'dummy-password', principal: 'alice', action: 'Verify password for two-step sign-in',
          endpoint: 'https://fixed.test/login', username: 'dummy',
          mfaTransition: { resourceId: 'dummy-mfa', account: 'dummy-account' },
        },
        {
          kind: 'mfa', resourceId: 'dummy-mfa', principal: 'alice', action: 'confirm_mfa',
          endpoint: 'https://different.test/mfa', username: 'other-account', account: 'dummy-account', operationMode: 'links_registered',
        },
      ],
    })).toThrow('secure handoff worker configuration is invalid');
    expect(() => parseSecureHandoffWorkerConfig({
      databasePath: '/var/lib/whatsoup/bot.db', linksBaseUrl: LINKS_BASE_URL, pollIntervalMs: 60_000,
      adapters: [
        {
          kind: 'password', resourceId: 'dummy-password', principal: 'alice', action: 'Verify password for two-step sign-in',
          endpoint: 'https://fixed.test/login', username: 'dummy',
          mfaTransition: { resourceId: 'dummy-mfa', account: 'dummy-account' },
        },
        {
          kind: 'password', resourceId: 'dummy-password-retry', principal: 'alice', action: 'Verify password for two-step sign-in',
          endpoint: 'https://fixed.test/other-login', username: 'dummy',
          mfaTransition: { resourceId: 'dummy-mfa', account: 'dummy-account' },
        },
        {
          kind: 'mfa', resourceId: 'dummy-mfa', principal: 'alice', action: 'confirm_mfa',
          endpoint: 'https://fixed.test/mfa', username: 'dummy', account: 'dummy-account', operationMode: 'links_registered',
        },
      ],
    })).toThrow('secure handoff worker configuration is invalid');
  });

  it('accepts the links API only on a hash-pinned canonical link host', async () => {
    const withBase = (linksBaseUrl: string) => ({
      databasePath: '/var/lib/whatsoup/bot.db', linksBaseUrl, pollIntervalMs: 60_000,
      adapters: [{ kind: 'password', resourceId: 'dummy-login', principal: 'alice', action: 'sign_in', endpoint: 'https://fixed.test/login', username: 'dummy' }],
    });
    // Spellings the URL parser normalizes to the exact base are accepted, as
    // the former literal comparison accepted them; the parsed base is canonical.
    for (const spelling of [
      LINKS_BASE_URL,
      `https://${TEST_LINK_HOST.toUpperCase()}/s/api/v1`,
      `https://${TEST_LINK_HOST}:443/s/api/v1`,
      `https://${TEST_LINK_HOST}/s/api/v1/`,
    ]) {
      expect(parseSecureHandoffWorkerConfig(withBase(spelling), TEST_PROTECTED_DELIVERY_PINS).linksBaseUrl).toBe(LINKS_BASE_URL);
    }
    // An unpinned host, a pinned delivery host that is not a canonical link
    // host, host spellings the pin check refuses, and any other origin or path
    // are refused.
    for (const refused of [
      'https://unpinned.example.test/s/api/v1',
      `https://${TEST_DELIVERY_HOST}/s/api/v1`,
      `https://www.${TEST_LINK_HOST}/s/api/v1`,
      `https://${TEST_LINK_HOST}./s/api/v1`,
      `https://${TEST_LINK_HOST}:8443/s/api/v1`,
      `https://${TEST_LINK_HOST}/s/api/v2`,
      `https://${TEST_LINK_HOST}/s/api/v1?x=1`,
      `https://user@${TEST_LINK_HOST}/s/api/v1`,
      `http://${TEST_LINK_HOST}/s/api/v1`,
    ]) {
      expect(() => parseSecureHandoffWorkerConfig(withBase(refused), TEST_PROTECTED_DELIVERY_PINS))
        .toThrow('secure handoff worker configuration is invalid');
    }
    // The production pins never match a test host.
    const production = await vi.importActual<typeof import('../../src/core/protected-delivery-pins.ts')>(
      '../../src/core/protected-delivery-pins.ts',
    );
    expect(() => parseSecureHandoffWorkerConfig(withBase(LINKS_BASE_URL), production.PROTECTED_DELIVERY_PINS))
      .toThrow('secure handoff worker configuration is invalid');
  });

  it('uses only an exact, unexpired registered submitted intake at its fixed HTTP target', async () => {
    const otherPrincipal = 'P'.repeat(22);
    const otherResource = 'Q'.repeat(22);
    const dbPath = makeDatabase([
      { intakeId: INTAKE_ID },
      { intakeId: otherPrincipal, principal: 'mallory' },
      { intakeId: otherResource, resourceId: 'other-resource' },
      { intakeId: 'E'.repeat(22), expiresAt: '2026-10-30T11:00:00.000Z' },
      { intakeId: 'C'.repeat(22), state: 'cancelled' },
    ]);
    const fixture = await loginFixture();
    const calls: string[] = [];
    const completions: Array<Record<string, unknown>> = [];
    const worker = createSecureHandoffWorker({
      config: config(dbPath), environment: environment(), clock: fixedClock(),
      fetch: fetchFixture(fixture.endpoint, new Map([[INTAKE_ID, { id: INTAKE_ID, resourceId: 'dummy-login', action: 'sign_in', kind: 'password', state: 'submitted' }]]), calls, completions),
    });
    await worker.start();
    await worker.tick();
    await worker.stop();

    expect(fixture.accepted).toEqual([{ username: 'dummy-user', password: SECRET }]);
    expect(calls).toEqual([
      `GET /s/api/v1/intakes/${INTAKE_ID}?principal=alice`,
      `POST /s/api/v1/intakes/${INTAKE_ID}/consume`,
      `POST /s/api/v1/intakes/${INTAKE_ID}/complete`,
    ]);
    expect(completions).toEqual([{
      receipt: RECEIPT,
      outcome: 'succeeded',
      operationResult: { phase: 'password', outcome: 'completed' },
    }]);
  });

  it('registers a direct source 202 as one paired MFA challenge before completing the password precursor', async () => {
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const dbPath = makeDatabase([{ intakeId: INTAKE_ID, resourceId: 'dummy-password', action: 'Verify password for two-step sign-in', expiresAt }]);
    const calls: Array<{ method: string; path: string; body: string | undefined }> = [];
    const worker = createSecureHandoffWorker({
      config: pairedConfig(dbPath), environment: environment(), clock: {
        now: () => Date.now(), nowIso: () => new Date().toISOString(),
      },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname === 'fixed-dummy.invalid') {
          expect(url.pathname).toBe('/password');
          expect(JSON.parse(String(init?.body))).toEqual({ username: 'dummy-user', password: SECRET, intakeId: INTAKE_ID });
          return new Response(JSON.stringify({
            parentIntakeId: INTAKE_ID, principal: 'alice', account: 'dummy-account', resourceId: 'dummy-mfa',
            operationId: 'source-operation-1', expiresAt,
          }), { status: 202, headers: { 'content-type': 'application/json' } });
        }
        calls.push({ method: init?.method ?? 'GET', path: url.pathname, body: typeof init?.body === 'string' ? init.body : undefined });
        const id = url.pathname.split('/')[5];
        if (init?.method === 'GET' && id) {
          return new Response(JSON.stringify(metadata({
            id, resourceId: 'dummy-password', action: 'Verify password for two-step sign-in', kind: 'password', state: 'submitted', expiresAt,
          }, 'dummy-account')), { status: 200 });
        }
        if (init?.method === 'POST' && url.pathname.endsWith('/consume') && id) {
          return new Response(JSON.stringify({
            ...consumed(id), resourceId: 'dummy-password', action: 'Verify password for two-step sign-in',
          }), { status: 200 });
        }
        if (init?.method === 'POST' && url.pathname === '/s/api/v1/resources/dummy-mfa/challenges') {
          return new Response(JSON.stringify({
            id: 'C'.repeat(22), resourceId: 'dummy-mfa', operationId: 'source-operation-1', expiresAt, state: 'open',
          }), { status: 201 });
        }
        if (init?.method === 'POST' && url.pathname.endsWith('/complete') && id) {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({ id, state: 'succeeded', operationResult: body.operationResult ?? null }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      },
    });

    await worker.start();
    await worker.tick();
    await worker.stop();

    expect(calls).toEqual([
      { method: 'GET', path: `/s/api/v1/intakes/${INTAKE_ID}`, body: undefined },
      { method: 'POST', path: `/s/api/v1/intakes/${INTAKE_ID}/consume`, body: '{}' },
      {
        method: 'POST', path: '/s/api/v1/resources/dummy-mfa/challenges',
        body: JSON.stringify({ principal: 'alice', operationId: 'source-operation-1', expiresAt }),
      },
      {
        method: 'POST', path: `/s/api/v1/intakes/${INTAKE_ID}/complete`,
        body: JSON.stringify({
          receipt: RECEIPT,
          outcome: 'succeeded',
          operationResult: { phase: 'password', outcome: 'mfa_required' },
        }),
      },
    ]);
  });

  it('rejects paired password and registered-MFA metadata whose account label changed before consume', async () => {
    const passwordId = 'P'.repeat(22);
    const mfaId = 'M'.repeat(22);
    const dbPath = makeDatabase([
      { intakeId: passwordId, resourceId: 'dummy-password', action: 'Verify password for two-step sign-in', kind: 'password', state: 'submitted' },
      { intakeId: mfaId, resourceId: 'dummy-mfa', action: 'confirm_mfa', kind: 'mfa', state: 'submitted' },
    ]);
    const remotes = new Map<string, Intake>([
      [passwordId, { id: passwordId, resourceId: 'dummy-password', action: 'Verify password for two-step sign-in', kind: 'password', state: 'submitted' }],
      [mfaId, { id: mfaId, resourceId: 'dummy-mfa', action: 'confirm_mfa', kind: 'mfa', state: 'submitted' }],
    ]);
    const linksCalls: string[] = [];
    let targetCalls = 0;
    const worker = createSecureHandoffWorker({
      config: pairedConfig(dbPath), environment: environment(), clock: fixedClock(),
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname === 'fixed-dummy.invalid') {
          targetCalls += 1;
          return new Response(null, { status: 500 });
        }
        linksCalls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
        const id = url.pathname.split('/')[5];
        if (init?.method === 'GET' && id) {
          const remote = remotes.get(id);
          return remote === undefined
            ? new Response('{}', { status: 404 })
            : new Response(JSON.stringify(metadata(remote, 'changed-account')), { status: 200 });
        }
        return new Response('{}', { status: 500 });
      },
    });

    await worker.start();
    await worker.tick();
    await worker.stop();

    expect(linksCalls).toHaveLength(2);
    expect(linksCalls).toContain(`GET /s/api/v1/intakes/${passwordId}?principal=alice`);
    expect(linksCalls).toContain(`GET /s/api/v1/intakes/${mfaId}?principal=alice`);
    expect(linksCalls.some((call) => call.includes('/consume') || call.includes('/ambiguous'))).toBe(false);
    expect(targetCalls).toBe(0);
  });

  it('does not consume awaiting, cancelled, expired, ambiguous, or cross-bound metadata', async () => {
    const awaiting = 'A'.repeat(22);
    const ambiguous = 'B'.repeat(22);
    const mismatched = 'M'.repeat(22);
    const expired = 'E'.repeat(22);
    const cancelled = 'C'.repeat(22);
    const dbPath = makeDatabase([
      { intakeId: awaiting }, { intakeId: ambiguous, state: 'consuming' }, { intakeId: mismatched },
      { intakeId: expired }, { intakeId: cancelled },
    ]);
    const fixture = await loginFixture();
    const calls: string[] = [];
    const worker = createSecureHandoffWorker({
      config: config(dbPath), environment: environment(), clock: fixedClock(),
      fetch: fetchFixture(fixture.endpoint, new Map([
        [awaiting, { id: awaiting, resourceId: 'dummy-login', action: 'sign_in', kind: 'password', state: 'awaiting_input' }],
        [ambiguous, { id: ambiguous, resourceId: 'dummy-login', action: 'sign_in', kind: 'password', state: 'ambiguous' }],
        [mismatched, { id: mismatched, resourceId: 'other-resource', action: 'sign_in', kind: 'password', state: 'submitted' }],
        [expired, { id: expired, resourceId: 'dummy-login', action: 'sign_in', kind: 'password', state: 'submitted', expiresAt: '2026-10-30T11:00:00.000Z' }],
        [cancelled, { id: cancelled, resourceId: 'dummy-login', action: 'sign_in', kind: 'password', state: 'cancelled' }],
      ]), calls),
    });
    await worker.start();
    await worker.tick();
    await worker.stop();

    expect(fixture.accepted).toEqual([]);
    expect(calls).toEqual([
      `GET /s/api/v1/intakes/${cancelled}?principal=alice`,
      `GET /s/api/v1/intakes/${expired}?principal=alice`,
      `GET /s/api/v1/intakes/${mismatched}?principal=alice`,
      `GET /s/api/v1/intakes/${ambiguous}?principal=alice`,
      `GET /s/api/v1/intakes/${awaiting}?principal=alice`,
    ]);
  });

  it('reconciles a remote consuming intake after restart without executing an adapter and has no overlapping ticks', async () => {
    const dbPath = makeDatabase([{ intakeId: INTAKE_ID, state: 'consuming' }]);
    const events: string[] = [];
    let unblock: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => { unblock = resolve; });
    const worker = createSecureHandoffWorker({
      config: config(dbPath), environment: environment(), clock: fixedClock(),
      transport: { async getSecretInput() {
        events.push('status');
        await wait;
        return metadata({ id: INTAKE_ID, resourceId: 'dummy-login', action: 'sign_in', kind: 'password', state: 'consuming' }) as never;
      } },
      consumer: {
        async execute() { events.push('execute'); return { id: INTAKE_ID, state: 'succeeded' as const }; },
        async reconcileAmbiguous() { events.push('reconcile'); return { id: INTAKE_ID, state: 'ambiguous' as const }; },
      },
    });
    await worker.start();
    const first = worker.tick();
    const second = worker.tick();
    expect(second).toBe(first);
    unblock!();
    await first;
    await worker.stop();

    expect(events).toEqual(['status', 'reconcile']);
  });

  it('pages past the first hundred active rows without a writable local ledger', async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      intakeId: `${index.toString(36).padStart(3, '0')}${'Z'.repeat(19)}`,
    }));
    const dbPath = makeDatabase(rows);
    const statusIds: string[] = [];
    const worker = createSecureHandoffWorker({
      config: config(dbPath), environment: environment(), clock: fixedClock(),
      transport: { async getSecretInput({ id }) {
        statusIds.push(id);
        return metadata({ id, resourceId: 'dummy-login', action: 'sign_in', kind: 'password', state: 'awaiting_input' }) as never;
      } },
      consumer: {
        async execute() { throw new Error('awaiting input must not execute'); },
        async reconcileAmbiguous() { throw new Error('awaiting input must not reconcile'); },
      },
    });
    await worker.start();
    await worker.tick();
    await worker.tick();
    await worker.stop();

    expect(statusIds).toHaveLength(101);
    expect(new Set(statusIds).size).toBe(101);
  });

  it('rejects an incompatible local database before starting a timer or admitting a tick', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'secure-handoff-worker-invalid-'));
    directories.push(directory);
    const worker = createSecureHandoffWorker({
      config: config(join(directory, 'not-the-whatsoup-db.sqlite')), environment: environment(), clock: fixedClock(),
    });

    await expect(worker.start()).rejects.toThrow('secure handoff worker database is incompatible');
    await expect(worker.tick()).rejects.toThrow('secure handoff worker is not started');
  });

  it('refuses a database one schema behind and names the unapplied current migration', async () => {
    const path = makeDatabase([]);
    const behind = new DatabaseSync(path);
    try {
      // The protected secret input table exists; only the current migration is missing.
      behind.prepare('UPDATE schema_migrations SET version = ? WHERE version = ?')
        .run(CURRENT_SCHEMA_MIGRATION - 1, CURRENT_SCHEMA_MIGRATION);
      expect(() => validateDatabase(behind, path))
        .toThrow('database has not applied the current schema migration of this binary');
    } finally {
      behind.close();
    }
    const worker = createSecureHandoffWorker({ config: config(path), environment: environment(), clock: fixedClock() });
    await expect(worker.start()).rejects.toThrow('secure handoff worker database is incompatible');
  });

  it('advances past malformed newest intake metadata', async () => {
    const malformed = Array.from({ length: 100 }, (_, index) => ({ intakeId: `bad-${index}` }));
    const valid = 'V'.repeat(22);
    const dbPath = makeDatabase([{ intakeId: valid }, ...malformed]);
    const events: string[] = [];
    const worker = createSecureHandoffWorker({
      config: config(dbPath), environment: environment(), clock: fixedClock(),
      transport: { async getSecretInput({ id }) {
        events.push(id);
        return metadata({ id, resourceId: 'dummy-login', action: 'sign_in', kind: 'password', state: 'awaiting_input' }) as never;
      } },
      consumer: {
        async execute() { throw new Error('awaiting input must not execute'); },
        async reconcileAmbiguous() { throw new Error('awaiting input must not reconcile'); },
      },
    });
    await worker.start();
    await worker.tick();
    await worker.tick();
    await worker.stop();

    expect(events).toEqual([valid]);
  });

  it('denies ticks while stopping and supports a clean later restart', async () => {
    const dbPath = makeDatabase([{ intakeId: INTAKE_ID }]);
    let unblock: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const worker = createSecureHandoffWorker({
      config: config(dbPath), environment: environment(), clock: fixedClock(),
      transport: { async getSecretInput({ id }) {
        await blocked;
        return metadata({ id, resourceId: 'dummy-login', action: 'sign_in', kind: 'password', state: 'awaiting_input' }) as never;
      } },
      consumer: {
        async execute() { throw new Error('awaiting input must not execute'); },
        async reconcileAmbiguous() { throw new Error('awaiting input must not reconcile'); },
      },
    });
    await worker.start();
    const active = worker.tick();
    const stopping = worker.stop();
    await expect(worker.tick()).rejects.toThrow('secure handoff worker is stopping');
    unblock!();
    await active;
    await stopping;

    await worker.start();
    await worker.stop();
  });

  it('suppresses only exact-bound terminal metadata in a bounded process cache and rechecks after restart', async () => {
    const terminal = 'T'.repeat(22);
    const changedBinding = 'B'.repeat(22);
    const invalidExpiry = 'X'.repeat(22);
    const dbPath = makeDatabase([{ intakeId: terminal }, { intakeId: changedBinding }, { intakeId: invalidExpiry }]);
    const requests: string[] = [];
    const consumerEvents: string[] = [];
    const worker = createSecureHandoffWorker({
      config: config(dbPath), environment: environment(), clock: fixedClock(),
      transport: { async getSecretInput({ id }) {
        requests.push(id);
        if (id === changedBinding) {
          return metadata({ id, resourceId: 'other-resource', action: 'sign_in', kind: 'password', state: 'succeeded' }) as never;
        }
        if (id === invalidExpiry) {
          return { ...metadata({ id, resourceId: 'dummy-login', action: 'sign_in', kind: 'password', state: 'succeeded' }), expiresAt: 'not-an-instant' } as never;
        }
        return metadata({ id, resourceId: 'dummy-login', action: 'sign_in', kind: 'password', state: 'succeeded' }) as never;
      } },
      consumer: {
        async execute() { consumerEvents.push('execute'); return { id: terminal, state: 'succeeded' as const }; },
        async reconcileAmbiguous() { consumerEvents.push('reconcile'); return { id: terminal, state: 'ambiguous' as const }; },
      },
    });
    await worker.start();
    await worker.tick();
    await worker.tick();
    await worker.stop();

    expect(requests.filter((id) => id === terminal)).toHaveLength(1);
    expect(requests.filter((id) => id === changedBinding).length).toBeGreaterThan(1);
    expect(requests.filter((id) => id === invalidExpiry).length).toBeGreaterThan(1);
    expect(consumerEvents).toEqual([]);

    await worker.start();
    await worker.tick();
    await worker.stop();
    expect(requests.filter((id) => id === terminal)).toHaveLength(2);
  });

  it('does not apply a terminal cache entry to a changed local binding for the same intake id', async () => {
    const dbPath = makeDatabase([{ intakeId: INTAKE_ID }]);
    const workerConfig = parseSecureHandoffWorkerConfig({
      databasePath: dbPath, linksBaseUrl: LINKS_BASE_URL, pollIntervalMs: 60_000,
      adapters: [
        { kind: 'password', resourceId: 'dummy-login', principal: 'alice', action: 'sign_in', endpoint: 'https://fixed-dummy.invalid/login', username: 'dummy-user' },
        { kind: 'password', resourceId: 'alternate-login', principal: 'alice', action: 'alternate_sign_in', endpoint: 'https://fixed-alternate.invalid/login', username: 'alternate-user' },
      ],
    });
    const bindings: string[] = [];
    const consumerEvents: string[] = [];
    const worker = createSecureHandoffWorker({
      config: workerConfig, environment: environment(), clock: fixedClock(),
      transport: { async getSecretInput({ id }) {
        bindings.push(id);
        return bindings.length === 1
          ? metadata({ id, resourceId: 'dummy-login', action: 'sign_in', kind: 'password', state: 'succeeded' }) as never
          : metadata({ id, resourceId: 'alternate-login', action: 'alternate_sign_in', kind: 'password', state: 'awaiting_input' }) as never;
      } },
      consumer: {
        async execute() { consumerEvents.push('execute'); return { id: INTAKE_ID, state: 'succeeded' as const }; },
        async reconcileAmbiguous() { consumerEvents.push('reconcile'); return { id: INTAKE_ID, state: 'ambiguous' as const }; },
      },
    });
    await worker.start();
    await worker.tick();
    const writer = new DatabaseSync(dbPath);
    writer.prepare(`UPDATE protected_secret_inputs
      SET resource_id='alternate-login', action='alternate_sign_in'
      WHERE intake_id=?`).run(INTAKE_ID);
    writer.close();
    await worker.tick();
    await worker.stop();

    expect(bindings).toEqual([INTAKE_ID, INTAKE_ID]);
    expect(consumerEvents).toEqual([]);
  });
});

function fixedClock(): { now(): number; nowIso(): string } {
  return { now: () => NOW_MS, nowIso: () => NOW };
}
