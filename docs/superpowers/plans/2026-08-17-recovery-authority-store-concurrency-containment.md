# Recovery-Authority Store Concurrency Containment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every accepted recovery-marker mutation across concurrent WhatSoup processes without retaining the fixed-temp collision or introducing an unbounded synchronous event-loop stall.

**Architecture:** First harden the existing process-lock primitive so one acquisition can wait with one already-fsynced temp payload and can distinguish a normal release race from corrupt on-disk bytes. Then route both marker mutators through one locked read-modify-write transaction and publish with the existing private-JSON writer. A bounded real-process harness proves set/set conservation and forces set/clear through the actual internal filesystem read boundary.

**Tech Stack:** TypeScript, Node.js 24.15.0, Vitest 4, `node:child_process`, existing `process-lock.ts`, existing `private-fs.ts`, Test Integrity, and the WhatSoup branch/release gates.

**Approved design:** `docs/superpowers/specs/2026-08-17-recovery-authority-store-concurrency-containment-design.md`

**Review status:** execution evidence amended this plan after its prior review.
Revalidate the amended plan before publication.

## Global Constraints

- Begin from `fix/recovery-authority-store-concurrency`; preserve the existing untracked falsifier until Task 2 replaces it deliberately.
- Fetch and rebase onto current `origin/main` before implementation. Use `git stash --include-untracked` only if the untracked test obstructs rebase; never use destructive checkout, restore, clean, or reset commands.
- Recheck open PRs and remote branches for overlapping edits to `src/lib/recovery-authority-store.ts`, `src/lib/process-lock.ts`, and their tests immediately before rebase.
- Preserve `state_root()`, marker keys, the public `void` mutator signatures, `loadRecoveryMarkers(): Set<string>`, and the truthy-key JSON object schema.
- Do not move state to `XDG_STATE_HOME`, export `WHATSOUP_INSTANCE`, split stores by instance, migrate markers, or change `loadRecoveryMarkers()` failure semantics.
- Replace the design's reviewed-but-unproven 2,000 ms wait with `RECOVERY_AUTHORITY_LOCK_WAIT_MS = 500`. Do not raise that ceiling to make a test pass.
- The policy-bounded stall is 500 ms of contention wait plus one synchronous acquire/write/release attempt. On the local measurement host, the exact planned uncontended transaction measured p50 15.230 ms, p95 49.092 ms, p99 68.973 ms, and max 87.914 ms over 1,000 iterations; the evidence-bound observed envelope is therefore about 588 ms, not 500 ms. OS fsync latency has no deterministic hard upper bound, so never describe this as a strict 588 ms guarantee.
- The local starvation threshold is 250 ms. One isolated stall does not alone set the 20-sample p95 starvation signal, but repeated marker mutations can. The implementation must expose timeout/failure evidence and must not claim it eliminates event-loop risk.
- A 16-process probe of a naive retry loop produced 1/16 success at 100 ms, 4/16 at 250 ms, and 13/16 at 500 ms. At 1,000–2,000 ms, nine children failed because `acquireProcessLock()` classified a normal release-between-`EEXIST`-and-read race as `corrupt`. Task 1 fixes that prerequisite before marker-store locking.
- If the improved one-temp wait cannot produce 16/16 successful writers and all 16 markers in 10 consecutive runs within the 500 ms wait ceiling, stop. Do not ship synchronous containment and do not increase the ceiling; reopen the approved design to choose typed path separation, per-marker files, or another non-global serialization architecture.

  > **⛔ HARD STOP TRIGGERED — 2026-08-17. This lane does not ship.**
  >
  > Observed on `1b48a3fe2` after two harness defects were corrected: **15/16 writers**,
  > with one child exiting code 1 on `ProcessLockError: process lock active` having waited
  > the full 500 ms — **deterministic across 3/3 runs**. That is below the 16/16 bar, so the
  > condition above applies verbatim: the ceiling was not raised and synchronous containment
  > is not shipped.
  >
  > Consistent with, not contradicted by, the 13/16-at-500 ms probe recorded above.
  >
  > *Why raising the ceiling would not have helped:* the lock is polling-based with no FIFO
  > or starvation protection. Each handoff costs up to a full `pollMs` (10 ms) before any
  > waiter observes the release, and an individual waiter can lose the race repeatedly. The
  > dominant cost is handoff latency × N, not the critical section, so the pressure grows
  > with contention and a larger ceiling only defers the same starvation.
  >
  > *Evidence limit:* the measurement host is loaded (load 43–48 across 14 cores) and cannot
  > be made quiet, so the 10-consecutive-run acceptance was not executed. An idle-host pass
  > would demonstrate favourable scheduling, not the architecture's concurrency guarantee
  > under realistic contention.
  >
  > **Decision (owner, 2026-08-17): reopen the design as one durable file per marker.**
  > Supporting evidence: the on-disk shape is not an external contract — all 12 production
  > consumers use only `loadRecoveryMarkers` / `setRecoveryMarker` / `clearRecoveryMarker`,
  > and no production code, script, or runbook reads `recovery-authority.json` directly
  > (only test fixtures do). Markers are independent by key (`<source>:<botName>`) with no
  > cross-key invariant, and consumers consume the result as `.has(key)`. A single object
  > therefore imposes **false sharing**: the 16-way race writes 16 *distinct* keys that
  > serialize on one lock for no semantic reason. Per-marker files make that contention
  > structurally impossible rather than merely wider, and `writeAtomicPrivateFileSync`
  > already supplies per-file atomicity.
  >
  > This supersedes the "Preserve … the truthy-key JSON object schema" and "do not migrate
  > markers" constraints above **for the successor lane only**; both remained in force for
  > every commit on this branch.
  >
  > Carried forward to the successor lane: `loadRecoveryMarkers()` becomes a directory
  > enumeration; a one-time read-both migration path is required; test fixtures that write
  > the aggregate object need updating; and the 2,000 ms test allowance below is retained
  > for now and revisited there.
