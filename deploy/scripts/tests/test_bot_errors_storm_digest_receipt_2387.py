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
import socket
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


@pytest.fixture(autouse=True)
def _clean_receipt_ledger():
    """Restore the dispatcher module's in-process receipt ledger after each case.

    The ledger is a module global and this file mutates it, directly and through
    the code under test. Cross-FILE leakage is impossible -- every test module
    loads its own dispatcher module object -- but intra-file order dependence is
    not, and the adoption assertions are only honest while the set is what the
    case intended. Snapshot and restore in place rather than rebinding the name,
    because the dispatcher closes over the object, not over this module's view
    of it.
    """
    saved = set(_disp._storm_receipts_written)
    yield
    _disp._storm_receipts_written.clear()
    _disp._storm_receipts_written.update(saved)


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

    # A restart is a new process, so the in-process ledger of receipts written
    # and not yet proved published is empty. Clearing it is what makes the next
    # call an adoption rather than a re-read of this process's own work.
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
    # The ledger holds only ids still owed: an acknowledged receipt suppresses its
    # own adoption through publishedAtEpoch, so the id does not accumulate.
    assert settled[0]["receiptId"] not in _disp._storm_receipts_written


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


# ---------------------------------------------------------------------------
# Fix iteration 1. Everything below is RED at 93d9be77 -- the commit the two
# merge reviews bounced -- except where a docstring says INVARIANT or FALSIFIER.
# Every case leads with an assertion that also fails at b6c9d60f, so neither
# baseline reaches a symbol it does not define and no failure here is an
# AttributeError. Head-only receipt fields are read with .get() for the same
# reason.
# ---------------------------------------------------------------------------

_ORPHAN_SOURCE = "meta_alert_storm_receipt_orphan"
_SETTLED_PUBLICATION_PROVEN = "publication-proven"
_SETTLED_PUBLISHED_EVIDENCE = "published-evidence"
_SETTLED_ORPHAN_PAGED = "orphan-paged"


def _closed_window_start() -> int:
    """A window whose 120 seconds are long over, so no re-collapse can reach it."""
    return int(time.time()) - 3600


def _receipt_files(state_dir: Path) -> list[Path]:
    directory = _receipt_dir(state_dir)
    if not directory.is_dir():
        return []
    return sorted(directory.glob("*.json"))


def _records_of_type(paths: dict[str, Path], kind: str) -> list[dict[str, Any]]:
    return [record for record in _dispatch_records(paths) if record.get("type") == kind]


