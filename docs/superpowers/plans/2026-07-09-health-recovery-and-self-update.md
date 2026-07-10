# Health, Recovery, and Self-Update Implementation Plan

**Status:** Pending implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep failed or unknown health/recovery observations visibly unknown and prevent the fleet self-updater from restarting into an uninspected, unpinned, or unvalidated checkout.

**Architecture:** WS-B01 introduces typed database probe results, separates process liveness from readiness, and preserves quarantine whenever recovery proof or breaker-state handling fails. WS-B02 turns the existing updater into an inspect-pull-inspect-install-validate-recheck-restart sequence: every Git observation is mandatory, dependency installs use the pinned toolchain and frozen lockfiles, a bounded validation profile runs before restart, and every post-pull failure emits deterministic recovery guidance while leaving the service running on the old process.

**Tech Stack:** TypeScript 5.9, Node.js 24.15.0, npm 11.12.1, Pino 9, Vitest 4, `node:sqlite`, Git fast-forward updates, Server-Sent Events, launchd/systemd service manager abstraction.

## Global Constraints

- Audited base is `7330bafbe77d7a15febce32eb09b304e8778862f`; fetch `origin` immediately before creating each branch and record the actual base SHA in the PR receipt.
- Publication boundary is local branch and commits only; publishing a branch or Draft PR requires explicit approval.
- Preserve one coherent behavioral idea per PR and keep every PR independently revertible.
- Use the repository-pinned Node.js `24.15.0` and npm `11.12.1` through `scripts/run-with-pinned-npm.sh`; never use ambient Node/npm for evidence or self-update installs.
- WS-B01 starts only after PR #1716 lands or closes because #1716 changes provider recovery, health, runtime, deploy, and hygiene surfaces. Rebase onto its final main result and retain every new provider-health field.
- PR #1715 must land or close before final WS-B01 verification because it changes bot-errors health/deploy behavior consumed by the release drills; it does not authorize editing #1715's branch.
- PR #1714 does not overlap WS-B01/B02 code, but every branch still starts from freshly fetched main after its disposition and reruns the full release gate.
- Before treating any branch as superseded, run `git range-diff` and `git cherry -v`; no branch deletion belongs to this plan.
- Critical database read failure is never represented as zero, empty, or healthy; readiness is HTTP 503 while process liveness remains independently observable.
- Recovery verification or breaker-state failure preserves `outbound_quarantined`; recovery reconciliation continues and emits a bounded failure alert.
- Self-update stops on any SHA/status/diff uncertainty, any non-fast-forward update, any frozen-install failure, any validation failure, or any pre-restart race.
- Use `npm ci`, never `npm install`, in the updater. The updater must invoke it through the repository's pinned runtime script.
- Do not use `git reset --hard`, `git checkout --`, `git restore .`, or `git clean`. Recovery guidance uses inspection and an operator-reviewed `git revert --no-commit <old>..<new>` path.
- Tests use disposable repositories, in-memory SQLite, mock service managers, and synthetic state. They must not restart a real service or mutate a real checkout.
- Do not weaken an assertion that pins unsafe behavior; replace it with the new invariant and retain a negative assertion proving the old outcome is impossible.
- A skipped, masked, timed-out, or environment-missing check is inconclusive and must be reported as a proof gap.

---

## File Structure

### WS-B01 — truthful health and fail-closed recovery

- Create `src/core/health-db-probe.ts`: typed `ok/value/errorType/durationMs` result with bounded SQLite error taxonomy.
- Create `tests/core/health-db-probe.test.ts`: success, slow, SQLite code, and unknown-error tests.
- Modify `src/core/health.ts`: replace fallback values with typed probes; add `GET /live`; make critical unreadability unhealthy/503; serialize null plus probe status.
- Modify `tests/core/health.test.ts`: liveness/readiness separation and zero-is-not-error canaries.
- Modify `src/lib/incident-breaker.ts`: private no-follow state reads/writes and corrupt-state refusal.
- Modify `src/lib/fleet-health-gate.ts`: preserve the existing mode decisions but propagate proof/state errors after emitting bounded failure evidence.
- Modify `src/core/durability.ts`: catch a gate failure without clearing quarantine.
- Modify `tests/lib/incident-breaker.test.ts`, `tests/lib/fleet-health-gate.test.ts`, `tests/lib/fleet-health-gate-wiring.test.ts`, and `tests/core/durability-edge.test.ts`: fail-closed state/gate/wiring canaries.
- Modify `docs/configuration.md` and `docs/runbooks/fleet-bot-hardening-standard.md`: liveness/readiness and quarantine semantics.

### WS-B02 — fail-closed verified self-update

- Modify `src/fleet/routes/update.ts`: mandatory Git inspection, fast-forward pull, exact SHA/diff proof, pinned frozen installs, bounded validation, pre-restart recheck, and recovery guidance.
- Modify `tests/fleet/routes/update-edge.test.ts`: mandatory preflight and post-pull inspection failures.
- Modify `tests/fleet/routes/update-handle.test.ts`: pinned command sequence, validation failure, race, no-change, and restart proof.
- Modify `tests/fleet/routes/update-real-git.test.ts`: disposable real-Git fast-forward and failure preservation.
- Modify `docs/runbook.md`: append the exact event contract and operator-reviewed recovery commands.
- Modify `README.md`: self-update endpoint now validates before restart.

---

### Task 1: Represent Database Health as Typed Evidence (WS-B01)

