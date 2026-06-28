#!/usr/bin/env python3
"""Safety tests for launchd_plist_inventory_probe metadata-only output."""
import io
import json
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import launchd_plist_inventory_probe as probe  # noqa: E402
from launchd_plist_inventory_probe import (  # noqa: E402
    build_report,
    calendar_shape,
    classify_path_value,
    classify_root,
    fallback_parse_xml_plist,
    find_plists,
    keepalive_shape,
    label_prefix_class,
    managed_components_summary,
    parse_value,
    summarize_plist,
)


def write_plist(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_plist(payload), encoding="utf-8")


def render_value(value) -> str:
    if isinstance(value, bool):
        return "<true/>" if value else "<false/>"
    if isinstance(value, int):
        return f"<integer>{value}</integer>"
    if isinstance(value, list):
        return "<array>" + "".join(render_value(item) for item in value) + "</array>"
    if isinstance(value, dict):
        return render_dict(value)
    escaped = str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return f"<string>{escaped}</string>"


def render_dict(payload: dict) -> str:
    parts = ["<dict>"]
    for key, value in payload.items():
        parts.append(f"<key>{key}</key>")
        parts.append(render_value(value))
    parts.append("</dict>")
    return "".join(parts)


def render_plist(payload: dict) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        '<plist version="1.0">'
        f"{render_dict(payload)}"
        "</plist>\n"
    )


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")


def fixture_tree(root: Path) -> tuple[Path, Path]:
    launch_agents = root / "home/Library/LaunchAgents"
    home = str(Path.home())  # CURRENT user's home so the probe classifies it as home_path (portable)
    write_plist(
        launch_agents / "com.whatsoup.secret-bot.plist",
        {
            "Label": "com.whatsoup.secret-bot",
            "ProgramArguments": [
                f"{home}/private/bin/run-secret.sh",
                "--token",
                "canary-must-not-leak",
            ],
            "EnvironmentVariables": {
                "PATH": f"{home}/private/bin:/usr/bin",
                "PINECONE_API_KEY": "pcsk_secretshouldnotleak",
                "SECRET_TOKEN": "canary-must-not-leak",
            },
            "RunAtLoad": True,
            "KeepAlive": {"Crashed": True},
            "StartInterval": 120,
            "WorkingDirectory": f"{home}/private/workdir",
            "StandardOutPath": f"{home}/private/logs/out.log",
            "StandardErrorPath": f"{home}/private/logs/err.log",
        },
    )
    (launch_agents / "bad-secret.plist").write_text("canary-must-not-leak <not plist>", encoding="utf-8")
    managed = root / "managed-components.json"
    write_json(
        managed,
        {
            "protective_services": {
                "entries": [
                    {
                        "name": "secret-watchdog",
                        "label_pattern": "com.whatsoup.{BOT_NAME}-watchdog",
                        "install_path": "~/Library/LaunchAgents/com.whatsoup.secret-bot-watchdog.plist",
                        "purpose": "Monitors health and restarts stalled launchd jobs.",
                    },
                    {
                        "name": "token-backup",
                        "label_pattern": "com.whatsoup.ms365-token-backup",
                        "purpose": "Backs up auth token material.",
                    },
                ]
            }
        },
    )
    return launch_agents, managed


def assert_no_fixture_values(rendered: str) -> None:
    for forbidden in [
        "secret-bot",
        "run-secret.sh",
        "canary-must-not-leak",
        "pcsk_secretshouldnotleak",
        f"{Path.home()}/private",
        "secret-watchdog",
        "token-backup",
        "com.whatsoup.secret-bot",
    ]:
        assert forbidden not in rendered, forbidden


def test_launchd_probe_summarizes_plists_without_raw_values():
    with tempfile.TemporaryDirectory(prefix="launchd-probe-") as tmp_dir:
        root, managed = fixture_tree(Path(tmp_dir))
        report = build_report([root], managed)
        rendered = json.dumps(report, sort_keys=True)
        assert report["schema"] == "agent-runtime-launchd-plist-inventory", report
        assert report["summary"]["plist_count"] == 2, report
        assert report["summary"]["parse_status_counts"] == {"error": 1, "ok": 1}, report
        assert report["summary"]["label_prefix_class_counts"]["com.whatsoup"] == 1, report
        assert report["summary"]["sensitive_env_key_total"] == 2, report
        ok = next(item for item in report["plists"] if item["parse_status"] == "ok")
        assert ok["program_arguments_count"] == 3, ok
        assert ok["program_first_arg_path_class"] == "home_path", ok
        assert ok["env_keys"] == ["PATH", "PINECONE_API_KEY", "SECRET_TOKEN"], ok
        assert ok["keepalive"]["keys"] == ["Crashed"], ok
        assert ok["start_interval_seconds"] == 120, ok
        assert ok["log_path_count"] == 2, ok
        assert_no_fixture_values(rendered)


