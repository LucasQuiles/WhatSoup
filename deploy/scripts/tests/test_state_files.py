"""Executable contract for the state-filename SSOT (#3050, QPKT-3051-3050 Car A).

Guards the cross-component read/write contract: every BOT ERRORS component
must reference state filenames through ``lib/state_files.py`` constants, never
raw literals. A raw literal reintroduced in any component desyncs writers from
readers on the next rename (the #3050 false-green class: the watchdog reads a
file the writer no longer produces, sees nothing wrong, and reports green).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))

from lib import state_files  # noqa: E402 — needs the scripts dir on sys.path
COMPONENT_GLOB = "bot-errors-*.py"

# The complete constant surface (packet §4 Module 2). Q_LOOP_STATE's literal
# ("state.json") is excluded from the raw-literal scan below: it is a generic
# name that legitimately appears in q-loop namespace code Car A does not touch.
EXPECTED_CONSTANTS = {
    "COLLECTOR_STATE": "collector-state.json",
    "DISPATCHER_STATE": "dispatcher-state.json",
    "INCIDENT_STATE": "incident-state.json",
    "DISPATCHER_META_STATE": "dispatcher-meta-state.json",
    "MAINTENANCE": "maintenance.json",
    "HEARTBEAT_WATCHDOG_STATE": "heartbeat-watchdog-state.json",
    "SELFCHECK_STATE": "selfcheck-state.json",
    "DEADMAN_STATE": "deadman-state.json",
    "GUI_SESSION_MONITOR_STATE": "gui-session-monitor-state.json",
    "RUNTIME_STALENESS_STATE": "runtime-staleness-state.json",
    "SENTINEL_HEARTBEAT": "sentinel-heartbeat.json",
    "FLEET_SENTINEL_STATE": "fleet-sentinel-state.json",
    "Q_LOOP_STATE": "state.json",
}

SCANNED_LITERALS = {
    name: literal
    for name, literal in EXPECTED_CONSTANTS.items()
    if name != "Q_LOOP_STATE"
}


def test_constants_are_byte_identical_to_contract() -> None:
    """T7a: every constant exists and carries the exact pre-migration filename."""
    for name, literal in EXPECTED_CONSTANTS.items():
        assert getattr(state_files, name) == literal, (
            f"{name} must stay byte-identical to the on-disk filename "
            f"{literal!r}; a drift here silently orphans existing state files"
        )


def test_no_raw_state_filename_literals_in_components() -> None:
    """T7b: no component references a state filename by raw quoted literal.

    Discrimination: restoring any single migrated site (e.g. reverting
    ``state_root() / COLLECTOR_STATE`` back to
    ``state_root() / "collector-state.json"``) turns this red.
    """
    offenders: list[str] = []
    for script in sorted(SCRIPTS_DIR.glob(COMPONENT_GLOB)):
        text = script.read_text(encoding="utf-8")
        for lineno, line in enumerate(text.splitlines(), start=1):
            for literal in SCANNED_LITERALS.values():
                if re.search(rf"[\"']{re.escape(literal)}[\"']", line):
                    offenders.append(f"{script.name}:{lineno}: {line.strip()}")
    assert offenders == [], (
        "raw state-filename literal(s) found outside lib/state_files.py "
        "(import the constant instead):\n" + "\n".join(offenders)
    )


def test_cross_component_writer_reader_share_the_collector_constant() -> None:
    """T8: collector (writer) and heartbeat-watchdog (reader) both bind to the
    SAME constant object, so a rename propagates to both sides atomically.

    Structural proof: both import ``COLLECTOR_STATE`` from ``lib.state_files``
    and neither carries the raw literal (asserted above); the module attribute
    is the single point a rename flows through.
    """
    collector = (SCRIPTS_DIR / "bot-errors-collector.py").read_text(encoding="utf-8")
    watchdog = (SCRIPTS_DIR / "bot-errors-heartbeat-watchdog.py").read_text(encoding="utf-8")
    import_re = re.compile(
        r"from lib\.state_files import \(?[^)]*\bCOLLECTOR_STATE\b", re.DOTALL
    )
    assert import_re.search(collector), (
        "collector (writer) must import COLLECTOR_STATE from lib.state_files"
    )
    assert import_re.search(watchdog), (
        "heartbeat-watchdog (reader) must import COLLECTOR_STATE from lib.state_files"
    )
