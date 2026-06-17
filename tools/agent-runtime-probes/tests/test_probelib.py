#!/usr/bin/env python3
"""Tests for shared probe helpers and bad-JSON consumer behavior."""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bot_errors_proof_ladder import managed_component_names, runtime_manifest_files  # noqa: E402
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


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} probelib tests passed")
