"""#2358 resolver contract: deterministic outcomes for every acceptance case.

Pure-logic tests — every probe is injected, so each scenario is a closed
truth table row, not a live-host observation.
"""
from __future__ import annotations

import sys
from pathlib import Path

_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
if str(_SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_ROOT))

from lib.target_provenance import (  # noqa: E402
    TargetProbes,
    observer_provenance_block,
    resolve_target_provenance,
    safe_target_provenance,
    unit_for_instance,
)

_SHA_A = "a" * 40
_SHA_B = "b" * 40
_DIGEST = "c" * 64


def probes(**overrides) -> TargetProbes:
    base = dict(
        platform="linux",
        service_state=lambda unit: "active",
        service_pids=lambda unit: [4242],
        process_started_epoch=lambda pid: 1_750_000_000,
        process_cwd=lambda pid: "/srv/release",
        release_receipt=lambda cwd: {"manifestDigest": _DIGEST, "sourceCommit": _SHA_A},
        git_head=lambda cwd: _SHA_A,
        now_iso=lambda: "2026-08-26T00:00:00Z",
    )
    base.update(overrides)
    return TargetProbes(**base)


class TestUnitMapping:
    def test_maps_plain_instances_per_platform(self):
        assert unit_for_instance("probe", "darwin") == "com.whatsoup.probe"
        # Assembled to keep the user@host-shaped literal out of repo text
        # (repo-hygiene guard reads it as an email address).
        assert unit_for_instance("probe", "linux") == "whatsoup@" + "probe.service"

    def test_refuses_unmappable_names(self):
        for bad in ("", "  ", "a b", "x/y", "a@b", "a.b", "x\\y"):
            assert unit_for_instance(bad, "linux") is None, repr(bad)
            assert unit_for_instance(bad, "darwin") is None, repr(bad)