- Every child process must have a watchdog. Timeout, signal, malformed receipt, masked exit, partial run, or empty output is inconclusive and cannot authorize GREEN.
- Use Node 24.15.0 locally. Node 25 evidence comes from GitHub quality jobs on the exact published SHA.
- No push, PR creation, workflow rerun, merge, deployment, service restart, or live marker mutation is authorized by Tasks 1-4.

---

## File Map

- `src/lib/process-lock.ts` — add opt-in bounded waiting that reuses one temp payload and correctly handles lock disappearance after `EEXIST`.
- `tests/lib/process-lock.test.ts` — pin release-race, bounded-wait, timeout, corrupt-file, and unchanged immediate-acquire behavior.
- `src/lib/recovery-authority-store.ts` — own the shared transaction boundary and reuse private JSON publication.
- `tests/lib/recovery-authority-store.test.ts` — retain sequential semantics, remove duplicate setup, and correct false concurrency wording.
- `tests/lib/recovery-authority-store-concurrency.test.ts` — own the watchdog-bounded process harness and behavioral set/set plus set/clear proofs.
- `docs/superpowers/specs/2026-08-17-recovery-authority-store-concurrency-containment-design.md` — record the measured timeout correction and process-lock prerequisite discovered during plan review.
- `docs/publication-audit.md` — retain canonical private-archive classification after the design amendment and this plan are tracked.

---

### Task 1: Align the branch and harden bounded process-lock waiting

**Files:**

- Modify: `src/lib/process-lock.ts:15-70,234-335`
- Modify: `tests/lib/process-lock.test.ts`
- Modify: `docs/superpowers/specs/2026-08-17-recovery-authority-store-concurrency-containment-design.md`
- Modify: `docs/publication-audit.md`

**Interfaces:**

- Consumes: existing `acquireProcessLock(lockPath, options)` and `releaseProcessLock(handle)`.
- Produces: optional `AcquireProcessLockOptions.wait` with exact type `ProcessLockWaitOptions`; existing callers without `wait` retain immediate fail-closed behavior.

- [ ] **Step 1: Capture alignment and overlap evidence, then rebase**

Run:

```bash
git fetch origin
git status --short --branch
git rev-list --left-right --count origin/main...HEAD
gh pr list --state open --limit 100 --json number,title,headRefName,files \
  --jq '.[] | select(any(.files[]?; .path == "src/lib/process-lock.ts" or .path == "src/lib/recovery-authority-store.ts" or .path == "tests/lib/process-lock.test.ts" or .path == "tests/lib/recovery-authority-store.test.ts"))'
git rebase origin/main
git status --short --branch
```

Expected: no overlapping open PR; rebase succeeds; the untracked concurrency test remains present. If an overlapping PR exists or the untracked path obstructs rebase, stop and reconcile ownership before continuing.

- [ ] **Step 2: Add deterministic failing process-lock tests**

In `tests/lib/process-lock.test.ts`, add tests for the exact new contract:

```ts
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import type {
  AcquireProcessLockOptions,
  ProcessLockHandle,
} from '../../src/lib/process-lock.ts';

function fixedIdentity(token: string, pid: number): AcquireProcessLockOptions {
  return {
    pid,
    token,
    now: new Date('2026-08-17T00:00:00.000Z'),
    bootId: 'boot-current',
    isProcessAlive: () => true,
  };
}

function withPatchedReadFileSync<T>(
  replacement: (original: typeof fs.readFileSync) => typeof fs.readFileSync,
  action: () => T,
): T {
  const original = fs.readFileSync;
  fs.readFileSync = replacement(original);
  syncBuiltinESMExports();
  try {
    return action();
  } finally {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  }
}

it('retries when the conflicting lock is released between EEXIST and payload read', () => {
  const lockPath = makeLockPath();
  const held = acquireProcessLock(lockPath, fixedIdentity('held', 11111));
  let released = false;

  const acquired = withPatchedReadFileSync(
    (original) => ((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === lockPath && !released) {
        released = true;
        expect(releaseProcessLock(held)).toBe(true);
      }
      return Reflect.apply(original, fs, args);
    }) as typeof fs.readFileSync,
    () => acquireProcessLock(lockPath, fixedIdentity('next', 22222)),
  );

  expect(released).toBe(true);
  expect(acquired.token).toBe('next');
  expect(releaseProcessLock(acquired)).toBe(true);
});

it('classifies a replacement holder as active rather than corrupt', () => {
  const lockPath = makeLockPath();
  const held = acquireProcessLock(lockPath, fixedIdentity('held', 11111));
  let replacement: ProcessLockHandle | undefined;
  let interleaved = false;

  const error = withPatchedReadFileSync(
    (original) => ((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) !== lockPath || interleaved) {
        return Reflect.apply(original, fs, args);
      }
      interleaved = true;
      expect(releaseProcessLock(held)).toBe(true);
      let missingError: unknown;
      try {
        Reflect.apply(original, fs, args);
      } catch (error) {
        missingError = error;
      }
      expect((missingError as NodeJS.ErrnoException).code).toBe('ENOENT');
      replacement = acquireProcessLock(lockPath, fixedIdentity('replacement', 33333));
      throw missingError;
    }) as typeof fs.readFileSync,
    () => catchError(() => acquireProcessLock(lockPath, fixedIdentity('next', 22222))),
  );

  expect(interleaved).toBe(true);
  expect(isProcessLockError(error)).toBe(true);
  if (!isProcessLockError(error)) throw new Error('expected ProcessLockError');
  expect(error.reason).toBe('active');
  expect(error.existingPid).toBe(33333);
  expect(replacement).toBeDefined();
  expect(releaseProcessLock(replacement!)).toBe(true);
});

it('waits with one acquisition payload and succeeds after a live holder releases', () => {
  const lockPath = makeLockPath();
  const held = acquireProcessLock(lockPath, fixedIdentity('held', 11111));
  let nowMs = 0;
  let sleeps = 0;

  const acquired = acquireProcessLock(lockPath, {
    ...fixedIdentity('next', 22222),
    wait: {
      timeoutMs: 500,
      pollMs: 10,
      monotonicNow: () => nowMs,
      sleep: (ms) => {
        sleeps += 1;
        nowMs += ms;
        if (sleeps === 1) expect(releaseProcessLock(held)).toBe(true);
      },
    },
  });

  expect(sleeps).toBe(1);
  expect(acquired.token).toBe('next');
  expect(releaseProcessLock(acquired)).toBe(true);
});

it('bounds live-holder waiting and preserves the holder on timeout', () => {
  const lockPath = makeLockPath();
  const held = acquireProcessLock(lockPath, fixedIdentity('held', 11111));
  let nowMs = 0;

  const error = catchError(() => acquireProcessLock(lockPath, {
    ...fixedIdentity('next', 22222),
    wait: {
      timeoutMs: 25,
      pollMs: 10,
      monotonicNow: () => nowMs,
      sleep: (ms) => { nowMs += ms; },
    },
  }));

  expect(isProcessLockError(error)).toBe(true);
  if (!isProcessLockError(error)) throw new Error('expected ProcessLockError');
  expect(error.reason).toBe('active');
  expect(nowMs).toBe(25);
  expect(readProcessLockPayload(lockPath)?.token).toBe('held');
  expect(releaseProcessLock(held)).toBe(true);
});
```