def _orphan_pages(paths: dict[str, Path]) -> list[dict[str, Any]]:
    """Every content-free orphan meta-alert sitting in the outbox."""
    found = []
    for path in sorted(paths["outbox"].glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("source") == _ORPHAN_SOURCE:
            found.append(payload)
    return found


def _deliver(paths: dict[str, Path], digest_path: Path) -> Path:
    """Move a queued digest to sent, so the next collapse supersedes it."""
    target = paths["sent"] / digest_path.name
    os.replace(digest_path, target)
    return target


def _unpublish(path: Path) -> None:
    """Roll a receipt back to unpublished: the page went out, the process died."""
    record = json.loads(path.read_text(encoding="utf-8"))
    record["publishedAtEpoch"] = None
    record["settledReason"] = None
    path.write_text(json.dumps(record, sort_keys=True) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# F1 -- the cap must never destroy the receipt for the page publishing next
# ---------------------------------------------------------------------------

_FORCED_CAP_ONE = 1


def test_f1_cap_never_evicts_the_receipt_being_written(tmp_path, storm_paths, monkeypatch):
    """RED at 93d9be77. A window older than the retained set must keep its receipt."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    monkeypatch.setattr(_disp, "STORM_RECEIPT_MAX_RECORDS", _FORCED_CAP_ONE, raising=False)
    paths = storm_paths
    incident_state = _disp.load_incident_state(paths)
    newer_start = int(time.time())
    older_start = newer_start - 6000

    assert _collapse(
        paths,
        [
            _member("n1", "host-a", "critical", "newer window", newer_start),
            _member("n2", "host-b", "critical", "newer window", newer_start),
        ],
        newer_start,
        incident_state,
    ) == 2
    assert _collapse(
        paths,
        [
            _member("o1", "host-c", "warning", "older window", older_start),
            _member("o2", "host-d", "warning", "older window", older_start),
        ],
        older_start,
        incident_state,
    ) == 2

    kept = {receipt["windowStartEpoch"] for receipt in _receipts(tmp_path)}
    assert older_start in kept, (
        f"the receipt for the page that just published must survive its own write, kept {kept}"
    )
    published = {digest["storm"]["windowStartEpoch"] for digest in _digests(paths)}
    assert older_start in published, "the older window must still publish its digest"
    assert len(_receipts(tmp_path)) == _FORCED_CAP_ONE, "the bound must still hold"


def test_f1b_evicting_another_windows_unpublished_receipt_is_recorded(
    tmp_path, storm_paths, monkeypatch
):
    """RED at 93d9be77. An unpublished receipt evicted by the bound must be named."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    monkeypatch.setattr(_disp, "STORM_RECEIPT_MAX_RECORDS", _FORCED_CAP_ONE, raising=False)
    paths = storm_paths
    incident_state = _disp.load_incident_state(paths)
    stranded_start = int(time.time()) - 6000
    later_start = int(time.time())

    def _die(*args, **kwargs):
        raise _PublishFailure("the digest never reached the queue")

    monkeypatch.setattr(_disp, "publish_event_json", _die)
    with pytest.raises(_PublishFailure):
        _collapse(
            paths,
            [
                _member("u1", "host-a", "critical", "stranded window", stranded_start),
                _member("u2", "host-b", "critical", "stranded window", stranded_start),
            ],
            stranded_start,
            incident_state,
        )
    monkeypatch.undo()
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    monkeypatch.setattr(_disp, "STORM_RECEIPT_MAX_RECORDS", _FORCED_CAP_ONE, raising=False)

    stranded = _receipts(tmp_path)
    assert len(stranded) == 1, f"the stranded window must hold a receipt, got {len(stranded)}"
    assert stranded[0]["publishedAtEpoch"] is None, "the stranded receipt is still owed"
    stranded_fingerprint = stranded[0]["fingerprint"]

    assert _collapse(
        paths,
        [
            _member("v1", "host-c", "critical", "later window", later_start),
            _member("v2", "host-d", "critical", "later window", later_start),
        ],
        later_start,
        incident_state,
    ) == 2

    evictions = _records_of_type(paths, "storm_receipt_evicted")
    assert len(evictions) == 1, f"the drop must be recorded, got {len(evictions)}"
    dropped = evictions[0]["details"]
    # The controller log admits counts, booleans and enumerated strings only, so
    # the fingerprint reaches it as a bounded integer prefix. Two fingerprints
    # can share a window; without this the two drops are indistinguishable.
    assert dropped.get("fingerprintPrefix") == int(stranded_fingerprint[:8], 16), (
        "the record must name which fingerprint of the window was dropped"
    )
    assert dropped["published"] is False, "an unpublished drop must not read as settled"
    assert dropped["windowStartEpoch"] == stranded_start
    kept = {receipt["windowStartEpoch"] for receipt in _receipts(tmp_path)}
    assert kept == {later_start}, f"the bound must retain the newest window, kept {kept}"


# ---------------------------------------------------------------------------
# F2 -- adoption must terminate, in one of three ways, and never silently
# ---------------------------------------------------------------------------

_RECONCILE_CYCLES = 5


def test_f2a_publication_evidence_settles_a_closed_window_without_paging(
    tmp_path, storm_paths, monkeypatch
):
    """RED at 93d9be77. A receipt orphaned after its page must settle, not repeat."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = _closed_window_start()
    incident_state = _disp.load_incident_state(paths)
    assert _collapse(
        paths,
        [
            _member("g1", "host-a", "critical", "settled window", window_start),
            _member("g2", "host-b", "critical", "settled window", window_start),
        ],
        window_start,
        incident_state,
    ) == 2

    files = _receipt_files(tmp_path)
    assert len(files) == 1, f"expected one receipt, got {len(files)}"
    # The page went out; the process died before it could say so.
    _unpublish(files[0])
    _disp._storm_receipts_written.clear()

    for _cycle in range(_RECONCILE_CYCLES):
        _disp.reconcile_storm_digest_receipts(paths)

    settled = _receipts(tmp_path)
    assert len(settled) == 1, f"expected one receipt, got {len(settled)}"
    assert settled[0]["publishedAtEpoch"] is not None, (
        "a closed window whose digest exists must settle; no collapse path can reach it again"
    )
    assert settled[0].get("settledReason") == _SETTLED_PUBLISHED_EVIDENCE
    assert settled[0]["adoptions"] == 1, (
        f"adoptions must count adoptions, not cycles, got {settled[0]['adoptions']}"
    )
    assert _orphan_pages(paths) == [], "evidence exists, so nothing may page"
    assert len(_digests(paths)) == 1, "settlement must not publish a second digest"
    assert len(_records_of_type(paths, "storm_receipt_settled")) == 1


def test_f2b_an_open_window_is_left_to_the_recollapse_and_logged_once(
    tmp_path, storm_paths, monkeypatch
):
    """RED at 93d9be77. An open window must be adopted once per process, not per cycle."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = int(time.time())
    incident_state = _disp.load_incident_state(paths)

    def _die(*args, **kwargs):
        raise _PublishFailure("the digest never reached the queue")

    monkeypatch.setattr(_disp, "publish_event_json", _die)
    with pytest.raises(_PublishFailure):
        _collapse(
            paths,
            [
                _member("h1", "host-a", "critical", "open window", window_start),
                _member("h2", "host-b", "critical", "open window", window_start),
            ],
            window_start,
            incident_state,
        )
    monkeypatch.undo()
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)

    owed = _receipts(tmp_path)
    assert len(owed) == 1, f"the owed page must be durable, got {len(owed)}"
    _disp._storm_receipts_written.clear()

    for _cycle in range(_RECONCILE_CYCLES):
        _disp.reconcile_storm_digest_receipts(paths)

    still_owed = _receipts(tmp_path)
    assert len(still_owed) == 1
    assert still_owed[0]["adoptions"] == 1, (
        f"an open window must be adopted once per process, got {still_owed[0]['adoptions']}"
    )
    assert len(_records_of_type(paths, "storm_receipt_adopted")) == 1, (
        "one adoption record per process, not one per cycle"
    )
    assert still_owed[0]["publishedAtEpoch"] is None, "the page is still owed"
    assert still_owed[0].get("settledReason") is None
    assert _orphan_pages(paths) == [], "an open window must not page an orphan"


def test_f2c_a_closed_window_with_no_evidence_pages_one_orphan_and_settles(
    tmp_path, storm_paths, monkeypatch
):
    """RED at 93d9be77. A lost page must end in a page, never in silence."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = _closed_window_start()
    incident_state = _disp.load_incident_state(paths)

    def _die(*args, **kwargs):
        raise _PublishFailure("the digest never reached the queue")

    monkeypatch.setattr(_disp, "publish_event_json", _die)
    with pytest.raises(_PublishFailure):
        _collapse(
            paths,
            [
                _member("j1", "host-a", "critical", "lost window", window_start),
                _member("j2", "host-b", "critical", "lost window", window_start),
            ],
            window_start,
            incident_state,
        )
    monkeypatch.undo()
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)

    owed = _receipts(tmp_path)
    assert len(owed) == 1, f"the owed page must be durable, got {len(owed)}"
    fingerprint = owed[0]["fingerprint"]
    _disp._storm_receipts_written.clear()

    for _cycle in range(_RECONCILE_CYCLES):
        _disp.reconcile_storm_digest_receipts(paths)

    orphans = _orphan_pages(paths)
    assert len(orphans) == 1, (
        f"a closed window with no evidence must page exactly once, got {len(orphans)}"
    )
    orphan = orphans[0]
    # Positive controls first, so the absence assertions below are not vacuous.
    assert fingerprint in orphan["evidence"], "the orphan page must carry the fingerprint"
    assert f"window_start_epoch:{window_start}" in orphan["evidence"]
    assert "collapsed_events:2" in orphan["evidence"]
    assert "affected_hosts:2" in orphan["evidence"]
    rendered = _disp.format_event(orphan)
    assert fingerprint in rendered, "the rendered orphan page must carry the fingerprint"
    for surface in (orphan["evidence"], rendered):
        assert str(paths["storm_manifests"]) not in surface, "no manifest path may appear"
        assert "fingerprint_basis" not in surface, "no fingerprint basis may appear"
        assert "host-a" not in surface and "host-b" not in surface, "no host name may appear"
        assert "lost window" not in surface, "no summary text may appear"

    settled = _receipts(tmp_path)
    assert len(settled) == 1
    assert settled[0].get("settledReason") == _SETTLED_ORPHAN_PAGED
    assert settled[0]["publishedAtEpoch"] is not None, "the orphan page settles the receipt"
    assert settled[0]["adoptions"] == 1, (
        f"adoptions must count adoptions, not cycles, got {settled[0]['adoptions']}"
    )
    paged = _records_of_type(paths, "storm_receipt_orphan_paged")
    assert len(paged) == 1
    assert paged[0]["details"]["windowStartEpoch"] == window_start
    settled_records = _records_of_type(paths, "storm_receipt_settled")
    assert len(settled_records) == 1
    assert settled_records[0]["details"]["orphanPaged"] is True


def test_f2d_a_superseding_revision_is_not_settled_by_the_first_pages_evidence(
    tmp_path, storm_paths, monkeypatch
):
    """RED at 93d9be77. Evidence must resolve the revision the receipt is owed for."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = _closed_window_start()
    incident_state = _disp.load_incident_state(paths)
    assert _collapse(
        paths,
        [
            _member("q1", "host-a", "critical", "revision window", window_start),
            _member("q2", "host-b", "critical", "revision window", window_start),
        ],
        window_start,
        incident_state,
    ) == 2
    first_digest_paths = _digest_paths(paths)
    assert len(first_digest_paths) == 1
    _deliver(paths, first_digest_paths[0])

    def _die(*args, **kwargs):
        raise _PublishFailure("the superseding page never reached the queue")

    monkeypatch.setattr(_disp, "publish_event_json", _die)
    with pytest.raises(_PublishFailure):
        _collapse(
            paths,
            [_member("q3", "host-c", "critical", "revision window", window_start + 5)],
            window_start + 5,
            incident_state,
        )
    monkeypatch.undo()
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)

    owed = _receipts(tmp_path)
    assert len(owed) == 1, f"expected one receipt, got {len(owed)}"
    assert owed[0].get("revision") == 2, (
        "the superseding page must own the receipt, or its loss is invisible"
    )
    assert owed[0]["publishedAtEpoch"] is None, "the superseding page never published"
    receipt_id = owed[0]["receiptId"]
    # The FIRST revision's digest is present and delivered. A revision-blind
    # evidence check would read it as proof for the second revision's page.
    assert _disp.find_event_path_by_id(
        receipt_id, paths, ("outbox", "processing", "sent", "suppressed", "quarantine")
    ) is not None, "the first page must still be on record"

    _disp._storm_receipts_written.clear()
    _disp.reconcile_storm_digest_receipts(paths)

    settled = _receipts(tmp_path)
    assert settled[0].get("settledReason") == _SETTLED_ORPHAN_PAGED, (
        "revision 1 evidence must not settle revision 2"
    )
    assert len(_orphan_pages(paths)) == 1, "the lost superseding page must be reported"


