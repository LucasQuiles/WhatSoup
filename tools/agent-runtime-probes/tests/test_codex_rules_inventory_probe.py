#!/usr/bin/env python3
"""Tests for codex_rules_inventory_probe metadata redaction.

Unhappy-path focus: malformed rule lines, invalid parse states, missing/absent .rules
files, nonzero parse_error counts, error branches in parse_prefix_rule and token_family,
degraded file_summary paths, and CLI e2e exit code + JSON shape.
"""
import argparse
import io
import json
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from codex_rules_inventory_probe import (  # noqa: E402
    build_report,
    file_summary,
    find_rule_files,
    main,
    parse_prefix_rule,
    token_family,
)

PROBE_PATH = Path(__file__).resolve().parent.parent / "codex_rules_inventory_probe.py"


def write_rules(tmp: Path) -> Path:
    rules = tmp / "default.rules"
    rules.write_text(
        "\n".join(
            [
                'prefix_rule(pattern=["git", "commit"], decision="allow")',
                'prefix_rule(pattern=["ssh", "-q", "user@example.host", "cat /Users/testuser/private/.env"], decision="allow")',
                'prefix_rule(pattern=["/bin/zsh", "-lc", "source /Users/testuser/LAB/App/.env.local; curl https://example.com/?token=$SECRET_TOKEN"], decision="prompt")',
                'prefix_rule(pattern=["python3", "-c", "print(\'sk-shouldnotrender123456\')"], decision="deny")',
                "not_a_rule(",
            ]
        ),
        encoding="utf-8",
    )
    return rules


def test_rules_inventory_counts_decisions_and_flags():
    tmp = Path(tempfile.mkdtemp(prefix="codex-rules-probe-test-"))
    rules = write_rules(tmp)
    report = build_report(argparse.Namespace(rules_dir=str(tmp), rules_file=[str(rules)], pretty=False))

    assert report["schema"] == "agent-runtime-codex-rules-inventory", report
    assert report["schema_version"] == "0.1", report
    assert report["aggregate"]["rule_count"] == 4, report
    assert report["aggregate"]["parse_error_count"] == 1, report
    assert report["aggregate"]["decision_counts"] == {"allow": 2, "deny": 1, "prompt": 1}, report
    flags = report["aggregate"]["flag_counts"]
    assert flags["has_home_path"] >= 2, report
    assert flags["has_url"] == 1, report
    assert flags["has_account_like"] == 1, report
    assert flags["has_env_expansion"] == 1, report
    assert flags["has_secret_word"] >= 1, report


def test_rules_inventory_suppresses_raw_patterns():
    tmp = Path(tempfile.mkdtemp(prefix="codex-rules-probe-test-"))
    rules = write_rules(tmp)
    report = build_report(argparse.Namespace(rules_dir=str(tmp), rules_file=[str(rules)], pretty=False))
    rendered = json.dumps(report, sort_keys=True)

    for forbidden in [
        "user@example.host",
        "/Users/testuser/private/.env",
        "/Users/testuser/LAB/App/.env.local",
        "https://example.com",
        "$SECRET_TOKEN",
        "sk-shouldnotrender123456",
        "source /Users/testuser/LAB/App",
    ]:
        assert forbidden not in rendered, forbidden
    assert "pattern_sha256_16" in rendered, report
    assert "token_family_counts" in rendered, report


# ---------------------------------------------------------------------------
# parse_prefix_rule — unhappy paths for malformed / invalid rule lines
# ---------------------------------------------------------------------------

def test_parse_prefix_rule_invalid_not_call_returns_error():
    """A line that parses but is not a call expression returns error 'not_call'."""
    pattern, decision, error = parse_prefix_rule('"just_a_string"')
    assert pattern is None
    assert decision is None
    assert error == "not_call", error


def test_parse_prefix_rule_invalid_wrong_function_name_returns_not_prefix_rule():
    """A call to a function other than prefix_rule returns error 'not_prefix_rule'."""
    pattern, decision, error = parse_prefix_rule('other_rule(pattern=["git"], decision="allow")')
    assert pattern is None
    assert decision is None
    assert error == "not_prefix_rule", error