**Files:**
- Create: `src/core/health-db-probe.ts`
- Create: `tests/core/health-db-probe.test.ts`

**Interfaces:**
- Produces: `HealthDbProbe<T>`, `HealthDbErrorType`, `runHealthDbProbe<T>(read, now?)`, and `probeMetadata(probe)`.
- Error vocabulary: `busy`, `full`, `io`, `corrupt`, `cannot_open`, `schema`, `query_failed`.

- [ ] **Step 1: Write the failing typed-probe tests**

```ts
// tests/core/health-db-probe.test.ts
import { describe, expect, it } from 'vitest';
import {
  probeMetadata,
  runHealthDbProbe,
} from '../../src/core/health-db-probe.ts';

describe('health DB probes', () => {
  it('distinguishes a measured zero from an unavailable measurement', () => {
    const zero = runHealthDbProbe(() => 0, (() => {
      const values = [100, 104];
      return () => values.shift()!;
    })());
    expect(zero).toEqual({ ok: true, value: 0, errorType: null, durationMs: 4 });

    const unavailable = runHealthDbProbe(() => {
      throw Object.assign(new Error('no such table: messages'), { code: 'SQLITE_ERROR' });
    });
    expect(unavailable).toMatchObject({ ok: false, value: null, errorType: 'query_failed' });
    expect(unavailable).not.toHaveProperty('error');
  });

  it.each([
    ['SQLITE_BUSY', 'busy'],
    ['SQLITE_FULL', 'full'],
    ['SQLITE_IOERR_READ', 'io'],
    ['SQLITE_CORRUPT', 'corrupt'],
    ['SQLITE_CANTOPEN', 'cannot_open'],
    ['SQLITE_SCHEMA', 'schema'],
  ] as const)('maps %s to bounded error type %s', (code, expected) => {
    const result = runHealthDbProbe(() => {
      throw Object.assign(new Error('synthetic detail must not escape'), { code });
    });
    expect(result).toMatchObject({ ok: false, value: null, errorType: expected });
    expect(JSON.stringify(result)).not.toContain('synthetic detail');
  });

  it('serializes only status, bounded error type, and duration', () => {
    const result = runHealthDbProbe(() => { throw new Error('DB_CANARY_f9a7'); });
    expect(probeMetadata(result)).toEqual({
      ok: false,
      error_type: 'query_failed',
      duration_ms: expect.any(Number),
    });
    expect(JSON.stringify(probeMetadata(result))).not.toContain('DB_CANARY_f9a7');
  });
});
```

- [ ] **Step 2: Run the test to prove the module is missing**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/core/health-db-probe.test.ts --pool=forks`

Expected: FAIL with missing `src/core/health-db-probe.ts`.

- [ ] **Step 3: Implement the typed probe**

```ts
// src/core/health-db-probe.ts
export type HealthDbErrorType =
  | 'busy'
  | 'full'
  | 'io'
  | 'corrupt'
  | 'cannot_open'
  | 'schema'
  | 'query_failed';

export type HealthDbProbe<T> =
  | { ok: true; value: T; errorType: null; durationMs: number }
  | { ok: false; value: null; errorType: HealthDbErrorType; durationMs: number };

function classify(error: unknown): HealthDbErrorType {
  const code = typeof (error as { code?: unknown })?.code === 'string'
    ? (error as { code: string }).code
    : '';
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return 'busy';
  if (code === 'SQLITE_FULL') return 'full';
  if (code.startsWith('SQLITE_IOERR')) return 'io';
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') return 'corrupt';
  if (code === 'SQLITE_CANTOPEN' || code === 'SQLITE_PERM') return 'cannot_open';
  if (code === 'SQLITE_SCHEMA') return 'schema';
  return 'query_failed';
}

export function runHealthDbProbe<T>(
  read: () => T,
  now: () => number = Date.now,
): HealthDbProbe<T> {
  const startedAt = now();
  try {
    return {
      ok: true,
      value: read(),
      errorType: null,
      durationMs: Math.max(0, now() - startedAt),
    };
  } catch (error) {
    return {
      ok: false,
      value: null,
      errorType: classify(error),
      durationMs: Math.max(0, now() - startedAt),
    };
  }
}

export function probeMetadata<T>(probe: HealthDbProbe<T>): {
  ok: boolean;
  error_type: HealthDbErrorType | null;
  duration_ms: number;
} {
  return {
    ok: probe.ok,
    error_type: probe.errorType,
    duration_ms: probe.durationMs,
  };
}
```

- [ ] **Step 4: Run focused tests and typecheck**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/core/health-db-probe.test.ts --pool=forks`

Expected: PASS.

Run: `bash scripts/run-with-pinned-npm.sh run typecheck:all`

Expected: exit 0.

- [ ] **Step 5: Commit the evidence primitive**

```bash
git add src/core/health-db-probe.ts tests/core/health-db-probe.test.ts
git commit -m "fix(health): add typed database probe evidence"
```

### Task 2: Separate Process Liveness from Database Readiness (WS-B01)

**Files:**
- Modify: `src/core/health.ts:1-149,1001-1285`
- Modify: `tests/core/health.test.ts:184-217,1355-1390,2781-2815`
- Modify: `docs/configuration.md:215-224`

**Interfaces:**
- Consumes: `runHealthDbProbe` and `probeMetadata` from Task 1.
- Produces: unauthenticated loopback `GET /live -> 200 {"status":"alive"}` and readiness `GET /health` with nullable values plus `sqlite.probes`.
- Critical readiness probes: `messages`, `access_list`, `schema_version`, `schema_migrations`, and `pending_polls`.

