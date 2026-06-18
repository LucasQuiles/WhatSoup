#!/usr/bin/env python3
"""Tests for Q namespace lint: classification branches, doc discovery, scan
happy/unhappy paths, main() report shape, and CLI e2e.

No pytest fixtures. Manual monkeypatch via setattr + try/finally. Filesystem and
probelib seams (HOME, git_head) are swapped to keep the probe metadata-only and
fully offline. Assertions check OUTCOMES (counts, classifications, report shape),
not mere execution.
"""
import io
import json
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import q_namespace_lint as probe  # noqa: E402
from q_namespace_lint import (  # noqa: E402
    classify,
    doc_paths,
    rel,
    scan_path,
    short_snippet,
)

PROBE_PATH = Path(__file__).resolve().parent.parent / "q_namespace_lint.py"


# --- rel() -----------------------------------------------------------------

def test_rel_strips_home_prefix_when_under_home():
    orig_home = probe.HOME
    probe.HOME = Path("/Users/example")
    try:
        assert rel(Path("/Users/example/AGENT-RUNTIME-TOPOLOGY.md")) == "AGENT-RUNTIME-TOPOLOGY.md"
    finally:
        probe.HOME = orig_home


def test_rel_returns_absolute_when_outside_home():
    orig_home = probe.HOME
    probe.HOME = Path("/Users/example")
    try:
        # ValueError branch: path is not relative to HOME.
        assert rel(Path("/var/tmp/elsewhere.md")) == "/var/tmp/elsewhere.md"
    finally:
        probe.HOME = orig_home


# --- short_snippet() -------------------------------------------------------

def test_short_snippet_collapses_whitespace_and_truncates():
    raw = "  the\tquick   brown\nfox " + ("x" * 400)
    out = short_snippet(raw)
    assert out.startswith("the quick brown fox ")
    assert "\t" not in out and "\n" not in out
    assert len(out) == 220  # truncated to the 220-char cap


# --- classify() branches ---------------------------------------------------
# rel() needs a HOME for path_text; use a stable HOME for these.

def _with_home(fn, home="/Users/example"):
    orig = probe.HOME
    probe.HOME = Path(home)
    try:
        return fn()
    finally:
        probe.HOME = orig


def test_classify_namespace_meta_reference():
    # meta hint present; no host, no control.
    cls = _with_home(lambda: classify(Path("/Users/example/AGENT-RUNTIME-TOPOLOGY.md"),
                                      "Discussion of the Q namespace audit and bare Q handling."))
    assert cls == "namespace_meta_reference", cls


def test_classify_q_host_explicit():
    # host cue (/Users/testuser), no control cue, no meta cue.
    cls = _with_home(lambda: classify(Path("/Users/example/AGENT-RUNTIME-TOPOLOGY.md"),
                                      "The agent runs from /Users/testuser on this Mac."))
    assert cls == "q_host_explicit", cls


def test_classify_bot_errors_control_plane_explicit_via_line_hint():
    # control cue via BOT_ERRORS_HINT (q-loop) in the LINE, no host cue, no meta.
    cls = _with_home(lambda: classify(Path("/Users/example/AGENT-RUNTIME-TOPOLOGY.md"),
                                      "Heartbeat handled by the q-loop dispatcher."))
    assert cls == "bot_errors_control_plane_explicit", cls


def test_classify_control_plane_via_path_hint_even_for_neutral_line():
    # control cue via PATH hint (bot-errors-q-loop.py); line itself has no host/control words.
    line = "def main():"  # plain line, but path forces control classification
    cls = _with_home(lambda: classify(Path("/Users/example/LAB/WhatSoup/deploy/scripts/bot-errors-q-loop.py"),
                                      line))
    assert cls == "bot_errors_control_plane_explicit", cls


def test_classify_mixed_q_host_and_control_plane():
    # both host (/Users/testuser) and control (q-loop) cues on one line.
    cls = _with_home(lambda: classify(Path("/Users/example/AGENT-RUNTIME-TOPOLOGY.md"),
                                      "The /Users/testuser workstation also feeds the q-loop dispatcher."))
    assert cls == "mixed_q_host_and_control_plane", cls


def test_classify_bare_q_candidate_when_no_cues():
    # No host, control, or meta cues — ambiguous bare reference.
    cls = _with_home(lambda: classify(Path("/Users/example/AGENT-RUNTIME-TOPOLOGY.md"),
                                      "Ownership transfers to Q before the next step."))
    assert cls == "bare_q_candidate", cls


def test_classify_meta_plus_host_is_not_meta():
    # meta hint AND host hint => host wins (meta branch requires NOT host AND NOT control).
    cls = _with_home(lambda: classify(Path("/Users/example/AGENT-RUNTIME-TOPOLOGY.md"),
                                      "Q namespace notes for this workstation."))
    assert cls == "q_host_explicit", cls


