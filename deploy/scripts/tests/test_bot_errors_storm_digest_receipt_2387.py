"""#2387: a storm-collapse digest keyed by its own window, with a durable receipt.

At the base commit `storm_digest_event()` computes a window identity --
fingerprint hash plus window start -- uses it as the digest's event id and as
its force-notify level, and then throws it away for the incident identity:
`"instance"` and `"source"` are both the literal `storm-collapse`, so every
digest ever produced keys to `fleet|storm-collapse|storm-collapse`. Two terminal
aggregates in one bounded window (a critical group and a warning group have
different fingerprints, because severity is a fingerprint component) both pass
the force-notify gate on their distinct levels and are then stored under that
one key, where the later one overwrites the earlier one's summary and evidence.
The surviving operator record is order-dependent.

The tests below drive the real collapse path. R1-R5 are RED at the base commit
and fail on assertions, not on imports: nothing here imports a symbol the base
does not define, the receipt directory is named by a literal, and the first
assertion in each case is the one the defect breaks. I1-I2 are INVARIANTS --
they pass at the base commit and must still pass after -- and are labelled as
such so they are not read as evidence of a fix.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import pytest

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from support import dispatcher_fixtures  # noqa: E402

_SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

_DISPATCHER = _SCRIPTS_DIR / "bot-errors-dispatcher.py"
_disp = dispatcher_fixtures.load_module_from_path(
    "bot_errors_dispatcher_storm_receipt_2387", _DISPATCHER
)
_write_event = dispatcher_fixtures.write_outbox_event
_dispatch_records = dispatcher_fixtures.dispatch_log_records

# Named by literal, never by a module symbol: the RED runs must fail on the
# assertions below rather than on a missing attribute.
_RECEIPT_DIR_NAME = "storm-receipts"
_STORM_SOURCE = "storm-collapse"

_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_OUTBOX_DIR",
    "BOT_ERRORS_STORM_THRESHOLD",
    "BOT_ERRORS_STORM_WINDOW_SECONDS",
    "BOT_ERRORS_STORM_RECEIPT_MAX_RECORDS",
]

_clean_env = dispatcher_fixtures.make_env_scrub_fixture(_ENV_KEYS)


@pytest.fixture()
def storm_paths(tmp_path: Path) -> dict[str, Path]:
    """A sandboxed state root with the storm knobs pinned for these scenarios."""
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    os.environ["BOT_ERRORS_STORM_THRESHOLD"] = "2"
    os.environ["BOT_ERRORS_STORM_WINDOW_SECONDS"] = "120"
    return _disp.setup_dirs()


def _member(
    event_id: str,
    machine: str,
    severity: str = "critical",
    summary: str = "storm member",
    base_epoch: int | None = None,
) -> dict[str, Any]:
    """One storm member as a producer would write it."""
    if base_epoch is None:
        base_epoch = int(time.time())
    return {
        "schemaVersion": 1,
        "id": event_id,
        "eventType": "alert",
        "severity": severity,
        "source": "daily-health",
        "machine": machine,
        "instance": "eh-bot",
        "summary": summary,
        "evidence": f"probe {machine}",
        "createdAt": _disp.iso_from_epoch(base_epoch),
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0},
    }


def _collapse(
    paths: dict[str, Path],
    members: list[dict[str, Any]],
    window_start: int,
    incident_state: dict[str, Any],
) -> int:
    """Collapse one group through the real entry point."""
    records = []
    for member in members:
        name = f"{member['id']}.json"
        _write_event(paths, name, member)
        records.append((paths["outbox"] / name, member))
    fingerprint = _disp.storm_fingerprint(members[0])
    return _disp.collapse_storm_group(
        paths, (fingerprint, window_start), records, incident_state
    )


def _digests(paths: dict[str, Path]) -> list[dict[str, Any]]:
    """Every queued storm digest, oldest filename first."""
    found = []
    for path in sorted(paths["outbox"].glob("*.json")):
        if _STORM_SOURCE not in path.name:
            continue
        found.append(json.loads(path.read_text(encoding="utf-8")))
    return found


def _digest_paths(paths: dict[str, Path]) -> list[Path]:
    return [p for p in sorted(paths["outbox"].glob("*.json")) if _STORM_SOURCE in p.name]


def _receipt_dir(state_dir: Path) -> Path:
    return state_dir / _RECEIPT_DIR_NAME


def _receipts(state_dir: Path) -> list[dict[str, Any]]:
    """Every durable per-window receipt, or [] when none has ever been written."""
    directory = _receipt_dir(state_dir)
    if not directory.is_dir():
        return []
    return [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(directory.glob("*.json"))
    ]


# ---------------------------------------------------------------------------
# R1 (C1) -- mixed severity in one window, both processing orders
# ---------------------------------------------------------------------------

_MIXED_ORDERS = ("critical-first", "warning-first")


def test_r1_mixed_severity_one_window_keeps_both_records(tmp_path, storm_paths, monkeypatch):
    """RED at base. Two aggregates in one window must not share an incident key."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = int(time.time())
    incident_state = _disp.load_incident_state(paths)

    critical_members = [
        _member("c1", "host-a", "critical", "disk gone", window_start),
        _member("c2", "host-b", "critical", "disk gone", window_start),
        _member("c3", "host-c", "critical", "disk gone", window_start),
    ]
    warning_members = [
        _member("w1", "host-d", "warning", "queue slow", window_start),
        _member("w2", "host-e", "warning", "queue slow", window_start),
    ]
    assert _collapse(paths, critical_members, window_start, incident_state) == 3
    assert _collapse(paths, warning_members, window_start, incident_state) == 2

    digests = _digests(paths)
    assert len(digests) == 2, f"expected two digests, got {len(digests)}"
    keys = [_disp.incident_key(digest) for digest in digests]
    assert len(set(keys)) == 2, f"digests must not share an incident key: {keys}"

    receipts = _receipts(tmp_path)
    assert len(receipts) == 2, f"expected two receipts, got {len(receipts)}"
    assert {receipt["fingerprint"] for receipt in receipts} == {
        digest["storm"]["fingerprint"] for digest in digests
    }
    assert {receipt["severity"] for receipt in receipts} == {"critical", "warning"}
    assert {receipt["collapsedEvents"] for receipt in receipts} == {3, 2}

    by_severity = {digest["severity"]: digest for digest in digests}
    for order in _MIXED_ORDERS:
        state = _disp.load_incident_state(paths)
        sequence = (
            [by_severity["critical"], by_severity["warning"]]
            if order == "critical-first"
            else [by_severity["warning"], by_severity["critical"]]
        )
        for digest in sequence:
            _disp.mark_incident_sent(digest, state)
        open_incidents = state["openIncidents"]
        assert len(open_incidents) == 2, f"{order}: expected two records, got {len(open_incidents)}"
        for digest in sequence:
            record = open_incidents[_disp.incident_key(digest)]
            assert digest["summary"][:60] in record["lastSummary"], order
            assert f"severity:{digest['severity']}" in record["lastEvidence"], order
            assert f"fingerprint:{digest['storm']['fingerprint']}" in record["lastEvidence"], order
            assert f"collapsed_events:{digest['storm']['collapsedEvents']}" in record["lastEvidence"], order