# ---------------------------------------------------------------------------
# F3 -- every publication for a window is preceded by its receipt
# ---------------------------------------------------------------------------

def test_f3_superseding_publication_writes_and_settles_its_own_receipt(
    tmp_path, storm_paths, monkeypatch
):
    """RED at 93d9be77. The superseding page must be preceded by a receipt too."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = int(time.time())
    incident_state = _disp.load_incident_state(paths)
    assert _collapse(
        paths,
        [
            _member("t1", "host-a", "critical", "superseding window", window_start),
            _member("t2", "host-b", "critical", "superseding window", window_start),
        ],
        window_start,
        incident_state,
    ) == 2
    delivered = _digest_paths(paths)
    assert len(delivered) == 1
    _deliver(paths, delivered[0])

    assert _collapse(
        paths,
        [
            _member("t3", "host-c", "critical", "superseding window", window_start + 5),
            _member("t4", "host-d", "critical", "superseding window", window_start + 5),
        ],
        window_start + 5,
        incident_state,
    ) == 2

    superseding = _digests(paths)
    assert len(superseding) == 1, "the superseding revision must publish one digest"
    assert superseding[0]["id"].endswith("-v2")

    receipts = _receipts(tmp_path)
    assert len(receipts) == 1, f"one window keeps one receipt, got {len(receipts)}"
    assert receipts[0].get("revision") == 2, "the receipt must name the revision it owes"
    assert receipts[0]["publishedAtEpoch"] is not None, "the superseding page is proven"
    assert receipts[0].get("settledReason") == _SETTLED_PUBLICATION_PROVEN
    assert receipts[0]["collapsedEvents"] == 2, "the receipt must carry this revision counts"
    assert receipts[0]["affectedHosts"] == 2


def test_f3b_a_superseding_publication_writes_a_receipt_that_does_not_exist(
    tmp_path, storm_paths, monkeypatch
):
    """RED at 93d9be77. A wiped store must not let a superseding page go unrecorded."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = int(time.time())
    incident_state = _disp.load_incident_state(paths)
    assert _collapse(
        paths,
        [
            _member("y1", "host-a", "critical", "wiped window", window_start),
            _member("y2", "host-b", "critical", "wiped window", window_start),
        ],
        window_start,
        incident_state,
    ) == 2
    delivered = _digest_paths(paths)
    assert len(delivered) == 1
    _deliver(paths, delivered[0])

    existing = _receipt_files(tmp_path)
    assert len(existing) == 1, f"expected one receipt, got {len(existing)}"
    for path in existing:
        path.unlink()
    _disp._storm_receipts_written.clear()
    assert _receipts(tmp_path) == [], "the store is wiped"

    assert _collapse(
        paths,
        [_member("y3", "host-c", "critical", "wiped window", window_start + 5)],
        window_start + 5,
        incident_state,
    ) == 1

    rebuilt = _receipts(tmp_path)
    assert len(rebuilt) == 1, "the superseding page must write its own receipt"
    assert rebuilt[0].get("revision") == 2
    assert rebuilt[0]["publishedAtEpoch"] is not None


# ---------------------------------------------------------------------------
# F4 -- the in-process ledger must not leak an id on any acknowledgement path
# ---------------------------------------------------------------------------

def test_f4_acknowledgement_discards_the_ledger_id_on_every_return_path(
    tmp_path, storm_paths, monkeypatch
):
    """RED at 93d9be77. Write, ack, re-write, ack again: the id must be gone."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = int(time.time())
    incident_state = _disp.load_incident_state(paths)
    assert _collapse(
        paths,
        [
            _member("z1", "host-a", "critical", "ledger window", window_start),
            _member("z2", "host-b", "critical", "ledger window", window_start),
        ],
        window_start,
        incident_state,
    ) == 2
    receipts = _receipts(tmp_path)
    assert len(receipts) == 1, f"expected one receipt, got {len(receipts)}"
    receipt_id = receipts[0]["receiptId"]
    assert receipt_id not in _disp._storm_receipts_written, "the first ack drops the id"

    # The fresh path runs again for a window whose receipt survives: the write
    # re-adds the id, and the acknowledgement must drop it whatever it returns.
    rewritten = _disp.storm_digest_receipt_record(
        receipt_id, receipts[0]["fingerprint"], window_start,
        receipts[0]["windowEndEpoch"], "critical", 2, 2,
    )
    _disp.write_storm_digest_receipt(paths, rewritten)
    assert receipt_id in _disp._storm_receipts_written, "the write claims the id"
    _disp.acknowledge_storm_digest_receipt(paths, receipt_id)
    assert receipt_id not in _disp._storm_receipts_written, "the id must not accumulate"

    # An acknowledgement that finds the receipt already settled returns early;
    # that path must drop the id too.
    _disp._storm_receipts_written.add(receipt_id)
    assert _disp.acknowledge_storm_digest_receipt(paths, receipt_id) is False
    assert receipt_id not in _disp._storm_receipts_written, "the early return leaked the id"

    # So must an acknowledgement for a receipt that is not there at all.
    _disp._storm_receipts_written.add(receipt_id)
    for path in _receipt_files(tmp_path):
        path.unlink()
    assert _disp.acknowledge_storm_digest_receipt(paths, receipt_id) is False
    assert receipt_id not in _disp._storm_receipts_written, "the absent-record return leaked the id"


# ---------------------------------------------------------------------------
# F5 -- the bound covers every file in the store, and a failure to unlink is said
# ---------------------------------------------------------------------------

_PLANTED_JSON = "wrong-shape.json"
_PLANTED_BARE = "garbage-not-json"
_DURABLE_INTERNAL = ".durable-json.lock"


def test_f5_unreadable_files_count_toward_the_cap_and_go_first(
    tmp_path, storm_paths, monkeypatch
):
    """RED at 93d9be77. Retention must bound the store, not only what parses."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = int(time.time())
    incident_state = _disp.load_incident_state(paths)
    assert _collapse(
        paths,
        [
            _member("c8", "host-a", "critical", "census window", window_start),
            _member("c9", "host-b", "critical", "census window", window_start),
        ],
        window_start,
        incident_state,
    ) == 2
    receipts = _receipts(tmp_path)
    assert len(receipts) == 1, f"expected one receipt, got {len(receipts)}"
    kept_id = receipts[0]["receiptId"]

    directory = _receipt_dir(tmp_path)
    (directory / _PLANTED_JSON).write_text('{"schemaVersion": 1}', encoding="utf-8")
    (directory / _PLANTED_BARE).write_text("not json at all", encoding="utf-8")
    # Positive control: a durable-writer internal is not a receipt and must
    # never be unlinked by retention.
    (directory / _DURABLE_INTERNAL).write_text("", encoding="utf-8")

    monkeypatch.setattr(_disp, "STORM_RECEIPT_MAX_RECORDS", _FORCED_CAP_ONE, raising=False)
    _disp.enforce_storm_receipt_cap(paths)

    names = sorted(path.name for path in directory.iterdir())
    assert _PLANTED_JSON not in names, "a wrong-shape file must count toward the bound"
    assert _PLANTED_BARE not in names, "an unparseable file must count toward the bound"
    assert _DURABLE_INTERNAL in names, "retention must never unlink a durable-writer internal"
    assert f"{kept_id}.json" in names, "unreadable entries carry no obligation and go first"
    unreadable_drops = _records_of_type(paths, "storm_receipt_unreadable_evicted")
    assert len(unreadable_drops) == 2, (
        f"each unreadable drop needs its own record, got {len(unreadable_drops)}"
    )
    assert unreadable_drops[0]["details"]["cap"] == _FORCED_CAP_ONE
    assert _records_of_type(paths, "storm_receipt_evicted") == [], (
        "a valid receipt must not be dropped while unreadable files remain"
    )


