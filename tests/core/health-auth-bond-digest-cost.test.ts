/**
 * P42 — the /health request path must not walk and hash the Baileys auth tree.
 *
 * Every GET /health used to call ConnectionManager.getConnectionState(), which
 * called AuthBondGuard.inspect(), which walked the auth directory twice (a
 * harden/chmod pass and a read-and-SHA-256 pass) synchronously on the main
 * thread. On the `personal` instance that is 17,680 files and ~400 ms of
 * blocked event loop per request, which the loop-lag gauge in the same response
 * then reported as `event_loop_starved` — the observer manufacturing the
 * starvation it reports.
 *
 * These tests pin the three properties the fix has to hold:
 *   1. a read of the observability path never performs the walk inline,
 *   2. the cached digest is byte-identical to the synchronous one, and
 *   3. the lag sampler excludes observer cost across the whole window, not
 *      only the request that is being served.
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config.ts', () => ({
  config: {
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set(['15550100001']),
    controlPeers: new Map<string, string>(),
    dbPath: ':memory:',
    mediaDir: '/tmp/whatsoup-test-media-health-digest-cost/tmp',
    botName: 'phbot',
    accessMode: 'allowlist',
    healthPort: 9999,
    healthBindAddress: '127.0.0.1',
    agentProvider: 'claude-cli',
    models: { conversation: 'claude-opus-4-5', extraction: 'claude-haiku-4-5', validation: 'claude-haiku-4-5', fallback: 'claude-sonnet-4-5' },
  },
}));

const lookupCredentialMock = vi.hoisted(() => vi.fn(
  (service: string) => service === 'whatsoup-health-token' ? process.env.WHATSOUP_HEALTH_TOKEN ?? null : null,
));
vi.mock('../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/keyring.ts')>();
  return { ...actual, lookupCredential: lookupCredentialMock };
});
vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return { createChildLogger: () => loggerMock().createChildLogger() };
});
vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlert: vi.fn(() => true),
  emitAlertChecked: vi.fn(() => true),
  emitObservationChecked: vi.fn(() => true),
  clearAlertSource: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

import { Database } from '../../src/core/database.ts';
import { startHealthServer, type HealthDeps } from '../../src/core/health.ts';
import { AuthBondGuard } from '../../src/transport/auth-bond.ts';
import { LoopLagSampler } from '../../src/lib/loop-lag-sampler.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';
import { emptyConnectionStateSnapshot } from '../../src/transport/twilio/connection-snapshot.ts';

const TOKEN = 'test-health-token-digest-cost';

/**
 * ~2,000 files, the fixture size the P42 brief names. The real instance carries
 * 17,680; 2,000 is enough to make an inline walk cost tens of milliseconds
 * while keeping the fixture cheap to build.
 */
const FIXTURE_FILES = 2_000;
/** The brief's budget: a health request may not block the loop longer than this. */
const MAX_BLOCK_MS = 50;

let fixtureRoot = '';
let authDir = '';
let stateRoot = '';

function buildFixture(): void {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'whatsoup-p42-'));
  authDir = join(fixtureRoot, 'auth');
  stateRoot = join(fixtureRoot, 'state');
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(authDir, 'creds.json'), JSON.stringify({
    me: { id: '15550100001:1@s.whatsapp.net', lid: '12345:1@lid' },
    registrationId: 1,
  }), { mode: 0o600 });
  for (let i = 0; i < FIXTURE_FILES; i += 1) {
    writeFileSync(
      join(authDir, `pre-key-${String(i).padStart(5, '0')}.json`),
      JSON.stringify({ keyId: i, keyData: 'x'.repeat(64) }),
      { mode: 0o600 },
    );
  }
}

function makeGuard(): AuthBondGuard {
  return new AuthBondGuard({ authDir, stateRoot, instanceName: 'p42-test' });
}

/**
 * Recompute the tree digest from the documented format alone.
 *
 * Comparing inspectCached() against inspect() only proves the two agree; if the
 * shared walk were wrong they would agree on the wrong answer. This is written
 * against the format the digest commits to — relative path, octal mode, the
 * literal 'file', then contents, each NUL-terminated, over lexicographically
 * sorted paths — so it fails independently if the walk changes what it hashes
 * or the order it hashes it in. treeHash gates auth-bond tamper detection, so
 * that property is worth an independent check rather than a self-comparison.
 */
function referenceTreeDigest(dir: string): { hash: string; fileCount: number; totalBytes: number } {
  const paths: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const st = lstatSync(current);
    if (st.isDirectory()) {
      stack.push(...readdirSync(current).filter(name => name !== '.DS_Store').map(name => join(current, name)));
      continue;
    }
    if (st.isFile()) paths.push(current);
  }
  paths.sort();
  const hasher = createHash('sha256');
  let totalBytes = 0;
  for (const path of paths) {
    const st = lstatSync(path);
    totalBytes += st.size;
    hasher.update(relative(dir, path));
    hasher.update('\0');
    hasher.update((st.mode & 0o777).toString(8));
    hasher.update('\0');
    hasher.update('file');
    hasher.update('\0');
    hasher.update(readFileSync(path));
    hasher.update('\0');
  }
  return { hash: hasher.digest('hex'), fileCount: paths.length, totalBytes };
}

/**
 * Measure the longest stretch the event loop was unable to run a macrotask.
 *
 * A setImmediate chain re-arms itself as fast as the loop allows, so the
 * largest gap between consecutive runs is the longest synchronous block that
 * occurred while the probe was armed. This is the only instrument in these
 * tests that can tell "the walk moved off the request path" from "the walk got
 * faster" — a wall-clock timing of the call would pass for both.
 */
function startBlockProbe(): { stop: () => number } {
  let last = performance.now();
  let maxGapMs = 0;
  let armed = true;
  const tick = (): void => {
    if (!armed) return;
    const now = performance.now();
    const gap = now - last;
    if (gap > maxGapMs) maxGapMs = gap;
    last = now;
    setImmediate(tick);
  };
  setImmediate(tick);
  return {
    stop: () => {
      armed = false;
      return maxGapMs;
    },
  };
}

/** Let the probe chain run so a block that just ended is actually observed. */
async function settle(iterations = 40): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

function healthReq(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port, path: '/health', method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function buildTestServer(deps: HealthDeps): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  return new Promise((resolve) => {
    const server = startHealthServer(deps);
    server.close(() => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 });
      });
    });
  });
}

function makeDeps(db: Database, guard: AuthBondGuard): HealthDeps {
  return {
    db,
    connectionManager: {
      botJid: '15551230004@s.whatsapp.net',
      botLid: null,
      sendMessage: vi.fn(),
      sendMedia: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      // The production seam under test: the observability read path reads the
      // cached tree digest instead of walking the tree inline.
      getConnectionState: () => ({
        ...emptyConnectionStateSnapshot({
          connected: true,
          stateChangedAt: '2026-09-03T00:00:00.000Z',
          lastDisconnectReason: null,
        }),
        authBond: guard.inspectCached(),
      }),
    } as unknown as ConnectionManager,
    startedAt: Date.now() - 60_000,
    getEnrichmentStats: vi.fn().mockReturnValue({ lastRun: null, unprocessed: 0 }),
    instanceName: 'phbot',
    instanceType: 'agent',
    accessMode: 'allowlist',
  };
}