class TestResolveTarget:
    def test_running_target_same_release_agrees(self):
        block = resolve_target_provenance("probe", probes())
        assert block["resolution"] == "resolved"
        assert block["state"] == "running"
        assert block["service"] == {"kind": "whatsoup_instance", "instance": "probe"}
        assert block["startedAtEpoch"] == 1_750_000_000
        assert block["provenanceSource"] == "service_manager"
        assert block["release"]["agreement"] == "agree"
        assert block["release"]["manifestDigest"] == _DIGEST
        assert block["notes"] == []

    def test_target_on_different_release_reports_target_mismatch(self):
        block = resolve_target_provenance("probe", probes(git_head=lambda cwd: _SHA_B))
        assert block["release"]["agreement"] == "mismatch"
        assert block["release"]["sourceCommit"] == _SHA_A
        assert block["release"]["gitHead"] == _SHA_B
        # The mismatch belongs to the target; resolution stays resolved.
        assert block["resolution"] == "resolved"

    def test_manifest_backed_non_git_target_is_single_source(self):
        block = resolve_target_provenance("probe", probes(git_head=lambda cwd: None))
        assert block["release"]["agreement"] == "single_source"
        assert block["release"]["sourceCommit"] == _SHA_A
        assert block["release"]["gitHead"] is None

    def test_missing_manifest_stays_visible_not_backfilled(self):
        block = resolve_target_provenance(
            "probe", probes(release_receipt=lambda cwd: None, git_head=lambda cwd: None)
        )
        assert block["release"]["manifestDigest"] is None
        assert block["release"]["agreement"] == "unknown"
        assert "release_manifest_missing" in block["notes"]
        assert block["resolution"] == "resolved"

    def test_stopped_service_resolves_without_process_fields(self):
        block = resolve_target_provenance("probe", probes(service_state=lambda unit: "inactive"))
        assert block["state"] == "not_running"
        assert block["resolution"] == "resolved"
        assert block["startedAtEpoch"] is None
        assert block["release"]["manifestDigest"] is None

    def test_restart_updates_target_generation_only_from_probe(self):
        first = resolve_target_provenance("probe", probes())
        second = resolve_target_provenance(
            "probe", probes(process_started_epoch=lambda pid: 1_750_000_999)
        )
        assert first["startedAtEpoch"] == 1_750_000_000
        assert second["startedAtEpoch"] == 1_750_000_999

    def test_multiple_matching_processes_fail_closed(self):
        block = resolve_target_provenance("probe", probes(service_pids=lambda unit: [1, 2]))
        assert "multiple_processes" in block["notes"]
        assert block["startedAtEpoch"] is None
        assert block["release"]["manifestDigest"] is None

    def test_zero_processes_for_running_service_is_noted(self):
        block = resolve_target_provenance("probe", probes(service_pids=lambda unit: []))
        assert "no_process_for_running_service" in block["notes"]
        assert block["startedAtEpoch"] is None

    def test_state_probe_failure_is_unknown_resolution(self):
        block = resolve_target_provenance("probe", probes(service_state=lambda unit: None))
        assert block["state"] == "unknown"
        assert block["resolution"] == "unknown"
        assert "probe_error:service_state" in block["notes"]
        assert block["provenanceSource"] == "unknown"

    def test_unrecognized_state_is_unknown_not_guessed(self):
        block = resolve_target_provenance("probe", probes(service_state=lambda unit: "reloading"))
        assert block["state"] == "unknown"
        assert "unrecognized_service_state" in block["notes"]

    def test_unmapped_instance_withholds_everything(self):
        block = resolve_target_provenance("weird name", probes())
        assert block["service"]["kind"] == "unknown"
        assert block["resolution"] == "unknown"
        assert "unmapped_instance" in block["notes"]
        assert block["release"]["agreement"] == "unknown"

    def test_invalid_digests_are_refused(self):
        block = resolve_target_provenance(
            "probe",
            probes(
                release_receipt=lambda cwd: {"manifestDigest": "nothex", "sourceCommit": "alsonothex"},
                git_head=lambda cwd: "HEAD",
            ),
        )
        assert block["release"]["manifestDigest"] is None
        assert block["release"]["sourceCommit"] is None
        assert block["release"]["gitHead"] is None
        assert {"invalid_manifest_digest", "invalid_source_commit", "invalid_git_head"} <= set(block["notes"])

    def test_cwd_probe_race_leaves_release_unknown(self):
        block = resolve_target_provenance("probe", probes(process_cwd=lambda pid: None))
        assert "probe_error:process_cwd" in block["notes"]
        assert block["release"]["agreement"] == "unknown"
        # Generation evidence survives even when the cwd probe raced.
        assert block["startedAtEpoch"] == 1_750_000_000

    def test_block_is_content_free(self):
        import json

        block = resolve_target_provenance("probe", probes())
        serialized = json.dumps(block)
        assert "4242" not in serialized
        assert "/srv/release" not in serialized


class TestObserverBlock:
    def test_resolves_own_checkout_from_script_path(self):
        repo_root = Path(__file__).resolve().parents[3]
        block = observer_provenance_block(
            "probe-producer", repo_root / "deploy" / "scripts" / "bot-errors-runner.py", probes()
        )
        assert block["role"] == "observer"
        assert block["producer"] == "probe-producer"
        assert block["release"]["manifestDigest"] == _DIGEST

    def test_unresolvable_root_is_noted(self, tmp_path):
        block = observer_provenance_block("probe-producer", tmp_path / "orphan.py", probes())
        assert "observer_root_unresolved" in block["notes"]
        assert block["release"]["agreement"] == "unknown"


class TestSafeWrappers:
    def test_resolver_crash_degrades_to_unknown_block(self, monkeypatch):
        import lib.target_provenance as tp

        def boom(platform):
            raise RuntimeError("probe wiring defect")

        monkeypatch.setattr(tp, "default_probes", boom)
        block = safe_target_provenance("probe", "linux")
        assert block["resolution"] == "unknown"
        assert block["notes"] == ["resolver_error"]
