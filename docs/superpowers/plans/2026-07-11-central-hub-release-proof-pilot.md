# Central Hub Release-Proof Pilot Implementation Plan

**Status:** Active — Gate 0 tasks implemented locally on this branch; pushes, merges, and pilot-host rollout remain owner-gated

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Gate 0 of `docs/superpowers/specs/2026-07-11-central-hub-release-proof-pilot-design.md` — honest detectors, scheduler runner, hardened monitor units, narrow installer, manifest coverage, dispatcher drill test, and docs — entirely as local repository changes.

**Architecture:** Approach A from the spec: tree provenance and runtime staleness stay separate detectors with separate incident sources; both gain honest failure semantics and scheduler-safe exit contracts; a small shell runner invokes exactly one detector from a versioned host-local bundle under a shared non-blocking lock; a narrow installer manages only the bundle, a mode file, four monitor units, and two timer enablements, with receipts and rollback.

**Tech Stack:** Python 3.12 (detectors, pytest suites), Bash (runner, installer), systemd user units, TypeScript + Vitest (black-box subprocess tests), existing BOT ERRORS outbox/dispatcher pipeline.

> **Post-review supersession (2026-07-12):** The final Gate 0 implementation
> supersedes the illustrative Task 7/8 installer listings below. In particular,
> the final installer binds `--bundle-sha` to a clean source `HEAD`, validates
> staged unit copies before changing `current`, treats versioned bundles as
> immutable, uses exclusive random replacement files, rejects symlinked managed
> roots, stores complete host-bound receipts outside the monitor-writable BOT
> ERRORS state tree, retains failed bundles for forensics, fails closed on
> unknown timer-state probes, and verifies timers are both enabled and active.
> The executable script and its black-box tests are authoritative where an
> older inline listing differs.

## Global Constraints

Copied from the spec — every task implicitly includes these:

- This plan authorizes **local specification, implementation, and test changes only**. Pushes, PRs, merges, pilot-host writes, BOT ERRORS emission on a real host, unit installation on a real host, app deploys/restarts, and qFleet writes remain separately owner-gated (spec header).
- No task may modify `deploy/setup.sh` behavior, qFleet probes, SoupOps, instance runtime, health response shape, database, console, or macOS files (spec §13, §15).
- Scheduled git inspection is offline and uses `git --no-optional-locks`; it never fetches (spec §2).
- Every skipped, unavailable, masked, or unrun check is Inconclusive, not Pass (spec §2).
- Monitor units must not contain `Requires=`, `PartOf=`, `BindsTo=`, `Restart=`, or any command targeting `whatsoup@*`, `whatsoup-fleet`, dispatcher, collector, or q-loop services (spec §6.4).
- Node pinned at `24.15.0`; run Vitest as `npx vitest run --pool=forks <files>`; Python suites via `python3 -m pytest -q`.
- Commit messages: conventional prefix, **no attribution trailers of any kind** (machine-global ban; the repo `commit-msg` guard also enforces hygiene).
- Stage explicit paths only — `git add -A` is banned in this repo lane.
- Execution context: the existing isolated spec worktree, branch `codex/central-hub-release-proof-spec-20260711`. All commits stay local; **do not push**.
- New/changed docs under guarded roots (`docs/runbooks/`, `docs/superpowers/`, `deploy/scripts/README-bot-errors.md` is not guarded but runbooks are) must keep `docs/publication-audit.md` rows and counts consistent — the pre-commit publication guard fails closed otherwise. Existing paths already have rows; only *new* doc files need new rows.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `deploy/scripts/bot-errors-runtime-staleness.py` | modify | B1: typed probe errors, honest exit semantics |
| `deploy/scripts/bot-errors-tree-provenance.py` | modify | B2: `--reporter` scheduler mode, `--no-optional-locks` |
| `deploy/scripts/bot-errors-health-check.py` | modify | `--no-optional-locks` on the scheduled SHA read only |
| `deploy/scripts/bot-errors-release-proof-run.sh` | create | scheduler runner: one component, mode file, shared lock |
| `deploy/scripts/install-bot-errors-release-proof.sh` | create | narrow installer: dry-run/install/set-mode/verify/rollback |
| `deploy/bot-errors-tree-provenance.service` / `.timer` | create | tree monitor unit pair (§6.4 contract) |
| `deploy/bot-errors-runtime-staleness.service` / `.timer` | modify | align existing pair to §6.4 contract + bundle runner |
| `deploy/bot-errors-runtime-manifest.json` | modify | refresh hashes; add runner + installer entries |
| `scripts/check-bot-errors-runtime-manifest.ts` | modify | runner + installer become mandatory manifest paths |
| `tests/scripts/bot-errors-runtime-staleness.test.ts` | extend | probe-failure matrix, exit codes |
| `deploy/scripts/tests/test_bot_errors_tree_provenance.py` | extend | reporter exits, lock flag, index preservation |
| `deploy/scripts/tests/test_bot_errors_f9_git_head_sha.py` | extend | SHA read uses `--no-optional-locks` |
| `tests/scripts/bot-errors-release-proof-run.test.ts` | create | runner black-box tests |
| `tests/scripts/bot-errors-release-proof-installer.test.ts` | create | installer fixture tests (temp home, fake systemctl, ledger) |
| `tests/scripts/bot-errors-service-templates.test.ts` | extend | §6.4 unit contract, single-producer check |
| `tests/scripts/unit-drift.test.ts` | extend | explicit four-unit scope |
| `tests/scripts/bot-errors-dispatcher.test.ts` | extend | two-run alert/clear drill (§12.4) |
| `deploy/scripts/README-bot-errors.md` | modify | release-proof monitor section, single-producer rule |
| `docs/runbooks/release-deployment.md` | modify | in-place-git pilot section (gates, criteria pointer) |

Task order matters: detector script edits (Tasks 1–3) precede the manifest refresh (Task 9) because the manifest pins their hashes.

---

### Task 1: Runtime-staleness probe honesty (B1)

**Files:**
- Modify: `deploy/scripts/bot-errors-runtime-staleness.py`
- Test: `tests/scripts/bot-errors-runtime-staleness.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ProbeError` exception class; `run_once` exit contract `0` valid observations / `1` emit failure / `2` any probe error (probe error dominates); `discover_instances()` raises `ProbeError`; `probe_instance()` raises `ProbeError`; affirmative not-running (`MainPID` output exactly `0`) still returns a skip result. Task 4's runner and the spec's §6.4 `SuccessExitStatus=75` depend on exactly these codes.

- [ ] **Step 1: Extend the fake binaries and `run()` helper in the test file**

In `tests/scripts/bot-errors-runtime-staleness.test.ts`, replace the three fake-binary constants with failure-injectable versions (same defaults, so existing cases keep passing):

Keep every existing output line of the three fakes byte-identical (the `list-units` demo-unit line, the `MainPID` echo, the `etimes` echo, the find `printf`) and add only these failure-injection guards:

- `FAKE_SYSTEMCTL`: first line of the body: `if [ -n "\${FAKE_SYSTEMCTL_RC:-}" ]; then exit "\${FAKE_SYSTEMCTL_RC}"; fi`; and inside the `list-units` branch, before the demo-unit echo: `if [ -n "\${FAKE_DISCOVERY_EMPTY:-}" ]; then exit 0; fi`
- `FAKE_PS`: first line of the body: `if [ -n "\${FAKE_PS_RC:-}" ]; then exit "\${FAKE_PS_RC}"; fi`
- `FAKE_FIND`: first two lines of the body: `if [ -n "\${FAKE_FIND_RC:-}" ]; then exit "\${FAKE_FIND_RC}"; fi` and `if [ -n "\${FAKE_FIND_EMPTY:-}" ]; then exit 0; fi`

(The demo unit-name literal is deliberately not reproduced here — the repo hygiene guard forbids email-shaped strings in docs; copy it from the existing constant.) Then make `run()` set a deterministic repo root so the script never needs its (removed) script-anchor fallback:

```ts
// inside run(args, fakeEnv) env object, before ...fakeEnv spread:
BOT_ERRORS_STALENESS_REPO_ROOT: process.cwd(),
```

`fakeEnv` must spread **after** this key so tests can override it (including to `''` to simulate absence).

- [ ] **Step 2: Write the failing tests**

Append a new `describe('probe honesty (B1)')` block:

```ts
describe('probe honesty (B1)', () => {
  it('discovery command failure → exit 2, no alert, no clear', () => {
    const res = run([], { FAKE_SYSTEMCTL_RC: '1' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('probe error');
    expect(res.stdout).not.toContain('ALERT');
    expect(res.stdout).not.toContain('CLEAR');
  });

  it('successful discovery with zero instances → exit 2, not an empty healthy fleet', () => {
    const res = run([], { FAKE_DISCOVERY_EMPTY: '1' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('probe error');
  });

  it('malformed MainPID output → exit 2, distinct from not-running', () => {
    const res = run(['--instance', 'demo'], { FAKE_MAINPID: 'garbage' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('malformed MainPID');
    expect(res.stdout).not.toContain('ALERT');
    expect(res.stdout).not.toContain('CLEAR');
  });

  it('empty MainPID output → exit 2, distinct from not-running', () => {
    const res = run(['--instance', 'demo'], { FAKE_MAINPID: '' });
    expect(res.status).toBe(2);
  });

  it('ps command failure → exit 2, no emit', () => {
    const res = run(['--instance', 'demo'], { FAKE_PS_RC: '1' });
    expect(res.status).toBe(2);
    expect(res.stdout).not.toContain('ALERT');
    expect(res.stdout).not.toContain('CLEAR');
  });

  it('malformed ps etimes → exit 2, no emit', () => {
    const res = run(['--instance', 'demo'], { FAKE_ETIMES: 'abc' });
    expect(res.status).toBe(2);
  });

  it('find command failure → exit 2, never a false CLEAR', () => {
    const res = run(['--instance', 'demo'], { FAKE_FIND_RC: '1' });
    expect(res.status).toBe(2);
    expect(res.stdout).not.toContain('CLEAR');
  });

  it('empty find output → exit 2, never a false CLEAR', () => {
    const res = run(['--instance', 'demo'], { FAKE_FIND_EMPTY: '1' });
    expect(res.status).toBe(2);
    expect(res.stdout).not.toContain('CLEAR');
  });

  it('unresolvable repo root (no /proc match, no env) → exit 2', () => {
    const res = run(['--instance', 'demo'], {
      FAKE_MAINPID: '4194000',
      BOT_ERRORS_STALENESS_REPO_ROOT: '',
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('repo root');
  });

  it('emit script failure → exit 1', () => {
    const res = run(['--instance', 'demo'], {
      FAKE_SRC_EPOCH: String(Math.floor(Date.now() / 1000) + 3600),
      FAKE_EMIT_RC: '7',
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('emit failed');
  });
});
```

For the last case, teach the stub emitter (`FAKE_EMIT_PY`) to honor `FAKE_EMIT_RC`: add near its top

```python
import os, sys
rc = os.environ.get("FAKE_EMIT_RC", "")
if rc:
    sys.exit(int(rc))
```

**Also update the existing case** `not-running (non-numeric MainPID output) → no emit` (~line 193): under the amended spec, non-numeric MainPID is a **probe error**, not a not-running skip. Rename it to `malformed MainPID is a probe error, not a not-running skip` and assert `status === 2` (it duplicates the new malformed test; keep one and delete the other rather than carrying both).

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `npx vitest run --pool=forks tests/scripts/bot-errors-runtime-staleness.test.ts`
Expected: existing cases pass; every `probe honesty (B1)` case FAILS (current script exits 0 on all probe failures).

- [ ] **Step 4: Implement the fix**

In `deploy/scripts/bot-errors-runtime-staleness.py`:

(a) After the `EMIT_SOURCE = "runtime_stale"` line, add:

```python
class ProbeError(Exception):
    """A probe command failed or returned malformed output; the observation is unknown.

    Unknown observations must never be converted to fresh/stale state (spec B1)."""
```

(b) Replace `discover_instances` body so command failure raises:

```python
def discover_instances() -> list[str]:
    """List whatsoup@ instance names via systemctl.

    Raises ProbeError when the discovery command itself fails; an empty
    result is returned to the caller, which treats it as a probe error too.
    """
    rc, out = _run(
        [
            "systemctl",
            "--user",
            "list-units",
            "whatsoup@*",
            "--all",
            "--no-legend",
            "--plain",
        ]
    )
    if rc != 0:
        raise ProbeError(f"instance discovery failed: systemctl list-units rc={rc}")
    names: list[str] = []
    for line in out.splitlines():
        stripped = line.strip()
        if stripped.startswith("whatsoup@") and ".service" in stripped:
            token = stripped.split()[0]
            name = token.removeprefix("whatsoup@").removesuffix(".service")
            if name:
                names.append(name)
    return names
```

(c) In `probe_instance`, check every probe status. The MainPID block becomes:

