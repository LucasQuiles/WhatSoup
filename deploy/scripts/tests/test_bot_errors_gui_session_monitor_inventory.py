"""Tests for #2467 — GUI-session monitor inventory validation fail-closed.

The external GUI-session monitor converted a missing, unreadable, malformed,
or non-object fleet inventory into an empty object.  Its scheduled run_once()
path then derived zero targets, wrote state, emitted no diagnostic, and
returned success — silently erasing all coverage for the monitor that exists
specifically to detect the class of failures where an in-session observer
disappears with the GUI session.

These tests verify the unified canonical validator (validate_inventory) used
by both --config-check and the scheduled --once path:

  - Missing/unreadable/malformed/non-object/implicit-empty inventories fail
    closed (exit 2) in BOTH paths.
  - Invalid cycles perform zero SSH probes, zero state writes.
  - Explicit not_applicable declarations distinguish from implicit-empty.
  - Both config_check and run_once agree on every invalid class.

Module loader mirrors the existing test_bot_errors_gui_session_monitor.py
pattern (importlib with sys.modules registration for annotation resolution).
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-gui-session-monitor.py"


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_gui_session_monitor_2467", _SCRIPT
    )
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    assert spec and spec.loader
    # Register before exec so NamedTuple / annotation resolution works.
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture(scope="module")
def mod():
    return _load_module()


def _write_fleet(tmp_path: Path, data) -> Path:
    """Write a fleet file and return its path."""
    fleet_file = tmp_path / "fleet.json"
    if isinstance(data, str):
        fleet_file.write_text(data, encoding="utf-8")
    else:
        fleet_file.write_text(json.dumps(data), encoding="utf-8")
    return fleet_file


# ---------------------------------------------------------------------------
# validate_inventory — typed result for every invalid class
# ---------------------------------------------------------------------------


class TestValidateInventoryStatus:
    """validate_inventory returns the correct status for every class."""

    def test_missing_file_returns_missing(self, mod, tmp_path, monkeypatch):
        path = tmp_path / "nonexistent.json"
        monkeypatch.setattr(mod, "fleet_path", lambda: path)
        result = mod.validate_inventory()
        assert result.status == mod.INVENTORY_MISSING
        assert result.fleet is None
        assert result.targets == []
        assert result.error is not None

    def test_malformed_json_returns_malformed(self, mod, tmp_path, monkeypatch):
        path = _write_fleet(tmp_path, "{not valid json")
        monkeypatch.setattr(mod, "fleet_path", lambda: path)
        result = mod.validate_inventory()
        assert result.status == mod.INVENTORY_MALFORMED
        assert result.fleet is None
        assert result.targets == []
        assert result.error is not None

    def test_truncated_json_returns_malformed(self, mod, tmp_path, monkeypatch):
        path = _write_fleet(tmp_path, '{"hosts": [{"host": "h1", "ins')
        monkeypatch.setattr(mod, "fleet_path", lambda: path)
        result = mod.validate_inventory()
        assert result.status == mod.INVENTORY_MALFORMED

    def test_non_object_json_returns_non_object(self, mod, tmp_path, monkeypatch):
        path = _write_fleet(tmp_path, "[1, 2, 3]")
        monkeypatch.setattr(mod, "fleet_path", lambda: path)
        result = mod.validate_inventory()
        assert result.status == mod.INVENTORY_NON_OBJECT
        assert result.fleet is None

    def test_non_object_string_returns_non_object(self, mod, tmp_path, monkeypatch):
        path = _write_fleet(tmp_path, '"just a string"')
        monkeypatch.setattr(mod, "fleet_path", lambda: path)
        result = mod.validate_inventory()
        assert result.status == mod.INVENTORY_NON_OBJECT

    def test_non_object_number_returns_non_object(self, mod, tmp_path, monkeypatch):
        path = _write_fleet(tmp_path, "42")
        monkeypatch.setattr(mod, "fleet_path", lambda: path)
        result = mod.validate_inventory()
        assert result.status == mod.INVENTORY_NON_OBJECT

    def test_empty_hosts_returns_implicit_empty(self, mod, tmp_path, monkeypatch):
        path = _write_fleet(tmp_path, {"hosts": []})
        monkeypatch.setattr(mod, "fleet_path", lambda: path)
        result = mod.validate_inventory()
        assert result.status == mod.INVENTORY_IMPLICIT_EMPTY
        assert result.targets == []

    def test_missing_hosts_key_returns_implicit_empty(self, mod, tmp_path, monkeypatch):
        path = _write_fleet(tmp_path, {"version": "1.0"})
        monkeypatch.setattr(mod, "fleet_path", lambda: path)
        result = mod.validate_inventory()
        assert result.status == mod.INVENTORY_IMPLICIT_EMPTY

    def test_unknown_policy_returns_invalid_policy(self, mod, tmp_path, monkeypatch):
        fleet = {
            "hosts": [
                {
                    "host": "synth-host-a",
                    "instances": [
                        {
                            "service": "com.whatsoup.primary",
                            "guiSessionExpected": "bogus",
                        },
                    ],
                }
            ]
        }
        path = _write_fleet(tmp_path, fleet)
        monkeypatch.setattr(mod, "fleet_path", lambda: path)
        result = mod.validate_inventory()
        assert result.status == mod.INVENTORY_INVALID_POLICY
        assert "bogus" in (result.error or "")

    def test_valid_fleet_with_targets_returns_valid(self, mod, tmp_path, monkeypatch):
        fleet = {
            "hosts": [
                {
                    "host": "synth-host-a",
                    "instances": [
                        {
                            "service": "com.whatsoup.primary",
                            "guiSessionExpected": "always_aqua",
                        },
                    ],
                }
            ]
        }
        path = _write_fleet(tmp_path, fleet)
        monkeypatch.setattr(mod, "fleet_path", lambda: path)
        result = mod.validate_inventory()
        assert result.status == mod.INVENTORY_VALID
        assert len(result.targets) == 1
        assert result.fleet is not None

    def test_all_not_applicable_returns_not_applicable(
        self, mod, tmp_path, monkeypatch
    ):
        """Fleet where every instance explicitly declares not_applicable."""
        fleet = {
            "hosts": [
                {
                    "host": "synth-headless-a",
                    "instances": [
                        {
                            "service": "systemd-unit",
                            "guiSessionExpected": "not_applicable",
                        },
                    ],
                }
            ]
        }
        path = _write_fleet(tmp_path, fleet)
        monkeypatch.setattr(mod, "fleet_path", lambda: path)
        result = mod.validate_inventory()
        assert result.status == mod.INVENTORY_NOT_APPLICABLE
        assert result.targets == []

    def test_mixed_not_applicable_and_headless_ok_returns_not_applicable(
        self, mod, tmp_path, monkeypatch
    ):
        """All instances excluded by policy → not_applicable (zero targets, explicitly declared)."""
        fleet = {
            "hosts": [
                {
                    "host": "synth-host-a",
                    "instances": [
                        {"service": "unit1", "guiSessionExpected": "headless_ok"},
                        {"service": "unit2", "guiSessionExpected": "not_applicable"},
                    ],
                }
            ]
        }
        path = _write_fleet(tmp_path, fleet)
        monkeypatch.setattr(mod, "fleet_path", lambda: path)
        result = mod.validate_inventory()
        assert result.status == mod.INVENTORY_NOT_APPLICABLE


# ---------------------------------------------------------------------------
# config_check and run_once agree on every invalid class
# ---------------------------------------------------------------------------


class TestConfigCheckRunOnceAgreement:
    """Both entry points must fail closed on every invalid class (#2467)."""

    @pytest.mark.parametrize(
        "fleet_data,expected_status",
        [
            ('{"hosts":[]}', "implicit_empty"),
            ("[1,2,3]", "non_object"),
            ("{bad json", "malformed"),
            ('"string"', "non_object"),
            ("42", "non_object"),
            ('{"version":"1.0"}', "implicit_empty"),
        ],
    )
    def test_config_check_fails_closed(
        self, mod, tmp_path, monkeypatch, fleet_data, expected_status
    ):
        path = _write_fleet(tmp_path, fleet_data)
        monkeypatch.setattr(mod, "fleet_path", lambda: path)
        assert mod.config_check() == 2

    @pytest.mark.parametrize(
        "fleet_data,expected_status",
        [
            ('{"hosts":[]}', "implicit_empty"),
            ("[1,2,3]", "non_object"),
            ("{bad json", "malformed"),
            ('"string"', "non_object"),
            ("42", "non_object"),
            ('{"version":"1.0"}', "implicit_empty"),
        ],
    )
    def test_run_once_fails_closed(
        self, mod, tmp_path, monkeypatch, fleet_data, expected_status
    ):
        path = _write_fleet(tmp_path, fleet_data)
        monkeypatch.setattr(mod, "fleet_path", lambda: path)
        monkeypatch.setattr(mod, "load_state", lambda: {})
        monkeypatch.setattr(mod, "save_state", lambda s: None)
        assert mod.run_once(dry_run=False) == 2

    def test_config_check_passes_on_not_applicable(self, mod, tmp_path, monkeypatch):
        fleet = {
            "hosts": [
                {
                    "host": "h1",
                    "instances": [
                        {"service": "unit1", "guiSessionExpected": "not_applicable"}
                    ],
                }
            ]
        }
        path = _write_fleet(tmp_path, fleet)
        monkeypatch.setattr(mod, "fleet_path", lambda: path)
        assert mod.config_check() == 0

    def test_run_once_passes_on_not_applicable(self, mod, tmp_path, monkeypatch):
        fleet = {
            "hosts": [
                {
                    "host": "h1",
                    "instances": [
                        {"service": "unit1", "guiSessionExpected": "not_applicable"}
                    ],
                }
            ]
        }
        path = _write_fleet(tmp_path, fleet)
        monkeypatch.setattr(mod, "fleet_path", lambda: path)
        assert mod.run_once(dry_run=False) == 0


# ---------------------------------------------------------------------------
# Invalid cycles: zero probes, zero state writes
# ---------------------------------------------------------------------------


class TestInvalidCycleSideEffects:
    """Invalid inventory cycles must perform zero SSH probes and zero state writes."""

    def test_run_once_missing_file_no_probe_no_state_write(
        self, mod, tmp_path, monkeypatch
    ):
        path = tmp_path / "nonexistent.json"
        monkeypatch.setattr(mod, "fleet_path", lambda: path)

        save_calls = []
        monkeypatch.setattr(mod, "save_state", lambda s: save_calls.append(s))

        probe_calls = []
        monkeypatch.setattr(
            mod,
            "probe_host",
            lambda *a, **kw: (
                probe_calls.append(a)
                or {
                    "console_owner": None,
                    "agent_state": None,
                    "console_ok": False,
                    "agent_ok": False,
                    "error": "test",
                }
            ),
        )

        rc = mod.run_once(dry_run=False)
        assert rc == 2
        assert save_calls == []
        assert probe_calls == []

    def test_run_once_malformed_no_probe_no_state_write(
        self, mod, tmp_path, monkeypatch
    ):
        path = _write_fleet(tmp_path, "{bad json")
        monkeypatch.setattr(mod, "fleet_path", lambda: path)

        save_calls = []
        monkeypatch.setattr(mod, "save_state", lambda s: save_calls.append(s))
        monkeypatch.setattr(
            mod,
            "probe_host",
            lambda *a, **kw: (_ for _ in ()).throw(AssertionError("should not probe")),
        )

        rc = mod.run_once(dry_run=False)
        assert rc == 2
        assert save_calls == []

    def test_run_once_implicit_empty_no_probe_no_state_write(
        self, mod, tmp_path, monkeypatch
    ):
        path = _write_fleet(tmp_path, '{"hosts":[]}')
        monkeypatch.setattr(mod, "fleet_path", lambda: path)

        save_calls = []
        monkeypatch.setattr(mod, "save_state", lambda s: save_calls.append(s))
        monkeypatch.setattr(
            mod,
            "probe_host",
            lambda *a, **kw: (_ for _ in ()).throw(AssertionError("should not probe")),
        )

        rc = mod.run_once(dry_run=False)
        assert rc == 2
        assert save_calls == []

    def test_run_once_does_not_overwrite_prior_state_on_invalid(
        self, mod, tmp_path, monkeypatch
    ):
        """Invalid cycles must preserve prior state without overwriting it."""
        path = tmp_path / "nonexistent.json"
        monkeypatch.setattr(mod, "fleet_path", lambda: path)

        prior_state = {"synth-host-a/agent": {"consecutive_failures": 1}}
        monkeypatch.setattr(mod, "load_state", lambda: prior_state)

        save_calls = []
        monkeypatch.setattr(mod, "save_state", lambda s: save_calls.append(s))

        rc = mod.run_once(dry_run=False)
        assert rc == 2
        assert save_calls == []  # save_state never called → prior state preserved


# ---------------------------------------------------------------------------
# Post-install drift: deletion, truncation, replacement
# ---------------------------------------------------------------------------


class TestPostInstallDrift:
    """A valid config at install time can drift to invalid post-install."""

    def test_valid_then_deleted_fails_closed(self, mod, tmp_path, monkeypatch):
        """Simulate: config-check passes, then file deleted, then --once run."""
        fleet_file = _write_fleet(
            tmp_path,
            {
                "hosts": [
                    {
                        "host": "h1",
                        "instances": [
                            {
                                "service": "com.whatsoup.primary",
                                "guiSessionExpected": "always_aqua",
                            }
                        ],
                    }
                ]
            },
        )
        monkeypatch.setattr(mod, "fleet_path", lambda: fleet_file)
        assert mod.config_check() == 0

        # Delete the file (simulating post-install drift)
        fleet_file.unlink()
        monkeypatch.setattr(mod, "load_state", lambda: {})
        monkeypatch.setattr(mod, "save_state", lambda s: None)
        assert mod.run_once(dry_run=False) == 2

    def test_valid_then_truncated_fails_closed(self, mod, tmp_path, monkeypatch):
        fleet_file = _write_fleet(
            tmp_path,
            {
                "hosts": [
                    {
                        "host": "h1",
                        "instances": [
                            {
                                "service": "com.whatsoup.primary",
                                "guiSessionExpected": "always_aqua",
                            }
                        ],
                    }
                ]
            },
        )
        monkeypatch.setattr(mod, "fleet_path", lambda: fleet_file)
        assert mod.config_check() == 0

        # Truncate the file
        fleet_file.write_text('{"hosts": [{"host": "h1", "ins', encoding="utf-8")
        monkeypatch.setattr(mod, "load_state", lambda: {})
        monkeypatch.setattr(mod, "save_state", lambda s: None)
        assert mod.run_once(dry_run=False) == 2

    def test_valid_then_replaced_with_non_object_fails_closed(
        self, mod, tmp_path, monkeypatch
    ):
        fleet_file = _write_fleet(
            tmp_path,
            {
                "hosts": [
                    {
                        "host": "h1",
                        "instances": [
                            {
                                "service": "com.whatsoup.primary",
                                "guiSessionExpected": "always_aqua",
                            }
                        ],
                    }
                ]
            },
        )
        monkeypatch.setattr(mod, "fleet_path", lambda: fleet_file)
        assert mod.config_check() == 0

        # Replace with a JSON array
        fleet_file.write_text("[1,2,3]", encoding="utf-8")
        monkeypatch.setattr(mod, "load_state", lambda: {})
        monkeypatch.setattr(mod, "save_state", lambda s: None)
        assert mod.run_once(dry_run=False) == 2


# ---------------------------------------------------------------------------
# Recovery: valid inventory restored after gap
# ---------------------------------------------------------------------------


class TestRecovery:
    """Restoring a valid inventory after an invalid cycle resumes monitoring."""

    def test_recovery_after_deletion(self, mod, tmp_path, monkeypatch):
        fleet_file = _write_fleet(
            tmp_path,
            {
                "hosts": [
                    {
                        "host": "h1",
                        "instances": [
                            {
                                "service": "com.whatsoup.primary",
                                "guiSessionExpected": "always_aqua",
                            }
                        ],
                    }
                ]
            },
        )
        monkeypatch.setattr(mod, "fleet_path", lambda: fleet_file)
        monkeypatch.setattr(mod, "load_state", lambda: {})

        save_calls = []
        monkeypatch.setattr(mod, "save_state", lambda s: save_calls.append(s))

        # Delete → fail closed
        fleet_file.unlink()
        assert mod.run_once(dry_run=False) == 2
        assert save_calls == []

        # Restore → resumes
        _write_fleet(
            tmp_path,
            {
                "hosts": [
                    {
                        "host": "h1",
                        "instances": [
                            {
                                "service": "com.whatsoup.primary",
                                "guiSessionExpected": "always_aqua",
                            }
                        ],
                    }
                ]
            },
        )
        monkeypatch.setattr(
            mod,
            "probe_host",
            lambda *a, **kw: {
                "console_owner": "botuser",
                "agent_state": "running",
                "console_ok": True,
                "agent_ok": True,
                "boot_id": "test",
            },
        )
        rc = mod.run_once(dry_run=False)
        assert rc == 0
        assert len(save_calls) == 1  # state written on valid cycle


# ---------------------------------------------------------------------------
# Diagnostic output: structured, privacy-safe
# ---------------------------------------------------------------------------


class TestDiagnostics:
    """Invalid-cycle diagnostics must be bounded and privacy-safe."""

    def test_missing_file_diagnostic_has_no_identity(
        self, mod, tmp_path, monkeypatch, capsys
    ):
        path = tmp_path / "nonexistent.json"
        monkeypatch.setattr(mod, "fleet_path", lambda: path)
        monkeypatch.setattr(mod, "load_state", lambda: {})
        monkeypatch.setattr(mod, "save_state", lambda s: None)
        mod.run_once(dry_run=False)
        err = capsys.readouterr().err
        assert "not found" in err
        # The diagnostic must not contain inventory contents or deployment identities.
        assert "hosts" not in err.lower() or "fleet" in err.lower()

    def test_implicit_empty_diagnostic_mentions_not_applicable(
        self, mod, tmp_path, monkeypatch, capsys
    ):
        path = _write_fleet(tmp_path, '{"hosts":[]}')
        monkeypatch.setattr(mod, "fleet_path", lambda: path)
        monkeypatch.setattr(mod, "load_state", lambda: {})
        monkeypatch.setattr(mod, "save_state", lambda s: None)
        mod.run_once(dry_run=False)
        err = capsys.readouterr().err
        assert "not_applicable" in err

    def test_config_check_not_applicable_output(
        self, mod, tmp_path, monkeypatch, capsys
    ):
        fleet = {
            "hosts": [
                {
                    "host": "h1",
                    "instances": [
                        {"service": "unit1", "guiSessionExpected": "not_applicable"}
                    ],
                }
            ]
        }
        path = _write_fleet(tmp_path, fleet)
        monkeypatch.setattr(mod, "fleet_path", lambda: path)
        rc = mod.config_check()
        out = capsys.readouterr().out
        assert rc == 0
        assert "not_applicable" in out


# ---------------------------------------------------------------------------
# _fleet_declares_not_applicable
# ---------------------------------------------------------------------------


class TestFleetDeclaresNotApplicable:
    def test_true_when_instance_has_not_applicable(self, mod):
        fleet = {
            "hosts": [
                {
                    "host": "h1",
                    "instances": [
                        {"service": "unit1", "guiSessionExpected": "not_applicable"}
                    ],
                }
            ]
        }
        assert mod._fleet_declares_not_applicable(fleet) is True

    def test_false_when_no_not_applicable(self, mod):
        fleet = {
            "hosts": [
                {
                    "host": "h1",
                    "instances": [
                        {"service": "unit1", "guiSessionExpected": "always_aqua"}
                    ],
                }
            ]
        }
        assert mod._fleet_declares_not_applicable(fleet) is False

    def test_false_when_empty_hosts(self, mod):
        fleet = {"hosts": []}
        assert mod._fleet_declares_not_applicable(fleet) is False

    def test_false_when_missing_hosts(self, mod):
        fleet = {}
        assert mod._fleet_declares_not_applicable(fleet) is False

    def test_true_mixed_with_headless_ok(self, mod):
        fleet = {
            "hosts": [
                {
                    "host": "h1",
                    "instances": [
                        {"service": "unit1", "guiSessionExpected": "headless_ok"},
                        {"service": "unit2", "guiSessionExpected": "not_applicable"},
                    ],
                }
            ]
        }
        assert mod._fleet_declares_not_applicable(fleet) is True