# ---------------------------------------------------------------------------
# R2 (C2) -- one fingerprint, two windows
# ---------------------------------------------------------------------------

def test_r2_same_fingerprint_two_windows_are_two_identities(tmp_path, storm_paths, monkeypatch):
    """RED at base. Two windows of the same fingerprint must be two identities."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    first_start = int(time.time())
    second_start = first_start + 600
    incident_state = _disp.load_incident_state(paths)

    assert _collapse(
        paths,
        [
            _member("a1", "host-a", "critical", "same text", first_start),
            _member("a2", "host-b", "critical", "same text", first_start),
        ],
        first_start,
        incident_state,
    ) == 2
    assert _collapse(
        paths,
        [
            _member("b1", "host-a", "critical", "same text", second_start),
            _member("b2", "host-b", "critical", "same text", second_start),
        ],
        second_start,
        incident_state,
    ) == 2

    digests = _digests(paths)
    assert len(digests) == 2, f"expected two digests, got {len(digests)}"
    assert len({digest["storm"]["fingerprint"] for digest in digests}) == 1, "fingerprints must match"
    keys = [_disp.incident_key(digest) for digest in digests]
    assert len(set(keys)) == 2, f"two windows must be two identities: {keys}"

    receipts = _receipts(tmp_path)
    assert len(receipts) == 2, f"expected two receipts, got {len(receipts)}"
    assert {receipt["windowStartEpoch"] for receipt in receipts} == {first_start, second_start}


# ---------------------------------------------------------------------------
# I1 (C3) -- INVARIANT: one fingerprint, one window, one identity
# ---------------------------------------------------------------------------

def test_i1_invariant_same_fingerprint_same_window_is_one_identity(tmp_path, storm_paths, monkeypatch):
    """INVARIANT (passes at base and after). The identity must not become per-event."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = int(time.time())
    incident_state = _disp.load_incident_state(paths)

    assert _collapse(
        paths,
        [
            _member("s1", "host-a", "critical", "one window", window_start),
            _member("s2", "host-b", "critical", "one window", window_start),
        ],
        window_start,
        incident_state,
    ) == 2
    assert _collapse(
        paths,
        [
            _member("s3", "host-c", "critical", "one window", window_start + 10),
        ],
        window_start + 10,
        incident_state,
    ) == 1

    digests = _digests(paths)
    assert len(digests) == 1, f"one window must publish one digest, got {len(digests)}"
    receipts = _receipts(tmp_path)
    assert len(receipts) <= 1, f"one window must not produce two receipts, got {len(receipts)}"


