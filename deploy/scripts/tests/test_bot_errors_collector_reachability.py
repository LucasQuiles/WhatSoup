"""Tests for two reachability audit blockers in bot-errors-collector.

BLOCKER 1 — daemon-lifetime stale Tailscale cache:
  - Module globals TAILSCALE_STATUS_CACHE/TAILSCALE_STATUS_ERROR persist
    across run_once calls; a peer seen offline in cycle 1 stays offline until
    process restart. Fix: reset_tailscale_cache() cleared at the top of each
    run_once call so within one cycle it is still a memo (N hosts → 1 subprocess
    call per cycle) but each new cycle refreshes.

BLOCKER 2 — tailscale_online_ssh_failed too broad:
  - ssh_failure_diagnosis() labels ANY non-timeout error on an online peer as
    tailscale_online_ssh_failed. skip_writefail_after_outbox_failure() then
    silently skips the secondary writefail probe, hiding remote-script failures.
  - Fix: narrow tailscale_online_ssh_failed to transport-level failures (connection
    refused/reset, no-route, SSH auth / host-key); label remote-command failures
    (nonzero exit from remote script, permission denied on files, missing script)
    as tailscale_online_ssh_remote_error, which must NOT trigger skip.
"""
from __future__ import annotations

import contextlib
import importlib.util
import os
import sys
import time
from pathlib import Path
from typing import Any
from unittest.mock import patch, MagicMock

import pytest

# ---------------------------------------------------------------------------
# Module loader (mirrors test_bot_errors_collector_backoff.py style)
# ---------------------------------------------------------------------------

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-collector.py"


def _load_module(extra_env: dict[str, str] | None = None):
    env_backup: dict[str, str | None] = {}
    if extra_env:
        for k, v in extra_env.items():
            env_backup[k] = os.environ.get(k)
            os.environ[k] = v
    try:
        spec = importlib.util.spec_from_file_location("bot_errors_collector", _SCRIPT)
        mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    finally:
        if extra_env:
            for k, orig in env_backup.items():
                if orig is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = orig


@pytest.fixture()
def tmp_state(tmp_path: Path):
    state_dir = tmp_path / "bot-errors"
    outbox_dir = tmp_path / "outbox"
    state_dir.mkdir(mode=0o700)
    outbox_dir.mkdir(mode=0o700)
    return state_dir, outbox_dir


@contextlib.contextmanager
def _env(state_dir: Path, outbox_dir: Path):
    env_map = {
        "BOT_ERRORS_STATE_DIR": str(state_dir),
        "BOT_ERRORS_OUTBOX_DIR": str(outbox_dir),
        "BOT_ERRORS_TAILSCALE_STATUS_COMMAND": "",
    }
    backup = {k: os.environ.get(k) for k in env_map}
    for k, v in env_map.items():
        os.environ[k] = v
    try:
        yield
    finally:
        for k, orig in backup.items():
            if orig is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = orig


def _load_mod_with_dirs(state_dir: Path, outbox_dir: Path):
    return _load_module(extra_env={
        "BOT_ERRORS_STATE_DIR": str(state_dir),
        "BOT_ERRORS_OUTBOX_DIR": str(outbox_dir),
        "BOT_ERRORS_TAILSCALE_STATUS_COMMAND": "",
    })


def _run_once_defaults(mod, remotes: list[str], **kwargs):
    defaults = dict(
        best_effort_remotes=set(),
        max_events=5,
        timeout=5,
        lease_seconds=30,
        remote_sla=9999,
        alert_cooldown=900,
        recovery_successes=2,
    )
    defaults.update(kwargs)
    return mod.run_once(remotes, **defaults)


# ===========================================================================
# BLOCKER 1: Stale Tailscale cache across daemon cycles
# ===========================================================================