Extend the existing corrupt-lock test to prove valid-looking but unreadable/truncated bytes remain `corrupt` and are never deleted. Add option-validation cases for negative, non-finite, or non-integer `timeoutMs`, and for non-positive/non-integer `pollMs`.

- [ ] **Step 3: Run the focused tests and capture RED**

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  npx vitest run --pool=forks --retry=0 tests/lib/process-lock.test.ts
```

Expected: RED because `wait` and the release-race retry do not exist. The tests
patch the real `node:fs` read boundary and synchronize named builtin exports;
they add no production-only timing seam. The old release-race path reports
`ProcessLockError('corrupt')`.

- [ ] **Step 4: Implement one-temp bounded waiting and release-race distinction**

Add these option types near `AcquireProcessLockOptions` in `src/lib/process-lock.ts`:

```ts
export interface ProcessLockWaitOptions {
  timeoutMs: number;
  pollMs: number;
  monotonicNow?: () => number;
  sleep?: (ms: number) => void;
}

export interface AcquireProcessLockOptions {
  // existing fields remain
  wait?: ProcessLockWaitOptions;
}
```

Add dependency-light defaults and validation:

```ts
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface ValidatedProcessLockWait {
  deadlineMs: number;
  pollMs: number;
  now: () => number;
  sleep: (ms: number) => void;
}

function validatedWait(options: ProcessLockWaitOptions | undefined): ValidatedProcessLockWait | null {
  if (!options) return null;
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0) {
    throw new RangeError('process lock wait timeoutMs must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(options.pollMs) || options.pollMs < 1) {
    throw new RangeError('process lock wait pollMs must be a positive safe integer');
  }
  const rawNow = options.monotonicNow ?? (() => performance.now());
  const rawSleep = options.sleep ?? sleepSync;
  const startedAtMs = rawNow();
  if (!Number.isFinite(startedAtMs)) {
    throw new RangeError('process lock wait monotonic clock must return a finite number');
  }
  const deadlineMs = startedAtMs + options.timeoutMs;
  let lastObservedMs = startedAtMs;
  const now = (): number => {
    const currentMs = rawNow();
    if (!Number.isFinite(currentMs)) {
      throw new RangeError('process lock wait monotonic clock must return a finite number');
    }
    if (currentMs < lastObservedMs) {
      throw new RangeError('process lock wait monotonic clock must not move backwards');
    }
    lastObservedMs = currentMs;
    return currentMs;
  };
  return {
    deadlineMs,
    pollMs: options.pollMs,
    now,
    sleep: (ms) => {
      const beforeSleepMs = lastObservedMs;
      rawSleep(ms);
      if (now() <= beforeSleepMs) {
        throw new RangeError('process lock wait monotonic clock must advance after sleep');
      }
    },
  };
}
```

Validate every later `wait.now()` result before deadline arithmetic as well. A
custom clock that becomes non-finite, moves backward, or fails to advance after
the injected sleep must throw a named `RangeError` rather than turning a bounded
wait into an unbounded loop. Compute `wait` once after
the one temp payload has been written and fsynced but before the acquisition
loop. That preserves the stated policy: at most 500 ms of cooperative waiting
plus temp preparation and the terminal synchronous attempt. The global
constraints already state that filesystem latency makes the total wall-clock
stall non-deterministic.

Do not distinguish absence from corruption with `readProcessLockPayload()`
followed by `existsSync()`: a replacement can appear between those calls and
be falsely reported corrupt. Refactor the existing parser behind one internal,
single-read discriminated result while preserving the public nullable API:

```ts
type ProcessLockReadResult =
  | { status: 'missing' }
  | { status: 'corrupt' }
  | { status: 'valid'; payload: ProcessLockPayload };

function readProcessLockResult(lockPath: string): ProcessLockReadResult {
  let text: string;
  try {
    text = readFileSync(lockPath, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'corrupt' };
  }
  try {
    const parsed = JSON.parse(text) as Partial<ProcessLockPayload>;
    const result = ProcessLockShapeSchema.safeParse(parsed);
    if (!result.success) return { status: 'corrupt' };
    return {
      status: 'valid',
      payload: {
        ...result.data,
        ...(typeof parsed.bootId === 'string' ? { bootId: parsed.bootId } : {}),
      },
    };
  } catch {
    return { status: 'corrupt' };
  }
}

