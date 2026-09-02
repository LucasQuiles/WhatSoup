"""Dispatcher-side contract tests for legacy confined alert content (#2386).

Red-first. The dispatcher is a pure consumer: it cannot recover the tokens the
producer's confinement boundary destroyed, but it must stop rendering the
confinement envelope as a Python dict repr, stop baking that repr into escalation
prefixes and persisted incident state, keep storm grouping working across hosts,
count the legacy forms it sees, and quarantine a mapping it has no safe way to
render.

All fixtures are synthetic.
"""

from __future__ import annotations

import ast
import importlib.util
import json
import os
import sys
import time
from pathlib import Path
from typing import Any
from unittest.mock import patch

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"

BRACE_QUOTE = "{" + chr(39)   # the "{'" prefix of a baked dict repr
DIGEST = "a1b2c3d4" + "e5f60789" * 7
CANONICAL = "TypeError - 54 chars - digest a1b2c3d4"
REPR_ALPHABETICAL = (
    "{'correlationDigest': '" + DIGEST + "', 'failureClass': 'TypeError', 'length': 54}"
)
REPR_FAILURE_CLASS_FIRST = (
    "{'failureClass': 'TypeError', 'length': 54, 'correlationDigest': '" + DIGEST + "'}"
)


def _load_module(extra_env: dict[str, str] | None = None):
    env_backup: dict[str, str | None] = {}
    if extra_env:
        for k, v in extra_env.items():
            env_backup[k] = os.environ.get(k)
            os.environ[k] = v
    try:
        spec = importlib.util.spec_from_file_location("bot_errors_dispatcher", _SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)
        return mod
    finally:
        if extra_env:
            for k, orig in env_backup.items():
                if orig is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = orig


_mod = _load_module()


def legacy_object() -> dict[str, Any]:
    return {"failureClass": "TypeError", "length": 54, "correlationDigest": DIGEST}


def _make_event(**kwargs: Any) -> dict[str, Any]:
    base = {
        "schemaVersion": 2,
        "eventKind": "incident_alert",
        "eventType": "alert",
        "severity": "critical",
        "id": "evt-fixture-001",
        "source": "primary_model_unusable",
        "summary": legacy_object(),
        "evidence": legacy_object(),
        "machine": "fixture-host-a",
        "instance": "fixture-bot",
        "createdAt": "2026-09-01T00:00:00.000Z",
    }
    base.update(kwargs)
    return base


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def test_format_event_renders_legacy_object_summary_readably() -> None:
    text = _mod.format_event(_make_event())
    assert CANONICAL in text
    assert "correlationDigest" not in text
    assert BRACE_QUOTE not in text


def test_format_event_renders_baked_repr_summary_readably() -> None:
    event = _make_event(summary=REPR_ALPHABETICAL, evidence=REPR_FAILURE_CLASS_FIRST)
    text = _mod.format_event(event)
    assert "correlationDigest" not in text
    assert BRACE_QUOTE not in text


# ---------------------------------------------------------------------------
# Escalation prefixes must never bake a repr
# ---------------------------------------------------------------------------

def test_escalation_prefix_does_not_bake_repr() -> None:
    event = _make_event()
    record: dict[str, Any] = {"openedAt": 0, "physicalCandidateCount": 0}
    _mod.append_still_open_context(
        event, record, "fixture|key|primary_model_unusable", 1000, 3,
        escalated=True, digest=False,
    )
    assert event["summary"].startswith("ESCALATED still open: ")
    assert BRACE_QUOTE not in event["summary"]
    assert "correlationDigest" not in event["summary"]
    assert BRACE_QUOTE not in event["evidence"]
    assert CANONICAL in event["summary"]


def test_escalation_is_idempotent_against_canonical_summary() -> None:
    """The idempotence guards read the rendered text, so a second pass must not
    stack a second prefix."""
    event = _make_event()
    record: dict[str, Any] = {"openedAt": 0, "physicalCandidateCount": 0}
    key = "fixture|key|primary_model_unusable"
    _mod.append_still_open_context(event, record, key, 1000, 3, escalated=True, digest=False)
    first = event["summary"]
    _mod.append_still_open_context(event, record, key, 1000, 4, escalated=True, digest=False)
    assert event["summary"].count("ESCALATED still open:") == 1
    assert event["summary"] == first


