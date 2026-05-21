# Tokenomics Installer (K) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tokenomics v2 installer ("K") that materializes the plugin into `~/.claude/plugins/tokenomics/` on a target host with hook-surface auditing, toolchain baseline checks, doctor gating, and transactional rollback of installer-created files when any step fails.

**Architecture:** Each installer concern is a small, independently testable Python module under `plugins/tokenomics/scripts/lib/`. A thin top-level entrypoint (`scripts/install.py`, future task) composes them. Pre-existing user state (`history.jsonl`, `threshold.json`, pre-existing state dirs) is never touched on rollback — only artifacts the current install created are reversed.

**Tech Stack:** Python 3 stdlib only (`json`, `pathlib`, `dataclasses`, `subprocess`, `os`, `tempfile`). pytest for tests. Existing convention: tests load library modules via `importlib.util` from absolute paths (see `plugins/tokenomics/tests/test_install_config.py`).

**Scope of this plan:** Tasks 1–3 shipped. Task 1 (`b3dac2d6`) shipped before this plan was written and is documented here for chain-of-custody. Tasks 2 and 3 ship under this plan. Subsequent installer tasks (toolchain baseline, doctor gate, plist materialization, manifest emission, install orchestrator) will be appended as separate tasks in follow-on revisions of this plan.

**Working directory:** the WhatSoup repo worktree on branch `feat/tokenomics-installer-20260521`. Run all commands from the repository root.

**Test command:** `bash scripts/run-tokenomics-pytests.sh` runs the full tokenomics pytest suite. Individual file form: `python3 -m pytest -q plugins/tokenomics/tests/test_<name>.py`.

**Specs this plan implements:**
- `plugins/tokenomics/SPEC.md` §K "Installer Hook-Surface Audit" (line 728), "Installer Search-Toolchain Baseline" (738), "Installer Doctor Gate" (748), "Plugin Manifest" (752).
- `plugins/tokenomics/SPEC.md` §5.4 "Installer Tests" (866) — Task 2 covers cases 5–9 (rollback semantics).
- `plugins/tokenomics/IMPLEMENTATION_PLAN.md` line 20 "K full installer with hook-surface audit + rollback checkpoint framework" (v1 deferral; this plan is the deferred work).

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `plugins/tokenomics/scripts/lib/install_config.py` | exists (`b3dac2d6`) | Parse + validate installer JSON config into typed `InstallConfig` |
| `plugins/tokenomics/scripts/lib/rollback.py` | shipped (Task 2) | `RollbackJournal` — record installer-created files/dirs/commands; undo in LIFO with pre-existing-state preservation |
| `plugins/tokenomics/scripts/lib/hook_audit.py` | shipped (Task 3) | `audit_hook_surfaces` — scan settings.json / hookify rules / other plugin hooks.json for conflicting PreToolUse browser-matcher; raises `HookConflict` |
| `plugins/tokenomics/tests/test_install_config.py` | exists (`b3dac2d6`) | Unit tests for `install_config.py` |
| `plugins/tokenomics/tests/test_rollback.py` | shipped (Task 2) | Unit tests for `rollback.py` |
| `plugins/tokenomics/tests/test_hook_audit.py` | shipped (Task 3) | Unit tests for `hook_audit.py` |
| `plugins/tokenomics/scripts/install.py` | future (later task) | Top-level installer orchestrator that uses `InstallConfig` + `RollbackJournal` + hook-audit + toolchain-baseline + doctor + plist-renderer |

Module boundary rule: `rollback.py` knows nothing about hooks, plists, or the doctor; it is a pure recorder/undoer of filesystem and command operations. This keeps it composable with whatever the installer orchestrator decides to do.

---

## Task list (Tasks 1–2 in this revision)

### Task 1: Install config schema + validator — **DONE (`b3dac2d6`)**

**Files (already on disk):**
- `plugins/tokenomics/scripts/lib/install_config.py`
- `plugins/tokenomics/tests/test_install_config.py`