- [ ] **Step 1: Replace the unsafe fallback test and add liveness proof**

Replace the `safeDbQuery returns fallback` test in `tests/core/health.test.ts` with:

```ts
it('returns 503 and null rather than a healthy zero when messages is unreadable', async () => {
  db.raw.exec('DROP TABLE messages');
  ({ server, port } = await buildTestServer(makeDeps(db)));

  const { status, body } = await httpReq(port, '/health', 'GET');
  expect(status).toBe(503);
  const json = JSON.parse(body);
  expect(json.status).toBe('unhealthy');
  expect(json.sqlite.messages_total).toBeNull();
  expect(json.sqlite.probes.messages).toMatchObject({
    ok: false,
    error_type: 'query_failed',
  });
});

it('keeps process liveness available when a critical table is unreadable', async () => {
  db.raw.exec('DROP TABLE messages');
  ({ server, port } = await buildTestServer(makeDeps(db)));

  const { status, body } = await httpReq(port, '/live', 'GET');
  expect(status).toBe(200);
  expect(JSON.parse(body)).toEqual({ status: 'alive' });
});

it('reports a real empty messages table as measured zero', async () => {
  ({ server, port } = await buildTestServer(makeDeps(db)));
  const { status, body } = await httpReq(port, '/health', 'GET');
  expect(status).toBe(200);
  const json = JSON.parse(body);
  expect(json.sqlite.messages_total).toBe(0);
  expect(json.sqlite.probes.messages).toMatchObject({ ok: true, error_type: null });
});
```

- [ ] **Step 2: Run the tests to prove error currently becomes zero/200 and `/live` is absent**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/core/health.test.ts -t "critical table|measured zero|503 and null" --pool=forks`

Expected: FAIL: `/health` returns 200/zero and `/live` returns 404.

- [ ] **Step 3: Add the liveness route before readiness dispatch**

Insert immediately before the current `req.url !== '/health'` branch:

```ts
if (req.url === '/live' && req.method === 'GET') {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'alive' }));
  return;
}
```

This endpoint intentionally performs no database, provider, WhatsApp, filesystem, or service-manager work.

- [ ] **Step 4: Replace fallback reads with typed probes**

Import `runHealthDbProbe`/`probeMetadata`, delete `safeDbQuery` and `latestSuccessfulOutboundSend`, and wrap these exact reads: `getMessageCount`, `getPendingCount`, latest successful `outbound_sends`, `PRAGMA schema_version`, maximum `schema_migrations.version`, and `pending_polls` count. Each failed probe logs only `{probe,errorType}`; each probe slower than 2,000 ms logs `{probe,elapsed}`. Treat `messages`, `access_list`, `schema_version`, `schema_migrations`, and `pending_polls` as critical. Any critical `ok:false` sets `status='unhealthy'`; a readable migration below `CURRENT_SCHEMA_MIGRATION` remains `degraded`.

Serialize failed numeric/string values as `null`, never fallback zero/empty. Add `sqlite.probes` entries for all six probes using `probeMetadata`; set `pending_polls_readable` from the probe and preserve the existing HTTP mapping `unhealthy -> 503`, otherwise 200.

- [ ] **Step 5: Add per-table negative tests**

Add a static `it.each` over `access_list`, `schema_migrations`, and `pending_polls`. Drop each table, request `/health`, and assert HTTP 503, `status='unhealthy'`, the named probe has `ok:false`, and its public value is `null`. The table identifiers must come only from the literal test table. Also assert an `outbound_sends` failure is surfaced as `ok:false`/null metadata but does not alone make readiness critical.

- [ ] **Step 6: Run health tests and typecheck**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/core/health-db-probe.test.ts tests/core/health.test.ts tests/fleet/health-poller.test.ts tests/fleet/health-poller-branches.test.ts --pool=forks`

Expected: PASS. Existing degraded-but-readable states remain HTTP 200; unreadable critical state is 503; `/live` is 200 in both cases.

Run: `bash scripts/run-with-pinned-npm.sh run typecheck:all`

Expected: exit 0.

- [ ] **Step 7: Document liveness/readiness and commit**

Add to the health configuration section in `docs/configuration.md`:

```markdown
`GET /live` is process liveness only and returns HTTP 200 while the HTTP server can answer. `GET /health` is readiness: critical SQLite probes report `{ok,error_type,duration_ms}`, failed values are `null`, and any unreadable critical table returns `status=unhealthy` with HTTP 503. A measured empty table remains `0`. Degraded-but-readable conditions continue returning HTTP 200 with `status=degraded`.
```

```bash
git add src/core/health.ts tests/core/health.test.ts docs/configuration.md
git commit -m "fix(health): preserve unknown database state"
```

### Task 3: Preserve Quarantine When Recovery Proof or State Fails (WS-B01)

**Files:**
- Modify: `src/lib/incident-breaker.ts:1-58`
- Modify: `src/lib/fleet-health-gate.ts:42-108`
- Modify: `src/core/durability.ts:974-1011`
- Modify: `tests/lib/incident-breaker.test.ts`
- Modify: `tests/lib/fleet-health-gate.test.ts:81-98`
- Modify: `tests/lib/fleet-health-gate-wiring.test.ts:24-53`
- Modify: `tests/core/durability-edge.test.ts:204-254`
- Modify: `docs/runbooks/fleet-bot-hardening-standard.md`