export function readProcessLockPayload(lockPath: string): ProcessLockPayload | null {
  const result = readProcessLockResult(lockPath);
  return result.status === 'valid' ? result.payload : null;
}
```

Create the temp payload once, as today. In the existing `EEXIST` branch,
consume that one-read classification:

```ts
const wait = validatedWait(options.wait);

const observed = readProcessLockResult(lockPath);
if (observed.status === 'missing') continue;
if (observed.status === 'corrupt') throw new ProcessLockError('corrupt', lockPath);
const existing = observed.payload;
```

When the existing holder is live, wait only when the opt-in budget remains, reusing the same temp payload and the existing loop:

```ts
if (isProcessAlive(existing.pid)) {
  if (wait && !terminalWaitAttempted) {
    const currentMs = wait.now();
    const remainingMs = wait.deadlineMs - currentMs;
    if (remainingMs > 0) {
      wait.sleep(Math.min(wait.pollMs, remainingMs));
      continue;
    }
    terminalWaitAttempted = true;
    continue;
  }
  throw new ProcessLockError('active', lockPath, existing.pid, decisionOf(true));
}
```

Initialize `terminalWaitAttempted` to false beside the existing reclaim flags.
The deadline transition returns to the atomic `linkSync` once; if that terminal
attempt still observes a live holder it throws `active`. This is required
because throwing from the pre-deadline holder observation can reject a lock
that was released before the atomic link was retried.

Do not change behavior for callers that omit `wait`. Do not delete an existing corrupt lock. Keep the outer `finally` cleanup so the one temp payload is removed on success or terminal failure.

- [ ] **Step 5: Run process-lock GREEN and all existing lock consumers**

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  npx vitest run --pool=forks --retry=0 \
  tests/lib/process-lock.test.ts \
  tests/lib/process-lock-fsync-failure.test.ts \
  tests/core/private-config-file.test.ts \
  tests/fleet/silence-manager.test.ts \
  tests/scripts/qregistry-loop.test.ts
```

Expected: all selected files pass with no retries. Immediate callers retain existing behavior; only opt-in callers wait.

- [ ] **Step 6: Amend the design with measured evidence and the prerequisite**

In the design's contention section, replace the 2,000 ms value with 500 ms and add:

```markdown
The policy bounds only cooperative contention waiting. One lock acquisition and
the synchronous filesystem transaction can extend wall-clock blocking beyond
500 ms. On the local measurement host, 1,000 exact primitive transactions measured p50 15.230 ms,
p95 49.092 ms, p99 68.973 ms, and max 87.914 ms, making the observed envelope
about 588 ms. Filesystem calls have no deterministic hard upper bound.

Plan review also proved that the existing process-lock primitive conflates a
normal release between `linkSync(...)=EEXIST` and payload read with corrupt
bytes. A follow-up `existsSync()` check would remain racy with a replacement
holder, so the prerequisite lock change uses one discriminated read result:
missing retries, valid is evaluated normally, and unreadable bytes remain
fail-closed corrupt.
```

Run the publication generator rather than hand-editing counts:

```bash
npm run guard:publication:write
npm run guard:publication:all
npm run guard:doc-drift
npm run guard:doc-tally
```

- [ ] **Step 7: Commit the prerequisite and design correction**

```bash
git add src/lib/process-lock.ts tests/lib/process-lock.test.ts \
  docs/superpowers/specs/2026-08-17-recovery-authority-store-concurrency-containment-design.md \
  docs/publication-audit.md
git diff --cached --check
npm run guard:publication:staged
git commit -m "fix(runtime): bound cooperative process-lock waiting"
```

---

### Task 2: Rebuild the process harness and implement the marker transaction

**Files:**

- Modify: `tests/lib/recovery-authority-store-concurrency.test.ts`
- Modify: `src/lib/recovery-authority-store.ts:21-139`

**Interfaces:**

- Consumes: `acquireProcessLock(path, { reclaimDeadSameBoot: true, wait: { timeoutMs: 500, pollMs: 10 } })`, `releaseProcessLock()`, `forceEnsurePrivateDirectorySync()`, and `writePrivateJsonMarkerSync()`.
- Produces: unchanged public `loadRecoveryMarkers()`, `setRecoveryMarker(source)`, and `clearRecoveryMarker(source)` functions.

- [ ] **Step 1: Replace the child runner with a bounded receipt protocol**

Resolve the module independently of cwd:

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STORE = fileURLToPath(new URL('../../src/lib/recovery-authority-store.ts', import.meta.url));
const CHILD_TIMEOUT_MS = 10_000;
const CHILD_KILL_GRACE_MS = 1_000;

interface ChildReceipt {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  operationElapsedMs: number | null;
  stdout: string;
  stderr: string;
}

interface RunningChild {
  ready: Promise<void>;
  send: (message: string) => void;
  settled: () => boolean;
  result: Promise<ChildReceipt>;
}

