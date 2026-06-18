#!/usr/bin/env python3
"""Unit tests for synthetic Codex prompt-input shape summarization.

Behavioral unhappy-path coverage. The probe shells out to `codex debug prompt-input`
via subprocess.run; every test here mocks codex_prompt_input_shape_probe.subprocess.run
(or the higher-level run_*_prompt_input helpers) so NO real codex binary or network is
ever invoked. Tests assert outcomes — message/role/byte/canary counts, fail-closed typed
error/degraded markers, and that no raw model-visible text ever appears in the report.
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import codex_prompt_input_shape_probe as probe  # noqa: E402
from codex_prompt_input_shape_probe import (  # noqa: E402
    PROJECT_DOC_CANARY,
    PROMPT_CANARY,
    build_report,
    safe_label,
    summarize_content,
    summarize_prompt_input,
)

PROBE_PATH = Path(__file__).resolve().parent.parent / "codex_prompt_input_shape_probe.py"


class FakeProc:
    """Minimal stand-in for subprocess.CompletedProcess."""

    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _patch_subprocess(monkeypatch, *, proc=None, raises=None, capture=None):
    """Replace probe.subprocess.run with a stub that records the call and returns/raises."""

    def fake_run(cmd, **kwargs):
        if capture is not None:
            capture["cmd"] = cmd
            capture["kwargs"] = kwargs
        if raises is not None:
            raise raises
        return proc

    monkeypatch.setattr(probe.subprocess, "run", fake_run)


def test_summarize_prompt_input_uses_hashes_not_text():
    data = [
        {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": f"dev {PROJECT_DOC_CANARY}"}]},
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": f"user {PROMPT_CANARY}"}]},
    ]
    out = summarize_prompt_input(data)
    rendered = str(out)
    assert out["message_count"] == 2, out
    assert out["roles"] == {"developer": 1, "user": 1}, out
    assert out["prompt_canary_hit_count"] == 1, out
    assert out["project_doc_canary_hit_count"] == 1, out
    assert PROMPT_CANARY not in rendered, out
    assert PROJECT_DOC_CANARY not in rendered, out
    assert "text_sha256_16" in rendered, out


def test_build_report_with_stubbed_runner_has_no_raw_context(monkeypatch):
    def fake_run(timeout: int, include_project_doc: bool):
        assert timeout == 20
        assert include_project_doc is True
        return {
            "status": "captured",
            "rc": 0,
            "parse_status": "parsed",
            "shape": summarize_prompt_input([
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": f"{PROMPT_CANARY} body"}]}
            ]),
        }

    import codex_prompt_input_shape_probe as probe

    monkeypatch.setattr(probe, "run_synthetic_prompt_input", fake_run)
    report = build_report()
    rendered = str(report)
    assert report["schema"] == "codex-prompt-input-shape", report
    assert report["schema_version"] == "0.2", report
    assert report["run"]["shape"]["prompt_canary_hit_count"] == 1, report
    assert PROMPT_CANARY not in rendered, report
    assert PROJECT_DOC_CANARY not in rendered, report


def test_build_report_real_local_mode_uses_synthetic_prompt_metadata_only(monkeypatch):
    def fake_real_run(timeout: int, cwd):
        assert timeout == 20
        return {
            "status": "captured",
            "command_mode": "real_local_env_synthetic_prompt",
            "cwd_sha256_16": "cwdhash",
            "rc": 0,
            "parse_status": "parsed",
            "stdout_bytes": 123,
            "stderr_bytes": 0,
            "shape": summarize_prompt_input([
                {
                    "type": "message",
                    "role": "developer",
                    "content": [{"type": "input_text", "text": "REAL_LOCAL_SECRET_CONTEXT user@example.com"}],
                },
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": f"{PROMPT_CANARY} body"}],
                },
            ]),
        }

    import codex_prompt_input_shape_probe as probe

    monkeypatch.setattr(probe, "run_real_local_prompt_input", fake_real_run)
    report = build_report(mode="real-local", cwd="/Users/testuser")
    rendered = str(report)
    assert report["proof_class"] == "real_local_provider_free_prompt_shape", report
    assert report["fixture"]["real_local_env"] is True, report
    assert report["fixture"]["fake_codex_home"] is False, report
    assert report["run"]["command_mode"] == "real_local_env_synthetic_prompt", report
    assert report["run"]["shape"]["roles"] == {"developer": 1, "user": 1}, report
    assert "REAL_LOCAL_SECRET_CONTEXT" not in rendered, report
    assert "user@example.com" not in rendered, report
    assert "/Users/testuser" not in rendered, report
    assert PROMPT_CANARY not in rendered, report


# --------------------------------------------------------------------------- #
# safe_label: long / slash / redact-non-str branches
# --------------------------------------------------------------------------- #
def test_safe_label_non_string_returns_none():
    assert safe_label(123) is None
    assert safe_label(None) is None
    assert safe_label({"a": 1}) is None


def test_safe_label_slash_value_is_hashed_not_echoed():
    secretish = "/Users/testuser/secret/path/component"
    out = safe_label(secretish)
    assert out is not None
    assert out.startswith("label_hash:"), out
    assert secretish not in out, out
    # hash is stable (16 hex chars after prefix)
    assert len(out.split(":", 1)[1]) == 16, out


def test_safe_label_overlong_value_is_hashed():
    long_value = "x" * 121
    out = safe_label(long_value)
    assert out.startswith("label_hash:"), out
    assert long_value not in out, out


def test_safe_label_redacts_secret_shaped_value_to_non_string_none():
    # An email triggers probelib redact() -> "<redacted:value>" (a str), so it round-trips
    # as a redaction marker, never the raw value.
    out = safe_label("user@example.com")
    assert out == "<redacted:value>", out
    assert "user@example.com" != out


def test_safe_label_plain_short_value_passes_through():
    assert safe_label("user") == "user"
    assert safe_label("assistant") == "assistant"


# --------------------------------------------------------------------------- #
# summarize_content: string / list-of-dict / dict-without-text / non-dict-part / scalar
# --------------------------------------------------------------------------- #
def test_summarize_content_string_kind_counts_bytes_and_canary():
    out = summarize_content(f"hello {PROMPT_CANARY}")
    assert out["kind"] == "string", out
    assert out["contains_prompt_canary"] is True, out
    assert out["contains_project_doc_canary"] is False, out
    assert out["text_bytes"] == len(f"hello {PROMPT_CANARY}".encode("utf-8")), out
    assert PROMPT_CANARY not in str(out), out


def test_summarize_content_list_with_text_part():
    out = summarize_content([{"type": "input_text", "text": f"a {PROJECT_DOC_CANARY}"}])
    assert out["kind"] == "list", out
    assert out["part_count"] == 1, out
    part = out["parts"][0]
    assert part["index"] == 0, part
    assert part["part_type"] == "input_text", part
    assert part["contains_project_doc_canary"] is True, part
    assert part["text_bytes"] == len(f"a {PROJECT_DOC_CANARY}".encode("utf-8")), part
    assert PROJECT_DOC_CANARY not in str(out), out


def test_summarize_content_list_dict_without_text_sets_text_bytes_none():
    out = summarize_content([{"type": "image", "url": "https://example.com/x.png"}])
    part = out["parts"][0]
    assert part["text_bytes"] is None, part
    assert part["part_type"] == "image", part
    # url key is preserved in keys but redact() neutralizes any secret-shaped values
    assert "url" in part["keys"], part


def test_summarize_content_list_non_dict_part_records_repr_type():
    out = summarize_content(["raw-string-part", 42])
    parts = out["parts"]
    assert parts[0]["kind"] == "str", parts
    assert parts[0]["repr_type"] == "str", parts
    assert parts[1]["kind"] == "int", parts
    assert parts[1]["repr_type"] == "int", parts
    # raw string part text is NOT summarized into bytes/hashes here (no text key)
    assert "text_bytes" not in parts[0], parts


def test_summarize_content_scalar_falls_through_to_kind_only():
    out = summarize_content(42)
    assert out == {"kind": "int"}, out
    assert summarize_content(None) == {"kind": "NoneType"}


def test_summarize_content_part_with_non_string_type_omits_part_type():
    out = summarize_content([{"type": 7, "text": "hi"}])
    part = out["parts"][0]
    assert "part_type" not in part, part
    assert part["text_bytes"] == 2, part


# --------------------------------------------------------------------------- #
# summarize_prompt_input: non-list json, non-dict items, string-content totals
# --------------------------------------------------------------------------- #
def test_summarize_prompt_input_non_list_is_typed_not_silent():
    out = summarize_prompt_input({"role": "user"})
    assert out["json_type"] == "dict", out
    assert out["message_count"] is None, out
    assert out["messages"] == [], out


def test_summarize_prompt_input_non_dict_items_recorded_by_kind():
    out = summarize_prompt_input(["scalar-item", 99])
    assert out["message_count"] == 2, out
    assert out["messages"][0]["kind"] == "str", out
    assert out["messages"][1]["kind"] == "int", out
    # no roles/types accumulated from non-dict items
    assert out["roles"] == {}, out
    assert out["total_text_bytes"] == 0, out


def test_summarize_prompt_input_string_content_accumulates_totals_and_canary():
    out = summarize_prompt_input([
        {"role": "user", "type": "message", "content": f"{PROMPT_CANARY} hi"},
    ])
    assert out["roles"] == {"user": 1}, out
    assert out["item_types"] == {"message": 1}, out
    assert out["prompt_canary_hit_count"] == 1, out
    assert out["total_text_bytes"] == len(f"{PROMPT_CANARY} hi".encode("utf-8")), out
    assert PROMPT_CANARY not in str(out), out


def test_summarize_prompt_input_empty_list_is_zeroed_not_none():
    out = summarize_prompt_input([])
    assert out["message_count"] == 0, out
    assert out["roles"] == {}, out
    assert out["total_text_bytes"] == 0, out
    assert out["prompt_canary_hit_count"] == 0, out
    assert out["messages"] == [], out


def test_summarize_prompt_input_message_without_role_or_type():
    out = summarize_prompt_input([{"content": "plain"}])
    msg = out["messages"][0]
    assert msg["role"] is None, msg
    assert msg["type"] is None, msg
    assert out["roles"] == {}, out


# --------------------------------------------------------------------------- #
# run_prompt_input_command: the subprocess wrapper — fail-closed unhappy paths
# --------------------------------------------------------------------------- #
def _run_cmd(monkeypatch, *, proc=None, raises=None, capture=None, temp_root=None):
    _patch_subprocess(monkeypatch, proc=proc, raises=raises, capture=capture)
    return probe.run_prompt_input_command(
        cmd=["codex", "debug", "prompt-input", "PROMPT_TEXT_DO_NOT_LEAK"],
        cwd=Path("/tmp/project"),
        env={"HOME": "/tmp/home"},
        timeout=5,
        host_home=Path("/tmp/home"),
        temp_root=temp_root,
        command_mode="synthetic_fake_roots",
        synthetic_project_doc_written=True,
    )


def test_run_command_missing_binary_yields_typed_error(monkeypatch):
    out = _run_cmd(monkeypatch, raises=FileNotFoundError("codex"))
    assert out["status"] == "error", out
    assert out["error_type"] == "FileNotFoundError", out
    # raw prompt text is replaced by a placeholder in the emitted command
    assert out["command"] == ["codex", "debug", "prompt-input", "<synthetic-prompt>"], out
    assert "PROMPT_TEXT_DO_NOT_LEAK" not in str(out), out
    assert "shape" not in out, out


def test_run_command_timeout_yields_typed_error(monkeypatch):
    out = _run_cmd(
        monkeypatch,
        raises=subprocess.TimeoutExpired(cmd=["codex"], timeout=5),
    )
    assert out["status"] == "error", out
    assert out["error_type"] == "TimeoutExpired", out
    assert "shape" not in out, out
    assert "PROMPT_TEXT_DO_NOT_LEAK" not in str(out), out


def test_run_command_nonzero_exit_is_captured_but_not_parsed(monkeypatch):
    out = _run_cmd(
        monkeypatch,
        proc=FakeProc(returncode=3, stdout="boom on stderr side", stderr="explode"),
    )
    assert out["status"] == "captured", out
    assert out["rc"] == 3, out
    assert out["parse_status"] == "not_parsed_nonzero_exit", out
    assert "shape" not in out, out
    assert out["stdout_bytes"] == len("boom on stderr side".encode("utf-8")), out
    assert out["stderr_bytes"] == len("explode".encode("utf-8")), out
    assert out["stderr_sha256_16"] is not None, out
    assert "boom on stderr side" not in str(out), out
    assert "explode" not in str(out), out


def test_run_command_malformed_json_is_typed_parse_error(monkeypatch):
    out = _run_cmd(monkeypatch, proc=FakeProc(returncode=0, stdout="{not json"))
    assert out["status"] == "captured", out
    assert out["rc"] == 0, out
    assert out["parse_status"] == "error", out
    assert out["parse_error_type"] in {"JSONDecodeError", "ValueError"}, out
    assert "shape" not in out, out
    assert "{not json" not in str(out), out


def test_run_command_empty_stderr_yields_null_hash(monkeypatch):
    payload = json.dumps([{"role": "user", "content": "ok"}])
    out = _run_cmd(monkeypatch, proc=FakeProc(returncode=0, stdout=payload, stderr=""))
    assert out["parse_status"] == "parsed", out
    assert out["stderr_sha256_16"] is None, out
    assert out["stderr_bytes"] == 0, out


def test_run_command_parsed_path_emits_shape_metadata_only(monkeypatch):
    payload = json.dumps([
        {"type": "message", "role": "developer", "content": [
            {"type": "input_text", "text": f"dev {PROJECT_DOC_CANARY} SENSITIVE_RAW_CONTEXT"}]},
        {"type": "message", "role": "user", "content": [
            {"type": "input_text", "text": f"{PROMPT_CANARY} ask"}]},
    ])
    out = _run_cmd(monkeypatch, proc=FakeProc(returncode=0, stdout=payload, stderr="warn"))
    assert out["parse_status"] == "parsed", out
    shape = out["shape"]
    assert shape["message_count"] == 2, shape
    assert shape["roles"] == {"developer": 1, "user": 1}, shape
    assert shape["prompt_canary_hit_count"] == 1, shape
    assert shape["project_doc_canary_hit_count"] == 1, shape
    assert shape["total_text_bytes"] > 0, shape
    # absolutely no raw model-visible text / sensitive context leaks into metadata
    assert "SENSITIVE_RAW_CONTEXT" not in str(out), out
    assert PROMPT_CANARY not in str(out), out
    assert PROJECT_DOC_CANARY not in str(out), out
    assert "warn" not in json.dumps(out), out


def test_run_command_home_and_temp_root_hit_counts(monkeypatch):
    # stdout that leaks the host home + temp root paths is COUNTED, not echoed.
    stdout = json.dumps([{"role": "user", "content": "/tmp/home and /tmp/troot here"}])
    out = _run_cmd(
        monkeypatch,
        proc=FakeProc(returncode=0, stdout=stdout, stderr="/tmp/home again"),
        temp_root=Path("/tmp/troot"),
    )
    assert out["host_home_hit_count"] == 2, out  # one in stdout, one in stderr
    assert out["temp_root_hit_count"] == 1, out
    # cwd /tmp/project is NOT under host_home /tmp/home
    assert out["cwd_is_home_relative"] is False, out


def test_run_command_temp_root_none_yields_null_hit_count(monkeypatch):
    stdout = json.dumps([{"role": "user", "content": "x"}])
    out = _run_cmd(
        monkeypatch,
        proc=FakeProc(returncode=0, stdout=stdout),
        temp_root=None,
    )
    assert out["temp_root_hit_count"] is None, out


def test_run_command_passes_expected_argv_and_kwargs(monkeypatch):
    capture: dict = {}
    _run_cmd(monkeypatch, proc=FakeProc(returncode=0, stdout="[]"), capture=capture)
    assert capture["cmd"][0:3] == ["codex", "debug", "prompt-input"], capture
    assert capture["kwargs"]["timeout"] == 5, capture
    assert capture["kwargs"]["check"] is False, capture
    assert capture["kwargs"]["capture_output"] is True, capture


# --------------------------------------------------------------------------- #
# run_synthetic_prompt_input / run_real_local_prompt_input: real wrappers, mocked codex
# --------------------------------------------------------------------------- #
def test_run_synthetic_prompt_input_builds_fake_roots_and_parses(monkeypatch):
    capture: dict = {}
    payload = json.dumps([{"role": "user", "type": "message",
                           "content": [{"type": "input_text", "text": f"{PROMPT_CANARY} q"}]}])
    _patch_subprocess(monkeypatch, proc=FakeProc(returncode=0, stdout=payload), capture=capture)
    out = probe.run_synthetic_prompt_input(timeout=7, include_project_doc=True)
    assert out["status"] == "captured", out
    assert out["command_mode"] == "synthetic_fake_roots", out
    assert out["parse_status"] == "parsed", out
    assert out["synthetic_project_doc_written"] is True, out
    assert out["shape"]["prompt_canary_hit_count"] == 1, out
    # env handed to codex points HOME/CODEX_HOME at the temp fake roots, not real home
    env = capture["kwargs"]["env"]
    assert env["HOME"] != str(Path.home()), env["HOME"]
    assert "codex-home" in env["CODEX_HOME"], env["CODEX_HOME"]
    assert capture["kwargs"]["timeout"] == 7, capture
    assert PROMPT_CANARY not in str(out), out


def test_run_synthetic_prompt_input_without_project_doc_flags_false(monkeypatch):
    _patch_subprocess(monkeypatch, proc=FakeProc(returncode=0, stdout="[]"))
    out = probe.run_synthetic_prompt_input(timeout=5, include_project_doc=False)
    assert out["synthetic_project_doc_written"] is False, out
    assert out["shape"]["message_count"] == 0, out


def test_run_real_local_prompt_input_uses_real_env_and_given_cwd(monkeypatch):
    capture: dict = {}
    payload = json.dumps([{"role": "developer", "content": "REAL_SECRET_X"}])
    _patch_subprocess(monkeypatch, proc=FakeProc(returncode=0, stdout=payload), capture=capture)
    out = probe.run_real_local_prompt_input(timeout=9, cwd=Path("/tmp/realproj"))
    assert out["command_mode"] == "real_local_env_synthetic_prompt", out
    assert out["synthetic_project_doc_written"] is False, out
    assert out["parse_status"] == "parsed", out
    assert capture["kwargs"]["cwd"] == "/tmp/realproj", capture
    assert capture["kwargs"]["timeout"] == 9, capture
    # cwd is only emitted as a hash, never raw
    assert out["cwd_sha256_16"] == probe.sha256_16("/tmp/realproj"), out
    assert "REAL_SECRET_X" not in str(out), out


# --------------------------------------------------------------------------- #
# build_report: both modes through the real helpers (codex mocked)
# --------------------------------------------------------------------------- #
def test_build_report_synthetic_mode_end_to_end_metadata_only(monkeypatch):
    payload = json.dumps([{"role": "user", "type": "message",
                           "content": [{"type": "input_text", "text": f"{PROMPT_CANARY} body"}]}])
    _patch_subprocess(monkeypatch, proc=FakeProc(returncode=0, stdout=payload))
    report = build_report(timeout=11, include_project_doc=True, mode="synthetic")
    assert report["proof_class"] == "synthetic_provider_free_prompt_shape", report
    assert report["fixture"]["fake_home"] is True, report
    assert report["fixture"]["real_local_env"] is False, report
    assert report["run"]["shape"]["prompt_canary_hit_count"] == 1, report
    assert report["run"]["rc"] == 0, report
    assert PROMPT_CANARY not in str(report), report


def test_build_report_real_local_mode_end_to_end(monkeypatch):
    payload = json.dumps([{"role": "developer", "content": "LEAK_ME_NOT"}])
    _patch_subprocess(monkeypatch, proc=FakeProc(returncode=0, stdout=payload))
    report = build_report(timeout=8, mode="real-local", cwd="/tmp/somewhere")
    assert report["proof_class"] == "real_local_provider_free_prompt_shape", report
    assert report["fixture"]["real_local_env"] is True, report
    assert report["fixture"]["fake_codex_home"] is False, report
    assert report["fixture"]["real_cwd_sha256_16"] == probe.sha256_16(
        str(Path("/tmp/somewhere").expanduser().resolve())), report
    assert "LEAK_ME_NOT" not in str(report), report


def test_build_report_default_cwd_when_none(monkeypatch):
    _patch_subprocess(monkeypatch, proc=FakeProc(returncode=0, stdout="[]"))
    report = build_report(mode="synthetic")
    # default include_project_doc=True path
    assert report["fixture"]["synthetic_project_doc"] is True, report
    assert report["run"]["status"] == "captured", report


# --------------------------------------------------------------------------- #
# main(): exit-code verdict branches + json emission (codex mocked, no real binary)
# --------------------------------------------------------------------------- #
def _run_main(monkeypatch, argv, proc=None, raises=None):
    _patch_subprocess(monkeypatch, proc=proc, raises=raises)
    monkeypatch.setattr(sys, "argv", ["codex_prompt_input_shape_probe.py", *argv])
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = probe.main()
    return rc, buf.getvalue()


def test_main_success_returns_zero_and_emits_json(monkeypatch):
    payload = json.dumps([{"role": "user", "content": f"{PROMPT_CANARY}"}])
    rc, out = _run_main(monkeypatch, ["--pretty"], proc=FakeProc(returncode=0, stdout=payload))
    assert rc == 0, out
    report = json.loads(out)
    assert report["schema"] == "codex-prompt-input-shape", report
    assert report["run"]["rc"] == 0, report
    assert PROMPT_CANARY not in out, out


def test_main_nonzero_codex_exit_returns_one(monkeypatch):
    rc, out = _run_main(monkeypatch, [], proc=FakeProc(returncode=5, stdout="x", stderr="y"))
    assert rc == 1, out
    report = json.loads(out)
    assert report["run"]["rc"] == 5, report
    assert report["run"]["parse_status"] == "not_parsed_nonzero_exit", report


def test_main_missing_binary_returns_one_with_typed_error(monkeypatch):
    rc, out = _run_main(monkeypatch, [], raises=FileNotFoundError("codex"))
    assert rc == 1, out
    report = json.loads(out)
    assert report["run"]["status"] == "error", report
    assert report["run"]["error_type"] == "FileNotFoundError", report


def test_main_no_project_doc_flag_disables_synthetic_doc(monkeypatch):
    rc, out = _run_main(monkeypatch, ["--no-project-doc"], proc=FakeProc(returncode=0, stdout="[]"))
    assert rc == 0, out
    report = json.loads(out)
    assert report["fixture"]["synthetic_project_doc"] is False, report


def test_main_real_local_flag_selects_real_local_mode(monkeypatch):
    payload = json.dumps([{"role": "user", "content": "z"}])
    rc, out = _run_main(
        monkeypatch, ["--real-local", "--cwd", "/tmp/x"],
        proc=FakeProc(returncode=0, stdout=payload),
    )
    assert rc == 0, out
    report = json.loads(out)
    assert report["proof_class"] == "real_local_provider_free_prompt_shape", report
    assert report["fixture"]["real_local_env"] is True, report


# --------------------------------------------------------------------------- #
# CLI e2e: run the probe as a real subprocess in DEFAULT synthetic mode.
# codex is almost certainly absent in CI -> probe must fail-closed (rc 1, typed error),
# never crash, and never leak raw text. This covers the __main__ entrypoint.
# --------------------------------------------------------------------------- #
def test_cli_entrypoint_default_synthetic_is_fail_closed_and_valid_json():
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH)],
        capture_output=True, text=True, timeout=60,
    )
    # Whether codex exists or not, the probe must emit valid JSON and a coherent verdict.
    report = json.loads(proc.stdout)
    assert report["schema"] == "codex-prompt-input-shape", report
    assert report["fixture"]["fake_home"] is True, report
    run = report["run"]
    if run.get("status") == "error" or run.get("rc") not in (0,):
        # fail-closed: nonzero process exit when codex missing / errored
        assert proc.returncode == 1, (proc.returncode, report)
    else:
        assert proc.returncode == 0, (proc.returncode, report)
    # never echo the synthetic prompt's raw canary text into stdout JSON values
    assert PROMPT_CANARY not in proc.stdout, proc.stdout


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]

    class MonkeyPatch:
        """Minimal monkeypatch shim with restore, so standalone runs don't leak state."""

        def __init__(self):
            self._undo = []

        def setattr(self, obj, name, value):
            self._undo.append((obj, name, getattr(obj, name)))
            setattr(obj, name, value)

        def undo(self):
            for obj, name, old in reversed(self._undo):
                setattr(obj, name, old)
            self._undo.clear()

    for fn in tests:
        if fn.__code__.co_argcount:
            mp = MonkeyPatch()
            try:
                fn(mp)
            finally:
                mp.undo()
        else:
            fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} Codex prompt-input shape tests passed")