beforeAll(() => {
  process.env.WHATSOUP_HEALTH_TOKEN = TOKEN;
  buildFixture();
});

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  delete process.env.WHATSOUP_HEALTH_TOKEN;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AuthBondGuard.inspectCached — the auth-tree walk is off the read path', () => {
  it('does not walk the tree inline on a cold cache', async () => {
    const guard = makeGuard();
    const probe = startBlockProbe();
    await settle(5);

    const snapshot = guard.inspectCached();

    await settle(5);
    const maxGapMs = probe.stop();

    // A cold read reports that it has no digest yet and that it started one,
    // rather than paying for the walk to answer the question.
    expect(snapshot.treeProvenance).toBeDefined();
    expect(snapshot.treeProvenance?.source).toBe('absent');
    expect(snapshot.treeProvenance?.refreshInFlight).toBe(true);
    expect(maxGapMs).toBeLessThan(MAX_BLOCK_MS);

    // The read above started a walk over 2,000 files. Drain it before leaving,
    // or its background I/O lands inside a later test's timing probe.
    await guard.warmTreeCache();
  });

  it('serves a cached digest identical to the synchronous computation', async () => {
    const guard = makeGuard();
    await guard.warmTreeCache();

    const cached = guard.inspectCached();
    const live = guard.inspect();
    const reference = referenceTreeDigest(authDir);

    expect(cached.treeProvenance?.source).toBe('cached');
    expect(cached.treeHash).toBe(live.treeHash);
    expect(cached.fileCount).toBe(live.fileCount);
    expect(cached.totalBytes).toBe(live.totalBytes);
    expect(cached.status).toBe(live.status);
    expect(cached.issues).toEqual(live.issues);
    expect(typeof cached.treeProvenance?.ageMs).toBe('number');

    // Independent of both: the digest is what the documented format says it is.
    expect(cached.treeHash).toBe(reference.hash);
    expect(live.treeHash).toBe(reference.hash);
    expect(cached.totalBytes).toBe(reference.totalBytes);

    // Positive control. Everything above would also pass against an empty
    // directory, where no walk is expensive and the 50 ms budget is met for
    // the wrong reason. Pin that the fixture really is at the scale the P42
    // brief names, so the timing assertions are measuring something.
    expect(reference.fileCount).toBeGreaterThanOrEqual(FIXTURE_FILES);
    expect(cached.fileCount).toBeGreaterThanOrEqual(FIXTURE_FILES);
  });

  it('costs materially less than the synchronous walk it replaced', async () => {
    const guard = makeGuard();
    await guard.warmTreeCache();

    const syncProbe = startBlockProbe();
    await settle(5);
    guard.inspect();
    await settle(5);
    const syncBlockMs = syncProbe.stop();

    const cachedProbe = startBlockProbe();
    await settle(5);
    guard.inspectCached();
    await settle(5);
    const cachedBlockMs = cachedProbe.stop();

    // The comparison is relative on purpose: an absolute floor for the
    // synchronous walk would be a machine-speed assertion and would flake.
    // What must hold on any machine is that the read path stopped doing the
    // work the walk does.
    expect(syncBlockMs).toBeGreaterThan(cachedBlockMs);
    expect(cachedBlockMs).toBeLessThan(MAX_BLOCK_MS);
  });

  it('refreshes without blocking the loop for the length of a walk', async () => {
    const guard = makeGuard();
    const probe = startBlockProbe();
    await settle(5);

    await guard.warmTreeCache();

    await settle(5);
    const maxGapMs = probe.stop();

    // The yielding walk hands the loop back between slices, so no single slice
    // may approach the cost of the whole tree.
    expect(guard.inspectCached().treeHash).toHaveLength(64);
    expect(maxGapMs).toBeLessThan(MAX_BLOCK_MS);
  });

  it('picks up a changed tree after invalidation', async () => {
    const guard = makeGuard();
    await guard.warmTreeCache();
    const before = guard.inspectCached().treeHash;

    writeFileSync(join(authDir, 'pre-key-added.json'), JSON.stringify({ keyId: 'added' }), { mode: 0o600 });
    guard.invalidateTreeCache('test-mutation');
    await guard.warmTreeCache();

    const after = guard.inspectCached().treeHash;
    // Read the live digest while the added file is still present: this test
    // shares one fixture with the rest of the file, so the cleanup below has to
    // happen before any assertion can throw, and the comparison has to be
    // against the tree as it was when the cached digest was taken.
    const liveAfter = guard.inspect().treeHash;
    rmSync(join(authDir, 'pre-key-added.json'), { force: true });

    expect(before).toHaveLength(64);
    expect(after).not.toBe(before);
    expect(after).toBe(liveAfter);
  });
});