**Interfaces:**
- Produces: `BreakerStateError` with bounded code `unsafe_path`, `invalid_json`, or `invalid_shape`.
- Preserves: `gateQuarantineClear` decision vocabulary for successful evaluations.
- Changes: gate exceptions never call `clearAlertSourceChecked(..., 'outbound_quarantined')`.

- [ ] **Step 1: Replace the legacy-clear wiring assertion with a fail-closed assertion**

Replace the test in `tests/lib/fleet-health-gate-wiring.test.ts`:

```ts
describe('gate failure is fail-closed at the wiring seam', () => {
  it('a throwing proof dependency preserves quarantine', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'gate-wiring-'));
    let cleared = false;
    let failureEvidence = '';
    const deps: GateDeps = {
      now: () => '2026-06-21 05:12:00',
      stateDir,
      recentWindowSeconds: 900,
      attemptWindowSeconds: 1800,
      tripThreshold: 5,
      confirmedOutboundWithinSeconds: () => { throw new Error('VERIFY_CANARY_8ad1'); },
      emitClear: () => { cleared = true; },
      emitEscalation: () => {},
      emitGateFailure: (evidence) => { failureEvidence = evidence; },
    };
    process.env.FLEET_HEALTH_VERIFY_GATE = 'enforce';
    try {
      expect(() => gateQuarantineClear('ml-bot', deps)).toThrow('VERIFY_CANARY_8ad1');
      expect(cleared).toBe(false);
      expect(failureEvidence).toContain('mode=enforce');
    } finally {
      delete process.env.FLEET_HEALTH_VERIFY_GATE;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
```

Add `mkdtempSync`/`rmSync`, `tmpdir`, and `join` to this test's Node imports.

Replace the durability edge expectation:

```ts
it('postConnectRecovery preserves quarantine when the verify gate throws', () => {
  gateQuarantineClear.mockImplementationOnce(() => { throw new Error('gate failed'); });
  expect(() => engine.postConnectRecovery()).not.toThrow();
  expect(clearAlertSource).not.toHaveBeenCalledWith('Loops', 'outbound_quarantined');
});
```

- [ ] **Step 2: Run the two tests to prove the current legacy clear**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/lib/fleet-health-gate-wiring.test.ts tests/core/durability-edge.test.ts -t "preserves quarantine" --pool=forks`

Expected: FAIL because the current catch calls `clearAlertSourceChecked`.

- [ ] **Step 3: Make breaker state private, no-follow, and schema-validated**

Add exported `BreakerStateError(code)` where `code` is exactly `unsafe_path | invalid_json | invalid_shape`. Before every read/write, call `forceEnsurePrivateDirectorySync(dir, 'incident breaker state directory')`. For reads: reject `lstatSync(file).isSymbolicLink()`, open with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, require `fstatSync(fd).isFile()`, close in `finally`, and map filesystem failures to `unsafe_path`. Parse JSON and require exact host/fault class, nullable valid UTC timestamp onset, an array of valid UTC timestamp attempts, and boolean `tripped`/`escalated`; never replace malformed state with defaults. For writes, call `writePrivateJsonMarkerSync`. Preserve the signatures of `stateFile`, `registerOnset`, `recordAttempt`, `attemptsInWindow`, and `clearIncident`.

- [ ] **Step 4: Add corrupt/symlink/mode tests**

Add to `tests/lib/incident-breaker.test.ts`:

```ts
it('fails closed on corrupt JSON instead of resetting the incident', () => {
  writeFileSync(join(dir, 'ml-bot__auth_terminal.json'), '{"onset":', { mode: 0o600 });
  expect(() => loadBreakerState(dir, 'ml-bot', 'auth_terminal'))
    .toThrowError(expect.objectContaining({ code: 'invalid_json' }));
});

it('fails closed on a symlinked state file', () => {
  const outside = join(dir, 'outside.json');
  writeFileSync(outside, JSON.stringify({
    host: 'ml-bot', faultClass: 'auth_terminal', onset: null,
    attempts: [], tripped: false, escalated: false,
  }));
  symlinkSync(outside, join(dir, 'ml-bot__auth_terminal.json'));
  expect(() => loadBreakerState(dir, 'ml-bot', 'auth_terminal'))
    .toThrowError(expect.objectContaining({ code: 'unsafe_path' }));
});

it('writes a 0600 state file beneath a 0700 directory', () => {
  const state = loadBreakerState(dir, 'ml-bot', 'auth_terminal');
  saveBreakerState(dir, state);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, 'ml-bot__auth_terminal.json')).mode & 0o777).toBe(0o600);
});
```

Add `writeFileSync`, `symlinkSync`, and `statSync` to the existing test imports.

- [ ] **Step 5: Remove the legacy clear from the durability catch**

Replace lines 1008-1011 in `src/core/durability.ts`:

```ts
} catch (err) {
  log.error(
    { err },
    'postConnectRecovery: verify gate failed; preserving outbound quarantine',
  );
}
```

Update the `emitGateFailure` text to remove the false fallback claim:

```ts
emitGateFailure: (evidence: string) =>
  emitAlertChecked(
    config.botName,
    'fleet_health_verify_gate_failed',
    `whatsoup@${config.botName} verify gate failed — quarantine preserved`,
    `FLEET_HEALTH_VERIFY_GATE failure: ${evidence}; quarantine_preserved=true`,
    'warning',
  ),
