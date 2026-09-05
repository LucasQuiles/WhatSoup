"""#2358: target-service provenance, separated from observer/producer provenance.

Bot-errors envelopes historically carried a single generic ``process`` block
describing the PRODUCER — so when the producer ran from a different checkout
than the service it inspected, the envelope's PID/cwd/release evidence pointed
at the wrong process. This module builds two explicit, content-free blocks:

- ``observer_provenance_block``: who observed this (producer identity and the
  producer's own release digests);
- ``resolve_target_provenance``: which serving process/release the finding
  describes, resolved from the detector's authoritative instance identity —
  never from the producer's cwd.

Design rules (issue #2358):
- Pure logic: every process/service/file probe is injected via
  :class:`TargetProbes`, so outcomes are deterministic and unit-testable.
- Fail closed: any unresolvable input yields ``unknown`` — producer values are
  NEVER copied into target fields.
- Content-free: blocks contain only bounded enums, hex digests, epoch ints,
  and note tags. No PID, path, argv, account, or raw manifest ever appears.
Rollout is shadow-mode (#2358 §Rollout): existing envelope fields are
untouched; these blocks are additive and nothing renders them publicly yet.
"""
from __future__ import annotations

import json
import os
import subprocess
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .sentinel_pin import compute_manifest_digest

TARGET_PROVENANCE_SCHEMA_VERSION = 1
RUNTIME_MANIFEST_RELPATH = "deploy/bot-errors-runtime-manifest.json"

_STATE_RUNNING = "running"
_STATE_NOT_RUNNING = "not_running"
_STATE_UNKNOWN = "unknown"

_RUNNING_RAW = {"running", "active", "active_process_fallback"}
_NOT_RUNNING_RAW = {"inactive", "failed", "not-loaded", "deactivating", "dead"}

_HEX = set("0123456789abcdef")

# Cross-block release verdicts (issue #2358 C9/C10). Deliberately distinct from
# the within-block ``release.agreement`` vocabulary: ``agree``/``mismatch``
# compare ONE side's manifest receipt against that same side's git head, while
# these compare the observer's release against the target's. Sharing words
# across the two axes is what let a within-target mismatch read as coverage of
# the observer-versus-target defect this issue was filed for.
RELEASE_DIVERGENCE_ALIGNED = "aligned"
RELEASE_DIVERGENCE_DIVERGED = "diverged"
RELEASE_DIVERGENCE_NOT_COMPARABLE = "not_comparable"

# Versioned apart from the provenance blocks: the verdict is a different shape
# and the two can evolve independently.
RELEASE_DIVERGENCE_SCHEMA_VERSION = 1

# Every note the verdict can carry. Named so a consumer matches a symbol
# rather than a spelling, and so the closed set is readable in one place.
NOTE_OBSERVER_BLOCK_ABSENT = "observer_block_absent"
NOTE_OBSERVER_SOURCE_COMMIT_ABSENT = "observer_source_commit_absent"
NOTE_OBSERVER_RELEASE_SELF_MISMATCH = "observer_release_self_mismatch"
NOTE_TARGET_BLOCK_ABSENT = "target_block_absent"
NOTE_TARGET_UNRESOLVED = "target_unresolved"
NOTE_TARGET_SOURCE_COMMIT_ABSENT = "target_source_commit_absent"
NOTE_TARGET_RELEASE_SELF_MISMATCH = "target_release_self_mismatch"
NOTE_CLASSIFIER_ERROR = "classifier_error"


def _is_hex_digest(value: Any) -> bool:
    return isinstance(value, str) and len(value) in (40, 64) and all(c in _HEX for c in value)


def unit_for_instance(instance: str, platform: str) -> str | None:
    """Map a detector-authoritative instance name to its service unit.

    Only plain WhatSoup instance names map; anything empty, path-like, or
    already unit-shaped is refused (fail closed) rather than guessed.
    """
    name = (instance or "").strip()
    if not name or any(ch in name for ch in "/\\ \t\n@."):
        return None
    if platform == "darwin":
        return f"com.whatsoup.{name}"
    return f"whatsoup@{name}.service"