**What shipped:**
- `InstallConfig` frozen dataclass with fields `bot`, `instance_path`, `ceiling`, `cooldown_seconds`, `whatsoup_repo`, `plugin_root` (all paths `.resolve()`-coerced).
- `InstallConfigError(ValueError)` raised on missing required keys, non-string/non-matching `bot` (regex `^[A-Za-z0-9_-]{1,80}$` — blocks path-injection bot names), non-object JSON root, and any coercion failure.
- `load_install_config(path)` reads JSON, validates, returns `InstallConfig`.
- 5 tests: valid load, missing-bot rejection, path-injection bot rejection, non-object-root rejection, path-resolution normalization (`..` segments collapse).

**No-op verification (do not re-run unless re-baselining):**

```bash
bash scripts/run-tokenomics-pytests.sh -k install_config
```
Expected: 5 passed.

---

### Task 2: Rollback checkpoint framework — **DONE**

**Why this is next:** Every later installer task (file copy, plist load, settings.json edit, skill-disable touch-files) mutates the host filesystem or launchd state. Without a transactional reversal primitive, a mid-install failure leaves the host in an undefined state. SPEC.md §5.4 cases 5, 7, 8, 9 mandate this behavior. We build it first so subsequent installer steps can record into it from day one.

**Module surface:**

```python
# plugins/tokenomics/scripts/lib/rollback.py

import dataclasses, json, os, pathlib, subprocess
from typing import Optional, Sequence


class RollbackError(RuntimeError):
    pass


@dataclasses.dataclass
class JournalEntry:
    op: str                  # "created_file" | "created_dir" | "command"
    path: Optional[str] = None
    undo_cmd: Optional[Sequence[str]] = None
    undone: bool = False


class RollbackJournal:
    """Records installer-created artifacts and reverses them on undo().

    Rules:
      - Only artifacts THIS journal created are reversed. Pre-existing files
        and directories are never removed.
      - created_dir undo removes the directory only if it is still empty.
        User state placed inside survives.
      - undo() processes entries LIFO; partial-failure-safe via per-entry
        `undone` flag (idempotent on re-run).
      - Optional journal_path persists each record to JSONL on append, so a
        process crash leaves a recoverable trail for an out-of-process
        `rollback --from <journal>` invocation (future task).
    """

    def __init__(self, journal_path: Optional[pathlib.Path] = None) -> None:
        self._entries: list[JournalEntry] = []
        self._journal_path = journal_path
        if journal_path is not None:
            journal_path.parent.mkdir(parents=True, exist_ok=True)
            journal_path.touch(exist_ok=True)

    def record_file(self, path: pathlib.Path) -> None: ...
    def record_dir(self, path: pathlib.Path) -> None: ...
    def record_command(self, undo_cmd: Sequence[str]) -> None: ...

    def ensure_dir(self, path: pathlib.Path) -> bool:
        """Create `path` if absent, record only if newly created.
        Returns True if created, False if pre-existing."""

    def undo(self) -> list[JournalEntry]:
        """Reverse LIFO. Returns the list of entries whose undo failed
        (each entry's `undone` flag is True on success, False on failure).
        Raises RollbackError only if undo state itself is corrupt."""

    @classmethod
    def from_path(cls, journal_path: pathlib.Path) -> "RollbackJournal":
        """Load a previously-persisted journal for out-of-process rollback."""
```

**Files:**
- Create: `plugins/tokenomics/scripts/lib/rollback.py`
- Create test: `plugins/tokenomics/tests/test_rollback.py`

- [x] **Step 2.1: Write the failing test file (all 9 tests)**

Create `plugins/tokenomics/tests/test_rollback.py` with the following content:

