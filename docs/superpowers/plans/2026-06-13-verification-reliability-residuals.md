# Verification Reliability Residuals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize the remaining merge-blocking verification risks: BOT ERRORS collector cooldown flake, file-size warning identity drift, coverage-threshold headroom, and deploy Python fixture hygiene coverage.

**Architecture:** Keep runtime behavior changes narrow and test-first. Collector flake work stays in the Python collector test/clock layer unless a red test proves production logic is wrong. Guardrail hardening stays in TypeScript guard tests and small scripts so verification failures are deterministic and locally reproducible.

**Tech Stack:** Python 3 pytest, TypeScript, Vitest 4, existing `scripts/eslint-fitness-check.ts`, existing repo hygiene guard, existing coverage output at `coverage/coverage-summary.json`.

**Status:** pending; execution should start only after the guardrail residual branch is either landed or deliberately split out of Task 4.

---

## Preconditions And Branching

- Start from current `origin/main` in an isolated worktree; do not modify the shared checkout.
- Do not stack this work on `chore/guardrail-residuals-20260613` unless that branch has already landed. If it has not landed, keep this as a separate branch and rebase after it lands.
- Before push or PR: run Test Integrity on any changed `tests/**/*.test.*` files, then `npm run verify:push:branch`.
- Do not weaken, skip, retry-loop, or quarantine flaky tests. The collector cooldown flake must be stabilized by deterministic time control.

## File Structure

- Modify: `deploy/scripts/tests/test_bot_errors_collector_backoff.py`
  - Owns deterministic fake-clock coverage for dead-host backoff and cooldown windows.
- Modify: `tests/scripts/fitness-file-size-warning-budget.test.ts`
  - Changes count-only file-size warning budget into exact identity + count enforcement.
- Add: `scripts/check-coverage-headroom.ts`
  - Reads coverage JSON summary and fails when enforced thresholds have less than configured safety headroom.
- Modify: `package.json`
  - Adds `guard:coverage-headroom` and wires it into `verify:push:branch` after coverage summary generation only if the task also adds a targeted summary generation step. If no summary generation is added, keep it as a release-only guard.
- Modify: `tests/scripts/pre-push-guard.test.ts`
  - Pins the coverage-headroom guard placement if it is wired into an npm verify chain.
- Modify: `docs/contributing/quality-guardrails-checklist.md`
  - Documents collector-clock proof, file-size identity policy, coverage-headroom policy, and deploy Python fixture hygiene enforcement.
- Modify if `chore/guardrail-residuals-20260613` has not landed: `scripts/repo-hygiene-guard.ts`, `tests/scripts/repo-hygiene-guard.test.ts`, `.github/workflows/quality.yml`, `package.json`, `scripts/safeguard-diagnostics.ts`, `tests/scripts/safeguard-diagnostics.test.ts`, `docs/public-surface.md`
  - Add the branch/base diff hygiene guard from the guardrail residual branch rather than re-inventing a different shape.

## Task 1: Collector Cooldown Fake-Clock Stabilization

**Files:**
- Modify: `deploy/scripts/tests/test_bot_errors_collector_backoff.py`

- [x] **Step 1: Add a deterministic fake clock helper**

Insert this helper below `_load_mod_with_dirs`:

```python
class FakeCollectorClock:
    def __init__(self, start: int):
        self.now = start

    def time(self) -> float:
        return float(self.now)

    def advance(self, seconds: int) -> None:
        self.now += seconds

    def set(self, value: int) -> None:
        self.now = value


@contextlib.contextmanager
def _patched_collector_clock(mod, clock: FakeCollectorClock):
    with patch.object(mod, "time") as mock_time:
        mock_time.time.side_effect = clock.time
        mock_time.strftime = time.strftime
        mock_time.gmtime = time.gmtime
        yield
```

- [x] **Step 2: Convert cooldown tests away from list-backed clocks**

Replace local patterns like:

```python
clock = [1_000_000]
mock_time.time.side_effect = lambda: float(clock[0])
clock[0] += 30
```

with:

```python
clock = FakeCollectorClock(1_000_000)
with _patched_collector_clock(mod, clock):
    _run_once_defaults(mod, [remote])
    clock.advance(30)
```

Apply this conversion to these tests first:

- `test_relay_host_down_emitted_exactly_once`
- `test_backoff_schedule_nextAttemptAt`
- `test_relay_host_recovered_and_reset`
- `test_restart_does_not_reemit_host_down`
- `test_no_per_attempt_meta_alerts_while_down`
- `test_live_host_unaffected_by_dead_host`