# ---------------------------------------------------------------------------
# R3 (C4) -- death before the publication, and no second page after it
# ---------------------------------------------------------------------------

class _PublishFailure(RuntimeError):
    """Stands in for the process dying between the receipt and the publication."""


def test_r3_receipt_survives_death_before_publication(tmp_path, storm_paths, monkeypatch):
    """RED at base. The obligation must be durable before the irreversible move."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = int(time.time())
    incident_state = _disp.load_incident_state(paths)
    members = [
        _member("d1", "host-a", "critical", "crash window", window_start),
        _member("d2", "host-b", "critical", "crash window", window_start),
    ]

    def _die(*args, **kwargs):
        raise _PublishFailure("process died before the digest reached the queue")

    monkeypatch.setattr(_disp, "publish_event_json", _die)
    with pytest.raises(_PublishFailure):
        _collapse(paths, members, window_start, incident_state)
    monkeypatch.undo()
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)

    receipts = _receipts(tmp_path)
    assert len(receipts) == 1, f"the owed page must be durable, got {len(receipts)} receipts"
    assert receipts[0]["publishedAtEpoch"] is None, "an unpublished digest must not read as published"
    assert _digests(paths) == [], "no digest was published"

    # A restart is a new process, so the in-process ledger of receipts this
    # process wrote is empty. Clearing it is what makes the next call an
    # adoption rather than a re-read of this process's own work.
    _disp._storm_receipts_written.clear()
    adopted = _disp.reconcile_storm_digest_receipts(paths)
    assert adopted == 1, f"expected one adoption, got {adopted}"
    assert _receipts(tmp_path)[0]["adoptions"] == 1
    assert any(
        record.get("type") == "storm_receipt_adopted" for record in _dispatch_records(paths)
    ), "the adoption must be recorded"

    # The members are still in the outbox, so the re-collapse republishes once.
    records = [(paths["outbox"] / f"{member['id']}.json", member) for member in members]
    assert _disp.collapse_storm_group(
        paths, (_disp.storm_fingerprint(members[0]), window_start), records, incident_state
    ) == 2
    assert len(_digests(paths)) == 1, "the retry must publish exactly one digest"
    settled = _receipts(tmp_path)
    assert len(settled) == 1, "the retry must not open a second receipt"
    assert settled[0]["publishedAtEpoch"] is not None, "the page is proven, the receipt must say so"


def test_r3b_death_after_publication_yields_no_second_page(tmp_path, storm_paths, monkeypatch):
    """RED at base. A death between publication and acknowledgement must not page twice."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = int(time.time())
    incident_state = _disp.load_incident_state(paths)

    assert _collapse(
        paths,
        [
            _member("p1", "host-a", "critical", "absorb window", window_start),
            _member("p2", "host-b", "critical", "absorb window", window_start),
        ],
        window_start,
        incident_state,
    ) == 2
    receipt_files = sorted(_receipt_dir(tmp_path).glob("*.json")) if _receipt_dir(tmp_path).is_dir() else []
    assert len(receipt_files) == 1, f"expected one receipt, got {len(receipt_files)}"

    # Roll the receipt back to unpublished: the page went out, the process died
    # before it could say so.
    unpublished = json.loads(receipt_files[0].read_text(encoding="utf-8"))
    unpublished["publishedAtEpoch"] = None
    receipt_files[0].write_text(json.dumps(unpublished, sort_keys=True) + "\n", encoding="utf-8")

    assert _collapse(
        paths,
        [_member("p3", "host-c", "critical", "absorb window", window_start + 5)],
        window_start + 5,
        incident_state,
    ) == 1
    assert len(_digests(paths)) == 1, "the absorb path must not publish a second digest"
    settled = _receipts(tmp_path)
    assert len(settled) == 1, f"expected one receipt, got {len(settled)}"
    assert settled[0]["publishedAtEpoch"] is not None, "the absorb must settle the owed receipt"