interface ChildWatchdogOptions {
  timeoutMs?: number;
  killGraceMs?: number;
}
```

Spawn children detached on POSIX so the watchdog owns their process group. Return separate readiness and completion promises; never truncate away exit classification:

```ts
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label}: timed out after ${timeoutMs}ms`);
    await delay(5);
  }
}

function terminateChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== 'win32') {
    try { process.kill(-child.pid, signal); return; } catch { /* child may already be gone */ }
  }
  child.kill(signal);
}

function spawnBoundedChild(
  file: string,
  options: ChildWatchdogOptions = {},
): RunningChild {
  const timeoutMs = options.timeoutMs ?? CHILD_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? CHILD_KILL_GRACE_MS;
  const child = spawn(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    '--experimental-strip-types',
    file,
  ], {
    detached: process.platform !== 'win32',
    env: { ...process.env, BOT_ERRORS_STATE_DIR: stateDir },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  let stdout = '';
  let stderr = '';
  let didSettle = false;
  let operationElapsedMs: number | null = null;
  let readyResolve!: () => void;
  const readySignal = new Promise<void>((resolve) => { readyResolve = resolve; });
  child.stdout!.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
  child.on('message', (message) => {
    if (message === 'ready') readyResolve();
    if (
      typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === 'operation-complete'
      && 'elapsedMs' in message
      && typeof message.elapsedMs === 'number'
      && Number.isFinite(message.elapsedMs)
      && message.elapsedMs >= 0
    ) {
      operationElapsedMs = message.elapsedMs;
    }
  });

  const result = new Promise<ChildReceipt>((resolve) => {
    let timedOut = false;
    let forceKill: NodeJS.Timeout | undefined;
    let finished = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      terminateChildTree(child, 'SIGTERM');
      forceKill = setTimeout(
        () => terminateChildTree(child, 'SIGKILL'),
        killGraceMs,
      );
    }, timeoutMs);
    const finish = (receipt: ChildReceipt): void => {
      if (finished) return;
      finished = true;
      clearTimeout(watchdog);
      if (forceKill) clearTimeout(forceKill);
      didSettle = true;
      resolve(receipt);
    };
    child.on('close', (code, signal) => {
      finish({ code, signal, timedOut, operationElapsedMs, stdout, stderr });
    });
    child.on('error', (error) => {
      finish({ code: null, signal: null, timedOut, operationElapsedMs, stdout, stderr: `${stderr}${String(error)}` });
    });
  });

  const ready = withTimeout(
    Promise.race([
      readySignal,
      result.then((receipt) => {
        throw new Error(`child exited before readiness: ${JSON.stringify(receipt)}`);
      }),
    ]),
    timeoutMs,
    'child readiness',
  );

  return {
    ready,
    send: (message) => child.send?.(message),
    settled: () => didSettle,
    result,
  };
}

function expectSuccessfulReceipt(receipt: ChildReceipt): void {
  expect(receipt).toMatchObject({
    code: 0,
    signal: null,
    timedOut: false,
    stdout: '',
    stderr: '',
  });
  expect(receipt.operationElapsedMs).not.toBeNull();
  expect(receipt.operationElapsedMs).toBeGreaterThanOrEqual(0);
}

function orphanStoreArtifacts(): string[] {
  return fs.readdirSync(stateDir).filter((name) =>
    name === `${MARKER_FILE}.tmp`
    || name === `${MARKER_FILE}.lock`
    || (name.startsWith(`.${MARKER_FILE}.`) && name.endsWith('.tmp'))
  );
}
```

Child scripts must send `ready`, await `go`, invoke exactly one public store
operation, and send one `operation-complete` receipt measured with the child's
real `performance.now()` clock. Await the IPC send callback before exit so a
clean exit without the measurement cannot be accepted. Add a named parent
readiness timeout so a child that never reaches the barrier is inconclusive
rather than a hung test. Add one focused harness test with a 100 ms watchdog
and 50 ms SIGKILL grace against a child that announces readiness but ignores
SIGTERM; it must produce `timedOut: true`, a nonzero signal classification,
and complete without leaving a live child.

- [ ] **Step 2: Rebuild set/set and prove RED against unchanged store code**

Generate 16 child scripts with this body:

```ts
import { setRecoveryMarker } from ${JSON.stringify(STORE)};
process.send?.('ready');
await new Promise<void>((resolve) => process.once('message', (message) => {
  if (message === 'go') resolve();
}));
const startedAtMs = performance.now();
setRecoveryMarker(${JSON.stringify(key)});
const elapsedMs = performance.now() - startedAtMs;
await new Promise<void>((resolve, reject) => {
  if (!process.send) return reject(new Error('IPC channel unavailable'));
  process.send({ type: 'operation-complete', elapsedMs }, (error) => {
    if (error) reject(error);
    else resolve();
  });
});
```

Wait for all 16 readiness receipts, release all 16 without awaiting any one child first, then assert every receipt before disk state:

```ts
const children = childFiles.map(spawnBoundedChild);
await Promise.all(children.map((child) => child.ready));
for (const child of children) child.send('go');
const receipts = await Promise.all(children.map((child) => child.result));

for (const receipt of receipts) expectSuccessfulReceipt(receipt);
expect(Object.keys(readMarkersFromDisk()).sort()).toEqual(expectedKeys.sort());
expect(orphanStoreArtifacts()).toEqual([]);
```

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  npx vitest run --pool=forks --retry=0 \
  tests/lib/recovery-authority-store-concurrency.test.ts \
  -t "preserves every concurrently written marker"
```

Expected: RED on unchanged store code through child failure and/or missing-marker conservation. This is the rewritten-harness baseline; do not inherit the former busy-spin result.

- [ ] **Step 3: Replace the decoy set/clear test with the actual read-boundary interleave**

The clear child must patch the shared default `node:fs` object before dynamically importing the store:

```ts
import fs from 'node:fs';
const markerPath = ${JSON.stringify(markerPath)};
const releasePath = ${JSON.stringify(clearReadReleasePath)};
const originalRead = fs.readFileSync.bind(fs);
let intercepted = false;
fs.readFileSync = ((path, ...args) => {
  const value = originalRead(path, ...args);
  if (!intercepted && String(path) === markerPath) {
    intercepted = true;
    process.send?.('ready');
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(releasePath)) Atomics.wait(sleeper, 0, 0, 5);
  }
  return value;
}) as typeof fs.readFileSync;
const { clearRecoveryMarker } = await import(${JSON.stringify(STORE)});
const startedAtMs = performance.now();
clearRecoveryMarker('source-a:inst-a');
const elapsedMs = performance.now() - startedAtMs;
await new Promise<void>((resolve, reject) => {
  if (!process.send) return reject(new Error('IPC channel unavailable'));
  process.send({ type: 'operation-complete', elapsedMs }, (error) => {
    if (error) reject(error);
    else resolve();
  });
});
```

Parent orchestration is the same before and after the fix:

```ts
const clearing = spawnBoundedChild(clearScript);
await clearing.ready;
// `setScript` reuses the ready/go/operation-complete body from Step 2.
const adding = spawnBoundedChild(setScript);
await adding.ready;
adding.send('go');