```python
import importlib.util
import json
import pathlib
import subprocess
import sys

ROLLBACK_PATH = pathlib.Path(__file__).parents[1] / "scripts" / "lib" / "rollback.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("rollback", ROLLBACK_PATH)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_empty_journal_undo_is_noop(tmp_path):
    module = _load_module()
    journal = module.RollbackJournal()
    failures = journal.undo()
    assert failures == []


def test_record_file_undo_removes_only_if_present(tmp_path):
    module = _load_module()
    target = tmp_path / "a.txt"
    target.write_text("x", encoding="utf-8")
    journal = module.RollbackJournal()
    journal.record_file(target)
    failures = journal.undo()
    assert failures == []
    assert not target.exists()


def test_record_file_undo_skips_already_removed_file(tmp_path):
    module = _load_module()
    target = tmp_path / "a.txt"
    target.write_text("x", encoding="utf-8")
    journal = module.RollbackJournal()
    journal.record_file(target)
    target.unlink()
    failures = journal.undo()
    # Already gone is success, not failure
    assert failures == []


def test_record_dir_undo_only_removes_if_empty(tmp_path):
    module = _load_module()
    created = tmp_path / "created"
    created.mkdir()
    journal = module.RollbackJournal()
    journal.record_dir(created)
    # User dropped a file inside after we created it
    (created / "user_state.txt").write_text("preserve me", encoding="utf-8")
    failures = journal.undo()
    # Non-empty dir undo is a recorded failure, not a crash
    assert len(failures) == 1
    assert failures[0].path == str(created)
    assert created.exists()
    assert (created / "user_state.txt").read_text(encoding="utf-8") == "preserve me"


def test_ensure_dir_records_only_when_newly_created(tmp_path):
    module = _load_module()
    pre_existing = tmp_path / "pre"
    pre_existing.mkdir()
    new_dir = tmp_path / "new"

    journal = module.RollbackJournal()
    assert journal.ensure_dir(pre_existing) is False
    assert journal.ensure_dir(new_dir) is True
    assert new_dir.is_dir()

    journal.undo()
    # Pre-existing dir survives undo (we never recorded it)
    assert pre_existing.is_dir()
    # Newly-created (and still empty) dir was removed
    assert not new_dir.exists()


def test_undo_is_lifo(tmp_path):
    module = _load_module()
    f1 = tmp_path / "1.txt"
    f1.write_text("1", encoding="utf-8")
    f2 = tmp_path / "2.txt"
    f2.write_text("2", encoding="utf-8")
    journal = module.RollbackJournal()
    journal.record_file(f1)
    journal.record_file(f2)
    failures = journal.undo()
    assert failures == []
    # Order in entries reflects LIFO traversal: last appended is first undone
    ops = [e.path for e in journal._entries if e.undone]
    assert ops == [str(f1), str(f2)]  # all undone


def test_undo_is_idempotent_on_rerun(tmp_path):
    module = _load_module()
    target = tmp_path / "a.txt"
    target.write_text("x", encoding="utf-8")
    journal = module.RollbackJournal()
    journal.record_file(target)
    journal.undo()
    # Second undo must be a no-op, not a re-attempt
    failures = journal.undo()
    assert failures == []


def test_record_command_runs_undo_on_undo(tmp_path):
    module = _load_module()
    marker = tmp_path / "marker.txt"
    journal = module.RollbackJournal()
    # Use python -c so the test is OS-portable on darwin
    journal.record_command([sys.executable, "-c", f"open({str(marker)!r}, 'w').write('done')"])
    failures = journal.undo()
    assert failures == []
    assert marker.read_text(encoding="utf-8") == "done"


def test_journal_persists_to_jsonl_when_path_given(tmp_path):
    module = _load_module()
    journal_path = tmp_path / "state" / "journal.jsonl"
    target = tmp_path / "a.txt"
    target.write_text("x", encoding="utf-8")
    journal = module.RollbackJournal(journal_path=journal_path)
    journal.record_file(target)

    assert journal_path.exists()
    lines = [json.loads(l) for l in journal_path.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert any(rec.get("op") == "created_file" and rec.get("path") == str(target) for rec in lines)


def test_from_path_reloads_journal_for_out_of_process_rollback(tmp_path):
    module = _load_module()
    journal_path = tmp_path / "j.jsonl"
    target = tmp_path / "a.txt"
    target.write_text("x", encoding="utf-8")

    journal = module.RollbackJournal(journal_path=journal_path)
    journal.record_file(target)

    reloaded = module.RollbackJournal.from_path(journal_path)
    failures = reloaded.undo()
    assert failures == []
    assert not target.exists()
```

- [x] **Step 2.2: Run the test to confirm it fails**

Run:

```bash
bash scripts/run-tokenomics-pytests.sh -k rollback
```