def test_second_append_path_does_not_bake_repr() -> None:
    """append_clear_context is the second site that concatenates onto evidence."""
    event = _make_event(
        eventKind="incident_recovery", eventType="clear", severity="info",
        evidence=legacy_object(),
    )
    # append_clear_context returns early unless an open incident exists.
    incident_state = {
        "openIncidents": {
            _mod.incident_key(event): {
                "openedIso": "2026-09-01T00:00:00Z",
                "eventId": "evt-fixture-000",
                "suppressedCount": 2,
                "lastSeenIso": "2026-09-01T00:00:00Z",
            }
        }
    }
    _mod.append_clear_context(event, incident_state)
    assert isinstance(event["evidence"], str)
    assert "suppressed_duplicates=2" in event["evidence"], "the append path must have run"
    assert CANONICAL in event["evidence"]
    assert BRACE_QUOTE not in event["evidence"]
    assert "correlationDigest" not in event["evidence"]


# ---------------------------------------------------------------------------
# Persisted incident state
# ---------------------------------------------------------------------------

def test_persisted_last_summary_is_canonical_string() -> None:
    event = _make_event()
    incident_state: dict[str, Any] = {}
    _mod.mark_incident_sent(event, incident_state)
    records = incident_state.get("openIncidents") or {}
    assert records, "an alert must open an incident record"
    record = next(iter(records.values()))
    assert record["lastSummary"] == CANONICAL
    assert record["lastEvidence"] == CANONICAL
    assert BRACE_QUOTE not in record["lastSummary"]


def test_persisted_state_read_renders_historical_repr() -> None:
    """Rows already carrying a baked repr must render, including prefixed rows.

    stale_incident_event builds its title from record["lastSummary"], which is
    exactly where the recapture found persisted reprs.
    """
    record = {
        "lastSummary": "ESCALATED still open: " + REPR_ALPHABETICAL,
        "openedAt": 0,
        "lastSeenAt": 0,
        "status": "open",
    }
    rendered = _mod.alert_text(record.get("lastSummary"))
    assert rendered == "ESCALATED still open: " + CANONICAL
    assert BRACE_QUOTE not in rendered


def test_awaiting_physical_evidence_is_stored_readably() -> None:
    """physicalCandidateLastEvidence is one of the persisted fields the recapture
    found carrying the defect."""
    event = _make_event(
        source="whatsapp_device_bond_lost",
        evidence="classification: physical_intervention_required linked-device bond lost",
    )
    record: dict[str, Any] = {}
    _mod.update_awaiting_physical_tracking(event, record, 1000)
    assert BRACE_QUOTE not in record.get("physicalCandidateLastEvidence", "")

    repr_event = _make_event(
        source="whatsapp_device_bond_lost",
        evidence=(
            "classification: physical_intervention_required linked-device bond lost "
            + REPR_ALPHABETICAL
        ),
    )
    repr_record: dict[str, Any] = {}
    _mod.update_awaiting_physical_tracking(repr_event, repr_record, 1000)
    stored = repr_record.get("physicalCandidateLastEvidence", "")
    assert stored, "the physical-candidate path must have stored evidence"
    assert BRACE_QUOTE not in stored
    assert "correlationDigest" not in stored


# ---------------------------------------------------------------------------
# Storm grouping
# ---------------------------------------------------------------------------