def test_parse_prefix_rule_invalid_syntax_error_returns_error():
    """A line with a syntax error returns a SyntaxError-class error string."""
    pattern, decision, error = parse_prefix_rule("prefix_rule(pattern=[, decision='allow')")
    assert pattern is None
    assert decision is None
    assert error is not None and error.startswith("SyntaxError"), error


def test_parse_prefix_rule_invalid_pattern_literal_eval_failed():
    """pattern= with a non-literal expression (variable ref) triggers parse error."""
    pattern, decision, error = parse_prefix_rule('prefix_rule(pattern=some_variable, decision="allow")')
    assert pattern is None
    assert decision is None
    assert error == "pattern_literal_eval_failed", error


def test_parse_prefix_rule_invalid_pattern_not_string_list():
    """pattern= with a list of non-strings triggers pattern_not_string_list error."""
    pattern, decision, error = parse_prefix_rule('prefix_rule(pattern=[1, 2, 3], decision="allow")')
    assert pattern is None
    assert decision is None
    assert error == "pattern_not_string_list", error


def test_parse_prefix_rule_invalid_decision_literal_eval_failed():
    """decision= with a non-literal expression triggers parse error."""
    pattern, decision, error = parse_prefix_rule('prefix_rule(pattern=["git"], decision=some_var)')
    assert pattern is None
    assert decision is None
    assert error == "decision_literal_eval_failed", error


def test_parse_prefix_rule_invalid_decision_not_string():
    """decision= with a non-string literal triggers decision_not_string error."""
    pattern, decision, error = parse_prefix_rule('prefix_rule(pattern=["git"], decision=42)')
    assert pattern is None
    assert decision is None
    assert error == "decision_not_string", error


def test_parse_prefix_rule_missing_pattern_returns_error():
    """A valid prefix_rule call with no pattern= kwarg returns missing_pattern error."""
    pattern, decision, error = parse_prefix_rule('prefix_rule(decision="allow")')
    assert pattern is None
    assert decision == "allow"
    assert error == "missing_pattern", error


def test_parse_prefix_rule_missing_decision_returns_error():
    """A valid prefix_rule call with no decision= kwarg returns missing_decision error."""
    pattern, decision, error = parse_prefix_rule('prefix_rule(pattern=["git"])')
    assert pattern == ["git"]
    assert decision is None
    assert error == "missing_decision", error


# ---------------------------------------------------------------------------
# token_family — coverage of branches not yet hit by existing tests
# ---------------------------------------------------------------------------

def test_token_family_home_path_users():
    """Tokens starting with /Users/ are classified as home_path."""
    result = token_family("/Users/alice/settings.json", 0)
    assert result == "home_path", result


def test_token_family_home_path_tilde():
    """Tokens starting with ~/ are classified as home_path."""
    result = token_family("~/mydir/file.txt", 1)
    assert result == "home_path", result


def test_token_family_tmp_path():
    """Tokens starting with /tmp/ are classified as tmp_path."""
    result = token_family("/tmp/scratch.log", 0)
    assert result == "tmp_path", result


def test_token_family_tmp_exact():
    """The exact token /tmp is classified as tmp_path."""
    result = token_family("/tmp", 0)
    assert result == "tmp_path", result


def test_token_family_device_path_dev_null():
    """The token /dev/null is classified as device_path."""
    result = token_family("/dev/null", 1)
    assert result == "device_path", result


def test_token_family_device_path_redirect_dev_null():
    """The token </dev/null is classified as device_path."""
    result = token_family("</dev/null", 1)
    assert result == "device_path", result


def test_token_family_env_expansion_dollar():
    """Tokens containing $VAR are classified as env_expansion (at non-zero index)."""
    result = token_family("$MY_VAR", 2)
    assert result == "env_expansion", result


def test_token_family_env_expansion_braces():
    """Tokens containing ${VAR} are classified as env_expansion."""
    result = token_family("${CONFIG_PATH}", 2)
    assert result == "env_expansion", result


