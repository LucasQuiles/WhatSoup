import { lookupCredentialMock, httpReq, TEST_HEALTH_TOKEN, healthReq, buildTestServer, makeDb, makeDeps } from './_helpers/health.ts';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { Database } from '../../src/core/database.ts';
import { ConnectionManager } from '../../src/transport/connection.ts';
import { emptyConnectionStateSnapshot } from '../../src/transport/twilio/connection-snapshot.ts';

// ---------------------------------------------------------------------------
// #2515 — Public/private health split canaries.
//
// GET /health returns a minimal versioned liveness envelope to unauthenticated
// callers (no identity, location, lifecycle, exception, recent-event, or
// credential fields) and the full diagnostic projection only to authenticated
// callers. These canaries fail open: if a privileged field ever leaks into the
// public bytes, the assertion on the synthetic marker catches it.
// ---------------------------------------------------------------------------

describe('GET /health — #2515 public/private liveness split', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    db = makeDb();
    process.env.WHATSOUP_HEALTH_TOKEN = TEST_HEALTH_TOKEN;
    ({ server, port } = await buildTestServer(makeDeps(db, {
      connectionManager: {
        botJid: 'synthetic-bot-jid-marker-2515@s.whatsapp.net',
        botLid: 'synthetic-bot-lid-marker-2515',
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn(() => emptyConnectionStateSnapshot({
          connected: true,
          stateChangedAt: '2026-07-29T00:00:00.000Z',
          lastDisconnectReason: null,
        })),
      } as unknown as ConnectionManager,
      instanceName: 'synthetic-instance-name-marker-2515',
    })));
  });

  afterEach(async () => {
    db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.WHATSOUP_HEALTH_TOKEN;
  });

  it('returns a minimal versioned public envelope with no privileged fields to unauthenticated callers', async () => {
    // No Authorization header — this is the public liveness path.
    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);

    // The public envelope carries only liveness plus the privacy-safe startup
    // notification projection.
    expect(json).toEqual({
      schema_version: 'health.public.v1',
      status: 'healthy',
      generated_at: expect.any(String),
      startupNotification: {
        state: 'not_applicable',
        policy: 'none',
        stabilitySeconds: null,
        bootCountSinceNotification: null,
        lastBootAt: null,
        lastNotifiedAt: null,
        nextEligibleAt: null,
        lastSendAt: null,
      },
    });

    // Fail-open canaries: if ANY privileged field leaks into the public bytes,
    // the synthetic markers placed in the test deps surface immediately.
    // Identity, location, lifecycle, exception, recent-event, and credential
    // fields must be absent.
    const bodyText = body;
    expect(bodyText).not.toContain('synthetic-bot-jid-marker-2515');
    expect(bodyText).not.toContain('synthetic-bot-lid-marker-2515');
    expect(bodyText).not.toContain('synthetic-instance-name-marker-2515');
    expect(bodyText).not.toContain('instance');
    expect(bodyText).not.toContain('whatsapp');
    expect(bodyText).not.toContain('transport');
    expect(bodyText).not.toContain('uptime');
    expect(bodyText).not.toContain('arc');
    expect(bodyText).not.toContain('provider');
    expect(bodyText).not.toContain('commit');
    expect(bodyText).not.toContain('degradation_causes');
  });

  it('returns 503 in the public envelope when transport is disconnected and not recovering', async () => {
    // Rebuild with a disconnected transport.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(makeDeps(db, {
      connectionManager: {
        botJid: null,
        botLid: null,
        sendMessage: vi.fn(),
        sendMedia: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        getConnectionState: vi.fn(() => emptyConnectionStateSnapshot({
          connected: false,
          stateChangedAt: '2026-07-29T00:00:00.000Z',
          lastDisconnectReason: null,
        })),
      } as unknown as ConnectionManager,
    })));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(503);
    const json = JSON.parse(body);
    expect(json.schema_version).toBe('health.public.v1');
    expect(json.status).toBe('unhealthy');
    // No privileged fields.
    expect(body).not.toContain('instance');
    expect(body).not.toContain('whatsapp');
  });

  it('returns the full diagnostic projection to authenticated callers', async () => {
    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);

    // The authenticated path returns the full diagnostic — privileged fields
    // are present and visible. This proves the split does not silently degrade
    // the diagnostic for authorized callers.
    expect(json.status).toBe('healthy');
    expect(json.whatsapp).toBeDefined();
    expect(json.instance).toBeDefined();
    expect(json.instance.name).toBe('synthetic-instance-name-marker-2515');
    expect(json.degradation_causes).toBeDefined();
    expect(typeof json.uptime_seconds).toBe('number');
  });

  it('rejects an invalid bearer token with the public envelope, not the diagnostic', async () => {
    const { status, body } = await httpReq(port, '/health', 'GET', undefined, {
      Authorization: 'Bearer wrong-token-2515',
    });
    // Invalid token is treated as unauthenticated — public envelope only.
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.schema_version).toBe('health.public.v1');
    expect(body).not.toContain('synthetic-instance-name-marker-2515');
    expect(body).not.toContain('whatsapp');
  });

  // The file-default lookupCredential mock ignores lookup options, which is
  // exactly how the unscoped-GET defect stayed invisible. These falsifiers use
  // a scope-SENSITIVE mock and restore the default in finally (this file has
  // no global mock reset).
  const restoreDefaultLookupMock = (): void => {
    lookupCredentialMock.mockImplementation(
      (service: string) => service === 'whatsoup-health-token'
        ? process.env.WHATSOUP_HEALTH_TOKEN ?? null
        : null,
    );
  };

  it('never grants the diagnostic to a token only the unscoped lookup knows (scope falsifier)', async () => {
    try {
      // No launcher-provenanced env token: exercise the scoped-keychain
      // fallback path directly.
      delete process.env.WHATSOUP_HEALTH_TOKEN;
      // Deliberately DIFFERENT scoped vs unscoped credentials: before the fix,
      // GET auth resolved unscoped, so the stale unscoped token would have
      // unlocked the full diagnostic projection here.
      lookupCredentialMock.mockImplementation(
        (service: string, options?: { user?: string }) =>
          service === 'whatsoup-health-token'
            ? (options?.user !== undefined ? 'scoped-secret-2515' : 'stale-unscoped-secret-2515')
            : null,
      );

      const unscoped = await httpReq(port, '/health', 'GET', undefined, {
        Authorization: 'Bearer stale-unscoped-secret-2515',
      });
      expect(unscoped.status).toBe(200);
      expect(JSON.parse(unscoped.body).schema_version).toBe('health.public.v1');
      expect(unscoped.body).not.toContain('synthetic-instance-name-marker-2515');

      // The instance-scoped credential is the one token every protected route
      // honors — GET diagnostic and mutation routes agree on it.
      const scoped = await httpReq(port, '/health', 'GET', undefined, {
        Authorization: 'Bearer scoped-secret-2515',
      });
      expect(scoped.status).toBe(200);
      expect(JSON.parse(scoped.body).instance?.name).toBe('synthetic-instance-name-marker-2515');

      const mutationUnscoped = await httpReq(port, '/send', 'POST', '{}', {
        Authorization: 'Bearer stale-unscoped-secret-2515',
      });
      expect(mutationUnscoped.status).toBe(401);
      const mutationScoped = await httpReq(port, '/send', 'POST', '{}', {
        Authorization: 'Bearer scoped-secret-2515',
      });
      // Auth passes; the empty body fails later validation — anything but 401.
      expect(mutationScoped.status).not.toBe(401);
    } finally {
      restoreDefaultLookupMock();
    }
  });

  it('resolves the expected token once per server, not once per request (keyring stall bound)', async () => {
    try {
      delete process.env.WHATSOUP_HEALTH_TOKEN;
      lookupCredentialMock.mockClear();
      lookupCredentialMock.mockImplementation(
        (service: string, options?: { user?: string }) =>
          service === 'whatsoup-health-token' && options?.user !== undefined
            ? 'scoped-secret-cache-2515'
            : null,
      );

      const first = await httpReq(port, '/health', 'GET', undefined, {
        Authorization: 'Bearer scoped-secret-cache-2515',
      });
      expect(JSON.parse(first.body).instance?.name).toBe('synthetic-instance-name-marker-2515');
      await httpReq(port, '/health', 'GET', undefined, {
        Authorization: 'Bearer scoped-secret-cache-2515',
      });
      await httpReq(port, '/health', 'GET', undefined, {
        Authorization: 'Bearer definitely-wrong',
      });

      // The scoped lookup shells out to the platform keyring synchronously, so
      // it must run once per server lifetime — not on every request (and not
      // again on unauthorized requests, which would let a request burst
      // serialize keyring stalls).
      const healthTokenLookups = lookupCredentialMock.mock.calls.filter(
        ([service]) => service === 'whatsoup-health-token',
      );
      expect(healthTokenLookups).toEqual([
        ['whatsoup-health-token', {
          user: 'synthetic-instance-name-marker-2515',
          skipMigrationFallbacks: true,
        }],
      ]);
    } finally {
      restoreDefaultLookupMock();
    }
  });

  it('honors the launcher-provenanced env token over a divergent stale keychain entry (rotation falsifier)', async () => {
    try {
      // The rotation stranding scenario: tokens.env rotated to F (launcher
      // exported it; fleet discovery reads the same file and sends F) while
      // the scoped keychain still holds stale K. Keychain-first precedence
      // would 401 the entire fleet, and a restart would not fix it.
      process.env.WHATSOUP_HEALTH_TOKEN = 'rotated-file-token-F';
      lookupCredentialMock.mockClear();
      lookupCredentialMock.mockImplementation(
        (service: string, options?: { user?: string }) =>
          service === 'whatsoup-health-token' && options?.user !== undefined
            ? 'stale-keychain-token-K'
            : null,
      );

      const fleet = await httpReq(port, '/health', 'GET', undefined, {
        Authorization: 'Bearer rotated-file-token-F',
      });
      expect(JSON.parse(fleet.body).instance?.name).toBe('synthetic-instance-name-marker-2515');

      // The stale keychain value must not authorize anything.
      const stale = await httpReq(port, '/health', 'GET', undefined, {
        Authorization: 'Bearer stale-keychain-token-K',
      });
      expect(JSON.parse(stale.body).schema_version).toBe('health.public.v1');
      const staleMutation = await httpReq(port, '/send', 'POST', '{}', {
        Authorization: 'Bearer stale-keychain-token-K',
      });
      expect(staleMutation.status).toBe(401);

      // Env-first: with a launcher-provenanced token present, the keychain is
      // never consulted at all.
      expect(lookupCredentialMock.mock.calls.filter(
        ([service]) => service === 'whatsoup-health-token',
      )).toEqual([]);
    } finally {
      process.env.WHATSOUP_HEALTH_TOKEN = TEST_HEALTH_TOKEN;
      restoreDefaultLookupMock();
    }
  });

  it('bounds miss retries and discovers a late-arriving credential after the window', async () => {
    try {
      vi.useFakeTimers({ toFake: ['Date'] });
      delete process.env.WHATSOUP_HEALTH_TOKEN;
      lookupCredentialMock.mockClear();
      lookupCredentialMock.mockImplementation(() => null);
      const tokenLookups = (): number => lookupCredentialMock.mock.calls
        .filter(([service]) => service === 'whatsoup-health-token').length;
      const attempt = () => httpReq(port, '/health', 'GET', undefined, {
        Authorization: 'Bearer late-token-2515',
      });

      // Repeated misses inside the retry window: exactly one keyring lookup.
      let res = await attempt();
      expect(JSON.parse(res.body).schema_version).toBe('health.public.v1');
      await attempt();
      await attempt();
      expect(tokenLookups()).toBe(1);

      // The credential appears, but inside the window the negative cache holds.
      lookupCredentialMock.mockImplementation(
        (service: string, options?: { user?: string }) =>
          service === 'whatsoup-health-token' && options?.user !== undefined
            ? 'late-token-2515'
            : null,
      );
      res = await attempt();
      expect(JSON.parse(res.body).schema_version).toBe('health.public.v1');
      expect(tokenLookups()).toBe(1);

      // Past the 30s bound the resolver re-consults and discovers it — a
      // transient keychain visibility failure cannot lock out the control
      // plane until restart.
      vi.setSystemTime(Date.now() + 31_000);
      res = await attempt();
      expect(JSON.parse(res.body).instance?.name).toBe('synthetic-instance-name-marker-2515');
      expect(tokenLookups()).toBe(2);
    } finally {
      vi.useRealTimers();
      restoreDefaultLookupMock();
    }
  });

  it('does not share cached tokens across server instances', async () => {
    try {
      delete process.env.WHATSOUP_HEALTH_TOKEN;
      lookupCredentialMock.mockImplementation(
        (service: string, options?: { user?: string }) =>
          service === 'whatsoup-health-token' && options?.user !== undefined
            ? `token-for-${options.user}`
            : null,
      );

      const first = await httpReq(port, '/health', 'GET', undefined, {
        Authorization: 'Bearer token-for-synthetic-instance-name-marker-2515',
      });
      expect(JSON.parse(first.body).instance?.name).toBe('synthetic-instance-name-marker-2515');

      const { server: otherServer, port: otherPort } = await buildTestServer(
        makeDeps(db, { instanceName: 'other-instance-2515' }),
      );
      try {
        // The second server resolves ITS OWN scoped token…
        const own = await httpReq(otherPort, '/health', 'GET', undefined, {
          Authorization: 'Bearer token-for-other-instance-2515',
        });
        expect(JSON.parse(own.body).instance?.name).toBe('other-instance-2515');
        // …and the first server's cached token must not authorize against it.
        const crossed = await httpReq(otherPort, '/health', 'GET', undefined, {
          Authorization: 'Bearer token-for-synthetic-instance-name-marker-2515',
        });
        expect(JSON.parse(crossed.body).schema_version).toBe('health.public.v1');
      } finally {
        await new Promise<void>((resolve) => otherServer.close(() => resolve()));
      }
    } finally {
      restoreDefaultLookupMock();
    }
  });
});
