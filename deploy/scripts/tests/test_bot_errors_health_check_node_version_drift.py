"""Tests for the running-process node-version drift assertion (#3074).

The daily health probe records the instance's running nodeVersion into evidence
(bot-errors-health-check.py ``health_probe_details``) but never asserted it
against the repo pin. This car adds a drift WARN marker when the running version
disagrees with ``.nvmrc``, mirroring the existing ``auth_bond_backup_age_warning``
WARN-cause precedent.

Loads bot-errors-health-check.py via importlib (hyphen in filename prevents
normal import). Mirrors the loader convention in
test_bot_errors_health_check_auth_bond.py.
"""

from __future__ import annotations

import datetime
import importlib.util
import json
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Module loader
# ---------------------------------------------------------------------------

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-health-check.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_health_check", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()
health_probe_details = _mod.health_probe_details
format_health_probe = _mod.format_health_probe
node_version_drift_marker = _mod.node_version_drift_marker
normalize_node_version = _mod.normalize_node_version
read_nvmrc_pin = _mod.read_nvmrc_pin


# ---------------------------------------------------------------------------
# Health-body fixtures
# ---------------------------------------------------------------------------


def _health_body(node_version: str | None, *, generated_at: str | None = None) -> str:
    """Build a minimal 200-OK /health JSON body with the given running nodeVersion.

    ``generated_at`` defaults to NOW so the freshness check is silent: a missing
    key co-fires health_generated_at_missing (a WARN cause) and a far-future
    value co-fires health_generated_at_future_skew (a FAIL cause) — either one
    masks the node_version_drift WARN discriminator (the Q163 finding).
    """
    if generated_at is None:
        generated_at = (
            datetime.datetime.now(datetime.timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )
    env: dict[str, str] = {}
    if node_version is not None:
        env["nodeVersion"] = node_version
    return json.dumps(
        {
            "status": "healthy",
            "generatedAt": generated_at,
            # Q163 fix: the source freshness check reads snake_case
            # ``generated_at`` — emitting only camelCase left it None, which
            # co-fired health_generated_at_missing (itself a WARN cause) and
            # vacuously masked the node_version_drift WARN discriminator.
            "generated_at": generated_at,
            "whatsapp": {"credential_lifecycle": {"environment": env}},
        }
    )


# ---------------------------------------------------------------------------
# Unit tests for the pure helpers
# ---------------------------------------------------------------------------


class TestNormalizeNodeVersion:
    def test_strips_leading_v(self):
        assert normalize_node_version("v24.15.0") == "24.15.0"

    def test_strips_leading_capital_v(self):
        assert normalize_node_version("V24.15.0") == "24.15.0"

    def test_no_prefix_unchanged(self):
        assert normalize_node_version("24.15.0") == "24.15.0"

    def test_strips_whitespace(self):
        assert normalize_node_version("  v24.15.0\n") == "24.15.0"

    def test_empty_string(self):
        assert normalize_node_version("") == ""

    def test_non_string(self):
        assert normalize_node_version(None) == ""  # type: ignore[arg-type]


class TestNodeVersionDriftMarker:
    def test_drift_returns_marker(self):
        marker = node_version_drift_marker("v22.0.0", "24.15.0")
        assert marker is not None
        assert marker.startswith("node_version_drift")
        assert "running=22.0.0" in marker
        assert "pinned=24.15.0" in marker

    def test_match_returns_none(self):
        assert node_version_drift_marker("24.15.0", "24.15.0") is None

    def test_match_with_v_prefix_on_both(self):
        assert node_version_drift_marker("v24.15.0", "24.15.0") is None

    def test_running_absent_returns_none(self):
        """DISCRIMINATOR: undiscoverable running version is NOT drift (no false positive)."""
        assert node_version_drift_marker(None, "24.15.0") is None
        assert node_version_drift_marker("", "24.15.0") is None

    def test_pinned_absent_returns_none(self):
        """No .nvmrc pin available -> cannot assert drift -> no marker."""
        assert node_version_drift_marker("24.15.0", "") is None
        assert node_version_drift_marker("24.15.0", None) is None  # type: ignore[arg-type]

    def test_both_absent_returns_none(self):
        assert node_version_drift_marker(None, "") is None
        assert node_version_drift_marker("", "") is None

    def test_whitespace_only_running_returns_none(self):
        assert node_version_drift_marker("   ", "24.15.0") is None


class TestReadNvmrcPin:
    def test_reads_actual_repo_pin(self):
        """The real .nvmrc at repo root must be readable and non-empty."""
        pin = read_nvmrc_pin()
        assert pin, "expected .nvmrc to be present and non-empty at REPO_ROOT"
        assert pin == normalize_node_version(pin), "pin should already be normalized"


# ---------------------------------------------------------------------------
# Integration: health_probe_details emits the marker into the details string
# ---------------------------------------------------------------------------


class TestHealthProbeDetailsDrift:
    def test_drift_marker_present_when_running_differs_from_pin(self, monkeypatch):
        """DISCRIMINATOR: drift -> the node_version_drift marker is in details.

        FAILS if the comparison branch is removed: both fixtures (drift + match)
        return the same (no-marker) result.
        """
        monkeypatch.setattr(_mod, "read_nvmrc_pin", lambda: "24.15.0")
        details = health_probe_details(200, _health_body("v22.0.0"))
        assert "node_version_drift" in details
        assert "running=22.0.0" in details
        assert "pinned=24.15.0" in details

    def test_no_drift_marker_when_running_matches_pin(self, monkeypatch):
        """Match -> no drift marker in details (regression guard)."""
        monkeypatch.setattr(_mod, "read_nvmrc_pin", lambda: "24.15.0")
        details = health_probe_details(200, _health_body("24.15.0"))
        assert "node_version_drift" not in details

    def test_no_drift_marker_when_running_version_absent(self, monkeypatch):
        """DISCRIMINATOR: undiscoverable running version -> NO false-positive drift.

        FAILS if the absent-telemetry guard is removed: a missing nodeVersion
        would otherwise compare empty-string against the pin and emit a spurious
        drift marker.
        """
        monkeypatch.setattr(_mod, "read_nvmrc_pin", lambda: "24.15.0")
        details = health_probe_details(200, _health_body(None))
        assert "node_version_drift" not in details

    def test_no_drift_marker_when_nvmrc_unreadable(self, monkeypatch):
        """No pin baseline available -> no drift assertion -> no marker."""
        monkeypatch.setattr(_mod, "read_nvmrc_pin", lambda: "")
        details = health_probe_details(200, _health_body("v22.0.0"))
        assert "node_version_drift" not in details


# ---------------------------------------------------------------------------
# Integration: format_health_probe escalates drift to a WARN-prefixed line
# ---------------------------------------------------------------------------


class TestFormatHealthProbeDrift:
    def test_drift_line_is_warn_prefixed(self, monkeypatch):
        """DISCRIMINATOR: drift -> the probe line carries a WARN prefix.

        FAILS if the WARN-cause registration is removed: the line drops to no
        prefix (info-class) and the daily summary loses the signal.
        """
        monkeypatch.setattr(_mod, "read_nvmrc_pin", lambda: "24.15.0")
        line = format_health_probe(
            "http://127.0.0.1:58000/health", 200, _health_body("v22.0.0")
        )
        assert line.startswith("WARN ")
        assert "node_version_drift" in line

    def test_match_line_has_no_warn_prefix(self, monkeypatch):
        """Match -> no WARN prefix from node drift (may still be healthy)."""
        monkeypatch.setattr(_mod, "read_nvmrc_pin", lambda: "24.15.0")
        line = format_health_probe(
            "http://127.0.0.1:58000/health", 200, _health_body("24.15.0")
        )
        # A matched version must not contribute a WARN prefix on its own. (Other
        # WARN causes in the same body are independent; this fixture has none.)
        assert "node_version_drift" not in line

    def test_undiscoverable_line_has_no_drift_warn(self, monkeypatch):
        """No running version -> no drift WARN (no false positive)."""
        monkeypatch.setattr(_mod, "read_nvmrc_pin", lambda: "24.15.0")
        line = format_health_probe(
            "http://127.0.0.1:58000/health", 200, _health_body(None)
        )
        assert "node_version_drift" not in line