```python
    rc, pid_out = _run(
        [
            "systemctl",
            "--user",
            "show",
            f"whatsoup@{instance}",
            "-p",
            "MainPID",
            "--value",
        ]
    )
    if rc != 0:
        raise ProbeError(f"whatsoup@{instance}: MainPID probe failed rc={rc}")
    pid_text = pid_out.strip()
    if pid_text == "0":
        return {
            "running": False,
            "pid": None,
            "boot_epoch": None,
            "repo_root": None,
            "src_file": None,
            "src_epoch": None,
            "stale": False,
            "critical": False,
            "lag_seconds": None,
            "error": "not running (MainPID=0)",
        }
    pid = parse_main_pid(pid_out)
    if pid is None:
        raise ProbeError(
            f"whatsoup@{instance}: malformed MainPID output {pid_text[:40]!r}"
        )
```

The ps block becomes:

```python
    rc, ps_out = _run(["ps", "-o", "etimes=", "-p", str(pid)])
    if rc != 0:
        raise ProbeError(f"whatsoup@{instance}: ps elapsed-time probe failed rc={rc}")
    etimes = parse_etimes(ps_out)
    if etimes is None:
        raise ProbeError(
            f"whatsoup@{instance}: malformed ps etimes output {ps_out.strip()[:40]!r}"
        )
    boot_epoch = compute_boot_epoch(etimes, now_epoch)
```

The repo-root + find block becomes:

```python
    repo_root = _repo_root_from_pid(pid)
    if repo_root is None:
        raise ProbeError(
            f"whatsoup@{instance}: repo root unresolved "
            "(no bootstrap.ts in /proc cmdline and BOT_ERRORS_STALENESS_REPO_ROOT unset)"
        )

    src_dir = os.path.join(repo_root, "src")
    rc, find_out = _run(["find", src_dir, "-name", "*.ts", "-printf", "%T@\t%p\n"])
    if rc != 0:
        raise ProbeError(f"whatsoup@{instance}: source mtime probe failed rc={rc}")
    src_file, src_epoch = parse_find_output(find_out)
    if src_epoch is None:
        raise ProbeError(
            f"whatsoup@{instance}: no parseable src/*.ts mtimes under source tree"
        )
```

(d) In `_repo_root_from_pid`, delete the script-anchor last resort and return `None`:

```python
    env_root = os.environ.get("BOT_ERRORS_STALENESS_REPO_ROOT", "").strip()
    if env_root:
        return env_root

    # No silent last resort: when this script runs from the release-proof
    # bundle the script anchor points at the bundle, not the app checkout,
    # and a wrong root silently yields a false-fresh verdict.
    return None
```

Change its return type annotation stays `str | None`.

(e) Replace `run_once` with the honest exit contract:

```python
def run_once(*, instances: list[str] | None, dry_run: bool) -> int:
    """Run one monitor cycle; return 0 (success), 1 (emit failure), 2 (probe error)."""
    if instances is None:
        try:
            instances = discover_instances()
        except ProbeError as exc:
            print(f"probe error: {exc}", file=sys.stderr)
            return 2
        if not instances:
            print(
                "probe error: no whatsoup@ instances discovered; "
                "refusing to report an empty fleet as healthy",
                file=sys.stderr,
            )
            return 2

    probe_error = False
    emit_failed = False
    for inst in instances:
        try:
            result = probe_instance(inst)
        except ProbeError as exc:
            print(f"probe error: {exc}", file=sys.stderr)
            probe_error = True
            continue

        if not result["running"]:
            print(f"whatsoup@{inst}: not running — skipping (no emit)")
            continue

        if result["stale"]:
            argv = build_emit_argv(
                instance=inst,
                lag_seconds=int(result["lag_seconds"] or 0),
                critical=bool(result["critical"]),
            )
        else:
            argv = build_clear_argv(instance=inst)

        verdict = "STALE" if result["stale"] else "fresh"
        lag_str = f" lag={result['lag_seconds']}s" if result["stale"] else ""
        crit_str = " critical=true" if result.get("critical") else ""
        print(f"whatsoup@{inst}: {verdict}{lag_str}{crit_str}")

        rc = emit_event(argv, dry_run=dry_run)
        if rc != 0:
            print(f"emit failed for whatsoup@{inst} (rc={rc})", file=sys.stderr)
            emit_failed = True

    if probe_error:
        return 2
    if emit_failed:
        return 1
    return 0
```

(f) Update the module docstring exit-code section to add: probe errors never emit alert or clear state; empty discovery is a probe error; only an affirmative `MainPID=0` observation is a skip.

- [ ] **Step 5: Run the suite green**

Run: `npx vitest run --pool=forks tests/scripts/bot-errors-runtime-staleness.test.ts`
Expected: PASS (all cases, existing and new).

- [ ] **Step 6: Commit**

```bash
git add deploy/scripts/bot-errors-runtime-staleness.py tests/scripts/bot-errors-runtime-staleness.test.ts
git commit -m "fix(bot-errors): make runtime-staleness probe failures honest (B1)"
```

---

### Task 2: Tree-provenance reporter mode + `--no-optional-locks` (B2)

**Files:**
- Modify: `deploy/scripts/bot-errors-tree-provenance.py`
- Test: `deploy/scripts/tests/test_bot_errors_tree_provenance.py`

**Interfaces:**
- Consumes: existing `_git`, `gather_tree_provenance`, `run_once`, `main` in the same module.
- Produces: CLI flag `--reporter` (combinable with `--once`/`--print`, rejects `--fetch`); reporter exit contract `0` observed clean/warning/critical, `2` inspection failure, `1` event-write failure; interactive/default exits unchanged (`{"info":0,"warning":1,"critical":2}`, GitError→1). Task 4's runner invokes `--reporter --print` and `--reporter --once`.

- [ ] **Step 1: Write the failing tests**

Append to `deploy/scripts/tests/test_bot_errors_tree_provenance.py` (reuse the file's existing `_make_origin_and_clone` fixture helper and `_mod` module handle):

```python
def test_reporter_print_exits_zero_for_warning_finding(tmp_path: Path, monkeypatch):
    _, work = _make_origin_and_clone(tmp_path, branch="develop")
    (work / "junk.txt").write_text("dirty\n")  # DIRTY finding -> warning severity
    state = tmp_path / "state"
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(state))
    rc = _mod.main(["--reporter", "--print", "--repo", str(work)])
    assert rc == 0
    assert not (state / "outbox").exists()


def test_reporter_once_exits_zero_and_emits_for_clean(tmp_path: Path, monkeypatch):
    _, work = _make_origin_and_clone(tmp_path, branch="develop")
    state = tmp_path / "state"
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(state))
    rc = _mod.main(["--reporter", "--once", "--repo", str(work)])
    assert rc == 0
    events = list((state / "outbox").glob("*.json"))
    assert len(events) == 1


def test_reporter_inspection_failure_exits_two_and_emits_nothing(tmp_path: Path, monkeypatch):
    not_a_repo = tmp_path / "empty"
    not_a_repo.mkdir()
    state = tmp_path / "state"
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(state))
    rc = _mod.main(["--reporter", "--once", "--repo", str(not_a_repo)])
    assert rc == 2
    assert not (state / "outbox").exists()


def test_reporter_event_write_failure_exits_one(tmp_path: Path, monkeypatch):
    _, work = _make_origin_and_clone(tmp_path, branch="develop")
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path / "state"))

    def boom(event):
        raise OSError("disk full")

    monkeypatch.setattr(_mod, "emit_outbox_event", boom)
    rc = _mod.main(["--reporter", "--once", "--repo", str(work)])
    assert rc == 1


def test_reporter_rejects_fetch(tmp_path: Path):
    with pytest.raises(SystemExit) as exc:
        _mod.main(["--reporter", "--fetch"])
    assert exc.value.code == 2


def test_interactive_severity_exits_unchanged(tmp_path: Path, monkeypatch):
    _, work = _make_origin_and_clone(tmp_path, branch="develop")
    (work / "junk.txt").write_text("dirty\n")
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path / "state"))
    rc = _mod.main(["--print", "--repo", str(work)])
    assert rc == 1  # warning severity still maps to exit 1 without --reporter


def test_all_offline_git_commands_use_no_optional_locks(tmp_path: Path, monkeypatch):
    _, work = _make_origin_and_clone(tmp_path, branch="develop")
    calls: list[list[str]] = []
    real_run = _mod.subprocess.run

    def recorder(argv, **kwargs):
        if argv and argv[0] == "git":
            calls.append(list(argv))
        return real_run(argv, **kwargs)

    monkeypatch.setattr(_mod.subprocess, "run", recorder)
    _mod.gather_tree_provenance(work.resolve(), do_fetch=False)
    assert calls, "expected at least one git invocation"
    for argv in calls:
        assert argv[1] == "--no-optional-locks", f"missing flag in: {argv}"


def test_git_index_bytes_and_mtime_unchanged(tmp_path: Path):
    _, work = _make_origin_and_clone(tmp_path, branch="develop")
    index = work / ".git" / "index"
    before_bytes = index.read_bytes()
    before_mtime = index.stat().st_mtime_ns
    _mod.gather_tree_provenance(work.resolve(), do_fetch=False)
    assert index.read_bytes() == before_bytes
    assert index.stat().st_mtime_ns == before_mtime
```

Add `import pytest` at the top of the test file if it is not already imported.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `python3 -m pytest deploy/scripts/tests/test_bot_errors_tree_provenance.py -q`
Expected: existing 19 pass; the new reporter/lock tests FAIL (`--reporter` unknown flag, `--no-optional-locks` absent).

- [ ] **Step 3: Implement**

In `deploy/scripts/bot-errors-tree-provenance.py`:

(a) `_git` gains the global flag (line ~163):

```python
            ["git", "--no-optional-locks", "-C", str(repo), *args],
```

(b) `_parse_args` gains the flag and the rejection:

```python
    parser.add_argument(
        "--reporter", action="store_true",
        help="scheduler mode: exit 0 for any successfully observed finding state "
             "(clean/warning/critical), 2 for inspection failure, 1 for event-write "
             "failure; rejects --fetch",
    )
```

and, after `parser.parse_args(argv)` returns (bind it to `args` first):

```python
    args = parser.parse_args(argv)
    if args.reporter and args.fetch:
        parser.error("--reporter rejects --fetch: scheduled runs must stay offline")
    return args
```

(`parser.error` exits with status 2.)

(c) `run_once` signature becomes `def run_once(*, do_fetch: bool, dry: bool, reporter: bool = False) -> int:` and its body changes in three places:

GitError handler:

```python
    except GitError as exc:
        evidence = f"tree_provenance inspection_error {str(exc)[:200]}"
        if reporter:
            print(evidence, file=sys.stderr)
            return 2
        if not dry:
            emit_outbox_event(build_outbox_event(
                "BOT ERRORS tree-provenance inspection error",
                evidence,
                "warning",
                event_type="alert",
            ))
        print(evidence)
        return 1
```

Emission wrapped for write failure (both modes report it as exit 1 instead of a traceback):

```python
    if not dry:
        alert_source = f"tree_provenance:{branch}" if sev == "critical" else None
        try:
            emit_outbox_event(build_outbox_event(
                summary, evidence, sev,
                event_type=event_type, alert_source=alert_source, snapshot=snap,
            ))
        except OSError as exc:
            print(f"tree_provenance event_write_error {str(exc)[:200]}", file=sys.stderr)
            return 1
```

Return value:

```python
    print(summary)
    print(evidence)
    if reporter:
        return 0
    return {"info": 0, "warning": 1, "critical": 2}[sev]
```

(d) `main` threads the flag: `return run_once(do_fetch=args.fetch, dry=bool(args.dry), reporter=bool(args.reporter))`.

(e) Update the module docstring "Runs standalone" bullet to document `--reporter` and the offline `--no-optional-locks` guarantee.

- [ ] **Step 4: Run the suite green**

Run: `python3 -m pytest deploy/scripts/tests/test_bot_errors_tree_provenance.py -q`
Expected: PASS (existing + 8 new).

- [ ] **Step 5: Commit**

```bash
git add deploy/scripts/bot-errors-tree-provenance.py deploy/scripts/tests/test_bot_errors_tree_provenance.py
git commit -m "feat(bot-errors): tree-provenance --reporter scheduler mode with no-optional-locks (B2)"
```

---

### Task 3: Health-check scheduled SHA read uses `--no-optional-locks`

**Files:**
- Modify: `deploy/scripts/bot-errors-health-check.py:800` (`_run_git_rev_parse`)
- Test: `deploy/scripts/tests/test_bot_errors_f9_git_head_sha.py`

**Interfaces:**
- Consumes: `_run_git_rev_parse(repo_root)` at `deploy/scripts/bot-errors-health-check.py:793-806`.
- Produces: identical `(stdout, stderr, returncode)` contract; only the argv changes. The existing graceful-degradation matrix must stay green.

- [ ] **Step 1: Write the failing test**

Append to `deploy/scripts/tests/test_bot_errors_f9_git_head_sha.py`, reusing that file's existing module-loading helper (it already imports the hyphenated health-check module by path; use the same module handle the other tests use — referred to as `_hc` below):

```python
def test_run_git_rev_parse_uses_no_optional_locks(tmp_path, monkeypatch):
    calls: list[list[str]] = []

    class _Proc:
        stdout = "a" * 40 + "\n"
        stderr = ""
        returncode = 0

    def fake_run(argv, **kwargs):
        calls.append(list(argv))
        return _Proc()

    monkeypatch.setattr(_hc.subprocess, "run", fake_run)
    _hc._run_git_rev_parse(tmp_path)
    assert calls, "expected a git invocation"
    assert calls[0][:2] == ["git", "--no-optional-locks"]
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 -m pytest deploy/scripts/tests/test_bot_errors_f9_git_head_sha.py -q`
Expected: only the new test FAILS (`calls[0][:2] == ["git", "-C"]` today).

- [ ] **Step 3: Implement**

In `_run_git_rev_parse` (`deploy/scripts/bot-errors-health-check.py:800`):

```python
        ["git", "--no-optional-locks", "-C", str(repo_root), "rev-parse", "HEAD"],
```

- [ ] **Step 4: Run the full file green**

Run: `python3 -m pytest deploy/scripts/tests/test_bot_errors_f9_git_head_sha.py -q`
Expected: PASS, including the pre-existing degradation matrix.

- [ ] **Step 5: Commit**

```bash
git add deploy/scripts/bot-errors-health-check.py deploy/scripts/tests/test_bot_errors_f9_git_head_sha.py
git commit -m "fix(bot-errors): scheduled health SHA read never takes optional git locks"
```

---

### Task 4: Release-proof scheduler runner

**Files:**
- Create: `deploy/scripts/bot-errors-release-proof-run.sh` (mode 0755)
- Test: `tests/scripts/bot-errors-release-proof-run.test.ts`

**Interfaces:**
- Consumes: detector CLIs from Tasks 1–2 (`--reporter --print` / `--reporter --once` / `--dry-run --once` / `--once`).
- Produces: `bot-errors-release-proof-run.sh tree|runtime-staleness`; env `BOT_ERRORS_RELEASE_PROOF_ENV` (mode-file path override), `BOT_ERRORS_RELEASE_PROOF_BUNDLE` (bundle `current` override), `BOT_ERRORS_RELEASE_PROOF_APP_REPO` (inspected checkout override), `BOT_ERRORS_STATE_DIR`; exits `0` valid observation, `1` detector event-write failure (propagated), `2` usage/mode/dependency error, `75` lock contention. Tasks 5 (units `ExecStart`) and 8 (installer bundle list) depend on this exact path and contract.

- [ ] **Step 1: Write the failing tests**

Create `tests/scripts/bot-errors-release-proof-run.test.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const RUNNER = join(process.cwd(), 'deploy/scripts/bot-errors-release-proof-run.sh');
const tmpDirs: string[] = [];

interface Fixture {
  home: string;
  bin: string;
  bundle: string;
  ledger: string;
  modeFile: string;
  stateDir: string;
}

function makeFixture(mode: string | null, opts: { flockRc?: number; noDetectors?: boolean } = {}): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'rp-run-'));
  tmpDirs.push(home);
  const bin = join(home, 'bin');
  const bundle = join(home, 'bundle');
  const stateDir = join(home, 'state');
  const ledger = join(home, 'ledger.txt');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(bundle, 'deploy/scripts'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  if (!opts.noDetectors) {
    for (const script of ['bot-errors-tree-provenance.py', 'bot-errors-runtime-staleness.py']) {
      writeFileSync(join(bundle, 'deploy/scripts', script), '# detector placeholder\n');
    }
  }
  // fake python3 records its argv, one line per invocation
  writeFileSync(join(bin, 'python3'), `#!/usr/bin/env bash\necho "python3 $*" >> "${ledger}"\nexit 0\n`);
  chmodSync(join(bin, 'python3'), 0o755);
  // fake flock: rc 0 grants the lock, 1 denies it
  const flockRc = opts.flockRc ?? 0;
  writeFileSync(join(bin, 'flock'), `#!/usr/bin/env bash\nexit ${flockRc}\n`);
  chmodSync(join(bin, 'flock'), 0o755);
  const modeFile = join(home, 'release-proof.env');
  if (mode !== null) writeFileSync(modeFile, `BOT_ERRORS_RELEASE_PROOF_MODE=${mode}\n`);
  return { home, bin, bundle, ledger, modeFile, stateDir };
}