def test_launchd_probe_summarizes_managed_components_without_names_or_paths():
    with tempfile.TemporaryDirectory(prefix="launchd-probe-") as tmp_dir:
        root, managed = fixture_tree(Path(tmp_dir))
        report = build_report([root], managed)
        managed_summary = report["whatsoup_managed_components"]
        rendered = json.dumps(managed_summary, sort_keys=True)
        assert managed_summary["status"] == "parsed", managed_summary
        assert managed_summary["protective_service_count"] == 2, managed_summary
        assert managed_summary["label_prefix_class_counts"]["com.whatsoup"] == 2, managed_summary
        assert managed_summary["purpose_class_counts"]["health_or_restart"] == 1, managed_summary
        assert managed_summary["purpose_class_counts"]["credential_backup"] == 1, managed_summary
        assert_no_fixture_values(rendered)


def test_launchd_managed_components_malformed_json_reports_error_type():
    with tempfile.TemporaryDirectory(prefix="launchd-probe-") as tmp_dir:
        path = Path(tmp_dir) / "managed-components.json"
        path.write_text("{bad", encoding="utf-8")

        summary = managed_components_summary(path)

    assert summary["status"] == "invalid_json", summary
    assert summary["error_type"] == "JSONDecodeError", summary
    assert summary["protective_service_count"] == 0, summary


def test_launchd_probe_cli_suppresses_values():
    with tempfile.TemporaryDirectory(prefix="launchd-probe-") as tmp_dir:
        root, managed = fixture_tree(Path(tmp_dir))
        result = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).resolve().parents[1] / "launchd_plist_inventory_probe.py"),
                "--root",
                str(root),
                "--managed-components",
                str(managed),
                "--pretty",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        report = json.loads(result.stdout)
        assert result.stderr == "", result.stderr
        assert report["summary"]["plist_count"] == 2, report
        assert report["whatsoup_managed_components"]["protective_service_count"] == 2, report
        assert_no_fixture_values(result.stdout)


def _force_plutil_failure(monkey_calls: list):
    """Make the probe's plutil invocation report a nonzero rc so summarize_plist
    falls back to the in-process XML tokenizer/parser. Returns the original."""
    orig = probe.subprocess.run

    class _FakeProc:
        returncode = 1
        stdout = ""
        stderr = "plutil refused"

    def fake_run(argv, *a, **kw):
        monkey_calls.append(argv)
        return _FakeProc()

    probe.subprocess.run = fake_run
    return orig


def test_classify_root_maps_known_roots_and_other():
    home = Path.home()
    assert classify_root(home / "Library/LaunchAgents") == "user_launch_agents"
    assert classify_root(home / "Library/LaunchAgents/sub") == "user_launch_agents"
    assert classify_root(Path("/Library/LaunchAgents")) == "system_launch_agents"
    assert classify_root(Path("/Library/LaunchDaemons")) == "system_launch_daemons"
    assert classify_root(Path("/tmp/whatever")) == "other"


def test_parse_value_guards_index_overrun_and_unexpected_token():
    # Index past the end of the token stream returns a safe (None, index) pair.
    assert parse_value([], 0) == (None, 0)
    assert parse_value([("key", "x")], 9) == (None, 9)
    # A leading container-close token is not a value start -> (None, index+1).
    assert parse_value([("dict_end", None)], 0) == (None, 1)
    assert parse_value([("array_end", None)], 0) == (None, 1)


