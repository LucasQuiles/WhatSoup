import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { open as openFileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXIT_BLOCK,
  EXIT_INCONCLUSIVE,
  EXIT_OK,
  REASON_CODES,
  REASON_OUTCOMES,
  acquireLease,
  acquireLeaseAsync,
  checkAllowedPaths,
  executeCli,
  exitCodeFor,
  formatUnexpectedFailure,
  heartbeatLease,
  parseLeaseRecord,
  processIdentityString,
  publishLeaseAsync,
  readRepoFacts,
  releaseLease,
  resolveLeaseLocation,
  statusLease,
  takeoverLease,
  type LeaseRecord,
  type LeaseResult,
} from '../../scripts/agent-lease.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const cliPath = join(repoRoot, 'scripts/agent-lease.ts');

/**
 * A PID that cannot exist on macOS or Linux (both cap `pid_max` far below 2^31-1).
 * Used to model a writer process that is PROVABLY absent, without the spawn/kill/reap
 * race a real child process would introduce.
 */
const ABSENT_PID = 2_147_483_647;

let scratch: string;

function run(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${String(r.status)}): ${r.stderr}`);
  }
  return r.stdout;
}

/** Create a REAL git repository in a real temp dir (repo convention: no fs mocking). */
function initRepo(name = 'repo'): string {
  const root = join(scratch, name);
  mkdirSync(root, { recursive: true });
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.email', 'lease-test@example.invalid'], root);
  run('git', ['config', 'user.name', 'Lease Test'], root);
  run('git', ['config', 'commit.gpgsign', 'false'], root);
  writeFileSync(join(root, 'README.md'), 'seed\n');
  run('git', ['add', 'README.md'], root);
  run('git', ['commit', '-m', 'seed'], root);
  return root;
}

function acquireOk(cwd: string, sessionId: string, extra: Record<string, unknown> = {}): LeaseRecord {
  const result = acquireLease({
    cwd,
    taskId: 'task-1',
    sessionId,
    toolIdentity: 'vitest',
    ...extra,
  });
  if (result.kind !== 'ok') {
    throw new Error(`expected acquire to succeed, got ${result.kind} ${result.reason}: ${result.message}`);
  }
  return result.record;
}

/**
 * Read `target` the instant it first exists, yielding to the event loop between polls.
 *
 * This models the losing acquirer exactly: it learns the path is taken and immediately tries
 * to find out who holds it. Returns the bytes it saw — `''` means it caught the publisher
 * between creating the name and writing the record, which is the defect under test.
 */
async function firstSightOfLease(target: string): Promise<string> {
  for (;;) {
    try {
      return readFileSync(target, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

/** Overwrite the on-disk lease with hand-crafted fields (models a foreign/stale writer). */
function writeLease(cwd: string, record: LeaseRecord): void {
  writeFileSync(resolveLeaseLocation(cwd).leasePath, `${JSON.stringify(record, null, 2)}\n`);
}

function readLeaseRaw(cwd: string): string {
  return readFileSync(resolveLeaseLocation(cwd).leasePath, 'utf8');
}

function runCli(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', cliPath, ...args],
    { cwd, encoding: 'utf8' },
  );
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

beforeEach(() => {
  scratch = mkdtempSync(join(realpathSync(tmpdir()), 'agent-lease-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ── Storage location: a lease `git clean` can delete is not a lease ──────────
describe('agent-lease storage location', () => {
  it('stores the lease OUTSIDE the working tree so `git clean -fdx` cannot delete it', () => {
    const repo = initRepo();
    acquireOk(repo, 'session-a');
    const { leasePath } = resolveLeaseLocation(repo);
    expect(existsSync(leasePath)).toBe(true);

    // The exact destructive sweep from the incident this lease prevents.
    run('git', ['clean', '-fdx'], repo);

    expect(existsSync(leasePath)).toBe(true);
    expect(statusLease({ cwd: repo }).kind).toBe('ok');
  });

  it('keys the lease per worktree — a linked worktree gets a DISTINCT lease path', () => {
    const repo = initRepo();
    const linked = join(scratch, 'linked');
    run('git', ['worktree', 'add', '-b', 'topic', linked], repo);

    const primary = resolveLeaseLocation(repo);
    const secondary = resolveLeaseLocation(linked);

    expect(secondary.leasePath).not.toBe(primary.leasePath);
    // Both live under the SHARED .git admin dir, but in per-worktree subdirs.
    expect(secondary.gitDir).not.toBe(primary.gitDir);
    expect(secondary.commonDir).toBe(primary.commonDir);

    acquireOk(repo, 'session-a');
    // A lease on the primary worktree must NOT block the linked worktree.
    expect(acquireLease({ cwd: linked, taskId: 't', sessionId: 'session-b', toolIdentity: 'vitest' }).kind).toBe('ok');
  });
});

// ── Acquire ─────────────────────────────────────────────────────────────────
describe('agent-lease acquire', () => {
  it('acquires on a free worktree and records the full rider-shaped lease', () => {
    const repo = initRepo();
    const record = acquireOk(repo, 'session-a', { allowedPaths: ['src', 'docs/x.md'] });

    expect(record.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(record.leaseId).toMatch(/[0-9a-f-]{36}/);
    expect(record.generation).toBe(1);
    expect(record.taskId).toBe('task-1');
    expect(record.mode).toBe('write');
    expect(record.writer.sessionId).toBe('session-a');
    expect(record.writer.processIdentity).toMatch(/^pid:\d+\|start:/);
    expect(record.writer.toolIdentity).toBe('vitest');
    expect(record.repository.branch).toBe('main');
    expect(record.repository.identity).not.toBe('');
    expect(record.repository.worktreeIdentity).not.toBe('');
    expect(record.lineage.baseOid).toMatch(/^[0-9a-f]{40}$/);
    expect(record.lineage.candidateOid).toBe(record.lineage.baseOid);
    expect(record.lineage.testedMergeOid).toBeNull();
    expect(Object.keys(record.bindings).sort()).toEqual([
      'manifestDigest',
      'planDigest',
      'policyDigest',
      'toolchainDigest',
    ]);
    expect(record.allowedPaths).toEqual(['src', 'docs/x.md']);
    expect(Date.parse(record.createdAt)).not.toBeNaN();
    expect(Date.parse(record.expiresAt)).toBeGreaterThan(Date.parse(record.heartbeatAt));
  });

  it('BLOCKS a second acquire while the lease is held → git.lease.writer-conflict, exit 1', () => {
    const repo = initRepo();
    acquireOk(repo, 'session-a');

    const second = acquireLease({ cwd: repo, taskId: 'task-2', sessionId: 'session-b', toolIdentity: 'vitest' });
    expect(second.kind).toBe('block');
    if (second.kind === 'ok') throw new Error('unreachable');
    expect(second.reason).toBe('git.lease.writer-conflict');
    expect(exitCodeFor(second)).toBe(EXIT_BLOCK);
    expect(exitCodeFor(second)).toBe(1);

    // The incumbent lease is untouched.
    const held = parseLeaseRecord(readLeaseRaw(repo));
    expect(held.valid).toBe(true);
    if (!held.valid) throw new Error('unreachable');
    expect(held.record.writer.sessionId).toBe('session-a');
  });

  it('RACE: two genuinely concurrent acquires → exactly ONE winner, loser is WRITER_CONFLICT', async () => {
    const repo = initRepo();

    // Both opens are dispatched to the libuv threadpool and contend on the same
    // inode with O_EXCL — a real kernel-level race, not a sequential re-check.
    const results: LeaseResult[] = await Promise.all([
      acquireLeaseAsync({ cwd: repo, taskId: 'task-a', sessionId: 'session-a', toolIdentity: 'vitest' }),
      acquireLeaseAsync({ cwd: repo, taskId: 'task-b', sessionId: 'session-b', toolIdentity: 'vitest' }),
    ]);

    const winners = results.filter((r) => r.kind === 'ok');
    const losers = results.filter((r) => r.kind !== 'ok');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    for (const loser of losers) {
      expect(loser.reason).toBe('git.lease.writer-conflict');
      expect(loser.kind).toBe('block');
      expect(exitCodeFor(loser)).toBe(EXIT_BLOCK);
    }

    // The persisted lease belongs to the winner — no lost update.
    const onDisk = parseLeaseRecord(readLeaseRaw(repo));
    if (!onDisk.valid) throw new Error('lease on disk is not parseable after the race');
    const winner = winners[0];
    if (winner === undefined || winner.kind !== 'ok') throw new Error('unreachable');
    expect(onDisk.record.leaseId).toBe(winner.record.leaseId);
  });

  /**
   * REGRESSION (real failure, 2026-07-22): the loser of a genuine race reported
   * `git.worktree.unaccounted-state` instead of `git.lease.writer-conflict`.
   *
   * Cause: the claim was `open(path,'wx')` followed by a separate write. `O_CREAT|O_EXCL`
   * publishes the INODE before any content exists, so the loser's EEXIST handler could read
   * a zero-byte file, fail to parse it, and downgrade a plain writer conflict to
   * "unaccounted state" — an Inconclusive that tells an operator to reconcile by hand when
   * all that was needed was to back off.
   *
   * The window is microseconds wide, so racing through `acquireLease` reproduces it only
   * intermittently — the defect survived a 43/43 green run and surfaced only under the loaded
   * push gate. A standalone probe measured 30 of 1200 losers (2.5%) under four-way contention.
   *
   * Rather than buy confidence with round count (each `acquireLease` spawns several `git`
   * subprocesses for repo facts, so a statistically meaningful number of rounds blows the
   * suite timeout), these two tests observe the publish step directly. `firstSightOfLease`
   * spins until the path exists and reads it the instant it does, which is precisely the
   * position the losing acquirer was in. The first test proves that observer can actually
   * catch a create-then-write publisher — without it, the second test would be a false green.
   */
  it('NON-VACUITY: the observer catches a create-then-write publisher mid-claim', async () => {
    const target = join(scratch, 'old-style-lease.json');
    const body = `${JSON.stringify({ schemaVersion: 1, leaseId: 'x' }, null, 2)}\n`;
    let caughtEmpty = false;

    for (let round = 0; round < 200 && !caughtEmpty; round += 1) {
      rmSync(target, { force: true });
      // Exactly the old publish path: O_CREAT|O_EXCL publishes the inode, the record lands
      // in a SECOND syscall, and everything in between sees a zero-byte file.
      const [firstSight] = await Promise.all([
        firstSightOfLease(target),
        (async () => {
          const handle = await openFileHandle(target, 'wx', 0o600);
          await handle.writeFile(body);
          await handle.close();
        })(),
      ]);
      if (firstSight === '') caughtEmpty = true;
    }

    expect(caughtEmpty, 'observer never caught the empty window — it cannot falsify anything').toBe(true);
  });

  it('publish is atomic: a concurrent observer NEVER sees an empty lease', async () => {
    const repo = initRepo();
    const record = acquireOk(repo, 'session-a');
    const target = join(scratch, 'published-lease.json');
    const location = { ...resolveLeaseLocation(repo), leasePath: target };

    for (let round = 0; round < 200; round += 1) {
      rmSync(target, { force: true });
      const [firstSight, published] = await Promise.all([
        firstSightOfLease(target),
        publishLeaseAsync(location, record),
      ]);

      expect(published.ok, `round ${round}: publish failed`).toBe(true);
      // The name and its contents become visible in the same instant, so the worst an
      // observer can do is arrive early (ENOENT) or late (complete record) — never between.
      expect(firstSight, `round ${round}: observer saw an empty lease`).not.toBe('');
      expect(parseLeaseRecord(firstSight).valid, `round ${round}: first sight did not parse`).toBe(true);
    }
  });

  it('RACE (repeated): a loser is ALWAYS a writer conflict, never unaccounted state', async () => {
    const repo = initRepo();
    const { leasePath } = resolveLeaseLocation(repo);
    const observed = new Set<string>();
    let winners = 0;

    for (let round = 0; round < 20; round += 1) {
      rmSync(leasePath, { force: true });

      const results = await Promise.all(
        ['a', 'b', 'c', 'd'].map((tag) =>
          acquireLeaseAsync({ cwd: repo, taskId: `task-${tag}`, sessionId: `session-${tag}`, toolIdentity: 'vitest' }),
        ),
      );

      winners += results.filter((r) => r.kind === 'ok').length;
      for (const loser of results.filter((r) => r.kind !== 'ok')) observed.add(loser.reason);

      // Whoever won, the published lease is complete — never a half-written stub.
      expect(parseLeaseRecord(readLeaseRaw(repo)).valid, `round ${round}: lease on disk did not parse`).toBe(true);
    }

    expect(winners, 'exactly one winner per round').toBe(20);
    expect([...observed]).toEqual(['git.lease.writer-conflict']);
  }, 60_000);

  it('publishes the lease atomically — it is never observable as an empty file', () => {
    const repo = initRepo();
    const location = resolveLeaseLocation(repo);

    acquireOk(repo, 'session-a');

    // Content-and-existence land together, so a concurrent reader that sees the path at
    // all sees a complete record.
    expect(readFileSync(location.leasePath, 'utf8').trim()).not.toBe('');
    expect(parseLeaseRecord(readLeaseRaw(repo)).valid).toBe(true);

    // The staging file used to publish atomically must not survive the claim.
    const leftovers = readdirSync(location.gitDir).filter((entry) => entry.includes('.claim-'));
    expect(leftovers, `staging debris left behind: ${leftovers.join(', ')}`).toEqual([]);
  });

  it('still reports UNACCOUNTED_STATE for a zero-byte lease left by a foreign writer', () => {
    const repo = initRepo();
    const location = resolveLeaseLocation(repo);

    // Not a race: nothing is mid-claim, this is genuine debris. Waiting on it or calling it
    // a writer conflict would name a holder that does not exist, so it stays Inconclusive.
    writeFileSync(location.leasePath, '');

    const result = acquireLease({ cwd: repo, taskId: 'task-1', sessionId: 'session-a', toolIdentity: 'vitest' });
    expect(result.kind).toBe('inconclusive');
    if (result.kind === 'ok') throw new Error('unreachable');
    expect(result.reason).toBe('git.worktree.unaccounted-state');
    expect(exitCodeFor(result)).toBe(EXIT_INCONCLUSIVE);
  });

  it(
    'RACE (multi-process): concurrent CLI acquires → exactly one exit 0, the rest exit 1',
    async () => {
      const repo = initRepo();
      const codes = await Promise.all(
        [0, 1, 2, 3].map(
          (i) =>
            new Promise<number>((resolveCode, rejectCode) => {
              const child = spawn(
                process.execPath,
                [
                  '--disable-warning=ExperimentalWarning',
                  '--experimental-strip-types',
                  cliPath,
                  'acquire',
                  '--task',
                  `task-${i}`,
                  '--session',
                  `session-${i}`,
                  '--tool',
                  'vitest',
                ],
                { cwd: repo, stdio: 'ignore' },
              );
              child.on('error', rejectCode);
              child.on('exit', (code) => resolveCode(code ?? -1));
            }),
        ),
      );

      expect(codes.filter((c) => c === EXIT_OK)).toHaveLength(1);
      expect(codes.filter((c) => c === EXIT_BLOCK)).toHaveLength(3);
      expect(codes.filter((c) => c === EXIT_INCONCLUSIVE)).toHaveLength(0);
    },
    60_000,
  );

  it('BLOCKS when the worktree is on the wrong branch → git.worktree.wrong-branch', () => {
    const repo = initRepo();
    const result = acquireLease({
      cwd: repo,
      taskId: 'task-1',
      sessionId: 'session-a',
      toolIdentity: 'vitest',
      expectBranch: 'feat/not-checked-out',
    });
    expect(result.kind).toBe('block');
    if (result.kind === 'ok') throw new Error('unreachable');
    expect(result.reason).toBe('git.worktree.wrong-branch');
    expect(exitCodeFor(result)).toBe(EXIT_BLOCK);
    expect(existsSync(resolveLeaseLocation(repo).leasePath)).toBe(false);
  });

  it('is INCONCLUSIVE when HEAD is not the expected OID → git.head.unexpected-change', () => {
    const repo = initRepo();
    const result = acquireLease({
      cwd: repo,
      taskId: 'task-1',
      sessionId: 'session-a',
      toolIdentity: 'vitest',
      expectHeadOid: '0'.repeat(40),
    });
    expect(result.kind).toBe('inconclusive');
    if (result.kind === 'ok') throw new Error('unreachable');
    expect(result.reason).toBe('git.head.unexpected-change');
    expect(exitCodeFor(result)).toBe(EXIT_INCONCLUSIVE);
  });

  it('CLI: a conflicting acquire exits 1 and names the reason on stderr', () => {
    const repo = initRepo();
    acquireOk(repo, 'session-a');
    const cli = runCli(repo, ['acquire', '--task', 't', '--session', 'session-b', '--tool', 'vitest']);
    expect(cli.code).toBe(1);
    expect(cli.stderr).toContain('git.lease.writer-conflict');
  });
});

// ── Fail-closed: malformed / unreadable state is NEVER success ───────────────
describe('agent-lease malformed state is fail-closed', () => {
  it('treats a TRUNCATED lease file as INCONCLUSIVE, never success', () => {
    const repo = initRepo();
    acquireOk(repo, 'session-a');
    const raw = readLeaseRaw(repo);
    writeFileSync(resolveLeaseLocation(repo).leasePath, raw.slice(0, Math.floor(raw.length / 2)));

    for (const result of [
      statusLease({ cwd: repo }),
      acquireLease({ cwd: repo, taskId: 't', sessionId: 'session-b', toolIdentity: 'vitest' }),
      heartbeatLease({ cwd: repo, sessionId: 'session-a', toolIdentity: 'vitest' }),
      releaseLease({ cwd: repo, sessionId: 'session-a', toolIdentity: 'vitest' }),
      takeoverLease({ cwd: repo, taskId: 't', sessionId: 'session-b', toolIdentity: 'vitest' }),
    ]) {
      expect(result.kind).toBe('inconclusive');
      expect(exitCodeFor(result)).toBe(EXIT_INCONCLUSIVE);
    }
  });

  it('treats a lease missing a required field as INCONCLUSIVE, never success', () => {
    const repo = initRepo();
    const record = acquireOk(repo, 'session-a');
    const stripped: Record<string, unknown> = { ...record };
    delete stripped.lineage;
    writeFileSync(resolveLeaseLocation(repo).leasePath, JSON.stringify(stripped));

    const result = statusLease({ cwd: repo });
    expect(result.kind).toBe('inconclusive');
    if (result.kind === 'ok') throw new Error('unreachable');
    expect(result.reason).toBe('git.worktree.unaccounted-state');
  });

  it('treats a lease with a wrong-typed field as INCONCLUSIVE (no silent coercion)', () => {
    const repo = initRepo();
    const record = acquireOk(repo, 'session-a');
    writeFileSync(
      resolveLeaseLocation(repo).leasePath,
      JSON.stringify({ ...record, generation: '2' }),
    );
    expect(parseLeaseRecord(readLeaseRaw(repo)).valid).toBe(false);
    expect(statusLease({ cwd: repo }).kind).toBe('inconclusive');
  });

  it('treats an UNREADABLE lease path (a directory in its place) as INCONCLUSIVE', () => {
    const repo = initRepo();
    const { leasePath } = resolveLeaseLocation(repo);
    mkdirSync(leasePath, { recursive: true });
    const result = statusLease({ cwd: repo });
    expect(result.kind).toBe('inconclusive');
    expect(exitCodeFor(result)).toBe(EXIT_INCONCLUSIVE);
  });

  it('CLI: a malformed lease exits 2 (INCONCLUSIVE), never 0', () => {
    const repo = initRepo();
    acquireOk(repo, 'session-a');
    writeFileSync(resolveLeaseLocation(repo).leasePath, '{ "schemaVersion": 1, "leaseId"');
    const cli = runCli(repo, ['status']);
    expect(cli.code).toBe(2);
    expect(cli.stderr).toContain('git.worktree.unaccounted-state');
  });

  it('is INCONCLUSIVE outside a git repository rather than reporting a free worktree', () => {
    const notARepo = join(scratch, 'plain');
    mkdirSync(notARepo, { recursive: true });
    const result = statusLease({ cwd: notARepo });
    expect(result.kind).toBe('inconclusive');
    expect(exitCodeFor(result)).toBe(EXIT_INCONCLUSIVE);
  });
});

// ── Expiry: a stale lease is NEVER removed merely for being old ──────────────
describe('agent-lease expiry', () => {
  it('reports EXPIRED_UNRECONCILED (exit 2) and does NOT steal the lease', () => {
    const repo = initRepo();
    const record = acquireOk(repo, 'session-a');
    const past = new Date(Date.now() - 3_600_000).toISOString();
    writeLease(repo, { ...record, heartbeatAt: past, expiresAt: past });

    const before = readLeaseRaw(repo);
    const result = acquireLease({ cwd: repo, taskId: 't', sessionId: 'session-b', toolIdentity: 'vitest' });

    expect(result.kind).toBe('inconclusive');
    if (result.kind === 'ok') throw new Error('unreachable');
    expect(result.reason).toBe('git.lease.expired-unreconciled');
    expect(exitCodeFor(result)).toBe(EXIT_INCONCLUSIVE);
    expect(exitCodeFor(result)).toBe(2);
    // Not silently stolen: byte-identical incumbent lease still on disk.
    expect(readLeaseRaw(repo)).toBe(before);
  });

  it('status on an expired lease is INCONCLUSIVE, not a clean "free worktree"', () => {
    const repo = initRepo();
    const record = acquireOk(repo, 'session-a');
    const past = new Date(Date.now() - 3_600_000).toISOString();
    writeLease(repo, { ...record, heartbeatAt: past, expiresAt: past });

    const result = statusLease({ cwd: repo });
    expect(result.kind).toBe('inconclusive');
    if (result.kind === 'ok') throw new Error('unreachable');
    expect(result.reason).toBe('git.lease.expired-unreconciled');
  });
});

// ── Takeover: seven steps, all of which must be PROVEN ───────────────────────
describe('agent-lease takeover', () => {
  /** Expire the held lease and point it at a writer PID that is provably absent. */
  function makeAbandonable(repo: string, record: LeaseRecord): LeaseRecord {
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const abandoned: LeaseRecord = {
      ...record,
      heartbeatAt: past,
      expiresAt: past,
      writer: { ...record.writer, processIdentity: `pid:${ABSENT_PID}|start:Mon Jan  1 00:00:00 2001` },
    };
    writeLease(repo, abandoned);
    return abandoned;
  }

  it('REFUSES takeover against a LIVE heartbeat → git.lease.writer-conflict, exit 1', () => {
    const repo = initRepo();
    acquireOk(repo, 'session-a');
    const before = readLeaseRaw(repo);

    const result = takeoverLease({ cwd: repo, taskId: 't', sessionId: 'session-b', toolIdentity: 'vitest' });
    expect(result.kind).toBe('block');
    if (result.kind === 'ok') throw new Error('unreachable');
    expect(result.reason).toBe('git.lease.writer-conflict');
    expect(exitCodeFor(result)).toBe(EXIT_BLOCK);
    expect(readLeaseRaw(repo)).toBe(before);
  });

  it('REFUSES takeover when the recorded PID is still ALIVE — a recycled PID is not identity', () => {
    const repo = initRepo();
    const record = acquireOk(repo, 'session-a');
    const past = new Date(Date.now() - 3_600_000).toISOString();
    // Same PID as a live process (this one), but a start time that does NOT match:
    // the PID was recycled. Death is therefore NOT proven → refuse.
    writeLease(repo, {
      ...record,
      heartbeatAt: past,
      expiresAt: past,
      writer: { ...record.writer, processIdentity: `pid:${process.pid}|start:Thu Jan  1 00:00:00 1970` },
    });
    const before = readLeaseRaw(repo);

    const result = takeoverLease({ cwd: repo, taskId: 't', sessionId: 'session-b', toolIdentity: 'vitest' });
    expect(result.kind).toBe('inconclusive');
    if (result.kind === 'ok') throw new Error('unreachable');
    expect(result.reason).toBe('git.lease.expired-unreconciled');
    expect(result.message).toMatch(/alive/i);
    expect(readLeaseRaw(repo)).toBe(before);
  });

  it('REFUSES takeover when process identity is UNDETERMINABLE (absence of evidence is not death)', () => {
    const repo = initRepo();
    const record = acquireOk(repo, 'session-a');
    const past = new Date(Date.now() - 3_600_000).toISOString();
    writeLease(repo, {
      ...record,
      heartbeatAt: past,
      expiresAt: past,
      writer: { ...record.writer, processIdentity: 'unknown' },
    });
    const before = readLeaseRaw(repo);

    const result = takeoverLease({ cwd: repo, taskId: 't', sessionId: 'session-b', toolIdentity: 'vitest' });
    expect(result.kind).toBe('inconclusive');
    if (result.kind === 'ok') throw new Error('unreachable');
    expect(result.reason).toBe('git.lease.expired-unreconciled');
    expect(exitCodeFor(result)).toBe(EXIT_INCONCLUSIVE);
    expect(readLeaseRaw(repo)).toBe(before);
  });

  it('SUCCEEDS when all seven steps are proven: generation increments and evidence is retained', () => {
    const repo = initRepo();
    const original = acquireOk(repo, 'session-a');
    const abandoned = makeAbandonable(repo, original);

    const result = takeoverLease({ cwd: repo, taskId: 'task-2', sessionId: 'session-b', toolIdentity: 'vitest' });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error(`${result.reason}: ${result.message}`);

    // 5. generation incremented
    expect(result.record.generation).toBe(original.generation + 1);
    expect(result.record.writer.sessionId).toBe('session-b');
    expect(result.record.leaseId).not.toBe(original.leaseId);
    // 7. a new candidate attempt id was issued
    expect(result.record.attemptId).toMatch(/[0-9a-f-]{36}/);
    expect(result.record.attemptId).not.toBe(original.attemptId);
    // 3. the pre-takeover branch + workspace state was frozen onto the record
    expect(result.record.freeze).not.toBeUndefined();
    expect(result.record.freeze?.branch).toBe('main');
    expect(result.record.freeze?.headOid).toMatch(/^[0-9a-f]{40}$/);
    expect(result.record.freeze?.workspaceDigest).toMatch(/^[0-9a-f]{64}$/);

    // 4. the previous lease is RETAINED as abandoned evidence, not deleted
    const { abandonedDir } = resolveLeaseLocation(repo);
    const evidence = readdirSync(abandonedDir);
    expect(evidence.length).toBeGreaterThan(0);
    const leaseEvidence = evidence.filter((f) => f.endsWith('.lease.json'));
    expect(leaseEvidence).toHaveLength(1);
    const retained = JSON.parse(readFileSync(join(abandonedDir, leaseEvidence[0]!), 'utf8')) as LeaseRecord;
    expect(retained.leaseId).toBe(abandoned.leaseId);
    expect(retained.writer.sessionId).toBe('session-a');

    const meta = evidence.filter((f) => f.endsWith('.abandoned.json'));
    expect(meta).toHaveLength(1);
    const metaBody = JSON.parse(readFileSync(join(abandonedDir, meta[0]!), 'utf8')) as {
      abandonedAt: string;
      abandonedBy: string;
      steps: { step: number; id: string; satisfied: boolean }[];
    };
    expect(Date.parse(metaBody.abandonedAt)).not.toBeNaN();
    expect(metaBody.abandonedBy).toBe('session-b');
    // All SEVEN rider steps recorded and satisfied.
    expect(metaBody.steps.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(metaBody.steps.every((s) => s.satisfied)).toBe(true);

    // The live lease is now the successor.
    const live = parseLeaseRecord(readLeaseRaw(repo));
    if (!live.valid) throw new Error('successor lease is not parseable');
    expect(live.record.leaseId).toBe(result.record.leaseId);
  });

  it('defaults omitted takeover allowedPaths to deny-all instead of inheriting a broad predecessor scope', () => {
    const repo = initRepo();
    makeAbandonable(repo, acquireOk(repo, 'session-a', { allowedPaths: ['.'] }));

    const result = takeoverLease({ cwd: repo, taskId: 'task-2', sessionId: 'session-b', toolIdentity: 'vitest' });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error(`${result.reason}: ${result.message}`);

    expect(result.record.allowedPaths).toEqual([]);
    expect(checkAllowedPaths(result.record, ['src/core/db.ts'])).toEqual(['src/core/db.ts']);
  });

  it('preserves explicit whole-repository takeover scope for compatibility', () => {
    const repo = initRepo();
    makeAbandonable(repo, acquireOk(repo, 'session-a', { allowedPaths: ['src'] }));

    const result = takeoverLease({
      cwd: repo,
      taskId: 'task-2',
      sessionId: 'session-b',
      toolIdentity: 'vitest',
      allowedPaths: ['.'],
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error(`${result.reason}: ${result.message}`);

    expect(result.record.allowedPaths).toEqual(['.']);
    expect(checkAllowedPaths(result.record, ['src/core/db.ts'])).toEqual([]);
  });

  it('reports every one of the seven rider steps on the successful result', () => {
    const repo = initRepo();
    makeAbandonable(repo, acquireOk(repo, 'session-a'));
    const result = takeoverLease({ cwd: repo, taskId: 't', sessionId: 'session-b', toolIdentity: 'vitest' });
    if (result.kind !== 'ok') throw new Error(`${result.reason}: ${result.message}`);
    expect(result.steps.map((s) => s.id)).toEqual([
      'heartbeat-expired',
      'writer-identity-proven-absent',
      'workspace-frozen',
      'previous-lease-recorded-abandoned',
      'generation-incremented',
      'lineage-revalidated',
      'candidate-attempt-issued',
    ]);
    expect(result.steps).toHaveLength(7);
  });

  it('REFUSES takeover when the worktree branch no longer matches the lease → WRONG_BRANCH', () => {
    const repo = initRepo();
    const record = acquireOk(repo, 'session-a');
    makeAbandonable(repo, record);
    run('git', ['checkout', '-b', 'other'], repo);

    const result = takeoverLease({ cwd: repo, taskId: 't', sessionId: 'session-b', toolIdentity: 'vitest' });
    expect(result.kind).toBe('block');
    if (result.kind === 'ok') throw new Error('unreachable');
    expect(result.reason).toBe('git.worktree.wrong-branch');
    expect(existsSync(resolveLeaseLocation(repo).leasePath)).toBe(true);
  });

  it('REFUSES takeover when HEAD is not the expected OID → git.head.unexpected-change', () => {
    const repo = initRepo();
    makeAbandonable(repo, acquireOk(repo, 'session-a'));
    const result = takeoverLease({
      cwd: repo,
      taskId: 't',
      sessionId: 'session-b',
      toolIdentity: 'vitest',
      expectHeadOid: '0'.repeat(40),
    });
    expect(result.kind).toBe('inconclusive');
    if (result.kind === 'ok') throw new Error('unreachable');
    expect(result.reason).toBe('git.head.unexpected-change');
  });

  it('REFUSES takeover when there is no lease at all (nothing to reconcile)', () => {
    const repo = initRepo();
    const result = takeoverLease({ cwd: repo, taskId: 't', sessionId: 'session-b', toolIdentity: 'vitest' });
    expect(result.kind).toBe('inconclusive');
    expect(exitCodeFor(result)).toBe(EXIT_INCONCLUSIVE);
  });
});

// ── Heartbeat / release ownership ───────────────────────────────────────────
describe('agent-lease heartbeat and release', () => {
  it('extends the lease for the owning writer', () => {
    const repo = initRepo();
    const record = acquireOk(repo, 'session-a', { ttlSeconds: 60 });
    const result = heartbeatLease({ cwd: repo, sessionId: 'session-a', toolIdentity: 'vitest', ttlSeconds: 600 });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(Date.parse(result.record.expiresAt)).toBeGreaterThan(Date.parse(record.expiresAt));
    expect(result.record.leaseId).toBe(record.leaseId);
    expect(result.record.generation).toBe(record.generation);
  });

  it('REFUSES a heartbeat from a non-owning session → WRITER_CONFLICT', () => {
    const repo = initRepo();
    acquireOk(repo, 'session-a');
    const before = readLeaseRaw(repo);
    const result = heartbeatLease({ cwd: repo, sessionId: 'session-b', toolIdentity: 'vitest' });
    expect(result.kind).toBe('block');
    if (result.kind === 'ok') throw new Error('unreachable');
    expect(result.reason).toBe('git.lease.writer-conflict');
    expect(readLeaseRaw(repo)).toBe(before);
  });

  it('REFUSES a release by a non-owner and RETAINS the lease', () => {
    const repo = initRepo();
    acquireOk(repo, 'session-a');
    const before = readLeaseRaw(repo);

    const result = releaseLease({ cwd: repo, sessionId: 'session-b', toolIdentity: 'vitest' });
    expect(result.kind).toBe('block');
    if (result.kind === 'ok') throw new Error('unreachable');
    expect(result.reason).toBe('git.lease.writer-conflict');
    expect(exitCodeFor(result)).toBe(EXIT_BLOCK);
    expect(readLeaseRaw(repo)).toBe(before);
  });

  it('REFUSES a release when the PID matches but the process identity does not (recycled PID)', () => {
    const repo = initRepo();
    const record = acquireOk(repo, 'session-a');
    writeLease(repo, {
      ...record,
      writer: { ...record.writer, processIdentity: `pid:${process.pid}|start:Thu Jan  1 00:00:00 1970` },
    });
    const result = releaseLease({ cwd: repo, sessionId: 'session-a', toolIdentity: 'vitest' });
    expect(result.kind).toBe('block');
    if (result.kind === 'ok') throw new Error('unreachable');
    expect(result.reason).toBe('git.lease.writer-conflict');
    expect(existsSync(resolveLeaseLocation(repo).leasePath)).toBe(true);
  });

  it('releases for the owner, archives the record, and frees the worktree', () => {
    const repo = initRepo();
    const record = acquireOk(repo, 'session-a');
    const result = releaseLease({ cwd: repo, sessionId: 'session-a', toolIdentity: 'vitest' });
    expect(result.kind).toBe('ok');
    expect(existsSync(resolveLeaseLocation(repo).leasePath)).toBe(false);

    const archived = readdirSync(resolveLeaseLocation(repo).releasedDir);
    expect(archived).toHaveLength(1);
    const body = JSON.parse(readFileSync(join(resolveLeaseLocation(repo).releasedDir, archived[0]!), 'utf8')) as LeaseRecord;
    expect(body.leaseId).toBe(record.leaseId);

    expect(acquireLease({ cwd: repo, taskId: 't', sessionId: 'session-b', toolIdentity: 'vitest' }).kind).toBe('ok');
  });

  it('REFUSES a heartbeat when no lease exists rather than silently creating one', () => {
    const repo = initRepo();
    const result = heartbeatLease({ cwd: repo, sessionId: 'session-a', toolIdentity: 'vitest' });
    expect(result.kind).toBe('inconclusive');
    expect(existsSync(resolveLeaseLocation(repo).leasePath)).toBe(false);
  });
});

// ── allowedPaths ────────────────────────────────────────────────────────────
describe('agent-lease allowedPaths', () => {
  it('reports every path outside the lease allowlist', () => {
    const repo = initRepo();
    const record = acquireOk(repo, 'session-a', { allowedPaths: ['src', 'docs/tools.md'] });
    const violations = checkAllowedPaths(record, [
      'src/core/db.ts',
      'docs/tools.md',
      'docs/runbook.md',
      '.github/workflows/quality.yml',
    ]);
    expect(violations).toEqual(['docs/runbook.md', '.github/workflows/quality.yml']);
  });

  it('BLOCKS an allowedPaths violation through the CLI with git.lease.path-not-allowed', () => {
    const repo = initRepo();
    acquireOk(repo, 'session-a', { allowedPaths: ['src'] });
    const cli = runCli(repo, ['check-path', 'docs/runbook.md']);
    expect(cli.code).toBe(1);
    expect(cli.stderr).toContain('git.lease.path-not-allowed');
    expect(cli.stderr).toContain('docs/runbook.md');

    const allowed = runCli(repo, ['check-path', 'src/core/db.ts']);
    expect(allowed.code).toBe(0);
  });

  it('denies EVERY path when allowedPaths is empty (fail-closed, not allow-all)', () => {
    const repo = initRepo();
    const record = acquireOk(repo, 'session-a', { allowedPaths: [] });
    expect(checkAllowedPaths(record, ['src/core/db.ts'])).toEqual(['src/core/db.ts']);
  });

  it('defaults omitted allowedPaths to deny-all rather than the whole repository', () => {
    const repo = initRepo();
    const record = acquireOk(repo, 'session-a');
    expect(record.allowedPaths).toEqual([]);
    expect(checkAllowedPaths(record, ['src/core/db.ts'])).toEqual(['src/core/db.ts']);
  });

  it('treats "." as a whole-repository allowlist', () => {
    const repo = initRepo();
    const record = acquireOk(repo, 'session-a', { allowedPaths: ['.'] });
    expect(record.allowedPaths).toEqual(['.']);
    expect(checkAllowedPaths(record, ['src/core/db.ts', 'docs/runbook.md'])).toEqual([]);
  });

  it('does not let a path escape the allowlist via traversal or prefix collision', () => {
    const repo = initRepo();
    const record = acquireOk(repo, 'session-a', { allowedPaths: ['src'] });
    expect(checkAllowedPaths(record, ['src/../docs/runbook.md', 'srcfoo/x.ts'])).toEqual([
      'src/../docs/runbook.md',
      'srcfoo/x.ts',
    ]);
  });
});

// ── Taxonomy and process identity primitives ────────────────────────────────
describe('agent-lease taxonomy and identity', () => {
  it('sanitizes unexpected failures without exposing raw exception text or absolute paths', () => {
    const localHomePrefix = ['', 'Users', 'example', 'private', 'repository.ts:10'].join('/');
    const rendered = formatUnexpectedFailure(
      new Error(`token=protected-value at ${localHomePrefix}`),
    );
    expect(rendered).toBe(
      '[agent-lease] git.worktree.unaccounted-state (INCONCLUSIVE) internal execution failed; reconcile the worktree and start a new attempt',
    );
    expect(rendered).not.toContain('protected-value');
    expect(rendered).not.toContain(['', 'Users', ''].join('/'));
  });

  it('keeps the CLI catch boundary inconclusive and sanitized when main throws', () => {
    const localHomePrefix = ['', 'Users', 'example', 'private', 'repository.ts:10'].join('/');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const code = executeCli([], () => {
      throw new Error(`token=protected-value at ${localHomePrefix}`);
    });

    expect(code).toBe(EXIT_INCONCLUSIVE);
    expect(stderr).toHaveBeenCalledTimes(1);
    const rendered = String(stderr.mock.calls[0]?.[0]);
    expect(rendered).toBe(`${formatUnexpectedFailure(undefined)}\n`);
    expect(rendered).not.toContain('protected-value');
    expect(rendered).not.toContain(['', 'Users', ''].join('/'));
    stderr.mockRestore();
  });
  it('maps the rider reason codes to the rider outcomes', () => {
    expect(REASON_OUTCOMES['git.lease.writer-conflict']).toBe('block');
    expect(REASON_OUTCOMES['git.lease.expired-unreconciled']).toBe('inconclusive');
    expect(REASON_OUTCOMES['git.worktree.wrong-branch']).toBe('block');
    expect(REASON_OUTCOMES['git.head.unexpected-change']).toBe('inconclusive');
    expect(REASON_OUTCOMES['git.worktree.unaccounted-state']).toBe('inconclusive');
  });

  it('maps outcomes to exit codes: ok 0, block 1, inconclusive 2', () => {
    expect(EXIT_OK).toBe(0);
    expect(EXIT_BLOCK).toBe(1);
    expect(EXIT_INCONCLUSIVE).toBe(2);
    expect(exitCodeFor({ kind: 'ok' })).toBe(EXIT_OK);
    expect(REASON_CODES.length).toBeGreaterThan(0);
    for (const reason of REASON_CODES) {
      const outcome = REASON_OUTCOMES[reason];
      const expected = outcome === 'block' ? EXIT_BLOCK : EXIT_INCONCLUSIVE;
      expect(exitCodeFor({ kind: outcome, reason })).toBe(expected);
    }
  });

  it('binds process identity to PID *and* process start time, not PID alone', () => {
    const mine = processIdentityString(process.pid);
    expect(mine).toMatch(/^pid:\d+\|start:.+/);
    expect(mine).not.toBe(`pid:${process.pid}|start:`);
    // Stable across calls for the same live process.
    expect(processIdentityString(process.pid)).toBe(mine);
    // A different PID yields a different identity even with the same start clock.
    expect(processIdentityString(ABSENT_PID)).not.toBe(mine);
  });

  it('binds the lease to an explicitly supplied long-lived writer PID', () => {
    const repo = initRepo();
    const record = acquireOk(repo, 'session-a', { pid: process.ppid });
    expect(record.writer.processIdentity).toBe(processIdentityString(process.ppid));
    expect(record.writer.processIdentity).not.toBe(processIdentityString(process.pid));

    // Ownership follows the DECLARED writer process, not whoever runs the command.
    const wrongProcess = releaseLease({ cwd: repo, sessionId: 'session-a', toolIdentity: 'vitest' });
    expect(wrongProcess.kind).toBe('block');
    const owner = releaseLease({ cwd: repo, sessionId: 'session-a', toolIdentity: 'vitest', pid: process.ppid });
    expect(owner.kind).toBe('ok');
  });

  it('CLI: rejects a non-numeric --pid as INCONCLUSIVE rather than defaulting silently', () => {
    const repo = initRepo();
    const cli = runCli(repo, ['acquire', '--task', 't', '--session', 's', '--tool', 'vitest', '--pid', 'abc']);
    expect(cli.code).toBe(2);
    expect(cli.stderr).toContain('--pid must be a positive integer');
    expect(existsSync(resolveLeaseLocation(repo).leasePath)).toBe(false);
  });

  it('reads repo facts from a real repository without fetching', () => {
    const repo = initRepo();
    const facts = readRepoFacts(repo);
    expect(facts.ok).toBe(true);
    if (!facts.ok) throw new Error(facts.message);
    expect(facts.facts.branch).toBe('main');
    expect(facts.facts.headOid).toMatch(/^[0-9a-f]{40}$/);
    // No remote configured → observedMainOid is explicitly null, never guessed.
    expect(facts.facts.observedMainOid).toBeNull();
    expect(facts.facts.workspaceDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('detects a dirty workspace in the frozen digest (the stash-collision surface)', () => {
    const repo = initRepo();
    const clean = readRepoFacts(repo);
    writeFileSync(join(repo, 'untracked.txt'), 'work in flight\n');
    const dirty = readRepoFacts(repo);
    if (!clean.ok || !dirty.ok) throw new Error('repo facts unreadable');
    expect(dirty.facts.workspaceDigest).not.toBe(clean.facts.workspaceDigest);
    expect(dirty.facts.dirtyPaths).toContain('untracked.txt');
  });
});