function runRunner(fx: Fixture, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [RUNNER, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.home,
      PATH: `${fx.bin}:${process.env.PATH}`,
      BOT_ERRORS_RELEASE_PROOF_ENV: fx.modeFile,
      BOT_ERRORS_RELEASE_PROOF_BUNDLE: fx.bundle,
      BOT_ERRORS_RELEASE_PROOF_APP_REPO: join(fx.home, 'app-repo'),
      BOT_ERRORS_STATE_DIR: fx.stateDir,
      ...extraEnv,
    },
  });
}

function ledgerLines(fx: Fixture): string[] {
  return existsSync(fx.ledger) ? readFileSync(fx.ledger, 'utf8').trim().split('\n') : [];
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe('bot-errors-release-proof-run.sh', () => {
  it('observe + tree → --reporter --print --repo <app repo>, exit 0', () => {
    const fx = makeFixture('observe');
    const res = runRunner(fx, ['tree']);
    expect(res.status).toBe(0);
    const lines = ledgerLines(fx);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('bot-errors-tree-provenance.py');
    expect(lines[0]).toContain('--reporter --print');
    expect(lines[0]).toContain(`--repo ${join(fx.home, 'app-repo')}`);
    expect(lines[0]).not.toContain('--once');
  });

  it('emit + tree → --reporter --once', () => {
    const fx = makeFixture('emit');
    const res = runRunner(fx, ['tree']);
    expect(res.status).toBe(0);
    expect(ledgerLines(fx)[0]).toContain('--reporter --once');
  });

  it('observe + runtime-staleness → --dry-run --once', () => {
    const fx = makeFixture('observe');
    const res = runRunner(fx, ['runtime-staleness']);
    expect(res.status).toBe(0);
    const line = ledgerLines(fx)[0];
    expect(line).toContain('bot-errors-runtime-staleness.py');
    expect(line).toContain('--dry-run');
    expect(line).toContain('--once');
  });

  it('emit + runtime-staleness → --once without --dry-run', () => {
    const fx = makeFixture('emit');
    const res = runRunner(fx, ['runtime-staleness']);
    expect(res.status).toBe(0);
    const line = ledgerLines(fx)[0];
    expect(line).toContain('--once');
    expect(line).not.toContain('--dry-run');
  });

  it('invalid mode → exit 2 before any detector runs', () => {
    const fx = makeFixture('yolo');
    const res = runRunner(fx, ['tree']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('invalid BOT_ERRORS_RELEASE_PROOF_MODE');
    expect(ledgerLines(fx)).toHaveLength(0);
  });

  it('missing mode file → exit 2', () => {
    const fx = makeFixture(null);
    const res = runRunner(fx, ['tree']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('missing mode file');
  });

  it('unknown component → exit 2', () => {
    const fx = makeFixture('observe');
    expect(runRunner(fx, ['everything']).status).toBe(2);
  });

  it('zero or two components → exit 2', () => {
    const fx = makeFixture('observe');
    expect(runRunner(fx, []).status).toBe(2);
    expect(runRunner(fx, ['tree', 'runtime-staleness']).status).toBe(2);
  });

  it('missing detector in bundle → exit 2', () => {
    const fx = makeFixture('observe', { noDetectors: true });
    const res = runRunner(fx, ['tree']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('missing detector');
  });

  it('lock contention → exit 75 and a recorded skip', () => {
    const fx = makeFixture('observe', { flockRc: 1 });
    const res = runRunner(fx, ['tree']);
    expect(res.status).toBe(75);
    expect(res.stderr).toContain('skipping cycle');
    expect(ledgerLines(fx)).toHaveLength(0);
  });

  it('contains no application service commands (structural)', () => {
    const text = readFileSync(RUNNER, 'utf8');
    for (const forbidden of ['systemctl', 'launchctl', 'whatsoup@', 'whatsoup-fleet']) {
      expect(text).not.toContain(forbidden);
    }
  });
});
```

- [ ] **Step 2: Run to verify all fail**

Run: `npx vitest run --pool=forks tests/scripts/bot-errors-release-proof-run.test.ts`
Expected: FAIL (runner file does not exist).

- [ ] **Step 3: Create the runner**

Create `deploy/scripts/bot-errors-release-proof-run.sh`:

```bash
#!/usr/bin/env bash
# BOT ERRORS release-proof scheduler runner (central pilot).
#
# Invokes exactly ONE monitor component from the versioned bundle under a
# shared non-blocking lock. Contains no detector logic and no service
# commands. Reads the mode file as data — never sources it as shell.
#
# Usage: bot-errors-release-proof-run.sh tree|runtime-staleness
#
# Exit codes:
#   0   valid observation (detector completed a clean/warning/critical or
#       stale/fresh observation)
#   1   detector event-write failure (propagated)
#   2   usage error, invalid/missing mode, missing dependency or detector
#   75  lock contention: cycle skipped, recorded on stderr
set -euo pipefail

usage() {
  echo "usage: bot-errors-release-proof-run.sh tree|runtime-staleness" >&2
}

if [ "$#" -ne 1 ]; then
  usage
  exit 2
fi
COMPONENT="$1"
case "$COMPONENT" in
  tree|runtime-staleness) ;;
  *)
    usage
    exit 2
    ;;
esac

MODE_FILE="${BOT_ERRORS_RELEASE_PROOF_ENV:-$HOME/.config/whatsoup/bot-errors-release-proof.env}"
if [ ! -f "$MODE_FILE" ]; then
  echo "release-proof: missing mode file: $MODE_FILE" >&2
  exit 2
fi
# Read the mode without sourcing the file as shell (spec 6.3).
MODE="$(sed -n 's/^BOT_ERRORS_RELEASE_PROOF_MODE=//p' "$MODE_FILE" | tail -n 1 | tr -d '[:space:]')"
case "$MODE" in
  observe|emit) ;;
  *)
    echo "release-proof: invalid BOT_ERRORS_RELEASE_PROOF_MODE: '$MODE' (expected observe|emit)" >&2
    exit 2
    ;;
esac

command -v flock >/dev/null 2>&1 || { echo "release-proof: missing dependency: flock" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "release-proof: missing dependency: python3" >&2; exit 2; }

BUNDLE_ROOT="${BOT_ERRORS_RELEASE_PROOF_BUNDLE:-$HOME/.local/lib/whatsoup/release-proof/current}"
STATE_DIR="${BOT_ERRORS_STATE_DIR:-$HOME/.local/state/bot-errors}"
LOCK_FILE="$STATE_DIR/release-proof.lock"
APP_REPO="${BOT_ERRORS_RELEASE_PROOF_APP_REPO:-$HOME/LAB/WhatSoup}"
mkdir -p "$STATE_DIR"

case "$COMPONENT" in
  tree)
    DETECTOR="$BUNDLE_ROOT/deploy/scripts/bot-errors-tree-provenance.py"
    if [ "$MODE" = "observe" ]; then
      ARGS=(--reporter --print --repo "$APP_REPO")
    else
      ARGS=(--reporter --once --repo "$APP_REPO")
    fi
    ;;
  runtime-staleness)
    DETECTOR="$BUNDLE_ROOT/deploy/scripts/bot-errors-runtime-staleness.py"
    if [ "$MODE" = "observe" ]; then
      ARGS=(--dry-run --once)
    else
      ARGS=(--once)
    fi
    ;;
esac

if [ ! -f "$DETECTOR" ]; then
  echo "release-proof: missing detector: $DETECTOR" >&2
  exit 2
fi

# Shared non-blocking lock: fd 9 survives the exec below, so the lock is
# held for the detector's whole lifetime and prevents cross-detector overlap.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "release-proof: lock held; skipping cycle ($COMPONENT)" >&2
  exit 75
fi