```

In `fleet-health-gate.ts`, catch only to emit bounded evidence. Use `error_type=${err instanceof BreakerStateError ? err.code : 'verification_failed'}` and `mode=${mode}`; do not include `err.message`, SQL, paths, or proof output, then rethrow the original error. Add a test whose thrown message contains `VERIFY_CANARY_8ad1` and assert the emitted evidence does not.

- [ ] **Step 6: Run breaker, gate, and recovery tests**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/lib/private-fs.test.ts tests/lib/incident-breaker.test.ts tests/lib/fleet-health-gate.test.ts tests/lib/fleet-health-gate-wiring.test.ts tests/lib/fleet-health-gate-replay.test.ts tests/core/durability-edge.test.ts tests/core/durability-recovery.test.ts --pool=forks`

Expected: PASS; proof failures and corrupt/symlink state never emit an outbound-quarantine clear, while proven recovery still clears exactly once.

- [ ] **Step 7: Document the recovery invariant and commit**

Add to `docs/runbooks/fleet-bot-hardening-standard.md`:

```markdown
An `outbound_quarantined` alert is cleared only by a completed gate decision that permits clear. A failed proof query, unreadable/corrupt breaker state, unsafe state path, or alert-state write failure emits `fleet_health_verify_gate_failed` and preserves quarantine. Reconciliation continues; operators inspect the bounded failure class and repair the proof/state surface before retrying.
```

Run: `bash scripts/run-with-pinned-npm.sh run typecheck:all`

Expected: exit 0.

```bash
git add src/lib/incident-breaker.ts src/lib/fleet-health-gate.ts src/core/durability.ts tests/lib/incident-breaker.test.ts tests/lib/fleet-health-gate.test.ts tests/lib/fleet-health-gate-wiring.test.ts tests/core/durability-edge.test.ts docs/runbooks/fleet-bot-hardening-standard.md
git commit -m "fix(recovery): preserve quarantine when proof fails"
```

### Task 4: Fail Closed on Git Inspection and Use Frozen Pinned Installs (WS-B02)

**Files:**
- Modify: `src/fleet/routes/update.ts:27-60,174-307`
- Modify: `tests/fleet/routes/update-edge.test.ts:137-186`
- Modify: `tests/fleet/routes/update-handle.test.ts:161-176,988-1135`

**Interfaces:**
- Produces: full-SHA proof (`previousSha`, `targetSha`), exact `changedFiles`, and SSE failure step `inspect`, `pull`, `diff`, `install`, or `console-install`.
- Install command: `bash scripts/run-with-pinned-npm.sh ci` from repo root and `bash scripts/run-with-pinned-npm.sh --prefix console ci` from repo root.

- [ ] **Step 1: Replace the status-failure test with fail-closed expectations**

Replace `continues to pull when the preflight status probe fails` in `tests/fleet/routes/update-edge.test.ts`:

```ts
it('stops before pull when the preflight status probe fails', async () => {
  execFileAsyncSpy
    .mockResolvedValueOnce({ stdout: 'a'.repeat(40) + '\n', stderr: '' })
    .mockRejectedValueOnce(new Error('status unavailable'));
  const { req, res } = makeReqRes();
  await handleUpdate(req, res, makeChecker(), '/repo');
  expect(parseSSE(res.chunks)).toEqual([{
    event: 'error',
    data: { step: 'inspect', reason: 'status_unavailable', message: 'Unable to inspect the working tree; update stopped before pull.' },
  }]);
  expect(execFileAsyncCalls()).toHaveLength(2);
  expect(restartSpy).not.toHaveBeenCalled();
});

it('stops before status or pull when HEAD cannot be proven', async () => {
  execFileAsyncSpy.mockRejectedValueOnce(new Error('rev-parse unavailable'));
  const { req, res } = makeReqRes();
  await handleUpdate(req, res, makeChecker(), '/repo');
  expect(parseSSE(res.chunks)[0]).toMatchObject({
    event: 'error', data: { step: 'inspect', reason: 'head_unavailable' },
  });
  expect(execFileAsyncCalls()).toHaveLength(1);
  expect(restartSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to prove inspection currently fails open**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/fleet/routes/update-edge.test.ts -t "status probe|HEAD cannot" --pool=forks`

Expected: FAIL because status and pre-pull SHA errors currently proceed.

- [ ] **Step 3: Add strict helpers and make every observation mandatory**

Add `requireFullSha` using `/^[a-f0-9]{40}$/`, and `execPinnedNpm(repoRoot,args,timeout)` that invokes `bash scripts/run-with-pinned-npm.sh` with `cwd:repoRoot`, `childEnv()`, and the supplied deadline. Add `updateRecovery(previousSha,targetSha|null)`; when target is known it returns exact `git diff --stat old..new` and `git revert --no-commit old..new` commands, and when unknown both commands are `null` with a note to inspect HEAD first.

Before pull, require `git rev-parse HEAD` (5 s) and `git status --porcelain` (5 s). Invalid/unavailable SHA emits `inspect/head_unavailable`; unavailable status emits `inspect/status_unavailable`; tracked changes emit `inspect/tracked_changes`. Every case finishes and returns before pull. Pull only with `git pull --ff-only origin main` (60 s).

- [ ] **Step 4: Require post-pull SHA and exact diff proof**

After pull, require full target SHA (5 s). Failure emits `inspect/target_head_unavailable`, includes `updateRecovery(prePullSha,null)`, preserves the post-update failure, and returns. Equal old/new SHA emits `pull/done` with `noChanges:true` and returns without install, validation, or restart. Otherwise require `git diff old new --name-only` (10 s); failure emits `diff/diff_unavailable`, known-SHA recovery guidance, preserves failure, and returns.

