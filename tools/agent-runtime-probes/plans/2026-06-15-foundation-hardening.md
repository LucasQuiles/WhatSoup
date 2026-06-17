# Foundation Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Single-home duplicated probe helpers into `probelib.py`, fix a bad-JSON crash inconsistency, and add three fail-closed `corpus_guard.py` hygiene checks — all behavior-preserving except the bad-JSON consistency fix.

**Architecture:** TDD-first. Each task: write/extend a test, see it fail, make the change, see it pass, then **checkpoint** (`/Users/testuser` is not a git repo, so the checkpoint is `corpus_guard.py` PASS + full `tests/test_*.py` suite green + `test-integrity scan tests` no findings — not `git commit`). Helpers move to `probelib.py` (single home); each probe imports them and deletes its local copy. Guard checks extend `check_probe_hygiene`.

**Tech Stack:** Python 3 stdlib only (no installs). Tests are plain `python3 tests/test_*.py` files with a `__main__` runner that runs `test_*` functions and prints PASS/`all N passed`.

**Spec:** `/Users/testuser/agent-runtime-probes/specs/2026-06-15-foundation-hardening-design.md`

---

## File Structure

- Modify `agent-runtime-probes/probelib.py` — add `sha256_16`, `git_head`.
- Create `agent-runtime-probes/tests/test_probelib.py` — unit tests for probelib helpers.
- Modify 6 probes to import `sha256_16`; 4 probes to import `git_head`; 4 to use `probelib.load_json`; 3 to use `probelib.run`.
- Modify `agent-runtime-probes/corpus_guard.py` — add `redaction_discipline` (HIGH), `schema_version_consistency` (MED), `readme_drift` (MED).
- Create/extend `agent-runtime-probes/tests/test_corpus_guard.py` — fixture tests for the 3 new checks.

**Checkpoint command (used after every task):**
```bash
cd /Users/testuser/agent-runtime-probes
for t in tests/test_*.py; do python3 "$t" >/dev/null || { echo "FAIL $t"; break; }; done && echo "suite green"
python3 corpus_guard.py | python3 -c 'import sys,json;print("guard:",json.load(sys.stdin)["summary"]["verdict"])'
/Users/testuser/.claude/plugins/test-integrity/scripts/test-integrity scan tests 2>/dev/null | tail -1
```
Expected after each task: `suite green`, `guard: PASS`, `No findings.`

---

## Task 1: Add `sha256_16` + `git_head` to probelib

**Files:**
- Create: `agent-runtime-probes/tests/test_probelib.py`
- Modify: `agent-runtime-probes/probelib.py`

- [ ] **Step 1: Write failing tests** in `tests/test_probelib.py`

```python
#!/usr/bin/env python3
"""Tests for probelib shared helpers."""
import os, sys, tempfile, subprocess
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from probelib import sha256_16, git_head, load_json  # noqa: E402

def test_sha256_16_is_16_hex_chars_and_stable():
    import hashlib
    v = sha256_16("hello")
    assert v == hashlib.sha256(b"hello").hexdigest()[:16], v
    assert len(v) == 16 and all(c in "0123456789abcdef" for c in v), v

def test_git_head_returns_short_sha_in_repo_and_none_outside():
    tmp = Path(tempfile.mkdtemp(prefix="probelib-git-"))
    assert git_head(tmp) is None  # not a repo
    subprocess.run(["git", "init", "-q"], cwd=tmp, check=True)
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t",
                    "commit", "-q", "--allow-empty", "-m", "x"], cwd=tmp, check=True)
    head = git_head(tmp)
    assert head and len(head) >= 7 and all(c in "0123456789abcdef" for c in head), head

def test_load_json_bad_json_returns_error_marker_not_raise():
    tmp = Path(tempfile.mkdtemp(prefix="probelib-json-")) / "bad.json"
    tmp.write_text("{ not json", encoding="utf-8")
    out = load_json(tmp)
    assert isinstance(out, dict) and "_error" in out, out

if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns: fn(); print("PASS", fn.__name__)
    print(f"\nall {len(fns)} probelib tests passed")
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/testuser/agent-runtime-probes && python3 tests/test_probelib.py`
Expected: FAIL — `ImportError: cannot import name 'sha256_16'` (or `git_head`).

- [ ] **Step 3: Add the helpers to `probelib.py`** (after the existing `import hashlib`? — add `import hashlib` to the import block if absent, then append near `du`/`sqlite_counts`):