def test_confined_storm_collapse_depends_on_digest_equality_not_host_normalization() -> None:
    """PINS A LIMITATION THIS CHANGE DOES NOT REPAIR.

    The design expected PR-A to restore cross-host storm collapse. It does not, and
    this test exists so nobody merges believing otherwise.

    normalized_summary replaces host tokens with a {host} placeholder so two hosts'
    summaries normalise together. A canonical confined summary contains NO host
    token, so that substitution is permanently inert for confined events. What
    remains is failureClass, length and an 8-hex digest prefix, and both length and
    digest derive from the RAW content the producer confined. Two hosts therefore
    collapse only when their raw summaries were byte-identical to begin with, not
    because the consumer normalised anything.

    Cross-host collapse for confined events returns only when the producer ships a
    typed diagnostic field and the grouping sites read it.
    """
    same_digest_a = _make_event(machine="fixture-host-a", instance="fixture-bot")
    same_digest_b = _make_event(machine="fixture-host-b", instance="fixture-bot")
    assert _mod.storm_fingerprint(same_digest_a) == _mod.storm_fingerprint(same_digest_b)

    # The load-bearing half: different raw content on two hosts yields a different
    # digest, the fingerprints diverge, and collapse does not fire. Host
    # normalisation cannot rescue it. That is the unrepaired limitation.
    other = dict(legacy_object())
    other["correlationDigest"] = "b2c3d4e5" + "f6a70891" * 7
    differing = _make_event(
        machine="fixture-host-b", instance="fixture-bot",
        summary=other, evidence=other,
    )
    assert _mod.storm_fingerprint(same_digest_a) != _mod.storm_fingerprint(differing), (
        "if this ever passes, cross-host collapse for confined events was repaired "
        "and this limitation test should be replaced by a real collapse test"
    )

    # What this change DOES deliver: a readable fingerprint, not a baked repr.
    assert BRACE_QUOTE not in _mod.storm_fingerprint(same_digest_a)
    assert "correlationdigest" not in _mod.storm_fingerprint(same_digest_a).lower()

def test_recovery_normalized_summary_matches_across_forms() -> None:
    """Alert/recovery pairing must match whether the producer sent the mapping or
    the baked repr."""
    as_object = _make_event(summary=legacy_object())
    as_repr = _make_event(summary=REPR_FAILURE_CLASS_FIRST)
    assert _mod.recovery_normalized_summary(as_object) == _mod.recovery_normalized_summary(as_repr)
    # And against the OTHER key order, which a matcher pinned to one order misses.
    as_alt_repr = _make_event(summary=REPR_ALPHABETICAL)
    assert _mod.recovery_normalized_summary(as_object) == _mod.recovery_normalized_summary(as_alt_repr)
    assert BRACE_QUOTE not in _mod.recovery_normalized_summary(as_object)


# ---------------------------------------------------------------------------
# Telemetry
# ---------------------------------------------------------------------------

def test_telemetry_counts_object_and_repr_separately() -> None:
    """One event can carry both forms. Each counter increments at most once, and
    the two are never summed."""
    event = _make_event(summary=legacy_object(), evidence=REPR_ALPHABETICAL)
    incident_state: dict[str, Any] = {}
    _mod.record_legacy_alert_content(event, incident_state)
    counters = incident_state["legacyAlertContent"]
    assert counters["queueLegacyObject"] == 1
    assert counters["queueBakedRepr"] == 1
    assert counters["queueUnrenderable"] == 0
    assert counters["lastLegacySource"] == "primary_model_unusable"
    assert counters["lastLegacyIso"]
    assert counters["lastLegacyAt"] > 0


def test_telemetry_counts_one_per_counter_per_event() -> None:
    """Both fields carrying the SAME form still increments that counter once."""
    event = _make_event(summary=legacy_object(), evidence=legacy_object())
    incident_state: dict[str, Any] = {}
    _mod.record_legacy_alert_content(event, incident_state)
    counters = incident_state["legacyAlertContent"]
    assert counters["queueLegacyObject"] == 1
    assert counters["queueBakedRepr"] == 0


def test_telemetry_does_not_count_plain_strings() -> None:
    event = _make_event(summary="plain operator text", evidence="more operator text")
    incident_state: dict[str, Any] = {}
    _mod.record_legacy_alert_content(event, incident_state)
    counters = incident_state.get("legacyAlertContent", {})
    assert counters.get("queueLegacyObject", 0) == 0
    assert counters.get("queueBakedRepr", 0) == 0
    assert counters.get("queueUnrenderable", 0) == 0