exec python3 "$DETECTOR" "${ARGS[@]}"
```

Then: `chmod 0755 deploy/scripts/bot-errors-release-proof-run.sh`

- [ ] **Step 4: Run green**

Run: `npx vitest run --pool=forks tests/scripts/bot-errors-release-proof-run.test.ts`
Expected: PASS. Note the fake `flock 9` receives the fd argument; the fake ignores it, which is fine — real-flock behavior is proven at Gate 1 on the pilot host.

- [ ] **Step 5: Commit**

```bash
git add deploy/scripts/bot-errors-release-proof-run.sh tests/scripts/bot-errors-release-proof-run.test.ts
git commit -m "feat(bot-errors): release-proof scheduler runner with shared lock and mode file"
```

---

### Task 5: Monitor systemd units (§6.4 contract)

**Files:**
- Create: `deploy/bot-errors-tree-provenance.service`, `deploy/bot-errors-tree-provenance.timer`
- Modify: `deploy/bot-errors-runtime-staleness.service`, `deploy/bot-errors-runtime-staleness.timer`
- Test: `tests/scripts/bot-errors-service-templates.test.ts`

**Interfaces:**
- Consumes: `bot-errors-release-proof-run.sh` path contract from Task 4.
- Produces: four tracked generic unit files whose installed bytes Task 8's installer copies verbatim and Task 6's drift check compares byte-for-byte.

- [ ] **Step 1: Write the failing tests**

In `tests/scripts/bot-errors-service-templates.test.ts`, add near the existing template arrays:

```ts
const releaseProofServices = [
  'deploy/bot-errors-tree-provenance.service',
  'deploy/bot-errors-runtime-staleness.service',
];
const releaseProofTimers = [
  'deploy/bot-errors-tree-provenance.timer',
  'deploy/bot-errors-runtime-staleness.timer',
];
const releaseProofUnits = [...releaseProofServices, ...releaseProofTimers];
```

Include `releaseProofUnits` in the privacy check: in the test `keep deploy-specific identifiers out of tracked unit files`, change the first loop to iterate `[...unitTemplates, ...releaseProofUnits]`.

Then append a new describe block:

```ts
describe('release-proof monitor units', () => {
  it('services carry the full safety and resource contract', () => {
    for (const file of releaseProofServices) {
      const text = readFileSync(file, 'utf8');
      for (const directive of [
        'Type=oneshot',
        'EnvironmentFile=%h/.config/whatsoup/bot-errors.env',
        'ExecStart=%h/.local/lib/whatsoup/release-proof/current/deploy/scripts/bot-errors-release-proof-run.sh',
        'UMask=0077',
        'TimeoutStartSec=45s',
        'TimeoutStopSec=15s',
        'KillMode=control-group',
        'SuccessExitStatus=75',
        'NoNewPrivileges=yes',
        'PrivateTmp=yes',
        'ProtectSystem=strict',
        'ProtectHome=read-only',
        'ReadWritePaths=%h/.local/state/bot-errors',
        'MemoryMax=128M',
        'TasksMax=32',
        'Nice=10',
        'IOSchedulingClass=idle',
      ]) {
        expect(text, `${file} missing ${directive}`).toContain(directive);
      }
    }
  });

  it('units never bind to, restart, or command application services', () => {
    for (const file of releaseProofUnits) {
      const text = readFileSync(file, 'utf8');
      for (const forbidden of [
        'Requires=',
        'PartOf=',
        'BindsTo=',
        'Restart=',
        'whatsoup@',
        'whatsoup-fleet',
        'bot-errors-dispatcher',
        'bot-errors-collector',
        'bot-errors-q-loop',
      ]) {
        expect(text, `${file} contains forbidden ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('timers bootstrap with distinct offsets and repeat via OnUnitInactiveSec', () => {
    const tree = readFileSync('deploy/bot-errors-tree-provenance.timer', 'utf8');
    const stale = readFileSync('deploy/bot-errors-runtime-staleness.timer', 'utf8');
    for (const text of [tree, stale]) {
      expect(text).toContain('OnUnitInactiveSec=30m');
      expect(text).toContain('RandomizedDelaySec=');
      expect(text).not.toContain('OnUnitActiveSec=');
      expect(text).not.toContain('Persistent=true');
    }
    const offset = (t: string) => t.match(/OnActiveSec=(\S+)/)?.[1];
    expect(offset(tree)).toBeDefined();
    expect(offset(stale)).toBeDefined();
    expect(offset(tree)).not.toBe(offset(stale));
  });

  it('exactly one tracked unit schedules tree provenance (single producer, B3)', () => {
    const unitFiles = globSync('deploy/*.service');
    const producers = unitFiles.filter((f) =>
      readFileSync(f, 'utf8').includes('bot-errors-release-proof-run.sh tree'),
    );
    expect(producers).toEqual(['deploy/bot-errors-tree-provenance.service']);
  });
});
```

Add `import { globSync } from 'node:fs';` alongside the existing fs imports (Node 24 ships `globSync`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --pool=forks tests/scripts/bot-errors-service-templates.test.ts`
Expected: new block FAILS (files missing / old directives present); existing cases still pass.

- [ ] **Step 3: Write the unit files**

`deploy/bot-errors-tree-provenance.service`:

```ini
[Unit]
Description=BOT ERRORS tree-provenance release-proof monitor (offline git inspection)

[Service]
Type=oneshot
EnvironmentFile=%h/.config/whatsoup/bot-errors.env
ExecStart=%h/.local/lib/whatsoup/release-proof/current/deploy/scripts/bot-errors-release-proof-run.sh tree
SyslogIdentifier=bot-errors-tree-provenance
UMask=0077
TimeoutStartSec=45s
TimeoutStopSec=15s
KillMode=control-group
SuccessExitStatus=75
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%h/.local/state/bot-errors
MemoryMax=128M
TasksMax=32
Nice=10
IOSchedulingClass=idle
```

`deploy/bot-errors-tree-provenance.timer`:

```ini
[Unit]
Description=Run BOT ERRORS tree-provenance release-proof monitor every 30 minutes

[Timer]
OnActiveSec=7m
OnUnitInactiveSec=30m
RandomizedDelaySec=120
AccuracySec=1m
Unit=bot-errors-tree-provenance.service

[Install]
WantedBy=timers.target
```

`deploy/bot-errors-runtime-staleness.service` (full replacement):

```ini
[Unit]
Description=BOT ERRORS runtime code-staleness release-proof monitor

[Service]
Type=oneshot
EnvironmentFile=%h/.config/whatsoup/bot-errors.env
ExecStart=%h/.local/lib/whatsoup/release-proof/current/deploy/scripts/bot-errors-release-proof-run.sh runtime-staleness
SyslogIdentifier=bot-errors-runtime-staleness
UMask=0077
TimeoutStartSec=45s
TimeoutStopSec=15s
KillMode=control-group
SuccessExitStatus=75
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%h/.local/state/bot-errors
MemoryMax=128M
TasksMax=32
Nice=10
IOSchedulingClass=idle
```

`deploy/bot-errors-runtime-staleness.timer` (full replacement):

```ini
[Unit]
Description=Run BOT ERRORS runtime code-staleness release-proof monitor every 30 minutes

[Timer]
OnActiveSec=19m
OnUnitInactiveSec=30m
RandomizedDelaySec=120
AccuracySec=1m
Unit=bot-errors-runtime-staleness.service

[Install]
WantedBy=timers.target
```

Design notes the implementer must not "fix": `After=network-online.target` is intentionally removed (both detectors are offline); `OnUnitInactiveSec` (not `OnUnitActiveSec`) prevents self-overlap; `OnActiveSec` bootstrap offsets differ (7m vs 19m) so the two timers never start aligned; `ProtectSystem=strict`/`ProtectHome=read-only`/`ReadWritePaths` are subject to `systemd-analyze --user verify` on the pilot host at Gate 1 per spec §6.4 — if the pilot's systemd rejects one, that is an execution-time finding, not a reason to weaken the tracked contract preemptively. The runtime-staleness `WorkingDirectory=` and direct-checkout `ExecStart` are intentionally gone: monitor code now runs only from the versioned bundle.

- [ ] **Step 4: Run green**

Run: `npx vitest run --pool=forks tests/scripts/bot-errors-service-templates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add deploy/bot-errors-tree-provenance.service deploy/bot-errors-tree-provenance.timer deploy/bot-errors-runtime-staleness.service deploy/bot-errors-runtime-staleness.timer tests/scripts/bot-errors-service-templates.test.ts
git commit -m "feat(bot-errors): hardened release-proof monitor units (tree + runtime-staleness)"
```

---

### Task 6: Unit-drift explicit four-unit scope

**Files:**
- Implementation: `scripts/check-unit-drift.sh`
- Test: `tests/scripts/unit-drift.test.ts`

**Interfaces:**
- Consumes: `scripts/check-unit-drift.sh` CLI (`--repo-root`, `--systemd-dir`, `--bin-dir`, `--unit`, `--wrapper`, `--no-wrappers`). Empty or repeated selectors and mixed wrapper modes are usage errors; `--no-wrappers` is the explicit unit-only applicability decision.
- Produces: proof that the pilot's explicit invocation `--unit <four monitor units>` passes/fails/skips correctly. The runbook (Task 11) documents this exact invocation.

- [ ] **Step 1: Write the failing tests**

Append to `tests/scripts/unit-drift.test.ts`, reusing its `makeFixture()`/`run()` helpers:

```ts
const MONITOR_UNITS = [
  'bot-errors-tree-provenance.service',
  'bot-errors-tree-provenance.timer',
  'bot-errors-runtime-staleness.service',
  'bot-errors-runtime-staleness.timer',
];

function writeMonitorUnits(repo: string, systemd: string): void {
  for (const unit of MONITOR_UNITS) {
    const body = `[Unit]\nDescription=${unit}\n`;
    writeFileSync(join(repo, 'deploy', unit), body);
    writeFileSync(join(systemd, unit), body);
  }
}

describe('release-proof explicit unit scope', () => {
  it('passes when all four monitor units match', () => {
    const { repo, systemd, bin } = makeFixture();
    writeMonitorUnits(repo, systemd);
    const res = run([
      '--repo-root', repo, '--systemd-dir', systemd, '--bin-dir', bin,
      '--unit', ...MONITOR_UNITS,
      '--no-wrappers',
    ]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('all selected systemd units match; wrapper checks not applicable');
    for (const unit of MONITOR_UNITS) expect(res.stdout).toContain(`ok: ${unit}`);
  });

  it('fails when one monitor unit drifts', () => {
    const { repo, systemd, bin } = makeFixture();
    writeMonitorUnits(repo, systemd);
    writeFileSync(join(systemd, 'bot-errors-tree-provenance.timer'), '[Unit]\nDescription=tampered\n');
    const res = run([
      '--repo-root', repo, '--systemd-dir', systemd, '--bin-dir', bin,
      '--unit', ...MONITOR_UNITS,
      '--no-wrappers',
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('drift: bot-errors-tree-provenance.timer');
  });

  it('missing systemd dir is inconclusive (exit 3), not a pass', () => {
    const { repo, bin } = makeFixture();
    const res = run([
      '--repo-root', repo, '--systemd-dir', join(repo, 'nonexistent-systemd'), '--bin-dir', bin,
      '--unit', ...MONITOR_UNITS,
      '--no-wrappers',
    ]);
    expect(res.status).toBe(3);
    expect(res.stdout).toContain('SKIP');
  });
});
```

The same test file first adds parser-boundary cases proving that empty
`--unit` and `--wrapper` selectors exit `2`, mixed `--wrapper` /
`--no-wrappers` modes exit `2`, repeated selection modes exit `2`, a selected
unit that references a registered managed-wrapper alias or implementation path
cannot claim wrapper non-applicability, and an explicit non-empty wrapper
remains a passing safe neighbor. The runner invokes `/bin/bash` so the macOS Bash 3.2
nounset boundary is exercised deterministically.

(`--no-wrappers` positively records that wrapper checks are not applicable to
these four monitor units. The checker proves that no selected checked-in unit
references a registered managed-wrapper alias, repository-relative
implementation path, or implementation basename. Empty, repeated, or mixed
selectors are rejected instead of silently reducing scope.)

- [ ] **Step 2: Run — prove the parser and Bash 3.2 boundary**

Run: `npx vitest run --pool=forks tests/scripts/unit-drift.test.ts`
Expected before the implementation patch: FAIL because `--no-wrappers` is not
yet supported and empty selectors can erase scope. Expected after the smallest
parser and Bash 3.2-safe iteration patch: PASS. These tests pin the pilot's exact
invocation shape; do not adjust them to preserve silent under-selection.

- [ ] **Step 3: Commit**

```bash
git add scripts/check-unit-drift.sh tests/scripts/unit-drift.test.ts
git commit -m "fix(bot-errors): fail closed on unit-drift scope selection"
```

---

### Task 7: Narrow installer — preflight, hashing, dry-run

**Files:**
- Create: `deploy/scripts/install-bot-errors-release-proof.sh` (mode 0755)
- Create: `tests/scripts/bot-errors-release-proof-installer.test.ts`

**Interfaces:**
- Consumes: unit files from Task 5, runner path from Task 4, manifest schema (`files[] = {path, sha256, mustContain}`).
- Produces: CLI `install-bot-errors-release-proof.sh <dry-run|install|set-mode|verify|rollback> --host <name> [--mode observe|emit] [--bundle-sha <40-hex>] [--receipt <dir>]`; env overrides for tests: `RELEASE_PROOF_HOME`, `RELEASE_PROOF_SOURCE_ROOT`, `RELEASE_PROOF_SYSTEMD_DIR`, `RELEASE_PROOF_MANIFEST`. Exit `0` ok, `1` verification failure, `2` usage/preflight/inconclusive. Task 8 fills the mutating operations; this task lands the whole CLI with `install`/`set-mode`/`verify`/`rollback` wired but the file fully working for `dry-run`.

- [ ] **Step 1: Write the failing tests (preflight + dry-run scope)**

Create `tests/scripts/bot-errors-release-proof-installer.test.ts` with the shared fixture used by both installer tasks:

```ts
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const INSTALLER = join(process.cwd(), 'deploy/scripts/install-bot-errors-release-proof.sh');
const SYNTH_HOST = 'rp-test-host';
const SHA = 'a'.repeat(40);
const tmpDirs: string[] = [];

const BUNDLE_FILES = [
  'deploy/scripts/bot-errors-release-proof-run.sh',
  'deploy/scripts/bot-errors-tree-provenance.py',
  'deploy/scripts/bot-errors-runtime-staleness.py',
  'deploy/scripts/bot-errors-emit.py',
  'deploy/scripts/lib/__init__.py',
  'deploy/scripts/lib/bot_errors_redaction.py',
];
const UNIT_FILES = [
  'bot-errors-tree-provenance.service',
  'bot-errors-tree-provenance.timer',
  'bot-errors-runtime-staleness.service',
  'bot-errors-runtime-staleness.timer',
];

interface Fixture {
  home: string;
  source: string;
  systemd: string;
  bin: string;
  ledger: string;
  manifest: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'rp-install-'));
  tmpDirs.push(root);
  const home = join(root, 'home');
  const source = join(root, 'source');
  const systemd = join(root, 'systemd');
  const bin = join(root, 'bin');
  const ledger = join(root, 'ledger.txt');
  mkdirSync(join(source, 'deploy/scripts/lib'), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(systemd, { recursive: true });
  mkdirSync(bin, { recursive: true });

  const entries: Array<{ path: string; sha256: string; mustContain: string[] }> = [];
  for (const rel of BUNDLE_FILES) {
    const body = `# synthetic ${rel}\n`;
    writeFileSync(join(source, rel), body);
    entries.push({ path: rel, sha256: sha256(body), mustContain: [] });
  }
  for (const unit of UNIT_FILES) {
    writeFileSync(join(source, 'deploy', unit), `[Unit]\nDescription=${unit}\n`);
  }
  const manifest = join(source, 'deploy/bot-errors-runtime-manifest.json');
  writeFileSync(manifest, JSON.stringify({
    schemaVersion: 1,
    scope: 'bot-errors-runtime-scripts',
    files: entries,
  }, null, 2));

  // fake systemctl / systemd-analyze / hostname write a command ledger;
  // `show -p FragmentPath --value <unit>` answers with the fixture systemd
  // path so the installer's loaded-fragment verification can pass.
  const fakeSystemctl = [
    '#!/usr/bin/env bash',
    `echo "systemctl $*" >> "${ledger}"`,
    'if [ "$2" = "is-enabled" ]; then echo disabled; fi',
    'if [ "$2" = "is-active" ]; then echo inactive; fi',
    'if [ "$2" = "show" ]; then',
    '  for a in "$@"; do :; done   # a = last arg = unit name',
    '  case "$*" in',
    `    *FragmentPath*) echo "${systemd}/$a" ;;`,
    '    *) echo "" ;;',
    '  esac',
    'fi',
    'exit 0',
  ].join('\n') + '\n';
  writeFileSync(join(bin, 'systemctl'), fakeSystemctl);
  writeFileSync(join(bin, 'systemd-analyze'), `#!/usr/bin/env bash\necho "systemd-analyze $*" >> "${ledger}"\nexit 0\n`);
  writeFileSync(join(bin, 'hostname'), `#!/usr/bin/env bash\necho "${SYNTH_HOST}"\n`);
  for (const f of ['systemctl', 'systemd-analyze', 'hostname']) chmodSync(join(bin, f), 0o755);

  return { home, source, systemd, bin, ledger, manifest };
}

function runInstaller(fx: Fixture, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [INSTALLER, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.home,
      PATH: `${fx.bin}:${process.env.PATH}`,
      RELEASE_PROOF_HOME: fx.home,
      RELEASE_PROOF_SOURCE_ROOT: fx.source,
      RELEASE_PROOF_SYSTEMD_DIR: fx.systemd,
      RELEASE_PROOF_MANIFEST: fx.manifest,
      ...extraEnv,
    },
  });
}

/** Recursive dir snapshot: sorted "relpath sha256(content)" lines; dirs as "relpath/ dir". */
function snapshotDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) {
        out.push(`${relative(dir, p)}/ dir`);
        walk(p);
      } else if (st.isSymbolicLink()) {
        out.push(`${relative(dir, p)} link`);
      } else {
        out.push(`${relative(dir, p)} ${sha256(readFileSync(p, 'utf8'))}`);
      }
    }
  };
  walk(dir);
  return out;
}

function ledgerLines(fx: Fixture): string[] {
  return existsSync(fx.ledger) ? readFileSync(fx.ledger, 'utf8').trim().split('\n').filter(Boolean) : [];
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe('installer preflight and dry-run', () => {
  it('dry-run prints the plan and produces zero filesystem and command delta', () => {
    const fx = makeFixture();
    const before = { home: snapshotDir(fx.home), systemd: snapshotDir(fx.systemd) };
    const res = runInstaller(fx, ['dry-run', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', SHA]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('DRY_RUN_OK');
    expect(snapshotDir(fx.home)).toEqual(before.home);
    expect(snapshotDir(fx.systemd)).toEqual(before.systemd);
    expect(ledgerLines(fx)).toHaveLength(0);
  });

  it('host gate fails closed with fingerprints only', () => {
    const fx = makeFixture();
    const res = runInstaller(fx, ['dry-run', '--host', 'wrong-host', '--mode', 'observe', '--bundle-sha', SHA]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('host gate failed');
    expect(res.stderr).not.toContain('wrong-host');
    expect(res.stderr).not.toContain(SYNTH_HOST);
  });

  it('host canonicalization: case and trailing dot are ignored', () => {
    const fx = makeFixture();
    const res = runInstaller(fx, ['dry-run', '--host', `${SYNTH_HOST.toUpperCase()}.`, '--mode', 'observe', '--bundle-sha', SHA]);
    expect(res.status).toBe(0);
  });

  it('source hash mismatch against the manifest aborts before any write', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.source, 'deploy/scripts/bot-errors-emit.py'), '# tampered\n');
    const before = snapshotDir(fx.home);
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', SHA]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('hash mismatch');
    expect(snapshotDir(fx.home)).toEqual(before);
    expect(ledgerLines(fx)).toHaveLength(0);
  });

  it('symlinked source file is rejected', () => {
    const fx = makeFixture();
    const target = join(fx.source, 'deploy/scripts/bot-errors-emit.py');
    rmSync(target);
    symlinkSync('/etc/hostname', target);
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', SHA]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('symlink');
  });

  it('invalid bundle sha is rejected', () => {
    const fx = makeFixture();
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', 'nothex']);
    expect(res.status).toBe(2);
  });

  it('install --mode emit is rejected: emit is reached only via set-mode', () => {
    const fx = makeFixture();
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'emit', '--bundle-sha', SHA]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('install only supports --mode observe');
  });

  it('installer never references the daily-health tree integration (B3, structural)', () => {
    const text = readFileSync(INSTALLER, 'utf8');
    expect(text).not.toContain('expectTreeProvenance');
    expect(text).not.toContain('health-profile');
    expect(text).not.toContain('bot-errors-health-check');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --pool=forks tests/scripts/bot-errors-release-proof-installer.test.ts`
Expected: FAIL (installer does not exist).

- [ ] **Step 3: Create the installer (complete file; Task 8's operations included)**

Create `deploy/scripts/install-bot-errors-release-proof.sh`:

```bash
#!/usr/bin/env bash
# Narrow installer for the BOT ERRORS release-proof monitor (central pilot).
#
# Manages ONLY:
#   - versioned monitor bundles under   <home>/.local/lib/whatsoup/release-proof/<40-hex>/
#   - the `current` bundle symlink
#   - the mode file                     <home>/.config/whatsoup/bot-errors-release-proof.env
#   - the four monitor unit files       bot-errors-tree-provenance.{service,timer}
#                                       bot-errors-runtime-staleness.{service,timer}
#   - enablement of the two monitor timers
#
# It never mutates any application, fleet, dispatcher, collector, or q-loop
# unit and never writes into the application checkout or instance state.
# The scheduled tree producer it installs is the ONLY tree producer; this
# installer deliberately has no knowledge of the daily-health integration.
#
# Operations:
#   dry-run  --host <name> --mode observe|emit --bundle-sha <40-hex>
#   install  --host <name> --mode observe      --bundle-sha <40-hex>
#   set-mode --host <name> --mode observe|emit
#   verify   --host <name> --bundle-sha <40-hex>
#   rollback --host <name> --receipt <dir>
#
# Exit codes: 0 ok; 1 verification failure; 2 usage/preflight error or
# inconclusive (a check that could not run).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="${RELEASE_PROOF_SOURCE_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
HOME_DIR="${RELEASE_PROOF_HOME:-$HOME}"
SYSTEMD_DIR="${RELEASE_PROOF_SYSTEMD_DIR:-${XDG_CONFIG_HOME:-$HOME_DIR/.config}/systemd/user}"
MANIFEST="${RELEASE_PROOF_MANIFEST:-$SOURCE_ROOT/deploy/bot-errors-runtime-manifest.json}"

BUNDLE_PARENT="$HOME_DIR/.local/lib/whatsoup/release-proof"
MODE_FILE="$HOME_DIR/.config/whatsoup/bot-errors-release-proof.env"
STATE_DIR="${BOT_ERRORS_STATE_DIR:-$HOME_DIR/.local/state/bot-errors}"
RECEIPT_PARENT="$STATE_DIR/release-proof-receipts"
INSTALL_LOCK="$STATE_DIR/release-proof-install.lock"

BUNDLE_FILES=(
  "deploy/scripts/bot-errors-release-proof-run.sh"
  "deploy/scripts/bot-errors-tree-provenance.py"
  "deploy/scripts/bot-errors-runtime-staleness.py"
  "deploy/scripts/bot-errors-emit.py"
  "deploy/scripts/lib/__init__.py"
  "deploy/scripts/lib/bot_errors_redaction.py"
)
UNIT_FILES=(
  "bot-errors-tree-provenance.service"
  "bot-errors-tree-provenance.timer"
  "bot-errors-runtime-staleness.service"
  "bot-errors-runtime-staleness.timer"
)
TIMER_UNITS=(
  "bot-errors-tree-provenance.timer"
  "bot-errors-runtime-staleness.timer"
)

fail() { echo "release-proof-install: $*" >&2; exit 2; }

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

sha256_of() {
  python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"
}

manifest_sha_of() {
  python3 -c '
import json, sys
manifest = json.load(open(sys.argv[1]))
for entry in manifest.get("files", []):
    if entry.get("path") == sys.argv[2]:
        print(entry.get("sha256", ""))
        break
' "$MANIFEST" "$1"
}

canon_host() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/\.*$//'; }

fingerprint() {
  python3 -c 'import hashlib,sys;print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:12])' "$1"
}

require_host() {
  [ -n "$EXPECT_HOST" ] || fail "--host is required"
  local expect actual
  expect="$(canon_host "$EXPECT_HOST")"
  actual="$(canon_host "$(hostname)")"
  if [ "$expect" != "$actual" ]; then
    echo "release-proof-install: host gate failed (expected fp=$(fingerprint "$expect") actual fp=$(fingerprint "$actual"))" >&2
    exit 2
  fi
  echo "host gate ok (fp=$(fingerprint "$actual"))"
}

require_bundle_sha() {
  printf '%s' "$BUNDLE_SHA" | grep -Eq '^[0-9a-f]{40}$' || fail "--bundle-sha must be 40 lowercase hex chars"
}

require_no_symlink() {
  [ -L "$1" ] && fail "refusing symlink in managed path: $1"
  return 0
}

verify_sources() {
  [ -f "$MANIFEST" ] || fail "manifest not found: $MANIFEST"
  local rel src want got
  for rel in "${BUNDLE_FILES[@]}"; do
    src="$SOURCE_ROOT/$rel"
    [ -e "$src" ] || fail "missing source file: $rel"
    require_no_symlink "$src"
    want="$(manifest_sha_of "$rel")"
    [ -n "$want" ] || fail "manifest has no entry for $rel"
    got="$(sha256_of "$src")"
    [ "$want" = "$got" ] || fail "hash mismatch for $rel (manifest=$want actual=$got)"
  done
  for rel in "${UNIT_FILES[@]}"; do
    src="$SOURCE_ROOT/deploy/$rel"
    [ -e "$src" ] || fail "missing unit source: deploy/$rel"
    require_no_symlink "$src"
  done
  echo "sources verified against manifest ($(basename "$MANIFEST"))"
}

require_lock() {
  mkdir -p "$STATE_DIR"
  exec 8>"$INSTALL_LOCK"
  if command -v flock >/dev/null 2>&1; then
    flock -n 8 || fail "installer lock held: $INSTALL_LOCK"
  else
    fail "missing dependency: flock"
  fi
}

sctl() { systemctl --user "$@"; }

validate_units_staged() {
  local stage="$1" unit
  command -v systemd-analyze >/dev/null 2>&1 || fail "missing dependency: systemd-analyze (unit validation is mandatory)"
  bash -n "$stage/bundle/deploy/scripts/bot-errors-release-proof-run.sh" || fail "runner failed bash -n"
  for unit in "${UNIT_FILES[@]}"; do
    systemd-analyze --user verify "$stage/units/$unit" || fail "systemd verify rejected $unit"
  done
}

render_stage() {
  local stage="$1" rel dest
  for rel in "${BUNDLE_FILES[@]}"; do
    dest="$stage/bundle/$rel"
    mkdir -p "$(dirname "$dest")"
    cp "$SOURCE_ROOT/$rel" "$dest"
    [ "$(sha256_of "$dest")" = "$(manifest_sha_of "$rel")" ] || fail "staged copy hash drifted: $rel"
  done
  chmod 0755 "$stage/bundle/deploy/scripts/bot-errors-release-proof-run.sh"
  mkdir -p "$stage/units"
  for rel in "${UNIT_FILES[@]}"; do
    cp "$SOURCE_ROOT/deploy/$rel" "$stage/units/$rel"
  done
}

atomic_symlink() {
  python3 -c '
import os, sys
target, link = sys.argv[1], sys.argv[2]
tmp = link + ".tmp-swap"
if os.path.islink(tmp) or os.path.exists(tmp):
    os.unlink(tmp)
os.symlink(target, tmp)
os.replace(tmp, link)
' "$1" "$2"
}

write_mode_file() {
  mkdir -p "$(dirname "$MODE_FILE")"
  local tmp="$MODE_FILE.tmp"
  printf 'BOT_ERRORS_RELEASE_PROOF_MODE=%s\n' "$1" > "$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$MODE_FILE"
}

take_backup() {
  RECEIPT="$RECEIPT_PARENT/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$RECEIPT/units-prior"
  local unit installed
  for unit in "${UNIT_FILES[@]}"; do
    installed="$SYSTEMD_DIR/$unit"
    if [ -f "$installed" ]; then
      require_no_symlink "$installed"
      cp "$installed" "$RECEIPT/units-prior/$unit"
    else
      : > "$RECEIPT/units-prior/$unit.was-absent"
    fi
  done
  if [ -L "$BUNDLE_PARENT/current" ]; then
    readlink "$BUNDLE_PARENT/current" > "$RECEIPT/current-prior.txt"
  else
    : > "$RECEIPT/current-prior.was-absent"
  fi
  if [ -f "$MODE_FILE" ]; then
    cp "$MODE_FILE" "$RECEIPT/mode-prior.env"
  else
    : > "$RECEIPT/mode-prior.was-absent"
  fi
  for unit in "${TIMER_UNITS[@]}"; do
    printf '%s enabled=%s active=%s\n' "$unit" \
      "$(sctl is-enabled "$unit" 2>/dev/null || true)" \
      "$(sctl is-active "$unit" 2>/dev/null || true)" >> "$RECEIPT/timer-state-prior.txt"
  done
  echo "backup receipt: $RECEIPT"
}

do_rollback_from() {
  local receipt="$1" unit prior
  [ -d "$receipt" ] || fail "receipt not found: $receipt"
  for unit in "${TIMER_UNITS[@]}"; do
    sctl disable --now "$unit" || true
  done
  for unit in "${UNIT_FILES[@]}"; do
    prior="$receipt/units-prior/$unit"
    if [ -f "$prior" ]; then
      cp "$prior" "$SYSTEMD_DIR/.$unit.tmp"
      mv -f "$SYSTEMD_DIR/.$unit.tmp" "$SYSTEMD_DIR/$unit"
    elif [ -f "$receipt/units-prior/$unit.was-absent" ]; then
      rm -f "$SYSTEMD_DIR/$unit"
    fi
  done
  if [ -f "$receipt/current-prior.txt" ]; then
    atomic_symlink "$(cat "$receipt/current-prior.txt")" "$BUNDLE_PARENT/current"
  elif [ -f "$receipt/current-prior.was-absent" ]; then
    rm -f "$BUNDLE_PARENT/current"
  fi
  if [ -f "$receipt/mode-prior.env" ]; then
    cp "$receipt/mode-prior.env" "$MODE_FILE.tmp"
    mv -f "$MODE_FILE.tmp" "$MODE_FILE"
  elif [ -f "$receipt/mode-prior.was-absent" ]; then
    rm -f "$MODE_FILE"
  fi
  sctl daemon-reload
  if [ -f "$receipt/timer-state-prior.txt" ]; then
    while read -r unit rest; do
      case "$rest" in
        *enabled=enabled*) sctl enable "$unit" || true ;;
      esac
      case "$rest" in
        *active=active*) sctl start "$unit" || true ;;
      esac
    done < "$receipt/timer-state-prior.txt"
  fi
  for unit in "${UNIT_FILES[@]}"; do
    prior="$receipt/units-prior/$unit"
    if [ -f "$prior" ] && ! cmp -s "$prior" "$SYSTEMD_DIR/$unit"; then
      echo "release-proof-install: rollback byte verification failed for $unit" >&2
      exit 1
    fi
  done
  echo "ROLLBACK_OK receipt=$receipt"
}

do_verify() {
  local unit failures=0
  for unit in "${UNIT_FILES[@]}"; do
    if ! cmp -s "$SOURCE_ROOT/deploy/$unit" "$SYSTEMD_DIR/$unit"; then
      echo "verify: unit drift or missing: $unit" >&2
      failures=$((failures + 1))
    fi
  done
  local link="$BUNDLE_PARENT/current"
  if [ ! -L "$link" ] || [ "$(readlink "$link")" != "$BUNDLE_PARENT/$BUNDLE_SHA" ]; then
    echo "verify: current symlink does not point at $BUNDLE_SHA" >&2
    failures=$((failures + 1))
  fi
  local rel
  for rel in "${BUNDLE_FILES[@]}"; do
    if [ "$(sha256_of "$BUNDLE_PARENT/$BUNDLE_SHA/$rel")" != "$(manifest_sha_of "$rel")" ]; then
      echo "verify: bundle hash drift: $rel" >&2
      failures=$((failures + 1))
    fi
  done
  if [ ! -f "$MODE_FILE" ]; then
    echo "verify: mode file missing" >&2
    failures=$((failures + 1))
  fi
  local frag dropins
  for unit in "${UNIT_FILES[@]}"; do
    frag="$(sctl show -p FragmentPath --value "$unit" 2>/dev/null || true)"
    dropins="$(sctl show -p DropInPaths --value "$unit" 2>/dev/null || true)"
    if [ "$frag" != "$SYSTEMD_DIR/$unit" ]; then
      echo "verify: loaded fragment for $unit is '$frag', expected $SYSTEMD_DIR/$unit" >&2
      failures=$((failures + 1))
    fi
    if [ -n "$dropins" ]; then
      echo "verify: unexpected drop-ins for $unit: $dropins" >&2
      failures=$((failures + 1))
    fi
  done
  [ "$failures" -eq 0 ] || exit 1
  echo "VERIFY_OK"
}

do_install() {
  # Verification precedes the lock (spec 6.5 items 2 vs 5): a failed source
  # check must leave zero filesystem delta, and the lock file is a write.
  verify_sources
  require_lock
  mkdir -p "$BUNDLE_PARENT"
  local stage
  stage="$(mktemp -d "$BUNDLE_PARENT/.stage-XXXXXX")"
  render_stage "$stage"
  validate_units_staged "$stage"
  take_backup
  trap 'echo "release-proof-install: failure after backup — rolling back" >&2; do_rollback_from "$RECEIPT"; exit 1' ERR

  rm -rf "$BUNDLE_PARENT/$BUNDLE_SHA"
  mv "$stage/bundle" "$BUNDLE_PARENT/$BUNDLE_SHA"
  atomic_symlink "$BUNDLE_PARENT/$BUNDLE_SHA" "$BUNDLE_PARENT/current"

  mkdir -p "$SYSTEMD_DIR"
  local unit
  for unit in "${UNIT_FILES[@]}"; do
    [ -e "$SYSTEMD_DIR/$unit" ] && require_no_symlink "$SYSTEMD_DIR/$unit"
    cp "$stage/units/$unit" "$SYSTEMD_DIR/.$unit.tmp"
    mv -f "$SYSTEMD_DIR/.$unit.tmp" "$SYSTEMD_DIR/$unit"
  done
  rm -rf "$stage"

  write_mode_file "$MODE"
  sctl daemon-reload
  for unit in "${TIMER_UNITS[@]}"; do
    sctl enable --now "$unit"
  done
  do_verify
  trap - ERR
  {
    printf 'operation=install\nbundle_sha=%s\nmode=%s\nreceipt=%s\n' "$BUNDLE_SHA" "$MODE" "$RECEIPT"
  } > "$RECEIPT/receipt.txt"
  echo "RECEIPT=$RECEIPT"
  echo "ROLLBACK: bash deploy/scripts/install-bot-errors-release-proof.sh rollback --host <host> --receipt $RECEIPT"
  echo "INSTALL_OK"
}

do_set_mode() {
  require_lock
  take_backup
  write_mode_file "$MODE"
  printf 'operation=set-mode\nmode=%s\nreceipt=%s\n' "$MODE" "$RECEIPT" > "$RECEIPT/receipt.txt"
  echo "RECEIPT=$RECEIPT"
  echo "SET_MODE_OK mode=$MODE"
}

do_dry_run() {
  verify_sources
  echo "--- would materialize bundle $BUNDLE_SHA under $BUNDLE_PARENT/$BUNDLE_SHA/ ---"
  printf '  %s\n' "${BUNDLE_FILES[@]}"
  echo "--- would install units into $SYSTEMD_DIR ---"
  printf '  %s\n' "${UNIT_FILES[@]}"
  echo "--- would write mode file $MODE_FILE with mode=$MODE ---"
  echo "--- would run: systemctl --user daemon-reload; enable --now ${TIMER_UNITS[*]} ---"
  echo "DRY_RUN_OK"
}

OP="${1:-}"
[ -n "$OP" ] || { usage >&2; exit 2; }
shift

EXPECT_HOST=""
MODE=""
BUNDLE_SHA=""
RECEIPT_ARG=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) EXPECT_HOST="${2:?missing --host value}"; shift 2 ;;
    --mode) MODE="${2:?missing --mode value}"; shift 2 ;;
    --bundle-sha) BUNDLE_SHA="${2:?missing --bundle-sha value}"; shift 2 ;;
    --receipt) RECEIPT_ARG="${2:?missing --receipt value}"; shift 2 ;;
    *) fail "unexpected argument: $1" ;;
  esac
done

case "$OP" in
  dry-run)
    require_host
    case "$MODE" in observe|emit) ;; *) fail "dry-run requires --mode observe|emit" ;; esac
    [ -n "$BUNDLE_SHA" ] && require_bundle_sha || fail "dry-run requires --bundle-sha"
    do_dry_run
    ;;
  install)
    require_host
    if [ "$MODE" != "observe" ]; then
      fail "install only supports --mode observe; use set-mode for emit after the observe soak"
    fi
    [ -n "$BUNDLE_SHA" ] || fail "install requires --bundle-sha"
    require_bundle_sha
    do_install
    ;;
  set-mode)
    require_host
    case "$MODE" in observe|emit) ;; *) fail "set-mode requires --mode observe|emit" ;; esac
    do_set_mode
    ;;
  verify)
    require_host
    [ -n "$BUNDLE_SHA" ] || fail "verify requires --bundle-sha"
    require_bundle_sha
    do_verify
    ;;
  rollback)
    require_host
    [ -n "$RECEIPT_ARG" ] || fail "rollback requires --receipt <dir>"
    require_lock
    do_rollback_from "$RECEIPT_ARG"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
