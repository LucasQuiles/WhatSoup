import { httpReq, TEST_HEALTH_TOKEN, healthReq, buildTestServer, makeDb, makeDeps } from './_helpers/health.ts';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Database } from '../../src/core/database.ts';
import { config } from '../../src/config.ts';
import { getShadowGateRecorder, __resetShadowGateForTests } from '../../src/core/shadow-gate-adapter.ts';
import { SHADOW_GATE_COUNT_KEYS } from '../../src/core/shadow-gate-events.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

describe('GET /health — shadowGate (advisory)', () => {
  const tmp = trackTmpDirs('health-shadow-gate-');
  const { join } = path;
  const mutableConfig = config as unknown as Record<string, unknown>;
  const zeroCounts = Object.fromEntries(SHADOW_GATE_COUNT_KEYS.map((k) => [k, 0]));
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;
  let savedShadowGate: PropertyDescriptor | undefined;

  beforeEach(async () => {
    savedShadowGate = Object.getOwnPropertyDescriptor(config, 'shadowGate');
    process.env.WHATSOUP_HEALTH_TOKEN = TEST_HEALTH_TOKEN;
    db = makeDb();
    ({ server, port } = await buildTestServer(makeDeps(db)));
  });

  afterEach(async () => {
    await __resetShadowGateForTests();
    if (savedShadowGate) Object.defineProperty(config, 'shadowGate', savedShadowGate);
    else delete mutableConfig.shadowGate;
    db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.WHATSOUP_HEALTH_TOKEN;
  });

  async function diagnostic(): Promise<Record<string, unknown>> {
    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    return JSON.parse(body) as Record<string, unknown>;
  }

  const statusFields = (body: Record<string, unknown>) => ({
    status: body.status,
    status_reasons: body.status_reasons,
    degradation_causes: body.degradation_causes,
  });

  it('mode off (or an absent section) reports exactly { mode: "off" }', async () => {
    expect((await diagnostic()).shadowGate).toEqual({ mode: 'off' });
    mutableConfig.shadowGate = { mode: 'off', eventsDir: join(tmp.make('off'), 'events') };
    expect((await diagnostic()).shadowGate).toEqual({ mode: 'off' });
  });

  it('shadow mode before the first dispatched message reports a not_started recorder', async () => {
    mutableConfig.shadowGate = { mode: 'shadow', eventsDir: join(tmp.make('lazy'), 'events') };
    expect((await diagnostic()).shadowGate).toEqual({
      mode: 'shadow', recorder: 'not_started', sinkState: null, sinkDegradedReason: null, counts: zeroCounts,
    });
  });

  it('a closed sink behind a registered recorder reports unavailable, not not_started', async () => {
    mutableConfig.shadowGate = { mode: 'shadow', eventsDir: join(tmp.make('closed'), 'events') };
    const recorder = getShadowGateRecorder(db, config);
    expect(recorder).not.toBeNull();
    await recorder!.close();
    expect((await diagnostic()).shadowGate).toMatchObject({
      mode: 'shadow', recorder: 'unavailable', sinkState: 'closed',
    });
  });

  it('shadow mode with a live recorder reports ready, closed codes and counters only', async () => {
    mutableConfig.shadowGate = { mode: 'shadow', eventsDir: join(tmp.make('ready'), 'events') };
    expect(getShadowGateRecorder(db, config)).not.toBeNull();

    await vi.waitFor(async () => {
      expect((await diagnostic()).shadowGate).toMatchObject({ recorder: 'ready', sinkState: 'ready' });
    });
    const shadowGate = (await diagnostic()).shadowGate as Record<string, unknown>;
    expect(Object.keys(shadowGate).sort()).toEqual(['counts', 'mode', 'recorder', 'sinkDegradedReason', 'sinkState']);
    expect(shadowGate).toMatchObject({ mode: 'shadow', sinkDegradedReason: null });
    expect(Object.keys(shadowGate.counts as object).sort()).toEqual([...SHADOW_GATE_COUNT_KEYS].sort());
    expect(shadowGate.counts).toMatchObject({ evaluated: 0, recorded: 0 });
  });

  it('a latched creation failure reports a disabled recorder', async () => {
    mutableConfig.shadowGate = {
      mode: 'shadow',
      get eventsDir(): string {
        throw new Error('bad section');
      },
    };
    expect(getShadowGateRecorder(db, config)).toBeNull();
    expect((await diagnostic()).shadowGate).toEqual({
      mode: 'shadow', recorder: 'disabled', sinkState: null, sinkDegradedReason: null, counts: zeroCounts,
    });
  });

  it('a degraded sink is reported with its reason code and leaves health status untouched', async () => {
    const baseline = statusFields(await diagnostic());
    const blocker = join(tmp.make('degraded'), 'not-a-dir');
    writeFileSync(blocker, 'x');
    mutableConfig.shadowGate = { mode: 'shadow', eventsDir: join(blocker, 'events') };
    expect(getShadowGateRecorder(db, config)).not.toBeNull();

    await vi.waitFor(async () => {
      expect((await diagnostic()).shadowGate).toMatchObject({
        mode: 'shadow', recorder: 'degraded', sinkState: 'degraded', sinkDegradedReason: 'mkdir_failed',
      });
    });
    expect(statusFields(await diagnostic())).toEqual(baseline);
  });

  it('a degraded sink that is later closed still reports degraded with its reason', async () => {
    const blocker = join(tmp.make('degraded-closed'), 'not-a-dir');
    writeFileSync(blocker, 'x');
    mutableConfig.shadowGate = { mode: 'shadow', eventsDir: join(blocker, 'events') };
    const recorder = getShadowGateRecorder(db, config)!;
    await vi.waitFor(() => expect(recorder.sinkStatus().state).toBe('degraded'));
    await recorder.close();
    expect((await diagnostic()).shadowGate).toMatchObject({
      recorder: 'degraded', sinkState: 'closed', sinkDegradedReason: 'mkdir_failed',
    });
  });

  describe('with a stubbed sink status', () => {
    function stubbedRecorder() {
      mutableConfig.shadowGate = { mode: 'shadow', eventsDir: join(tmp.make('stub'), 'events') };
      return vi.spyOn(getShadowGateRecorder(db, config)!, 'sinkStatus');
    }

    it('reports a sink that is still starting as starting, not ready', async () => {
      stubbedRecorder().mockReturnValue({ state: 'starting', degradedReason: null });
      expect((await diagnostic()).shadowGate).toMatchObject({
        recorder: 'starting', sinkState: 'starting', sinkDegradedReason: null,
      });
    });

    it('replaces a degraded reason outside the id charset with unknown', async () => {
      stubbedRecorder().mockReturnValue({ state: 'degraded', degradedReason: '/var/lib/whatsoup/events: EACCES' });
      const { body } = await healthReq(port);
      expect(body).not.toContain('/var/lib/whatsoup');
      expect((JSON.parse(body) as Record<string, unknown>).shadowGate).toMatchObject({
        recorder: 'degraded', sinkDegradedReason: 'unknown',
      });
    });

    it('a throwing sink status still answers 200 and reports unavailable', async () => {
      stubbedRecorder().mockImplementation(() => {
        throw new Error('sink status failed');
      });
      expect((await diagnostic()).shadowGate).toEqual({
        mode: 'shadow', recorder: 'unavailable', sinkState: null, sinkDegradedReason: null,
        counts: expect.objectContaining({ evaluated: 0 }),
      });
    });
  });
});