await waitUntil(
  () => adding.settled() || fs.existsSync(`${markerPath}.lock`),
  CHILD_TIMEOUT_MS,
  'setter neither completed nor encountered the transaction lock',
);
fs.writeFileSync(clearReadReleasePath, 'release', { flag: 'wx' });

const [clearReceipt, setReceipt] = await Promise.all([clearing.result, adding.result]);
expectSuccessfulReceipt(clearReceipt);
expectSuccessfulReceipt(setReceipt);
expect(readMarkersFromDisk()).toEqual({ 'source-b:inst-b': true });
```

Against old code there is no lock: the setter completes, then the stale clear erases B, producing RED. Against contained code the clear owns the lock at its real read boundary: the parent releases it, then the setter reads the post-clear object and preserves B. The set/set test separately prevents a decorative or one-sided lock from satisfying this test.

- [ ] **Step 4: Implement the one-transaction marker mutation**

In `src/lib/recovery-authority-store.ts`, import the established primitives and define the fixed policy:

```ts
import {
  acquireProcessLock,
  isProcessLockError,
  releaseProcessLock,
  type ProcessLockHandle,
} from './process-lock.ts';
import {
  forceEnsurePrivateDirectorySync,
  writePrivateJsonMarkerSync,
} from './private-fs.ts';

const RECOVERY_AUTHORITY_LOCK_WAIT_MS = 500;
const RECOVERY_AUTHORITY_LOCK_POLL_MS = 10;
```

Keep the current set-versus-clear read-failure behavior through one explicit loader:

```ts
type MarkerReadFailure = 'empty' | 'skip';

function markersForMutation(
  path: string,
  onFailure: MarkerReadFailure,
): Map<string, boolean> | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path, 'utf-8'));
    const markers = new Map<string, boolean>();
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      for (const key of parseMarkerJson(raw as Record<string, unknown>)) markers.set(key, true);
    }
    return markers;
  } catch {
    return onFailure === 'empty' ? new Map<string, boolean>() : null;
  }
}
```

Add the shared transaction boundary:

```ts
function mutateRecoveryMarkers(
  operation: 'set' | 'clear',
  source: string,
): void {
  const startedAtMs = performance.now();
  const path = markerPath();
  forceEnsurePrivateDirectorySync(Path.dirname(path), 'recovery authority state');

  let lock: ProcessLockHandle;
  try {
    lock = acquireProcessLock(`${path}.lock`, {
      reclaimDeadSameBoot: true,
      wait: {
        timeoutMs: RECOVERY_AUTHORITY_LOCK_WAIT_MS,
        pollMs: RECOVERY_AUTHORITY_LOCK_POLL_MS,
      },
    });
  } catch (error) {
    const reason = isProcessLockError(error)
      ? (error.reason === 'active' ? 'lock_timeout' : `lock_${error.reason}`)
      : 'lock_unavailable';
    log.warn({
      operation,
      reason,
      elapsedMs: Math.round(performance.now() - startedAtMs),
    }, 'recovery authority mutation not accepted');
    throw error;
  }

  try {
    const markers = markersForMutation(path, operation === 'set' ? 'empty' : 'skip');
    if (markers === null) return;
    if (operation === 'set') markers.set(source, true);
    else markers.delete(source);
    writePrivateJsonMarkerSync(path, Object.fromEntries(markers), {
      label: 'recovery authority markers',
    });
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as NodeJS.ErrnoException).code ?? 'unknown')
      : 'unknown';
    log.warn({
      operation,
      reason: 'mutation_failed',
      code,
      elapsedMs: Math.round(performance.now() - startedAtMs),
    }, 'recovery authority mutation failed');
    throw error;
  } finally {
    if (!releaseProcessLock(lock)) {
      log.error({
        operation,
        reason: 'lock_release_lost_ownership',
        elapsedMs: Math.round(performance.now() - startedAtMs),
      }, 'recovery authority lock release lost ownership');
    }
  }
}
```

Do not log `source` or the generated lock token. The operation, bounded reason,
error code when available, and monotonic elapsed time are sufficient to
reconstruct a timeout or publication failure without exposing marker identity.
Test the warning fields for `lock_timeout` and the error fields for a forced
release-ownership loss through existing module seams; a log line without these
machine-readable fields is not acceptance evidence.

Public mutators become exact wrappers:

```ts
export function setRecoveryMarker(source: string): void {
  mutateRecoveryMarkers('set', source);
}

export function clearRecoveryMarker(source: string): void {
  mutateRecoveryMarkers('clear', source);
}
```

Remove the fixed-temp writer. Do not change `loadRecoveryMarkers()` or `state_root()`.

- [ ] **Step 5: Run behavioral GREEN and enforce the 500 ms architecture gate**

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  npx vitest run --pool=forks --retry=0 \
  tests/lib/recovery-authority-store.test.ts \
  tests/lib/recovery-authority-store-concurrency.test.ts
```

Expected: both files pass, every child receipt is clean, all 16 keys survive, set/clear ends with only B, and no lock/temp artifacts remain.

Then run the complete concurrency file 10 separate times so each exit is independently visible:

