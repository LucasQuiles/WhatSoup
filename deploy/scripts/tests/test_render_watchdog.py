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