def test_f5b_an_unlink_failure_is_recorded_and_releases_the_ledger_id(
    tmp_path, storm_paths, monkeypatch
):
    """RED at 93d9be77. A store that cannot be pruned must say so, not fail quietly."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    incident_state = _disp.load_incident_state(paths)
    first_start = int(time.time())
    starts = [first_start + index * 600 for index in range(3)]
    for index, window_start in enumerate(starts):
        assert _collapse(
            paths,
            [
                _member(f"x{index}a", "host-a", "critical", "readonly", window_start),
                _member(f"x{index}b", "host-b", "critical", "readonly", window_start),
            ],
            window_start,
            incident_state,
        ) == 2
    directory = _receipt_dir(tmp_path)
    receipts = _receipts(tmp_path)
    assert len(receipts) == 3, f"expected three receipts, got {len(receipts)}"
    for receipt in receipts:
        _disp._storm_receipts_written.add(receipt["receiptId"])

    monkeypatch.setattr(_disp, "STORM_RECEIPT_MAX_RECORDS", _FORCED_CAP_ONE, raising=False)
    original_mode = directory.stat().st_mode
    directory.chmod(0o500)
    try:
        dropped = _disp.enforce_storm_receipt_cap(paths)
    finally:
        directory.chmod(original_mode)

    assert dropped == [], "nothing was unlinked, so nothing may be reported as dropped"
    assert len(_receipts(tmp_path)) == 3, "the bound is exceeded, which is the point"
    failures = _records_of_type(paths, "storm_receipt_evict_failed")
    assert len(failures) == 2, (
        f"a bound this process cannot enforce must be stated, got {len(failures)} records"
    )
    assert failures[0]["details"]["cap"] == _FORCED_CAP_ONE
    assert failures[0]["details"]["retained"] == 3
    assert failures[0]["details"]["unreadable"] is False
    claimed = {receipt["receiptId"] for receipt in _receipts(tmp_path)}
    assert len(claimed & _disp._storm_receipts_written) == 1, (
        "an id this process can no longer account for must be released"
    )


# ---------------------------------------------------------------------------
# F6 -- FALSIFIER. One helper builds every storm manifest name
# ---------------------------------------------------------------------------

def test_f6_every_storm_manifest_name_comes_from_one_helper(
    tmp_path, storm_paths, monkeypatch
):
    """FALSIFIER for the derived manifest binding. Desynchronise the helper and this dies."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    helper = getattr(_disp, "storm_manifest_path", None)
    assert helper is not None, "the manifest name must have exactly one source"
    paths = storm_paths
    window_start = int(time.time())
    incident_state = _disp.load_incident_state(paths)
    assert _collapse(
        paths,
        [
            _member("mm1", "host-a", "critical", "manifest window", window_start),
            _member("mm2", "host-b", "critical", "manifest window", window_start),
        ],
        window_start,
        incident_state,
    ) == 2
    digests = _digests(paths)
    assert len(digests) == 1
    fingerprint = digests[0]["storm"]["fingerprint"]

    # Literals, so a change to the helper is caught rather than followed.
    base_name = f"{window_start}.{fingerprint}.json"
    revision_name = f"{window_start}.{fingerprint}.v2.json"
    assert (paths["storm_manifests"] / base_name).exists(), "the base manifest name moved"
    assert helper(paths, fingerprint, window_start) == paths["storm_manifests"] / base_name
    assert helper(paths, fingerprint, window_start, 2) == paths["storm_manifests"] / revision_name

    _deliver(paths, _digest_paths(paths)[0])
    assert _collapse(
        paths,
        [_member("mm3", "host-c", "critical", "manifest window", window_start + 5)],
        window_start + 5,
        incident_state,
    ) == 1
    assert (paths["storm_manifests"] / revision_name).exists(), (
        "the superseding manifest name moved"
    )


# ---------------------------------------------------------------------------
# F7 -- the renderer must refuse a manifest path from a pre-upgrade digest
# ---------------------------------------------------------------------------

