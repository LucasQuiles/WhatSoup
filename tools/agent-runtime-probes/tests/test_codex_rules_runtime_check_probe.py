#!/usr/bin/env python3
"""Tests for codex_rules_runtime_check_probe metadata redaction."""
import argparse
import json
import os
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import codex_rules_runtime_check_probe as probe_mod  # noqa: E402
from codex_rules_runtime_check_probe import (  # noqa: E402
    build_report,
    case_report,
    load_cases,
    main,
    reduce_check_result,
    rule_file_meta,
    run_check,
)

PROBE_PATH = Path(__file__).resolve().parent.parent / "codex_rules_runtime_check_probe.py"


def test_reduce_check_result_suppresses_matched_prefix_payload():
    raw = {
        "rc": 0,
        "stdout": json.dumps({
            "matchedRules": [
                {
                    "prefixRuleMatch": {
                        "matchedPrefix": [
                            "ssh",
                            "user@example.host",
                            "https://secret.example.invalid",
                            "sk-secretshape123456",
                        ],
                        "decision": "allow",
                    }
                }
            ],
            "decision": "allow",
        }),
        "stderr": "do not show /Users/testuser/private/path",
    }
    result = reduce_check_result(raw, "allow", "match")
    rendered = json.dumps(result, sort_keys=True)
    assert result["parse_status"] == "ok", result
    assert result["matched_rule_count"] == 1, result
    assert result["decision"] == "allow", result
    assert result["case_verdict"] == "pass", result
    for forbidden in [
        "user@example.host",
        "https://secret.example.invalid",
        "sk-secretshape123456",
        "/Users/testuser/private/path",
    ]:
        assert forbidden not in rendered, forbidden
    assert result["matched_rules"][0]["matched_prefix"]["token_count"] == 4, result


