"""Tests for #2356: INCIDENT_RENOTIFY_CAP_SECONDS allows exponential backoff.

fails-before:  Cap default = 21600 (6h) = initial interval. After doubling:
               21600 → capped immediately back to 21600. Never grows.
passes-after:  Cap default = 86400 (24h). Advance: 21600 → 43200 → 86400.
               Backoff meaningfully grows to 24h.

No regression: explicit env override still works.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path


_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"


def _load_mod(env_override: str | None = None) -> object:
    if env_override:
        os.environ["BOT_ERRORS_INCIDENT_RENOTIFY_CAP_SECONDS"] = env_override
    try:
        spec = importlib.util.spec_from_file_location(
            "bot_errors_dispatcher_2356", str(_SCRIPT)
        )
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)
        return mod
    finally:
        if env_override:
            os.environ.pop("BOT_ERRORS_INCIDENT_RENOTIFY_CAP_SECONDS", None)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_default_cap_is_86400():
    """Default cap is 24h (86400s), not 21600."""
    mod = _load_mod()
    assert mod.INCIDENT_RENOTIFY_CAP_SECONDS == 24 * 60 * 60, (
        f"expected 86400, got {mod.INCIDENT_RENOTIFY_CAP_SECONDS}"
    )
    print("PASS: default_cap_86400")


def test_env_override_preserved():
    """Explicit BOT_ERRORS_INCIDENT_RENOTIFY_CAP_SECONDS env var wins."""
    mod = _load_mod("43200")
    assert mod.INCIDENT_RENOTIFY_CAP_SECONDS == 43200, (
        f"expected 43200, got {mod.INCIDENT_RENOTIFY_CAP_SECONDS}"
    )
    print("PASS: env_override_43200")


if __name__ == "__main__":
    test_default_cap_is_86400()
    test_env_override_preserved()
    print()
    print("ALL 2 TESTS PASS (TRUE_RC=0)")