@dataclass(frozen=True)
class TargetProbes:
    """Injected probe surface. Every callable returns None on probe failure —
    a failed probe is evidence-absent, never evidence-zero."""

    platform: str
    service_state: Callable[[str], str | None]
    service_pids: Callable[[str], list[int] | None]
    process_started_epoch: Callable[[int], int | None]
    process_cwd: Callable[[int], str | None]
    release_receipt: Callable[[str], Mapping[str, Any] | None]
    git_head: Callable[[str], str | None]
    now_iso: Callable[[], str]


def _release_block(
    cwd: str | None,
    probes: TargetProbes,
    notes: list[str],
) -> dict[str, Any]:
    manifest_digest: str | None = None
    source_commit: str | None = None
    git_head: str | None = None
    if cwd is not None:
        receipt = probes.release_receipt(cwd)
        if receipt is None:
            notes.append("release_manifest_missing")
        else:
            candidate_digest = receipt.get("manifestDigest")
            candidate_commit = receipt.get("sourceCommit")
            if candidate_digest is not None and not _is_hex_digest(candidate_digest):
                notes.append("invalid_manifest_digest")
            else:
                manifest_digest = candidate_digest
            if candidate_commit is not None and not _is_hex_digest(candidate_commit):
                notes.append("invalid_source_commit")
            else:
                source_commit = candidate_commit
        head = probes.git_head(cwd)
        if head is not None and not _is_hex_digest(head):
            notes.append("invalid_git_head")
        else:
            git_head = head
    if source_commit is not None and git_head is not None:
        agreement = "agree" if source_commit == git_head else "mismatch"
    elif source_commit is not None or git_head is not None:
        agreement = "single_source"
    else:
        agreement = "unknown"
    return {
        "manifestDigest": manifest_digest,
        "sourceCommit": source_commit,
        "gitHead": git_head,
        "agreement": agreement,
    }


def resolve_target_provenance(instance: str, probes: TargetProbes) -> dict[str, Any]:
    """Resolve the TARGET service's provenance from its instance identity.

    Deterministic outcomes (issue #2358 acceptance criteria):
    - unmapped instance -> resolution=unknown, everything else withheld;
    - manager says running + one process -> resolved, generation + release set;
    - manager says stopped -> resolved not_running, process fields withheld;
    - zero processes for a running service, or multiple matching processes ->
      process-derived fields withheld with an explicit note (fail closed);
    - missing/invalid manifest or git evidence stays visible as unknown
      agreement — it is never backfilled from the producer.
    """
    notes: list[str] = []
    block: dict[str, Any] = {
        "schemaVersion": TARGET_PROVENANCE_SCHEMA_VERSION,
        "role": "target",
        "receiptAt": probes.now_iso(),
        "service": {"kind": "unknown", "instance": None},
        "state": _STATE_UNKNOWN,
        "startedAtEpoch": None,
        "provenanceSource": "unknown",
        "release": {
            "manifestDigest": None,
            "sourceCommit": None,
            "gitHead": None,
            "agreement": "unknown",
        },
        "resolution": "unknown",
        "notes": notes,
    }
    unit = unit_for_instance(instance, probes.platform)
    if unit is None:
        notes.append("unmapped_instance")
        return block
    block["service"] = {"kind": "whatsoup_instance", "instance": instance.strip()}

    raw_state = probes.service_state(unit)
    if raw_state is None:
        notes.append("probe_error:service_state")
        state = _STATE_UNKNOWN
    else:
        normalized = raw_state.strip().lower()
        if normalized in _RUNNING_RAW:
            state = _STATE_RUNNING
        elif normalized in _NOT_RUNNING_RAW:
            state = _STATE_NOT_RUNNING
        else:
            notes.append("unrecognized_service_state")
            state = _STATE_UNKNOWN
    block["state"] = state
    if raw_state is not None:
        block["provenanceSource"] = "service_manager"

    if state == _STATE_NOT_RUNNING:
        block["resolution"] = "resolved"
        return block

    pids = probes.service_pids(unit)
    cwd: str | None = None
    if pids is None:
        notes.append("probe_error:service_pids")
    elif len(pids) == 0:
        if state == _STATE_RUNNING:
            notes.append("no_process_for_running_service")
    elif len(pids) > 1:
        # Ambiguity: refuse to attribute a generation or release to any of them.
        notes.append("multiple_processes")
    else:
        pid = pids[0]
        started = probes.process_started_epoch(pid)
        if started is None:
            notes.append("probe_error:process_started_epoch")
        else:
            block["startedAtEpoch"] = int(started)
        cwd = probes.process_cwd(pid)
        if cwd is None:
            notes.append("probe_error:process_cwd")

    block["release"] = _release_block(cwd, probes, notes)
    block["resolution"] = "resolved" if state != _STATE_UNKNOWN else "unknown"
    return block