def test_telemetry_accumulates_across_events() -> None:
    incident_state: dict[str, Any] = {}
    _mod.record_legacy_alert_content(_make_event(summary=legacy_object(), evidence=""), incident_state)
    _mod.record_legacy_alert_content(_make_event(summary=legacy_object(), evidence=""), incident_state)
    assert incident_state["legacyAlertContent"]["queueLegacyObject"] == 2


# ---------------------------------------------------------------------------
# Quarantine
# ---------------------------------------------------------------------------

def test_unrenderable_mapping_event_is_quarantined(tmp_path: Path) -> None:
    outbox = tmp_path / "outbox"
    quarantine = tmp_path / "quarantine"
    outbox.mkdir(mode=0o700)
    quarantine.mkdir(mode=0o700)
    event = _make_event(summary={"failureClass": "TypeError", "note": "unexpected"})
    path = outbox / "evt-fixture-001.json"
    path.write_text(json.dumps(event), encoding="utf-8")

    assert _mod.load_valid_event_or_quarantine(path, quarantine) is None
    landed = list(quarantine.iterdir())
    assert len(landed) == 1
    assert "unrenderable_alert_content" in landed[0].name


def test_legacy_shaped_mapping_event_is_not_quarantined(tmp_path: Path) -> None:
    outbox = tmp_path / "outbox"
    quarantine = tmp_path / "quarantine"
    outbox.mkdir(mode=0o700)
    quarantine.mkdir(mode=0o700)
    path = outbox / "evt-fixture-002.json"
    path.write_text(json.dumps(_make_event()), encoding="utf-8")

    assert _mod.load_valid_event_or_quarantine(path, quarantine) is not None
    assert list(quarantine.iterdir()) == []


# ---------------------------------------------------------------------------
# Blast-radius guard
# ---------------------------------------------------------------------------

def test_truncate_still_stringifies_raw_error() -> None:
    """truncate is the shared primitive; funnelling it through alert_text would
    replace operator-visible error text with the sentinel."""
    class FixtureError(Exception):
        def __str__(self) -> str:
            return "fixture transport failure"

    assert _mod.truncate(FixtureError(), 200) == "fixture transport failure"
    assert _mod.truncate({"unexpected": "mapping"}, 200) == "{'unexpected': 'mapping'}"
    assert _mod.truncate(None, 200) == ""
    assert "[unrenderable alert content]" not in _mod.truncate({"a": 1}, 200)


def test_manifest_entry_renders_legacy_content() -> None:
    event = _make_event()
    entry = _mod.manifest_entry(Path("/fixture/outbox/evt-fixture-001.json"), event)
    assert BRACE_QUOTE not in entry["summary"]
    assert BRACE_QUOTE not in entry["evidence"]
    assert CANONICAL in entry["summary"]


def test_dead_letter_crumb_summary_renders_in_the_emitted_meta_alert(tmp_path, monkeypatch) -> None:
    """Drives queue_dead_letter_meta_alert, where the raw read actually lived.

    A dead-letter crumb is a persisted artifact and can carry the legacy form, and
    the meta-alert built from it is a NEWLY MINTED event, so an unrouted read here
    re-creates the defect downstream of every other fix in this change. Asserting on
    the emitted payload is what makes this test fail when the read is reverted.
    """
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path / "state"))
    mod = _load_module()
    paths = mod.setup_dirs()

    crumb = {
        "event": {
            "id": "dead-evt-fixture-001",
            "source": "primary_model_unusable",
            "summary": legacy_object(),
            "createdAt": "2026-09-01T00:00:00Z",
        },
        "delivery": {"status": "dead_letter", "attempts": 10},
        "terminated_at": "2026-09-01T01:00:00Z",
    }
    crumb_path = paths["dead_letter"] / "20260901010000.dead-evt-fixture-001.json"
    crumb_path.write_text(json.dumps(crumb, indent=2, sort_keys=True) + chr(10), encoding="utf-8")
    crumb_path.chmod(0o600)

    with patch.object(mod, "append_dispatch_log"), \
         patch.object(mod, "read_meta_state", return_value={}):
        count = mod.queue_dead_letter_meta_alert(paths, int(time.time()))

    assert count == 1, "the meta-alert must fire for a non-empty dead-letter dir"
    queued = sorted(paths["outbox"].glob("*.json"))
    assert len(queued) == 1
    payload = json.loads(queued[0].read_text(encoding="utf-8"))
    assert payload["source"] == "meta_alert_dead_letter"
    evidence = payload["evidence"]
    assert "oldest_summary=" in evidence, "the crumb summary must reach the meta-alert"
    assert CANONICAL in evidence
    assert BRACE_QUOTE not in evidence
    assert "correlationDigest" not in evidence