def test_token_family_shell_snippet_semicolon():
    """Tokens containing semicolons are classified as shell_snippet."""
    result = token_family("echo hello; rm -rf /tmp/x", 2)
    assert result == "shell_snippet", result


def test_token_family_shell_snippet_pipe():
    """Tokens containing pipe characters are classified as shell_snippet."""
    result = token_family("cat file | grep word", 2)
    assert result == "shell_snippet", result


def test_token_family_sensitive_word_at_non_zero_index():
    """A non-flag, non-special token containing a secret keyword becomes sensitive_word."""
    result = token_family("mytoken", 2)
    assert result == "sensitive_word", result


def test_token_family_sensitive_word_key_variant():
    """A token containing 'key' at non-zero index is classified as sensitive_word."""
    result = token_family("apikey", 2)
    assert result == "sensitive_word", result


# ---------------------------------------------------------------------------
# file_summary — missing file and OSError (degraded / error paths)
# ---------------------------------------------------------------------------

def test_file_summary_missing_file_returns_exists_false():
    """file_summary for a nonexistent path returns exists=False with empty rules."""
    p = Path("/nonexistent-probe-test-dir-xyz/nope.rules")
    result = file_summary(p)
    assert result["exists"] is False, result
    assert result["rules"] == [], result
    assert result["parse_errors"] == [], result


def test_file_summary_oserror_on_read_sets_read_error():
    """If reading the file raises OSError, read_error field is set and rules is empty."""
    tmp = Path(tempfile.mkdtemp(prefix="codex-inv-oserr-"))
    p = tmp / "error.rules"
    p.write_text('prefix_rule(pattern=["git"], decision="allow")', encoding="utf-8")

    orig_read_text = Path.read_text

    def bad_read(self, *args, **kwargs):
        if self == p:
            raise OSError("simulated read failure")
        return orig_read_text(self, *args, **kwargs)

    Path.read_text = bad_read
    try:
        result = file_summary(p)
    finally:
        Path.read_text = orig_read_text

    assert "read_error" in result, result
    assert result["read_error"] == "OSError", result
    assert result["rules"] == [], result


def test_file_summary_skips_blank_and_comment_lines():
    """Blank lines and comment lines are skipped; only real rule lines are counted."""
    tmp = Path(tempfile.mkdtemp(prefix="codex-inv-skip-"))
    p = tmp / "sparse.rules"
    p.write_text(
        "\n".join([
            "",
            "# this is a comment",
            '   ',
            'prefix_rule(pattern=["python3"], decision="allow")',
        ]),
        encoding="utf-8",
    )
    result = file_summary(p)
    assert result["rule_count"] == 1, result
    assert result["parse_error_count"] == 0, result


def test_file_summary_parse_errors_recorded_for_invalid_malformed_lines():
    """Malformed rule lines produce entries in parse_errors with error_class field."""
    tmp = Path(tempfile.mkdtemp(prefix="codex-inv-errs-"))
    p = tmp / "badlines.rules"
    p.write_text(
        "\n".join([
            'not_prefix_rule()',
            'prefix_rule(pattern=[1,2], decision="allow")',
            'prefix_rule(pattern=["git"], decision=999)',
        ]),
        encoding="utf-8",
    )
    result = file_summary(p)
    assert result["parse_error_count"] == 3, result
    error_classes = {e["error_class"] for e in result["parse_errors"]}
    assert "not_prefix_rule" in error_classes, error_classes
    assert "pattern_not_string_list" in error_classes, error_classes
    assert "decision_not_string" in error_classes, error_classes


# ---------------------------------------------------------------------------
# find_rule_files — missing rules_dir and glob path (no explicit files)
# ---------------------------------------------------------------------------

def test_find_rule_files_missing_directory_returns_empty():
    """find_rule_files returns [] when the rules_dir does not exist."""
    missing = Path("/nonexistent-rules-dir-probe-xyz")
    result = find_rule_files(missing, [])
    assert result == [], result