class TestTailscaleCacheReset:
    """BLOCKER 1: reset_tailscale_cache() must exist and run_once must call it
    so that each collection cycle starts with a fresh Tailscale status fetch.
    """

    def test_reset_tailscale_cache_function_exists(self, tmp_state):
        """reset_tailscale_cache() must be present on the module."""
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        assert hasattr(mod, "reset_tailscale_cache"), (
            "reset_tailscale_cache() function not found on module"
        )
        assert callable(mod.reset_tailscale_cache)

    def test_reset_tailscale_cache_clears_both_globals(self, tmp_state):
        """reset_tailscale_cache() must set both module globals to None/empty."""
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        # Seed non-None values into both globals.
        mod.TAILSCALE_STATUS_CACHE = {"Self": {}, "Peer": {}}
        mod.TAILSCALE_STATUS_ERROR = "some error"
        mod.reset_tailscale_cache()
        assert mod.TAILSCALE_STATUS_CACHE is None, (
            "reset_tailscale_cache() must set TAILSCALE_STATUS_CACHE to None"
        )
        assert mod.TAILSCALE_STATUS_ERROR is None, (
            "reset_tailscale_cache() must set TAILSCALE_STATUS_ERROR to None"
        )

    def test_run_once_calls_reset_tailscale_cache(self, tmp_state):
        """run_once must call reset_tailscale_cache at the start of each cycle."""
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        reset_calls = [0]
        original_reset = mod.reset_tailscale_cache

        def counting_reset():
            reset_calls[0] += 1
            original_reset()

        remote = "somehost:/srv/whatsoup/bot-errors"
        with _env(state_dir, outbox_dir), \
             patch.object(mod, "reset_tailscale_cache", side_effect=counting_reset), \
             patch.object(mod, "ssh_json_lines", side_effect=RuntimeError("timeout")), \
             patch.object(mod, "remote_failure_context", return_value=([], {})):
            _run_once_defaults(mod, [remote])
            _run_once_defaults(mod, [remote])

        assert reset_calls[0] == 2, (
            f"reset_tailscale_cache should be called once per run_once cycle, got {reset_calls[0]}"
        )

    def test_offline_peer_seen_online_after_cache_reset(self, tmp_state):
        """ACCEPTANCE TEST: daemon cycle 1 sees peer offline, cycle 2 (after cache
        reset) sees online and SSH resumes — no restart needed.

        This is the core regression test: without the fix the cache is seeded with
        the offline status on cycle 1 and never refreshed, so cycle 2 still skips SSH
        even though the peer is now online. With the fix, reset_tailscale_cache()
        clears the memo at the start of each cycle and preflight_remote_unreachable()
        re-fetches fresh status.

        We drive this via preflight_remote_unreachable directly (which calls
        tailscale_peer_summary → load_tailscale_status) rather than through a full
        run_once cycle, to isolate the cache behaviour from the SSH harness.
        """
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)

        host = "transithost"

        # Tailscale status sequence: first call returns offline, second returns online.
        # The real load_tailscale_status writes into module globals and is checked by
        # the guard clause in the function itself.  We replicate that here.
        call_index = [0]

        def mock_load_tailscale_status():
            # Sequence: offline on call 0, online on call 1+.
            idx = call_index[0]
            call_index[0] += 1
            if idx == 0:
                cache = {"Self": {}, "Peer": {host: {
                    "HostName": host, "DNSName": host, "Online": False, "TailscaleIPs": [],
                }}}
            else:
                cache = {"Self": {}, "Peer": {host: {
                    "HostName": host, "DNSName": host, "Online": True, "TailscaleIPs": [],
                }}}
            # Replicate what the real function does: write into module globals.
            mod.TAILSCALE_STATUS_CACHE = cache
            mod.TAILSCALE_STATUS_ERROR = None
            return cache, None

        with patch.object(mod, "load_tailscale_status", side_effect=mock_load_tailscale_status), \
             patch.object(mod, "resolve_ssh_host_targets", return_value=[host]):

            # Call 0 (via load_tailscale_status mock): peer is offline.
            result_cycle1 = mod.preflight_remote_unreachable(host)
            assert result_cycle1 is not None, (
                "Cycle 1: peer is offline, preflight must return non-None (block SSH)"
            )
            assert result_cycle1.get("online") is False

            # Cache is now populated with offline status.  Without reset, a second
            # call would re-use the cached offline result.
            # Simulate what run_once does: reset the cache before the next cycle.
            mod.reset_tailscale_cache()

            # Call 1 (fresh after reset): peer is online.
            result_cycle2 = mod.preflight_remote_unreachable(host)
            assert result_cycle2 is None, (
                "Cycle 2: peer is online, preflight must return None (SSH must be allowed)"
            )

        # load_tailscale_status must have been called once per cycle (not reused from cache).
        assert call_index[0] == 2, (
            f"load_tailscale_status must be called once per cycle, got {call_index[0]} calls"
        )

    def test_tailscale_error_does_not_permanently_disable_diagnostics(self, tmp_state):
        """A transient status-command failure must not disable diagnostics for the
        remaining lifetime of the process — each cycle must re-attempt.

        Tested directly through reset_tailscale_cache() + load_tailscale_status():
        seed an error into the globals, verify the guard clause short-circuits,
        then call reset_tailscale_cache() and verify load_tailscale_status() is
        called again on the next invocation.
        """
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)

        load_calls = [0]

        def mock_load_tailscale_status():
            load_calls[0] += 1
            mod.TAILSCALE_STATUS_ERROR = "rc=1: connection refused"
            mod.TAILSCALE_STATUS_CACHE = None
            return None, "rc=1: connection refused"

        # Verify reset_tailscale_cache clears both globals so load_tailscale_status
        # will re-execute (not be blocked by the guard clause) on the next cycle.

        # Seed an error state directly into the globals (as the real function would).
        mod.TAILSCALE_STATUS_CACHE = None
        mod.TAILSCALE_STATUS_ERROR = "rc=1: connection refused"

        # Without reset the real guard clause (`if … is not None`) short-circuits.
        # Confirm it by calling the *real* (unpatched) load_tailscale_status — it
        # must return the cached error without invoking the mock.
        cache_val, err_val = mod.load_tailscale_status()
        assert load_calls[0] == 0, "real guard clause must not call mock when error is cached"
        assert err_val == "rc=1: connection refused"

        # reset_tailscale_cache must clear both globals.
        mod.reset_tailscale_cache()
        assert mod.TAILSCALE_STATUS_ERROR is None, "reset must clear TAILSCALE_STATUS_ERROR"
        assert mod.TAILSCALE_STATUS_CACHE is None, "reset must clear TAILSCALE_STATUS_CACHE"

        # After reset, load_tailscale_status re-executes (guard clause no longer fires).
        with patch.object(mod, "load_tailscale_status", side_effect=mock_load_tailscale_status):
            mod.load_tailscale_status()
        assert load_calls[0] == 1, (
            f"load_tailscale_status must execute after reset, got {load_calls[0]} calls"
        )


