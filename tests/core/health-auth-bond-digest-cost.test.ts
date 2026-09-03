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
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createServer, request } from 'node:http';
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

    expect(linked.treeProvenance?.source).toBe('cached');
    expect(linked.issues).toContain('creds_json_symlink');
    expect(linked.status).toBe('invalid');
    // And it must not have parsed identity out of the link target.
    expect(linked.meHash).toBeNull();
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

/** Let real timers and the refresh loop run, without reading the cache. */
async function quietMs(totalMs: number): Promise<void> {
  const step = 20;
  for (let waited = 0; waited < totalMs; waited += step) {
    await new Promise<void>((resolve) => { setTimeout(resolve, step); });
  }
}

describe('r2 MUST-1 — an invalidated digest converges without a reader', () => {
  it('publishes a fresh observation after a burst of writes, using one extra walk', async () => {
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: 'p42-r2-must1',
      // Small but non-zero, so the rate floor is genuinely exercised and the
      // test still finishes quickly.
      treeRefreshMinIntervalMs: 50,
    });
    await guard.warmTreeCache();
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
    await quietMs(400);

    const after = guard.inspectCached().treeProvenance!;
    expect(after.source).toBe('cached');
    expect(after.lastRefreshKind).toBe('fresh');
    // Exactly one walk lands for the whole burst. A walk per write is what the
    // begin/end pair used to buy, and every one of those was discarded.
    expect(after.refreshCount - before.refreshCount).toBe(1);
  });

  it('does not discard the walk its own invalidation started', async () => {
    const fx = makeOwnFixture();
    ownFixtureRoots.push(fx.root);
    const guard = new AuthBondGuard({
      authDir: fx.authDir,
      stateRoot: fx.stateRoot,
      instanceName: 'p42-r2-must1-pair',
      treeRefreshMinIntervalMs: 0,
    });
    await guard.warmTreeCache();
    const before = guard.inspectCached().treeProvenance!;

    // The shape the key-store wrapper used to produce: two invalidations around
    // one write. The second bumped the generation while the first one's walk was
    // in flight, so that walk was fenced off and nothing replaced it.
    guard.invalidateTreeCache('key-store-set-begin');
    guard.invalidateTreeCache('key-store-set-end');

    await quietMs(300);

    const after = guard.inspectCached().treeProvenance!;
    expect(after.lastRefreshKind).toBe('fresh');
    expect(after.lastRefreshKind).not.toBe('superseded');
    expect(after.refreshCount).toBeGreaterThan(before.refreshCount);
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