def test_find_rule_files_existing_dir_returns_sorted_rules_files():
    """find_rule_files globs *.rules from an existing directory."""
    tmp = Path(tempfile.mkdtemp(prefix="codex-inv-find-"))
    (tmp / "alpha.rules").write_text('prefix_rule(pattern=["git"], decision="allow")', encoding="utf-8")
    (tmp / "beta.rules").write_text('prefix_rule(pattern=["npm"], decision="deny")', encoding="utf-8")
    (tmp / "not_rules.txt").write_text("ignored", encoding="utf-8")
    result = find_rule_files(tmp, [])
    names = [p.name for p in result]
    assert "alpha.rules" in names, names
    assert "beta.rules" in names, names
    assert "not_rules.txt" not in names, names


# ---------------------------------------------------------------------------
# main() — CLI entrypoint coverage
# ---------------------------------------------------------------------------

def test_main_with_empty_missing_rules_dir_exits_zero():
    """main() with a nonexistent rules_dir exits 0 and emits valid JSON with zero rules."""
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = main(["--rules-dir", "/nonexistent-rules-dir-probe-xyz"])
    assert rc == 0, rc
    report = json.loads(buf.getvalue())
    assert report["schema"] == "agent-runtime-codex-rules-inventory", report
    assert report["aggregate"]["rule_count"] == 0, report


def test_main_with_pretty_flag_emits_indented_json():
    """main() --pretty emits indented JSON output."""
    tmp = Path(tempfile.mkdtemp(prefix="codex-inv-main-pretty-"))
    p = tmp / "sample.rules"
    p.write_text('prefix_rule(pattern=["git"], decision="allow")', encoding="utf-8")
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = main(["--rules-dir", str(tmp), "--rules-file", str(p), "--pretty"])
    assert rc == 0, rc
    raw = buf.getvalue()
    assert "\n" in raw and "  " in raw, "expected indented output"
    report = json.loads(raw)
    assert report["aggregate"]["rule_count"] == 1, report


def test_main_rules_file_argument_overrides_directory():
    """--rules-file causes main() to read the named file, not directory glob."""
    tmp = Path(tempfile.mkdtemp(prefix="codex-inv-main-file-"))
    p = tmp / "explicit.rules"
    p.write_text('prefix_rule(pattern=["python3"], decision="deny")', encoding="utf-8")
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = main(["--rules-dir", "/nonexistent-rules-dir-probe-xyz", "--rules-file", str(p)])
    assert rc == 0, rc
    report = json.loads(buf.getvalue())
    assert report["aggregate"]["rule_count"] == 1, report
    assert report["aggregate"]["decision_counts"] == {"deny": 1}, report


# ---------------------------------------------------------------------------
# Determinism test
# ---------------------------------------------------------------------------

def test_build_report_is_deterministic():
    """build_report produces byte-identical JSON output on repeated calls with same input."""
    tmp = Path(tempfile.mkdtemp(prefix="codex-inv-det-"))
    p = tmp / "det.rules"
    p.write_text(
        "\n".join([
            'prefix_rule(pattern=["git", "commit"], decision="allow")',
            'prefix_rule(pattern=["python3", "-m", "pytest"], decision="allow")',
            'prefix_rule(pattern=["zsh", "-lc"], decision="prompt")',
        ]),
        encoding="utf-8",
    )
    args = argparse.Namespace(rules_dir=str(tmp), rules_file=[str(p)], pretty=False)
    r1 = json.dumps(build_report(args), sort_keys=True)
    r2 = json.dumps(build_report(args), sort_keys=True)
    assert r1 == r2, "build_report output is not deterministic"


# ---------------------------------------------------------------------------
# CLI e2e subprocess test
# ---------------------------------------------------------------------------

def test_cli_e2e_subprocess_exits_zero_and_emits_valid_json_shape():
    """Running the probe as a subprocess exits 0 and emits JSON with required schema fields."""
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--rules-dir", "/nonexistent-rules-dir-probe-xyz"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-codex-rules-inventory", report
    assert "aggregate" in report, report
    assert "files" in report, report
    assert "limitations" in report, report
    assert isinstance(report["aggregate"]["rule_count"], int), report


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} Codex rules inventory probe tests passed")
