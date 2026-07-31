"""Tests for #2459 — terminal relay archive retention contract.

The collector's remote acknowledgement path moves successfully relayed BOT
ERRORS artifacts into a terminal forensic archive (relayed/), but the archive
had no retention contract and preserved stale delivery.status='queued' state.

These tests verify:

  - Ack path rewrites delivery status to terminal (collectorDisposition)
    while preserving producer state (producerDeliveryStatus).
  - Census reports privacy-safe aggregates (count/bytes/age/parse health).
  - Retention is dry-run-first, bounded, and fail-closed for nonterminal.
  - Privacy: census and retention outputs contain no payload/identity fields.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-collector.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_collector_2459", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    assert spec and spec.loader
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture(scope="module")
def mod():
    return _load_module()


def _make_terminal_payload(
    *, status: str = "relayed", has_delivery: bool = True
) -> dict:
    """Build a synthetic BOT ERRORS payload."""
    payload = {"id": "synthetic-test-id", "kind": "test", "event": "synthetic"}
    if has_delivery:
        payload["delivery"] = {
            "attempts": 0,
            "status": "queued",
            "nextAttemptAtEpoch": 0,
        }
    if status:
        payload["collectorDisposition"] = {"status": status, "at": int(time.time())}
    return payload


def _write_relayed(archive_dir: Path, name: str, payload: dict | str) -> Path:
    """Write a synthetic relayed artifact."""
    path = archive_dir / name
    if isinstance(payload, str):
        path.write_text(payload, encoding="utf-8")
    else:
        path.write_text(json.dumps(payload), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Ack path rewrite (REMOTE_ACK_SCRIPT)
# ---------------------------------------------------------------------------


class TestAckPathRewrite:
    """The REMOTE_ACK_SCRIPT must rewrite delivery status to terminal on ack."""

    def test_ack_script_contains_collector_disposition_logic(self, mod):
        """Verify the ack script string contains the rewrite logic."""
        assert "collectorDisposition" in mod.REMOTE_ACK_SCRIPT
        assert "producerDeliveryStatus" in mod.REMOTE_ACK_SCRIPT

    def test_ack_script_preserves_producer_state(self, mod):
        """Verify the ack script moves delivery to producerDeliveryStatus."""
        assert "producerDeliveryStatus" in mod.REMOTE_ACK_SCRIPT
        assert 'pop("delivery")' in mod.REMOTE_ACK_SCRIPT

    def test_ack_script_handles_malformed_json(self, mod):
        """Malformed JSON must not crash the ack script."""
        assert "except" in mod.REMOTE_ACK_SCRIPT
        assert "ValueError" in mod.REMOTE_ACK_SCRIPT


# ---------------------------------------------------------------------------
# Census function
# ---------------------------------------------------------------------------


class TestCensusRelayArchive:
    """census_relay_archive returns privacy-safe bounded aggregates."""

    def test_empty_archive_returns_zeros(self, mod, tmp_path):
        result = mod.census_relay_archive(tmp_path / "relayed")
        assert result["count"] == 0
        assert result["total_bytes"] == 0
        assert result["oldest_age_seconds"] is None
        assert result["parse_failures"] == 0
        assert result["nonterminal_count"] == 0

    def test_nonexistent_dir_returns_zeros(self, mod, tmp_path):
        result = mod.census_relay_archive(tmp_path / "nonexistent")
        assert result["count"] == 0

    def test_counts_terminal_artifacts(self, mod, tmp_path):
        archive = tmp_path / "relayed"
        archive.mkdir()
        _write_relayed(archive, "a.json.relayed", _make_terminal_payload())
        _write_relayed(archive, "b.json.relayed", _make_terminal_payload())
        result = mod.census_relay_archive(archive)
        assert result["count"] == 2
        assert result["nonterminal_count"] == 0
        assert result["parse_failures"] == 0

    def test_reports_bytes(self, mod, tmp_path):
        archive = tmp_path / "relayed"
        archive.mkdir()
        payload = _make_terminal_payload()
        _write_relayed(archive, "a.json.relayed", payload)
        result = mod.census_relay_archive(archive)
        expected = len(json.dumps(payload).encode("utf-8"))
        assert result["total_bytes"] == expected

    def test_reports_oldest_age(self, mod, tmp_path):
        archive = tmp_path / "relayed"
        archive.mkdir()
        old = _write_relayed(archive, "old.json.relayed", _make_terminal_payload())
        new = _write_relayed(archive, "new.json.relayed", _make_terminal_payload())
        # Set old file to 1 hour ago
        old_time = time.time() - 3600
        os.utime(old, (old_time, old_time))
        result = mod.census_relay_archive(archive)
        assert result["oldest_age_seconds"] is not None
        assert result["oldest_age_seconds"] >= 3500  # ~1 hour

    def test_counts_parse_failures(self, mod, tmp_path):
        archive = tmp_path / "relayed"
        archive.mkdir()
        _write_relayed(archive, "good.json.relayed", _make_terminal_payload())
        _write_relayed(archive, "bad.json.relayed", "{not valid json")
        result = mod.census_relay_archive(archive)
        assert result["count"] == 2
        assert result["parse_failures"] == 1

    def test_counts_nonterminal_artifacts(self, mod, tmp_path):
        """Artifacts without collectorDisposition are nonterminal."""
        archive = tmp_path / "relayed"
        archive.mkdir()
        _write_relayed(
            archive, "terminal.json.relayed", _make_terminal_payload(status="relayed")
        )
        # Nonterminal: has delivery.status='queued' but no collectorDisposition
        _write_relayed(
            archive,
            "queued.json.relayed",
            {"id": "x", "delivery": {"status": "queued"}},
        )
        result = mod.census_relay_archive(archive)
        assert result["count"] == 2
        assert result["nonterminal_count"] == 1

    def test_no_payload_identity_in_output(self, mod, tmp_path):
        """Census output must not contain payload content or identity."""
        archive = tmp_path / "relayed"
        archive.mkdir()
        _write_relayed(
            archive,
            "secret.json.relayed",
            {
                "id": "secret-host-user@s.whatsapp.net",
                "host": "private-host-123",
                "delivery": {"status": "queued"},
                "body": "private-message-content",
                "collectorDisposition": {"status": "relayed", "at": int(time.time())},
            },
        )
        result = mod.census_relay_archive(archive)
        result_str = json.dumps(result)
        assert "s.whatsapp.net" not in result_str
        assert "private-host" not in result_str
        assert "private-message" not in result_str


# ---------------------------------------------------------------------------
# Retention prune
# ---------------------------------------------------------------------------


class TestRetentionPruneRelayArchive:
    """Retention prune is dry-run-first, bounded, fail-closed."""

    def test_dry_run_does_not_remove(self, mod, tmp_path):
        archive = tmp_path / "relayed"
        archive.mkdir()
        path = _write_relayed(archive, "a.json.relayed", _make_terminal_payload())
        old_time = time.time() - 7200  # 2 hours ago
        os.utime(path, (old_time, old_time))
        result = mod.retention_prune_relay_archive(
            archive_dir=archive, max_age_seconds=3600, dry_run=True
        )
        assert result["dry_run"] is True
        assert result["removed_count"] == 1
        assert path.exists()  # NOT removed (dry-run)

    def test_apply_removes_old_terminal(self, mod, tmp_path):
        archive = tmp_path / "relayed"
        archive.mkdir()
        old = _write_relayed(archive, "old.json.relayed", _make_terminal_payload())
        old_time = time.time() - 7200  # 2 hours ago
        os.utime(old, (old_time, old_time))
        result = mod.retention_prune_relay_archive(
            archive_dir=archive, max_age_seconds=3600, dry_run=False
        )
        assert result["removed_count"] == 1
        assert not old.exists()

    def test_keeps_recent_terminal(self, mod, tmp_path):
        archive = tmp_path / "relayed"
        archive.mkdir()
        recent = _write_relayed(
            archive, "recent.json.relayed", _make_terminal_payload()
        )
        result = mod.retention_prune_relay_archive(
            archive_dir=archive, max_age_seconds=3600, dry_run=False
        )
        assert result["removed_count"] == 0
        assert recent.exists()

    def test_never_removes_nonterminal(self, mod, tmp_path):
        """Nonterminal artifacts must NEVER be removed (fail-closed)."""
        archive = tmp_path / "relayed"
        archive.mkdir()
        # Nonterminal: no collectorDisposition
        queued = _write_relayed(
            archive, "queued.json.relayed", {"delivery": {"status": "queued"}}
        )
        old_time = time.time() - 999999
        os.utime(queued, (old_time, old_time))
        result = mod.retention_prune_relay_archive(
            archive_dir=archive, max_age_seconds=1, dry_run=False
        )
        assert result["removed_count"] == 0
        assert result["skipped_nonterminal_or_malformed"] == 1
        assert queued.exists()

    def test_never_removes_malformed(self, mod, tmp_path):
        """Malformed JSON artifacts must NEVER be removed (fail-closed)."""
        archive = tmp_path / "relayed"
        archive.mkdir()
        bad = _write_relayed(archive, "bad.json.relayed", "{not json")
        result = mod.retention_prune_relay_archive(
            archive_dir=archive, max_age_seconds=0, dry_run=False
        )
        assert result["removed_count"] == 0
        assert result["skipped_nonterminal_or_malformed"] == 1
        assert bad.exists()

    def test_max_count_removes_oldest_excess(self, mod, tmp_path):
        archive = tmp_path / "relayed"
        archive.mkdir()
        for i in range(5):
            path = _write_relayed(
                archive, f"file{i}.json.relayed", _make_terminal_payload()
            )
            mtime = time.time() - (5 - i) * 100  # file0 oldest
            os.utime(path, (mtime, mtime))
        result = mod.retention_prune_relay_archive(
            archive_dir=archive, max_count=3, dry_run=False
        )
        assert result["removed_count"] == 2  # 5 - 3 = 2 removed
        # Oldest two (file0, file1) should be gone
        assert not (archive / "file0.json.relayed").exists()
        assert not (archive / "file1.json.relayed").exists()
        # Newest three remain
        assert (archive / "file2.json.relayed").exists()
        assert (archive / "file4.json.relayed").exists()

    def test_requires_at_least_one_threshold(self, mod, tmp_path):
        with pytest.raises(ValueError, match="at least one"):
            mod.retention_prune_relay_archive(archive_dir=tmp_path, dry_run=True)

    def test_dry_run_apply_parity(self, mod, tmp_path):
        """Dry-run and apply must report the same removed_count for same input."""
        for dry_run in (True, False):
            archive = tmp_path / f"relay_{'dry' if dry_run else 'apply'}"
            archive.mkdir()
            for i in range(3):
                path = _write_relayed(
                    archive, f"f{i}.json.relayed", _make_terminal_payload()
                )
                mtime = time.time() - 7200
                os.utime(path, (mtime, mtime))
            result = mod.retention_prune_relay_archive(
                archive_dir=archive, max_age_seconds=3600, dry_run=dry_run
            )
            assert result["removed_count"] == 3

    def test_no_payload_identity_in_receipt(self, mod, tmp_path):
        """Retention receipt must not contain payload content or identity."""
        archive = tmp_path / "relayed"
        archive.mkdir()
        _write_relayed(
            archive,
            "secret.json.relayed",
            {
                "id": "secret-id@s.whatsapp.net",
                "host": "private-host",
                "body": "private-content",
                "collectorDisposition": {
                    "status": "relayed",
                    "at": int(time.time() - 9999),
                },
            },
        )
        old_time = time.time() - 9999
        os.utime(archive / "secret.json.relayed", (old_time, old_time))
        result = mod.retention_prune_relay_archive(
            archive_dir=archive, max_age_seconds=1, dry_run=True
        )
        result_str = json.dumps(result)
        assert "s.whatsapp.net" not in result_str
        assert "private-host" not in result_str
        assert "private-content" not in result_str

    def test_removed_bytes_reported(self, mod, tmp_path):
        archive = tmp_path / "relayed"
        archive.mkdir()
        payload = _make_terminal_payload()
        path = _write_relayed(archive, "a.json.relayed", payload)
        old_time = time.time() - 7200
        os.utime(path, (old_time, old_time))
        expected = len(json.dumps(payload).encode("utf-8"))
        result = mod.retention_prune_relay_archive(
            archive_dir=archive, max_age_seconds=3600, dry_run=True
        )
        assert result["removed_bytes"] == expected