def make_fake_codex(path: Path) -> Path:
    script = path / "fake-codex"
    script.write_text(
        """#!/usr/bin/env python3
import json, sys
tokens = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
if tokens[:2] == ['git', 'commit']:
    print(json.dumps({'matchedRules':[{'prefixRuleMatch': {'matchedPrefix': ['git', 'commit'], 'decision': 'allow'}}], 'decision': 'allow'}))
else:
    print(json.dumps({'matchedRules': []}))
""",
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return script


def test_runtime_check_cli_shape_with_fake_codex_suppresses_case_tokens_and_paths():
    with tempfile.TemporaryDirectory(prefix="codex-rules-runtime-secret-") as tmp_dir:
        tmp = Path(tmp_dir)
        fake = make_fake_codex(tmp)
        rules_dir = tmp / "rules"
        rules_dir.mkdir()
        rules = rules_dir / "default.rules"
        rules.write_text('prefix_rule(pattern=["git", "commit"], decision="allow")\n', encoding="utf-8")
        case_file = tmp / "cases.json"
        case_file.write_text(
            json.dumps([
                {
                    "case_id": "secret_case",
                    "tokens": ["git", "commit", "-m", "user@example.host sk-secretshape123456"],
                    "expected_decision": "allow",
                    "expected_match": "match",
                }
            ]),
            encoding="utf-8",
        )
        report = build_report(argparse.Namespace(
            rules_dir=str(rules_dir),
            rules_file=[str(rules)],
            case_json=str(case_file),
            codex_bin=str(fake),
            timeout=5,
            no_run=False,
            pretty=False,
        ))
        rendered = json.dumps(report, sort_keys=True)
        assert report["schema"] == "agent-runtime-codex-rules-runtime-check", report
        assert report["aggregate"]["case_verdict_counts"] == {"pass": 1}, report
        assert report["aggregate"]["matched_case_count"] == 1, report
        for forbidden in [
            tmp_dir,
            "user@example.host",
            "sk-secretshape123456",
            "git commit",
        ]:
            assert forbidden not in rendered, forbidden
        assert "tokens_sha256_16" in rendered, report


# --- rule_file_meta OSError branch ---

def test_rule_file_meta_oserror_on_read_returns_empty():
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp = Path(tmp_dir)
        rules = tmp / "bad.rules"
        rules.write_text("content", encoding="utf-8")
        # Make it unreadable
        rules.chmod(0o000)
        try:
            result = rule_file_meta(rules)
            # exists=True but line_count should be 0 and sha should be None
            assert result["exists"] is True, result
            assert result["line_count"] == 0, result
            assert result["sha256_16"] is None, result
        finally:
            rules.chmod(0o644)


# --- load_cases default cases path ---

def test_load_cases_none_returns_default_cases():
    cases = load_cases(None)
    assert isinstance(cases, list), cases
    assert len(cases) == 2, cases
    case_ids = {c["case_id"] for c in cases}
    assert "git_commit_prefix_allow" in case_ids, cases
    assert "git_status_short_no_match" in case_ids, cases


# --- load_cases validation errors ---

def test_load_cases_non_list_json_raises():
    with tempfile.TemporaryDirectory() as tmp_dir:
        f = Path(tmp_dir) / "cases.json"
        f.write_text(json.dumps({"not": "a list"}), encoding="utf-8")
        try:
            load_cases(f)
            assert False, "expected ValueError"
        except ValueError as exc:
            assert "list" in str(exc), exc


def test_load_cases_non_dict_item_raises():
    with tempfile.TemporaryDirectory() as tmp_dir:
        f = Path(tmp_dir) / "cases.json"
        f.write_text(json.dumps(["just a string"]), encoding="utf-8")
        try:
            load_cases(f)
            assert False, "expected ValueError"
        except ValueError as exc:
            assert "not an object" in str(exc), exc


def test_load_cases_bad_tokens_raises():
    with tempfile.TemporaryDirectory() as tmp_dir:
        f = Path(tmp_dir) / "cases.json"
        f.write_text(json.dumps([{"case_id": "x", "tokens": "not a list"}]), encoding="utf-8")
        try:
            load_cases(f)
            assert False, "expected ValueError"
        except ValueError as exc:
            assert "tokens" in str(exc), exc


def test_load_cases_tokens_with_non_string_elements_raises():
    with tempfile.TemporaryDirectory() as tmp_dir:
        f = Path(tmp_dir) / "cases.json"
        f.write_text(json.dumps([{"case_id": "x", "tokens": ["git", 42]}]), encoding="utf-8")
        try:
            load_cases(f)
            assert False, "expected ValueError"
        except ValueError as exc:
            assert "tokens" in str(exc), exc


def test_load_cases_missing_case_id_generates_default():
    with tempfile.TemporaryDirectory() as tmp_dir:
        f = Path(tmp_dir) / "cases.json"
        f.write_text(json.dumps([{"tokens": ["ls"]}]), encoding="utf-8")
        cases = load_cases(f)
        assert cases[0]["case_id"] == "case_0", cases


def test_load_cases_invalid_expected_match_raises():
    with tempfile.TemporaryDirectory() as tmp_dir:
        f = Path(tmp_dir) / "cases.json"
        f.write_text(json.dumps([{
            "case_id": "x",
            "tokens": ["ls"],
            "expected_match": "bogus",
        }]), encoding="utf-8")
        try:
            load_cases(f)
            assert False, "expected ValueError"
        except ValueError as exc:
            assert "expected_match" in str(exc), exc


def test_load_cases_non_string_expected_decision_raises():
    with tempfile.TemporaryDirectory() as tmp_dir:
        f = Path(tmp_dir) / "cases.json"
        f.write_text(json.dumps([{
            "case_id": "x",
            "tokens": ["ls"],
            "expected_decision": 42,
        }]), encoding="utf-8")
        try:
            load_cases(f)
            assert False, "expected ValueError"
        except ValueError as exc:
            assert "expected_decision" in str(exc), exc


# --- run_check FileNotFoundError and TimeoutExpired ---

def test_run_check_codex_missing_returns_rc_127():
    result = run_check("/nonexistent/path/to/codex-xyz", [], ["ls"], timeout=5)
    assert result["rc"] == 127, result
    assert "not found" in result["stderr"].lower() or "executable" in result["stderr"].lower(), result
    assert result["stdout"] == "", result


def test_run_check_timeout_returns_rc_124():
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp = Path(tmp_dir)
        sleeper = tmp / "slow-codex"
        sleeper.write_text(
            "#!/usr/bin/env python3\nimport time\ntime.sleep(30)\n",
            encoding="utf-8",
        )
        sleeper.chmod(sleeper.stat().st_mode | stat.S_IXUSR)
        result = run_check(str(sleeper), [], ["ls"], timeout=1)
        assert result["rc"] == 124, result
        assert "timeout" in result["stderr"].lower(), result
        assert result["stdout"] == "", result


# --- reduce_check_result JSON parse error (malformed stdout) ---

def test_reduce_check_result_malformed_json_parse_error():
    raw = {"rc": 0, "stdout": "this is not json {{{", "stderr": ""}
    result = reduce_check_result(raw, None, "any")
    assert result["parse_status"] == "json_error", result
    assert result["parse_error_class"].startswith("JSONDecodeError:"), result
    assert result["matched_rule_count"] is None, result
    assert result["decision"] is None, result
    assert result["case_verdict"] == "fail", result


def test_reduce_check_result_json_array_not_dict():
    raw = {"rc": 0, "stdout": json.dumps([1, 2, 3]), "stderr": ""}
    result = reduce_check_result(raw, None, "any")
    assert result["parse_status"] == "unexpected_json_type", result
    assert result["matched_rule_count"] is None, result
    assert result["decision"] is None, result
    assert result["case_verdict"] == "fail", result


# --- reduce_check_result matchedRules non-list fallback ---

def test_reduce_check_result_matched_rules_non_list_treated_as_empty():
    raw = {
        "rc": 0,
        "stdout": json.dumps({"matchedRules": "not-a-list", "decision": "allow"}),
        "stderr": "",
    }
    result = reduce_check_result(raw, None, "any")
    assert result["parse_status"] == "ok", result
    assert result["matched_rule_count"] == 0, result
    assert result["decision"] == "allow", result


# --- reduce_check_result no_match branches ---

def test_reduce_check_result_no_match_expected_match_zero_is_pass():
    raw = {
        "rc": 0,
        "stdout": json.dumps({"matchedRules": [], "decision": None}),
        "stderr": "",
    }
    result = reduce_check_result(raw, None, "no_match")
    assert result["parse_status"] == "ok", result
    assert result["matched_rule_count"] == 0, result
    assert result["case_verdict"] == "pass", result


def test_reduce_check_result_no_match_but_got_match_is_fail():
    raw = {
        "rc": 0,
        "stdout": json.dumps({
            "matchedRules": [{"prefixRuleMatch": {"matchedPrefix": ["ls"], "decision": "allow"}}],
            "decision": "allow",
        }),
        "stderr": "",
    }
    result = reduce_check_result(raw, None, "no_match")
    assert result["parse_status"] == "ok", result
    assert result["matched_rule_count"] == 1, result
    assert result["case_verdict"] == "fail", result


def test_reduce_check_result_no_match_expected_decision_none_verified():
    # When expected_match="no_match" and expected_decision is None,
    # decision must be None for pass — verify the elif branch
    raw = {
        "rc": 0,
        "stdout": json.dumps({"matchedRules": [], "decision": "allow"}),
        "stderr": "",
    }
    result = reduce_check_result(raw, None, "no_match")
    # decision is "allow" but expected no_match requires decision==None → fail
    assert result["case_verdict"] == "fail", result


def test_reduce_check_result_expected_decision_mismatch_is_fail():
    raw = {
        "rc": 0,
        "stdout": json.dumps({
            "matchedRules": [{"prefixRuleMatch": {"matchedPrefix": ["ls"], "decision": "deny"}}],
            "decision": "deny",
        }),
        "stderr": "",
    }
    result = reduce_check_result(raw, "allow", "match")
    assert result["parse_status"] == "ok", result
    assert result["case_verdict"] == "fail", result


def test_reduce_check_result_nonzero_rc_is_fail():
    raw = {
        "rc": 1,
        "stdout": json.dumps({"matchedRules": [], "decision": None}),
        "stderr": "some error",
    }
    result = reduce_check_result(raw, None, "any")
    assert result["case_verdict"] == "fail", result


# --- case_report with no_run flag ---

def test_case_report_no_run_skips_check():
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp = Path(tmp_dir)
        rules_dir = tmp / "rules"
        rules_dir.mkdir()
        rules_file = rules_dir / "default.rules"
        rules_file.write_text("", encoding="utf-8")
        case = {
            "case_id": "test_skip",
            "tokens": ["git", "status"],
            "expected_decision": None,
            "expected_match": "any",
        }
        row = case_report("codex", [rules_file], case, timeout=5, run_checks=False)
        assert row["check_status"] == "not_run", row
        assert "result" not in row, row
        assert row["case_id"] == "test_skip", row
        assert row["uses_separator_before_command"] is True, row


def test_build_report_no_run_flag_all_not_run():
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp = Path(tmp_dir)
        rules_dir = tmp / "rules"
        rules_dir.mkdir()
        report = build_report(argparse.Namespace(
            rules_dir=str(rules_dir),
            rules_file=[],
            case_json=None,
            codex_bin="codex",
            timeout=5,
            no_run=True,
            pretty=False,
        ))
        assert report["schema"] == "agent-runtime-codex-rules-runtime-check", report
        assert report["proof_class"] == "static_case_shape_only", report
        for row in report["cases"]:
            assert row["check_status"] == "not_run", row


# --- CLI main() entrypoint ---

def test_main_cli_emits_valid_json_no_run():
    with tempfile.TemporaryDirectory() as tmp_dir:
        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH), "--no-run", "--rules-dir", tmp_dir],
            capture_output=True, text=True, timeout=30,
        )
        assert proc.returncode == 0, proc.stderr
        report = json.loads(proc.stdout)
        assert report["schema"] == "agent-runtime-codex-rules-runtime-check", report
        assert report["proof_class"] == "static_case_shape_only", report