def observer_provenance_block(
    producer: str,
    script_path: str | os.PathLike[str],
    probes: TargetProbes,
) -> dict[str, Any]:
    """Content-free provenance for the OBSERVER itself, resolved from the
    producer script's own checkout (never from process cwd, which may differ).
    Exact PID/cwd/argv stay in the envelope's existing private ``process``
    block; this block carries only identity and release digests."""
    notes: list[str] = []
    root: str | None = None
    current = Path(script_path).resolve().parent
    for candidate in (current, *current.parents):
        if (candidate / RUNTIME_MANIFEST_RELPATH).is_file():
            root = str(candidate)
            break
    if root is None:
        notes.append("observer_root_unresolved")
    return {
        "schemaVersion": TARGET_PROVENANCE_SCHEMA_VERSION,
        "role": "observer",
        "receiptAt": probes.now_iso(),
        "producer": producer,
        "release": _release_block(root, probes, notes),
        "notes": notes,
    }


def _release_source_commit(block: Mapping[str, Any] | None) -> str | None:
    """The release commit a provenance block actually proved, or None."""
    if not isinstance(block, Mapping):
        return None
    release = block.get("release")
    if not isinstance(release, Mapping):
        return None
    commit = release.get("sourceCommit")
    return commit if _is_hex_digest(commit) else None


def _release_self_mismatch(block: Mapping[str, Any] | None) -> bool:
    """True when one side contradicts itself: its manifest receipt and its own
    git head disagree. A within-block fact, independent of the cross-block
    axis, and never a reason to move the verdict."""
    if not isinstance(block, Mapping):
        return False
    release = block.get("release")
    return isinstance(release, Mapping) and release.get("agreement") == "mismatch"