```

Then: `chmod 0755 deploy/scripts/install-bot-errors-release-proof.sh`

Note one deliberate subtlety: in `dry-run`, the line `[ -n "$BUNDLE_SHA" ] && require_bundle_sha || fail ...` is wrong shell logic (the `|| fail` fires when `require_bundle_sha` succeeds is false only). Write it as two explicit statements instead:

```bash
    [ -n "$BUNDLE_SHA" ] || fail "dry-run requires --bundle-sha"
    require_bundle_sha
```

- [ ] **Step 4: Run this task's tests green**

Run: `npx vitest run --pool=forks tests/scripts/bot-errors-release-proof-installer.test.ts`
Expected: PASS for all `installer preflight and dry-run` cases.

- [ ] **Step 5: Commit**

```bash
git add deploy/scripts/install-bot-errors-release-proof.sh tests/scripts/bot-errors-release-proof-installer.test.ts
git commit -m "feat(bot-errors): narrow release-proof installer with fail-closed preflight and no-write dry-run"
```

---

### Task 8: Installer — install, set-mode, verify, rollback behavior tests

**Files:**
- Test: `tests/scripts/bot-errors-release-proof-installer.test.ts` (extend)
- Modify (only if a test exposes a defect): `deploy/scripts/install-bot-errors-release-proof.sh`

**Interfaces:**
- Consumes: the complete installer from Task 7 and the fixture helpers already in the test file.
- Produces: verified mutation semantics — backup-before-replace, minimal systemctl surface, mode isolation, rollback restoration.

- [ ] **Step 1: Write the failing/behavior tests**

Append to `tests/scripts/bot-errors-release-proof-installer.test.ts`:

```ts
describe('installer mutation, set-mode, verify, rollback', () => {
  function installOk(fx: Fixture) {
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', SHA]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('INSTALL_OK');
    return res;
  }

  it('install materializes bundle, units, mode file, and enables only the two monitor timers', () => {
    const fx = makeFixture();
    installOk(fx);
    for (const rel of BUNDLE_FILES) {
      expect(existsSync(join(fx.home, '.local/lib/whatsoup/release-proof', SHA, rel))).toBe(true);
    }
    expect(readFileSync(join(fx.home, '.config/whatsoup/bot-errors-release-proof.env'), 'utf8'))
      .toBe('BOT_ERRORS_RELEASE_PROOF_MODE=observe\n');
    for (const unit of UNIT_FILES) {
      expect(readFileSync(join(fx.systemd, unit), 'utf8'))
        .toBe(readFileSync(join(fx.source, 'deploy', unit), 'utf8'));
    }
    const mutating = ledgerLines(fx).filter((l) =>
      l.startsWith('systemctl') && !/ (is-enabled|is-active|show) /.test(` ${l} `));
    expect(mutating).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable --now bot-errors-tree-provenance.timer',
      'systemctl --user enable --now bot-errors-runtime-staleness.timer',
    ]);
  });

  it('mutating systemctl calls never name an application or fleet unit', () => {
    const fx = makeFixture();
    installOk(fx);
    for (const line of ledgerLines(fx)) {
      for (const forbidden of ['whatsoup@', 'whatsoup-fleet', 'dispatcher', 'collector', 'q-loop']) {
        expect(line).not.toContain(forbidden);
      }
    }
  });

  it('backup precedes replacement: receipt preserves prior installed unit bytes', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.systemd, 'bot-errors-runtime-staleness.service'), '[Unit]\nDescription=old generation\n');
    const res = installOk(fx);
    const receipt = res.stdout.match(/RECEIPT=(\S+)/)?.[1];
    expect(receipt).toBeDefined();
    expect(readFileSync(join(receipt!, 'units-prior/bot-errors-runtime-staleness.service'), 'utf8'))
      .toContain('old generation');
    expect(existsSync(join(receipt!, 'units-prior/bot-errors-tree-provenance.service.was-absent'))).toBe(true);
  });

  it('set-mode touches only the mode file', () => {
    const fx = makeFixture();
    installOk(fx);
    const beforeSystemd = snapshotDir(fx.systemd);
    const beforeBundle = snapshotDir(join(fx.home, '.local/lib/whatsoup/release-proof', SHA));
    const res = runInstaller(fx, ['set-mode', '--host', SYNTH_HOST, '--mode', 'emit']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('SET_MODE_OK mode=emit');
    expect(readFileSync(join(fx.home, '.config/whatsoup/bot-errors-release-proof.env'), 'utf8'))
      .toBe('BOT_ERRORS_RELEASE_PROOF_MODE=emit\n');
    expect(snapshotDir(fx.systemd)).toEqual(beforeSystemd);
    expect(snapshotDir(join(fx.home, '.local/lib/whatsoup/release-proof', SHA))).toEqual(beforeBundle);
  });

  it('verify exits 1 on installed unit drift', () => {
    const fx = makeFixture();
    installOk(fx);
    writeFileSync(join(fx.systemd, 'bot-errors-tree-provenance.timer'), '[Unit]\nDescription=tampered\n');
    const res = runInstaller(fx, ['verify', '--host', SYNTH_HOST, '--bundle-sha', SHA]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unit drift or missing: bot-errors-tree-provenance.timer');
  });

  it('rollback restores prior unit bytes, symlink, mode, and enablement', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.systemd, 'bot-errors-runtime-staleness.service'), '[Unit]\nDescription=old generation\n');
    const res = installOk(fx);
    const receipt = res.stdout.match(/RECEIPT=(\S+)/)?.[1]!;
    const roll = runInstaller(fx, ['rollback', '--host', SYNTH_HOST, '--receipt', receipt]);
    expect(roll.status, roll.stderr).toBe(0);
    expect(roll.stdout).toContain('ROLLBACK_OK');
    expect(readFileSync(join(fx.systemd, 'bot-errors-runtime-staleness.service'), 'utf8'))
      .toContain('old generation');
    expect(existsSync(join(fx.systemd, 'bot-errors-tree-provenance.service'))).toBe(false);
    expect(existsSync(join(fx.home, '.config/whatsoup/bot-errors-release-proof.env'))).toBe(false);
    expect(existsSync(join(fx.home, '.local/lib/whatsoup/release-proof/current'))).toBe(false);
    const disables = ledgerLines(fx).filter((l) => l.includes('disable --now'));
    expect(disables).toEqual([
      'systemctl --user disable --now bot-errors-tree-provenance.timer',
      'systemctl --user disable --now bot-errors-runtime-staleness.timer',
    ]);
  });

  it('activation failure after backup triggers auto-rollback', () => {
    const fx = makeFixture();
    // fake systemctl that fails on `enable`
    writeFileSync(join(fx.bin, 'systemctl'),
      `#!/usr/bin/env bash\necho "systemctl $*" >> "${fx.ledger}"\nif [ "$2" = "enable" ]; then exit 1; fi\nif [ "$2" = "is-enabled" ]; then echo disabled; fi\nif [ "$2" = "is-active" ]; then echo inactive; fi\nexit 0\n`);
    chmodSync(join(fx.bin, 'systemctl'), 0o755);
    const before = snapshotDir(fx.systemd);
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', SHA]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('rolling back');
    expect(snapshotDir(fx.systemd)).toEqual(before);
  });
});
```

- [ ] **Step 2: Run and fix**

Run: `npx vitest run --pool=forks tests/scripts/bot-errors-release-proof-installer.test.ts`
Expected: most cases PASS against Task 7's installer. Debug any failure in the installer (not by weakening tests). Two known sharp edges to check first if something fails: (a) the fixture's fake `systemctl show` answers `FragmentPath` queries with `<fixture systemd dir>/<unit>` — if the loaded-fragment verification fails, check that emulation before suspecting the installer; (b) `do_rollback_from`'s `while read -r unit rest` parsing of `timer-state-prior.txt` needs the `enabled=`/`active=` fields in `rest`.

- [ ] **Step 3: Commit**

```bash
git add tests/scripts/bot-errors-release-proof-installer.test.ts deploy/scripts/install-bot-errors-release-proof.sh
git commit -m "test(bot-errors): release-proof installer mutation, mode, verify, rollback coverage"
```

---

### Task 9: Runtime manifest + mandatory-path checker

**Files:**
- Modify: `deploy/bot-errors-runtime-manifest.json`
- Modify: `scripts/check-bot-errors-runtime-manifest.ts` (`EXPLICIT_REQUIRED_RUNTIME_PATHS`, lines ~75-78)
- Test: whatever suite covers the checker (locate with `grep -rl "check-bot-errors-runtime-manifest" tests/`); update its expected required-path list if it pins one.

**Interfaces:**
- Consumes: final byte content of the detectors (Tasks 1–2), health-check (Task 3), runner (Task 4), installer (Task 7).
- Produces: a manifest whose hashes match the working tree, with the runner and installer as mandatory paths — the installer's `verify_sources` depends on these entries at pilot time.

- [ ] **Step 1: Make the checker require the two new shell scripts**

In `scripts/check-bot-errors-runtime-manifest.ts`, extend `EXPLICIT_REQUIRED_RUNTIME_PATHS` with:

```ts
  'deploy/scripts/bot-errors-release-proof-run.sh',
  'deploy/scripts/install-bot-errors-release-proof.sh',