- [x] **Step 3: Add a boundary test for the exact cooldown edge**

Append this test after `test_backoff_schedule_nextAttemptAt`:

```python
def test_backoff_window_boundary_is_deterministic(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    remote = "deadhost:/srv/whatsoup/bot-errors"
    clock = FakeCollectorClock(8_000_000)
    ssh_calls: list[int] = []

    def fake_fail(h, script, args, timeout):
        ssh_calls.append(clock.now)
        raise RuntimeError("timeout")

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_fail), \
         patch.object(mod, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod, clock):
        for _ in range(3):
            _run_once_defaults(mod, [remote])
            clock.advance(30)

        state = mod.load_state()
        next_attempt_at = int(state["remotes"][remote]["nextAttemptAt"])
        calls_before_window_checks = len(ssh_calls)

        clock.set(next_attempt_at - 1)
        _run_once_defaults(mod, [remote])
        assert len(ssh_calls) == calls_before_window_checks

        clock.set(next_attempt_at)
        _run_once_defaults(mod, [remote])
        assert len(ssh_calls) > calls_before_window_checks
```

- [x] **Step 4: Verify the new test fails before any production-code change**

Run:

```bash
python3 -m pytest deploy/scripts/tests/test_bot_errors_collector_backoff.py::test_backoff_window_boundary_is_deterministic -q
```

Observed: the boundary test passed immediately after the fake-clock helper was wired, so the production boundary was correct; the new test still pins the previously implicit exact edge.

- [x] **Step 5: Run the collector backoff suite repeatedly**

Run:

```bash
for i in $(seq 1 20); do
  python3 -m pytest deploy/scripts/tests/test_bot_errors_collector_backoff.py -q || exit 1
done
```

Expected: all 20 runs pass. Any failure is a real flake signal; do not replace this with retries in CI.

Observed proof: `python3.12 -m pytest deploy/scripts/tests/test_bot_errors_collector_backoff.py -q` passed once with 13 tests, then the same suite passed in a 20-run loop; host `python3`/`python3.14` lacks pytest, so proofs intentionally use `python3.12`.

- [x] **Step 6: Commit the collector-clock slice**

Run:

```bash
git add deploy/scripts/tests/test_bot_errors_collector_backoff.py
git commit -m "test(bot-errors): make collector cooldown tests deterministic"
```

## Task 2: File-Size Warning Identity Ratchet

**Files:**
- Modify: `tests/scripts/fitness-file-size-warning-budget.test.ts`

- [ ] **Step 1: Replace count-only budget with exact identity set**

Replace the comment and `BUDGET_MAX` block with:

```ts
const EXPECTED_FILE_SIZE_WARNING_FILES = [
  'src/runtimes/agent/runtime.ts',
  'src/transport/connection.ts',
  'tests/core/health.test.ts',
  'tests/fleet/health-poller.test.ts',
  'tests/runtimes/agent/runtime.test.ts',
  'tests/runtimes/agent/session.test.ts',
  'tests/scripts/bot-errors-health-check.test.ts',
].sort();
```

Replace the assertion body with:

```ts
const result = await runEslintFitness(process.cwd());
const fileSizeWarningFiles = result.issues
  .filter((issue) => issue.code === 'max-lines')
  .map((issue) => issue.filePath)
  .sort();

expect(fileSizeWarningFiles).toEqual(EXPECTED_FILE_SIZE_WARNING_FILES);
```

- [ ] **Step 2: Run the file-size budget test**

Run:

```bash
npm test -- --pool=forks --fileParallelism=false tests/scripts/fitness-file-size-warning-budget.test.ts
```

Expected: pass if the current identity set is still exact; fail if a +1/-1 swap or new oversized file exists.

- [ ] **Step 3: Commit the file-size identity slice**

Run:

```bash
git add tests/scripts/fitness-file-size-warning-budget.test.ts
git commit -m "test(guards): pin file-size warning identities"
```

## Task 3: Coverage Threshold Headroom Guard

**Files:**
- Add: `scripts/check-coverage-headroom.ts`
- Modify: `package.json`
- Modify: `tests/scripts/pre-push-guard.test.ts`
- Modify: `docs/contributing/quality-guardrails-checklist.md`

- [ ] **Step 1: Add the headroom checker**

Create `scripts/check-coverage-headroom.ts`:

