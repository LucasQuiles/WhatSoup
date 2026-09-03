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
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
      expect(body.auth_bond).toBeTruthy();
      expect(typeof body.auth_bond.digest_age_ms).toBe('number');
      expect(typeof body.auth_bond.digest_refresh_in_flight).toBe('boolean');
      expect(body.auth_bond.digest_source).toBe('cached');
      expect(body.auth_bond.tree_hash).toBeTruthy();
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

    // Twenty consecutive intervals, each carrying a 400 ms health-handler span.
    // Every interval therefore lands 900 ms after the last instead of 500 ms.
    // Without a window-wide exclusion each sample reads 400 ms of lag and the
    // second-largest-of-twenty statistic crosses the 250 ms threshold, which is
    // exactly the false `event_loop_starved` the P42 diagnosis observed.
    for (let i = 0; i < 20; i += 1) {
      sampler.recordObserverSpan(clock + 100, clock + 500);
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