def test_f7_a_pre_upgrade_digest_renders_without_the_manifest_path(
    tmp_path, storm_paths, monkeypatch
):
    """RED at 93d9be77. The in-flight tail must not put a path on the page."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = int(time.time())
    incident_state = _disp.load_incident_state(paths)
    assert _collapse(
        paths,
        [
            _member("pu1", "host-a", "critical", "pre upgrade", window_start),
            _member("pu2", "host-b", "critical", "pre upgrade", window_start),
        ],
        window_start,
        incident_state,
    ) == 2
    digests = _digests(paths)
    assert len(digests) == 1
    digest = digests[0]
    fingerprint = digest["storm"]["fingerprint"]
    # A digest written by a dispatcher from before this change, still queued
    # across the upgrade, and delivered without a further absorb.
    stale_path = str(paths["storm_manifests"] / f"{window_start}.{fingerprint}.json")
    digest["storm"]["manifest"] = stale_path

    rendered = _disp.format_event(digest)
    assert fingerprint in rendered, "positive control: the page still carries the fingerprint"
    assert "storm_manifest" not in rendered, "the renderer must not print the manifest line"
    assert stale_path not in rendered, "the manifest path must not reach the operator page"
    assert str(paths["storm_manifests"]) not in rendered


# ---------------------------------------------------------------------------
# F8 -- one window writes exactly one receipt
# ---------------------------------------------------------------------------

def test_f8_one_window_writes_exactly_one_receipt(tmp_path, storm_paths, monkeypatch):
    """RED at base. I1 admits zero so it can pass at base; this pins the exact count.

    I1 is an INVARIANT and must pass where the receipt store does not exist, so
    its receipt assertion is `<= 1`. That is too weak to pin the behaviour once
    the store exists, so the exact count lives here instead of weakening I1.
    """
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = int(time.time())
    incident_state = _disp.load_incident_state(paths)
    assert _collapse(
        paths,
        [
            _member("ex1", "host-a", "critical", "exact window", window_start),
            _member("ex2", "host-b", "critical", "exact window", window_start),
        ],
        window_start,
        incident_state,
    ) == 2
    assert _collapse(
        paths,
        [_member("ex3", "host-c", "critical", "exact window", window_start + 10)],
        window_start + 10,
        incident_state,
    ) == 1
    receipts = _receipts(tmp_path)
    assert len(receipts) == 1, f"one window must produce exactly one receipt, got {len(receipts)}"
    assert len(_digests(paths)) == 1


# ---------------------------------------------------------------------------
# F9 -- the cap constant is read from the environment at import
# ---------------------------------------------------------------------------

_ENV_CAP_KEY = "BOT_ERRORS_STORM_RECEIPT_MAX_RECORDS"
_ENV_CAP_VALID = "3"
_ENV_CAP_ZERO = "0"
_ENV_CAP_MALFORMED = "not-a-number"


def _load_dispatcher(name: str):
    return dispatcher_fixtures.load_module_from_path(name, _DISPATCHER)


def test_f9_the_cap_environment_variable_is_read_at_import(monkeypatch):
    """RED at 93d9be77 only for the malformed and zero arms, which were unproven."""
    monkeypatch.setenv(_ENV_CAP_KEY, _ENV_CAP_VALID)
    configured = _load_dispatcher("bot_errors_dispatcher_storm_receipt_2387_env_ok")
    assert getattr(configured, "STORM_RECEIPT_MAX_RECORDS", None) == int(_ENV_CAP_VALID), (
        "the environment override must reach the constant"
    )

    # positive_env_int refuses both at import, so a bad value fails the process
    # at startup rather than silently reverting to the default.
    monkeypatch.setenv(_ENV_CAP_KEY, _ENV_CAP_ZERO)
    with pytest.raises(ValueError):
        _load_dispatcher("bot_errors_dispatcher_storm_receipt_2387_env_zero")
    monkeypatch.setenv(_ENV_CAP_KEY, _ENV_CAP_MALFORMED)
    with pytest.raises(ValueError):
        _load_dispatcher("bot_errors_dispatcher_storm_receipt_2387_env_bad")


# ---------------------------------------------------------------------------
# F10 -- different underlying sources, and duplicate delivery
# ---------------------------------------------------------------------------

_SECOND_UNDERLYING_SOURCE = "service-exit"


def test_f10_two_underlying_sources_in_one_window_are_two_identities(
    tmp_path, storm_paths, monkeypatch
):
    """RED at base. Two producers collapsing in one window must not merge."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = int(time.time())
    incident_state = _disp.load_incident_state(paths)

    health = [
        _member("sa1", "host-a", "critical", "same words", window_start),
        _member("sa2", "host-b", "critical", "same words", window_start),
    ]
    other = []
    for index, machine in enumerate(("host-c", "host-d")):
        member = _member(f"sb{index}", machine, "critical", "same words", window_start)
        member["source"] = _SECOND_UNDERLYING_SOURCE
        other.append(member)

    assert _collapse(paths, health, window_start, incident_state) == 2
    assert _collapse(paths, other, window_start, incident_state) == 2

    digests = _digests(paths)
    assert len(digests) == 2, f"expected two digests, got {len(digests)}"
    keys = [_disp.incident_key(digest) for digest in digests]
    assert len(set(keys)) == 2, f"two underlying sources must not share a key: {keys}"
    receipts = _receipts(tmp_path)
    assert len(receipts) == 2, f"expected two receipts, got {len(receipts)}"
    assert len({receipt["fingerprint"] for receipt in receipts}) == 2
    underlying = {
        line.split(":", 1)[1]
        for digest in digests
        for line in digest["evidence"].splitlines()
        if line.startswith("source:")
    }
    assert underlying == {"daily-health", _SECOND_UNDERLYING_SOURCE}


def test_f10b_invariant_duplicate_delivery_leaves_the_receipt_untouched(
    tmp_path, storm_paths, monkeypatch
):
    """INVARIANT. Delivering one digest twice must not open or rewrite anything."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = int(time.time())
    incident_state = _disp.load_incident_state(paths)
    assert _collapse(
        paths,
        [
            _member("dd1", "host-a", "critical", "duplicate delivery", window_start),
            _member("dd2", "host-b", "critical", "duplicate delivery", window_start),
        ],
        window_start,
        incident_state,
    ) == 2
    digests = _digests(paths)
    assert len(digests) == 1
    digest = digests[0]

    directory = _receipt_dir(tmp_path)
    before = (
        {path.name: path.read_bytes() for path in sorted(directory.glob("*.json"))}
        if directory.is_dir()
        else {}
    )
    state = _disp.load_incident_state(paths)
    _disp.mark_incident_sent(digest, state)
    _disp.mark_incident_sent(digest, state)
    after = (
        {path.name: path.read_bytes() for path in sorted(directory.glob("*.json"))}
        if directory.is_dir()
        else {}
    )
    assert after == before, "a duplicate delivery must not touch the receipt"
    assert len(state["openIncidents"]) == 1, "a duplicate delivery must not open a second record"
    record = state["openIncidents"][_disp.incident_key(digest)]
    assert record["renotifyCount"] == 1, "the second delivery is a renotify, not a new incident"


# ---------------------------------------------------------------------------
# Fix iteration 2. Everything below is RED at a20cf388 -- the commit the spec
# review bounced on the re-page loop -- except where a docstring says INVARIANT
# or FALSIFIER. Every symbol either exists at a20cf388 or is named by literal,
# so a failure there is an AssertionError and never an AttributeError.
# ---------------------------------------------------------------------------

_ORPHAN_INTENT_FIELD = "orphanPagedAtEpoch"
_SETTLEMENT_UNRECORDED = "storm_receipt_settlement_unrecorded"
_INTENT_UNRECORDED = "storm_receipt_orphan_intent_unrecorded"
_PAGE_ON_RECORD = "storm_receipt_orphan_page_on_record"
_LEDGER_DIRS = ("outbox", "processing", "sent", "suppressed", "quarantine")
_MALFORMED_PREFIX_SENTINEL = -1
_FAULT_CYCLES = 4


def _digest_incident_key(token: str) -> str:
    """The incident key a storm digest for `token` keys to."""
    return f"fleet|storm-collapse|storm-collapse.{token}"


def _orphan_incident_key(token: str) -> str:
    """The incident key the window-qualified orphan meta-alert keys to.

    Built from the same parts the dispatcher stamps on an event it emits itself,
    so this mirrors the real key rather than asserting against a copy of it.
    """
    machine = _disp.safe_segment(socket.gethostname())
    return f"{machine}|bot-errors-dispatcher|{_ORPHAN_SOURCE}.{token}"


def _lose_the_digest(paths: dict[str, Path]) -> int:
    """Remove every queued storm digest from all five ledger directories.

    The ledger form of the publication evidence has to be absent before an
    incident-record form can be shown to decide anything on its own.
    """
    removed = 0
    for key in _LEDGER_DIRS:
        directory = paths[key]
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.json")):
            if _STORM_SOURCE in path.name:
                path.unlink()
                removed += 1
    return removed


def _unpublished(state_dir: Path) -> list[dict[str, Any]]:
    return [record for record in _receipts(state_dir) if record["publishedAtEpoch"] is None]


def _owed_receipt(paths, tmp_path, monkeypatch, window_start: int, tag: str, ids):
    """Collapse one window whose digest publication dies, leaving its page owed.

    Returns the single receipt left unpublished, so a case can build a second
    owed window beside a settled one.
    """

    def _die(*args, **kwargs):
        raise _PublishFailure("the digest never reached the queue")

    monkeypatch.setattr(_disp, "publish_event_json", _die)
    with pytest.raises(_PublishFailure):
        _collapse(
            paths,
            [
                _member(ids[0], "host-a", "critical", tag, window_start),
                _member(ids[1], "host-b", "critical", tag, window_start),
            ],
            window_start,
            _disp.load_incident_state(paths),
        )
    monkeypatch.undo()
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    owed = _unpublished(tmp_path)
    assert len(owed) == 1, f"exactly one page must be owed, got {len(owed)}"
    _disp._storm_receipts_written.clear()
    return owed[0]


def _seed_open_incident(paths: dict[str, Path], key: str, entry: dict[str, Any]) -> None:
    """Persist one open-incident record, so the FILE reconcile reads carries it."""
    state = _disp.load_incident_state(paths)
    state.setdefault("openIncidents", {})[key] = entry
    _disp.require_all_advance([_disp.save_incident_state(paths, state)])
    reloaded = _disp.load_incident_state(paths)
    assert key in reloaded.get("openIncidents", {}), (
        f"the seeded incident record must survive the state validator: {key}"
    )


# ---------------------------------------------------------------------------
# F11, F12 -- R8: one orphan page per WINDOW, not one per source
# ---------------------------------------------------------------------------

def test_f11_two_orphaned_windows_page_under_two_incident_keys(
    tmp_path, storm_paths, monkeypatch
):
    """RED at a20cf388. One key for every orphan lets the renotify throttle
    absorb the second window's page while its receipt still records it paged."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    first_start = _closed_window_start()
    second_start = first_start - 5000

    _owed_receipt(paths, tmp_path, monkeypatch, first_start, "orphan one", ("w1a", "w1b"))
    _disp.reconcile_storm_digest_receipts(paths)
    _owed_receipt(paths, tmp_path, monkeypatch, second_start, "orphan two", ("w2a", "w2b"))
    _disp.reconcile_storm_digest_receipts(paths)

    orphans = _orphan_pages(paths)
    assert len(orphans) == 2, f"each orphaned window must page, got {len(orphans)}"
    keys = [_disp.incident_key(orphan) for orphan in orphans]
    assert len(set(keys)) == 2, (
        f"two orphaned windows must not share one incident key: {keys}"
    )
    for start in (first_start, second_start):
        naming = [key for key in keys if str(start) in key]
        assert len(naming) == 1, f"one key must name window {start}: {keys}"
    # The alert SOURCE is unchanged; only the incident identity moved.
    assert {orphan["source"] for orphan in orphans} == {_ORPHAN_SOURCE}
    assert len({orphan["id"] for orphan in orphans}) == 2, "each window pages under its own id"
    for orphan in orphans:
        assert "host-a" not in _disp.format_event(orphan), "no host name may appear"