```

- [ ] **Step 2: Run the checker to see it fail closed**

Run: `bash scripts/run-with-pinned-node.sh scripts/check-bot-errors-runtime-manifest.ts`
Expected: FAIL with `missing-required-path` for both new scripts, plus `hash-drift` for the three modified `.py` files.

- [ ] **Step 3: Refresh the manifest**

Run this from the repo root to refresh drifted hashes and append the two new entries:

```bash
python3 - <<'PY'
import hashlib, json

MANIFEST = "deploy/bot-errors-runtime-manifest.json"
NEW_ENTRIES = [
    {
        "path": "deploy/scripts/bot-errors-release-proof-run.sh",
        "mustContain": ["BOT_ERRORS_RELEASE_PROOF_MODE", "exit 75", "flock -n 9"],
    },
    {
        "path": "deploy/scripts/install-bot-errors-release-proof.sh",
        "mustContain": ["host gate", "RECEIPT", "daemon-reload"],
    },
]

def digest(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()

manifest = json.load(open(MANIFEST))
for entry in manifest["files"]:
    entry["sha256"] = digest(entry["path"])
existing = {entry["path"] for entry in manifest["files"]}
for new in NEW_ENTRIES:
    if new["path"] not in existing:
        manifest["files"].append({"path": new["path"], "sha256": digest(new["path"]), "mustContain": new["mustContain"]})
manifest["files"].sort(key=lambda entry: entry["path"])
with open(MANIFEST, "w") as fh:
    json.dump(manifest, fh, indent=2)
    fh.write("\n")
print("manifest refreshed")
PY
```

Before running it, confirm each `mustContain` marker string actually appears verbatim in the corresponding script (adjust markers, not scripts). Note this refreshes hashes for **all** tracked files — inspect `git diff deploy/bot-errors-runtime-manifest.json` and confirm only the three modified `.py` entries changed hash and the two new entries were appended; if any *other* hash changed, an untracked modification slipped in — stop and investigate.

- [ ] **Step 4: Run checker and checker tests green**

Run: `bash scripts/run-with-pinned-node.sh scripts/check-bot-errors-runtime-manifest.ts`
Expected: `BOT ERRORS runtime manifest guard passed (N file(s))`.

Then locate and run the checker's own suite (e.g. `grep -rl "check-bot-errors-runtime-manifest" tests/scripts/`) and update any pinned required-path expectation to include the two new entries. Also run the real-manifest installer smoke: `bash deploy/scripts/install-bot-errors-release-proof.sh dry-run --host "$(hostname)" --mode observe --bundle-sha 0000000000000000000000000000000000000000` — expected `DRY_RUN_OK` (sources now verify against the refreshed real manifest).

- [ ] **Step 5: Commit**

```bash
git add deploy/bot-errors-runtime-manifest.json scripts/check-bot-errors-runtime-manifest.ts
git commit -m "chore(bot-errors): manifest covers release-proof runner and installer as mandatory paths"
```

(Include the checker-test file in the `git add` if it needed updating.)

---

### Task 10: Dispatcher two-run alert/clear drill test (§12.4)

**Files:**
- Test: `tests/scripts/bot-errors-dispatcher.test.ts` (extend only — the dispatcher itself must not change unless this red-first test exposes a real contract defect, per spec §6.1)

**Interfaces:**
- Consumes: real `deploy/scripts/bot-errors-emit.py` and `deploy/scripts/bot-errors-dispatcher.py` under `BOT_ERRORS_STATE_DIR` sandbox + `BOT_ERRORS_DRY_SEND_CAPTURE` (existing idiom in this file).
- Produces: proof that one warning and one same-key clear traverse the production dispatcher with duplicate/orphan suppression and drained queues — the local twin of the Gate 2 host drill.

- [ ] **Step 1: Write the test**

Append to `tests/scripts/bot-errors-dispatcher.test.ts`, reusing its `tmpdir`/`mkdtempSync` and dispatcher-invocation idiom (`execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], …)`):

```ts
describe('release-proof drill: two-run alert/clear traversal', () => {
  const DRILL_SOURCE = 'release_proof_drill';
  const DRILL_INSTANCE = 'drill-synthetic';

  function emitDrill(root: string, extra: string[]): void {
    execFileSync('python3', ['deploy/scripts/bot-errors-emit.py', ...extra], {
      cwd: process.cwd(),
      env: { ...process.env, BOT_ERRORS_STATE_DIR: root, BOT_ERRORS_INLINE_LOG_TAIL: '0' },
    });
  }

  function dispatchOnce(root: string, capture: string): string {
    return execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: root,
        BOT_ERRORS_DRY_SEND_CAPTURE: capture,
        BOT_ERRORS_INLINE_LOG_TAIL: '0',
      },
    });
  }

  function dirCount(root: string, name: string): number {
    const dir = join(root, name);
    return existsSync(dir) ? readdirSync(dir).length : 0;
  }

  it('one warning then one same-key clear; duplicates suppressed; queues drain', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-drill-'));
    tmpRoots.push(tmpRoot); // use this file's existing cleanup registry name
    const capture = join(tmpRoot, 'capture.jsonl');
    const alertArgs = [
      '--severity', 'warning',
      '--source', DRILL_SOURCE,
      '--instance', DRILL_INSTANCE,
      '--summary', 'release-proof drill alert',
    ];
    const clearArgs = ['--clear', '--source', DRILL_SOURCE, '--instance', DRILL_INSTANCE];

    // Run 1: alert opens an incident and lands in sent/.
    emitDrill(tmpRoot, alertArgs);
    dispatchOnce(tmpRoot, capture);
    expect(dirCount(tmpRoot, 'outbox')).toBe(0);
    expect(dirCount(tmpRoot, 'sent')).toBe(1);
    const incidentsAfterAlert = readFileSync(join(tmpRoot, 'incident-state.json'), 'utf8');
    expect(incidentsAfterAlert).toContain(DRILL_SOURCE);
    expect(incidentsAfterAlert).toContain(DRILL_INSTANCE);

    // Duplicate alert with the same key: suppressed, no second alert send.
    emitDrill(tmpRoot, alertArgs);
    dispatchOnce(tmpRoot, capture);
    expect(dirCount(tmpRoot, 'outbox')).toBe(0);

    // Run 2: same-key clear closes the incident.
    emitDrill(tmpRoot, clearArgs);
    dispatchOnce(tmpRoot, capture);
    const incidentsAfterClear = readFileSync(join(tmpRoot, 'incident-state.json'), 'utf8');
    expect(incidentsAfterClear).not.toContain(DRILL_INSTANCE);

    // Orphan clear: suppressed without residue.
    emitDrill(tmpRoot, clearArgs);
    dispatchOnce(tmpRoot, capture);

    for (const queue of ['outbox', 'processing', 'writefail', 'dead-letter', 'quarantine']) {
      expect(dirCount(tmpRoot, queue), `${queue} not drained`).toBe(0);
    }
    const rendered = readFileSync(capture, 'utf8');
    expect(rendered).toContain('release-proof drill alert');
  });
});
```

Adjust three anchors to this file's actual local idiom while writing (they are established facts of the file, not design choices): the cleanup-registry array name (`tmpRoots` here — match what the file uses), the imports already present, and the duplicate-suppression observable. For the duplicate-suppression assertion specifically: after the duplicate-alert dispatch, count alert messages in `capture.jsonl` for the drill summary — if the dispatcher's contract is suppress-while-open, assert the count stayed 1; if it re-notifies by design, assert on the dispatcher's suppression/audit marker in its stdout summary instead. Read the dispatcher's suppression behavior from its existing tests first; only if the real emitter/dispatcher cannot satisfy §12.4's "duplicate alert is suppressed and audited" is a dispatcher change even on the table (spec §6.1), and that would be its own red-first task.

- [ ] **Step 2: Run**

Run: `npx vitest run --pool=forks tests/scripts/bot-errors-dispatcher.test.ts`
Expected: PASS. If emit flags differ from `build_emit_argv`'s contract (`--severity/--source/--instance/--summary/--clear`), read `deploy/scripts/bot-errors-emit.py --help` and fix the test's argv, not the emitter.

- [ ] **Step 3: Commit**

```bash
git add tests/scripts/bot-errors-dispatcher.test.ts
git commit -m "test(bot-errors): two-run release-proof drill through the real dispatcher"
```

---

### Task 11: Documentation (README, runbook, single-producer rule)

**Files:**
- Modify: `deploy/scripts/README-bot-errors.md`
- Modify: `docs/runbooks/release-deployment.md`

**Interfaces:**
- Consumes: everything above.
- Produces: operator documentation for the pilot; closes the spec §13 doc requirement and the B3 "documentation states which producer owns alert and clear state" correction.

- [ ] **Step 1: README section**

Append to `deploy/scripts/README-bot-errors.md` a new top-level section:

```markdown
## Release-proof monitor (central pilot)