describe('GET /health — request cost and digest provenance', () => {
  it('serves the auth-bond digest without blocking the loop, and reports its age', async () => {
    const db = new Database(':memory:');
    // open() applies the pragmas and runs the migrations; startHealthServer
    // prepares statements against the schema they create.
    db.open();
    const guard = makeGuard();
    await guard.warmTreeCache();
    const { server, port } = await buildTestServer(makeDeps(db, guard));

    try {
      // Warm the HTTP path once so first-request setup is not attributed to the
      // measured request.
      await healthReq(port);

      const probe = startBlockProbe();
      await settle(5);
      const res = await healthReq(port);
      await settle(5);
      const maxGapMs = probe.stop();

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as Record<string, any>;
      // The auth-bond projection lives under `whatsapp`, not at the root.
      expect(body.whatsapp.auth_bond).toBeTruthy();
      expect(typeof body.whatsapp.auth_bond.digest_age_ms).toBe('number');
      expect(typeof body.whatsapp.auth_bond.digest_refresh_in_flight).toBe('boolean');
      expect(body.whatsapp.auth_bond.digest_source).toBe('cached');
      expect(body.whatsapp.auth_bond.tree_hash).toBeTruthy();
      expect(typeof body.event_loop.observer_cost_ms).toBe('number');
      expect(maxGapMs).toBeLessThan(MAX_BLOCK_MS);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('reports the live path as live, with no refresh-scheduler provenance', async () => {
    const db = new Database(':memory:');
    db.open();
    const guard = makeGuard();
    // No getHealthConnectionState, so health.ts falls back to the live getter
    // and the snapshot it returns carries no treeProvenance at all.
    const deps = {
      ...makeDeps(db, guard),
      connectionManager: {
        botJid: '15551230004@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn(),
        sendMedia: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        getConnectionState: () => ({
          ...emptyConnectionStateSnapshot({
            connected: true, stateChangedAt: '2026-09-03T00:00:00.000Z', lastDisconnectReason: null,
          }),
          authBond: guard.inspect(),
        }),
      } as unknown as ConnectionManager,
    } as HealthDeps;
    const { server, port } = await buildTestServer(deps);

    try {
      const res = await healthReq(port);
      const body = JSON.parse(res.body) as Record<string, any>;
      const bond = body.whatsapp.auth_bond;

      // Positive control: this really is the live projection. Without it the
      // three assertions below would also pass against a cached read that
      // happened to have nothing scheduled.
      expect(bond.digest_source).toBe('live');
      expect(bond.digest_refresh_outcome).toBe('live');
      expect(bond.tree_hash).toBeTruthy();

      // The documented live-path defaults. These three fields describe the
      // cached refresh scheduler, which the live path does not have, so an
      // operator reading false/null here is seeing an absent scheduler and not
      // an idle one — which is what docs/public-surface.md now says.
      expect(bond.digest_refresh_scheduled).toBe(false);
      expect(bond.digest_next_refresh_eligible_ms).toBeNull();
      expect(bond.digest_refresh_attempts).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
});

describe('LoopLagSampler — observer cost is excluded across the window', () => {
  it('does not report starvation built from the health handler own cost', () => {
    vi.useFakeTimers();
    let clock = 0;
    const sampler = new LoopLagSampler({ now: () => clock, wallNow: () => clock });
    sampler.start();

    // Twenty consecutive intervals, each with a 400 ms health handler running
    // INSIDE the overdue region — the handler is what delayed the timer. Every
    // interval lands 900 ms after the last instead of 500 ms, and without the
    // exclusion each sample reads 400 ms; the second-largest-of-twenty
    // statistic then crosses the 250 ms threshold, which is exactly the false
    // `event_loop_starved` the P42 diagnosis observed.
    for (let i = 0; i < 20; i += 1) {
      sampler.recordObserverSpan(clock + 500, clock + 900);
      clock += 900;
      vi.advanceTimersByTime(500);
    }

    const snap = sampler.snapshot();
    expect(snap.sampleCount).toBe(20);
    expect(snap.locallyStarved).toBe(false);
    expect(snap.p95LagMs).toBeLessThan(250);
    // The excluded cost stays visible so a consumer can see what the observer
    // spent, rather than it vanishing silently.
    expect(snap.observerCostMs).toBeGreaterThan(0);
    sampler.stop();
  });

  it('does not let observer work before the deadline hide real starvation', () => {
    vi.useFakeTimers();
    let clock = 0;
    const sampler = new LoopLagSampler({ now: () => clock, wallNow: () => clock });
    sampler.start();

    // Baseline 0, deadline 500. The observer ran entirely BEFORE the timer was
    // due, so it delayed nothing; the 400 ms after the deadline is somebody
    // else's stall and must be reported in full. Subtracting the whole
    // baseline-to-callback overlap reported zero here.
    sampler.recordObserverSpan(100, 500);
    clock = 900;
    vi.advanceTimersByTime(500);

    expect(sampler.rawSamples().map((sample) => sample.lagMs)).toEqual([400]);
    sampler.stop();
  });

  it('counts overlapping observer spans once, not twice', () => {
    vi.useFakeTimers();
    let clock = 0;
    const sampler = new LoopLagSampler({ now: () => clock, wallNow: () => clock });
    sampler.start();

    // Two handlers overlapping in [600,800]. Together they occupied the loop
    // for 400 ms of the 600 ms overdue region, so 200 ms of real lag remains.
    // Summing the spans instead of taking their union subtracts 600 and reports
    // zero, hiding that stall entirely.
    sampler.recordObserverSpan(500, 800);
    sampler.recordObserverSpan(600, 900);
    clock = 1100;
    vi.advanceTimersByTime(500);

    expect(sampler.rawSamples().map((sample) => sample.lagMs)).toEqual([200]);
    sampler.stop();
  });

  it('accounts for an observer span that is still running', () => {
    vi.useFakeTimers();
    let clock = 0;
    const sampler = new LoopLagSampler({ now: () => clock, wallNow: () => clock });
    sampler.start();

    // The interval fires while the handler is mid-flight. A span registered
    // only on close cannot explain the sample it caused, so the whole 500 ms
    // would read as starvation instead of 100 ms.
    clock = 600;
    const endSpan = sampler.beginObserverSpan();
    clock = 1000;
    vi.advanceTimersByTime(500);

    expect(sampler.rawSamples().map((sample) => sample.lagMs)).toEqual([100]);
    endSpan();
    sampler.stop();
  });

  it('does not subtract observer time twice across a snapshot-to-interval handoff', () => {
    vi.useFakeTimers();
    let clock = 0;
    const sampler = new LoopLagSampler({ now: () => clock, wallNow: () => clock });
    sampler.start();

    // A recorded snapshot rebases the baseline to actual - interval, which is
    // EARLIER than the moment it just consumed. Trimming spans against that
    // rebased baseline rather than against the observation time leaves the last
    // interval's worth of already-counted observer time in the list, and the
    // next interval subtracts it a second time.
    sampler.recordObserverSpan(600, 1400);
    clock = 1600;
    sampler.snapshot();

    // A genuine 300 ms block with no observer activity anywhere inside it.
    clock = 1900;
    vi.advanceTimersByTime(500);

    const lags = sampler.rawSamples().map((sample) => sample.lagMs);
    // Second entry is the interval fire. Double subtraction erases it to 0.
    expect(lags).toEqual([300, 300]);
    sampler.stop();
  });

  it('still reports genuine starvation that no observer span explains', () => {
    vi.useFakeTimers();
    let clock = 0;
    const sampler = new LoopLagSampler({ now: () => clock, wallNow: () => clock });
    sampler.start();

    for (let i = 0; i < 20; i += 1) {
      // A 400 ms stall with only 10 ms of observer cost inside it: the residue
      // is real and must survive the exclusion.
      sampler.recordObserverSpan(clock + 100, clock + 110);
      clock += 900;
      vi.advanceTimersByTime(500);
    }

    const snap = sampler.snapshot();
    expect(snap.sampleCount).toBe(20);
    expect(snap.locallyStarved).toBe(true);
    sampler.stop();
  });
});

// ===========================================================================
// MUST-2 — an unobserved tree must never read as a healthy one.
//
// The first version of this cache discarded the observation on every
// invalidation. Until the refresh landed, inspectCached() built its snapshot
// from an empty harden-issue list, so a tree carrying a planted symlink or a
// failed chmod reported status 'present' with no issues, and
// classifyAuthFailure returned 'none'. The alerting path read clean on a dirty
// tree. These tests pin the three properties that close it.
// ===========================================================================

/** Every isolated fixture built by makeOwnFixture, removed once at the end. */
const ownFixtureRoots: string[] = [];
afterAll(() => {
  for (const r of ownFixtureRoots) rmSync(r, { recursive: true, force: true });
});

/** An isolated auth fixture, so a test that dirties a tree cannot leak into the shared one. */
function makeOwnFixture(files = 12): { root: string; authDir: string; stateRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'whatsoup-p42-must2-'));
  const ownAuthDir = join(root, 'auth');
  mkdirSync(ownAuthDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(ownAuthDir, 'creds.json'), JSON.stringify({
    me: { id: '15550100001:1@s.whatsapp.net', lid: '12345:1@lid' },
    registrationId: 1,
  }), { mode: 0o600 });
  for (let i = 0; i < files; i += 1) {
    writeFileSync(join(ownAuthDir, `pre-key-${i}.json`), JSON.stringify({ keyId: i }), { mode: 0o600 });
  }
  return { root, authDir: ownAuthDir, stateRoot: join(root, 'state') };
}

describe('MUST-2 — an unobserved auth tree must not read as a clean one', () => {
  it('keeps the last observation after an invalidation instead of discarding it', async () => {
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    symlinkSync(join(fx.authDir, 'creds.json'), join(fx.authDir, 'planted-symlink.json'));

    const guard = new AuthBondGuard({
      authDir: fx.authDir, stateRoot: fx.stateRoot, instanceName: 'p42-must2',
    });
    await guard.warmTreeCache();

    const warm = guard.inspectCached();
    expect(warm.status).toBe('invalid');
    expect(warm.issues.some(i => i.startsWith('auth_tree_symlink:'))).toBe(true);

    // The event that invalidates says the tree CHANGED, not that it became
    // unknowable. The last observation is the best evidence available until a
    // newer one exists, so it must survive, marked stale.
    guard.invalidateTreeCache('creds-update-saved');
    const afterInvalidate = guard.inspectCached();

    expect(afterInvalidate.treeProvenance?.source).toBe('stale');
    expect(afterInvalidate.treeProvenance?.lastInvalidationReason).toBe('creds-update-saved');
    expect(typeof afterInvalidate.treeProvenance?.ageMs).toBe('number');
    // The load-bearing assertion: the symlink is still reported.
    expect(afterInvalidate.issues.some(i => i.startsWith('auth_tree_symlink:'))).toBe(true);
    expect(afterInvalidate.status).toBe('invalid');
  });

  it('reports a never-warmed cache as unknown rather than present', () => {
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    const guard = new AuthBondGuard({
      authDir: fx.authDir, stateRoot: fx.stateRoot, instanceName: 'p42-must2-cold',
    });

    const cold = guard.inspectCached();

    expect(cold.treeProvenance?.source).toBe('absent');
    expect(cold.status).toBe('unknown');
    expect(cold.issues).toContain('auth_tree_unobserved');
    expect(cold.treeHash).toBeNull();
    // inspect() is the live path and must be unaffected by any of this.
    expect(guard.inspect().status).toBe('present');
    expect(guard.inspect().treeProvenance).toBeUndefined();
  });

  it('reports a digest stale past the risk bound as unknown', async () => {
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    let clockMs = 1_760_000_000_000;
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: 'p42-must2-stale',
      // Age is monotonic by design: a wall-clock rollback must not be able to
      // make a stale digest read as fresh.
      monotonicNow: () => clockMs,
      treeCacheMaxAgeMs: 30_000,
      treeRefreshMinIntervalMs: 0,
    });
    await guard.warmTreeCache();
    expect(guard.inspectCached().status).toBe('present');

    // Past the refresh trigger but inside the risk bound: stale, still trusted.
    clockMs += 45_000;
    const merelyStale = guard.inspectCached();
    expect(merelyStale.treeProvenance?.source).toBe('stale');
    expect(merelyStale.status).toBe('present');

    // Past the risk bound: the digest is too old to stand behind.
    clockMs += 120_000;
    const overStale = guard.inspectCached();
    expect(overStale.status).toBe('unknown');
    expect(overStale.issues.some(i => i.startsWith('auth_tree_stale:'))).toBe(true);
  });
});

describe('r2 SHOULD-1 — /health prefers the cached projection over the live getter', () => {
  it('reads getHealthConnectionState, not getConnectionState', async () => {
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    const db = new Database(':memory:');
    db.open();
    const guard = new AuthBondGuard({
      authDir: fx.authDir, stateRoot: fx.stateRoot, instanceName: 'p42-r2-should1', treeRefreshMinIntervalMs: 0,
    });
    await guard.warmTreeCache();

    // The two getters return observably different snapshots: the live one has
    // no provenance at all, the cached one is stamped `cached`. Only preferring
    // the cached reader can produce `digest_source: "cached"` in the body.
    const liveCalls: string[] = [];
    const deps = {
      db,
      connectionManager: {
        botJid: '15551230004@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn(),
        sendMedia: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        getConnectionState: () => {
          liveCalls.push('live');
          return {
            ...emptyConnectionStateSnapshot({
              connected: true, stateChangedAt: '2026-09-03T00:00:00.000Z', lastDisconnectReason: null,
            }),
            authBond: guard.inspect(),
          };
        },
        getHealthConnectionState: () => ({
          ...emptyConnectionStateSnapshot({
            connected: true, stateChangedAt: '2026-09-03T00:00:00.000Z', lastDisconnectReason: null,
          }),
          authBond: guard.inspectCached(),
        }),
      } as unknown as ConnectionManager,
      startedAt: Date.now() - 60_000,
      getEnrichmentStats: vi.fn().mockReturnValue({ lastRun: null, unprocessed: 0 }),
      instanceName: 'phbot',
      instanceType: 'agent' as const,
      accessMode: 'allowlist' as const,
    } as unknown as HealthDeps;

    const { server, port } = await buildTestServer(deps);
    try {
      const res = await healthReq(port);
      const body = JSON.parse(res.body) as Record<string, any>;

      // Deleting the `getHealthConnectionState?.() ??` preference in health.ts
      // sends every request back to a live tree walk — the whole P42 cost — and
      // this is the assertion that catches it.
      expect(body.whatsapp.auth_bond.digest_source).toBe('cached');
      expect(typeof body.whatsapp.auth_bond.digest_age_ms).toBe('number');
      expect(liveCalls).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
});

describe('HIGH-2 — credential reads refuse to follow a link, cache or no cache', () => {
  it('rejects a symlinked creds.json even while the cached tree reads clean', async () => {
    const fx = makeOwnFixture();
    const guard = new AuthBondGuard({
      authDir: fx.authDir, stateRoot: fx.stateRoot, instanceName: 'p42-high2', treeRefreshMinIntervalMs: 0,
    });
    await guard.warmTreeCache();
    expect(guard.inspectCached().status).toBe('present');

    // Swap creds.json for a link to valid JSON elsewhere. The cached tree walk
    // still says the tree is clean, so this is caught only by the live,
    // per-request O_NOFOLLOW open.
    writeFileSync(join(fx.root, 'elsewhere.json'), JSON.stringify({
      me: { id: '19995550000:1@s.whatsapp.net' },
    }), { mode: 0o600 });
    rmSync(join(fx.authDir, 'creds.json'));
    symlinkSync(join(fx.root, 'elsewhere.json'), join(fx.authDir, 'creds.json'));

    const linked = guard.inspectCached();
    rmSync(fx.root, { recursive: true, force: true });

    // The exact terminal shape proves both cache provenance and that no
    // identity was parsed from the link target.
    expect(linked).toMatchObject({
      status: 'invalid',
      meHash: null,
      issues: expect.arrayContaining(['creds_json_symlink']),
      treeProvenance: { source: 'cached' },
    });
  });

  it('rejects a symlinked auth root', () => {
    const fx = makeOwnFixture();
    const linkedRoot = join(fx.root, 'auth-link');
    symlinkSync(fx.authDir, linkedRoot);
    const guard = new AuthBondGuard({
      authDir: linkedRoot, stateRoot: fx.stateRoot, instanceName: 'p42-high2-root',
    });

    const snap = guard.inspect();
    rmSync(fx.root, { recursive: true, force: true });

    expect(snap.issues).toContain('auth_dir_symlink');
    expect(snap.status).toBe('invalid');
  });
});

describe('r3 MUST-1 — a bad auth root is refused before the credential is read', () => {
  it('does not read creds.json through a symlinked auth root, even on a clean cache', async () => {
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    const guard = new AuthBondGuard({
      authDir: fx.authDir, stateRoot: fx.stateRoot, instanceName: 'p42-r3-must1', treeRefreshMinIntervalMs: 0,
    });
    await guard.warmTreeCache();
    expect(guard.inspectCached().meHash).not.toBeNull();

    // Swap the root for a link to a directory holding DIFFERENT credentials.
    // O_NOFOLLOW guards only the final component, so the child open still
    // traverses the attacker-chosen directory unless the root check gates it.
    const decoy = join(fx.root, 'decoy');
    mkdirSync(decoy, { recursive: true, mode: 0o700 });
    writeFileSync(join(decoy, 'creds.json'), JSON.stringify({
      me: { id: '19998887777:1@s.whatsapp.net' },
    }), { mode: 0o600 });
    renameSync(fx.authDir, join(fx.root, 'auth-real'));
    symlinkSync(decoy, fx.authDir);

    const snap = guard.inspectCached();

    // The load-bearing terminal shape: no identity or credential digest was
    // taken from the link target.
    expect(snap).toMatchObject({
      status: 'invalid',
      meHash: null,
      creds: { sha256: null },
      issues: expect.arrayContaining(['auth_dir_symlink']),
    });
  });
});

describe('r3 MUST-2 — a walk that never inspected a tree is not a fresh observation', () => {
  it('does not publish an absent root as a fresh digest', async () => {
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    const missingRoot = join(fx.root, 'not-created-yet');
    const guard = new AuthBondGuard({
      authDir: missingRoot, stateRoot: fx.stateRoot, instanceName: 'p42-r3-must2', treeRefreshMinIntervalMs: 0,
    });

    await guard.warmTreeCache();

    const prov = guard.inspectCached().treeProvenance!;
    // A walk over a root that is not there inspected nothing. Publishing it as
    // `fresh` stamps a current timestamp on a null digest and an empty issue
    // list, which later reads as a clean tree.
    expect(prov.lastRefreshKind).not.toBe('fresh');
    expect(prov.source).toBe('absent');

    // A read on a null observation can fire `void refreshTreeCache()`, and
    // afterAll removes this fixture root, so leave nothing walking. Since the
    // failed-walk retry landed, the read above is usually held by the armed
    // successor instead and starts nothing — this drain is kept because that
    // is a scheduling detail, not a guarantee the test should depend on.
    // warmTreeCache awaits any walk already in flight before it forces
    // anything, which is the drain this file uses at the end of the cold-cache
    // test near the top. The seam test's settleDigest cannot be used here: it
    // polls for `cached`, which an absent root never reaches, and a poll
    // through inspectCached() on a null observation would restart the very
    // walk it is waiting for.
    await guard.warmTreeCache();
  });

  it('does not read green after the root reappears under a null-tree observation', async () => {
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    const lateRoot = join(fx.root, 'late-auth');
    const guard = new AuthBondGuard({
      authDir: lateRoot, stateRoot: fx.stateRoot, instanceName: 'p42-r3-must2-window', treeRefreshMinIntervalMs: 0,
    });

    // A walk lands while the root is absent — the restore window.
    await guard.warmTreeCache();

    // The root comes back, healthy.
    mkdirSync(lateRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(lateRoot, 'creds.json'), JSON.stringify({
      me: { id: '15550100001:1@s.whatsapp.net', lid: '12345:1@lid' },
    }), { mode: 0o600 });

    const snap = guard.inspectCached();

    // Live credential checks now pass, so nothing else stops `present`. The
    // cached observation must not be allowed to supply a clean tree it never saw.
    expect(snap.treeHash).toBeNull();
    expect(snap.status).not.toBe('present');

    // Same drain, same reason: the read above started a background walk and
    // afterAll is about to remove the tree underneath it.
    await guard.warmTreeCache();
  });
});

describe('MED-3 — refresh outcome is typed and age is monotonic', () => {
  it('reports a completed walk as fresh and counts it', async () => {
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    const guard = new AuthBondGuard({
      authDir: fx.authDir, stateRoot: fx.stateRoot, instanceName: 'p42-med3', treeRefreshMinIntervalMs: 0,
    });

    expect(guard.inspectCached().treeProvenance?.lastRefreshKind).toBe('none');
    await guard.warmTreeCache();

    const warm = guard.inspectCached();
    expect(warm.treeProvenance?.lastRefreshKind).toBe('fresh');
    expect(warm.treeProvenance?.lastRefreshReason).toBeNull();
    expect(warm.treeProvenance?.refreshCount).toBe(1);
  });

  it('does not let a wall-clock rollback refresh a stale digest', async () => {
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    let monotonicMs = 1_000;
    let wallMs = 1_760_000_000_000;
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: 'p42-med3-clock',
      now: () => new Date(wallMs),
      monotonicNow: () => monotonicMs,
      treeCacheMaxAgeMs: 30_000,
      treeRefreshMinIntervalMs: 0,
    });
    await guard.warmTreeCache();

    // Two minutes of real elapsed time, while the wall clock is dragged an hour
    // backwards. Age taken from wall time would read as negative and clamp to
    // zero, making a digest past the risk bound report as freshly cached.
    monotonicMs += 130_000;
    wallMs -= 3_600_000;

    const aged = guard.inspectCached();
    expect(aged.treeProvenance?.ageMs).toBeGreaterThanOrEqual(130_000);
    expect(aged.status).toBe('unknown');
  });
});

/**
 * Advance fake time without touching the cache.
 *
 * These two tests must not READ while they wait: a read of its own can start a
 * walk, which is exactly the behaviour under test. Fake timers give a wait that
 * observes nothing, and they drive both the successor `setTimeout` and the
 * `setImmediate` yields inside the walk, so no wall-clock margin is being
 * guessed at on a shared worker.
 */
async function advanceQuietly(guardClock: { value: number }, ms: number): Promise<void> {
  guardClock.value += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

describe('r2 MUST-1 — an invalidated digest converges without a reader', () => {
  it('publishes a fresh observation after a burst of writes, using one extra walk', async () => {
    vi.useFakeTimers();
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    const clock = { value: 0 };
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: 'p42-r2-must1',
      // Non-zero so the rate floor is genuinely exercised.
      treeRefreshMinIntervalMs: 50,
      monotonicNow: () => clock.value,
    });
    const warm = guard.warmTreeCache();
    await vi.advanceTimersByTimeAsync(1);
    await warm;
    const before = guard.inspectCached().treeProvenance!;
    expect(before.source).toBe('cached');

    // A burst the size of a real group send. Baileys 7.0.0-rc12 writes one
    // Signal session per recipient device (Signal/libsignal.js:361) plus a few
    // constant writes per send, so a 50-device group send drives ~50 key-store
    // writes, each of which invalidates once. The floor plus the single
    // successor must collapse all of them onto one walk.
    for (let i = 0; i < 50; i += 1) guard.invalidateTreeCache(`key-store-set-end-${i}`);

    // Deliberately NO reads while we wait: a read of its own would start a
    // refresh and mask whether invalidation converges on its own. This is the
    // whole point — the fleet poller reads every 5 s, but the digest must not
    // depend on that to stop being stale.
    await advanceQuietly(clock, 400);

    const after = guard.inspectCached().treeProvenance!;
    expect(after.source).toBe('cached');
    expect(after.lastRefreshKind).toBe('fresh');
    // Exactly one walk lands for the whole burst. A walk per write is what the
    // begin/end pair used to buy, and every one of those was discarded.
    expect(after.refreshCount - before.refreshCount).toBe(1);
    // And exactly one walk was STARTED. refreshCount alone counts publications,
    // so it cannot see a traversal that ran and was thrown away; this is the
    // assertion that actually pins the cost claim.
    expect(after.refreshAttemptCount - before.refreshAttemptCount).toBe(1);
  });

  it('does not discard the walk its own invalidation started', async () => {
    vi.useFakeTimers();
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    const clock = { value: 0 };
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: 'p42-r2-must1-pair',
      treeRefreshMinIntervalMs: 0,
      monotonicNow: () => clock.value,
    });
    const warm = guard.warmTreeCache();
    await vi.advanceTimersByTimeAsync(1);
    await warm;
    const before = guard.inspectCached().treeProvenance!;

    // The shape the key-store wrapper used to produce: two invalidations around
    // one write. The second bumped the generation while the first one's walk was
    // in flight, so that walk was fenced off and nothing replaced it.
    guard.invalidateTreeCache('key-store-set-begin');
    guard.invalidateTreeCache('key-store-set-end');

    await advanceQuietly(clock, 300);

    const after = guard.inspectCached().treeProvenance!;
    expect(after.lastRefreshKind).toBe('fresh');
    expect(after.lastRefreshKind).not.toBe('superseded');
    expect(after.refreshCount).toBeGreaterThan(before.refreshCount);
  });
});

