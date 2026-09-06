"""Discriminating tests for lib/state_root.py (#3051 Car B / packet §6 Module-1).

T1-T6 from the packet. T4 is RED-on-current-main BY CONSTRUCTION: the #3051
false-green root cause is that the watchdog READ path resolved through the
generic state_root() while the sentinel WRITE path resolved through its own
sentinel_state_root(); the cure routes both through sentinel_state_root().
These tests assert the POST-cure behavior (green), and the hand-trace of why
each was RED pre-cure is quoted in the test docstrings.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
LIB_DIR = SCRIPTS_DIR / "lib"
for p in (str(SCRIPTS_DIR), str(LIB_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

sr_mod = importlib.import_module("state_root")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Strip every env var the module reads so each test starts from a known baseline.
    Also suppress test-isolation signals (pytest sets PYTEST_CURRENT_TEST)."""
    for var in (
        "BOT_ERRORS_STATE_DIR",
        "BOT_ERRORS_FLEET_SENTINEL_STATE_DIR",
        "BOT_ERRORS_Q_LOOP_STATE_DIR",
        "VITEST",
        "VITEST_WORKER_ID",
        "JEST_WORKER_ID",
        "PYTEST_CURRENT_TEST",
        "TMPDIR",
        "BOT_ERRORS_FLEET_SENTINEL_HEARTBEAT",
    ):
        monkeypatch.delenv(var, raising=False)
    # pytest sets PYTEST_CURRENT_TEST which triggers variant-B test-isolation.
    # Tests that assert the DEFAULT path suppress the signal explicitly here.
    monkeypatch.setattr(sr_mod, "_STRONG_TEST_SIGNAL_KEYS", ())


# T1 -- variant-A parity: explicit env wins; default when unset.
def test_t1_variant_a_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    assert sr_mod.state_root() == tmp_path


def test_t1_variant_a_default():
    assert sr_mod.state_root() == sr_mod.DEFAULT_STATE_ROOT


# T2 -- variant-B test-isolation preserved: under VITEST signal, returns per-worker tmp.
def test_t2_variant_b_test_isolation(monkeypatch):
    monkeypatch.setattr(sr_mod, "_STRONG_TEST_SIGNAL_KEYS", ("VITEST_WORKER_ID",))
    monkeypatch.setenv("VITEST_WORKER_ID", "7")
    monkeypatch.setenv("TMPDIR", "/tmp")
    result = sr_mod.state_root()
    assert result is not None
    assert "whatsoup-vitest-bot-errors" in str(result)
    assert "7" in result.name
    assert result != sr_mod.DEFAULT_STATE_ROOT  # RED if test-awareness dropped


# T3 -- variant-C anchor-resolve preserved (guards #2723 macOS symlink).
def test_t3_variant_c_anchor_resolve(monkeypatch, tmp_path):
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    resolved = sr_mod.state_root(resolve_anchor=True)
    assert resolved.name == tmp_path.name
    assert resolved.parent.is_absolute()


# T4 -- variant-D sentinel: honors its own env var; defaults to /fleet-sentinel.
# RED-on-main by construction: pre-cure the watchdog READ sentinel-heartbeat.json
# via state_root()/"fleet-sentinel" (BOT_ERRORS_STATE_DIR), while sentinel WROTE
# via BOT_ERRORS_FLEET_SENTINEL_STATE_DIR. When the operator set the sentinel
# override, the watchdog read a missing file -> false-green. Cure: both route
# through sentinel_state_root().
def test_t4_variant_d_sentinel_default():
    assert sr_mod.sentinel_state_root() == sr_mod.DEFAULT_STATE_ROOT / "fleet-sentinel"


def test_t4_variant_d_sentinel_override(monkeypatch, tmp_path):
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_STATE_DIR", str(tmp_path))
    assert sr_mod.sentinel_state_root() == tmp_path


def test_t4_discriminator_sentinel_heartbeat_paths_reconcile(monkeypatch, tmp_path):
    """The #3051 false-green cure: watchdog READ path == sentinel WRITE path
    when the sentinel override is set. Imports the actual watchdog function to
    prove the adoption site agrees, not just the module entry point."""
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_STATE_DIR", str(tmp_path))
    assert sr_mod.sentinel_state_root() == tmp_path
    # Import the watchdog fn via file path (dash in name prevents direct import).
    wd_path = SCRIPTS_DIR / "bot-errors-heartbeat-watchdog.py"
    spec = importlib.util.spec_from_file_location("be_watchdog", wd_path)
    hb_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hb_mod)
    read_path = hb_mod.fleet_sentinel_heartbeat_path()
    assert read_path.parent == tmp_path  # sentinel wrote here, watchdog reads here
    assert read_path.name == "sentinel-heartbeat.json"


# T5 -- variant-E selfcheck: appends /sentinel to canonical root.
def test_t5_variant_e_selfcheck():
    assert sr_mod.selfcheck_state_dir() == sr_mod.DEFAULT_STATE_ROOT / "sentinel"


def test_t5_variant_e_selfcheck_env(monkeypatch, tmp_path):
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    assert sr_mod.selfcheck_state_dir() == tmp_path / "sentinel"


# T6 -- no INDEPENDENT local state_root/default_state_dir defs remain in the adopted scripts.
ADOPTED_SCRIPTS = [
    "bot-errors-collector.py",
    "bot-errors-dispatcher.py",
    "bot-errors-emit.py",
    "bot-errors-health-check.py",
    "bot-errors-heartbeat-watchdog.py",
    "bot-errors-maintenance.py",
    "bot-errors-runner.py",
    "bot-errors-selfcheck.py",
    "bot-errors-sentinel.py",
    # Delegates through a module-private wrapper (#2341), so the pattern below
    # cannot see a restored copy under that name; the import check still holds.
    "bot-errors-tree-provenance.py",
]


