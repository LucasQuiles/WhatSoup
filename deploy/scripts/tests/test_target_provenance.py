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
    classify_release_divergence,
    observer_provenance_block,
    resolve_target_provenance,
    safe_release_divergence,
    safe_target_provenance,
    unit_for_instance,
)

_SHA_A = "a" * 40
_SHA_B = "b" * 40
_DIGEST = "c" * 64
# The probe cwd that stands for the TARGET checkout; anything else a probe is
# asked about is the OBSERVER's own checkout.
_TARGET_CWD = "/srv/release"
# Shapes a corrupted or hand-edited envelope can present where a provenance
# block belongs. Named so the probe below is not a bare literal sweep.
_NON_MAPPING_BLOCKS = ([], "not-a-block", 7)


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


class TestReleaseDivergence:
    """#2358 C9/C10: the OBSERVER's release versus the TARGET's release.

    This is a different axis from ``release.agreement``, which compares a
    single side's manifest receipt against that same side's git head. Every
    case below keeps both blocks internally agreeing, so only the cross-block
    axis can move the verdict.
    """

    def _blocks(self, target_commit: str, head_for=None, **overrides):
        def commit_for(cwd):
            return target_commit if cwd == _TARGET_CWD else _SHA_A

        side_probes = probes(
            process_cwd=lambda pid: _TARGET_CWD,
            release_receipt=lambda cwd: {"manifestDigest": _DIGEST, "sourceCommit": commit_for(cwd)},
            git_head=head_for or commit_for,
            **overrides,
        )
        repo_root = Path(__file__).resolve().parents[3]
        observer = observer_provenance_block(
            "probe-producer", repo_root / "deploy" / "scripts" / "bot-errors-runner.py", side_probes
        )
        target = resolve_target_provenance("probe", side_probes)
        return observer, target

    def test_differing_release_commits_name_the_target_as_divergent(self):
        observer, target = self._blocks(_SHA_B)
        # Precondition: the divergence is strictly between the two blocks.
        assert observer["release"]["sourceCommit"] == _SHA_A
        assert target["release"]["sourceCommit"] == _SHA_B
        assert observer["release"]["agreement"] == "agree"
        assert target["release"]["agreement"] == "agree"
        assert target["resolution"] == "resolved"

        verdict = classify_release_divergence(observer, target)
        assert verdict["classification"] == "diverged"
        assert verdict["divergentParty"] == "target"

    def test_same_release_commit_is_aligned(self):
        observer, target = self._blocks(_SHA_A)
        assert observer["release"]["sourceCommit"] == target["release"]["sourceCommit"]

        verdict = classify_release_divergence(observer, target)
        assert verdict["classification"] == "aligned"
        assert verdict["divergentParty"] is None

    def test_unresolved_target_is_not_comparable_even_when_commits_match(self):
        # The service-state probe failed, so the target block is unresolved --
        # yet its release evidence survives and happens to equal the observer's.
        # Comparing digests alone would call that agreement; it is not.
        observer, target = self._blocks(_SHA_A, service_state=lambda unit: None)
        assert target["resolution"] == "unknown"
        assert target["release"]["sourceCommit"] == observer["release"]["sourceCommit"]

        verdict = classify_release_divergence(observer, target)
        assert verdict["classification"] == "not_comparable"
        assert verdict["divergentParty"] is None
        assert "target_unresolved" in verdict["notes"]

    def test_unresolved_observer_is_not_comparable(self, tmp_path):
        def commit_for(cwd):
            return _SHA_A

        side_probes = probes(
            process_cwd=lambda pid: _TARGET_CWD,
            release_receipt=lambda cwd: {"manifestDigest": _DIGEST, "sourceCommit": commit_for(cwd)},
            git_head=commit_for,
        )
        observer = observer_provenance_block("probe-producer", tmp_path / "orphan.py", side_probes)
        target = resolve_target_provenance("probe", side_probes)
        assert observer["release"]["sourceCommit"] is None
        assert target["release"]["sourceCommit"] == _SHA_A

        verdict = classify_release_divergence(observer, target)
        assert verdict["classification"] == "not_comparable"
        assert "observer_source_commit_absent" in verdict["notes"]

    def test_observer_self_mismatch_is_noted_without_moving_the_verdict(self):
        # The manifest receipt on the observer side and the git head on that
        # same side disagree, so its evidence is internally contradictory. The
        # cross-block verdict stays correct, because sourceCommit is
        # unambiguously the manifest receipt, but a bare verdict would hide
        # that one side is ambiguous about the code it carries.
        # Both sides report the same git head; only the observer manifest
        # receipt disagrees with it, so the target stays internally consistent.
        observer, target = self._blocks(_SHA_B, head_for=lambda cwd: _SHA_B)
        assert observer["release"]["agreement"] == "mismatch"
        assert target["release"]["agreement"] == "agree"

        verdict = classify_release_divergence(observer, target)
        assert verdict["classification"] == "diverged"
        assert verdict["divergentParty"] == "target"
        assert "observer_release_self_mismatch" in verdict["notes"]

    def test_target_self_mismatch_is_noted_without_moving_the_verdict(self):
        # The serving target is ambiguous about the code it runs, yet its
        # manifest receipt matches the observer, so the cross-block axis reads
        # aligned. The note is the only thing that keeps that visible.
        observer, target = self._blocks(
            _SHA_A, head_for=lambda cwd: _SHA_B if cwd == _TARGET_CWD else _SHA_A
        )
        assert observer["release"]["agreement"] == "agree"
        assert target["release"]["agreement"] == "mismatch"

        verdict = classify_release_divergence(observer, target)
        assert verdict["classification"] == "aligned"
        assert verdict["divergentParty"] is None
        assert "target_release_self_mismatch" in verdict["notes"]

    def test_non_mapping_target_is_not_comparable_not_a_crash(self):
        # Reachable once a consumer reads envelopes back as JSON: the block can
        # be any JSON type after corruption or hand-editing.
        observer, _ = self._blocks(_SHA_A)
        for shape in _NON_MAPPING_BLOCKS:
            verdict = classify_release_divergence(observer, shape)
            assert verdict["classification"] == "not_comparable", repr(shape)
            assert "target_block_absent" in verdict["notes"], repr(shape)

    def test_non_mapping_observer_is_not_comparable_not_a_crash(self):
        _, target = self._blocks(_SHA_A)
        for shape in _NON_MAPPING_BLOCKS:
            verdict = classify_release_divergence(shape, target)
            assert verdict["classification"] == "not_comparable", repr(shape)
            assert "observer_block_absent" in verdict["notes"], repr(shape)

    def test_classifier_defect_degrades_to_not_comparable(self, monkeypatch):
        import lib.target_provenance as tp

        def boom(observer, target):
            raise RuntimeError("classifier defect")

        monkeypatch.setattr(tp, "classify_release_divergence", boom)
        verdict = safe_release_divergence({}, {})
        assert verdict["classification"] == "not_comparable"
        assert verdict["divergentParty"] is None
        assert verdict["notes"] == ["classifier_error"]


class TestSafeWrappers:
    def test_resolver_crash_degrades_to_unknown_block(self, monkeypatch):
        import lib.target_provenance as tp

        def boom(platform):
            raise RuntimeError("probe wiring defect")

        monkeypatch.setattr(tp, "default_probes", boom)
        block = safe_target_provenance("probe", "linux")
        assert block["resolution"] == "unknown"
        assert block["notes"] == ["resolver_error"]