ALERT_CONTENT_FIELDS = frozenset({
    # live event fields
    "summary", "evidence",
    # the seven persisted incident-state fields the prevalence recapture found
    # carrying the legacy form
    "lastSummary", "lastEvidence", "physicalCandidateLastEvidence",
    "lastSuppressedClearSummary", "lastSuppressedSymptomEvidence",
    "lastSuppressedSymptomSummary",
})
ALERT_CONTENT_ROUTERS = frozenset({"alert_text", "event_text", "alert_text_kind"})


def _unrouted_alert_content_reads(source: str) -> list[tuple[int, str, str, str]]:
    """Every alert-content READ in the dispatcher that is not routed through the funnel.

    AST-based, so it sees the read regardless of how it is spelled: single or
    double quotes, a two-argument ``.get(field, default)``, a bare ``.get(field)``
    with no ``str()`` around it, or a subscript. Writes are excluded by requiring a
    Load context, so ``event["summary"] = ...`` is correctly not a read.
    """
    tree = ast.parse(source)
    lines = source.splitlines()
    parent: dict[ast.AST, ast.AST] = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parent[child] = node

    def enclosing_function(node: ast.AST) -> str:
        current = parent.get(node)
        while current is not None and not isinstance(current, ast.FunctionDef):
            current = parent.get(current)
        return current.name if current is not None else "<module>"

    def is_routed(node: ast.AST) -> bool:
        current = parent.get(node)
        hops = 0
        while current is not None and hops < 4:
            if (
                isinstance(current, ast.Call)
                and isinstance(current.func, ast.Name)
                and current.func.id in ALERT_CONTENT_ROUTERS
            ):
                return True
            current = parent.get(current)
            hops += 1
        return False

    found: list[tuple[int, str, str, str]] = []
    for node in ast.walk(tree):
        field = None
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "get"
            and node.args
            and isinstance(node.args[0], ast.Constant)
            and node.args[0].value in ALERT_CONTENT_FIELDS
        ):
            field = node.args[0].value
        elif (
            isinstance(node, ast.Subscript)
            and isinstance(node.ctx, ast.Load)
            and isinstance(node.slice, ast.Constant)
            and node.slice.value in ALERT_CONTENT_FIELDS
        ):
            field = node.slice.value
        if field is None:
            continue
        function = enclosing_function(node)
        if function in ALERT_CONTENT_ROUTERS or is_routed(node):
            continue
        found.append((node.lineno, field, function, lines[node.lineno - 1].strip()))
    return found


def test_no_unrouted_alert_content_reads_remain_in_dispatcher() -> None:
    """Coverage assertion over every alert-content read in the dispatcher.

    Per-site tests can only prove the sites someone thought to enumerate. This is
    what catches a site nobody listed, which is exactly how the dead-letter crumb
    read was found. It is AST-based rather than text-based on purpose: a text scan
    keyed to one idiom silently misses a bare `.get("summary")`, a two-argument
    `.get(field, default)`, single quotes, and subscript reads.

    There is no allowlist, because at HEAD there is nothing to allow: `truncate`
    and `redact` take their arguments from elsewhere and never read these fields
    themselves, which is why they can stay outside the funnel. If a future change
    needs an exemption, add it here explicitly with a reason rather than loosening
    the scan.
    """
    unrouted = _unrouted_alert_content_reads(_SCRIPT.read_text(encoding="utf-8"))
    assert not unrouted, "alert-content reads must go through event_text/alert_text:\n" + "\n".join(
        f"  line {line} [{field}] in {function}: {text}" for line, field, function, text in unrouted
    )