// ---------------------------------------------------------------------------
// #2481 — the versioned `health_invariants` block (report-only).
//
// The producer emits a compile-time constant on the DIAGNOSTIC body only; the
// release-activation tool classifies it against its own floor. New modules are
// loaded with in-test `await import(...)` so this file still loads where they
// do not exist yet.
// ---------------------------------------------------------------------------

describe('GET /health — #2481 health_invariants block', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    db = makeDb();
    process.env.WHATSOUP_HEALTH_TOKEN = TEST_HEALTH_TOKEN;
    ({ server, port } = await buildTestServer(makeDeps(db)));
  });

  afterEach(async () => {
    db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.WHATSOUP_HEALTH_TOKEN;
  });

  it('emits the versioned block on the diagnostic body (literal lockstep)', async () => {
    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    expect((JSON.parse(body) as Record<string, unknown>).health_invariants).toEqual({
      schema: 'whatsoup.health-invariants.v1',
      ids: [
        'turn_capability.stale_evidence_degrades',
        'turn_capability.probe_expected_stale_degrades',
        'health.diagnostic_requires_token',
      ],
    });
  });

  it('emits the leaf constant verbatim', async () => {
    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const block = (JSON.parse(body) as Record<string, unknown>).health_invariants;
    const { HEALTH_INVARIANTS, HEALTH_INVARIANTS_SCHEMA } = await import('../../src/core/health-invariants.ts');
    expect(block).toEqual({ schema: HEALTH_INVARIANTS_SCHEMA, ids: [...HEALTH_INVARIANTS] });
  });

  it('keeps the block off the public envelope (#2515 boundary)', async () => {
    const { body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body) as Record<string, unknown>;
    expect(json.schema_version).toBe('health.public.v1');
    expect(json).not.toHaveProperty('health_invariants');
    expect(body).not.toContain('health_invariants');
  });

  it('leaves the diagnostic body without a top-level schema_version (unchanged discriminator)', async () => {
    const { body } = await healthReq(port);
    expect(JSON.parse(body) as Record<string, unknown>).not.toHaveProperty('schema_version');
  });

  // The test #3014 lacked: the REAL server's authenticated bytes, read by the
  // REAL release-activation reader and classifier. Nothing here writes the block.
  it('producer/consumer: the real diagnostic body classifies satisfied against the tool floor', async () => {
    const requestedAtMs = Date.now();
    const { status, body } = await healthReq(port);
    const { classifyAuthenticatedHealth } = await import('../../scripts/lib/release-activation/host.ts');
    const observation = classifyAuthenticatedHealth(status, body);
    expect(observation.projection).toBe('diagnostic');
    expect((observation as { invariants?: unknown }).invariants).toMatchObject({ reading: 'declared' });
    // The real producer names its own pid; here the process that served the body is this one.
    expect((observation as { responderPid?: unknown }).responderPid).toBe(process.pid);

    const { releaseInvariantsVerdict, resolveBinding } = await import('../../scripts/lib/release-activation/invariants.ts');
    // The launchd pid, argv and start-time sample is release:activate's job
    // (launchctl + ps); the responder half is checked against the body here.
    // This process started well before the request it just answered.
    const binding = resolveBinding(
      { pid: process.pid, argvMatches: true, passed: true, health: observation, requestedAtMs },
      { pid: process.pid, argvMatches: true, startedAtMs: requestedAtMs - 60_000 },
    );
    expect(binding).toBe('bound');
    expect(releaseInvariantsVerdict({
      pid: process.pid,
      argvMatches: true,
      health: observation,
      binding,
    })).toEqual({
      outcome: 'satisfied',
      detail: null,
      schema: 'known',
      undeclared: [],
    });
  });

  // Lead condition 2. Both readers cap the body at 65 536 bytes:
  // scripts/lib/release-activation/host.ts HEALTH_MAX_BYTES (the TypeScript
  // reader release:activate uses) and deploy/scripts/lib/health_reader.py
  // (`raw = response.read(65537)` / `len(raw) > 65536`). Over the cap, the
  // reader destroys the request and verification reads `unobserved`, which
  // fails the activation, so the block must not push the body near it.
  // The byte counts are computed on every run but appear ONLY in the assertion
  // message, i.e. only when an assertion fails; a passing run proves the bounds
  // without recording the numbers. The body is this harness's chat-mode body,
  // not a production agent-mode body, and it is checked against the exported
  // cap constant, not read through the real fetch.
  it('the diagnostic body with the block is measured well under the 65 536-byte reader cap', async () => {
    const { HEALTH_MAX_BYTES } = await import('../../scripts/lib/release-activation/host.ts') as { HEALTH_MAX_BYTES?: number };
    expect(HEALTH_MAX_BYTES).toBe(65_536);

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body) as Record<string, unknown>;
    expect(json).toHaveProperty('health_invariants');

    const bodyBytes = Buffer.byteLength(body, 'utf8');
    const blockBytes = Buffer.byteLength(JSON.stringify({ health_invariants: json.health_invariants }), 'utf8');
    const measured = `diagnostic /health body measured ${bodyBytes} bytes (block ${blockBytes} bytes) against cap ${HEALTH_MAX_BYTES}`;
    expect(blockBytes, measured).toBeLessThanOrEqual(1_024);
    // Margin: at most half the cap, so a production body larger than this
    // harness's chat-mode body still has room.
    expect(bodyBytes, measured).toBeLessThanOrEqual(HEALTH_MAX_BYTES! / 2);
  });
});