describe('r4 SHOULD-2 — a reader that arrives during or under a walk queues nothing', () => {
  it('does not buy a second walk for a reader that arrives while one is in flight', async () => {
    vi.useFakeTimers();
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    const clock = { value: 0 };
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: 'p42-r4-should2-inflight',
      // Zero floor on purpose: the only thing that can suppress a second walk
      // here is the in-flight guard, not the rate limiter.
      treeRefreshMinIntervalMs: 0,
      monotonicNow: () => clock.value,
    });
    const warm = guard.warmTreeCache();
    await vi.advanceTimersByTimeAsync(1);
    await warm;
    const before = guard.inspectCached().treeProvenance!;

    // One mutation starts one walk. drainYielding awaits a setImmediate before
    // its first step, so the walk is still in flight on the next line.
    guard.invalidateTreeCache('key-store-set-end');

    const during = guard.inspectCached().treeProvenance!;
    // Coverage assertion. Without it this test could pass vacuously by reading
    // after the walk had already landed, which exercises no guard at all.
    expect(during.refreshInFlight).toBe(true);

    await advanceQuietly(clock, 500);

    const after = guard.inspectCached().treeProvenance!;
    expect(after.lastRefreshKind).toBe('fresh');
    // The mutation's own walk, and nothing else. A reader that merely arrived
    // during it is answered by it; queueing a successor for that reader buys a
    // second full traversal for no new information.
    expect(after.refreshAttemptCount - before.refreshAttemptCount).toBe(1);
  });

  it('does not queue a successor for a reader that is only rate-limited', async () => {
    vi.useFakeTimers();
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    const clock = { value: 0 };
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: 'p42-r4-should2-floor',
      // Every read finds the observation stale, so a read reaches the floor
      // branch instead of being answered from the cache without asking.
      treeCacheMaxAgeMs: 0,
      treeRefreshMinIntervalMs: 50,
      monotonicNow: () => clock.value,
    });
    const warm = guard.warmTreeCache();
    await vi.advanceTimersByTimeAsync(1);
    await warm;
    const before = guard.inspectCached().treeProvenance!;
    expect(before.refreshScheduled).toBe(false);

    // A reader inside the floor, with no mutation anywhere in this test: the
    // digest is merely old, so there is nothing for a successor to converge on.
    const blocked = guard.inspectCached().treeProvenance!;
    // Coverage assertions: the read WAS treated as stale (so it did call
    // refreshTreeCache) and the walk did NOT start (so it took the floor
    // branch). Without this pair the assertion below could hold for the wrong
    // reason.
    // It queued nothing. All four fields are assigned synchronously inside the
    // same inspectCached call, so dropping the guard in the floor branch arms a
    // successor that is visible in this exact state shape.
    expect(blocked).toMatchObject({
      source: 'stale',
      refreshInFlight: false,
      refreshScheduled: false,
      nextRefreshEligibleInMs: null,
    });
  });
});