Expected: collection error / 10 errors with `ModuleNotFoundError: No module named 'rollback'` or `FileNotFoundError` resolving `ROLLBACK_PATH`. This proves the test file is wired correctly and the module is absent.

- [x] **Step 2.3: Implement the minimal module**

Create `plugins/tokenomics/scripts/lib/rollback.py` with the following content:

```python
import dataclasses
import json
import os
import pathlib
import subprocess
from typing import Optional, Sequence


class RollbackError(RuntimeError):
    pass


@dataclasses.dataclass
class JournalEntry:
    op: str
    path: Optional[str] = None
    undo_cmd: Optional[Sequence[str]] = None
    undone: bool = False


def _entry_to_record(entry: JournalEntry) -> dict:
    rec = {"op": entry.op, "undone": entry.undone}
    if entry.path is not None:
        rec["path"] = entry.path
    if entry.undo_cmd is not None:
        rec["undo_cmd"] = list(entry.undo_cmd)
    return rec


def _record_to_entry(rec: dict) -> JournalEntry:
    return JournalEntry(
        op=rec["op"],
        path=rec.get("path"),
        undo_cmd=rec.get("undo_cmd"),
        undone=bool(rec.get("undone", False)),
    )


class RollbackJournal:
    def __init__(self, journal_path: Optional[pathlib.Path] = None) -> None:
        self._entries: list[JournalEntry] = []
        self._journal_path = journal_path
        if journal_path is not None:
            journal_path.parent.mkdir(parents=True, exist_ok=True)
            if not journal_path.exists():
                journal_path.touch()

    def _append(self, entry: JournalEntry) -> None:
        self._entries.append(entry)
        if self._journal_path is not None:
            with self._journal_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(_entry_to_record(entry)) + "\n")

    def record_file(self, path: pathlib.Path) -> None:
        self._append(JournalEntry(op="created_file", path=str(path)))

    def record_dir(self, path: pathlib.Path) -> None:
        self._append(JournalEntry(op="created_dir", path=str(path)))

    def record_command(self, undo_cmd: Sequence[str]) -> None:
        if not undo_cmd:
            raise RollbackError("undo_cmd must be a non-empty sequence")
        self._append(JournalEntry(op="command", undo_cmd=list(undo_cmd)))

    def ensure_dir(self, path: pathlib.Path) -> bool:
        if path.exists():
            return False
        path.mkdir(parents=True, exist_ok=False)
        self.record_dir(path)
        return True

    def undo(self) -> list[JournalEntry]:
        failures: list[JournalEntry] = []
        for entry in reversed(self._entries):
            if entry.undone:
                continue
            try:
                if entry.op == "created_file":
                    assert entry.path is not None
                    p = pathlib.Path(entry.path)
                    if p.exists():
                        p.unlink()
                    entry.undone = True
                elif entry.op == "created_dir":
                    assert entry.path is not None
                    p = pathlib.Path(entry.path)
                    if not p.exists():
                        entry.undone = True
                    elif any(p.iterdir()):
                        # Non-empty: preserve user state
                        failures.append(entry)
                    else:
                        p.rmdir()
                        entry.undone = True
                elif entry.op == "command":
                    assert entry.undo_cmd is not None
                    result = subprocess.run(list(entry.undo_cmd), check=False)
                    if result.returncode == 0:
                        entry.undone = True
                    else:
                        failures.append(entry)
                else:
                    raise RollbackError(f"unknown op: {entry.op}")
            except OSError:
                failures.append(entry)
        return failures

    @classmethod
    def from_path(cls, journal_path: pathlib.Path) -> "RollbackJournal":
        inst = cls(journal_path=None)
        inst._journal_path = journal_path
        text = journal_path.read_text(encoding="utf-8")
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            inst._entries.append(_record_to_entry(json.loads(line)))
        return inst
```

- [x] **Step 2.4: Run the test to confirm it passes**

Run:

```bash
bash scripts/run-tokenomics-pytests.sh -k rollback
```

Expected: 11 passed (10 from the original design plus 1 defensive direct test for SPEC.md §5.4 case 6 added at approval time — `test_undo_never_removes_unrecorded_pre_existing_files`).