# ---------------------------------------------------------------------------
# R4 (C5) -- the retained set is capped and every drop is recorded
# ---------------------------------------------------------------------------

_RECEIPT_CAP = 2
_CAP_WINDOWS = 3


def test_r4_receipt_set_is_capped_and_the_drop_is_recorded(tmp_path, storm_paths, monkeypatch):
    """RED at base. The retained set must have a bound, and overflow must be stated."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    monkeypatch.setattr(_disp, "STORM_RECEIPT_MAX_RECORDS", _RECEIPT_CAP, raising=False)
    paths = storm_paths
    incident_state = _disp.load_incident_state(paths)
    first_start = int(time.time())
    starts = [first_start + index * 600 for index in range(_CAP_WINDOWS)]

    for index, window_start in enumerate(starts):
        assert _collapse(
            paths,
            [
                _member(f"k{index}a", "host-a", "critical", "capped", window_start),
                _member(f"k{index}b", "host-b", "critical", "capped", window_start),
            ],
            window_start,
            incident_state,
        ) == 2

    receipts = _receipts(tmp_path)
    assert len(receipts) == _RECEIPT_CAP, f"cap must bind, got {len(receipts)} receipts"
    retained = {receipt["windowStartEpoch"] for receipt in receipts}
    assert retained == set(starts[1:]), f"oldest window must be evicted first, kept {retained}"
    evictions = [
        record for record in _dispatch_records(paths) if record.get("type") == "storm_receipt_evicted"
    ]
    assert len(evictions) == 1, f"every drop must be recorded, got {len(evictions)}"
    # The controller log projects details to counts, booleans and enums, so the
    # disposition is read from `details` and the opaque receipt id is not in it.
    dropped = evictions[0]["details"]
    assert dropped["windowStartEpoch"] == starts[0]
    assert dropped["cap"] == _RECEIPT_CAP
    assert dropped["published"] is True


def test_r4b_no_incident_path_rewrites_or_removes_a_receipt(tmp_path, storm_paths, monkeypatch):
    """RED at base. Receipts must be untouched by send, clear and sweep."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = int(time.time())
    incident_state = _disp.load_incident_state(paths)
    assert _collapse(
        paths,
        [
            _member("i1", "host-a", "critical", "untouched", window_start),
            _member("i2", "host-b", "critical", "untouched", window_start),
        ],
        window_start,
        incident_state,
    ) == 2
    directory = _receipt_dir(tmp_path)
    assert directory.is_dir(), "the receipt store must exist"
    before = {path.name: path.read_bytes() for path in sorted(directory.glob("*.json"))}
    assert len(before) == 1, f"expected one receipt, got {len(before)}"

    state = _disp.load_incident_state(paths)
    for digest in _digests(paths):
        _disp.mark_incident_sent(digest, state)
    _disp.save_incident_state(paths, state)
    _disp.sweep_stale_incidents(paths)

    after = {path.name: path.read_bytes() for path in sorted(directory.glob("*.json"))}
    assert after == before, "no incident path may rewrite or remove a receipt"