describe('r4 NIT-2 / review MED-1, SHOULD-1, LOW-2, LOW-3 — the refresh scheduler owns convergence', () => {
  it('schedules its own retry after a cold failure, and a reader inside that window starts nothing', async () => {
    vi.useFakeTimers();
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    // A root that is not there: every walk returns `incomplete` and publishes
    // nothing. Nothing is ever invalidated, so under the old rule this walk
    // earned no retry at all and convergence fell back to "someone reads
    // again" — which is the case a 5 s fleet poller turns into one walk per
    // floor, forever.
    const missingRoot = join(fx.root, 'never-created');
    const clock = { value: 0 };
    const guard = new AuthBondGuard({
      authDir: missingRoot,
      stateRoot: fx.stateRoot,
      instanceName: 'p42-r4-x5-cold',
      treeRefreshMinIntervalMs: 100,
      monotonicNow: () => clock.value,
    });

    const first = guard.inspectCached().treeProvenance!;
    expect(first.refreshInFlight).toBe(true);
    await advanceQuietly(clock, 10);

    const settled = guard.inspectCached().treeProvenance!;
    // Coverage assertion: the walk really did fail to publish.
    expect(settled.lastRefreshKind).toBe('incomplete');
    expect(settled.refreshAttemptCount).toBe(1);
    // The load-bearing one: the failed walk queued its OWN successor, with no
    // invalidation anywhere in this test.
    expect(settled.refreshScheduled).toBe(true);
    expect(settled.nextRefreshEligibleInMs).toBe(200);

    // A reader arriving after the plain 100 ms floor but before the 200 ms
    // retry is due starts nothing. Note this assertion is held by the widened
    // reader floor AND by the armed timer, so it does not attribute to either;
    // the next test isolates the timer.
    //
    // Advanced in lockstep rather than by assigning `clock.value`: the retry
    // timer is armed on the FAKE clock, so moving only the injected clock here
    // would leave fake time at 10 ms and the successor below would never fire.
    await advanceQuietly(clock, 140);
    const duringBackoff = guard.inspectCached().treeProvenance!;
    expect(duringBackoff.refreshInFlight).toBe(false);
    expect(duringBackoff.refreshAttemptCount).toBe(1);
    expect(duringBackoff.refreshScheduled).toBe(true);

    // The successor, not a reader, is what walks.
    await advanceQuietly(clock, 100);
    expect(guard.inspectCached().treeProvenance!.refreshAttemptCount).toBe(2);
  });

  it('does not start a reader walk while a successor is already armed', async () => {
    vi.useFakeTimers();
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    const clock = { value: 0 };
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: 'p42-r4-med1-reader',
      // A HEALTHY tree, so the failure streak stays 0 and the widened reader
      // floor equals the plain one. The armed timer is then the only thing
      // that can hold this reader back, which is what makes the assertion
      // attributable to it.
      treeCacheMaxAgeMs: 0,
      treeRefreshMinIntervalMs: 50,
      monotonicNow: () => clock.value,
    });
    const warm = guard.warmTreeCache();
    await vi.advanceTimersByTimeAsync(1);
    await warm;
    expect(guard.inspectCached().treeProvenance!.refreshAttemptCount).toBe(1);

    // A mutation inside the floor is deferred onto one successor, due at 50.
    guard.invalidateTreeCache('key-store-set-end');
    const armed = guard.inspectCached().treeProvenance!;
    expect(armed.refreshScheduled).toBe(true);
    expect(armed.refreshInFlight).toBe(false);
    expect(armed.refreshAttemptCount).toBe(1);

    // Real time passes the floor while the timer has not yet run: the poller
    // read review MED-1 describes. The floor is measured from the last walk's
    // START and the successor's wait from its END, so this window exists on
    // every retry. The reader must not walk through it.
    //
    // The injected clock is moved WITHOUT advancing fake timers, deliberately,
    // and this is the one place in the file where that is correct: it is what
    // holds the armed successor pending while the guard's own notion of time
    // passes the floor. Replacing it with advanceQuietly fires the timer and
    // destroys the window under test.
    clock.value = 60;
    const reader = guard.inspectCached().treeProvenance!;
    expect(reader.refreshInFlight).toBe(false);
    expect(reader.refreshAttemptCount).toBe(1);
    expect(reader.refreshScheduled).toBe(true);

    await advanceQuietly(clock, 100);
    const done = guard.inspectCached().treeProvenance!;
    expect(done.lastRefreshKind).toBe('fresh');
    expect(done.refreshAttemptCount).toBe(2);
  });

  it('cancels a successor that a completed walk has made pointless', async () => {
    vi.useFakeTimers();
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    const clock = { value: 0 };
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: 'p42-r4-med1-cancel',
      treeRefreshMinIntervalMs: 50,
      monotonicNow: () => clock.value,
    });
    const warm = guard.warmTreeCache();
    await vi.advanceTimersByTimeAsync(1);
    await warm;

    // A mutation inside the floor arms a successor.
    guard.invalidateTreeCache('key-store-set-end');
    expect(guard.inspectCached().treeProvenance!.refreshScheduled).toBe(true);

    // A forced walk lands first and observes the very tree that successor was
    // queued to observe — the connect-path warm, or any other forced refresh.
    const second = guard.warmTreeCache();
    await vi.advanceTimersByTimeAsync(1);
    await second;

    const after = guard.inspectCached().treeProvenance!;
    expect(after.lastRefreshKind).toBe('fresh');
    // The published surface must not say a walk is queued over a settled
    // digest: `digest_refresh_scheduled` is what an operator reads to decide
    // whether to wait.
    expect(after.refreshScheduled).toBe(false);
    expect(after.nextRefreshEligibleInMs).toBeNull();
    const attempts = after.refreshAttemptCount;

    // And the retired timer must not walk when its delay expires.
    await advanceQuietly(clock, 500);
    expect(guard.inspectCached().treeProvenance!.refreshAttemptCount).toBe(attempts);
  });

  it('walks the failure back-off ladder and holds at the ceiling', async () => {
    vi.useFakeTimers();
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    const missingRoot = join(fx.root, 'never-created');
    const clock = { value: 0 };
    const guard = new AuthBondGuard({
      authDir: missingRoot,
      stateRoot: fx.stateRoot,
      instanceName: 'p42-r4-low3-ladder',
      treeRefreshMinIntervalMs: 100,
      monotonicNow: () => clock.value,
    });

    // A read is inert once a successor is armed, which is what lets the ladder
    // be observed without perturbing it.
    const dueMs: (number | null)[] = [];
    guard.inspectCached();
    await advanceQuietly(clock, 10);
    dueMs.push(guard.inspectCached().treeProvenance!.nextRefreshEligibleInMs);
    for (const step of [200, 400, 800, 1600]) {
      await advanceQuietly(clock, step);
      dueMs.push(guard.inspectCached().treeProvenance!.nextRefreshEligibleInMs);
    }

    // 100 ms base, doubling per consecutive failure, capped at 2^4 = 16
    // intervals. The fifth entry repeating the fourth IS the ceiling.
    expect(dueMs).toEqual([200, 400, 800, 1600, 1600]);
    // Five attempts, one per rung: the ladder is being climbed, not idled.
    expect(guard.inspectCached().treeProvenance!.refreshAttemptCount).toBe(5);
  });

  it('does not make a new invalidation episode inherit an earlier failure streak', async () => {
    vi.useFakeTimers();
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    const lateRoot = join(fx.root, 'late-auth');
    const clock = { value: 0 };
    const guard = new AuthBondGuard({
      authDir: lateRoot,
      stateRoot: fx.stateRoot,
      instanceName: 'p42-r4-low2-episode',
      treeRefreshMinIntervalMs: 100,
      monotonicNow: () => clock.value,
    });

    // Three demand-driven failures over a root that has not arrived yet.
    // Nothing is invalidated throughout, so this streak belongs to no episode.
    guard.inspectCached();
    await advanceQuietly(clock, 10);
    await advanceQuietly(clock, 200);
    await advanceQuietly(clock, 400);
    const stale = guard.inspectCached().treeProvenance!;
    expect(stale.refreshAttemptCount).toBe(3);
    expect(stale.nextRefreshEligibleInMs).toBe(800);

    // The root arrives and something writes key material to it: a NEW episode,
    // which has failed at nothing.
    mkdirSync(lateRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(lateRoot, 'creds.json'), JSON.stringify({
      me: { id: '15550100001:1@s.whatsapp.net', lid: '12345:1@lid' },
    }), { mode: 0o600 });
    guard.invalidateTreeCache('creds-file-committed');

    // Its successor is timed against a reset streak. Inheriting the 800 ms the
    // previous streak had reached would make a tree that just changed wait out
    // an unrelated fault before anyone looks at it.
    const episode = guard.inspectCached().treeProvenance!;
    expect(episode.refreshScheduled).toBe(true);
    expect(episode.nextRefreshEligibleInMs).toBe(100);

    // And it converges: the reset is not just a smaller number on the surface.
    await advanceQuietly(clock, 200);
    expect(guard.inspectCached().treeProvenance!.lastRefreshKind).toBe('fresh');
  });
});