def test_classify_path_value_buckets_every_prefix_class():
    # Exhaustive branch coverage of the path classifier, including the absent guards.
    assert classify_path_value(None) == "absent"
    assert classify_path_value("   ") == "absent"
    assert classify_path_value(str(Path.home()) + "/x") == "home_path"
    assert classify_path_value("~/x") == "home_path"
    assert classify_path_value("/Users/someone-else/x") == "other_user_path"
    assert classify_path_value("/usr/bin/env") == "system_binary_path"
    assert classify_path_value("/bin/sh") == "system_binary_path"
    assert classify_path_value("/sbin/launchd") == "system_binary_path"
    assert classify_path_value("/opt/homebrew/bin/x") == "managed_prefix_path"
    assert classify_path_value("/nix/store/x") == "managed_prefix_path"
    assert classify_path_value("/tmp/x") == "temp_path"
    assert classify_path_value("/private/tmp/x") == "temp_path"
    assert classify_path_value("/var/folders/ab/x") == "temp_path"
    assert classify_path_value("/etc/somewhere") == "absolute_path"
    assert classify_path_value("relative-cmd") == "relative_or_command"


def test_label_prefix_class_buckets_known_and_generic_prefixes():
    assert label_prefix_class(None) == "absent"
    assert label_prefix_class("   ") == "absent"
    assert label_prefix_class("com.whatsoup.bot") == "com.whatsoup"
    assert label_prefix_class("com.examplefleet.bot") == "com.examplefleet"
    assert label_prefix_class("com.tailscale.x") == "com.tailscale"
    assert label_prefix_class("homebrew.mxcl.foo") == "homebrew"
    assert label_prefix_class("com.apple.Safari") == "com.apple"
    assert label_prefix_class("org.example.daemon") == "org.example"
    assert label_prefix_class("singleword") == "other"


def test_keepalive_and_calendar_shape_classify_without_values():
    assert keepalive_shape(True) == {"type": "bool", "enabled": True}
    assert keepalive_shape(None) == {"type": "absent"}
    assert keepalive_shape("weird") == {"type": "str"}
    dict_shape = keepalive_shape({"Crashed": True, "NetworkState": True})
    assert dict_shape["type"] == "dict"
    assert dict_shape["keys"] == ["Crashed", "NetworkState"]
    assert dict_shape["key_count"] == 2
    assert calendar_shape(None) == {"type": "absent", "entry_count": 0, "keys": []}
    # A single dict (not wrapped in a list) is normalized to one entry.
    single = calendar_shape({"Hour": 3, "Minute": 30})
    assert single["type"] == "dict"
    assert single["entry_count"] == 1
    assert single["keys"] == ["Hour", "Minute"]
    multi = calendar_shape([{"Hour": 1}, {"Weekday": 2}])
    assert multi["type"] == "list"
    assert multi["entry_count"] == 2
    assert multi["keys"] == ["Hour", "Weekday"]


def test_fallback_parser_handles_all_token_kinds_and_rejects_non_dict_root():
    raw = (
        "<plist version=\"1.0\"><dict>"
        "<key>Label</key><string>com.examplefleet.fallback</string>"
        "<key>RunAtLoad</key><true/>"
        "<key>Disabled</key><false/>"
        "<key>StartInterval</key><integer>30</integer>"
        "<key>NotAnInt</key><integer>thirty</integer>"
        "<key>ProgramArguments</key><array><string>/usr/bin/env</string><string>x</string></array>"
        "<key>Nested</key><dict><key>inner</key><integer>1</integer></dict>"
        "<string>stray-non-key-token</string>"
        "</dict></plist>"
    )
    parsed = fallback_parse_xml_plist(raw)
    assert parsed["Label"] == "com.examplefleet.fallback"
    assert parsed["RunAtLoad"] is True
    assert parsed["Disabled"] is False
    assert parsed["StartInterval"] == 30
    # Non-integer <integer> body falls back to a string token, not a crash.
    assert parsed["NotAnInt"] == "thirty"
    assert parsed["ProgramArguments"] == ["/usr/bin/env", "x"]
    assert parsed["Nested"] == {"inner": 1}
    # Stray non-<key> token inside the dict is skipped, not promoted to a key.
    assert "stray-non-key-token" not in parsed
    # A plist whose root is an array (no top-level dict) is rejected, not silently emptied.
    try:
        fallback_parse_xml_plist("<plist><array><string>a</string></array></plist>")
    except ValueError as exc:
        assert "no top-level dict" in str(exc)
    else:
        raise AssertionError("expected ValueError for non-dict-root plist")