def test_the_coverage_scan_actually_catches_a_reverted_site() -> None:
    """Guards the guard.

    A coverage assertion that cannot fail is worse than none, because it reads as
    proof. This reverts each routed site in memory and requires the scan to flag
    it. The email-fallback subject is included here deliberately: its live branch
    sits behind a provenance gate that refuses email for a dispatcher rooted in a
    test directory, so it has structural coverage only, and this is what holds it.
    """
    source = _SCRIPT.read_text(encoding="utf-8")
    reverts = [
        (
            "email fallback subject",
            "{event_text(event, 'summary') or 'unknown'}",
            "{event.get('summary', 'unknown')}",
        ),
        (
            "format_event summary",
            'redact(event_text(event, "summary") or "unspecified bot error")',
            'redact(event.get("summary") or "unspecified bot error")',
        ),
        (
            "format_event evidence",
            'event_line("evidence", event_text(event, "evidence"), 1800)',
            'event_line("evidence", event.get("evidence"), 1800)',
        ),
        (
            "dead-letter crumb",
            'alert_text(crumb.get("event", {}).get("summary") or "")',
            'str(crumb.get("event", {}).get("summary") or "")',
        ),
        (
            "persisted lastSummary",
            'redacted_state_text(event_text(event, "summary"), 500)',
            'redacted_state_text(event.get("summary"), 500)',
        ),
    ]
    assert not _unrouted_alert_content_reads(source), "HEAD must start clean"
    for name, routed, raw in reverts:
        assert routed in source, f"routed form for {name} not found; update this test"
        mutated = source.replace(routed, raw, 1)
        assert _unrouted_alert_content_reads(mutated), (
            f"the coverage scan failed to catch a reverted {name}"
        )
def test_absorb_daily_health_signal_counts_legacy_alert_content() -> None:
    """The shared terminal-path helper is where counting has to happen."""
    event = _make_event(summary=legacy_object(), evidence=REPR_ALPHABETICAL)
    incident_state: dict[str, Any] = {}
    _mod.absorb_daily_health_signal(event, incident_state)
    counters = incident_state.get("legacyAlertContent") or {}
    assert counters.get("queueLegacyObject") == 1
    assert counters.get("queueBakedRepr") == 1


def test_storm_collapsed_member_is_counted_once_per_member() -> None:
    """collapse_storm_group calls the shared helper once per collapsed member.

    Driving the helper the way that loop does must count each member exactly once,
    so a collapsed population cannot read zero.
    """
    incident_state: dict[str, Any] = {}
    members = [
        _make_event(id="evt-fixture-a", summary=legacy_object(), evidence=""),
        _make_event(id="evt-fixture-b", summary=legacy_object(), evidence=""),
    ]
    for member in members:
        _mod.absorb_daily_health_signal(member, incident_state)
    assert incident_state["legacyAlertContent"]["queueLegacyObject"] == 2


def test_plain_string_event_does_not_create_a_telemetry_block() -> None:
    """The shared helper runs for EVERY event, so it must stay silent on clean ones."""
    event = _make_event(summary="plain operator text", evidence="more operator text")
    incident_state: dict[str, Any] = {}
    _mod.absorb_daily_health_signal(event, incident_state)
    assert "legacyAlertContent" not in incident_state


def test_legacy_counter_has_exactly_one_call_site_and_it_is_the_shared_helper() -> None:
    """Structural guard against the counter drifting back to a single path.

    If a later change re-adds a per-path call, one event consumed by process_one
    would count twice; if the shared call is removed, three terminal paths stop
    counting. Pin both by asserting the single call site and its parent.
    """
    import ast as _ast

    tree = _ast.parse(_SCRIPT.read_text(encoding="utf-8"))
    parents: list[str] = []
    for node in _ast.walk(tree):
        if not isinstance(node, _ast.FunctionDef):
            continue
        for inner in _ast.walk(node):
            if (
                isinstance(inner, _ast.Call)
                and isinstance(inner.func, _ast.Name)
                and inner.func.id == "record_legacy_alert_content"
            ):
                parents.append(node.name)
    assert parents == ["absorb_daily_health_signal"], (
        "record_legacy_alert_content must be called exactly once, from the shared "
        f"terminal-path helper; found call sites in {parents}"
    )
