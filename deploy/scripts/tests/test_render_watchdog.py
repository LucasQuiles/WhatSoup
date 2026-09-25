"""Tests for deploy/scripts/render-watchdog.py.

Covers the reusable render+verify tool that replaces hand `sed` rendering:
- golden JSON output for a fixed fixture template (deterministic);
- the REAL watchdog template renders with zero surviving placeholders and the
  per-host ports land (incl. a non-default fleet port);
- verify mode CATCHES the live churn bug — the raw, unrendered template still
  carries BOT_PORT/FLEET_PORT/BOT_NAME/__HOME__;
- bad/non-numeric ports fail closed (exit 3);
- find_placeholders is exact (no false hits on BOT_JSON / TERMINAL_AUTH_FAILURES).
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest
from hypothesis import given, strategies as st

_TESTS = Path(__file__).resolve().parent
if str(_TESTS) not in sys.path:
    sys.path.insert(0, str(_TESTS))

from bot_errors_property_support import private_case, properties  # noqa: E402

_SCRIPTS = Path(__file__).resolve().parents[1]
_SCRIPT = _SCRIPTS / "render-watchdog.py"
_TEMPLATE = _SCRIPTS.parent / "templates" / "watchdog-script.sh"

_spec = importlib.util.spec_from_file_location("render_watchdog", _SCRIPT)
rw = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rw)

_FIXTURE = (
    "#!/bin/zsh\n"
    'HOME_DIR="__HOME__"\n'
    'BOT_LABEL="com.whatsoup.BOT_NAME"\n'
    'BOT_HEALTH="http://127.0.0.1:BOT_PORT/health"\n'
    'FLEET_HEALTH="http://127.0.0.1:FLEET_PORT/"\n'
    "# operator account: USERNAME\n"
)
_FIXTURE_EXPECTED = (
    "#!/bin/zsh\n"
    'HOME_DIR="/Users/tester"\n'
    'BOT_LABEL="com.whatsoup.zz-bot"\n'
    'BOT_HEALTH="http://127.0.0.1:9001/health"\n'
    'FLEET_HEALTH="http://127.0.0.1:9002/"\n'
    "# operator account: tester\n"
)


def _run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(_SCRIPT), *args],
                          capture_output=True, text=True, timeout=20)


def test_render_fixture_golden_json(tmp_path):
    fx = tmp_path / "wd.template.sh"
    fx.write_text(_FIXTURE, encoding="utf-8")
    proc = _run("render", "--template", str(fx), "--bot-name", "zz-bot",
                "--bot-port", "9001", "--fleet-port", "9002",
                "--home", "/Users/tester", "--username", "tester", "--json")
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["placeholders_remaining"] == []
    assert payload["status"] == "ok"
    assert payload["sha256"] == hashlib.sha256(_FIXTURE_EXPECTED.encode()).hexdigest()
    assert payload["bot_port"] == "9001" and payload["fleet_port"] == "9002"


def test_render_fixture_out_file_matches_expected(tmp_path):
    fx = tmp_path / "wd.template.sh"
    fx.write_text(_FIXTURE, encoding="utf-8")
    out = tmp_path / "rendered.sh"
    proc = _run("render", "--template", str(fx), "--bot-name", "zz-bot",
                "--bot-port", "9001", "--fleet-port", "9002",
                "--home", "/Users/tester", "--username", "tester", "--out", str(out))
    assert proc.returncode == 0, proc.stderr
    assert out.read_text(encoding="utf-8") == _FIXTURE_EXPECTED


def test_render_real_template_no_placeholders():
    out = _run("render", "--template", str(_TEMPLATE), "--bot-name", "rb-bot",
               "--bot-port", "9095", "--fleet-port", "9099",
               "--home", "/Users/rachel", "--username", "rachel", "--json")
    assert out.returncode == 0, out.stderr
    payload = json.loads(out.stdout)
    assert payload["placeholders_remaining"] == [], payload
    # and the rendered body itself (stdout default) carries the host ports
    body = _run("render", "--template", str(_TEMPLATE), "--bot-name", "rb-bot",
                "--bot-port", "9095", "--fleet-port", "9099",
                "--home", "/Users/rachel", "--username", "rachel").stdout
    assert 'BOT_HEALTH="http://127.0.0.1:9095/health"' in body
    assert 'FLEET_HEALTH="http://127.0.0.1:9099/"' in body
    assert 'BOT_LABEL="com.whatsoup.rb-bot"' in body


def test_render_non_default_fleet_port_respected():
    body = _run("render", "--template", str(_TEMPLATE), "--bot-name", "ew-bot",
                "--bot-port", "9098", "--fleet-port", "9190",
                "--home", "/Users/eweintraub", "--username", "eweintraub").stdout
    assert 'FLEET_HEALTH="http://127.0.0.1:9190/"' in body
    assert "FLEET_PORT" not in body and "BOT_PORT" not in body


def test_render_bad_port_exits_3():
    proc = _run("render", "--template", str(_TEMPLATE), "--bot-name", "rb-bot",
                "--bot-port", "not-a-port", "--fleet-port", "9099",
                "--home", "/Users/rachel", "--json")
    assert proc.returncode == 3, proc.stdout
    assert json.loads(proc.stdout)["status"] == "bad_port"


def test_render_out_of_range_port_exits_3():
    proc = _run("render", "--template", str(_TEMPLATE), "--bot-name", "rb-bot",
                "--bot-port", "70000", "--fleet-port", "9099",
                "--home", "/Users/rachel", "--json")
    assert proc.returncode == 3


def test_render_leading_zero_port_exits_3():
    # "00009" -> curl treats :00009 as a live port and restart-loops; reject it.
    proc = _run("render", "--template", str(_TEMPLATE), "--bot-name", "rb-bot",
                "--bot-port", "00009", "--fleet-port", "9099",
                "--home", "/Users/rachel", "--json")
    assert proc.returncode == 3, proc.stdout


def test_render_rejects_shell_metacharacter_bot_name(tmp_path):
    # Raw substring substitution would turn this into executable shell in the
    # rendered artifact while placeholder verification still passed.
    out = tmp_path / "out.sh"
    proc = _run("render", "--template", str(_TEMPLATE),
                "--bot-name", 'zz"; rm -rf ~ #',
                "--bot-port", "9001", "--fleet-port", "9002",
                "--home", "/opt/zz-home", "--out", str(out))
    assert proc.returncode == 6, proc.stdout + proc.stderr
    assert "UNSAFE_VALUE" in proc.stdout
    assert not out.exists(), "an unsafe render must not write an artifact"


def test_render_rejects_expansion_in_home(tmp_path):
    out = tmp_path / "out.sh"
    proc = _run("render", "--template", str(_TEMPLATE), "--bot-name", "zz-bot",
                "--bot-port", "9001", "--fleet-port", "9002",
                "--home", "/opt/zz-home/$(id)", "--out", str(out))
    assert proc.returncode == 6, proc.stdout + proc.stderr
    assert not out.exists()


def test_render_rejects_relative_or_traversal_home():
    for home in ("opt/zz-home", "/opt/../etc"):
        proc = _run("render", "--template", str(_TEMPLATE), "--bot-name", "zz-bot",
                    "--bot-port", "9001", "--fleet-port", "9002", "--home", home)
        assert proc.returncode == 6, f"home={home!r}: {proc.stdout}"


@pytest.mark.parametrize("reserved", rw.PLACEHOLDER_TOKENS)
def test_render_rejects_placeholder_substrings_in_home(tmp_path, reserved):
    out = tmp_path / "out.sh"
    home = f"/Users/x{reserved}x"
    proc = _run("render", "--template", str(_TEMPLATE), "--bot-name", "zz-bot",
                "--bot-port", "9001", "--fleet-port", "9002",
                "--home", home, "--out", str(out), "--json")
    assert proc.returncode == 6, proc.stdout + proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["status"] == "unsafe_value"
    assert payload["field"] == "--home"
    assert not out.exists()


def test_render_rejects_shell_metacharacter_username():
    proc = _run("render", "--template", str(_TEMPLATE), "--bot-name", "zz-bot",
                "--bot-port", "9001", "--fleet-port", "9002",
                "--home", "/opt/zz-home", "--username", "tester; id")
    assert proc.returncode == 6, proc.stdout


def test_render_accepts_typical_fleet_values(tmp_path):
    out = tmp_path / "out.sh"
    proc = _run("render", "--template", str(_TEMPLATE), "--bot-name", "rb-bot",
                "--bot-port", "9095", "--fleet-port", "9099",
                "--home", "/opt/zz-home-2", "--username", "tester_2",
                "--out", str(out))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert out.exists()


def test_verify_catches_raw_template():
    # The live churn bug: an unrendered template installed verbatim. verify must
    # flag it as unsubstituted (exit 2) and name the surviving tokens.
    proc = _run("verify", "--script", str(_TEMPLATE), "--json")
    assert proc.returncode == 2, proc.stdout
    payload = json.loads(proc.stdout)
    assert payload["status"] == "unsubstituted"
    for tok in ("BOT_PORT", "FLEET_PORT", "BOT_NAME", "USERNAME", "__HOME__"):
        assert tok in payload["placeholders_remaining"], payload


def test_verify_clean_rendered_passes(tmp_path):
    out = tmp_path / "rb-bot-watchdog"
    rc = _run("render", "--template", str(_TEMPLATE), "--bot-name", "rb-bot",
              "--bot-port", "9095", "--fleet-port", "9099",
              "--home", "/Users/rachel", "--username", "rachel", "--out", str(out))
    assert rc.returncode == 0, rc.stderr
    proc = _run("verify", "--script", str(out), "--json")
    assert proc.returncode == 0, proc.stdout
    assert json.loads(proc.stdout)["placeholders_remaining"] == []


def test_find_placeholders_exact_no_false_positives():
    # BOT_JSON / TERMINAL_AUTH_FAILURES / RECOVERING_STATES must NOT be flagged.
    sample = 'data=os.environ["BOT_JSON"]\nTERMINAL_AUTH_FAILURES=(...)\nRECOVERING_STATES=()\n'
    assert rw.find_placeholders(sample) == []
    assert rw.find_placeholders('BOT_HEALTH="http://x:BOT_PORT/"') == ["BOT_PORT"]


def test_find_placeholders_no_username_substring_false_positive():
    # USERNAME embedded in a larger identifier must NOT be flagged (word boundary).
    assert rw.find_placeholders("FLEET_USERNAME_SUFFIX=x\nBOT_USERNAMES=all") == []
    assert rw.find_placeholders("# operator account: USERNAME") == ["USERNAME"]
    # __HOME__ still detected when quoted/spaced despite its underscores.
    assert rw.find_placeholders('HOME_DIR="__HOME__"') == ["__HOME__"]


# --- BOT ERRORS emitter path (baked at render time) ---------------------------
# Hosts run from immutable release trees, not from a fixed checkout, so the
# watchdog cannot guess where the emitter lives. The render bakes the emitter
# of the release the template was rendered from, and refuses a path that does
# not exist rather than installing a watchdog that can never page.

_EMIT_FIXTURE = '#!/bin/zsh\nHOME_DIR="__HOME__"\nBOT_ERRORS_EMIT="__BOT_ERRORS_EMIT__"\n'


def _release_tree(tmp_path: Path, with_emitter: bool = True) -> Path:
    release = tmp_path / "releases" / "WhatSoup-release-abc123"
    template = release / "deploy" / "templates" / "watchdog-script.sh"
    template.parent.mkdir(parents=True)
    template.write_text(_EMIT_FIXTURE, encoding="utf-8")
    if with_emitter:
        emitter = release / "deploy" / "scripts" / "bot-errors-emit.py"
        emitter.parent.mkdir(parents=True)
        emitter.write_text("# emitter\n", encoding="utf-8")
    return template


def _render_emit(template: Path, *extra: str) -> subprocess.CompletedProcess:
    return _run("render", "--template", str(template), "--bot-name", "zz-bot",
                "--bot-port", "9001", "--fleet-port", "9002",
                "--home", "/opt/zz-home", "--json", *extra)


def test_render_bakes_the_emitter_of_the_release_it_renders_from(tmp_path):
    template = _release_tree(tmp_path)
    proc = _render_emit(template)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    payload = json.loads(proc.stdout)
    expected = template.resolve().parents[1] / "scripts" / "bot-errors-emit.py"
    assert payload["bot_errors_emit"] == str(expected)
    body = _run("render", "--template", str(template), "--bot-name", "zz-bot",
                "--bot-port", "9001", "--fleet-port", "9002", "--home", "/opt/zz-home").stdout
    assert f'BOT_ERRORS_EMIT="{expected}"' in body


def test_render_refuses_a_release_without_an_emitter(tmp_path):
    proc = _render_emit(_release_tree(tmp_path, with_emitter=False))
    assert proc.returncode == 4, proc.stdout
    assert json.loads(proc.stdout)["status"] == "bad_input"


def test_render_accepts_an_explicit_existing_emitter(tmp_path):
    template = _release_tree(tmp_path, with_emitter=False)
    emitter = tmp_path / "other" / "bot-errors-emit.py"
    emitter.parent.mkdir()
    emitter.write_text("# emitter\n", encoding="utf-8")
    proc = _render_emit(template, "--bot-errors-emit", str(emitter))
    assert proc.returncode == 0, proc.stdout
    assert json.loads(proc.stdout)["bot_errors_emit"] == str(emitter)


def test_render_rejects_an_unsafe_emitter_path(tmp_path):
    template = _release_tree(tmp_path)
    for value in ("relative/bot-errors-emit.py", "/opt/x$(id)/bot-errors-emit.py", "/opt/BOT_NAME/e.py"):
        proc = _render_emit(template, "--bot-errors-emit", value)
        assert proc.returncode == 6, (value, proc.stdout)
        assert json.loads(proc.stdout)["field"] == "--bot-errors-emit"


def test_real_template_carries_the_emitter_placeholder():
    assert "__BOT_ERRORS_EMIT__" in rw.PLACEHOLDER_TOKENS
    assert 'BOT_ERRORS_EMIT="__BOT_ERRORS_EMIT__"' in _TEMPLATE.read_text(encoding="utf-8")


# --- Loopback health reader binding (baked at render time) --------------------
# The watchdog executes the release's deploy/scripts/lib/health_reader.py only
# after re-verifying its digest. The render derives that reader from the same
# release tree as the emitter and takes the digest from the tree's reviewed
# runtime manifest, refusing a reader that is missing, unlisted, or drifted.

_READER_FIXTURE = (
    '#!/bin/zsh\nHOME_DIR="__HOME__"\n'
    'HEALTH_READER_PATH="__HEALTH_READER_PATH__"\n'
    'HEALTH_READER_SHA256="__HEALTH_READER_SHA256__"\n'
)


def _reader_release(tmp_path: Path, *, with_reader: bool = True, pinned: bool = True) -> tuple[Path, Path]:
    release = tmp_path / "releases" / "WhatSoup-release-def456"
    template = release / "deploy" / "templates" / "watchdog-script.sh"
    template.parent.mkdir(parents=True)
    template.write_text(_READER_FIXTURE, encoding="utf-8")
    reader = release / "deploy" / "scripts" / "lib" / "health_reader.py"
    reader.parent.mkdir(parents=True)
    source = b"def fetch_loopback_health(*args): return 200, '{}'\n"
    if with_reader:
        reader.write_bytes(source)
    digest = hashlib.sha256(source if pinned else b"other\n").hexdigest()
    (release / "deploy" / "bot-errors-runtime-manifest.json").write_text(json.dumps(
        {"schemaVersion": 1, "files": [{"path": "deploy/scripts/lib/health_reader.py", "sha256": digest}]}))
    return template, reader


def _render_reader(template: Path, *extra: str) -> subprocess.CompletedProcess:
    return _run("render", "--template", str(template), "--bot-name", "test-agent",
                "--bot-port", "9999", "--fleet-port", "9998", "--home", "/opt/test-home",
                "--json", *extra)


def test_new_template_requires_health_reader_binding(tmp_path):
    template, _ = _reader_release(tmp_path, with_reader=False)
    out = tmp_path / "watchdog"
    proc = _render_reader(template, "--out", str(out))
    assert proc.returncode == 4
    assert "binding" in proc.stdout.lower()
    assert not out.exists()


def test_binding_derives_reader_and_digest_from_the_release_tree(tmp_path):
    template, reader = _reader_release(tmp_path)
    proc = _render_reader(template)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    value = json.loads(proc.stdout)
    digest = hashlib.sha256(reader.read_bytes()).hexdigest()
    assert value["health_reader_path"] == str(reader.resolve())
    assert value["health_reader_sha256"] == digest
    body = _run("render", "--template", str(template), "--bot-name", "test-agent",
                "--bot-port", "9999", "--fleet-port", "9998", "--home", "/opt/test-home").stdout
    assert f'HEALTH_READER_PATH="{reader.resolve()}"' in body
    assert f'HEALTH_READER_SHA256="{digest}"' in body


def test_binding_refuses_a_reader_that_drifted_from_its_manifest(tmp_path):
    template, _ = _reader_release(tmp_path, pinned=False)
    proc = _render_reader(template)
    assert proc.returncode == 4
    assert json.loads(proc.stdout)["status"] == "bad_input"


def test_binding_uses_reviewed_manifest_for_an_explicit_reader(tmp_path):
    helper = tmp_path / "health_reader.py"
    helper.write_text("def fetch_loopback_health(*args): return 200, '{}'\n")
    digest = hashlib.sha256(helper.read_bytes()).hexdigest()
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"schemaVersion": 1, "files": [
        {"path": "deploy/scripts/lib/health_reader.py", "sha256": digest}]}))
    proc = _render_reader(_TEMPLATE, "--health-reader", str(helper), "--runtime-manifest", str(manifest))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    value = json.loads(proc.stdout)
    assert value["health_reader_sha256"] == digest
    assert value["health_reader_path"] == str(helper)


def test_binding_rejects_an_unsafe_reader_path(tmp_path):
    template, _ = _reader_release(tmp_path)
    for value in ("relative/health_reader.py", "/opt/x$(id)/health_reader.py", "/opt/BOT_NAME/r.py"):
        proc = _render_reader(template, "--health-reader", value)
        assert proc.returncode == 6, (value, proc.stdout)
        assert json.loads(proc.stdout)["field"] == "--health-reader"


def test_real_template_binds_this_checkouts_pinned_reader():
    proc = _render_reader(_TEMPLATE)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    value = json.loads(proc.stdout)
    reader = _SCRIPTS / "lib" / "health_reader.py"
    manifest = json.loads((_SCRIPTS.parent / "bot-errors-runtime-manifest.json").read_text(encoding="utf-8"))
    pinned = [row["sha256"] for row in manifest["files"] if row["path"] == "deploy/scripts/lib/health_reader.py"]
    assert value["health_reader_path"] == str(reader.resolve())
    assert [value["health_reader_sha256"]] == pinned == [hashlib.sha256(reader.read_bytes()).hexdigest()]
    assert value["placeholders_remaining"] == []


@pytest.mark.parametrize("problem", ["boolean_schema", "duplicate_entry", "bad_hash"])
@properties
@given(source=st.binary(min_size=1, max_size=128))
def test_binding_rejects_invalid_manifest_without_output(problem, source):
    with private_case() as (tmp_path, monkeypatch):
        helper = tmp_path / "health_reader.py"
        helper.write_bytes(source)
        digest = hashlib.sha256(helper.read_bytes()).hexdigest()
        row = {"path": "deploy/scripts/lib/health_reader.py", "sha256": digest}
        document = {"schemaVersion": True if problem == "boolean_schema" else 1,
                    "files": [row, row] if problem == "duplicate_entry" else [row]}
        if problem == "bad_hash": row["sha256"] = "0" * 64
        manifest = tmp_path / "manifest.json"
        manifest.write_text(json.dumps(document))
        out = tmp_path / "watchdog"
        proc = _run("render", "--template", str(_TEMPLATE), "--bot-name", "test-agent",
                    "--bot-port", "9999", "--fleet-port", "9998", "--home", "/opt/test-home",
                    "--runtime-manifest", str(manifest), "--health-reader", str(helper),
                    "--out", str(out), "--json")
        assert proc.returncode == 4
        assert not out.exists()
        manifest.write_text(json.dumps({"schemaVersion": 1, "files": [{"path": "deploy/scripts/lib/health_reader.py", "sha256": digest}]}))
        accepted = _run("render", "--template", str(_TEMPLATE), "--bot-name", "test-agent",
                        "--bot-port", "9999", "--fleet-port", "9998", "--home", "/opt/test-home",
                        "--runtime-manifest", str(manifest), "--health-reader", str(helper),
                        "--out", str(out), "--json")
        assert accepted.returncode == 0, accepted.stderr
        assert out.is_file()
