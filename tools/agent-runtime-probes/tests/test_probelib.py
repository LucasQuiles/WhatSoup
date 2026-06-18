#!/usr/bin/env python3
"""Tests for shared probe helpers and bad-JSON consumer behavior."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bot_errors_proof_ladder import managed_component_names, runtime_manifest_files  # noqa: E402
import probelib  # noqa: E402
from probelib import git_head, load_json, sha256_16  # noqa: E402


def test_sha256_16_known_vector():
    assert sha256_16("abc") == "ba7816bf8f01cfea"
    assert len(sha256_16("abc")) == 16


def test_git_head_returns_commit_summary_and_none_outside_repo():
    with tempfile.TemporaryDirectory(prefix="probelib-git-test-") as tmp_dir:
        tmp = Path(tmp_dir)
        assert git_head(tmp) is None
        repo = tmp / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (repo / "file.txt").write_text("content\n", encoding="utf-8")
        subprocess.run(["git", "add", "file.txt"], cwd=repo, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(
            [
                "git",
                "-c",
                "user.name=Probe Test",
                "-c",
                "user.email=probe-test@example.invalid",
                "commit",
                "-m",
                "initial probe fixture",
            ],
            cwd=repo,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        head = git_head(repo)
        assert head is not None
        assert "initial probe fixture" in head


def test_load_json_good_and_bad_json():
    with tempfile.TemporaryDirectory(prefix="probelib-json-test-") as tmp_dir:
        tmp = Path(tmp_dir)
        good = tmp / "good.json"
        bad = tmp / "bad.json"
        good.write_text('{"ok": true}', encoding="utf-8")
        bad.write_text('{"broken":', encoding="utf-8")
        assert load_json(good) == {"ok": True}
        parsed_bad = load_json(bad)
        assert isinstance(parsed_bad, dict)
        assert "_error" in parsed_bad


def test_bad_json_consumers_do_not_emit_records():
    with tempfile.TemporaryDirectory(prefix="probelib-consumer-test-") as tmp_dir:
        repo = Path(tmp_dir)
        (repo / "deploy/health-profiles").mkdir(parents=True)
        (repo / "deploy/bot-errors-runtime-manifest.json").write_text("{bad", encoding="utf-8")
        (repo / "deploy/managed-components.json").write_text("{bad", encoding="utf-8")
        assert runtime_manifest_files(repo) == []
        assert managed_component_names(repo) == []


# --------------------------------------------------------------------------- #
# redact() — the estate-wide metadata-only guarantee rests on this function, yet it had NO
# direct coverage (every redaction-core eq/bool/not mutant survived the sweep). Pin the
# decision boundaries: a one-node logic flip must not make redaction fail OPEN (leak) or
# over-redact benign fields. See feedback_probelib_redact_field_name_clobber.
# --------------------------------------------------------------------------- #
def test_redact_sensitive_key_with_plaintext_value_fails_closed():
    # redact() decision is `sensitive_part(key) AND not _is_safe_key(key)` (L74). Removing the
    # `not` would redact a sensitive field ONLY when it is ALSO a safe key — i.e. NEVER for a
    # real secret field — leaking the value. A plaintext value (not matching SECRET_VALUE) under
    # a sensitive key MUST still be redacted by the KEY path (no value-regex safety net).
    assert probelib.redact("plaintext-not-a-regex-secret", "api_key") == "<redacted>"
    assert probelib.redact("hunter2", "password") == "<redacted>"


def test_redact_benign_key_and_value_passes_through():
    # Both `sensitive AND not safe` (L74) and `isinstance(str) AND SECRET_VALUE.search` (L81)
    # are conjunctions; an 'and'->'or' on either would over-redact. A benign key with a benign
    # value must pass through untouched (structure-preserving, no false redaction).
    assert probelib.redact("Alice", "name") == "Alice"          # L74 and->or would redact
    assert probelib.redact("hello world", "") == "hello world"  # L81 and->or would redact


def test_redact_allowlisted_safe_name_not_clobbered():
    # _is_safe_key is `lowered in SAFE_KEY_NAMES OR lowered.endswith(SAFE_KEY_SUFFIXES)` (L67).
    # An 'or'->'and' would drop the allowlist for any safe NAME not also ending in a safe
    # suffix, clobbering benign sensitive-looking fields. 'has_secret_word' is allowlisted,
    # contains the sensitive part 'secret', and does NOT end with a SAFE_KEY_SUFFIX.
    assert "has_secret_word" in probelib.SAFE_KEY_NAMES
    assert not any("has_secret_word".endswith(s) for s in probelib.SAFE_KEY_SUFFIXES)
    assert probelib.redact("hello", "has_secret_word") == "hello"


def test_redact_secret_value_under_benign_key_is_caught():
    # Value-shape defense (L81): a secret-LOOKING value is redacted regardless of key name, so
    # a leaked credential cannot hide under an innocuous field name.
    assert probelib.redact("sk-ABCDEFGH12345678", "note") == "<redacted:value>"
    assert probelib.redact({"k": "ghp_" + "A" * 24}, "outer") == {"k": "<redacted:value>"}


def test_load_toml_missing_returns_none_present_parses():
    # `if not path.exists(): return None` (L118): a missing file is a clean None, a present file
    # is parsed. Removing the `not` would invert the guard — return None for a present file and
    # try to open a missing one. Both directions are pinned.
    assert probelib.load_toml(Path("/nonexistent/does-not-exist.toml")) is None
    with tempfile.NamedTemporaryFile("w", suffix=".toml", delete=False) as f:
        f.write("a = 1\n")
        p = f.name
    try:
        assert probelib.load_toml(Path(p)) == {"a": 1}
    finally:
        os.unlink(p)


def test_du_present_path_returns_size_string():
    # `if not path.exists(): return None` (L128) + `... if out["rc"] == 0 else None` (L131): an
    # EXISTING path yields a non-empty size string. The L128 not-removal would return None for a
    # present path; the L131 ==->!= flip would route a successful (rc 0) du to the None branch.
    # Both are killed by requiring a real size string for an existing directory.
    assert probelib.du(Path("/nonexistent/zzz-no-such")) is None
    with tempfile.TemporaryDirectory() as d:
        size = probelib.du(Path(d))
        assert isinstance(size, str) and size


def test_sqlite_counts_real_db_counts_rows():
    # sqlite_counts guards on `not path.exists() or which("sqlite3") is None` (L135) and parses
    # `int(stdout) if rc == 0 and stdout.isdigit() else None` (L140). With a real db + the
    # sqlite3 CLI present: the L135 not-removal would return None for a VALID db, and the L140
    # ==->!= flip would route the successful (rc 0) query to the None branch. A known row count
    # pins both. (The two `or`/`and` bool flips at L135/L140 are EQUIVALENT — both guard
    # conditions lead to None whether short-circuited early or via the downstream error path.)
    import sqlite3 as _sql
    if shutil.which("sqlite3") is None:  # pragma: no cover - environment lacks the CLI
        return
    with tempfile.TemporaryDirectory() as d:
        dbp = Path(d) / "t.db"
        con = _sql.connect(str(dbp))
        con.execute("create table t (x integer)")
        con.executemany("insert into t values (?)", [(1,), (2,), (3,)])
        con.commit()
        con.close()
        assert probelib.sqlite_counts(dbp, ["t"]) == {"t": 3}
        assert probelib.sqlite_counts(Path(d) / "missing.db", ["t"]) is None


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} probelib tests passed")