def classify_release_divergence(
    observer: Mapping[str, Any] | None,
    target: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Classify the OBSERVER's release against the TARGET's release.

    Pure: reads two already-built blocks and returns a new dict. It writes
    nothing and probes nothing. Total over its annotated input type and over
    anything else an envelope read back as JSON can present: a block that is
    absent, or is not a mapping at all, classifies not_comparable rather than
    raising.

    A side whose own manifest receipt and git head disagree adds a note naming
    that side. The verdict itself does not move, because the two axes are
    different questions and merging them is the conflation this module exists
    to prevent -- but a bare verdict over self-contradictory evidence would
    read as more certain than it is.

    The two sides are judged by deliberately different predicates, because the
    blocks are not symmetric. ``resolve_target_provenance`` carries an explicit
    ``resolution``, and an unresolved target can still surface a release commit
    -- a failed service-state probe leaves ``resolution`` unknown while the
    manifest receipt survives. Comparing digests alone would call that
    agreement, so a target is comparable only when it resolved AND proved a
    commit. ``observer_provenance_block`` has no ``resolution`` field at all;
    its failure to resolve shows up as an absent release commit, which is
    therefore the whole observer-side predicate.

    Fail closed (#2358 C7): anything short of two proven commits is
    ``not_comparable`` with a note naming the missing side. It is never
    ``aligned``, because absence of evidence is not evidence of agreement.
    When the commits differ the verdict names the TARGET as the divergent
    party (#2358 C10): the observer reported faithfully about a service that
    was running other code, and attributing the difference to the observer is
    the misattribution this issue was filed for.
    """
    notes: list[str] = []

    observer_commit = _release_source_commit(observer)
    if not isinstance(observer, Mapping):
        notes.append(NOTE_OBSERVER_BLOCK_ABSENT)
    elif observer_commit is None:
        notes.append(NOTE_OBSERVER_SOURCE_COMMIT_ABSENT)
    if _release_self_mismatch(observer):
        notes.append(NOTE_OBSERVER_RELEASE_SELF_MISMATCH)

    target_commit: str | None = None
    if not isinstance(target, Mapping):
        notes.append(NOTE_TARGET_BLOCK_ABSENT)
    elif target.get("resolution") != "resolved":
        notes.append(NOTE_TARGET_UNRESOLVED)
    else:
        target_commit = _release_source_commit(target)
        if target_commit is None:
            notes.append(NOTE_TARGET_SOURCE_COMMIT_ABSENT)
    if _release_self_mismatch(target):
        notes.append(NOTE_TARGET_RELEASE_SELF_MISMATCH)

    if observer_commit is None or target_commit is None:
        classification = RELEASE_DIVERGENCE_NOT_COMPARABLE
        divergent_party = None
    elif observer_commit == target_commit:
        classification = RELEASE_DIVERGENCE_ALIGNED
        divergent_party = None
    else:
        classification = RELEASE_DIVERGENCE_DIVERGED
        divergent_party = "target"

    return {
        "schemaVersion": RELEASE_DIVERGENCE_SCHEMA_VERSION,
        "classification": classification,
        "divergentParty": divergent_party,
        "notes": notes,
    }


# ---------------------------------------------------------------------------
# Production probe adapters. Thin, bounded (3s), catch-all -> None.
# ---------------------------------------------------------------------------

_PROBE_TIMEOUT = 3


def _run(cmd: list[str]) -> str | None:
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=_PROBE_TIMEOUT,
            check=False,
        )
    except Exception:  # noqa: BLE001 - a failed probe is evidence-absent, never fatal.
        return None
    return proc.stdout


def _launchctl_print(unit: str) -> str | None:
    return _run(["launchctl", "print", f"gui/{os.getuid()}/{unit}"])


def _darwin_service_state(unit: str) -> str | None:
    output = _launchctl_print(unit)
    if output is None:
        return None
    for line in output.splitlines():
        stripped = line.strip()
        if stripped.startswith("state = "):
            return stripped.removeprefix("state = ").strip()
    return "inactive"


def _darwin_service_pids(unit: str) -> list[int] | None:
    output = _launchctl_print(unit)
    if output is None:
        return None
    pids: list[int] = []
    for line in output.splitlines():
        stripped = line.strip()
        if stripped.startswith("pid = "):
            try:
                pids.append(int(stripped.removeprefix("pid = ").strip()))
            except ValueError:
                return None
    return pids


def _linux_service_state(unit: str) -> str | None:
    output = _run(["systemctl", "--user", "is-active", unit])
    if output is None:
        return None
    return output.strip() or None


def _linux_service_pids(unit: str) -> list[int] | None:
    output = _run(["systemctl", "--user", "show", "--property=MainPID", unit])
    if output is None:
        return None
    for line in output.splitlines():
        key, _, value = line.partition("=")
        if key == "MainPID":
            try:
                pid = int(value.strip())
            except ValueError:
                return None
            return [pid] if pid > 0 else []
    return None


def _process_started_epoch(pid: int) -> int | None:
    output = _run(["ps", "-o", "etimes=", "-p", str(pid)])
    if output is None:
        return None
    try:
        return int(time.time()) - int(output.strip())
    except ValueError:
        return None


def _process_cwd(pid: int) -> str | None:
    output = _run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"])
    if output is None:
        return None
    for line in output.splitlines():
        if line.startswith("n"):
            return line[1:].strip() or None
    return None


def _release_receipt(cwd: str) -> Mapping[str, Any] | None:
    manifest_path = Path(cwd) / RUNTIME_MANIFEST_RELPATH
    try:
        with open(manifest_path, encoding="utf-8") as handle:
            payload = json.load(handle)
    except Exception:  # noqa: BLE001 - missing/corrupt manifest is evidence-absent.
        return None
    if not isinstance(payload, dict):
        return None
    files = payload.get("files")
    table: dict[str, str] = {}
    if isinstance(files, list):
        for entry in files:
            if isinstance(entry, dict) and isinstance(entry.get("path"), str) and isinstance(entry.get("sha256"), str):
                table[entry["path"]] = entry["sha256"]
    # `expected_head_sha` is stamped at deploy time (sentinel_pin contract);
    # a committed working tree legitimately lacks it.
    source_commit = payload.get("expected_head_sha")
    return {
        "manifestDigest": compute_manifest_digest(table) if table else None,
        "sourceCommit": source_commit if isinstance(source_commit, str) else None,
    }


def _git_head(cwd: str) -> str | None:
    output = _run(["git", "-C", cwd, "rev-parse", "HEAD"])
    if output is None:
        return None
    head = output.strip()
    return head or None


def default_probes(platform: str) -> TargetProbes:
    darwin = platform == "darwin"
    return TargetProbes(
        platform=platform,
        service_state=_darwin_service_state if darwin else _linux_service_state,
        service_pids=_darwin_service_pids if darwin else _linux_service_pids,
        process_started_epoch=_process_started_epoch,
        process_cwd=_process_cwd,
        release_receipt=_release_receipt,
        git_head=_git_head,
        now_iso=lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )


def safe_target_provenance(instance: str, platform: str) -> dict[str, Any]:
    """Never let provenance resolution break alert emission: any resolver
    crash degrades to an explicit unknown block."""
    try:
        return resolve_target_provenance(instance, default_probes(platform))
    except Exception:  # noqa: BLE001 - alert emission must survive resolver defects.
        return {
            "schemaVersion": TARGET_PROVENANCE_SCHEMA_VERSION,
            "role": "target",
            "receiptAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "service": {"kind": "unknown", "instance": None},
            "state": _STATE_UNKNOWN,
            "startedAtEpoch": None,
            "provenanceSource": "unknown",
            "release": {"manifestDigest": None, "sourceCommit": None, "gitHead": None, "agreement": "unknown"},
            "resolution": "unknown",
            "notes": ["resolver_error"],
        }


def safe_release_divergence(
    observer: Mapping[str, Any] | None,
    target: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Same never-break contract for the cross-block verdict.

    The runner builds its failure event OUTSIDE the try that preserves the
    alert, so a raise here would lose the alert entirely rather than degrade
    it. Fails closed to not_comparable, and performs no I/O.
    """
    try:
        return classify_release_divergence(observer, target)
    except Exception:  # noqa: BLE001 - alert emission must survive classifier defects.
        return {
            "schemaVersion": RELEASE_DIVERGENCE_SCHEMA_VERSION,
            "classification": RELEASE_DIVERGENCE_NOT_COMPARABLE,
            "divergentParty": None,
            "notes": [NOTE_CLASSIFIER_ERROR],
        }


def safe_observer_provenance(producer: str, script_path: str | os.PathLike[str], platform: str) -> dict[str, Any]:
    """Same never-break contract for the observer block."""
    try:
        return observer_provenance_block(producer, script_path, default_probes(platform))
    except Exception:  # noqa: BLE001 - alert emission must survive resolver defects.
        return {
            "schemaVersion": TARGET_PROVENANCE_SCHEMA_VERSION,
            "role": "observer",
            "receiptAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "producer": producer,
            "release": {"manifestDigest": None, "sourceCommit": None, "gitHead": None, "agreement": "unknown"},
            "notes": ["resolver_error"],
        }