Monitor-only detection of tree provenance drift and runtime code staleness on
the in-place-git central pilot host. Design:
`docs/superpowers/specs/2026-07-11-central-hub-release-proof-pilot-design.md`.

### Components

- `bot-errors-release-proof-run.sh tree|runtime-staleness` — scheduler runner.
  Reads `~/.config/whatsoup/bot-errors-release-proof.env` as data (never
  sourced), validates `BOT_ERRORS_RELEASE_PROOF_MODE=observe|emit`, takes a
  shared non-blocking lock, and invokes exactly one detector from the
  versioned bundle. Exits: 0 valid observation, 1 event-write failure,
  2 usage/mode/dependency error, 75 lock contention (recorded skip; units
  treat it as success via `SuccessExitStatus=75`).
- `install-bot-errors-release-proof.sh` — narrow installer with
  `dry-run` / `install --mode observe` / `set-mode` / `verify` /
  `rollback --receipt <dir>`. Manages ONLY the bundle under
  `~/.local/lib/whatsoup/release-proof/<sha>/`, the `current` symlink, the
  mode file, the four monitor units, and the two monitor timer enablements.
  `install` accepts only observe mode; emit is a separate `set-mode` after
  the observe soak. Dry-run performs zero writes.
- Units: `bot-errors-tree-provenance.{service,timer}`,
  `bot-errors-runtime-staleness.{service,timer}` — oneshot, 30-minute
  `OnUnitInactiveSec` cadence with distinct bootstrap offsets, resource-capped
  (`MemoryMax=128M`, `TasksMax=32`), sandboxed, and forbidden from naming any
  application/fleet/dispatcher unit.