- [ ] **Step 5: Replace mutable installs with pinned frozen installs**

When root lockfile changed run `execPinnedNpm(repoRoot,['ci'],180_000)`; when console lockfile changed run `execPinnedNpm(repoRoot,['--prefix','console','ci'],180_000)`. Preserve the current running/done/skip events. Every failure includes known-SHA recovery guidance and returns before restart. Remove every executable `npm install` path.

- [ ] **Step 6: Update command-sequence tests**

Update `execFileAsyncCalls()` expected happy-path entries:

```ts
{ cmd: 'git', args: ['rev-parse', 'HEAD'], cwd: '/repo', timeout: 5_000 },
{ cmd: 'git', args: ['status', '--porcelain'], cwd: '/repo', timeout: 5_000 },
{ cmd: 'git', args: ['pull', '--ff-only', 'origin', 'main'], cwd: '/repo', timeout: 60_000 },
{ cmd: 'git', args: ['rev-parse', 'HEAD'], cwd: '/repo', timeout: 5_000 },
{ cmd: 'git', args: ['diff', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '--name-only'], cwd: '/repo', timeout: 10_000 },
{ cmd: 'bash', args: ['scripts/run-with-pinned-npm.sh', 'ci'], cwd: '/repo', timeout: 180_000 },
{ cmd: 'bash', args: ['scripts/run-with-pinned-npm.sh', '--prefix', 'console', 'ci'], cwd: '/repo', timeout: 180_000 },
```

Change all mocked SHAs in update tests from seven-character values to deterministic 40-character values. Add a static source assertion:

```ts
it('contains no mutable npm install invocation', () => {
  const source = readFileSync('src/fleet/routes/update.ts', 'utf8');
  expect(source).not.toMatch(/execFileAsync\(\s*['"]npm['"][\s\S]{0,80}\[['"]install['"]/);
  expect(source).toContain("['ci']");
});
```

- [ ] **Step 7: Run updater preflight/install tests**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/fleet/routes/update-edge.test.ts tests/fleet/routes/update-handle.test.ts -t "inspect|status|HEAD|lockfile|mutable npm" --pool=forks`

Expected: PASS; no status/SHA/diff failure reaches restart and every install goes through the pinned script with `ci`.

- [ ] **Step 8: Commit the inspection/frozen-install slice**

Run: `bash scripts/run-with-pinned-npm.sh run typecheck:all`

Expected: exit 0.

```bash
git add src/fleet/routes/update.ts tests/fleet/routes/update-edge.test.ts tests/fleet/routes/update-handle.test.ts
git commit -m "fix(update): fail closed on inspection and install"
```

### Task 5: Require Bounded Validation and Recheck Before Restart (WS-B02)

**Files:**
- Modify: `src/fleet/routes/update.ts:289-325`
- Modify: `tests/fleet/routes/update-handle.test.ts:225-310,847-985`
- Modify: `tests/fleet/routes/update-real-git.test.ts`
- Modify: `docs/runbook.md`
- Modify: `README.md:245-260`

**Interfaces:**
- Validation commands: source/runtime drift guard (60 s), all TypeScript (120 s), changed-related Vitest (240 s), and console build (180 s when `console/` changed).
- Pre-restart proof: HEAD still equals `targetSha` and tracked status is still empty.
- SSE success boundary: `restart:running` means validation passed and restart was requested; it is not proof the new process came back.

- [ ] **Step 1: Add validation-failure and checkout-race tests**

Add to `tests/fleet/routes/update-handle.test.ts`:

```ts
it('blocks restart when changed-related tests fail', async () => {
  setupHappyPath({
    pullStdout: 'Updating aaaaaaa..bbbbbbb\n',
    diffFiles: 'src/core/health.ts\n',
  });
  execFileAsyncSpy
    .mockResolvedValueOnce({ stdout: '', stderr: '' })
    .mockResolvedValueOnce({ stdout: '', stderr: '' })
    .mockRejectedValueOnce(Object.assign(new Error('tests failed'), { stderr: '1 failed' }));
  const { req, res } = makeReqRes();
  await handleUpdate(req, res, makeChecker(), '/repo');
  expect(parseSSE(res.chunks)).toContainEqual(expect.objectContaining({
    event: 'error', data: expect.objectContaining({ step: 'validate', reason: 'tests_failed' }),
  }));
  expect(serviceManagerRestartSpy).not.toHaveBeenCalled();
});

it('blocks restart when HEAD changes after validation', async () => {
  setupHappyPath({ pullStdout: 'Updating aaaaaaa..bbbbbbb\n', diffFiles: 'src/core/health.ts\n' });
  execFileAsyncSpy
    .mockResolvedValueOnce({ stdout: '', stderr: '' })
    .mockResolvedValueOnce({ stdout: '', stderr: '' })
    .mockResolvedValueOnce({ stdout: '', stderr: '' })
    .mockResolvedValueOnce({ stdout: 'c'.repeat(40) + '\n', stderr: '' });
  const { req, res } = makeReqRes();
  await handleUpdate(req, res, makeChecker(), '/repo');
  expect(parseSSE(res.chunks)).toContainEqual(expect.objectContaining({
    event: 'error', data: expect.objectContaining({ step: 'recheck', reason: 'head_changed' }),
  }));
  expect(serviceManagerRestartSpy).not.toHaveBeenCalled();
});
```

Update `setupHappyPath` so its base/target SHA responses are 40 characters and append successful responses for each validation/recheck command in the exact order defined below.

- [ ] **Step 2: Run the tests to prove restart currently has no validation boundary**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/fleet/routes/update-handle.test.ts -t "changed-related tests|HEAD changes after validation" --pool=forks`