```ts
#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface CoverageMetric {
  pct: number;
}

interface CoverageSummary {
  total?: {
    lines?: CoverageMetric;
    branches?: CoverageMetric;
    functions?: CoverageMetric;
    statements?: CoverageMetric;
  };
}

const THRESHOLDS = {
  lines: 82,
  branches: 73,
  functions: 79,
} as const;

const MIN_HEADROOM_POINTS = 2;

function readSummary(cwd: string): CoverageSummary {
  const file = path.join(cwd, 'coverage', 'coverage-summary.json');
  return JSON.parse(readFileSync(file, 'utf8')) as CoverageSummary;
}

export function checkCoverageHeadroom(cwd = process.cwd()): string[] {
  const summary = readSummary(cwd);
  const findings: string[] = [];

  for (const [metric, threshold] of Object.entries(THRESHOLDS)) {
    const pct = summary.total?.[metric as keyof typeof THRESHOLDS]?.pct;
    if (typeof pct !== 'number') {
      findings.push(`${metric}: missing coverage percentage`);
      continue;
    }
    const headroom = pct - threshold;
    if (headroom < MIN_HEADROOM_POINTS) {
      findings.push(`${metric}: pct=${pct.toFixed(2)} threshold=${threshold} headroom=${headroom.toFixed(2)} < ${MIN_HEADROOM_POINTS}`);
    }
  }

  return findings;
}

export function run(cwd = process.cwd()): string[] {
  const findings = checkCoverageHeadroom(cwd);
  if (findings.length > 0) {
    console.error('coverage headroom guard failed');
    for (const finding of findings) console.error(finding);
    process.exitCode = 1;
  } else {
    console.log('coverage headroom guard passed');
  }
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 2: Add unit coverage for the checker**

Create `tests/scripts/check-coverage-headroom.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { checkCoverageHeadroom } from '../../scripts/check-coverage-headroom.ts';

const roots: string[] = [];

function makeSummary(total: Record<string, { pct: number }>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'coverage-headroom-'));
  roots.push(root);
  mkdirSync(path.join(root, 'coverage'), { recursive: true });
  writeFileSync(path.join(root, 'coverage', 'coverage-summary.json'), JSON.stringify({ total }, null, 2));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('coverage headroom guard', () => {
  it('passes when every enforced metric has at least two points of headroom', () => {
    const root = makeSummary({
      lines: { pct: 84.1 },
      branches: { pct: 75.1 },
      functions: { pct: 81.1 },
    });

    expect(checkCoverageHeadroom(root)).toEqual([]);
  });

  it('fails when any enforced metric is too close to its threshold', () => {
    const root = makeSummary({
      lines: { pct: 83.9 },
      branches: { pct: 75.1 },
      functions: { pct: 81.1 },
    });

    expect(checkCoverageHeadroom(root)).toEqual([
      'lines: pct=83.90 threshold=82 headroom=1.90 < 2',
    ]);
  });
});
```

- [ ] **Step 3: Add npm script**

Add to `package.json` scripts:

```json
"guard:coverage-headroom": "bash scripts/run-with-pinned-node.sh scripts/check-coverage-headroom.ts"
```

Do not wire this into `verify:push:branch` unless that chain first generates `coverage/coverage-summary.json`. Wire it into `verify:release` immediately after `npm run coverage:check`:

```json
"... && npm run coverage:check && npm run guard:coverage-headroom && npm --prefix console run build"
```

- [ ] **Step 4: Pin release-chain placement**

In `tests/scripts/pre-push-guard.test.ts`, add:

```ts
it('verify:release checks coverage headroom after coverage generation', () => {
  const chain = packageJson.scripts['verify:release'];
  expect(chain, 'verify:release script must exist').toBeDefined();
  expect(chain).toMatch(/\bnpm run coverage:check\b/);
  expect(chain).toMatch(/\bnpm run guard:coverage-headroom\b/);
  expect(chain.indexOf('npm run coverage:check')).toBeLessThan(
    chain.indexOf('npm run guard:coverage-headroom'),
  );
});
```

- [ ] **Step 5: Run coverage and headroom once**

Run:

```bash
npm run coverage:check >/tmp/coverage-headroom.log 2>&1; echo "coverage exit=$?"
npm run guard:coverage-headroom
```

Expected: `coverage exit=0` and `coverage headroom guard passed`. If the guard fails, do not lower `MIN_HEADROOM_POINTS`; either raise coverage or record an explicit decision to accept lower headroom before dependency bumps.

- [ ] **Step 6: Commit the coverage-headroom slice**

Run:

```bash
git add scripts/check-coverage-headroom.ts tests/scripts/check-coverage-headroom.test.ts package.json tests/scripts/pre-push-guard.test.ts docs/contributing/quality-guardrails-checklist.md
git commit -m "chore(guards): add coverage threshold headroom check"
```

## Task 4: Deploy Python Fixture Hygiene Coverage Lock

**Files:**
- Modify if not already landed: `scripts/repo-hygiene-guard.ts`
- Modify if not already landed: `tests/scripts/repo-hygiene-guard.test.ts`
- Modify if not already landed: `.github/workflows/quality.yml`
- Modify if not already landed: `package.json`
- Modify if not already landed: `docs/contributing/quality-guardrails-checklist.md`

- [ ] **Step 1: Check whether branch-diff hygiene already exists**

Run:

```bash
npm run guard:repo:branch-diff -- --help
```

Expected if already landed: command exits `0` and help mentions `--branch-diff`.

- [ ] **Step 2: If missing, land the branch/base diff guard before continuing**

Use the implementation from branch `chore/guardrail-residuals-20260613`, not a new variant. Required behavior:

```ts
scanBranchDiff(cwd, baseRef)
```

must scan:

- final merge-base(base, HEAD)..HEAD added lines with the existing hygiene patterns;
- sensitive artifacts present in the final branch diff;
- secret-shaped branch-history additions and sensitive artifacts even when later removed.

- [ ] **Step 3: Verify deploy Python fixture coverage is pinned**

Ensure `tests/scripts/repo-hygiene-guard.test.ts` contains these tests:

```ts
it('flags private host labels in deploy script Python tests', () => {
  const issues = scanAddedLines([
    { filePath: 'deploy/scripts/tests/test_example.py', line: 4, text: 'HOST = "' + 'nuc' + 'les' + '"' },
  ]);

  expect(issues.map((issue) => issue.code)).toContain('private-host-label');
});