```bash
for run in $(seq 1 10); do
  PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
    npx vitest run --pool=forks --retry=0 \
    tests/lib/recovery-authority-store-concurrency.test.ts || exit "$?"
done
```

Expected: 10/10 pass. If any writer reaches `lock_timeout`, any successful call exceeds the documented diagnostic envelope without explanation, or any run needs more than 500 ms of cooperative waiting, stop and reopen architecture. Do not raise the constant.

- [ ] **Step 6: Commit the behavioral containment**

```bash
git add src/lib/recovery-authority-store.ts \
  tests/lib/recovery-authority-store-concurrency.test.ts
git diff --cached --check
git commit -m "fix(reliability): serialize recovery marker mutations"
```

---

### Task 3: Correct legacy tests and prove mutation discrimination

**Files:**

- Modify: `tests/lib/recovery-authority-store.test.ts:1-117`
- Verify: `tests/lib/recovery-authority-store-concurrency.test.ts`

**Interfaces:**

- Consumes: unchanged public recovery-authority store API.
- Produces: accurate sequential semantics documentation plus explicit RED receipts for the three repaired race classes.

- [ ] **Step 1: Remove duplicate setup and false concurrency language**

Keep one `beforeEach`:

```ts
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'recovery-auth-test-'));
  process.env['BOT_ERRORS_STATE_DIR'] = tmpRoot;
  warnSpy.mockClear();
});
```

Replace the comments that claim `{}` closes a concurrent race with:

```ts
// Sequential format contract: clearing the final marker persists an empty
// object. Cross-process serialization is proved only by the sibling
// recovery-authority-store-concurrency suite.
```

Add sequential compatibility assertions for: readable object without the cleared key is republished unchanged; corrupt JSON makes clear a no-op; corrupt JSON makes set rebuild with only the requested key; array-shaped JSON normalizes through the existing empty-map path; and the published file is mode `0600` on POSIX.

- [ ] **Step 2: Run sequential and concurrency suites GREEN**

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  npx vitest run --pool=forks --retry=0 \
  tests/lib/recovery-authority-store.test.ts \
  tests/lib/recovery-authority-store-concurrency.test.ts
```

Expected: all tests pass without retry or timing warnings.

- [ ] **Step 3: Run explicit mutation falsifiers**

Perform each mutation one at a time with `apply_patch`, run the named test, capture RED, then apply the exact inverse patch before the next mutation:

1. Replace `writePrivateJsonMarkerSync()` in the transaction with the former
   fixed `path + '.tmp'` write/rename. Expected: set/set remains GREEN because
   the transaction lock serializes writers; the POSIX `0600` publication test
   fails (`0644` observed locally). This proves the private-writer contract
   without falsely claiming a temp collision can occur under an intact lock.
2. Move lock acquisition after `markersForMutation()`. Expected: set/set or set/clear fails because stale reads occur outside the lock.
3. Make `clearRecoveryMarker()` bypass `mutateRecoveryMarkers()`. Expected: behavioral set/clear fails and final state loses B.

After restoring each mutation, run:

```bash
git diff -- src/lib/recovery-authority-store.ts
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  npx vitest run --pool=forks --retry=0 \
  tests/lib/recovery-authority-store-concurrency.test.ts
```

Expected: the source diff is empty before the final GREEN run; the restored suite passes. Never use `git checkout`, `git restore`, or `git reset` to remove a mutation.

- [ ] **Step 4: Run Test Integrity on both test files**

```bash
$HOME/.claude/plugins/test-integrity/scripts/test-integrity scan --ci \
  tests/lib/process-lock.test.ts \
  tests/lib/recovery-authority-store.test.ts \
  tests/lib/recovery-authority-store-concurrency.test.ts