def test_summarize_plist_uses_fallback_parser_when_plutil_fails():
    # When plutil reports failure, the probe must still parse via its own tokenizer
    # and record the plutil failure class in parse_fallback_error_class.
    with tempfile.TemporaryDirectory(prefix="launchd-fallback-") as tmp_dir:
        root = Path(tmp_dir)
        plist = root / "com.examplefleet.fallback.plist"
        write_plist(
            plist,
            {
                "Label": "com.examplefleet.fallback",
                "ProgramArguments": ["/opt/homebrew/bin/run.sh", "--flag"],
                "EnvironmentVariables": {"API_TOKEN": "x", "PATH": "/usr/bin"},
                "RunAtLoad": True,
                "StartInterval": 45,
            },
        )
        calls: list = []
        orig = _force_plutil_failure(calls)
        try:
            summary = summarize_plist(plist, root)
        finally:
            probe.subprocess.run = orig
    assert calls, "expected the probe to attempt plutil before falling back"
    assert summary["parse_status"] == "ok", summary
    # plutil failed (rc 1) but fallback succeeded -> the plutil failure class is recorded.
    assert summary["parse_fallback_error_class"] == "plutil_rc_1", summary
    assert summary["label_prefix_class"] == "com.examplefleet", summary
    assert summary["program_first_arg_path_class"] == "managed_prefix_path", summary
    assert summary["program_arguments_count"] == 2, summary
    assert summary["start_interval_seconds"] == 45, summary
    assert summary["sensitive_env_key_count"] == 1, summary
    assert summary["env_keys"] == ["API_TOKEN", "PATH"], summary


def test_summarize_plist_classifies_unparseable_file_as_typed_error():
    # plutil fails AND the fallback parser cannot find a top-level dict -> the probe
    # must fail closed with a typed error status, never a silent skip.
    with tempfile.TemporaryDirectory(prefix="launchd-error-") as tmp_dir:
        root = Path(tmp_dir)
        plist = root / "broken.plist"
        plist.write_text("this is not a plist at all", encoding="utf-8")
        calls: list = []
        orig = _force_plutil_failure(calls)
        try:
            summary = summarize_plist(plist, root)
        finally:
            probe.subprocess.run = orig
    assert summary["parse_status"] == "error", summary
    assert summary["parse_error_class"] == "ValueError", summary
    assert summary["parse_fallback_error_class"] == "plutil_rc_1", summary
    assert summary["raw_bytes"] == len("this is not a plist at all"), summary
    # A failed parse must not leak label/program/env fields.
    assert "label_prefix_class" not in summary, summary
    assert "env_keys" not in summary, summary


def test_summarize_plist_records_exception_when_plutil_invocation_raises():
    # If the plutil subprocess itself raises (e.g. binary missing), the probe captures
    # the exception class as the fallback error, then still parses via the tokenizer.
    with tempfile.TemporaryDirectory(prefix="launchd-raise-") as tmp_dir:
        root = Path(tmp_dir)
        plist = root / "com.apple.ok.plist"
        write_plist(plist, {"Label": "com.apple.ok"})
        orig = probe.subprocess.run

        def boom(*a, **kw):
            raise FileNotFoundError("plutil not installed")

        probe.subprocess.run = boom
        try:
            summary = summarize_plist(plist, root)
        finally:
            probe.subprocess.run = orig
    assert summary["parse_status"] == "ok", summary
    assert summary["parse_fallback_error_class"] == "FileNotFoundError", summary
    assert summary["label_prefix_class"] == "com.apple", summary


def test_summarize_plist_marks_non_dict_root_as_not_object():
    # A plist whose top-level value parses to a non-dict (here an array) must be
    # classified not_object and must not emit any label/program metadata.
    with tempfile.TemporaryDirectory(prefix="launchd-notobj-") as tmp_dir:
        root = Path(tmp_dir)
        plist = root / "array-root.plist"
        plist.write_text(
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<plist version="1.0"><array><string>a</string><string>b</string></array></plist>',
            encoding="utf-8",
        )
        summary = summarize_plist(plist, root)
    assert summary["parse_status"] == "not_object", summary
    assert "label_prefix_class" not in summary, summary
    assert "program_path_class" not in summary, summary
    assert summary["raw_bytes"] > 0, summary


def test_find_plists_returns_empty_for_missing_directory():
    assert find_plists(Path("/nonexistent-launchd-root-xyz/agents")) == []


def test_managed_components_missing_file_reports_missing_status():
    summary = managed_components_summary(Path("/nonexistent-xyz/managed-components.json"))
    assert summary == {"status": "missing", "error_type": None, "protective_service_count": 0}


