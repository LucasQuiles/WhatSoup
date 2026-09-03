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
import re
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
    # Absence alone would accept the unrenderable sentinel or empty output, which
    # are regressions, not fixes. Assert the rendering that is actually wanted.
    assert CANONICAL in text
    # Derived from the code under test rather than a duplicated literal.
    sentinel = _mod.alert_text({"not": "renderable"})
    assert sentinel not in text
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
    # Without this the assertion below passes on the early-return path, where
    # nothing was stored at all and the default "" trivially contains no repr.
    assert "physicalCandidateLastEvidence" in record, (
        "the physical-candidate path must have stored evidence"
    )
    assert BRACE_QUOTE not in record["physicalCandidateLastEvidence"]

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
    # SAME 8-char prefix, different tail. With identity on the display digest this
    # pair collided; with the full digest they stay distinct. A pair differing at
    # character zero would pass even with a 1-character digest and prove nothing.
    other = dict(legacy_object())
    other["correlationDigest"] = DIGEST[:8] + "9" * 56
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
ALERT_CONTENT_ROUTERS = frozenset({
    "alert_text", "event_text", "alert_text_kind",
    # Without these two a direct .get() regression INSIDE them is invisible to
    # the scan, which is exactly where such a regression would hide.
    "alert_text_for_fingerprint", "event_fingerprint_text", "legacy_confined_to_text",
})


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
        # NO blanket skip for reads inside the router helpers themselves. Skipping
        # them hid a direct read inside the funnel, which is exactly where such a
        # regression would sit. Verified: without the skip, HEAD is still clean.
        if is_routed(node):
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

    Reads inside the router helpers are NOT exempt either: those helpers read via a
    variable field name, so an added constant-key read there is a regression and is
    reported like any other.
    """
    unrouted = _unrouted_alert_content_reads(_SCRIPT.read_text(encoding="utf-8"))
    assert not unrouted, "alert-content reads must go through event_text/alert_text:\n" + "\n".join(
        f"  line {line} [{field}] in {function}: {text}" for line, field, function, text in unrouted
    )


def test_the_coverage_scan_catches_a_direct_read_inside_a_router_helper() -> None:
    """A regression hiding INSIDE the funnel must not be invisible.

    The scan used to skip every read whose enclosing function was a router, so a
    direct constant-key read added to one of those helpers passed silently. The
    helpers legitimately read via a VARIABLE field name, so nothing is lost by
    scanning them, and HEAD stays clean.
    """
    source = _SCRIPT.read_text(encoding="utf-8")
    assert not _unrouted_alert_content_reads(source), "HEAD must start clean"
    routed_call = '    return alert_text_for_fingerprint(event.get(key) or "")'
    assert routed_call in source, "the fingerprint helper's shape changed; update this test"
    mutated = source.replace(
        routed_call,
        '    _leak = event.get("summary")\n' + routed_call,
        1,
    )
    found = _unrouted_alert_content_reads(mutated)
    assert found, "a direct read inside a router helper must be reported"
    assert any(entry[2] == "event_fingerprint_text" for entry in found), found


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
def test_the_recorder_not_absorb_is_what_counts() -> None:
    """The count moved OUT of absorb_daily_health_signal, deliberately.

    Recording inside absorb looked like the shared-call-site fix, but two of the
    four terminal paths call absorb only for daily-health sources, so a non-daily
    legacy event was never counted there. The recorder is now called directly by
    each terminal path, outside any source guard.
    """
    event = _make_event(summary=legacy_object(), evidence=REPR_ALPHABETICAL)
    via_absorb: dict[str, Any] = {}
    _mod.absorb_daily_health_signal(event, via_absorb)
    assert "legacyAlertContent" not in via_absorb

    via_recorder: dict[str, Any] = {}
    assert _mod.record_legacy_alert_content(event, via_recorder) is True
    counters = via_recorder["legacyAlertContent"]
    assert counters["queueLegacyObject"] == 1
    assert counters["queueBakedRepr"] == 1

def test_storm_collapsed_member_is_counted_once_per_member() -> None:
    """collapse_storm_group calls the recorder once per collapsed member."""
    incident_state: dict[str, Any] = {}
    members = [
        _make_event(id="evt-fixture-a", summary=legacy_object(), evidence=""),
        _make_event(id="evt-fixture-b", summary=legacy_object(), evidence=""),
    ]
    for member in members:
        assert _mod.record_legacy_alert_content(member, incident_state) is True
    assert incident_state["legacyAlertContent"]["queueLegacyObject"] == 2

def test_plain_string_event_does_not_create_a_telemetry_block() -> None:
    """The shared helper runs for EVERY event, so it must stay silent on clean ones."""
    event = _make_event(summary="plain operator text", evidence="more operator text")
    incident_state: dict[str, Any] = {}
    _mod.absorb_daily_health_signal(event, incident_state)
    assert "legacyAlertContent" not in incident_state


def test_legacy_counter_is_called_from_every_terminal_path_and_only_those() -> None:
    """Structural: the recorder's call sites are exactly the four terminal paths.

    Too few and a whole population stops being counted, which is the defect this
    replaced; too many and one event counts twice. Pinning the exact set is what
    keeps both from drifting back in.
    """
    import ast as _ast

    tree = _ast.parse(_SCRIPT.read_text(encoding="utf-8"))
    callers: set[str] = set()
    for node in _ast.walk(tree):
        if not isinstance(node, _ast.FunctionDef):
            continue
        for inner in _ast.walk(node):
            if (
                isinstance(inner, _ast.Call)
                and isinstance(inner.func, _ast.Name)
                and inner.func.id == "record_legacy_alert_content"
            ):
                callers.add(node.name)
    assert callers == {
        "collapse_storm_group",
        "suppress_alerts_recovered_before_delivery",
        "suppress_ready_recovery_duplicates",
        "process_one",
    }, f"unexpected recorder call sites: {sorted(callers)}"

def _quarantine_one_unrenderable(tmp_path: Path) -> None:
    outbox = tmp_path / "outbox"
    quarantine = tmp_path / "quarantine"
    outbox.mkdir(exist_ok=True)
    quarantine.mkdir(exist_ok=True)
    event = _make_event(summary=["not", "renderable"])
    path = outbox / "evt-unrenderable.json"
    path.write_text(json.dumps(event), encoding="utf-8")
    assert _mod.load_valid_event_or_quarantine(path, quarantine) is None
    landed = list(quarantine.iterdir())
    assert len(landed) == 1
    assert "unrenderable_alert_content" in landed[0].name


def test_unrenderable_quarantine_is_counted(tmp_path: Path) -> None:
    _mod.ack_unrenderable_quarantine_telemetry(
        _mod.flush_unrenderable_quarantine_telemetry({})
    )  # drain any prior pending count
    _quarantine_one_unrenderable(tmp_path)
    incident_state: dict[str, Any] = {}
    folded = _mod.flush_unrenderable_quarantine_telemetry(incident_state)
    assert folded == 1
    counters = incident_state["legacyAlertContent"]
    assert counters["queueUnrenderable"] == 1
    assert counters["queueLegacyObject"] == 0
    assert counters["queueBakedRepr"] == 0
    assert counters["lastLegacyAt"] > 0
    _mod.ack_unrenderable_quarantine_telemetry(folded)

def test_the_recorder_does_not_fold_quarantine_counts(tmp_path: Path) -> None:
    """One fold site, and its commit is adjacent to it.

    The recorder used to fold pending quarantine counts too, but its callers
    commit far away, so a failed write there could not be detected or recovered
    from. Folding happens only at the end-of-cycle drain, where the commit is the
    next statement and can be acknowledged.
    """
    _mod.ack_unrenderable_quarantine_telemetry(
        _mod.flush_unrenderable_quarantine_telemetry({})
    )
    _quarantine_one_unrenderable(tmp_path)
    incident_state: dict[str, Any] = {}
    _mod.record_legacy_alert_content(
        _make_event(summary=legacy_object(), evidence=""), incident_state
    )
    counters = incident_state["legacyAlertContent"]
    assert counters["queueLegacyObject"] == 1
    assert counters["queueUnrenderable"] == 0, "the recorder must not fold quarantine counts"

    # The pending quarantine is still there, for the drain site to fold.
    drained: dict[str, Any] = {}
    folded = _mod.flush_unrenderable_quarantine_telemetry(drained)
    assert folded == 1
    _mod.ack_unrenderable_quarantine_telemetry(folded)

def test_acknowledged_quarantine_count_is_not_replayed(tmp_path: Path) -> None:
    """Once acknowledged, the same quarantine must not be folded again."""
    _mod.ack_unrenderable_quarantine_telemetry(
        _mod.flush_unrenderable_quarantine_telemetry({})
    )
    _quarantine_one_unrenderable(tmp_path)
    first: dict[str, Any] = {}
    folded = _mod.flush_unrenderable_quarantine_telemetry(first)
    assert folded == 1
    _mod.ack_unrenderable_quarantine_telemetry(folded)

    second: dict[str, Any] = {}
    assert _mod.flush_unrenderable_quarantine_telemetry(second) == 0
    assert "legacyAlertContent" not in second

def test_flush_is_silent_when_nothing_was_quarantined() -> None:
    _mod.ack_unrenderable_quarantine_telemetry(
        _mod.flush_unrenderable_quarantine_telemetry({})
    )
    incident_state: dict[str, Any] = {}
    assert _mod.flush_unrenderable_quarantine_telemetry(incident_state) == 0
    assert "legacyAlertContent" not in incident_state

POISON_SUMMARY = (
    "{'failureClass': 'TypeError', 'length': "
    + "1" * 5000
    + ", 'correlationDigest': '"
    + DIGEST
    + "'}"
)


def test_poison_alert_content_does_not_wedge_the_queue(tmp_path, monkeypatch) -> None:
    """End-to-end over two cycles: the queue drains and the healthy alert lands."""
    root = tmp_path / "state"
    outbox = root / "outbox"
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(root))
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(outbox))
    monkeypatch.setenv("BOT_ERRORS_JID", "12345@g.us")
    mod = _load_module()

    sent_texts: list[str] = []
    monkeypatch.setattr(mod, "send_whatsapp", lambda text, socket_path="": sent_texts.append(text))
    monkeypatch.setattr(mod, "append_dispatch_log", lambda *a, **k: None)

    paths = mod.setup_dirs()
    # Sorted first, so it is processed before the healthy alert: an abort here
    # would take the healthy alert down with it.
    poison = _make_event(id="poison-001", summary=POISON_SUMMARY, evidence="poison evidence")
    # A DIFFERENT source, so the two are distinct incidents. Sharing a source would
    # make the second a duplicate of the first's open incident and it would be
    # suppressed for reasons unrelated to this test.
    healthy = _make_event(
        id="healthy-001", source="agent_respawn_failed",
        summary="healthy alert", evidence="healthy evidence",
    )
    for name, event in (("aaa-poison.json", poison), ("zzz-healthy.json", healthy)):
        path = paths["outbox"] / name
        path.write_text(json.dumps(event), encoding="utf-8")
        path.chmod(0o600)

    # No exception may escape run_once.
    first = mod.run_once(max_events=25)
    second = mod.run_once(max_events=25)

    remaining = sorted(p.name for p in paths["outbox"].glob("*.json"))
    assert remaining == [], f"the queue must drain, still holds {remaining}"
    assert any("healthy alert" in text for text in sent_texts), (
        "the healthy alert must be delivered even when a poison event is queued first"
    )
    # Both events were accounted for in cycle one; cycle two has nothing left to do,
    # which is the property that was broken: the poison used to re-abort every cycle.
    assert first.get("processed", 0) == 2
    assert second.get("processed", 0) == 0
    assert first.get("failed", 0) == 0


def test_poison_alert_content_renders_as_text_not_as_an_envelope() -> None:
    """The bounded grammar makes an over-long run simply not the envelope."""
    assert _mod.alert_text(POISON_SUMMARY) == POISON_SUMMARY
    assert _mod.alert_text_kind(POISON_SUMMARY) == "string"


# ---------------------------------------------------------------------------
# Item 5: incident identity must not shrink to the display digest
# ---------------------------------------------------------------------------
# The canonical string shows digest[:8] because that is what an operator reads.
# Fingerprints are not display. Feeding them the rendered string put incident
# identity on 32 bits, so two DISTINCT incidents whose digests share a prefix
# collapsed into one. On main the summary carried the full 64-hex repr and they
# did not collide, so this is a regression against main, not a pre-existing gap.

SHARED_PREFIX = "a1b2c3d4"
DIGEST_TAIL_A = SHARED_PREFIX + "1" * 56
DIGEST_TAIL_B = SHARED_PREFIX + "2" * 56


def _event_with_digest(digest: str, host: str) -> dict[str, Any]:
    confined = {"failureClass": "TypeError", "length": 54, "correlationDigest": digest}
    return _make_event(machine=host, summary=confined, evidence=confined)


def test_same_prefix_different_tail_digests_do_not_collide() -> None:
    """The regression: distinct incidents must stay distinct across hosts."""
    first = _event_with_digest(DIGEST_TAIL_A, "fixture-host-a")
    second = _event_with_digest(DIGEST_TAIL_B, "fixture-host-b")
    assert _mod.storm_fingerprint(first) != _mod.storm_fingerprint(second)
    assert _mod.recovery_episode_fingerprint(first) != _mod.recovery_episode_fingerprint(second)
    assert _mod.recovery_duplicate_fingerprint(first) != _mod.recovery_duplicate_fingerprint(second)


def test_identical_digests_still_collapse_across_hosts() -> None:
    """The other side: full-digest identity must not break real collapse."""
    first = _event_with_digest(DIGEST_TAIL_A, "fixture-host-a")
    second = _event_with_digest(DIGEST_TAIL_A, "fixture-host-b")
    assert _mod.storm_fingerprint(first) == _mod.storm_fingerprint(second)


def test_display_rendering_keeps_the_eight_character_prefix() -> None:
    """Fingerprints take the full digest; what an operator reads is unchanged."""
    event = _event_with_digest(DIGEST_TAIL_A, "fixture-host-a")
    assert _mod.event_text(event, "summary") == "TypeError - 54 chars - digest a1b2c3d4"
    text = _mod.format_event(event)
    assert "digest a1b2c3d4" in text
    assert DIGEST_TAIL_A not in text, "the full digest must not reach operator-visible text"


# ---------------------------------------------------------------------------
# Item 7: the count must land AND persist on every terminal path
# ---------------------------------------------------------------------------
# Recording inside absorb_daily_health_signal was not enough. On
# recovered-before-delivery the call sat inside a daily-health guard, so a
# non-daily legacy event was never counted; on storm collapse and recovery
# dedupe it was counted into the in-memory payload but the commit was gated on a
# daily-health-only flag, so the increment was computed and discarded.

def _legacy_non_daily_event(event_id: str) -> dict[str, Any]:
    return _make_event(id=event_id, source="primary_model_unusable",
                       summary=legacy_object(), evidence="")


def test_recorder_reports_whether_it_changed_state() -> None:
    """The commit gates key off this, so it has to be truthful both ways."""
    state: dict[str, Any] = {}
    assert _mod.record_legacy_alert_content(_legacy_non_daily_event("e1"), state) is True
    clean = _make_event(summary="plain text", evidence="plain text")
    assert _mod.record_legacy_alert_content(clean, {}) is False


def test_non_daily_legacy_event_is_counted_on_every_terminal_path() -> None:
    """One call per consumed event on each path, outside any daily-health guard."""
    for path_name in ("storm_collapse", "recovered_before_delivery", "recovery_dedupe"):
        state: dict[str, Any] = {}
        changed = _mod.record_legacy_alert_content(_legacy_non_daily_event(path_name), state)
        assert changed is True, f"{path_name} must report a state change"
        assert state["legacyAlertContent"]["queueLegacyObject"] == 1, path_name


def test_terminal_paths_do_not_gate_the_recorder_on_daily_health() -> None:
    """Structural: no recorder call may sit under a daily-health source guard.

    This is the shape that made the counter blind. A per-site behavioural test
    cannot see it, because the site still counts for daily-health events.
    """
    import ast as _ast

    source = _SCRIPT.read_text(encoding="utf-8")
    tree = _ast.parse(source)
    parent: dict[_ast.AST, _ast.AST] = {}
    for node in _ast.walk(tree):
        for child in _ast.iter_child_nodes(node):
            parent[child] = node

    offenders = []
    for node in _ast.walk(tree):
        if not (
            isinstance(node, _ast.Call)
            and isinstance(node.func, _ast.Name)
            and node.func.id == "record_legacy_alert_content"
        ):
            continue
        current = parent.get(node)
        while current is not None:
            if isinstance(current, _ast.If):
                test_src = _ast.get_source_segment(source, current.test) or ""
                if "daily-health" in test_src:
                    offenders.append((node.lineno, test_src.strip()[:70]))
                    break
            current = parent.get(current)
    assert not offenders, (
        "the legacy-content recorder must not sit under a daily-health guard: "
        + "; ".join(f"line {ln} under {t}" for ln, t in offenders)
    )


# ---------------------------------------------------------------------------
# MED-2: a quarantine count must survive a failed durable write
# ---------------------------------------------------------------------------
# The pending counter is a process global. Draining it at fold time and
# committing later means a failed durable write loses the count outright: it is
# gone from the global AND absent from disk. The count must only be acknowledged
# once a commit has actually succeeded.

def test_pending_quarantine_survives_a_failed_commit(tmp_path: Path) -> None:
    """Fold without acknowledgement leaves the count pending for the next cycle."""
    _mod.ack_unrenderable_quarantine_telemetry(
        _mod.flush_unrenderable_quarantine_telemetry({})
    )  # drain any prior pending count
    _quarantine_one_unrenderable(tmp_path)

    # Cycle one: fold, then the durable write fails, so no acknowledgement.
    lost_state: dict[str, Any] = {}
    folded = _mod.flush_unrenderable_quarantine_telemetry(lost_state)
    assert folded == 1
    assert lost_state["legacyAlertContent"]["queueUnrenderable"] == 1
    # commit raised; the state object is discarded and never acknowledged.

    # Cycle two: the count must still be pending and must land.
    kept_state: dict[str, Any] = {}
    refolded = _mod.flush_unrenderable_quarantine_telemetry(kept_state)
    assert refolded == 1, "a failed commit must not lose the quarantine count"
    assert kept_state["legacyAlertContent"]["queueUnrenderable"] == 1
    _mod.ack_unrenderable_quarantine_telemetry(refolded)

    # Acknowledged now, so it must not be folded a third time.
    after_state: dict[str, Any] = {}
    assert _mod.flush_unrenderable_quarantine_telemetry(after_state) == 0
    assert "legacyAlertContent" not in after_state


def test_acknowledgement_drains_only_what_was_committed(tmp_path: Path) -> None:
    """A partial acknowledgement must leave the remainder pending."""
    _mod.ack_unrenderable_quarantine_telemetry(
        _mod.flush_unrenderable_quarantine_telemetry({})
    )
    _quarantine_one_unrenderable(tmp_path)
    _quarantine_one_unrenderable(tmp_path)

    first: dict[str, Any] = {}
    folded = _mod.flush_unrenderable_quarantine_telemetry(first)
    assert folded == 2
    _mod.ack_unrenderable_quarantine_telemetry(1)   # only one write made it

    remainder: dict[str, Any] = {}
    assert _mod.flush_unrenderable_quarantine_telemetry(remainder) == 1
    _mod.ack_unrenderable_quarantine_telemetry(1)
    assert _mod.flush_unrenderable_quarantine_telemetry({}) == 0


# ---------------------------------------------------------------------------
# LOW-2: a queued clear must not be counted twice
# ---------------------------------------------------------------------------
# suppress_alerts_recovered_before_delivery records the clear unconditionally,
# but only consumes it when no incident is open. With an incident open the clear
# stays in the outbox and process_one records it a second time.

def test_queued_clear_is_counted_once_not_twice(tmp_path, monkeypatch) -> None:
    """Two cycles, end to end: three legacy events must count three times, not four.

    Reaching the defect needs the real preconditions, not just an open incident:
    suppress_alerts_recovered_before_delivery only runs its body when a clear has a
    PENDING, NOT-YET-READY alert of the same key still in the outbox. With an
    incident already open the clear will dispatch, so the pass leaves it in the
    outbox for process_one -- and recording it in both places counted that one
    event twice.
    """
    root = tmp_path / "state"
    outbox = root / "outbox"
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(root))
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(outbox))
    monkeypatch.setenv("BOT_ERRORS_JID", "12345@g.us")
    mod = _load_module()
    monkeypatch.setattr(mod, "send_whatsapp", lambda text, socket_path="": None)
    monkeypatch.setattr(mod, "append_dispatch_log", lambda *a, **k: None)
    paths = mod.setup_dirs()

    def queue(name: str, event: dict[str, Any]) -> None:
        path = paths["outbox"] / name
        path.write_text(json.dumps(event), encoding="utf-8")
        path.chmod(0o600)

    def counted() -> int:
        raw = json.loads(paths["incident_state"].read_text(encoding="utf-8"))
        return int((raw.get("legacyAlertContent") or {}).get("queueLegacyObject") or 0)

    # First cycle: one legacy alert opens the incident. One event, one count.
    queue("a.json", _make_event(id="alert-001", summary=legacy_object(), evidence=""))
    mod.run_once(max_events=25)
    assert counted() == 1, "the first cycle must count the alert exactly once"

    # Second cycle: a NOT-READY alert of the same key plus a READY clear. Two more
    # events, so two more counts.
    queue("b-alert.json", _make_event(
        id="alert-002", summary=legacy_object(), evidence="",
        createdAt="2026-09-02T00:01:00.000Z",
        delivery={"nextAttemptAtEpoch": int(time.time()) + 3600, "attempts": 1},
    ))
    queue("c-clear.json", _make_event(
        id="clear-001", eventKind="incident_recovery", eventType="clear",
        severity="info", summary=legacy_object(), evidence="",
        createdAt="2026-09-02T00:02:00.000Z",
    ))
    result = mod.run_once(max_events=25)
    assert result.get("recoveredBeforeDelivery") == 1, (
        "the recovered-before-delivery pass must actually have run"
    )

    total = counted()
    assert total == 3, (
        f"three legacy events must count three times, got {total}; "
        "four means the queued clear was counted by both the pre-loop pass and process_one"
    )

def test_recovered_before_delivery_gates_the_clear_recorder() -> None:
    """Structural: the clear-event recorder must sit under the same gate as its
    consumption, so a queued clear is not counted by two different paths.

    A behavioural test on the helper alone cannot see this: the double count only
    appears once process_one also runs, in a later phase of the same cycle.
    """
    import ast as _ast

    source = _SCRIPT.read_text(encoding="utf-8")
    tree = _ast.parse(source)
    target = None
    for node in _ast.walk(tree):
        if isinstance(node, _ast.FunctionDef) and node.name == "suppress_alerts_recovered_before_delivery":
            target = node
            break
    assert target is not None

    parent: dict[_ast.AST, _ast.AST] = {}
    for node in _ast.walk(target):
        for child in _ast.iter_child_nodes(node):
            parent[child] = node

    ungated = []
    for node in _ast.walk(target):
        if not (
            isinstance(node, _ast.Call)
            and isinstance(node.func, _ast.Name)
            and node.func.id == "record_legacy_alert_content"
            and node.args
            and isinstance(node.args[0], _ast.Name)
            and node.args[0].id == "clear_event"
        ):
            continue
        gated = False
        current = parent.get(node)
        while current is not None:
            if isinstance(current, _ast.If):
                test_src = _ast.get_source_segment(source, current.test) or ""
                if "clear_will_dispatch" in test_src:
                    gated = True
                    break
            current = parent.get(current)
        if not gated:
            ungated.append(node.lineno)
    assert not ungated, (
        "the clear-event recorder must be gated on clear_will_dispatch, "
        f"ungated at line(s) {ungated}"
    )


# ---------------------------------------------------------------------------
# Telemetry must never be able to wedge the queue
# ---------------------------------------------------------------------------
# The recorder is pure today, but it is the per-event caller of the quarantine
# fold, so a future raise inside it would abort the cycle before the event is
# delivered -- the same total-alert-loss class as the poison value. Telemetry is
# not worth an alert, so the call fails open and records why.

def test_a_raising_recorder_does_not_stop_the_event(tmp_path, monkeypatch) -> None:
    root = tmp_path / "state"
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(root))
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(root / "outbox"))
    monkeypatch.setenv("BOT_ERRORS_JID", "12345@g.us")
    mod = _load_module()

    sent: list[str] = []
    logged: list[dict[str, Any]] = []
    monkeypatch.setattr(mod, "send_whatsapp", lambda text, socket_path="": sent.append(text))
    monkeypatch.setattr(mod, "append_dispatch_log", lambda paths, record: logged.append(record))

    def raising_recorder(event, incident_state):
        raise RuntimeError("fixture telemetry failure")

    monkeypatch.setattr(mod, "record_legacy_alert_content", raising_recorder)

    paths = mod.setup_dirs()
    path = paths["outbox"] / "evt-telemetry.json"
    path.write_text(json.dumps(_make_event(id="telemetry-001", summary="operator text")), encoding="utf-8")
    path.chmod(0o600)

    result = mod.run_once(max_events=25)

    assert result.get("sent", 0) == 1, "a telemetry failure must not stop delivery"
    assert any("operator text" in text for text in sent)
    assert list(paths["outbox"].glob("*.json")) == [], "the queue must still drain"
    assert any(
        record.get("type") == "legacy_alert_content_telemetry_failed" for record in logged
    ), "the failure must be recorded, not swallowed silently"


# ---------------------------------------------------------------------------
# The quarantine path must page (#2386)
# ---------------------------------------------------------------------------
# Quarantine happens inside ready(), BEFORE process_one, so a quarantined event
# is out of the queue before any delivery path runs. Nothing else in the cycle
# reports it: the dead-letter meta-alert covers exhausted delivery only, and the
# failed counter is incremented after the move. A one-shot run with a single
# unrenderable CRITICAL alert therefore exited 0 with the alert silently dropped,
# where the base behaviour paged a sentinel. #2386's acceptance is that failing
# closed on a malformed schema must not suppress the safe source/class signal.

UNRENDERABLE_NONCE = "nonce4f2a9c1edonotleak"


def _dispatcher_in(tmp_path: Path, monkeypatch) -> Any:
    """A dispatcher module bound to a sandbox state root, with sending stubbed."""
    root = tmp_path / "state"
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(root))
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(root / "outbox"))
    monkeypatch.setenv("BOT_ERRORS_JID", "12345@g.us")
    mod = _load_module()
    monkeypatch.setattr(mod, "send_whatsapp", lambda text, socket_path="": None)
    return mod


def _queue_event(paths: dict[str, Path], name: str, event: dict[str, Any]) -> dict[str, Any]:
    path = paths["outbox"] / name
    path.write_text(json.dumps(event), encoding="utf-8")
    path.chmod(0o600)
    return event


def _unrenderable_event(**overrides: Any) -> dict[str, Any]:
    """A CRITICAL alert whose summary is a mapping-free value nothing can render.

    The nonce lives ONLY in the unrenderable value, so a meta-alert that quotes any
    part of the quarantined content fails the leak assertion below.
    """
    base: dict[str, Any] = {
        "id": "unrenderable-001",
        "summary": [UNRENDERABLE_NONCE, "not renderable"],
        "evidence": "plain evidence text " + UNRENDERABLE_NONCE,
    }
    base.update(overrides)
    return _make_event(**base)


def _queued_meta_alerts(paths: dict[str, Path], mod: Any) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    for path in sorted(paths["outbox"].glob("*.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if record.get("source") == mod.UNRENDERABLE_META_ALERT_SOURCE:
            found.append(record)
    return found


def test_a_quarantined_unrenderable_alert_queues_exactly_one_meta_alert(tmp_path, monkeypatch) -> None:
    mod = _dispatcher_in(tmp_path, monkeypatch)
    paths = mod.setup_dirs()
    _queue_event(paths, "aaa-unrenderable.json", _unrenderable_event())

    result = mod.run_once(max_events=25)

    alerts = _queued_meta_alerts(paths, mod)
    assert len(alerts) == 1, f"expected exactly one meta-alert, got {len(alerts)}"
    assert result.get("unrenderableMetaAlerted") == 1
    assert alerts[0]["severity"] == "critical", "a dropped CRITICAL alert must page"
    assert alerts[0]["eventKind"] == "incident_alert"

    quarantined = [p.name for p in paths["quarantine"].iterdir()]
    assert len(quarantined) == 1 and "unrenderable_alert_content" in quarantined[0]

    counters = json.loads(paths["incident_state"].read_text(encoding="utf-8"))
    assert int((counters.get("legacyAlertContent") or {}).get("queueUnrenderable") or 0) == 1


def test_a_one_shot_run_that_quarantined_an_alert_does_not_exit_zero(tmp_path, monkeypatch) -> None:
    """The exit code is the only signal a systemd one-shot unit reports."""
    mod = _dispatcher_in(tmp_path, monkeypatch)
    paths = mod.setup_dirs()
    _queue_event(paths, "aaa-unrenderable.json", _unrenderable_event())

    monkeypatch.setattr(sys, "argv", ["bot-errors-dispatcher.py", "--once"])
    assert mod.main() == 1, "a cycle that dropped an alert must not report success"


def test_a_one_shot_run_with_nothing_quarantined_still_exits_zero(tmp_path, monkeypatch) -> None:
    """Negative control: the new non-zero path must not fire on a healthy cycle."""
    mod = _dispatcher_in(tmp_path, monkeypatch)
    paths = mod.setup_dirs()
    _queue_event(paths, "aaa-healthy.json", _make_event(
        id="healthy-001", summary="healthy alert", evidence="healthy evidence",
    ))

    monkeypatch.setattr(sys, "argv", ["bot-errors-dispatcher.py", "--once"])
    assert mod.main() == 0


def test_the_run_result_reports_the_quarantine_count_for_the_cycle(tmp_path, monkeypatch) -> None:
    mod = _dispatcher_in(tmp_path, monkeypatch)
    paths = mod.setup_dirs()
    _queue_event(paths, "aaa-one.json", _unrenderable_event(id="unrenderable-001"))
    _queue_event(paths, "bbb-two.json", _unrenderable_event(
        id="unrenderable-002", source="agent_respawn_failed",
    ))

    result = mod.run_once(max_events=25)

    assert result["unrenderableQuarantined"] == 2
    # Two DIFFERENT incident keys, so the per-key throttle pages for both.
    assert result["unrenderableMetaAlerted"] == 2
    # A quarantined alert was not delivered and is never retried, so it is a
    # terminal failure of the cycle, folded into the counters health inspection
    # and the one-shot exit status already read.
    assert result["failed"] == 2
    assert result["processed"] == 2
    assert result["lastError"] == "unrenderable_alert_content"


def test_a_second_unrenderable_event_inside_the_window_queues_no_second_meta_alert(
    tmp_path, monkeypatch,
) -> None:
    """Throttled per incident key, so one broken producer pages once, not per event."""
    mod = _dispatcher_in(tmp_path, monkeypatch)
    paths = mod.setup_dirs()

    _queue_event(paths, "aaa-one.json", _unrenderable_event(id="unrenderable-001"))
    first = mod.run_once(max_events=25)
    _queue_event(paths, "bbb-two.json", _unrenderable_event(id="unrenderable-002"))
    second = mod.run_once(max_events=25)

    assert first["unrenderableMetaAlerted"] == 1
    assert second["unrenderableMetaAlerted"] == 0, "the throttle must suppress the second page"
    assert first["unrenderableQuarantined"] + second["unrenderableQuarantined"] == 2, (
        "the throttle governs the PAGE, never the count"
    )
    counters = json.loads(paths["incident_state"].read_text(encoding="utf-8"))
    assert int((counters.get("legacyAlertContent") or {}).get("queueUnrenderable") or 0) == 2


def test_the_meta_alert_carries_no_bytes_of_the_quarantined_content(tmp_path, monkeypatch) -> None:
    """Mutation-provable: leaking one byte of the quarantined value turns this red."""
    mod = _dispatcher_in(tmp_path, monkeypatch)
    paths = mod.setup_dirs()
    original = _queue_event(paths, "aaa-unrenderable.json", _unrenderable_event())
    # Positive control: the nonce really is in the record that was quarantined, so
    # its absence below is a property of the meta-alert, not of the fixture.
    assert UNRENDERABLE_NONCE in json.dumps(original)

    mod.run_once(max_events=25)

    alerts = _queued_meta_alerts(paths, mod)
    assert len(alerts) == 1
    body = json.dumps(alerts[0])
    assert UNRENDERABLE_NONCE not in body, "the meta-alert quoted the quarantined content"
    assert BRACE_QUOTE not in body, "the meta-alert baked a dict repr"
    # The safe signal must survive: failing closed may not suppress the class
    # signal. Superseded (B2): this asserted the raw source and machine appeared,
    # which is the unvalidated identity echo that had to go. What survives is the
    # canonical set plus an opaque per-producer identity.
    assert "primary_model_unusable" not in body, "raw source must not reach the page"
    assert "fixture-host-a" not in body, "raw machine must not reach the page"
    assert "reason=unrenderable_alert_content" in body
    assert "alert_kind=incident_alert" in body
    assert "alert_severity=critical" in body
    assert "failure_class=" in body
    assert re.search(r"producer_identity=[0-9a-f]{16}", body), body


def test_the_meta_alert_reports_the_class_from_a_renderable_sibling_without_the_digest(
    tmp_path, monkeypatch,
) -> None:
    """The class survives; the digest and the length do not.

    An event can carry a legacy confinement envelope in one field and an
    unrenderable value in the other. That envelope is where a failure class exists
    at all, so it is the one place the class can come from -- but only the class:
    `alert_text` also renders a length and a digest prefix, and neither belongs in
    a page about content the consumer refused to render.
    """
    mod = _dispatcher_in(tmp_path, monkeypatch)
    paths = mod.setup_dirs()
    _queue_event(paths, "aaa-mixed.json", _make_event(
        id="unrenderable-mixed", summary=legacy_object(), evidence=[UNRENDERABLE_NONCE],
    ))

    mod.run_once(max_events=25)

    alerts = _queued_meta_alerts(paths, mod)
    assert len(alerts) == 1
    body = json.dumps(alerts[0])
    assert "failure_class=TypeError" in body
    assert DIGEST not in body and DIGEST[:8] not in body
    assert "54 chars" not in body
    assert UNRENDERABLE_NONCE not in body
    assert "evidence:list" in body, "the shape of the failure is reported by type, not content"


def test_every_unrenderable_quarantine_site_passes_the_event() -> None:
    """Coverage assertion over BOTH quarantine call sites.

    Per-site tests only prove the sites someone thought to enumerate. The second
    site sits in process_one, reachable when the file is rewritten between the
    ready() scan and the claim; a site that drops the event drops the page with it.
    """
    tree = ast.parse(_SCRIPT.read_text(encoding="utf-8"))
    calls = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "quarantine_invalid_envelope"
    ]
    assert len(calls) == 2, f"expected two quarantine sites, found {len(calls)}"
    for call in calls:
        assert len(call.args) == 4, f"site drops the event: {ast.unparse(call)}"


def test_the_signal_is_content_free_for_an_event_with_no_identity() -> None:
    """A malformed record must not break the page it is the reason for."""
    signal = _mod.unrenderable_alert_signal("not a mapping at all")
    assert signal["failureClass"] == "unavailable"
    assert signal["identity"] == _mod.UNRENDERABLE_IDENTITY_UNAVAILABLE
    assert signal["reason"] == _mod.UNRENDERABLE_ALERT_CONTENT_CODE
    assert signal["kind"] == "unknown" and signal["severity"] == "unknown"


def test_a_malformed_event_before_a_healthy_alert_does_not_block_it(tmp_path, monkeypatch) -> None:
    """Queue continuity: failing closed must not suppress a healthy sibling.

    The malformed event sorts FIRST, so an implementation that aborts, wedges, or
    returns early on the quarantine path takes the healthy alert down with it.
    """
    mod = _dispatcher_in(tmp_path, monkeypatch)
    sent: list[str] = []
    monkeypatch.setattr(mod, "send_whatsapp", lambda text, socket_path="": sent.append(text))
    paths = mod.setup_dirs()

    _queue_event(paths, "aaa-unrenderable.json", _unrenderable_event())
    # A DIFFERENT source, so the healthy alert is its own incident rather than a
    # duplicate suppressed for reasons unrelated to this test.
    _queue_event(paths, "zzz-healthy.json", _make_event(
        id="healthy-001", source="agent_respawn_failed",
        summary="healthy alert", evidence="healthy evidence",
    ))

    result = mod.run_once(max_events=25)

    assert any("healthy alert" in text for text in sent), (
        "the healthy alert must still deliver behind a quarantined one"
    )
    assert result["unrenderableQuarantined"] == 1
    assert result["failed"] == 1, "the malformed event is still accounted as terminal"
    assert result["sent"] == 1
    assert result["lastError"] == "unrenderable_alert_content"
    assert sorted(p.name for p in paths["outbox"].glob("*.json")) == [
        p.name for p in paths["outbox"].glob("*.json")
        if json.loads(p.read_text(encoding="utf-8")).get("source")
        == mod.UNRENDERABLE_META_ALERT_SOURCE
    ], "only the meta-alert may remain queued"


def test_the_quarantine_disposition_is_typed_not_a_bare_boolean() -> None:
    """A terminal drop and a not-due event must not look the same to the caller."""
    mod = _mod
    assert mod.DISPOSITION_READY.state == "ready"
    assert mod.DISPOSITION_NOT_READY.state == "not_ready"
    assert mod.DISPOSITION_READY.reason == ""


def test_the_disposition_carries_the_fixed_reason_and_validated_header(tmp_path: Path) -> None:
    """The reason is the fixed code, and the header values were already validated."""
    outbox = tmp_path / "outbox"
    quarantine = tmp_path / "quarantine"
    outbox.mkdir(exist_ok=True)
    quarantine.mkdir(exist_ok=True)
    path = outbox / "evt-unrenderable.json"
    path.write_text(json.dumps(_unrenderable_event()), encoding="utf-8")

    disposition = _mod.ready_disposition(path, quarantine)

    assert disposition.state == "quarantined"
    assert disposition.reason == "unrenderable_alert_content"
    # Classification validated the header BEFORE it rejected the content, so the
    # kind and severity are known and are canonical values, not raw event text.
    assert disposition.kind == "incident_alert"
    assert disposition.severity == "critical"
    assert UNRENDERABLE_NONCE not in json.dumps(disposition.__dict__)


def test_a_not_due_event_is_not_reported_as_quarantined(tmp_path: Path) -> None:
    """Negative control: the typed result must separate the two non-ready cases."""
    outbox = tmp_path / "outbox"
    quarantine = tmp_path / "quarantine"
    outbox.mkdir(exist_ok=True)
    quarantine.mkdir(exist_ok=True)
    path = outbox / "evt-later.json"
    path.write_text(json.dumps(_make_event(
        id="later-001", summary="healthy", evidence="healthy",
        delivery={"nextAttemptAtEpoch": int(time.time()) + 3600, "attempts": 1},
    )), encoding="utf-8")

    disposition = _mod.ready_disposition(path, quarantine)

    assert disposition.state == "not_ready"
    assert disposition.reason == ""
    assert list(quarantine.iterdir()) == []


# ---------------------------------------------------------------------------
# The content-free page's own fields are bounded tokens (#2386)
# ---------------------------------------------------------------------------
# The page is a newline-joined block of fixed `key=value` lines. Two of those
# values come from the quarantined event itself, and `source` is an unconstrained
# producer string. A newline inside it does not merely look untidy: it writes a
# whole line of the operator's page, so a producer can forge a `disposition:` that
# contradicts the real one three lines below.

FORGED_SOURCE = (
    "benign_source\n"
    "disposition: delivered normally\n"
    "failure_class=TypeError\n"
    "attacker_line=" + UNRENDERABLE_NONCE
)

# Every key the page's evidence block is allowed to begin a line with. A forged
# line is detected by a line that starts with none of them, which catches an
# injected key this list never anticipated as well as the ones it does.
_EVIDENCE_LINE_PREFIXES = (
    "unrenderable_quarantine_count=",
    "alert_source=",
    "incident_key=",
    "failure_class=",
    "unrenderable_fields=",
    "disposition: original quarantined",
)


def test_the_meta_alert_event_id_survives_redaction() -> None:
    """The page must name an event id an operator can look up.

    The id concatenated an epoch and a process id with a hyphen, which is exactly
    the shape the phone-like redactor rewrites, so the operator-visible page
    named the event `...-[REDACTED PHONE]-<digest>` and could not be matched to
    its dispatch-log entry or quarantine file. The sibling dead-letter meta-alert
    renders its id intact; this one must too.
    """
    signal = _mod.unrenderable_alert_signal(_unrenderable_event())
    event = _mod.unrenderable_meta_event(signal, 1)
    event_id = event["id"]
    assert _mod.redact(event_id) == event_id, (
        f"the redactor rewrites the event id: {_mod.redact(event_id)}"
    )
    # Negative control: the redactor DOES rewrite the shape this id used to have,
    # so the assertion above is not passing because redaction is inert here.
    assert _mod.redact("dispatcher-x-1788888888-97982-2e28f2f5") != \
        "dispatcher-x-1788888888-97982-2e28f2f5"


# A source shaped like a test-fixture path. The dispatcher drops any event whose
# text matches one of these, so an echoed producer path can make the page about a
# dropped alert drop itself.
LEAK_SHAPED_SOURCE = "collector_writefail_/tmp/wa-test-auth/session"


def test_a_leak_shaped_source_cannot_make_the_page_drop_itself(tmp_path, monkeypatch) -> None:
    """The page must survive a source that looks like a test-fixture path.

    matched_test_leak_pattern walks EVERY string field of the meta-alert -- the
    comment above the event id says as much, which is why no state path goes in
    its evidence. Echoing `source` verbatim put a producer-controlled path into
    that same walk, so an alert whose producer named a /tmp fixture was
    quarantined AND never paged: the silent drop this issue exists to close,
    arriving through the page built to prevent it. safe_segment removes the "/"
    every leak pattern needs, so the token cannot match one.
    """
    mod = _dispatcher_in(tmp_path, monkeypatch)
    sent: list[str] = []
    monkeypatch.setattr(mod, "send_whatsapp", lambda text, socket_path="": sent.append(text))
    paths = mod.setup_dirs()
    event = _unrenderable_event(source=LEAK_SHAPED_SOURCE)
    _queue_event(paths, "aaa-leaky.json", event)

    # Quarantine, queue the page, deliver it.
    for _ in range(3):
        mod.run_once(max_events=25)

    signal = mod.unrenderable_alert_signal(event)
    assert not any("/" in value for value in signal.values()), signal
    assert mod.matched_test_leak_pattern(mod.unrenderable_meta_event(signal, 1)) is None
    assert len(sent) == 1, "the page must still reach the operator"
    assert UNRENDERABLE_NONCE not in "".join(sent)


# ---------------------------------------------------------------------------
# One quarantined event is accounted ONCE (B1)
# ---------------------------------------------------------------------------
# Quarantine can happen at two sites. The pre-loop passes reach it through
# ready(), before the cycle counts anything, which is why the cycle folds a
# delta. process_one reaches it AFTER `processed` was incremented and returns a
# failure, so the same event is counted by both mechanisms.


def test_a_rewrite_between_ready_and_claim_is_accounted_once(tmp_path, monkeypatch) -> None:
    """The claim-race quarantine must not be counted by both mechanisms.

    A healthy event passes ready(), then the file is rewritten before the claim
    reads it -- the exact window the second quarantine site exists for. The
    cycle's blanket delta and process_one's own failure both describe THAT event,
    so a run reporting one quarantine reported two processed and two failed.
    All four counters are asserted together: quarantine and signal counts alone
    stay correct under the double count and cannot falsify it.
    """
    mod = _dispatcher_in(tmp_path, monkeypatch)
    paths = mod.setup_dirs()
    _queue_event(paths, "aaa-race.json", _make_event(
        id="race-001", summary="healthy at scan time", evidence="healthy evidence",
    ))

    real_claim = mod.claim

    def rewriting_claim(path, processing_dir):
        claimed = real_claim(path, processing_dir)
        # The rewrite the second site exists for: renderable at ready(), not
        # renderable by the time the claimed file is parsed.
        claimed.write_text(json.dumps(_make_event(
            id="race-001", summary=[UNRENDERABLE_NONCE], evidence="evidence",
        )), encoding="utf-8")
        return claimed

    monkeypatch.setattr(mod, "claim", rewriting_claim)

    result = mod.run_once(max_events=25)

    observed = {
        "processed": result["processed"],
        "failed": result["failed"],
        "unrenderableQuarantined": result["unrenderableQuarantined"],
        "unrenderableMetaAlerted": result["unrenderableMetaAlerted"],
    }
    assert observed == {
        "processed": 1,
        "failed": 1,
        "unrenderableQuarantined": 1,
        "unrenderableMetaAlerted": 1,
    }, observed
    assert result["lastError"] == mod.UNRENDERABLE_ALERT_CONTENT_CODE


# ---------------------------------------------------------------------------
# The signal is built from canonical values only (B2)
# ---------------------------------------------------------------------------
# safe_segment bounds SHAPE. It is not a privacy boundary, and every identity
# field the signal read was unvalidated producer text. The five below are all of
# them; the sixth column, the failure class, is canonical only because the
# vocabulary is closed, and is asserted separately.

IDENTITY_MARKERS = {
    "machine": "machinemarker8842",
    "instance": "instancemarker8842",
    "source": "sourcemarker8842",
    "alertSource": "alertsourcemarker8842",
    "remote": "remotemarker8842",
}


def _identity_hostile_event() -> dict[str, Any]:
    """One event carrying a distinct marker in every unvalidated identity field."""
    return _unrenderable_event(
        id="identity-001",
        machine=IDENTITY_MARKERS["machine"],
        instance=IDENTITY_MARKERS["instance"],
        source=IDENTITY_MARKERS["source"],
        alertSource=IDENTITY_MARKERS["alertSource"],
        diagnostics={"remote": IDENTITY_MARKERS["remote"]},
    )


def _durable_sinks(paths: dict[str, Path]) -> dict[str, str]:
    """Every durable file the dispatcher wrote, EXCEPT the quarantine artifact.

    Scanning the tree rather than a list of known files is deliberate: a listed
    sink is only the sinks someone remembered, and the signal reaches meta-state,
    the dispatch log, incident state and the outbox by different paths.
    """
    root = paths["root"]
    sinks: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file() or paths["quarantine"] in path.parents:
            continue
        sinks[str(path.relative_to(root))] = path.read_text(encoding="utf-8", errors="replace")
    return sinks


def test_no_unvalidated_identity_field_reaches_any_durable_sink(tmp_path, monkeypatch) -> None:
    """Markers in machine, instance, source, alertSource and diagnostics.remote.

    The page, the meta-state throttle map, the dispatch log and the outbox payload
    are all checked, because the signal reaches them by different routes. The
    quarantine artifact is excluded on purpose: it is the durable record of the
    original and is supposed to hold it.
    """
    mod = _dispatcher_in(tmp_path, monkeypatch)
    paths = mod.setup_dirs()
    # Three fixtures, because two of the five fields are only reachable through
    # specific shapes: incident_source folds alertSource in for the health
    # sources, and the diagnostic remote only for the collector instance. A
    # single generic fixture would assert their absence vacuously.
    for name, event in (
        ("aaa-generic.json", _identity_hostile_event()),
        ("bbb-alertsource.json", _unrenderable_event(
            id="identity-002", source="daily-health",
            alertSource=IDENTITY_MARKERS["alertSource"],
        )),
        ("ccc-remote.json", _unrenderable_event(
            id="identity-003", instance="bot-errors-collector",
            diagnostics={"remote": IDENTITY_MARKERS["remote"]},
        )),
    ):
        _queue_event(paths, name, event)
        # Positive control: this field really does compose into the identity the
        # signal used to publish, so its absence below is a property of the fix.
        assert any(
            marker in mod.incident_key(event)
            for marker in IDENTITY_MARKERS.values()
        ), name

    mod.run_once(max_events=25)
    mod.run_once(max_events=25)

    sinks = _durable_sinks(paths)
    # Coverage assertion: an empty scan would make every absence below vacuous.
    assert len(sinks) >= 3, sorted(sinks)
    assert any("unrenderable" in body for body in sinks.values()), sorted(sinks)

    leaks = {
        (name, field): where
        for field, name in IDENTITY_MARKERS.items()
        for where, body in sinks.items()
        if name in body
    }
    assert not leaks, leaks

    # Positive control: the markers really were in the event, and the quarantine
    # artifact still holds them, so the absences above are not a fixture that
    # never carried them.
    quarantined = "".join(
        p.read_text(encoding="utf-8", errors="replace")
        for p in paths["quarantine"].rglob("*") if p.is_file()
    )
    for name in IDENTITY_MARKERS.values():
        assert name in quarantined, name


def test_the_signal_carries_only_canonical_values(tmp_path, monkeypatch) -> None:
    """A field allowlist, so a future field cannot be added without a decision."""
    mod = _dispatcher_in(tmp_path, monkeypatch)
    signal = mod.unrenderable_alert_signal(
        _identity_hostile_event(), kind="incident_alert", severity="critical",
    )
    assert set(signal) == {
        "reason", "kind", "severity", "failureClass", "unrenderableFields", "identity",
    }, sorted(signal)
    assert signal["reason"] == mod.UNRENDERABLE_ALERT_CONTENT_CODE
    assert signal["kind"] == "incident_alert"
    assert signal["severity"] == "critical"
    assert signal["failureClass"] == "unavailable"
    # A bounded, non-reversible operation identity: hex only, fixed width, and
    # not any of the raw components it stands in for.
    assert re.fullmatch(r"[0-9a-f]{16}", signal["identity"]), signal["identity"]
    for name in IDENTITY_MARKERS.values():
        assert name not in json.dumps(signal), name


def test_the_identity_is_stable_per_producer_and_distinct_across_them(tmp_path, monkeypatch) -> None:
    """It replaces the incident key for throttling, so it must group the same way."""
    mod = _dispatcher_in(tmp_path, monkeypatch)
    a1 = mod.unrenderable_alert_signal(_unrenderable_event(source="producer_a"))["identity"]
    a2 = mod.unrenderable_alert_signal(_unrenderable_event(source="producer_a"))["identity"]
    b = mod.unrenderable_alert_signal(_unrenderable_event(source="producer_b"))["identity"]
    assert a1 == a2, "the same producer must throttle to one page"
    assert a1 != b, "two producers must not collapse into one page"


def test_the_failure_class_in_the_signal_is_from_the_closed_vocabulary(tmp_path, monkeypatch) -> None:
    """The one non-fixed field that survives, and why it is safe to keep."""
    mod = _dispatcher_in(tmp_path, monkeypatch)
    valid = mod.unrenderable_alert_signal(_unrenderable_event(
        id="cls-001", summary=legacy_object(), evidence=[UNRENDERABLE_NONCE],
    ))
    assert valid["failureClass"] == "TypeError"
    assert valid["failureClass"] in _load_redaction_classes()

    # A class the producer could not have emitted never becomes the signal's.
    hostile = mod.unrenderable_alert_signal(_unrenderable_event(
        id="cls-002",
        summary={"failureClass": "hostile" + UNRENDERABLE_NONCE, "length": 54,
                 "correlationDigest": DIGEST},
        evidence=[UNRENDERABLE_NONCE],
    ))
    assert hostile["failureClass"] == "unavailable", hostile


def _load_redaction_classes() -> set[str]:
    spec = importlib.util.spec_from_file_location(
        "b2_redaction", _SCRIPT.parent / "lib" / "bot_errors_redaction.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return set(module.LEGACY_FAILURE_CLASSES)


def test_every_evidence_line_of_the_page_is_a_canonical_field(tmp_path, monkeypatch) -> None:
    """The page's whole evidence block, asserted as a set, not field by field.

    Supersedes an earlier pair of tests that bounded the SHAPE of the echoed
    source so it could not forge a line. Bounding shape is not a privacy
    boundary: the fix is that no unvalidated producer text is interpolated at
    all. Asserting the exact line set is what makes a re-added field red.
    """
    mod = _dispatcher_in(tmp_path, monkeypatch)
    paths = mod.setup_dirs()
    _queue_event(paths, "aaa-lines.json", _identity_hostile_event())

    mod.run_once(max_events=25)

    alerts = _queued_meta_alerts(paths, mod)
    assert len(alerts) == 1
    lines = alerts[0]["evidence"].split("\n")
    keys = [line.split("=", 1)[0] if "=" in line else line.split(":", 1)[0] for line in lines]
    assert keys == [
        "unrenderable_quarantine_count",
        "reason",
        "alert_kind",
        "alert_severity",
        "failure_class",
        "unrenderable_fields",
        "producer_identity",
        "disposition",
    ], lines
    for name in IDENTITY_MARKERS.values():
        assert name not in alerts[0]["evidence"], name


def test_no_signal_value_carries_a_newline_or_free_text(tmp_path, monkeypatch) -> None:
    """Every value matches a closed pattern, so none can be prose.

    The page is a newline-joined block of `key=value` lines, so a value able to
    hold a newline writes a line of it. Under the canonical set that is true by
    construction rather than by a length or shape bound, and this pins it.
    """
    mod = _dispatcher_in(tmp_path, monkeypatch)
    signal = mod.unrenderable_alert_signal(
        _identity_hostile_event(), kind="incident_alert", severity="critical",
    )
    patterns = {
        "reason": r"[a-z_]{1,64}",
        "kind": r"[a-z_]{1,32}",
        "severity": r"[a-z_]{1,32}",
        "failureClass": r"[A-Za-z_]{1,21}",
        "unrenderableFields": r"[A-Za-z_:,]{0,128}",
        "identity": r"[0-9a-f]{16}",
    }
    assert set(signal) == set(patterns), sorted(signal)
    for field, pattern in patterns.items():
        assert re.fullmatch(pattern, signal[field]), (field, signal[field])