```

Expected: zero block findings. Manually record that every child has a watchdog, every child result is asserted, the actual read boundary is intercepted, and no retry masks a failure.

- [ ] **Step 5: Commit corrected sequential tests**

```bash
git add tests/lib/recovery-authority-store.test.ts
git diff --cached --check
git commit -m "test(reliability): distinguish recovery marker concurrency"
```

---

### Task 4: Run consumer regressions and the exact branch gate

**Files:**

- `tests/setup/bot-errors-vitest-isolation.ts` — per-test marker-store isolation (see the amendment below).
- `tests/lib/process-lock.test.ts` — default-clock contention coverage (see the amendment below).
- No production edits: `src/` is untouched by Task 4.

**Amendment (2026-08-17).** Task 4 was written verify-only. Step 1 surfaced a real,
reproducible consumer regression that required two test-side corrections, recorded here so
the final blast radius is not audited as unexplained extra change.

- **Failure census.** Step 1 on `145b2d62b` failed **6 files / 22 tests / 1 error**, in two
  classes that must not be conflated:
  - **6 genuine marker-leak failures** — health-poller ×1, connection-auth-bond-edge ×3,
    reconnect ×2 (`no alert emitted`, `called 0 times`, `expected true to be false`). These
    are what the isolation correction repairs.
  - **16 load-induced timeouts** — heal ×6, durability-edge ×6, poller-past-due-alert ×4
    (`Test/Hook timed out in 10000ms`). All 16 pass **unchanged** at raised timeouts under
    *higher* load (heal 51/51, durability-edge 46/46, poller-past-due-alert 10/10), and the
    same file on the same commit ran 289.6s in-batch vs 84.9s alone, so they were never
    evidence about this branch.

  The isolation correction is credited with **6**, never 22.

- **Root cause.** This setup file *names* `BOT_ERRORS_STATE_DIR` but never creates it, so
  every pre-repair marker write failed ENOENT and was swallowed. Once the repaired store
  creates its own directory (`recovery-authority-store.ts:122`), markers persist and leak
  between tests inside one worker; consumers restore alert ownership at construction
  (`connection.ts:738`, `scheduler.ts:144`, `health-poller.ts:809`) and suppress an alert a
  later test expects. Proven **intra-file**, not cross-file: the file alone still fails 3,
  while the single failing test alone passes. The suite was green because the store was
  broken.

- **Correction: named-not-created per-test isolation.** A `beforeEach` points
  `BOT_ERRORS_STATE_DIR` at a sequence-keyed path under the already-owned `isolatedHome`.
  The directory is **named, not created** — the store materialises it on first write — so
  no per-test `mkdtemp` is added and cleanup rides the existing ownership-token-guarded
  teardown plus its `process.once('exit')` fallback. No vitest internal (`ctx.task.id`) is
  relied on. Marker keys, `state_root()`, and every production API are unchanged.

- **Default-clock coverage.** `acquireProcessLock`'s `wait` defaults its clock to
  `performance.now()`, and every pre-existing wait test injected `monotonicNow`, leaving
  the default path — the only one the store uses — unexercised in-process. Three cases now
  pin it: real contention → `ProcessLockError('active')`; fake timers excluding
  `performance` → the same; bare `vi.useFakeTimers()` → the deliberately specified
  `RangeError`, with `isProcessLockError() === false` recorded as its concrete cost.
  Store-level real-clock contention was **already** covered by
  `tests/lib/recovery-authority-store-concurrency.test.ts:356` (child process, real timers,
  500–588ms envelope), so this adds the fake-timer mode only.

- **Retained contract.** The clock-advance `RangeError` is deliberate and pinned at
  `tests/lib/process-lock.test.ts:521-525`. Replacing it with accumulated-sleep accounting
  would retire a tested contract and is **deferred to its own design decision**, not taken
  in this lane.

**Expanded final blast radius** (Task 4 adds the last two entries):

- `docs/publication-audit.md`
- `docs/superpowers/plans/2026-08-17-recovery-authority-store-concurrency-containment.md`
- `docs/superpowers/specs/2026-08-17-recovery-authority-store-concurrency-containment-design.md`
- `src/lib/process-lock.ts`
- `src/lib/recovery-authority-store.ts`
- `tests/lib/recovery-authority-store.test.ts`
- `tests/lib/recovery-authority-store-concurrency.test.ts`
- `tests/lib/process-lock.test.ts`
- `tests/setup/bot-errors-vitest-isolation.ts`

Unchanged: configuration, migrations, launchers, recovery-marker consumers, marker-key
construction, state-root selection, public API signatures, and `loadRecoveryMarkers()`
failure semantics.

**Interfaces:**

- Consumes: final Task 1-3 commits.
- Produces: an exact-head local acceptance receipt suitable for PR review.

- [ ] **Step 1: Run direct recovery-marker consumers**

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  npx vitest run --pool=forks --retry=0 \
  tests/lib/model-advisor.test.ts \
  tests/fleet/health-poller.test.ts \
  tests/core/durability-edge.test.ts \
  tests/core/heal.test.ts \
  tests/core/substrate/poller-past-due-alert.test.ts \
  tests/transport/connection-auth-bond-edge.test.ts \
  tests/transport/reconnect.test.ts \
  tests/runtimes/agent/provider-execution-gate.test.ts \
  tests/runtimes/chat/providers/pinecone-alert-recovery.test.ts \
  tests/runtimes/chat/providers/transcription/openai-whisper-extended.test.ts
```

Expected: all listed files pass. A timeout, truncation, killed process, or partial output is inconclusive.

- [ ] **Step 2: Run static and repository gates**

```bash
npm run typecheck:all
npm run guard:lint:src
npm run guard:test-integrity:required
npm run guard:doc-drift
npm run guard:doc-tally
npm run guard:publication:all
npm run guard:publication:staged
```

Expected: every command exits 0; Test Integrity reports no new or drifted blocking finding.

- [ ] **Step 3: Run the full branch gate**

```bash
npm run verify:push:branch
```

Expected: the complete branch gate exits 0. Record its step count and exact HEAD rather than inheriting a prior branch receipt.

- [ ] **Step 4: Audit final blast radius and branch state**

```bash
git status --short --branch
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD
git log --format='%h %s' origin/main..HEAD
git rev-parse HEAD
git rev-list --left-right --count origin/main...HEAD
```

Expected changed production files: `src/lib/process-lock.ts` and `src/lib/recovery-authority-store.ts`. Expected tests: the three named lock/store files. Expected documentation: the approved design, this plan, and mechanically updated publication audit. No config, migration, launcher, caller, marker-key, or state-root file may appear.

- [ ] **Step 5: Stop at the publication boundary**

Do not push or create a PR without a current owner instruction naming that publication. When authorized, use force-with-lease only if the rebase made publication non-fast-forward, verify local/remote/PR head equality, require fresh Node 24, Node 25, CodeQL, and protected-context success on that exact SHA, and never treat an empty or aggregate-only check as GREEN.

---

## Final Acceptance Record

Before claiming implementation complete, record:

- rebased base SHA and final head SHA;
- no overlapping open PR at rebase and publication time;
- process-lock release-race RED then GREEN;
- rewritten marker set/set RED on old code;
- real-read-boundary set/clear RED on old code;
- 10/10 complete concurrency runs with 16/16 writers and the 500 ms ceiling unchanged;
- all three mutation falsifiers RED for the intended reason;
- Test Integrity result;
- direct-consumer test result;
- typecheck, lint, documentation, publication, and full branch-gate receipts;
- exact changed-file blast radius; and
- explicit statement that typed ownership, path migration, and `loadRecoveryMarkers()` failure semantics remain deferred.

The follow-up ownership design must carry a forward pointer to the retained corrupt-marker behavior: a corrupt marker file still makes `clearRecoveryMarker()` a silent no-op in this increment. Do not rediscover or reclassify that known debt as a new containment regression.