def test_managed_components_top_level_list_reports_invalid_shape():
    with tempfile.TemporaryDirectory(prefix="launchd-mc-shape-") as tmp_dir:
        path = Path(tmp_dir) / "managed-components.json"
        path.write_text("[1, 2, 3]", encoding="utf-8")
        summary = managed_components_summary(path)
    assert summary["status"] == "invalid_shape", summary
    assert summary["error_type"] == "list", summary
    assert summary["protective_service_count"] == 0, summary


def test_managed_components_non_list_entries_and_non_dict_items_fail_closed():
    # entries that are not a list collapse to zero parsed services (fail closed).
    with tempfile.TemporaryDirectory(prefix="launchd-mc-entries-") as tmp_dir:
        path = Path(tmp_dir) / "managed-components.json"
        write_json(path, {"protective_services": {"entries": "not-a-list"}})
        summary = managed_components_summary(path)
    assert summary["status"] == "parsed", summary
    assert summary["protective_service_count"] == 0, summary
    assert summary["label_prefix_class_counts"] == {}, summary
    assert summary["purpose_class_counts"] == {}, summary


def test_managed_components_skips_non_dict_entries_and_counts_manifest_purpose():
    # A non-dict entry is skipped during classification; a manifest/drift purpose
    # is bucketed as manifest_or_drift.
    with tempfile.TemporaryDirectory(prefix="launchd-mc-mixed-") as tmp_dir:
        path = Path(tmp_dir) / "managed-components.json"
        write_json(
            path,
            {
                "protective_services": {
                    "entries": [
                        "i-am-not-a-dict",
                        {"label_pattern": "com.examplefleet.manifest", "purpose": "Checks manifest drift nightly."},
                    ]
                }
            },
        )
        summary = managed_components_summary(path)
    # Count reflects len(entries) including the non-dict, but only the dict is classified.
    assert summary["protective_service_count"] == 2, summary
    assert summary["label_prefix_class_counts"] == {"com.examplefleet": 1}, summary
    assert summary["purpose_class_counts"] == {"manifest_or_drift": 1}, summary


def test_main_default_root_and_no_managed_components():
    # Exercise main(): default-root branch (no --root) + --no-managed-components,
    # pointed at hermetic temp constants so no system plists are read.
    with tempfile.TemporaryDirectory(prefix="launchd-main-") as tmp_dir:
        root, _ = fixture_tree(Path(tmp_dir))
        orig_argv = sys.argv
        orig_default = probe.DEFAULT_USER_ROOT
        probe.DEFAULT_USER_ROOT = root
        sys.argv = ["launchd_plist_inventory_probe.py", "--no-managed-components"]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = probe.main()
        finally:
            sys.argv = orig_argv
            probe.DEFAULT_USER_ROOT = orig_default
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["summary"]["plist_count"] == 2, report
    assert report["summary"]["root_count"] == 1, report
    assert report["whatsoup_managed_components"] == {"status": "skipped"}, report
    assert_no_fixture_values(buf.getvalue())


def test_main_include_system_extends_roots_and_pretty_prints():
    # Exercise main(): --include-system (root extension) + --pretty, with SYSTEM_ROOTS
    # patched to a hermetic empty temp dir so no real /Library plists are touched.
    with tempfile.TemporaryDirectory(prefix="launchd-main-sys-") as tmp_dir:
        base = Path(tmp_dir)
        root, managed = fixture_tree(base)
        empty_system = base / "empty-system"
        empty_system.mkdir()
        orig_argv = sys.argv
        orig_system = probe.SYSTEM_ROOTS
        probe.SYSTEM_ROOTS = [empty_system]
        sys.argv = [
            "launchd_plist_inventory_probe.py",
            "--root", str(root),
            "--managed-components", str(managed),
            "--include-system",
            "--pretty",
        ]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = probe.main()
        finally:
            sys.argv = orig_argv
            probe.SYSTEM_ROOTS = orig_system
    assert rc == 0
    out = buf.getvalue()
    # --pretty emits indented JSON (multi-line with leading spaces).
    assert "\n  " in out, "expected pretty-printed indentation"
    report = json.loads(out)
    # 1 explicit root + 1 patched system root = 2 roots scanned.
    assert report["summary"]["root_count"] == 2, report
    assert report["summary"]["plist_count"] == 2, report
    assert report["whatsoup_managed_components"]["protective_service_count"] == 2, report
    assert_no_fixture_values(out)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} launchd plist inventory tests passed")