```python
def sha256_16(value: str) -> str:
    """Short content hash: first 16 hex chars of sha256. Single home for the suite."""
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()[:16]


def git_head(repo: Path) -> str | None:
    """Short HEAD sha of a git repo, or None if not a repo / no commits."""
    out = run(["git", "-C", str(repo), "rev-parse", "--short", "HEAD"])
    return out["stdout"] if out["rc"] == 0 and out["stdout"] else None
```

NOTE: before finalizing, open `q_namespace_lint.py` and `whatsoup_spawn_config_probe.py`,
read their existing `git_head`/`sha16`-style defs, and make probelib's output **byte-identical**
to whatever they currently produce (e.g. if a copy uses `rev-parse HEAD` without `--short`,
match it). The test above asserts shape, not an exact sha; the per-probe tests in Tasks 2-3
assert behavior preservation.

- [ ] **Step 4: Run to verify it passes**

Run: `python3 tests/test_probelib.py`
Expected: `all 3 probelib tests passed`.

- [ ] **Step 5: Checkpoint** (run the checkpoint command block). Expected: `suite green`, `guard: PASS` (note: `probe_hygiene` will now flag `test_probelib`'s parent `probelib.py`? No — probelib is in LIBRARIES; but the new `tests/test_probelib.py` may trip `missing_test`'s pairing? It will not — `missing_test` keys on probe `*.py`, not test files). Confirm `guard: PASS`, `No findings.`

---

## Task 2: Adopt `sha256_16` in the 6 probes

**Files (Modify):** `codex_hook_dual_path_probe.py`, `opencode_config_redactor.py`, `mcp_schema_inventory_probe.py`, `model_todo_provenance_probe.py`, `secret_guard_canary.py`, `tmup_dag_schema_probe.py`

- [ ] **Step 1: Confirm baseline green** — `python3 tests/test_<each>.py` for the 6 that have tests; note which pass. (Run the checkpoint; record `suite green`.)