# --- doc_paths() -----------------------------------------------------------

def test_doc_paths_globs_agent_runtime_docs_and_skips_directories():
    with tempfile.TemporaryDirectory(prefix="q-nslint-home-") as tmp:
        home = Path(tmp)
        keep = home / "AGENT-RUNTIME-TOPOLOGY.md"
        keep.write_text("Q\n")
        other = home / "AGENT-RUNTIME-NOTES.md"
        other.write_text("Q\n")
        # A directory that matches the glob must be excluded (is_file() filter).
        (home / "AGENT-RUNTIME-dir.md").mkdir()
        # A non-matching file must be ignored.
        (home / "README.md").write_text("Q\n")
        orig_home = probe.HOME
        probe.HOME = home
        try:
            paths = doc_paths(include_whatsoup=False)
        finally:
            probe.HOME = orig_home
    names = sorted(p.name for p in paths)
    assert names == ["AGENT-RUNTIME-NOTES.md", "AGENT-RUNTIME-TOPOLOGY.md"], names


def test_doc_paths_includes_existing_whatsoup_refs_only():
    with tempfile.TemporaryDirectory(prefix="q-nslint-home-") as tmp:
        home = Path(tmp)
        # one AGENT-RUNTIME doc
        (home / "AGENT-RUNTIME-TOPOLOGY.md").write_text("Q\n")
        # create exactly one of the WhatSoup refs so the missing ones are filtered out
        ws = home / "LAB/WhatSoup/deploy/scripts"
        ws.mkdir(parents=True)
        (ws / "bot-errors-q-loop.py").write_text("# q-loop\n")
        orig_home = probe.HOME
        probe.HOME = home
        try:
            with_ws = doc_paths(include_whatsoup=True)
            without_ws = doc_paths(include_whatsoup=False)
        finally:
            probe.HOME = orig_home
    with_names = sorted(p.name for p in with_ws)
    assert with_names == ["AGENT-RUNTIME-TOPOLOGY.md", "bot-errors-q-loop.py"], with_names
    # the four other WhatSoup refs do not exist, so they are NOT included
    assert sorted(p.name for p in without_ws) == ["AGENT-RUNTIME-TOPOLOGY.md"]


# --- scan_path() happy path ------------------------------------------------

def test_scan_path_emits_one_mention_per_q_line_with_classification():
    with tempfile.TemporaryDirectory(prefix="q-nslint-") as tmp:
        doc = Path(tmp) / "AGENT-RUNTIME-TOPOLOGY.md"
        doc.write_text(
            "This line mentions Q ambiguously.\n"      # bare_q_candidate
            "Q's Mac is this workstation host.\n"      # q_host_explicit
            "The q-loop dispatcher heals errors.\n"    # bot_errors_control_plane_explicit
            "A line with no relevant token at all.\n"  # no Q match -> skipped
        )
        orig_home = probe.HOME
        probe.HOME = Path(tmp)
        try:
            mentions = scan_path(doc)
        finally:
            probe.HOME = orig_home
    assert len(mentions) == 3, mentions
    assert [m["line"] for m in mentions] == [1, 2, 3]
    assert [m["classification"] for m in mentions] == [
        "bare_q_candidate",
        "q_host_explicit",
        "bot_errors_control_plane_explicit",
    ]
    assert mentions[0]["snippet"] == "This line mentions Q ambiguously."


def test_scan_path_skips_lines_without_q_token():
    with tempfile.TemporaryDirectory(prefix="q-nslint-") as tmp:
        doc = Path(tmp) / "AGENT-RUNTIME-TOPOLOGY.md"
        # "Quick", "Quality" must NOT match (Q followed by a letter); "Equator" embeds Q internally.
        doc.write_text("Quick Quality Equator strings only.\nNo bare token here.\n")
        mentions = scan_path(doc)
    assert mentions == [], mentions


def test_scan_path_reports_read_error_marker_for_missing_path():
    with tempfile.TemporaryDirectory(prefix="q-namespace-lint-test-") as tmp_dir:
        missing = Path(tmp_dir) / "missing.md"
        mentions = scan_path(missing)

    assert mentions == [
        {
            "path": str(missing),
            "line": None,
            "classification": "read_error",
            "snippet": "",
            "error_type": "FileNotFoundError",
        }
    ], mentions


def test_scan_path_reports_read_error_for_unreadable_directory_target():
    # Reading a directory raises OSError (IsADirectoryError) -> fail-closed marker.
    with tempfile.TemporaryDirectory(prefix="q-nslint-") as tmp:
        d = Path(tmp) / "sub"
        d.mkdir()
        mentions = scan_path(d)
    assert len(mentions) == 1
    assert mentions[0]["classification"] == "read_error"
    assert mentions[0]["line"] is None
    assert mentions[0]["error_type"] == "IsADirectoryError"