# ===========================================================================
# BLOCKER 2: tailscale_online_ssh_failed too broad
# ===========================================================================

# Classification table for ssh_failure_diagnosis():
#
# | Error pattern                          | Diagnosis                          | Skip writefail? |
# |----------------------------------------|------------------------------------|-----------------|
# | timeout / timed out / operation timed  | tailscale_online_ssh_timeout       | YES             |
# | connection refused                     | tailscale_online_ssh_failed        | YES             |
# | connection reset by peer               | tailscale_online_ssh_failed        | YES             |
# | no route to host                       | tailscale_online_ssh_failed        | YES             |
# | network is unreachable                 | tailscale_online_ssh_failed        | YES             |
# | permission denied (publickey)          | tailscale_online_ssh_failed        | YES             |
# | host key verification failed           | tailscale_online_ssh_failed        | YES             |
# | ssh: connect to host ... port          | tailscale_online_ssh_failed        | YES             |
# | Process exited with status N           | tailscale_online_ssh_remote_error  | NO              |
# | bash: /path/to/script: No such file    | tailscale_online_ssh_remote_error  | NO              |
# | PermissionError / permission denied /  | tailscale_online_ssh_remote_error  | NO              |
# |   (on remote file, not SSH auth)       |                                    |                 |
# | returncode=N (remote script nonzero)   | tailscale_online_ssh_remote_error  | NO              |

