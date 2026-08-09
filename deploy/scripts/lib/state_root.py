"""Single source of truth for bot-errors state-root resolution (#3051).

Reconciles the 5 behavioral variants that previously existed as 9 independent
copies across the dispatcher cluster (variant key in each docstring):

  A (one-liner)        — collector / dispatcher / maintenance
  B (test-aware)       — emit / health-check / runner (per-worker tmp isolation)
  C (anchor-resolve)   — heartbeat-watchdog (#2723 macOS /var -> /private/var)
  D (sentinel)         — sentinel (BOT_ERRORS_FLEET_SENTINEL_STATE_DIR + /fleet-sentinel)
  E (suffix + rename)  — selfcheck (appends /sentinel; fn was default_state_dir)

Variant divergence is PRESERVED, not flattened: collapsing B breaks test
isolation (state bleed across vitest workers), C regresses #2723 on macOS,
D is the #3051 false-green root cause itself.

Companion module: ``lib.state_files`` (#3050, Car A / PR #3093).
"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

ENV_STATE_ROOT = "BOT_ERRORS_STATE_DIR"
ENV_SENTINEL_STATE_DIR = "BOT_ERRORS_FLEET_SENTINEL_STATE_DIR"
DEFAULT_STATE_ROOT = Path.home() / ".local/state" / "bot-errors"

_STRONG_TEST_SIGNAL_KEYS = (
    "VITEST",
    "VITEST_WORKER_ID",
    "JEST_WORKER_ID",
    "PYTEST_CURRENT_TEST",
)


def _env_value(key: str) -> str | None:
    """Local copy of the env_value() helper (packet §5 trap #4: extract test_state_root + its deps only)."""
    value = os.environ.get(key)
    return value.strip() if value and value.strip() else None


def _safe_segment(value: str) -> str:
    """Local copy of safe_segment() (dependency of test_state_root; packet §5 trap #4)."""
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value.strip()).strip("_")
    return (cleaned or "unknown")[:80]


def _strong_test_signals() -> list[str]:
    """Local copy of strong_test_signals() (dependency of test_state_root; packet §5 trap #4)."""
    return [key for key in _STRONG_TEST_SIGNAL_KEYS if _env_value(key)]


def test_state_root() -> Path | None:
    """Variant B — per-worker tmp isolation under vitest/jest.

    Ported verbatim from bot-errors-emit.py:69 (byte-identical in health-check
    and runner). Returns None when no test signal is present so the caller
    falls back to DEFAULT_STATE_ROOT. Collapsing this into the plain one-liner
    breaks test isolation (state bleed across workers).
    """
    if not _strong_test_signals():
        return None
    cwd_hash = hashlib.sha256(os.getcwd().encode("utf-8")).hexdigest()[:12]
    worker = _safe_segment(
        _env_value("VITEST_WORKER_ID")
        or _env_value("JEST_WORKER_ID")
        or f"pid-{os.getpid()}"
    )
    return (
        Path(os.environ.get("TMPDIR", "/tmp"))
        / "whatsoup-vitest-bot-errors"
        / f"{cwd_hash}.{worker}"
    )


def state_root(*, resolve_anchor: bool = False) -> Path:
    """Canonical bot-errors state root.

    Variant A when ``resolve_anchor=False`` and no test signal: behavior-identical
    to the collector/dispatcher/maintenance one-liner
    ``Path(os.environ.get("BOT_ERRORS_STATE_DIR", Path.home() / ".local/state/bot-errors"))``.
    Variant B test-isolation is preserved via the ``test_state_root()`` fallback.
    Pass ``resolve_anchor=True`` for variant C (#2723 macOS symlink survival).
    """
    explicit = os.environ.get(ENV_STATE_ROOT)
    if explicit and explicit.strip():
        root = Path(explicit)
    else:
        root = test_state_root() or DEFAULT_STATE_ROOT
    if resolve_anchor:
        anchor = root.absolute()
        try:
            return anchor.parent.resolve(strict=True) / anchor.name
        except (FileNotFoundError, NotADirectoryError):
            # No existing parent to alias-resolve (fresh host / CI runner
            # before first state write). The #2723 anchor intent is resolving
            # OS path aliases like /var -> /private/var, which only applies to
            # paths that exist; non-strict resolution keeps the same answer on
            # such hosts without demanding the directory be pre-created.
            return anchor.parent.resolve() / anchor.name
    return root


def sentinel_state_root() -> Path:
    """Variant D — sentinel component root.

    Honors ``BOT_ERRORS_FLEET_SENTINEL_STATE_DIR`` as the specific override;
    otherwise derives from the resolved ``state_root()`` (which honors the
    global ``BOT_ERRORS_STATE_DIR``) plus ``/fleet-sentinel``. This is the
    #3051 false-green cure: writer (sentinel) and reader (watchdog) both
    resolve through this ONE function, so neither a sentinel-var override nor
    a global state-dir override can desync them. The pre-#3051 writer ignored
    the global var (static home fallback) while the reader honored it — that
    asymmetry, in either direction, is the bug class this function closes.
    """
    explicit = os.environ.get(ENV_SENTINEL_STATE_DIR)
    if explicit and explicit.strip():
        return Path(explicit)
    return state_root() / "fleet-sentinel"


def selfcheck_state_dir() -> Path:
    """Variant E — selfcheck state dir (appends /sentinel to the canonical root).

    Successor to bot-errors-selfcheck.py:114 ``default_state_dir()``; behavior-identical.
    """
    return state_root() / "sentinel"