# --- main() report shape ---------------------------------------------------

def _run_main(argv, home):
    """Run main() with a controlled HOME, stubbed git_head, and argv; return parsed report."""
    orig_home, orig_argv, orig_git = probe.HOME, sys.argv, probe.git_head
    probe.HOME = home
    probe.git_head = lambda repo: "deadbeef synthetic head"
    sys.argv = ["q_namespace_lint.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        probe.HOME, sys.argv, probe.git_head = orig_home, orig_argv, orig_git
    return rc, json.loads(buf.getvalue())


def test_main_counts_paths_classifications_and_top_paths():
    with tempfile.TemporaryDirectory(prefix="q-nslint-home-") as tmp:
        home = Path(tmp)
        doc = home / "AGENT-RUNTIME-TOPOLOGY.md"
        doc.write_text(
            "Ownership transfers to Q here.\n"          # bare_q_candidate
            "Q's Mac is this workstation host.\n"        # q_host_explicit
            "The q-loop dispatcher heals errors.\n"     # bot_errors_control_plane_explicit
        )
        rc, report = _run_main(["--no-whatsoup"], home)

    assert rc == 0
    assert report["schema"] == "q-namespace-lint-report"
    assert report["schema_version"] == "0.1"
    assert report["what_soup_head"] == "deadbeef synthetic head"
    assert report["scanned_path_count"] == 1
    assert report["mention_count"] == 3
    assert report["summary"]["by_classification"] == {
        "bare_q_candidate": 1,
        "bot_errors_control_plane_explicit": 1,
        "q_host_explicit": 1,
    }
    assert report["summary"]["read_error_count"] == 0
    assert report["summary"]["top_paths"] == {"AGENT-RUNTIME-TOPOLOGY.md": 3}
    # verdict dictionary documents every classification key emitted
    for cls in report["summary"]["by_classification"]:
        assert cls in report["verdict"]


def test_main_counts_read_errors_into_summary():
    with tempfile.TemporaryDirectory(prefix="q-nslint-home-") as tmp:
        home = Path(tmp)
        # A directory matching the glob is is_file()-filtered out of doc_paths, so to
        # force a read_error we make a real file then turn it unreadable via read stub.
        doc = home / "AGENT-RUNTIME-TOPOLOGY.md"
        doc.write_text("Q\n")
        orig_read = Path.read_text

        def boom(self, *a, **k):
            if self.name == "AGENT-RUNTIME-TOPOLOGY.md":
                raise PermissionError("denied")
            return orig_read(self, *a, **k)

        Path.read_text = boom
        try:
            rc, report = _run_main(["--no-whatsoup"], home)
        finally:
            Path.read_text = orig_read

    assert rc == 0
    assert report["scanned_path_count"] == 1
    assert report["mention_count"] == 1
    assert report["summary"]["read_error_count"] == 1
    assert report["summary"]["by_classification"] == {"read_error": 1}


def test_main_emits_pretty_json_when_flag_set():
    with tempfile.TemporaryDirectory(prefix="q-nslint-home-") as tmp:
        home = Path(tmp)
        (home / "AGENT-RUNTIME-TOPOLOGY.md").write_text("Mentions Q here.\n")
        orig_home, orig_argv, orig_git = probe.HOME, sys.argv, probe.git_head
        probe.HOME = home
        probe.git_head = lambda repo: None
        sys.argv = ["q_namespace_lint.py", "--no-whatsoup", "--pretty"]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = probe.main()
        finally:
            probe.HOME, sys.argv, probe.git_head = orig_home, orig_argv, orig_git
    raw = buf.getvalue()
    assert rc == 0
    # pretty => indented multi-line output
    assert "\n  " in raw
    report = json.loads(raw)
    assert report["what_soup_head"] is None
    assert report["mention_count"] == 1


def test_main_empty_when_no_docs_present():
    with tempfile.TemporaryDirectory(prefix="q-nslint-home-") as tmp:
        home = Path(tmp)  # no AGENT-RUNTIME docs at all
        rc, report = _run_main(["--no-whatsoup"], home)
    assert rc == 0
    assert report["scanned_path_count"] == 0
    assert report["mention_count"] == 0
    assert report["summary"]["by_classification"] == {}
    assert report["summary"]["top_paths"] == {}


# --- CLI e2e ---------------------------------------------------------------

def test_cli_entrypoint_emits_valid_json():
    # e2e: covers the `if __name__ == "__main__"` entrypoint + real json.dump path.
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--no-whatsoup"],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["schema"] == "q-namespace-lint-report"
    assert "verdict" in report and "summary" in report
    assert isinstance(report["scanned_path_count"], int)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} q_namespace_lint tests passed")
