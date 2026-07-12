"""Tests for the bot-errors tree-provenance guard (gap-matrix class 2).

Builds throwaway git repos with ``git init`` + commits to exercise each
provenance case:

  * clean-and-pushed       -> no finding (info)
  * dirty                  -> warning (CHECK_DIRTY)
  * ahead-of-upstream      -> warning (CHECK_AHEAD)        [the hub-32 shape]
  * on-main-ahead          -> critical (CHECK_DIRECT_TO_PROTECTED)
  * diverged history       -> critical (CHECK_DIVERGED)
  * detached HEAD          -> critical (CHECK_DIVERGED)
  * phantom untracked .ts  -> info (CHECK_PHANTOM_SRC)

A bare repo stands in for "origin" so ``@{u}`` resolves offline; no network is
ever used.  No real phone numbers / paths leak: evidence is asserted on
redacted (basename + fingerprint) shapes only.
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess

import pytest


_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-tree-provenance.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_tree_provenance", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()


# ---------------------------------------------------------------------------
# git fixture helpers
# ---------------------------------------------------------------------------
# Author identity uses a domainless local handle so it carries no TLD and the
# repo-hygiene personal-email regex (which requires "@domain.tld") never trips.
_FIXTURE_HANDLE = "fixture@local"
_GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "Fixture",
    "GIT_AUTHOR_EMAIL": _FIXTURE_HANDLE,
    "GIT_COMMITTER_NAME": "Fixture",
    "GIT_COMMITTER_EMAIL": _FIXTURE_HANDLE,
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_SYSTEM": "/dev/null",
}


def _git(repo: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=_GIT_ENV,
        check=True,
    )
    return proc.stdout.strip()


def _commit(repo: Path, name: str, content: str) -> None:
    (repo / name).write_text(content, encoding="utf-8")
    _git(repo, "add", name)
    _git(repo, "commit", "-m", f"add {name}")


def _make_origin_and_clone(tmp_path: Path, branch: str = "main") -> tuple[Path, Path]:
    """Create a bare 'origin' and a working clone tracking ``branch``."""
    origin = tmp_path / "origin.git"
    origin.mkdir()
    _git(origin, "init", "--bare", "--initial-branch", branch)

    work = tmp_path / "work"
    work.mkdir()
    _git(work, "init", "--initial-branch", branch)
    _git(work, "remote", "add", "origin", str(origin))
    _commit(work, "README.md", "base\n")
    _git(work, "push", "-u", "origin", branch)
    return origin, work


def _snap(repo: Path) -> dict:
    return _mod.gather_tree_provenance(repo, do_fetch=False)


def _checks(findings) -> set[str]:
    return {f["check"] for f in findings}


def _sev_for(findings, check) -> str:
    for f in findings:
        if f["check"] == check:
            return f["severity"]
    raise AssertionError(f"no finding for {check}: {findings}")


# ---------------------------------------------------------------------------
# clean-and-pushed -> no finding
# ---------------------------------------------------------------------------
def test_clean_and_pushed_no_finding(tmp_path: Path):
    _, work = _make_origin_and_clone(tmp_path, branch="develop")
    snap = _snap(work)
    findings = _mod.provenance_findings(snap)
    assert findings == [], findings
    assert snap["ancestry"] == "same"
    assert snap["ahead"] == 0
    assert _mod.overall_severity(findings) == "info"


# ---------------------------------------------------------------------------
# dirty -> warning
# ---------------------------------------------------------------------------
def test_dirty_tree_warns(tmp_path: Path):
    _, work = _make_origin_and_clone(tmp_path, branch="develop")
    # Uncommitted runtime change.
    (work / "README.md").write_text("base\nMUTATED\n", encoding="utf-8")
    snap = _snap(work)
    findings = _mod.provenance_findings(snap)
    assert _mod.CHECK_DIRTY in _checks(findings)
    assert _sev_for(findings, _mod.CHECK_DIRTY) == "warning"
    assert snap["dirty_count"] >= 1


# ---------------------------------------------------------------------------
# ahead-of-upstream (non-protected branch) -> warning  [hub-32 shape]
# ---------------------------------------------------------------------------
def test_ahead_of_upstream_warns(tmp_path: Path):
    _, work = _make_origin_and_clone(tmp_path, branch="develop")
    # Local commit not pushed -> ahead of @{u}, branch is not protected.
    _commit(work, "feature.txt", "local only\n")
    snap = _snap(work)
    findings = _mod.provenance_findings(snap)
    assert snap["ahead"] == 1
    assert snap["ancestry"] == "ahead"
    assert _mod.CHECK_AHEAD in _checks(findings)
    assert _sev_for(findings, _mod.CHECK_AHEAD) == "warning"
    # Not on a protected branch -> NOT critical.
    assert _mod.CHECK_DIRECT_TO_PROTECTED not in _checks(findings)


# ---------------------------------------------------------------------------
# on-main-ahead -> critical (the exact hub-32 divergence)
# ---------------------------------------------------------------------------
def test_on_main_ahead_is_critical(tmp_path: Path):
    _, work = _make_origin_and_clone(tmp_path, branch="main")
    # Commit directly on main, do not push: the nucles hub-32 anti-pattern.
    for i in range(3):
        _commit(work, f"direct-{i}.txt", f"unpushed {i}\n")
    snap = _snap(work)
    findings = _mod.provenance_findings(snap)
    assert snap["branch"] == "main"
    assert snap["protected_branch"] is True
    assert snap["ahead"] == 3
    assert _mod.CHECK_DIRECT_TO_PROTECTED in _checks(findings)
    assert _sev_for(findings, _mod.CHECK_DIRECT_TO_PROTECTED) == "critical"
    assert _mod.overall_severity(findings) == "critical"
    # The plain "ahead" warning must NOT also fire (no double-emit).
    assert _mod.CHECK_AHEAD not in _checks(findings)


def test_master_also_protected(tmp_path: Path):
    _, work = _make_origin_and_clone(tmp_path, branch="master")
    _commit(work, "direct.txt", "unpushed\n")
    snap = _snap(work)
    findings = _mod.provenance_findings(snap)
    assert _mod.CHECK_DIRECT_TO_PROTECTED in _checks(findings)
    assert _sev_for(findings, _mod.CHECK_DIRECT_TO_PROTECTED) == "critical"


# ---------------------------------------------------------------------------
# diverged history -> critical
# ---------------------------------------------------------------------------
def test_diverged_history_is_critical(tmp_path: Path):
    origin, work = _make_origin_and_clone(tmp_path, branch="develop")
    # Advance origin via a second clone, then rewrite local history so neither
    # is an ancestor of the other.
    other = tmp_path / "other"
    other.mkdir()
    _git(other, "clone", str(origin), ".")
    _commit(other, "remote-side.txt", "from elsewhere\n")
    _git(other, "push", "origin", "develop")

    # Local: amend the base commit (rewrite) + add a divergent commit, then
    # refresh the remote-tracking ref WITHOUT merging.
    _commit(work, "local-side.txt", "diverged local\n")
    _git(work, "commit", "--amend", "-m", "rewritten base", "--no-edit")
    _git(work, "fetch", "origin")  # local fetch from on-disk bare repo, no net

    snap = _snap(work)
    findings = _mod.provenance_findings(snap)
    assert snap["ancestry"] == "diverged"
    assert snap["ahead"] > 0 and snap["behind"] > 0
    assert _mod.CHECK_DIVERGED in _checks(findings)
    assert _sev_for(findings, _mod.CHECK_DIVERGED) == "critical"


# ---------------------------------------------------------------------------
# detached HEAD -> critical
# ---------------------------------------------------------------------------
def test_detached_head_is_critical(tmp_path: Path):
    _, work = _make_origin_and_clone(tmp_path, branch="develop")
    _commit(work, "second.txt", "second\n")
    head = _git(work, "rev-parse", "HEAD")
    _git(work, "checkout", "--detach", head)
    snap = _snap(work)
    findings = _mod.provenance_findings(snap)
    assert snap["detached"] is True
    assert _mod.CHECK_DIVERGED in _checks(findings)
    assert _sev_for(findings, _mod.CHECK_DIVERGED) == "critical"


# ---------------------------------------------------------------------------
# phantom untracked .ts under src/ -> info (advisory)
# ---------------------------------------------------------------------------
def test_phantom_untracked_ts_is_advisory(tmp_path: Path):
    _, work = _make_origin_and_clone(tmp_path, branch="develop")
    src = work / "src"
    src.mkdir()
    (src / "ghost.ts").write_text("export const ghost = 1;\n", encoding="utf-8")
    snap = _snap(work)
    findings = _mod.provenance_findings(snap)
    assert _mod.CHECK_PHANTOM_SRC in _checks(findings)
    assert _sev_for(findings, _mod.CHECK_PHANTOM_SRC) == "info"
    assert snap["phantom_src"] == ["src/ghost.ts"]


# ---------------------------------------------------------------------------
# inventory line shape + redaction (composes with daily-health classifier)
# ---------------------------------------------------------------------------
def test_inventory_lines_use_fail_warn_prefixes(tmp_path: Path, monkeypatch):
    _, work = _make_origin_and_clone(tmp_path, branch="main")
    _commit(work, "direct.txt", "unpushed\n")
    monkeypatch.setattr(_mod, "REPO_ROOT", work.resolve())
    lines = _mod.tree_provenance_inventory({"expectTreeProvenance": True}, do_fetch=False)
    # Critical -> FAIL prefix so the health-check classifier counts it.
    assert any(line.startswith("FAIL tree_provenance ") for line in lines), lines
    # Instance token is the branch (second token after the prefix), never a path.
    fail_line = next(l for l in lines if l.startswith("FAIL "))
    body = fail_line[len("FAIL "):]
    tokens = body.split()
    assert tokens[0] == "tree_provenance"
    # branch token must not contain a path separator
    branch_token = tokens[1].rstrip(":")
    assert "/" not in branch_token and os.sep not in branch_token


def test_inventory_clean_line_no_fail(tmp_path: Path, monkeypatch):
    _, work = _make_origin_and_clone(tmp_path, branch="develop")
    monkeypatch.setattr(_mod, "REPO_ROOT", work.resolve())
    lines = _mod.tree_provenance_inventory({"expectTreeProvenance": True}, do_fetch=False)
    assert len(lines) == 1
    assert lines[0].startswith("tree_provenance ")
    assert "clean" in lines[0]
    assert not lines[0].startswith("FAIL ") and not lines[0].startswith("WARN ")


def test_inventory_profile_opt_out(tmp_path: Path):
    lines = _mod.tree_provenance_inventory({"expectTreeProvenance": False}, do_fetch=False)
    assert lines == ["tree_provenance: skipped by health profile"]


def test_inventory_default_is_opt_in(tmp_path: Path):
    # Matching the health-profile schema convention, the check is opt-in:
    # an empty profile must not inspect the tree (or warn) at all.
    lines = _mod.tree_provenance_inventory({}, do_fetch=False)
    assert lines == ["tree_provenance: skipped by health profile"]


def test_redaction_scrubs_long_digit_runs():
    # A branch/path with a >7-digit run must be scrubbed.
    out = _mod.redact_ref("feature/1234567890-thing")
    assert "1234567890" not in out
    seg = _mod.redact_path_segment("/tmp/wa/120363999999999000.ts")
    assert "120363999999999000" not in seg
    # basename retained shape, fingerprinted
    assert "@" in seg


# ---------------------------------------------------------------------------
# severity threshold configurability
# ---------------------------------------------------------------------------
def test_dirty_severity_configurable(tmp_path: Path, monkeypatch):
    _, work = _make_origin_and_clone(tmp_path, branch="develop")
    (work / "README.md").write_text("base\nMUTATED\n", encoding="utf-8")
    monkeypatch.setattr(_mod, "DIRTY_SEVERITY", "info")
    snap = _snap(work)
    findings = _mod.provenance_findings(snap)
    assert _sev_for(findings, _mod.CHECK_DIRTY) == "info"


def test_dirty_threshold_suppresses_below_count(tmp_path: Path, monkeypatch):
    _, work = _make_origin_and_clone(tmp_path, branch="develop")
    (work / "README.md").write_text("base\nMUTATED\n", encoding="utf-8")
    monkeypatch.setattr(_mod, "DIRTY_THRESHOLD", 5)
    snap = _snap(work)
    findings = _mod.provenance_findings(snap)
    assert _mod.CHECK_DIRTY not in _checks(findings)


# ---------------------------------------------------------------------------
# non-repo path raises GitError (caller degrades gracefully)
# ---------------------------------------------------------------------------
def test_non_repo_raises_git_error(tmp_path: Path):
    plain = tmp_path / "plain"
    plain.mkdir()
    with pytest.raises(_mod.GitError):
        _mod.gather_tree_provenance(plain, do_fetch=False)


# ---------------------------------------------------------------------------
# offline default: gather never invokes network (no fetch unless asked)
# ---------------------------------------------------------------------------
def test_offline_default_no_fetch(tmp_path: Path, monkeypatch):
    _, work = _make_origin_and_clone(tmp_path, branch="develop")
    called = {"fetch": False}

    def _boom(*a, **k):
        called["fetch"] = True
        return None

    monkeypatch.setattr(_mod, "fetch_upstream", _boom)
    _mod.gather_tree_provenance(work, do_fetch=False)
    assert called["fetch"] is False


# ---------------------------------------------------------------------------
# run_once exit codes + outbox emission format
# ---------------------------------------------------------------------------
def test_run_once_emits_critical_outbox_event(tmp_path: Path, monkeypatch):
    _, work = _make_origin_and_clone(tmp_path, branch="main")
    _commit(work, "direct.txt", "unpushed\n")
    state = tmp_path / "state"
    monkeypatch.setattr(_mod, "REPO_ROOT", work.resolve())
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(state))
    rc = _mod.run_once(do_fetch=False, dry=False)
    assert rc == 2  # critical
    outbox = state / "outbox"
    events = list(outbox.glob("*.json"))
    assert len(events) == 1
    import json

    payload = json.loads(events[0].read_text())
    assert payload["severity"] == "critical"
    assert payload["source"] == "tree-provenance"
    assert payload["schemaVersion"] == 1
    assert payload["eventType"] == "alert"
    assert "alertSource" in payload
    # No full repo path leaked in the event body.
    assert str(work) not in json.dumps(payload)


def test_run_once_clean_returns_zero_and_no_emit_when_dry(tmp_path: Path, monkeypatch):
    _, work = _make_origin_and_clone(tmp_path, branch="develop")
    state = tmp_path / "state"
    monkeypatch.setattr(_mod, "REPO_ROOT", work.resolve())
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(state))
    rc = _mod.run_once(do_fetch=False, dry=True)
    assert rc == 0
    assert not (state / "outbox").exists()


# ---------------------------------------------------------------------------
# --reporter scheduler mode + --no-optional-locks (B2)
# ---------------------------------------------------------------------------
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


def test_reporter_rejects_json(tmp_path: Path):
    # --json ignores reporter semantics (GitError -> 1, not 2), so the
    # combination is a usage error rather than a silently different contract.
    with pytest.raises(SystemExit) as exc:
        _mod.main(["--reporter", "--json"])
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