# ---------------------------------------------------------------------------
# R5 (C6) -- the evidence boundary, with a positive control
# ---------------------------------------------------------------------------

def test_r5_no_manifest_path_or_fingerprint_basis_survives(tmp_path, storm_paths, monkeypatch):
    """RED at base. The digest and the receipt must carry no path and no basis."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = int(time.time())
    incident_state = _disp.load_incident_state(paths)
    assert _collapse(
        paths,
        [
            _member("e1", "host-a", "critical", "boundary window", window_start),
            _member("e2", "host-b", "critical", "boundary window", window_start),
        ],
        window_start,
        incident_state,
    ) == 2

    digests = _digests(paths)
    assert len(digests) == 1
    digest = digests[0]
    manifest_root = str(paths["storm_manifests"])
    digest_surfaces = {
        "evidence": digest["evidence"],
        "storm": json.dumps(digest["storm"], sort_keys=True),
        "diagnostics": json.dumps(digest["diagnostics"], sort_keys=True),
        "rendered": _disp.format_event(digest),
    }
    # Positive control first, so the absence assertions below are not vacuous.
    fingerprint = digest["storm"]["fingerprint"]
    assert fingerprint in digest_surfaces["evidence"], "the opaque fingerprint must survive"
    assert f"window_start_epoch:{window_start}" in digest_surfaces["evidence"], "the window must survive"
    assert fingerprint in digest_surfaces["rendered"], "the rendered page must keep the fingerprint"

    for name, text in digest_surfaces.items():
        assert manifest_root not in text, f"{name} still carries a manifest path"
        assert "fingerprint_basis" not in text, f"{name} still carries the fingerprint basis"
    assert "manifest" not in digest["storm"], "the digest must not bind a path in its payload"
    assert "logHints" not in digest["diagnostics"], "the digest must not hint at a path"

    receipt_text = json.dumps(_receipts(tmp_path), sort_keys=True)
    assert fingerprint in receipt_text, "the receipt must carry the fingerprint"
    assert str(window_start) in receipt_text, "the receipt must carry the window"
    assert manifest_root not in receipt_text, "the receipt still carries a manifest path"
    assert "fingerprint_basis" not in receipt_text, "the receipt still carries the fingerprint basis"


# ---------------------------------------------------------------------------
# I2 (C7) -- INVARIANT: force-notify and the outbox filename are unchanged
# ---------------------------------------------------------------------------

_OUTBOX_GLOB_MARKER = "storm-collapse"


def test_i2_invariant_force_notify_and_outbox_name_unchanged(tmp_path, storm_paths, monkeypatch):
    """INVARIANT (passes at base and after). The force-notify gate must still fire."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = int(time.time())
    incident_state = _disp.load_incident_state(paths)
    assert _collapse(
        paths,
        [
            _member("f1", "host-a", "critical", "force notify", window_start),
            _member("f2", "host-b", "critical", "force notify", window_start),
        ],
        window_start,
        incident_state,
    ) == 2

    digest_paths = _digest_paths(paths)
    assert len(digest_paths) == 1, "the outbox filename must still carry the source segment"
    assert _OUTBOX_GLOB_MARKER in digest_paths[0].name
    digest = json.loads(digest_paths[0].read_text(encoding="utf-8"))
    assert digest["source"] == _STORM_SOURCE, "the raw source gates force-notify"
    assert digest["instance"] == _STORM_SOURCE, "the instance carries the maintenance scope"
    level = _disp.force_notify_level(digest)
    assert level is not None, "a digest must still force-notify"
    assert level == _disp.safe_segment(digest["diagnostics"]["forceNotifyLevel"])
    assert digest["storm"]["fingerprint"] in level and str(window_start) in level
    assert _disp.incident_scope(digest) == "fleet|storm-collapse", "the maintenance scope must not move"


# ---------------------------------------------------------------------------
# Ruling invariant -- incident_source() is byte-identical for every other source
# ---------------------------------------------------------------------------