def test_f12_an_orphan_pages_own_incident_record_is_not_publication_evidence(
    tmp_path, storm_paths, monkeypatch
):
    """RED at a20cf388, and it pins a path R8 CREATES rather than one it found.

    Window-qualifying the orphan alert makes its incident key end in the same
    window token the digest key ends in. An unanchored suffix test would then
    read the record left by a page reporting the digest MISSING as proof that
    digest published, and settle the very receipt the page was about. The
    positive control proves the digest key form still settles.
    """
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = _closed_window_start()
    record = _owed_receipt(
        paths, tmp_path, monkeypatch, window_start, "orphan evidence", ("v1", "v2")
    )
    token = record["receiptId"]
    assert _disp.find_event_path_by_id(token, paths, _LEDGER_DIRS) is None, (
        "the ledger form must be absent or this proves nothing"
    )

    _seed_open_incident(paths, _orphan_incident_key(token), {"status": "open", "openedAt": 1})
    _disp.reconcile_storm_digest_receipts(paths)

    by_id = {receipt["receiptId"]: receipt for receipt in _receipts(tmp_path)}
    assert by_id[token].get("settledReason") == _SETTLED_ORPHAN_PAGED, (
        "an orphan page's own incident record must not count as proof its digest published"
    )
    assert len(_orphan_pages(paths)) == 1, "the window still owed exactly one page"

    # Positive control: the DIGEST key form, a different window, still settles
    # without paging, so the assertion above is about the anchor and not about
    # the incident-record forms having stopped working.
    control_start = window_start - 7000
    control = _owed_receipt(
        paths, tmp_path, monkeypatch, control_start, "orphan control", ("v3", "v4")
    )
    _seed_open_incident(
        paths, _digest_incident_key(control["receiptId"]), {"status": "open", "openedAt": 1}
    )
    _disp.reconcile_storm_digest_receipts(paths)

    by_id = {receipt["receiptId"]: receipt for receipt in _receipts(tmp_path)}
    assert by_id[control["receiptId"]].get("settledReason") == _SETTLED_PUBLISHED_EVIDENCE, (
        "the digest key form must still settle its receipt without paging"
    )
    assert len(_orphan_pages(paths)) == 1, "the control window must not page"


# ---------------------------------------------------------------------------
# F13-F15, F20 -- R9 and spec MUST-1: one orphan page per window and revision
# ---------------------------------------------------------------------------

def test_f13_a_failing_settlement_write_pages_once_not_once_per_cycle(
    tmp_path, storm_paths, monkeypatch
):
    """RED at a20cf388: four reconcile calls, four pages. A store that accepts
    reads and refuses the settling write is the fault the spec review measured."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = _closed_window_start()
    _owed_receipt(paths, tmp_path, monkeypatch, window_start, "repage", ("p1", "p2"))

    real_publish = _disp.publish_storm_receipt

    def _refuse_the_settlement(path, receipt):
        if receipt.get("settledReason") is not None:
            raise OSError("the receipt store refuses the settling write")
        return real_publish(path, receipt)

    monkeypatch.setattr(_disp, "publish_storm_receipt", _refuse_the_settlement)
    for _cycle in range(_FAULT_CYCLES):
        _disp._storm_receipts_written.clear()
        _disp.reconcile_storm_digest_receipts(paths)

    orphans = _orphan_pages(paths)
    assert len(orphans) == 1, (
        f"{_FAULT_CYCLES} cycles against a refused settlement must page once, got {len(orphans)}"
    )
    owed = _receipts(tmp_path)
    assert len(owed) == 1
    assert owed[0]["publishedAtEpoch"] is None, "the settlement genuinely never landed"
    assert owed[0].get(_ORPHAN_INTENT_FIELD) is not None, (
        "the intent must be durable, or a page already sent cannot be told from one owed"
    )
    unrecorded = _records_of_type(paths, _SETTLEMENT_UNRECORDED)
    assert len(unrecorded) == _FAULT_CYCLES, (
        f"every lost settlement must be stated, got {len(unrecorded)}"
    )
    assert unrecorded[0]["details"]["orphanPaged"] is True
    on_record = _records_of_type(paths, _PAGE_ON_RECORD)
    assert len(on_record) == _FAULT_CYCLES - 1, (
        f"after the first cycle the page settles from the ledger, got {len(on_record)}"
    )


def test_f14_a_page_whose_intent_cannot_be_recorded_is_not_sent(
    tmp_path, storm_paths, monkeypatch
):
    """RED at a20cf388: four cycles, four pages. A store refusing EVERY write is
    the spec reviewer's literal probe. The intent write fails closed, so nothing
    pages at all rather than once per cycle with no record that it did."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = _closed_window_start()
    _owed_receipt(paths, tmp_path, monkeypatch, window_start, "intent", ("i1", "i2"))

    def _refuse_every_write(path, receipt):
        raise OSError("the receipt store refuses every write")

    monkeypatch.setattr(_disp, "publish_storm_receipt", _refuse_every_write)
    for _cycle in range(_FAULT_CYCLES):
        _disp._storm_receipts_written.clear()
        _disp.reconcile_storm_digest_receipts(paths)

    assert _orphan_pages(paths) == [], (
        "a page whose intent could not be recorded must not be sent"
    )
    refused = _records_of_type(paths, _INTENT_UNRECORDED)
    assert len(refused) == _FAULT_CYCLES, f"every refusal must be stated, got {len(refused)}"
    owed = _receipts(tmp_path)
    assert owed[0].get(_ORPHAN_INTENT_FIELD) is None, "no intent was ever recorded"
    assert owed[0]["publishedAtEpoch"] is None