### Single tree producer (B3)

`bot-errors-tree-provenance.py` has two possible schedulers: the standalone
timer above (source `tree-provenance`) and the daily-health embedding
(`tree_provenance_inventory`, daily-health sources). Dispatcher incident
identity is machine|instance|source, so the two DO NOT deduplicate. During
the pilot the standalone timer is the ONLY producer: the daily-health profile
keeps `expectTreeProvenance=false` on the pilot host, and the installer has
no code path that touches the daily-health integration. Alert and clear state
for tree findings is owned by the standalone `tree-provenance` source.

### Drift verification scope

The pilot always passes all four monitor unit names explicitly:

    bash scripts/check-unit-drift.sh --unit \
      bot-errors-tree-provenance.service bot-errors-tree-provenance.timer \
      bot-errors-runtime-staleness.service bot-errors-runtime-staleness.timer \
      --no-wrappers

plus `install-bot-errors-release-proof.sh verify`, which additionally checks
loaded fragment paths and drop-ins via `systemctl --user show`.
```

- [ ] **Step 2: Runbook section**

Append to `docs/runbooks/release-deployment.md`:

```markdown
## In-place-git release-proof pilot (central host)

The snapshot planes above do not apply to the central pilot host, which runs
an in-place-git checkout. Its release-proof plane is the monitor-only pilot
specified in
`docs/superpowers/specs/2026-07-11-central-hub-release-proof-pilot-design.md`
(gates, non-regression criteria, abort rules, and promotion packet live
there; this section is the operator entry point).

Operator sequence (each gate separately owner-gated):

1. **Gate 1 — isolated dry proof:** stage with
   `install-bot-errors-release-proof.sh dry-run --host <host> --mode observe
   --bundle-sha <merged-sha>`; run both detectors against temporary
   `BOT_ERRORS_STATE_DIR`; prove no application path changed.
2. **Gate 2 — controlled alert drill:** one warning + same-key clear through
   the production dispatcher (`--source release_proof_drill`, unique
   conservative instance, `BOT_ERRORS_INLINE_LOG_TAIL=0`). Requires
   execution-time owner confirmation — it is an external communication.
3. **Gate 3 — observe install + 24 h soak:**
   `install --mode observe`; verify with `verify` and the explicit
   four-unit `check-unit-drift.sh` invocation; capture the spec §9
   non-regression evidence before and after.
4. **Gate 4 — emit + 48 h soak:** `set-mode --mode emit` after a separate
   owner gate; one manual cycle per detector before automated coverage.
5. **Gate 5 — application provenance proof:** separate approval; deploy an
   approved main SHA, restart the app, stamp `expected_head_sha`, prove
   `/health.instance.commit`/`branch` and a runtime-staleness clear.

Rollback at any point: `install-bot-errors-release-proof.sh rollback
--host <host> --receipt <receipt-dir>` (printed by `install`). Rollback
touches only monitor artifacts and never invokes an application service
command.
```

- [ ] **Step 3: Runbook co-update check (CLAUDE.md PR discipline)**

Run:

```bash
git diff --name-only HEAD~10..HEAD | xargs -I{} grep -l "not yet wired\|not wired\|TODO\|not yet implemented\|runtime gap" docs/runbooks/ 2>/dev/null | sort -u
```

Read any hit in context; if one of this branch's changes closes a documented gap, update that runbook line in this task.

- [ ] **Step 4: Doc guards green**

Run: `npm run guard:doc-drift && npm run guard:publication:all`
Expected: both pass (these files already have publication-audit rows; no new doc files are created in this task).

- [ ] **Step 5: Commit**

```bash
git add deploy/scripts/README-bot-errors.md docs/runbooks/release-deployment.md
git commit -m "docs(bot-errors): release-proof pilot operator sections and single-producer rule"
```

---

### Task 12: Full local gates

**Files:** none (verification only; fix regressions where they arise).

- [ ] **Step 1: Targeted suites**

```bash
npx vitest run --pool=forks \
  tests/scripts/bot-errors-runtime-staleness.test.ts \
  tests/scripts/bot-errors-service-templates.test.ts \
  tests/scripts/unit-drift.test.ts \
  tests/scripts/bot-errors-dispatcher.test.ts \
  tests/scripts/bot-errors-release-proof-run.test.ts \
  tests/scripts/bot-errors-release-proof-installer.test.ts
python3 -m pytest -q \
  deploy/scripts/tests/test_bot_errors_tree_provenance.py \
  deploy/scripts/tests/test_bot_errors_f9_git_head_sha.py \
  deploy/scripts/tests/test_bot_errors_orphan_clear_suppression.py
bash deploy/scripts/tests/test_deployer_pin_mode.sh | grep -q PIN_TEST_PASS && echo PIN_OK
bash deploy/scripts/tests/test_deployer_mutation.sh | grep -q DEPLOYER_MUTATION_PASS && echo MUTATION_OK
```

Expected: all pass. The two deployer suites are adjacent-surface regression checks (this plan does not modify the deployer).

- [ ] **Step 2: Repo gates**

```bash
npm run typecheck
npm run guard:lint:src
bash scripts/run-with-pinned-node.sh scripts/check-bot-errors-runtime-manifest.ts
```

Expected: all pass.

- [ ] **Step 3: Full suite (CI parity)**

Run: `npm test`
Expected: PASS. The local push hook runs only a curated subset; CI runs the full suite with coverage — run the full suite locally before declaring Gate 0 complete (CLAUDE.md PR discipline). Watch the `arch.file-size` ratchet: the two new test files must stay within the warning budget; split them if the ratchet trips.

- [ ] **Step 4: Final review and stop**

```bash
git log --oneline origin/main..HEAD
git status --porcelain
```

Expected: a clean tree and roughly ten commits (spec, amendment, plan, Tasks 1–11). **Do not push** — pushing, PR filing, and every host-facing gate remain owner-gated. Report completion with the commit list and test evidence.

---

## Self-Review Notes (spec → task coverage)

- §4 B1 → Task 1. §4 B2 → Task 2. §4 B3 → Tasks 5 (single-producer test), 7 (installer structural test), 11 (docs). §4 B4 → Tasks 7–8 (narrow installer; `deploy/setup.sh` untouched). §4 B5 → Task 6 + installer `verify` fragment/drop-in checks (Task 7 code, Task 8 tests).
- §2 no-optional-locks + never-fetch → Tasks 2 (detector + `--reporter` fetch rejection) and 3 (health SHA read).
- §6.2 bundle → Tasks 7–8 (`BUNDLE_FILES` mirrors "runner + manifest-tracked files required by tree provenance, runtime staleness, and event emission"). §6.3 runner → Task 4. §6.4 units → Task 5. §6.5 installer → Tasks 7–8.
- §12.1 → Task 1. §12.2 → Tasks 2–3. §12.3 → Tasks 6–8. §12.4 → Task 10. §12.5 → Task 12.
- §13 file surface → every listed file appears in exactly one task above; `docs/runbooks/release-deployment.md` is the "central-hub/release deployment runbook" named in §13 (verified: no other runbook mentions the central hub).
- Host-facing work (Gates 1–6, §7.3 production drill, §14 packet) is intentionally absent: it is operational, separately owner-gated, and documented in Task 11's runbook section.
- Known execution-time risks called out inline: systemd sandbox directives subject to pilot-host `systemd-analyze` (Task 5), dispatcher duplicate-suppression observable (Task 10), file-size ratchet (Task 12).