# The eighteen in-scope sources. Only storm-collapse may change; a table rather
# than parametrised cases so the falsifier is one named constant.
_OTHER_SEVENTEEN_SOURCES = (
    "agent_turn_usage_unavailable",
    "agent_turn_admission_rejected",
    "runtime_provider_fallback_replay_failed",
    "agent_reply_guarantee_breach",
    "fallback_provider_failed",
    "fallback_empty_turn",
    "provider_unknown_terminal",
    "scheduler_send_failed",
    "provider_transient_network",
    "ingest_queue_displacement",
    "outbound_message_guard",
    "heal_repeated_failures",
    "remote-writefail-nondurable",
    "service-exit",
    "process-exit",
    "test-provenance-refused",
    "poison-event-quarantine",
)

# Sources whose identity is qualified at the base commit, with the qualifier the
# base already appends. Their behaviour must not move either.
_QUALIFIED_BASE_CASES = (
    ("daily-health", {"alertSource": "source_update"}, "daily-health:source_update"),
    ("heartbeat-watchdog", {"alertSource": "roster"}, "heartbeat-watchdog:roster"),
    ("daily-health-fail", {"alertSource": "probe"}, "daily-health-fail:probe"),
)


def _bare_event(source: str, **extra: Any) -> dict[str, Any]:
    event = {
        "source": source,
        "machine": "host-a",
        "instance": "eh-bot",
        "severity": "critical",
        "summary": "identity probe",
    }
    event.update(extra)
    return event


def test_incident_source_is_unchanged_for_every_other_source():
    """INVARIANT. Only storm-collapse gains a qualifier."""
    for source in _OTHER_SEVENTEEN_SOURCES:
        assert _disp.incident_source(_bare_event(source)) == source, source
        # A stray storm block must not qualify a source that is not the digest's.
        with_storm = _bare_event(
            source, storm={"fingerprint": "a" * 16, "windowStartEpoch": 1700000000}
        )
        assert _disp.incident_source(with_storm) == source, f"{source} with a storm block"
    for source, extra, expected in _QUALIFIED_BASE_CASES:
        assert _disp.incident_source(_bare_event(source, **extra)) == expected, source
    collector = _bare_event(
        "remote-writefail-nondurable",
        instance="bot-errors-collector",
        diagnostics={"remote": "host-z"},
    )
    assert _disp.incident_source(collector) == "remote-writefail-nondurable:host-z"


def test_storm_collapse_without_a_window_keeps_the_bare_source():
    """INVARIANT. A malformed digest must fall back, never mint a broken key."""
    assert _disp.incident_source(_bare_event(_STORM_SOURCE)) == _STORM_SOURCE
    assert _disp.incident_source(_bare_event(_STORM_SOURCE, storm={})) == _STORM_SOURCE
    partial = _bare_event(_STORM_SOURCE, storm={"fingerprint": "b" * 16})
    assert _disp.incident_source(partial) == _STORM_SOURCE
    non_integer = _bare_event(
        _STORM_SOURCE, storm={"fingerprint": "b" * 16, "windowStartEpoch": "1700000000"}
    )
    assert _disp.incident_source(non_integer) == _STORM_SOURCE


def test_legacy_unqualified_storm_record_is_folded_once(tmp_path, storm_paths, monkeypatch):
    """RED at base. The one record under the unqualified key must migrate."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = int(time.time())
    incident_state = _disp.load_incident_state(paths)
    assert _collapse(
        paths,
        [
            _member("m1", "host-a", "critical", "legacy fold", window_start),
            _member("m2", "host-b", "critical", "legacy fold", window_start),
        ],
        window_start,
        incident_state,
    ) == 2
    digest = _digests(paths)[0]

    legacy_key = "fleet|storm-collapse|storm-collapse"
    qualified_key = _disp.incident_key(digest)
    assert qualified_key != legacy_key, "the digest must not key to the unqualified record"

    state = {"version": 1, "openIncidents": {legacy_key: {"status": "open", "openedAt": 1}}, "lastSentAt": {legacy_key: 2}}
    _disp.migrate_legacy_unqualified_incident(digest, state)
    assert legacy_key not in state["openIncidents"], "the legacy record must be folded"
    assert state["openIncidents"][qualified_key]["openedAt"] == 1
    assert state["lastSentAt"][qualified_key] == 2