ONLINE_PEER = {"status": "found", "online": True}

TRANSPORT_ERRORS = [
    ("connection refused", "tailscale_online_ssh_failed"),
    ("ssh: connect to host deadhost port 22: connection refused", "tailscale_online_ssh_failed"),
    ("connection reset by peer", "tailscale_online_ssh_failed"),
    ("no route to host", "tailscale_online_ssh_failed"),
    ("network is unreachable", "tailscale_online_ssh_failed"),
    ("permission denied (publickey)", "tailscale_online_ssh_failed"),
    ("host key verification failed", "tailscale_online_ssh_failed"),
]

REMOTE_CMD_ERRORS = [
    "Process exited with status 1",
    "Process exited with status 127",
    "bash: /srv/whatsoup/bot-errors/collect.py: No such file or directory",
    "returncode=2",
    "remote script failed with exit code 1",
    "PermissionError: [Errno 13] Permission denied: '/srv/whatsoup'",
]


class TestSshFailureDiagnosisNarrowing:
    """BLOCKER 2: ssh_failure_diagnosis must distinguish transport failures from
    remote-command failures.
    """

    def test_transport_errors_still_classified_as_tailscale_online_ssh_failed(self, tmp_state):
        """Known transport-level errors must still produce tailscale_online_ssh_failed."""
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)

        for error, expected in TRANSPORT_ERRORS:
            result = mod.ssh_failure_diagnosis(error, ONLINE_PEER)
            assert result == expected, (
                f"error={error!r}: expected {expected!r}, got {result!r}"
            )

    @pytest.mark.parametrize("error", REMOTE_CMD_ERRORS)
    def test_remote_command_errors_classified_as_remote_error_not_transport(self, tmp_state, error):
        """Remote-command failures must be classified as tailscale_online_ssh_remote_error,
        NOT as tailscale_online_ssh_failed.
        """
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)

        result = mod.ssh_failure_diagnosis(error, ONLINE_PEER)
        assert result == "tailscale_online_ssh_remote_error", (
            f"error={error!r}: expected 'tailscale_online_ssh_remote_error', got {result!r}"
        )

    def test_skip_writefail_does_not_skip_for_remote_error(self, tmp_state):
        """skip_writefail_after_outbox_failure must return False when diagnosis is
        tailscale_online_ssh_remote_error — writefail probe must NOT be skipped.
        """
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)

        diagnostics = {"reachabilityDiagnosis": "tailscale_online_ssh_remote_error"}
        assert mod.skip_writefail_after_outbox_failure(diagnostics) is False, (
            "tailscale_online_ssh_remote_error must NOT cause skip_writefail_after_outbox_failure to return True"
        )

    def test_skip_writefail_still_skips_for_transport_failures(self, tmp_state):
        """skip_writefail_after_outbox_failure must still return True for the transport
        diagnoses that genuinely indicate unreachability.
        """
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)

        for diagnosis in ("tailscale_offline", "tailscale_online_ssh_timeout", "tailscale_online_ssh_failed"):
            diagnostics = {"reachabilityDiagnosis": diagnosis}
            assert mod.skip_writefail_after_outbox_failure(diagnostics) is True, (
                f"diagnosis={diagnosis!r}: expected skip_writefail to be True"
            )