def test_f15_a_recorded_intent_settles_from_the_page_already_on_record(
    tmp_path, storm_paths, monkeypatch
):
    """RED at a20cf388. The restart case: the page went out and the process died
    before the settlement. A second page would be a duplicate for one window."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = _closed_window_start()
    _owed_receipt(paths, tmp_path, monkeypatch, window_start, "restart", ("s1", "s2"))
    _disp.reconcile_storm_digest_receipts(paths)

    first = _receipts(tmp_path)
    assert len(_orphan_pages(paths)) == 1, "the first cycle pages once"
    assert first[0].get(_ORPHAN_INTENT_FIELD) is not None
    # The process died after the page and after the intent, before the settlement.
    _unpublish(_receipt_files(tmp_path)[0])
    _disp._storm_receipts_written.clear()

    for _cycle in range(_FAULT_CYCLES):
        _disp.reconcile_storm_digest_receipts(paths)

    assert len(_orphan_pages(paths)) == 1, (
        "a receipt carrying the intent must settle without a second page"
    )
    settled = _receipts(tmp_path)
    assert settled[0].get("settledReason") == _SETTLED_ORPHAN_PAGED
    assert settled[0]["publishedAtEpoch"] is not None
    assert len(_records_of_type(paths, _PAGE_ON_RECORD)) == 1, (
        "settling from a page already on record is logged as such"
    )


def test_f20_the_orphan_page_reports_the_adoption_that_produced_it(
    tmp_path, storm_paths, monkeypatch
):
    """RED at a20cf388. The page read the count before reconcile raised it, so it
    said 0 adoptions while the receipt it names said 1."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = _closed_window_start()
    _owed_receipt(paths, tmp_path, monkeypatch, window_start, "counted", ("c1", "c2"))
    _disp.reconcile_storm_digest_receipts(paths)

    orphans = _orphan_pages(paths)
    assert len(orphans) == 1
    settled = _receipts(tmp_path)[0]
    assert settled["adoptions"] == 1
    assert "receipt_adoptions:1" in orphans[0]["evidence"], (
        "the page and the receipt it names must agree on the adoption count"
    )


# ---------------------------------------------------------------------------
# F16 -- R10: each of the three publication-evidence forms decides on its own
# ---------------------------------------------------------------------------

def test_f16a_an_open_incident_key_for_the_window_settles_without_paging(
    tmp_path, storm_paths, monkeypatch
):
    """RED at a20cf388. Deleting both incident-record forms left 44 tests green.
    This is the form that decides once a digest has aged out of all five dirs."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = _closed_window_start()
    record = _owed_receipt(paths, tmp_path, monkeypatch, window_start, "keyform", ("k1", "k2"))
    token = record["receiptId"]
    assert _disp.find_event_path_by_id(token, paths, _LEDGER_DIRS) is None, (
        "the ledger form must be absent or this proves nothing"
    )

    _seed_open_incident(paths, _digest_incident_key(token), {"status": "open", "openedAt": 1})
    _disp.reconcile_storm_digest_receipts(paths)

    settled = _receipts(tmp_path)[0]
    assert settled.get("settledReason") == _SETTLED_PUBLISHED_EVIDENCE, (
        "an open incident keyed to this window is proof its page went out"
    )
    assert _orphan_pages(paths) == [], "evidence exists, so nothing may page"


def test_f16b_a_force_notify_level_for_the_window_settles_without_paging(
    tmp_path, storm_paths, monkeypatch
):
    """RED at a20cf388. The second incident-record form, on its own: the key
    below carries NO window token, so only the level can decide."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = _closed_window_start()
    record = _owed_receipt(paths, tmp_path, monkeypatch, window_start, "levelform", ("l1", "l2"))
    token = record["receiptId"]
    assert _disp.find_event_path_by_id(token, paths, _LEDGER_DIRS) is None, (
        "the ledger form must be absent or this proves nothing"
    )

    _seed_open_incident(
        paths,
        "fleet|storm-collapse|storm-collapse",
        {"status": "open", "openedAt": 1, "forceNotifyLevels": {token: 5}},
    )
    _disp.reconcile_storm_digest_receipts(paths)

    settled = _receipts(tmp_path)[0]
    assert settled.get("settledReason") == _SETTLED_PUBLISHED_EVIDENCE, (
        "a force-notify level naming this window is proof its page went out"
    )
    assert _orphan_pages(paths) == [], "evidence exists, so nothing may page"


def test_f16c_the_digest_in_the_ledger_settles_without_an_incident_record(
    tmp_path, storm_paths, monkeypatch
):
    """RED at 93d9be77, INVARIANT at a20cf388. The third form with the incident
    store empty, so the ledger lookup is the only thing that can decide."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = _closed_window_start()
    incident_state = _disp.load_incident_state(paths)
    assert _collapse(
        paths,
        [
            _member("d1", "host-a", "critical", "ledger form", window_start),
            _member("d2", "host-b", "critical", "ledger form", window_start),
        ],
        window_start,
        incident_state,
    ) == 2
    digest_paths = _digest_paths(paths)
    assert len(digest_paths) == 1
    _deliver(paths, digest_paths[0])
    _unpublish(_receipt_files(tmp_path)[0])
    _disp._storm_receipts_written.clear()

    assert not _disp.load_incident_state(paths).get("openIncidents"), (
        "no incident record may exist or this proves nothing"
    )
    _disp.reconcile_storm_digest_receipts(paths)

    settled = _receipts(tmp_path)[0]
    assert settled.get("settledReason") == _SETTLED_PUBLISHED_EVIDENCE
    assert _orphan_pages(paths) == [], "the digest is on record, so nothing may page"


def test_f16d_an_incident_record_never_settles_a_superseding_revision(
    tmp_path, storm_paths, monkeypatch
):
    """RED at a20cf388. Neutralising the revision guard left 29 tests green,
    because no case put an incident record carrying the token in front of a
    revision-2 receipt. This one does, and the window must still page."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = _closed_window_start()
    incident_state = _disp.load_incident_state(paths)
    assert _collapse(
        paths,
        [
            _member("r1", "host-a", "critical", "revision guard", window_start),
            _member("r2", "host-b", "critical", "revision guard", window_start),
        ],
        window_start,
        incident_state,
    ) == 2
    _deliver(paths, _digest_paths(paths)[0])

    def _die(*args, **kwargs):
        raise _PublishFailure("the superseding page never reached the queue")

    monkeypatch.setattr(_disp, "publish_event_json", _die)
    with pytest.raises(_PublishFailure):
        _collapse(
            paths,
            [_member("r3", "host-c", "critical", "revision guard", window_start + 5)],
            window_start + 5,
            incident_state,
        )
    monkeypatch.undo()
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)

    owed = _receipts(tmp_path)[0]
    assert owed.get("revision") == 2, "the superseding page must own the receipt"
    token = owed["receiptId"]
    assert _lose_the_digest(paths) >= 1, "the delivered first-revision digest must go"
    assert _disp.find_event_path_by_id(token, paths, _LEDGER_DIRS) is None
    assert _disp.find_event_path_by_id(f"{token}-v2", paths, _LEDGER_DIRS) is None

    # BOTH incident-record forms, together, naming this window.
    _seed_open_incident(
        paths,
        _digest_incident_key(token),
        {"status": "open", "openedAt": 1, "forceNotifyLevels": {token: 5}},
    )
    _disp._storm_receipts_written.clear()
    _disp.reconcile_storm_digest_receipts(paths)

    settled = _receipts(tmp_path)[0]
    assert settled.get("settledReason") == _SETTLED_ORPHAN_PAGED, (
        "revision 1 incident evidence must not settle revision 2"
    )
    assert len(_orphan_pages(paths)) == 1, "the lost superseding page must be reported"