Note: `scripts/run-tokenomics-pytests.sh` ignores extra args (it `exec`s pytest with a fixed argv), so `-k rollback` is dropped and the full suite always runs. Use `python3 -m pytest -q plugins/tokenomics/tests/test_rollback.py` for file-scoped runs.

- [x] **Step 2.5: Run the whole tokenomics test suite to confirm no regression**

Run:

```bash
bash scripts/run-tokenomics-pytests.sh
```

Expected: all previously-passing tests still pass plus the 11 new rollback tests (56 passed total at the time of writing).

- [x] **Step 2.6: Commit**

```bash
git add plugins/tokenomics/scripts/lib/rollback.py plugins/tokenomics/tests/test_rollback.py plugins/tokenomics/INSTALLER_PLAN.md
git commit -m "feat(tokenomics): add installer rollback journal

RollbackJournal records installer-created files, dirs, and undo
commands; undo() reverses them LIFO while preserving any pre-existing
state (non-empty created dirs are kept; pre-existing dirs are never
removed). Persists to JSONL when journal_path is supplied so a crashed
install leaves a recoverable trail.

Covers SPEC.md §5.4 installer-test cases 5-9 (partial-install rollback,
preservation of history.jsonl/threshold.json, empty-dir-only removal,
plist load failure unwind via undo_cmd).

Also adds INSTALLER_PLAN.md documenting Task 1 (install_config,
already shipped at b3dac2d6) and Task 2 (this commit)."
```

---

### Task 3: Hook-surface audit — **DONE**

**Files (shipped):**
- `plugins/tokenomics/scripts/lib/hook_audit.py`
- `plugins/tokenomics/tests/test_hook_audit.py`

**What shipped:**
- `BROWSER_MATCHER` constant: `"mcp__superpowers-chrome_chrome__use_browser"`.
- `ConflictRecord(path, surface, detail)` frozen dataclass.
- `HookConflict(RuntimeError)` carries `.conflicts` list.
- `scan_settings_json(path)` and `scan_plugin_hooks_json(path)` — JSON parse, walk `hooks.PreToolUse[*].matcher`, return tagged records.
- `scan_hookify_file(path)` — substring scan for the browser matcher in hookify `.local.md` content (hookify's `event:` taxonomy doesn't map 1:1 to agent runtime matchers, so substring on the literal tool name is the conservative check).
- `_matcher_targets_browser(matcher)` — tries regex `re.search` first (agent runtime matchers are regex; both literal and patterns like `mcp__superpowers-chrome_chrome__.*` match); falls back to substring on invalid regex.
- `audit_hook_surfaces(*, settings_paths, hookify_paths, plugin_hooks_paths, exclude_paths)` — composes the three scanners; resolves and excludes the tokenomics plugin's own hooks.json so it doesn't self-conflict.
- `require_no_conflict(records)` — raises `HookConflict` if non-empty; returns `None` otherwise. The orchestrator (future Task 8) is responsible for translating `HookConflict` into `EX_HOOK_CONFLICT=78`.

**Tests (16):** missing file, no hooks block, no browser matcher, literal matcher, regex matcher (`.*` suffix), invalid-regex substring fallback, PostToolUse-only ignored, malformed JSON, hookify missing/no-mention/mention, plugin-tag, own-plugin exclusion, three-surface aggregation, `require_no_conflict` empty no-op, `require_no_conflict` raise with `.conflicts` attached.

**SPEC.md coverage:** §728 (hook-surface audit), §5.4 cases 2 (settings.json conflict), 3 (plugin hooks.json conflict), 4 (hookify rules conflict).