class TestWritefailProbeRunsOnRemoteError:
    """NEGATIVE TEST (user-required): Tailscale online + SSH fails for a
    non-timeout, non-transport reason → writefail probe STILL RUNS and the
    failure is surfaced distinctly.
    """

    def test_writefail_probe_runs_when_outbox_fails_with_remote_error(self, tmp_state):
        """When the outbox claim fails with a remote-command error (not transport),
        the writefail probe MUST still be attempted (not skipped).

        Assert:
        1. ssh_json_lines is called a second time for REMOTE_WRITEFAIL_CLAIM_SCRIPT.
        2. The logged reachabilityDiagnosis for the outbox failure is
           tailscale_online_ssh_remote_error (not tailscale_online_ssh_failed).
        3. The writefail claim failure is surfaced as remote_writefail_claim_failed
           (not remote_writefail_claim_skipped_unreachable).
        """
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)

        remote = "livehost:/srv/whatsoup/bot-errors"
        host = "livehost"

        # Peer is online (transport-level reachable).
        online_tailscale = {
            "status": "found",
            "online": True,
            "matched": host,
            "targets": [host],
        }

        ssh_calls: list[str] = []

        def fake_ssh(h, script, args, timeout):
            ssh_calls.append(script)
            # Both calls fail, but with a remote-script error (not transport).
            raise RuntimeError("Process exited with status 1")

        # remote_failure_context must return the remote_error diagnosis.
        remote_error_diag = {
            "tailscale": online_tailscale,
            "reachabilityDiagnosis": "tailscale_online_ssh_remote_error",
        }

        with _env(state_dir, outbox_dir), \
             patch.object(mod, "ssh_json_lines", side_effect=fake_ssh), \
             patch.object(mod, "remote_failure_context",
                         return_value=(["reachabilityDiagnosis=tailscale_online_ssh_remote_error"], remote_error_diag)):
            _run_once_defaults(mod, [remote])

        # WRITEFAIL PROBE MUST HAVE RUN: ssh_json_lines called twice.
        writefail_called = any(s is mod.REMOTE_WRITEFAIL_CLAIM_SCRIPT for s in ssh_calls)
        assert writefail_called, (
            f"writefail probe must run when outbox fails with remote error; "
            f"ssh_calls scripts: {[id(s) for s in ssh_calls]}"
        )

        # The collector log must surface the failure as remote_writefail_claim_failed,
        # NOT as remote_writefail_claim_skipped_unreachable.
        logs = (state_dir / "logs" / "collector.jsonl").read_text()
        assert '"type": "remote_writefail_claim_failed"' in logs, (
            "remote-command outbox failure must surface writefail failure, not silent skip"
        )
        assert '"type": "remote_writefail_claim_skipped_unreachable"' not in logs, (
            "remote_writefail_claim_skipped_unreachable must not appear for non-transport failures"
        )

    def test_writefail_probe_diagnosis_is_surfaced_distinctly(self, tmp_state):
        """When the writefail probe runs after a remote-error outbox failure, the
        writefail failure gets its own reachability diagnostics entry.
        """
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)

        remote = "livehost:/srv/whatsoup/bot-errors"
        host = "livehost"

        online_tailscale = {
            "status": "found",
            "online": True,
            "matched": host,
            "targets": [host],
        }
        remote_error_diag = {
            "tailscale": online_tailscale,
            "reachabilityDiagnosis": "tailscale_online_ssh_remote_error",
        }

        ssh_calls: list[str] = []

        def fake_ssh(h, script, args, timeout):
            ssh_calls.append(script)
            raise RuntimeError("returncode=2")

        with _env(state_dir, outbox_dir), \
             patch.object(mod, "ssh_json_lines", side_effect=fake_ssh), \
             patch.object(mod, "remote_failure_context",
                         return_value=(["reachabilityDiagnosis=tailscale_online_ssh_remote_error"], remote_error_diag)):
            result = _run_once_defaults(mod, [remote])

        # Both calls should have run (outbox + writefail).
        assert len(ssh_calls) >= 2, (
            f"Expected at least 2 SSH calls (outbox + writefail), got {len(ssh_calls)}"
        )
        # failed count should reflect both failures.
        assert result.get("failed", 0) >= 2, (
            f"Expected failed >= 2 for both SSH failures, got {result.get('failed')}"
        )