def test_f17_run_once_settles_an_adopted_receipt_from_incident_state(
    tmp_path, storm_paths, monkeypatch
):
    """RED at a20cf388. Every other case calls reconcile directly, so nothing
    pinned the ordering the bare incident-state read depends on: reconcile takes
    no IncidentStateCycle and reads the FILE, which is correct only while it runs
    before every pass that mutates the in-memory payload. Driving the whole cycle
    with the settlement resting on the incident-record form pins that position."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = _closed_window_start()
    record = _owed_receipt(paths, tmp_path, monkeypatch, window_start, "cycle", ("y1", "y2"))
    token = record["receiptId"]
    assert _disp.find_event_path_by_id(token, paths, _LEDGER_DIRS) is None, (
        "the ledger form must be absent or the incident form decides nothing"
    )
    # The members the failed publication left behind are removed, so no
    # re-collapse inside the cycle can settle this receipt through the collapse
    # path. Reconciliation is then the only thing that can settle it, which is
    # what makes the assertion below about reconcile's position in the cycle.
    for leftover in sorted(paths["outbox"].glob("*.json")):
        leftover.unlink()
    _seed_open_incident(paths, _digest_incident_key(token), {"status": "open", "openedAt": 1})

    _disp.run_once(8)

    by_id = {receipt["receiptId"]: receipt for receipt in _receipts(tmp_path)}
    assert by_id[token].get("settledReason") == _SETTLED_PUBLISHED_EVIDENCE, (
        "a full cycle must settle the receipt from the incident record it reads"
    )
    assert _orphan_pages(paths) == [], "evidence exists, so the cycle must not page"


# ---------------------------------------------------------------------------
# F18 -- R11: the settled record describes the page the operator saw
# ---------------------------------------------------------------------------

def test_f18_the_absorb_refresh_rewrites_the_receipt_with_the_merged_counts(
    tmp_path, storm_paths, monkeypatch
):
    """RED at a20cf388. The absorb path acknowledged a receipt whose counts still
    described the FRESH publication, so the settled record named a page nobody
    was shown. FALSIFIER for the rewrite: remove it and the counts stay at two."""
    monkeypatch.setattr(_disp, "send_whatsapp", lambda text, *a, **k: None)
    paths = storm_paths
    window_start = int(time.time())
    incident_state = _disp.load_incident_state(paths)
    assert _collapse(
        paths,
        [
            _member("a1", "host-a", "critical", "absorb window", window_start),
            _member("a2", "host-b", "critical", "absorb window", window_start),
        ],
        window_start,
        incident_state,
    ) == 2
    fresh = _receipts(tmp_path)
    assert len(fresh) == 1
    assert fresh[0]["collapsedEvents"] == 2 and fresh[0]["affectedHosts"] == 2

    # The digest is still queued, so the late arrivals are absorbed into it.
    assert len(_digest_paths(paths)) == 1, "the digest must still be in flight"
    assert _collapse(
        paths,
        [
            _member("a3", "host-c", "critical", "absorb window", window_start + 1),
            _member("a4", "host-d", "critical", "absorb window", window_start + 2),
        ],
        window_start,
        incident_state,
    ) == 2

    merged = _receipts(tmp_path)
    assert len(merged) == 1, f"one window is one receipt, got {len(merged)}"
    assert merged[0]["affectedHosts"] == 4, (
        f"the settled receipt must describe the refreshed page, got {merged[0]['affectedHosts']} hosts"
    )
    assert merged[0]["collapsedEvents"] == 4, (
        f"the settled receipt must count what the refresh published, got {merged[0]['collapsedEvents']}"
    )
    assert merged[0]["publishedAtEpoch"] is not None, "the refreshed page is proven published"
    assert merged[0].get("settledReason") == _SETTLED_PUBLICATION_PROVEN
    digest = _digests(paths)[0]
    assert digest["storm"]["affectedHosts"] == 4, "the receipt must match the digest it guards"


# ---------------------------------------------------------------------------
# F19, F21 -- folded nits, each with its own falsifier
# ---------------------------------------------------------------------------

def test_f19_a_malformed_fingerprint_is_not_an_all_zero_prefix(tmp_path, storm_paths):
    """RED at a20cf388. Both reached the log as 0, which is the ambiguity the
    field exists to remove: a genuine all-zero prefix and a damaged one."""
    genuine = _disp.storm_fingerprint_prefix("0000000000000000")
    malformed = _disp.storm_fingerprint_prefix("not-hex-at-all")
    assert genuine == 0, "a genuine all-zero prefix is still zero"
    assert malformed == _MALFORMED_PREFIX_SENTINEL, (
        f"a malformed fingerprint must be distinguishable, got {malformed}"
    )
    # The projection admits it: negatives are clamped into the signed 53-bit
    # range, not dropped. Proved through the real log, not by reading the range.
    _disp.append_dispatch_log(storm_paths, {
        "type": "storm_receipt_evicted",
        "windowStartEpoch": 1,
        "fingerprintPrefix": malformed,
        "cap": 1,
    })
    logged = _records_of_type(storm_paths, "storm_receipt_evicted")
    assert logged[-1]["details"]["fingerprintPrefix"] == _MALFORMED_PREFIX_SENTINEL, (
        "the sentinel must survive the controller-log projection"
    )


_RESERVED_DAMAGED_ID = "storm-00112233445566aa-1700000000"
_KEEPER_DAMAGED_ID = "storm-00112233445566bb-1700000001"


def test_f21_an_unreadable_reserved_slot_is_counted_once_and_frees_its_ledger_id(
    tmp_path, storm_paths, monkeypatch
):
    """RED at a20cf388. Two defects in one census: the reserved slot was counted
    twice when its own file was damaged, and an unreadable eviction discarded a
    FILENAME where the ledger holds a receipt id, so the id was never released."""
    monkeypatch.setattr(_disp, "STORM_RECEIPT_MAX_RECORDS", 2, raising=False)
    paths = storm_paths
    directory = _receipt_dir(tmp_path)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{_RESERVED_DAMAGED_ID}.json").write_text("{not json", encoding="utf-8")
    (directory / f"{_KEEPER_DAMAGED_ID}.json").write_text("{also not json", encoding="utf-8")
    _disp._storm_receipts_written.add(_RESERVED_DAMAGED_ID)
    _disp._storm_receipts_written.add(_KEEPER_DAMAGED_ID)

    dropped = _disp.enforce_storm_receipt_cap(paths, reserve_id=_RESERVED_DAMAGED_ID)

    assert dropped == [], f"two entries under a cap of two must evict nothing, got {dropped}"
    assert (directory / f"{_KEEPER_DAMAGED_ID}.json").exists(), (
        "double-counting the reserved slot evicted a file the bound had room for"
    )

    # Now force one real eviction and prove the ledger ID goes, not the filename.
    monkeypatch.setattr(_disp, "STORM_RECEIPT_MAX_RECORDS", 1, raising=False)
    _disp.enforce_storm_receipt_cap(paths, reserve_id=_RESERVED_DAMAGED_ID)
    assert not (directory / f"{_KEEPER_DAMAGED_ID}.json").exists(), "the bound must be enforced"
    assert _KEEPER_DAMAGED_ID not in _disp._storm_receipts_written, (
        "an unreadable eviction must release the receipt id, not a filename"
    )