it('flags private host domains and tailnet IPs in deploy script Python tests', () => {
  const issues = scanAddedLines([
    { filePath: 'deploy/scripts/tests/test_example.py', line: 4, text: 'HOST = "' + 'nuc' + 'les.example.invalid"' },
    { filePath: 'deploy/scripts/tests/test_example.py', line: 5, text: `EXPECTED = "${['100', '91', '13', '7'].join('.')}"` },
  ]);

  expect(issues.map((issue) => issue.code)).toEqual(
    expect.arrayContaining(['private-host-label', 'private-tailnet-ip']),
  );
});
```

- [ ] **Step 4: Verify CI/local parity**

Run:

```bash
npm test -- --pool=forks --fileParallelism=false tests/scripts/repo-hygiene-guard.test.ts tests/scripts/pre-push-guard.test.ts tests/scripts/safeguard-diagnostics.test.ts
npm run guard:repo:branch-diff
```

Expected: tests pass and branch-diff guard exits `0` on a clean branch.

- [ ] **Step 5: Commit only if this task made changes**

Run:

```bash
git add scripts/repo-hygiene-guard.ts tests/scripts/repo-hygiene-guard.test.ts .github/workflows/quality.yml package.json docs/contributing/quality-guardrails-checklist.md
git commit -m "chore(guards): enforce deploy fixture hygiene on branch diffs"
```

Skip this commit if the guardrail residual branch has already landed the same behavior.

## Final Verification Ladder

- [ ] Run changed Python tests:

```bash
python3 -m pytest deploy/scripts/tests/test_bot_errors_collector_backoff.py -q
```

- [ ] Run changed TypeScript guard tests:

```bash
npm test -- --pool=forks --fileParallelism=false \
  tests/scripts/fitness-file-size-warning-budget.test.ts \
  tests/scripts/check-coverage-headroom.test.ts \
  tests/scripts/pre-push-guard.test.ts \
  tests/scripts/repo-hygiene-guard.test.ts
```

- [ ] Run Test Integrity:

```bash
"$HOME/.claude/plugins/test-integrity/scripts/test-integrity" scan --ci \
  tests/scripts/fitness-file-size-warning-budget.test.ts \
  tests/scripts/check-coverage-headroom.test.ts \
  tests/scripts/pre-push-guard.test.ts \
  tests/scripts/repo-hygiene-guard.test.ts
```

- [ ] Run full branch verification:

```bash
npm run verify:push:branch
```

- [ ] If coverage-headroom was wired into release verification, run:

```bash
npm run coverage:check
npm run guard:coverage-headroom
```

## Completion Criteria

- Collector cooldown tests pass 20 consecutive local runs without relying on real wall time.
- File-size warning budget fails on file identity swaps, not only warning-count growth.
- Coverage thresholds have an explicit minimum headroom guard before dependency bumps.
- Deploy Python fixture hygiene remains enforced in branch/PR contexts after the branch-diff guard lands.
- Documentation states which gates are authoritative and which remain advisory.