describe('review r4 LOW-1 — a transient credential read degrades, it does not page', () => {
  /**
   * The snapshot is hand-built from a real one so its shape cannot drift, and
   * fed through the production health server, so this exercises the real
   * classifyAuthFailure rather than a copy of its logic. `creds.mtime` defaults
   * to the distant past so the fresh-credential-write debounce cannot fire;
   * the last case below overrides it precisely because it wants that window.
   */
  async function classifyWith(
    issues: string[],
    guard: AuthBondGuard,
    db: Database,
    mtime = '2020-01-01T00:00:00.000Z',
  ): Promise<string> {
    const base = guard.inspect();
    const authBond = {
      ...base,
      status: 'invalid' as const,
      creds: { ...base.creds, mtime },
      issues,
    };
    const deps = {
      ...makeDeps(db, guard),
      connectionManager: {
        botJid: '15551230004@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn(),
        sendMedia: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        getConnectionState: () => ({
          ...emptyConnectionStateSnapshot({
            connected: true, stateChangedAt: '2026-09-03T00:00:00.000Z', lastDisconnectReason: null,
          }),
          authBond,
        }),
      } as unknown as ConnectionManager,
    } as HealthDeps;
    const { server, port } = await buildTestServer(deps);
    try {
      const res = await healthReq(port);
      return (JSON.parse(res.body) as Record<string, any>).whatsapp.connection.auth_failure_class;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('classifies a transient read as at-risk and a definite one as corruption', async () => {
    const db = new Database(':memory:');
    db.open();
    const guard = makeGuard();
    await guard.warmTreeCache();

    try {
      // Control first. The SAME status, the same everything, with a definite
      // reason: this must still page. Without it the assertion below could
      // hold because the classifier stopped classifying.
      const definite = await classifyWith(['creds_json_unreadable:EIO'], guard, db);
      expect(definite).toMatch(/^local_corruption_/);

      // The fix: an indefinite read is an absence of evidence, so it degrades
      // at the same severity `unknown` gets, rather than paging as corruption
      // on a credential that was never established to be broken.
      const transient = await classifyWith(['creds_json_read_transient:EAGAIN'], guard, db);
      expect(transient).toBe('auth_bond_at_risk');

      // Ordering. The transient guard sits with the `unknown` check, ahead of
      // the fresh-credential-write debounce, so a transient read inside the
      // write window still degrades instead of reading as healthy. The
      // debounce needs a fresh mtime AND an empty/invalid-JSON issue, so both
      // are supplied.
      const freshMtime = new Date(Date.now() - 1_000).toISOString();

      // Coverage assertion FIRST: without it the next line could pass because
      // the debounce never applied. This proves the window really is open.
      const debounced = await classifyWith(['creds_json_empty'], guard, db, freshMtime);
      expect(debounced).toBe('none');

      // Same window, plus a read that could not look. It must not read clean:
      // 'none' here is a false clean during exactly the window in which a
      // restore may act.
      const transientInWindow = await classifyWith(
        ['creds_json_empty', 'creds_json_read_transient:EAGAIN'], guard, db, freshMtime,
      );
      expect(transientInWindow).toBe('auth_bond_at_risk');
      expect(transientInWindow).not.toBe('none');
    } finally {
      db.close();
    }
  });
});

describe('r4 SHOULD-2 follow-up — the widened reader floor, isolated from the successor', () => {
  it('holds a reader on the widened floor even when no successor is armed', async () => {
    vi.useFakeTimers();
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    const missingRoot = join(fx.root, 'never-created');
    const clock = { value: 0 };
    const guard = new AuthBondGuard({
      authDir: missingRoot,
      stateRoot: fx.stateRoot,
      instanceName: 'p42-r4-floor-alone',
      treeRefreshMinIntervalMs: 100,
      monotonicNow: () => clock.value,
    });

    // White-box, and deliberately so. Every non-publishing walk now arms a
    // successor and readers defer to an armed successor, so in ordinary
    // operation the timer is the binding guard and the widened reader floor
    // behind it is unreachable — which would leave the floor with no
    // discriminating test at all. Stubbing the scheduler removes the outer
    // guard so the floor alone decides. This is the ONLY way to hold that
    // line, and the test says so rather than implying the floor is reachable.
    (guard as unknown as { scheduleTreeRefreshSuccessor: () => void })
      .scheduleTreeRefreshSuccessor = () => {};

    guard.inspectCached();
    await advanceQuietly(clock, 10);
    const settled = guard.inspectCached().treeProvenance!;
    expect(settled.lastRefreshKind).toBe('incomplete');
    expect(settled.refreshAttemptCount).toBe(1);
    // Coverage assertion: the stub really is in effect, so nothing below can
    // be attributed to an armed timer.
    expect(settled.refreshScheduled).toBe(false);

    // Past the plain 100 ms floor, inside the 200 ms one failure widens it to.
    await advanceQuietly(clock, 140);
    expect(guard.inspectCached().treeProvenance!.refreshAttemptCount).toBe(1);

    // And past the widened floor it walks again: a floor, not a lock.
    await advanceQuietly(clock, 60);
    expect(guard.inspectCached().treeProvenance!.refreshAttemptCount).toBe(2);

    await advanceQuietly(clock, 10);
  });
});

describe('public-surface contract — the three digest refresh-provenance fields', () => {
  it('serializes the documented names, units and counter semantics', async () => {
    const db = new Database(':memory:');
    db.open();
    const guard = makeGuard();
    await guard.warmTreeCache();
    const { server, port } = await buildTestServer(makeDeps(db, guard));

    try {
      const res = await healthReq(port);
      const bond = (JSON.parse(res.body) as Record<string, any>).whatsapp.auth_bond;

      // Names, exactly as docs/public-surface.md spells them. A rename is a
      // breaking change to a `stable` surface and has to fail here.
      expect(Object.keys(bond)).toEqual(expect.arrayContaining([
        'digest_refresh_scheduled',
        'digest_next_refresh_eligible_ms',
        'digest_refresh_attempts',
      ]));
      expect(typeof bond.digest_refresh_scheduled).toBe('boolean');
      expect(typeof bond.digest_refresh_attempts).toBe('number');
      expect(
        bond.digest_next_refresh_eligible_ms === null
        || typeof bond.digest_next_refresh_eligible_ms === 'number',
      ).toBe(true);

      // Unit: a DURATION in milliseconds, never a timestamp. An epoch value
      // would sail past this bound.
      if (bond.digest_next_refresh_eligible_ms !== null) {
        expect(bond.digest_next_refresh_eligible_ms).toBeGreaterThanOrEqual(0);
        expect(bond.digest_next_refresh_eligible_ms).toBeLessThan(1_000_000);
      }

      // Counter semantics: attempts counts walks STARTED, count counts walks
      // that PUBLISHED, so attempts can never trail count. Swapping the two
      // projections in health.ts fails here.
      expect(bond.digest_refresh_attempts).toBeGreaterThanOrEqual(bond.digest_refresh_count);
      expect(bond.digest_refresh_attempts).toBeGreaterThanOrEqual(1);

      // The three transient-read fields promoted alongside them, under the
      // same rule: names as docs/public-surface.md spells them, and the quiet
      // shape a healthy bond must report — false and two nulls, never absent
      // members, so a strict decoder sees the same keys in every response.
      expect(Object.keys(bond)).toEqual(expect.arrayContaining([
        'transient_read_persistent',
        'transient_read_reason',
        'transient_read_age_ms',
      ]));
      expect(bond.transient_read_persistent).toBe(false);
      expect(bond.transient_read_reason).toBeNull();
      expect(bond.transient_read_age_ms).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('has the release record the public-surface publication rules require', () => {
    // docs/public-surface.md "How to update this file" requires a release-notes
    // entry under "Public surface additions" for every promotion. The registry
    // row is covered by the drift check; this pins the half that is not.
    const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
    const releaseDir = join(repoRoot, 'docs', 'releases');
    const additions = readdirSync(releaseDir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => readFileSync(join(releaseDir, name), 'utf8'))
      .filter((body) => body.includes('## Public surface additions'));

    // Positive control: the directory really does hold release notes of the
    // expected shape, so an empty owning-set below means a MISSING record
    // rather than a mistyped path.
    expect(additions.length).toBeGreaterThan(1);

    const owning = additions.filter((body) => body.includes('digest_refresh_scheduled'));
    expect(owning).toHaveLength(1);
    expect(owning[0]).toContain('digest_next_refresh_eligible_ms');
    expect(owning[0]).toContain('digest_refresh_attempts');
    // The two properties an external strict decoder needs and cannot infer
    // from the field names.
    expect(owning[0]).toContain('MILLISECONDS');
    expect(owning[0]).toContain('Additive only');

    // The transient-read promotion is governed by the same rule, and it adds
    // a VALUE to an existing enumeration as well as three members — the one
    // thing a strict decoder of auth_failure_class cannot discover from a
    // field list, so the note has to say it.
    const transientOwning = additions.filter((body) => body.includes('transient_read_persistent'));
    expect(transientOwning).toHaveLength(1);
    expect(transientOwning[0]).toContain('transient_read_reason');
    expect(transientOwning[0]).toContain('transient_read_age_ms');
    expect(transientOwning[0]).toContain('auth_bond_read_persistent');
    expect(transientOwning[0]).toContain('NON-TERMINAL');
  });
});

describe('review finding — a persistently unreadable credential is named, not called corruption', () => {
  /**
   * The predecessor of this test hand-built the persistence flag, fed it
   * through a synthetic snapshot, and then asserted an outage decision by
   * importing the mode-bucket contract directly. Two review findings closed
   * here: the flag now comes from the guard's OWN accounting and reaches the
   * classifier through the production cached-health seam (makeDeps wires
   * `authBond: guard.inspectCached()`, which is what GET /health reads), and
   * the outage assertion is gone because no runtime opens one — the
   * mode-bucket cluster has no runtime importer, as the orphan-reachability
   * guard records.
   *
   * The fixture deliberately has NO auth-bond backup. That is the case the
   * finding is about: with no backup the old classifier returned
   * `local_corruption_unrestorable`, which takes /health to 503 and matches
   * the watchdog's terminal set — so a credential nobody could READ suppressed
   * the restart that might clear the read fault.
   */
  it('reports auth_bond_read_persistent at HTTP 200 with the fields that explain it', async () => {
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    const credsPath = join(fx.authDir, 'creds.json');
    const clock = { value: 0 };
    const inject = { transient: true };
    let transientOpens = 0;

    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        openSync: vi.fn((
          path: Parameters<typeof actual.openSync>[0],
          flags: Parameters<typeof actual.openSync>[1],
          mode?: Parameters<typeof actual.openSync>[2],
        ) => {
          if (String(path) === credsPath && inject.transient) {
            transientOpens += 1;
            throw Object.assign(
              new Error('EAGAIN: resource temporarily unavailable, open'),
              { code: 'EAGAIN' },
            );
          }
          return actual.openSync(path, flags, mode as any);
        }),
      };
    });

    const db = new Database(':memory:');
    db.open();
    try {
      const mod = await import('../../src/transport/auth-bond.ts');
      // treeCacheMaxAgeMs 10 makes treeStaleRiskMs 40 (× 4), the same multiple
      // production uses, so the bound is exercised without a 120 s wait.
      const guard = new mod.AuthBondGuard({
        authDir: fx.authDir,
        stateRoot: fx.stateRoot,
        instanceName: 'p42-r7-read-persistent',
        treeCacheMaxAgeMs: 10,
        monotonicNow: () => clock.value,
      }) as unknown as AuthBondGuard;
      const { server, port } = await buildTestServer(makeDeps(db, guard));

      try {
        // First request opens the streak. Coverage assertions: the injected
        // EAGAIN was really reached, the class is the short-lived one, and the
        // fixture genuinely carries no backup — without the last one the 200
        // below could come from the restorable branch instead of from the fix.
        const firstRes = await healthReq(port);
        const first = JSON.parse(firstRes.body) as Record<string, any>;
        expect(transientOpens).toBeGreaterThanOrEqual(1);
        expect(first.whatsapp.auth_bond.issues).toContain('creds_json_read_transient:EAGAIN');
        expect(first.whatsapp.auth_bond.backup.latest).toBeNull();
        expect(first.whatsapp.connection.auth_failure_class).toBe('auth_bond_at_risk');
        expect(first.whatsapp.auth_bond.transient_read_persistent).toBe(false);

        // Past the bound, on the same guard, with the transient still injected.
        clock.value = 41;
        const res = await healthReq(port);
        const body = JSON.parse(res.body) as Record<string, any>;

        // The class names the read fault. Reverting the classifier to the
        // not-'present' branch makes this line read local_corruption_*.
        expect(body.whatsapp.connection.auth_failure_class).toBe('auth_bond_read_persistent');
        // And it is NOT treated as terminal: 200, degraded, and the only
        // auth reason in the array is this class. `toContain` could not prove
        // "sole", so the auth reasons are compared as a whole.
        expect(res.status).toBe(200);
        expect(body.status).toBe('degraded');
        expect(
          (body.status_reasons as string[]).filter((reason) => reason.startsWith('auth_failure.')),
        ).toEqual(['auth_failure.auth_bond_read_persistent']);

        // The three fields that make the escalation explainable from one
        // response, all served from the guard's accounting rather than built
        // by this test.
        expect(body.whatsapp.auth_bond.transient_read_persistent).toBe(true);
        expect(body.whatsapp.auth_bond.transient_read_reason).toBe('creds_json_read_transient:EAGAIN');
        expect(body.whatsapp.auth_bond.transient_read_age_ms).toBe(41);

        // Recovery closes it out on the same seam: the streak resets, the
        // fields go quiet, and the class returns to 'none'. Without this the
        // test could pass on a flag that latches.
        inject.transient = false;
        clock.value = 100;
        const recoveredRes = await healthReq(port);
        const recovered = JSON.parse(recoveredRes.body) as Record<string, any>;
        expect(recovered.whatsapp.auth_bond.transient_read_persistent).toBe(false);
        expect(recovered.whatsapp.auth_bond.transient_read_reason).toBeNull();
        expect(recovered.whatsapp.auth_bond.transient_read_age_ms).toBeNull();
        expect(recovered.whatsapp.connection.auth_failure_class).not.toBe('auth_bond_read_persistent');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      db.close();
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  /**
   * The other half of the finding. With a backup present the old classifier
   * returned `local_corruption_restorable` — 200 rather than 503, but still a
   * corruption verdict that opens a local-corruption bucket and tells an
   * operator the store is damaged. The class must not depend on whether a
   * backup happens to exist, because the backup says nothing about whether the
   * credential could be read.
   */
  it('reports the same class with a backup present, so the verdict does not depend on one', async () => {
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    const credsPath = join(fx.authDir, 'creds.json');
    const clock = { value: 0 };

    // Seeded with the statically imported guard, which holds the REAL fs, so
    // the backup exists on disk before the failing reader is installed.
    const seeded = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: 'p42-r7-read-persistent-backup',
      now: () => new Date('2026-09-03T12:00:00Z'),
    }).capture('seed');
    expect(seeded).toMatchObject({ ok: true, captured: true });

    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        openSync: vi.fn((
          path: Parameters<typeof actual.openSync>[0],
          flags: Parameters<typeof actual.openSync>[1],
          mode?: Parameters<typeof actual.openSync>[2],
        ) => {
          if (String(path) === credsPath) {
            throw Object.assign(
              new Error('EAGAIN: resource temporarily unavailable, open'),
              { code: 'EAGAIN' },
            );
          }
          return actual.openSync(path, flags, mode as any);
        }),
      };
    });

    const db = new Database(':memory:');
    db.open();
    try {
      const mod = await import('../../src/transport/auth-bond.ts');
      const guard = new mod.AuthBondGuard({
        authDir: fx.authDir,
        stateRoot: fx.stateRoot,
        instanceName: 'p42-r7-read-persistent-backup',
        treeCacheMaxAgeMs: 10,
        monotonicNow: () => clock.value,
      }) as unknown as AuthBondGuard;
      const { server, port } = await buildTestServer(makeDeps(db, guard));

      try {
        await healthReq(port);
        clock.value = 41;
        const res = await healthReq(port);
        const body = JSON.parse(res.body) as Record<string, any>;

        // Coverage assertion: this fixture really does carry a backup, which
        // is what makes it the other branch of the old classifier's split.
        expect(body.whatsapp.auth_bond.backup.latest).not.toBeNull();
        // Same class, same code, same severity as the no-backup case.
        expect(body.whatsapp.connection.auth_failure_class).toBe('auth_bond_read_persistent');
        expect(res.status).toBe(200);
        expect(body.status).toBe('degraded');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      db.close();
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

describe('r5 NIT-4 follow-up — MIN_REFRESH_RETRY_INTERVAL_MS is exercised, not implied', () => {
  it('clamps the first retry wait to 100 ms when treeRefreshMinIntervalMs is 0', async () => {
    vi.useFakeTimers();
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    const missingRoot = join(fx.root, 'never-created-nit4');
    const clock = { value: 0 };
    const guard = new AuthBondGuard({
      authDir: missingRoot,
      stateRoot: fx.stateRoot,
      instanceName: 'p42-nit4-clamp',
      // Zero configured floor: the retry wait would collapse to 0 ms without
      // MIN_REFRESH_RETRY_INTERVAL_MS, degrading into an unbounded 0 ms timer
      // loop rather than reporting the load-bearing 100 ms.
      treeRefreshMinIntervalMs: 0,
      monotonicNow: () => clock.value,
    });

    // Cold walk: no root, so it fails and arms a successor via the finally.
    guard.inspectCached();
    await advanceQuietly(clock, 10);

    const settled = guard.inspectCached().treeProvenance!;
    // Coverage: the walk actually failed (not: the walk was never reached).
    expect(settled.lastRefreshKind).toBe('incomplete');
    expect(settled.refreshAttemptCount).toBe(1);
    // Timer is armed at the clamp, not the bare configured interval.
    // 50 ms clamp × 2^1 (one failure) = 100 ms.
    expect(settled.refreshScheduled).toBe(true);
    expect(settled.nextRefreshEligibleInMs).toBe(100);


    await advanceQuietly(clock, 10);
    vi.useRealTimers();
  });
});

describe('MUST-2 — GET /health does not classify an unobserved tree as clean', () => {
  it('reports auth_bond_at_risk, not none, for a never-warmed cache', async () => {
    const fx = makeOwnFixture();
    const db = new Database(':memory:');
    db.open();
    const guard = new AuthBondGuard({
      authDir: fx.authDir, stateRoot: fx.stateRoot, instanceName: 'p42-must2-http',
    });
    const { server, port } = await buildTestServer(makeDeps(db, guard));

    try {
      const res = await healthReq(port);
      const body = JSON.parse(res.body) as Record<string, any>;

      expect(body.whatsapp.auth_bond.digest_source).toBe('absent');
      expect(body.whatsapp.auth_bond.status).toBe('unknown');
      // The fail-open this MUST exists to close: 'none' here means an unknown
      // tree was reported as a clean one.
      expect(body.whatsapp.connection.auth_failure_class).toBe('auth_bond_at_risk');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});