Expected: FAIL because current code requests restart immediately after console build.

- [ ] **Step 3: Add the bounded validation profile**

Emit `validate/running`, then execute these calls in order through `execPinnedNpm`; on any failure emit the exact reason below with known-SHA recovery, call `preservePostUpdateFailure`, finish, and return:

| Arguments | Deadline | Failure reason |
|---|---:|---|
| `['run','guard:source-runtime-drift']` | 60 s | `runtime_drift` |
| `['run','typecheck:all']` | 120 s | `typecheck_failed` |
| `['test','--','--changed',prePullSha,'--pool=forks','--fileParallelism=false','--passWithNoTests']` | 240 s | `tests_failed` |

If any `console/` file changed, retain console build before this profile and increase its deadline to 180 s. Only all-success emits `validate/done`. Bound error text before SSE serialization; never emit raw unbounded stdout/stderr.

- [ ] **Step 4: Recheck and restart with exact version evidence**

Immediately before restart, emit `recheck/running`; require a full `git rev-parse HEAD` equal to `targetSha` and empty `git status --porcelain --untracked-files=no`, each within 5 s. Map failures to `head_unavailable`, `head_changed`, or `working_tree_changed`; attach recovery guidance, preserve any generated tracked changes, finish, and return. On success emit `recheck/done`, then `restart/running` containing `previousSha`, `targetSha`, and recovery guidance before calling `createServiceManager().restart('whatsoup-fleet')`. A rejected restart emits `restart/restart_failed` and finishes. Do not emit `complete`; down/up and running-version proof belong to WS-B03.

- [ ] **Step 5: Extend the disposable real-Git test**

Mock `createServiceManager` before importing the handler so the test can only call a restart spy. Commit `scripts/run-with-pinned-npm.sh` into the disposable seed repository, mark it executable, and make it branch on arguments:

```bash
#!/usr/bin/env bash
set -euo pipefail
case "${*}" in
  "ci"|"run guard:source-runtime-drift"|"run typecheck:all"|test*) exit 0 ;;
  *) printf 'unexpected pinned npm args: %s\n' "${*}" >&2; exit 64 ;;
esac
```

After `handleUpdate`, assert:

```ts
const events = parseSSE(res.chunks);
expect(events).toContainEqual(expect.objectContaining({
  event: 'progress',
  data: expect.objectContaining({
    step: 'restart',
    status: 'running',
    previousSha: prePullSha,
    targetSha: remoteUpdateSha,
  }),
}));
expect(git(repo, ['rev-parse', 'HEAD'])).toBe(remoteUpdateSha);
```

Retain the existing untracked-file preservation assertions and assert the restart spy was called exactly once with `whatsoup-fleet`.

- [ ] **Step 6: Run all self-update tests**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/fleet/routes/update.test.ts tests/fleet/routes/update-edge.test.ts tests/fleet/routes/update-handle.test.ts tests/fleet/routes/update-real-git.test.ts tests/fleet/update-checker.test.ts --pool=forks`

Expected: PASS; no error path reaches restart, no-change performs no install/validation/restart, and success carries exact old/new SHAs.

- [ ] **Step 7: Write the recovery runbook**

````markdown
## Fleet Self-Update Recovery

`POST /api/update` is a fail-closed SSE workflow:

1. prove full current SHA and clean tracked status;
2. pull `origin/main` with `--ff-only`;
3. prove full target SHA and exact changed-file diff;
4. run lockfile-triggered installs with pinned `npm ci`;
5. build changed console code;
6. run source/runtime drift, all-TypeScript, and changed-related tests under fixed deadlines;
7. re-prove target SHA and clean tracked status;
8. request fleet restart.

`restart:running` means the request was issued after validation. It is not proof that the old process exited, the new process started, or `/health.instance.commit` equals `targetSha`.

On a post-pull failure, keep the existing process running and inspect the SSE `recovery` object. From a clean operator shell:

```bash
: "${PREVIOUS_SHA:?set from SSE recovery.previousSha}"
: "${TARGET_SHA:?set from SSE recovery.targetSha}"
git status --short
git diff --stat "$PREVIOUS_SHA".."$TARGET_SHA"
git log --oneline "$PREVIOUS_SHA".."$TARGET_SHA"
```

If an operator decides to roll the checkout back, use an auditable reverse commit rather than destructive reset:

```bash
git revert --no-commit "$PREVIOUS_SHA".."$TARGET_SHA"
bash scripts/run-with-pinned-npm.sh ci
bash scripts/run-with-pinned-npm.sh run verify:release
git commit -m "revert: roll back failed fleet update"
```

Do not restart until the checkout is clean, validation passes, and the intended SHA is recorded. After restart, require `GET /live` 200, `GET /health` non-unhealthy, and `/health.instance.commit == targetSha` before reporting completion.
````

Append this section to `docs/runbook.md`. The shell guards refuse to proceed until both values are copied from the SSE recovery object.

- [ ] **Step 8: Update README and commit**

Replace the self-update endpoint description in `README.md` with:

```markdown
| `POST` | `/api/update` | Fast-forward `origin/main`, use pinned frozen installs, run bounded validation, recheck SHA/status, then request fleet restart. SSE reports exact previous/target SHAs and recovery guidance; restart request is not restart completion proof. |
```

Run: `bash scripts/run-with-pinned-npm.sh run typecheck:all`

Expected: exit 0.

```bash
git add src/fleet/routes/update.ts tests/fleet/routes/update-handle.test.ts tests/fleet/routes/update-real-git.test.ts docs/runbook.md README.md
git commit -m "fix(update): validate before fleet restart"
```

### Task 6: Verify and Package WS-B01 and WS-B02

**Files:**
- Modify only if generated guards require it: `docs/public-surface.md`, `docs/work-index.md`

**Interfaces:**
- Consumes: completed WS-B01 and WS-B02 branches.
- Produces: fresh focused and release receipts, residual-risk notes, and local PR-ready commits; no publication.

- [ ] **Step 1: Reconcile open-PR sequencing**

```bash
git fetch origin
git rev-parse origin/main
git status --short
```

Expected: recorded 40-character main SHA and empty status. Do not finalize WS-B01 until #1716 and #1715 have landed or closed. Rebase from their final main result and retain their health/provider/deploy behavior. #1714 requires a fresh-main rebase/release rerun but no semantic merge into this work.

- [ ] **Step 2: Run the complete focused receipt**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/core/health-db-probe.test.ts \
  tests/core/health.test.ts \
  tests/lib/private-fs.test.ts \
  tests/lib/incident-breaker.test.ts \
  tests/lib/fleet-health-gate.test.ts \
  tests/lib/fleet-health-gate-wiring.test.ts \
  tests/lib/fleet-health-gate-replay.test.ts \
  tests/core/durability-edge.test.ts \
  tests/core/durability-recovery.test.ts \
  tests/fleet/routes/update.test.ts \
  tests/fleet/routes/update-edge.test.ts \
  tests/fleet/routes/update-handle.test.ts \
  tests/fleet/routes/update-real-git.test.ts \
  tests/fleet/update-checker.test.ts \
  --pool=forks
```