def test_t6_no_independent_state_root_defs_remain():
    """No adopted script may define an INDEPENDENT state_root/default_state_dir.

    Exception: heartbeat-watchdog keeps a thin wrapper that delegates to the
    SSOT with resolve_anchor=True (variant C / #2723). That wrapper body must
    call the imported SSOT function -- it is not an independent copy.
    """
    import re

    pattern = re.compile(r"^def (state_root|default_state_dir)\b", re.MULTILINE)
    for script in ADOPTED_SCRIPTS:
        body = (SCRIPTS_DIR / script).read_text()
        matches = pattern.findall(body)
        if not matches:
            continue
        assert script == "bot-errors-heartbeat-watchdog.py", (
            f"{script} defines state_root/default_state_dir (not allowed)"
        )
        assert "_ssot_state_root(resolve_anchor=True)" in body, (
            "heartbeat-watchdog state_root wrapper must delegate to SSOT"
        )


def test_t6_adopted_scripts_import_from_lib():
    """Every adopted script must import its state_root from the SSOT module."""
    for script in ADOPTED_SCRIPTS:
        body = (SCRIPTS_DIR / script).read_text()
        assert "state_root" in body and (
            "from lib.state_root" in body or "from state_root" in body
        ), f"{script} does not import from lib/state_root.py"


# ---------------------------------------------------------------------------
# Variant F (#3051 CAR42) — q-loop root: distinct sibling root.
# ---------------------------------------------------------------------------


# TF1 -- env override honored.
def test_tf1_variant_f_q_loop_env_override(monkeypatch, tmp_path):
    """BOT_ERRORS_Q_LOOP_STATE_DIR wins when set (mirrors T1/T4 env-override shape)."""
    monkeypatch.setenv("BOT_ERRORS_Q_LOOP_STATE_DIR", str(tmp_path))
    assert sr_mod.q_loop_state_root() == tmp_path


# TF2 -- default = sibling bot-errors-q-loop under the same parent as the
# canonical bot-errors root.
def test_tf2_variant_f_q_loop_default_is_sibling():
    """Default q-loop root derives from DEFAULT_STATE_ROOT.parent, NOT state_root().

    Discrimination: the pre-CAR42 inline sites hardcoded
    ``Path.home() / ".local/state/bot-errors-q-loop"``; the SSOT default tracks
    the same parent as DEFAULT_STATE_ROOT so the two roots stay siblings under
    any future DEFAULT_STATE_ROOT relocation. Asserting the sibling relationship
    (same parent, distinct leaf) catches a regression that re-couples the q-loop
    root to state_root() (which would route it through test-isolation and break
    the loop's persistent lock/state files under vitest workers).
    """
    default_q_loop = sr_mod.q_loop_state_root()
    assert default_q_loop.parent == sr_mod.DEFAULT_STATE_ROOT.parent
    assert default_q_loop.name == "bot-errors-q-loop"
    assert default_q_loop != sr_mod.DEFAULT_STATE_ROOT  # distinct root, not the same


# ---------------------------------------------------------------------------
# T7c -- #3051 CAR42 zero-literal regression (mirrors test_state_files.py T7b
# raw-literal scan shape). Drives the #3051 T6 acceptance grep to ZERO on the
# path-construction sites (display/label strings are exempt per the gate's
# ruling-b carve-out).
# ---------------------------------------------------------------------------

# The one known display/label literal the gate ruled OUT of scope (collector
# remote-root label — the ``~`` tilde must be preserved byte-for-byte as a
# display string; str(DEFAULT_STATE_ROOT) would expand it via Path.home()).
DISPLAY_LABEL_EXEMPT_HITS = {
    ("bot-errors-collector.py", 'return value, "~/.local/state/bot-errors"'),
}

# Path-construction literals that MUST be routed through lib/state_root.py.
# Matches the gate's T6 grep substring ``.local/state/bot-errors``.
T7C_LITERAL = ".local/state/bot-errors"


def test_t7c_no_path_literals_in_consumer_scripts() -> None:
    """T7c: no consumer script references the state-root path by raw literal
    EXCEPT the gate-exempt display label in collector.py.

    Mirrors test_state_files.py::test_no_raw_state_filename_literals_in_components.
    Discrimination: reverting ANY migrated path-construction site (e.g.
    restoring ``DEFAULT_STATE_ROOT / "outbox"`` back to
    ``Path.home() / ".local/state/bot-errors/outbox"``) turns this red because
    the literal substring ``.local/state/bot-errors`` reappears outside the
    exempt set.
    """
    import re

    offenders: list[str] = []
    for script in sorted(SCRIPTS_DIR.glob("bot-errors-*.py")):
        text = script.read_text(encoding="utf-8")
        for lineno, line in enumerate(text.splitlines(), start=1):
            if T7C_LITERAL not in line:
                continue
            stripped = line.strip()
            if (script.name, stripped) in DISPLAY_LABEL_EXEMPT_HITS:
                continue  # gate ruling-b: display label, byte-identity preserved
            offenders.append(f"{script.name}:{lineno}: {stripped}")
    assert offenders == [], (
        "raw state-root path literal(s) found outside lib/state_root.py "
        "(route through the SSOT entry point instead):\n" + "\n".join(offenders)
    )