- [ ] **Step 2: For each of the 6 probes:** delete its local `sha16`/`sha256_16` def and add `sha256_16` to its `from probelib import (...)` line. Replace internal call sites with `sha256_16`. (If a probe's local function has a different name e.g. `sha16`, either keep the name via `from probelib import sha256_16 as sha16` or rename call sites — pick the lower-churn option per probe.)

- [ ] **Step 3: Run each affected probe's test**

Run: `for t in tests/test_codex_hook_dual_path_probe.py tests/test_opencode_config_redactor.py tests/test_mcp_schema_inventory_probe.py tests/test_model_todo_provenance_probe.py tests/test_secret_guard_canary.py tests/test_tmup_dag_schema_probe.py; do python3 "$t" >/dev/null && echo "PASS $t" || echo "FAIL $t"; done`
Expected: all PASS (behavior preserved).

- [ ] **Step 4: Checkpoint.** Expected: `suite green`, `guard: PASS`, `No findings.`

---

## Task 3: Adopt `git_head` in the 4 probes

**Files (Modify):** `bot_errors_proof_ladder.py`, `q_namespace_lint.py`, `whatsoup_alias_map.py`, `whatsoup_spawn_config_probe.py`

- [ ] **Step 1:** For each, delete the local `git_head` def and add `git_head` to its probelib import. Confirm call sites unchanged (same name).

- [ ] **Step 2: Run affected tests** (those that have one: `whatsoup_alias_map`, `whatsoup_spawn_config_probe`; the other two have none).

Run: `python3 tests/test_whatsoup_alias_map.py 2>/dev/null; python3 tests/test_whatsoup_spawn_config_probe.py`
Expected: PASS. Also run the 2 untested probes once to confirm they still emit valid JSON: `python3 whatsoup_spawn_config_probe.py >/dev/null && python3 q_namespace_lint.py >/dev/null && python3 bot_errors_proof_ladder.py >/dev/null && echo "probes run OK"`.

- [ ] **Step 3: Checkpoint.** Expected: `suite green`, `guard: PASS`, `No findings.`

---

## Task 4: D1 — route `load_json` callers + bad-JSON safety

**Files (Modify):** `bot_errors_proof_ladder.py`, `whatsoup_alias_map.py`, `opencode_topology_export.py`, `runtime_doctor.py`

- [ ] **Step 1: Read every consumer of the 4 local `load_json` calls.** For `bot_errors_proof_ladder.py` and `whatsoup_alias_map.py` (currently unguarded `json.loads(path.read_text())`), find each call site and the code that uses its return value. Confirm whether it would mishandle a `{"_error": ...}` dict (e.g. iterate keys as data). Record findings inline in the task.

- [ ] **Step 2: Write a failing guard test** for the consumer that needs an `_error` check (if any). If a consumer mishandles `_error`, add a test asserting it skips/flags the marker. If all consumers already tolerate an unexpected dict shape, note "no consumer change needed" and skip to Step 3.

```python
# tests/test_<probe>.py — add:
def test_malformed_input_json_does_not_crash_and_is_flagged():
    # build a fixture repo/dir with a malformed JSON the probe reads, run build_report,
    # assert the probe returns a structured result (not an exception) and marks the
    # bad input (e.g. parse_status/_error), never emitting raw bytes.
    ...
```

- [ ] **Step 3: Replace the 4 local `load_json` defs/calls** with `from probelib import load_json` and route call sites through it. For the 2 previously-unguarded callers, add an explicit `if isinstance(x, dict) and "_error" in x:` branch wherever the parsed value is consumed, producing a structured "invalid input" result.

- [ ] **Step 4: Run the affected probe tests + new bad-JSON test.** Expected: PASS, no crash on malformed input.

- [ ] **Step 5: Checkpoint.** Expected: `suite green`, `guard: PASS`, `No findings.`

---

## Task 5: `run()` consolidation (behavior-preserving timeouts)

**Files (Modify):** `opencode_topology_export.py` (t=30), `runtime_doctor.py` (t=20), `pi_presence_probe.py` (t=10)

- [ ] **Step 1:** In each, delete the local `run` def and add `run` to its probelib import. At **every** call site, pass the original timeout explicitly, e.g. `run([...], timeout=30)` in `opencode_topology_export.py`, `timeout=10` in `pi_presence_probe.py`. (probelib's `run` default is 20; explicit args preserve each probe's prior behavior.)

- [ ] **Step 2: Run affected probe tests** (`runtime_doctor`, `opencode_topology_export` have tests; `pi_presence_probe` — run it: `python3 pi_presence_probe.py >/dev/null && echo OK`).
Expected: PASS / OK.

- [ ] **Step 3: Checkpoint.** Expected: `suite green`, `guard: PASS`, `No findings.`

---

## Task 6: corpus_guard — `redaction_discipline` (HIGH)

**Files:** Modify `corpus_guard.py`; create/extend `tests/test_corpus_guard.py`

- [ ] **Step 1: Write failing test** in `tests/test_corpus_guard.py`

```python
#!/usr/bin/env python3
import os, sys, tempfile
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from corpus_guard import check_probe_hygiene  # noqa: E402

def _probe_dir(files: dict) -> Path:
    d = Path(tempfile.mkdtemp(prefix="guard-test-")); (d / "tests").mkdir()
    for name, body in files.items(): (d / name).write_text(body, encoding="utf-8")
    return d

def test_redaction_discipline_flags_value_emitter_without_redact_or_banner():
    d = _probe_dir({"naked_probe.py": "import json\nprint(json.dumps({'x': open('/etc/x').read()}))\n",
                    "probelib.py": "def redact(v,k=''):\n    return v\n"})
    res = check_probe_hygiene(d)
    kinds = {v["kind"] for v in res["violations"]}
    assert "missing_redaction_posture" in kinds, res

def test_redaction_discipline_passes_when_banner_present():
    d = _probe_dir({"ok_probe.py": 'X = {"redaction": "metadata-only"}\nimport json\nprint(json.dumps(X))\n',
                    "probelib.py": "def redact(v,k=''):\n    return v\n"})
    res = check_probe_hygiene(d)
    kinds = {v["kind"] for v in res["violations"]}
    assert "missing_redaction_posture" not in kinds, res

if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns: fn(); print("PASS", fn.__name__)
    print(f"\nall {len(fns)} corpus_guard tests passed")
```

- [ ] **Step 2: Run to verify it fails** — `python3 tests/test_corpus_guard.py` → FAIL (`missing_redaction_posture` not produced).

- [ ] **Step 3: Implement in `check_probe_hygiene`** — inside the per-probe loop add a `missing_posture` collector; after the loop append the violation:

```python
# in the loop (p not in LIBRARIES):
if "probelib" not in text and '"redaction"' not in text and "'redaction'" not in text:
    missing_posture.append(p.name)
# after the loop:
if missing_posture:
    violations.append({"kind": "missing_redaction_posture", "severity": "high",
                       "note": "value-emitting probe must import probelib.redact or carry a \"redaction\" banner",
                       "probes": missing_posture})
```
(Initialize `missing_posture = []` with the other accumulators. Update the check's overall `severity` to `"high"` when this violation is present so a real violation fails the gate.)

- [ ] **Step 4: Run to verify it passes** — `python3 tests/test_corpus_guard.py` → PASS.

- [ ] **Step 5: Checkpoint.** Expected: `suite green`, `guard: PASS` (real suite still passes — all probes import probelib or carry banners), `No findings.`

---

## Task 7: corpus_guard — `schema_version_consistency` (MED)

**Files:** Modify `corpus_guard.py`; extend `tests/test_corpus_guard.py`

- [ ] **Step 1: Add failing test:**

```python
def test_schema_version_consistency_flags_malformed():
    d = _probe_dir({"badver.py": 'SCHEMA_VERSION = "v1"\nimport json\nprint(json.dumps({"schema_version": "v1", "redaction":"metadata-only"}))\n',
                    "probelib.py": "def redact(v,k=''):\n    return v\n"})
    res = check_probe_hygiene(d)
    kinds = {v["kind"] for v in res["violations"]}
    assert "schema_version_malformed" in kinds, res
```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement** — in the loop, when a probe has a `schema_version`, extract the literal and check `re.search(r'schema_version["\']?\s*[:=]\s*["\'](\d+\.\d+)["\']', text)`; if a `schema_version` token exists but no `\d+\.\d+` literal matches, add `{"kind": "schema_version_malformed", "severity": "medium", "probes": [...]}`.

- [ ] **Step 4:** Run → PASS.

- [ ] **Step 5: Checkpoint.** Expected: `suite green`, `guard: PASS` (all real probes are `0.x`), `No findings.`

---

## Task 8: corpus_guard — `readme_drift` (MED)

**Files:** Modify `corpus_guard.py`; extend `tests/test_corpus_guard.py`

- [ ] **Step 1: Add failing test:**

```python
def test_readme_drift_flags_probe_missing_from_readme():
    d = _probe_dir({"lonely_probe.py": 'print("{}")\n',
                    "probelib.py": "def redact(v,k=''):\n    return v\n",
                    "README.md": "| `probelib.py` | lib | No |\n"})
    res = check_probe_hygiene(d)
    kinds = {v["kind"] for v in res["violations"]}
    assert "readme_drift" in kinds, res
```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement** — read `probe_dir/"README.md"` if present; collect probe basenames referenced in it (regex `` `([a-z0-9_]+\.py)` ``). For each non-library probe not referenced → drift; for each referenced name with no file → orphan. Append `{"kind": "readme_drift", "severity": "medium", "missing_from_readme": [...], "orphan_rows": [...]}` if any. (If README.md absent, skip — no violation.)

- [ ] **Step 4:** Run → PASS. Then verify the **real** README has no drift: `python3 corpus_guard.py | python3 -c 'import sys,json;[print(v) for c in json.load(sys.stdin)["checks"] if c["name"]=="probe_hygiene" for v in c["violations"]]'` → expect no `readme_drift` (if there is, add the missing rows to `README.md` — that is in-scope cleanup for this task).

- [ ] **Step 5: Final checkpoint + full verification:**

```bash
cd /Users/testuser/agent-runtime-probes
for t in tests/test_*.py; do python3 "$t" >/dev/null && echo "PASS $t" || echo "FAIL $t"; done
python3 corpus_guard.py --pretty | python3 -c 'import sys,json;d=json.load(sys.stdin);print("VERDICT",d["summary"]["verdict"]);[print(" ",c["name"],c["status"]) for c in d["checks"]]'
/Users/testuser/.claude/plugins/test-integrity/scripts/test-integrity scan tests
```
Expected: all tests PASS, `VERDICT PASS`, all three checks `pass`, `No findings.`

---

## Self-review notes
- Spec coverage: Part-1 git_head(T1,T3)/sha256_16(T1,T2)/run(T5)/load_json+D1(T4); Part-2 P3(T6)/P4(T7)/P7(T8); testing throughout. All spec sections mapped.
- Behavior preservation guarded by keeping every existing probe test green after each task.
- No `git commit` steps — `/Users/testuser` is not a repo; checkpoint = guard+suite+test-integrity green.