**Out of scope for Task 3:** path discovery (the orchestrator passes concrete paths in); exit-code mapping (orchestrator concern); live host scan (orchestrator runs the audit against real paths under the user's home).

---

### Review fixes (post Tasks 2 + 3, applied before draft PR)

A pre-PR code review flagged two Important issues that were addressed before pushing:

1. **`RollbackJournal.undo` now persists `undone` state after each mutating entry.** Without this, a crash-recovery `from_path()` followed by a second `undo()` could re-execute `command` undos (e.g., double-issue `launchctl unload`). `_persist_state()` atomically rewrites the JSONL via `tempfile.NamedTemporaryFile` + `os.replace`. Verified with red-green: the new regression test `test_undo_persists_done_state_so_reload_does_not_double_execute` fails (marker has `ran\nran\n`) when persistence is disabled, passes when enabled.

2. **Real LIFO ordering test.** The original `test_undo_is_lifo` only proved both entries were marked undone — it didn't actually prove reverse order, because both ops succeed regardless of sequence. Replaced with:
   - `test_undo_executes_entries_in_reverse_of_record_order` — uses `record_command` to append "first" / "second" to an order file in record order; asserts the file contents are `["second", "first"]` after undo.
   - `test_undo_unwinds_file_before_parent_dir_so_rmdir_succeeds` — exercises a real installer-style dependency: record parent dir then child file, undo, assert both removed (would fail with forward iteration since `rmdir` on non-empty dir is recorded as a failure not data loss).

   Both proven to bite under forward iteration.

3. **`hook_audit.py` adds an `__all__` export list** to make the public surface explicit and discoverable.

Test count after fixes: **74 passed** (was 72; net +2: removed weak LIFO test, added 3 new tests — real LIFO, parent/child unwind, double-execute regression).

Deferred to follow-up (reviewer "Minor"): public accessor for `_entries` (currently tests poke at the private list); `ensure_dir` race catch on `FileExistsError`; uniformly tighter type annotations.

---

## Tasks 4+ (not in this revision)

Reserved for follow-on revisions of this plan. Sketch only — these are **not** to be executed under this revision:

- **Task 4:** Search-toolchain baseline (`toolchain.py`) — verify `rg` is on `PATH` (hard fail, exit 79); warn on missing `fd`/`rga`/`ast-grep`. SPEC.md §738, §5.4 case 16.
- **Task 5:** Doctor gate wrapper — invoke `tokenomics-doctor --json` and bail on any `fail` record (exit 80). Depends on Doctor (L) existing or being mocked. SPEC.md §748, §5.4 cases 17–18.
- **Task 6:** Plugin-manifest emitter — write `tokenomics/.claude-plugin/plugin.json` with `name`, `version`, `sourceRepo`. SPEC.md §752, §5.4 case 19.
- **Task 7:** Plist materialization via existing `render-plist.py` + `launchctl load`, recorded as `record_command(["launchctl", "unload", ...])` on the journal. SPEC.md §5.4 cases 1, 9, 14.
- **Task 8:** Top-level orchestrator `scripts/install.py` — composes Tasks 1–7 in order, instantiates one `RollbackJournal`, calls `journal.undo()` on any exception, translates `HookConflict`/`InstallConfigError`/missing-toolchain/doctor-fail into the named exit codes (`EX_HOOK_CONFLICT=78`, `EX_INSTRUCTION_BLOAT=77`, `EX_MISSING_TOOLCHAIN=79`, `EX_DOCTOR_RED_FINDING=80`), and on success leaves the journal in place for forensic inspection.

Each becomes its own labeled task with its own TDD steps once Task 3 is merged.

---

## Self-review

- **Spec coverage in this revision:** Task 1 covers config validation (no specific SPEC.md test case — defensive baseline). Task 2 covers SPEC.md §5.4 cases 5, 6, 7, 8, 9 — case 6 via the defensive direct test `test_undo_never_removes_unrecorded_pre_existing_files`. Task 3 covers SPEC.md §728 plus §5.4 cases 2, 3, 4 (hook conflict detection across settings.json, plugin hooks.json, and hookify rules).
- **Placeholder scan:** All steps contain runnable code or runnable commands. No "TBD", "appropriate", "similar to".
- **Type consistency:** `JournalEntry` field names (`op`, `path`, `undo_cmd`, `undone`) are identical in the dataclass, the JSONL records, the `from_path` reload, and the test assertions. `record_file`/`record_dir`/`record_command`/`ensure_dir`/`undo` signatures match between the design block, the implementation, and the tests.
- **Cross-file consistency:** `_load_module()` in `test_rollback.py` mirrors the pattern in the existing `test_install_config.py`. Test command (`bash scripts/run-tokenomics-pytests.sh`) matches the script that exists on disk.