def test_main_function_returns_zero_and_prints_json():
    import io
    from contextlib import redirect_stdout
    with tempfile.TemporaryDirectory() as tmp_dir:
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = main(["--no-run", "--rules-dir", tmp_dir])
        assert rc == 0, rc
        report = json.loads(buf.getvalue())
        assert report["schema"] == "agent-runtime-codex-rules-runtime-check", report


def test_main_function_pretty_flag_indents_output():
    import io
    from contextlib import redirect_stdout
    with tempfile.TemporaryDirectory() as tmp_dir:
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = main(["--no-run", "--rules-dir", tmp_dir, "--pretty"])
        assert rc == 0, rc
        text = buf.getvalue()
        # Pretty-printed JSON has newlines and indentation
        assert "\n" in text, "expected indented output"
        report = json.loads(text)
        assert report["schema"] == "agent-runtime-codex-rules-runtime-check", report


def test_main_with_fake_codex_no_match_case():
    import io
    from contextlib import redirect_stdout
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp = Path(tmp_dir)
        fake = make_fake_codex(tmp)
        rules_dir = tmp / "rules"
        rules_dir.mkdir()
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = main([
                "--rules-dir", str(rules_dir),
                "--codex-bin", str(fake),
                "--timeout", "5",
            ])
        assert rc == 0, rc
        report = json.loads(buf.getvalue())
        # git_status_short_no_match case should pass since fake_codex returns no matches
        assert report["schema"] == "agent-runtime-codex-rules-runtime-check", report


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} Codex rules runtime check probe tests passed")