Expected: PASS with no skipped health/recovery/updater canary.

- [ ] **Step 3: Run static and integrity checks**

Run: `bash scripts/run-with-pinned-npm.sh run typecheck:all`

Expected: exit 0.

Run: `bash scripts/run-with-pinned-npm.sh run guard:test-integrity`

Expected: exit 0 and no new advisory naming these tests.

Run: `bash scripts/run-with-pinned-npm.sh run guard:fail-closed-gate`

Expected: exit 0; no fallback clear or fail-open updater branch is accepted.

Run: `bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift`

Expected: exit 0. If `/live` is a guarded HTTP surface, add its exact method/path/stability row and rerun.

- [ ] **Step 4: Run the complete release gate on each PR tip**

Run: `bash scripts/run-with-pinned-npm.sh run verify:release`

Expected: exit 0, including root suites/coverage, console build/design/browser suites, repository guards, deploy drills, and guard package. Missing Playwright/browser/external prerequisites are inconclusive until installed and rerun.

- [ ] **Step 5: Record residual risk for WS-B01**

```markdown
Residual risk: deterministic tests prove unreadable critical SQLite state remains unknown/503, process liveness remains separate, and verification/state failure cannot clear quarantine. They do not prove real disk-full/corruption behavior, bot-errors delivery, or a live recovery drill. Stage those faults before deployment claims.
```

- [ ] **Step 6: Record residual risk for WS-B02**

```markdown
Residual risk: disposable Git and mocked service-manager tests prove fail-closed inspection, pinned frozen installs, bounded validation, and restart blocking. The live checkout is updated before validation, so a validation failure leaves the new commit on disk while the old process continues; recovery is operator-reviewed revert/forward-fix, not automatic rollback. A real launchd/systemd restart and running-SHA proof remain staging requirements.
```

- [ ] **Step 7: Confirm clean local handoff without publication**

```bash
git status --short
git log --oneline --decorate origin/main..HEAD
git diff --check origin/main...HEAD
```

Expected: clean worktree, intended commits only, and no whitespace errors. Stop before `git push` or any GitHub mutation.

---

## Self-Review Notes

- Spec coverage: Tasks 1-3 implement WS-B01 and I4; Tasks 4-5 implement WS-B02; Task 6 enforces the program verification and publication boundaries.
- Negative controls: dropped `messages`, `access_list`, `schema_migrations`, and `pending_polls` tables never produce healthy zero; corrupt/symlink breaker state never clears quarantine; SHA/status/diff/validation/race failures never request restart.
- Fail-closed review: every observation required to mutate or restart has an explicit stop path; the old running process remains authoritative on post-pull failure.
- Type consistency: `HealthDbProbe<T>` carries one `errorType` vocabulary into JSON `error_type`; update events use `previousSha` and `targetSha` consistently from inspection through recovery guidance.
- Recovery honesty: the updater does not claim atomic checkout rollback or restart completion. The residual note explicitly states the on-disk post-pull state and staging requirement.
- Prohibited-token scan: run `rg -n '[T]BD|[T]ODO|implement[ ]later|fill[ ]in|similar[ ]to[ ]Task|appropriate[ ]error[ ]handling' docs/superpowers/plans/2026-07-09-health-recovery-and-self-update.md`; expected result is no matches.
- Open-PR sequencing: #1716 and #1715 gate WS-B01 finalization; #1714 requires a fresh-main rebase/release rerun; no plan step edits or publishes those branches.
