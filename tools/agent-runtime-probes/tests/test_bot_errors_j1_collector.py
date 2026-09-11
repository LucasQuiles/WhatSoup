#!/usr/bin/env python3
"""Contract tests for the BOT ERRORS J1 unattended collector (read-only, no publication)."""

import datetime as dt
import fcntl
import hashlib
import json
import os
import stat
import sys

import pytest

try:  # property-based coverage when hypothesis is installed; the corpus stays stdlib-only
    from hypothesis import given, settings
    from hypothesis import strategies as st

    HAVE_HYPOTHESIS = True
except ImportError:  # pragma: no cover - environment without hypothesis
    HAVE_HYPOTHESIS = False

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bot_errors_j1_collector as c  # noqa: E402

GEN_ID = "2026-09-11T00:24:59Z"
BODY_MARKER = "UNIQUE-BODY-MARKER-9f3a"


def _write(path, data, mode=0o600):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(data)
    os.chmod(path, mode)


def _rec(pk, mid, ts, body, sender="Name", is_from_me=0):
    """One scan row as the json_object() the remote script emits (JSON Lines)."""
    return {
        "pk": pk,
        "message_id": mid,
        "timestamp": ts,
        "created_at": "2026-09-11 00:00:00",
        "sender_jid": "sender@x",
        "sender_name": sender,
        "content_type": "text",
        "is_from_me": is_from_me,
        "body": body,
    }


def _lines(recs):
    # sqlite emits raw UTF-8 for non-ASCII and \uXXXX escapes for control bytes; json.dumps
    # with ensure_ascii=False produces the same shape.
    return "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in recs)


def make_root(tmp_path, run_id="20260826T035004Z-run", high_water=None):
    root = str(tmp_path / "loop")
    gen = {
        "schema_version": "bot-errors-checkpoint.v1",
        "run_id": run_id,
        "generation_id": GEN_ID,
        "interval": {
            "start_inclusive_utc": "2026-09-10T23:00:54Z",
            "end_exclusive_utc": GEN_ID,
            "overlap_seconds": 300,
        },
        "sources": high_water
        or {
            "whatsapp_q": {"high_water_rows": [{"pk": 100}]},
            "whatsapp_personal": {"high_water_rows": [{"pk": 200}]},
        },
    }
    gen_bytes = json.dumps(gen, indent=1) + "\n"
    _write(os.path.join(root, "checkpoint", "gen-20260911T002459Z.json"), gen_bytes)
    pointer = {
        "schema_version": "bot-errors-checkpoint-pointer.v1",
        "current_generation": "checkpoint/gen-20260911T002459Z.json",
        "generation_sha256": hashlib.sha256(gen_bytes.encode()).hexdigest(),
        "moved_at_utc": "2026-09-11T00:29:28Z",
        "recovery": "prior: none",
    }
    _write(
        os.path.join(root, "checkpoint", "CURRENT.json"),
        json.dumps(pointer, indent=1) + "\n",
    )
    _write(os.path.join(root, "QUEUE-STATUS.md"), "# ledger\n")
    return root


BODIES = [
    (
        "BOT ERROR - CRM public path DOWN\n  > severity: error\n"
        "  > incident_key: h|crm|public_path\n  > source: crm_probe"
    ),
    "\U0001f534 ↻ *Infra* · open 54d · last report: cert | expires",
    "BOT RECOVERY - CRM public path restored\n  > incident_key: h|crm|public_path",
    "[J1 supervision] Re-armed by lane\nsecond | line " + BODY_MARKER,
    "✅ *q* resolved · 3m 2s · service-health-bridge",
]


def scan_text(base_pk, sender="Name"):
    recs = [
        _rec(base_pk + i, f"AAAABBBBCCCC{i}", 1789086100 + 60 * i, body, sender=sender)
        for i, body in enumerate(BODIES, start=1)
    ]
    return _lines(recs)


PLANES_OK = (
    "=== SECTION clock ===\n2026-09-11T01:17:03Z\nSECTION_RC clock 0\n"
    "=== SECTION units-failed-listing ===\nSECTION_RC units-failed-listing 0\n"
    "=== SECTION units-per-unit ===\n--- whatsoup@q.service\nActiveState=active\nNRestarts=0\n"
    "--- bot-errors-dispatcher.service\nActiveState=active\nNRestarts=0\nSECTION_RC units-per-unit 0\n"
    "=== SECTION health ===\nhttp_code=200\nSECTION_RC health 0\n"
    "=== SECTION liveness ===\n--- q\n286503|1789086197\n--- personal\n444463|1789086198\nSECTION_RC liveness 0\n"
    "=== SECTION window-row-counts ===\n--- q\n5|101|105\n--- personal\n5|201|205\nSECTION_RC window-row-counts 0\n"
    '=== SECTION dispatcher-state ===\n{"cycleCompletedAt": "2026-09-11T00:25:04Z", "lastError": null, "pid": 1}\nSECTION_RC dispatcher-state 0\n'
    '=== SECTION incident-state ===\n{"openIncidents_len": 79, "flapState_len": 169, "updatedAt": "x"}\nSECTION_RC incident-state 0\n'
    '=== SECTION watchdog-state ===\n{"open": ["local_health:q"], "recentlyRecovered": ["supervision_deadman"], "generation": 7109, "writtenAt": "x"}\nSECTION_RC watchdog-state 0\n'
    '=== SECTION dispatch-outcomes ===\n{"by_type_24h": {"sent": 82, "suppressed": 4282, "cycle_completed": 2694}, "by_type_window": {"sent": 3, "cycle_completed": 112}, "cycle_duration_ms_window": {"n": 112, "p50": 40, "p95": 91, "max": 300}, "first_time": "2026-09-09T09:39:26Z", "last_time": "2026-09-11T01:16:58Z", "lines_24h": 46753, "lines_total": 80894, "lines_undecodable": 0, "lines_window": 1400, "log_bytes": 40593763, "log_mtime_age_s": 16, "window_end_utc": "2026-09-11T01:17:00Z", "window_start_utc": "2026-09-11T00:19:59Z"}\nSECTION_RC dispatch-outcomes 0\n'
    '=== SECTION incident-inventory ===\n{"age_days_max": 68.7, "age_days_p50": 13.4, "age_days_p90": 51.9, "flap_keys": 163, "flap_top": [{"cumulative": 1151, "key": "h|i|release-currency", "trips_in_window": 11}], "flap_trip_unit": "s", "flap_trips_in_window_total": 40, "open": 80, "renotify_total": 568, "rows_skipped": 0, "status": {"awaiting_physical": 43, "open": 37}, "suppressed_total": 25118, "top_suppressed": [{"age_days": 51.9, "key": "h|i|k", "renotify": 3, "status": "open", "suppressed": 4100}], "updatedAt": "x"}\nSECTION_RC incident-inventory 0\n'
    "=== SECTION queues ===\noutbox=0\nprocessing=0\nquarantine=42\nsent=10099\nSECTION_RC queues 0\n"
    "=== SECTION supervision-pointer ===\n838d0616700d8ca26b9f1f26cb7ad1f7f47c18469c68327c4923a0d9aed46978  CURRENT.json\n1789086568\nSECTION_RC supervision-pointer 0\n"
    "=== SECTION deployed-checkout ===\nda3c801be5a8995f9033ebebc2b150388ac0a8b9\nfix/some-branch\nSECTION_RC deployed-checkout 0\n"
    "=== SECTION end ===\n2026-09-11T01:17:04Z\n"
)

CANARY_OK = (
    "=== clock ===\n2026-09-11T00:25:44Z\n=== nonterminal ===\n0\n=== rows ===\n53|19|965\n"
    "=== occurrences ===\n20|ok|1788561638\n19|ok|1788560395\n"
)


def make_fixtures(tmp_path, planes=PLANES_OK, canary=CANARY_OK, sender="Name"):
    fx = str(tmp_path / "fx")
    _write(os.path.join(fx, "whatsapp_q.out"), scan_text(100, sender))
    _write(os.path.join(fx, "whatsapp_personal.out"), scan_text(200, sender))
    _write(os.path.join(fx, "nucles.out"), planes)
    _write(os.path.join(fx, "mini3.out"), canary)
    return fx


def snapshot(base):
    out = {}
    for d, _dirs, files in os.walk(base):
        for f in files:
            p = os.path.join(d, f)
            with open(p, "rb") as fh:
                out[os.path.relpath(p, base)] = hashlib.sha256(fh.read()).hexdigest()
    return out


def run(root, fx, now="2026-09-11T01:17:00Z"):
    return c.main(["--root", root, "--fixture-dir", fx, "--now", now])


# ------------------------------------------------------------------------------ pure helpers


def test_interval_is_half_open_with_overlap_and_refuses_inverted_end():
    now = c.parse_iso("2026-09-11T01:17:00Z")
    iv = c.interval(GEN_ID, now, 300)
    assert iv["start_inclusive_utc"] == "2026-09-11T00:19:59Z"
    assert iv["end_exclusive_utc"] == "2026-09-11T01:17:00Z"
    assert iv["end_ts"] - iv["start_ts"] == 3421
    with pytest.raises(ValueError):
        c.interval(GEN_ID, c.parse_iso("2026-09-11T00:19:00Z"), 300)


def test_expected_slot_snaps_forward_within_tolerance_else_previous_slot():
    assert c.expected_slot(c.parse_iso("2026-09-11T01:17:00Z"), 17) == (
        "2026-09-11T01:17:00Z",
        0,
    )
    # 61 s early: still this hour's slot (launchd jitter / clock step), delta negative.
    assert c.expected_slot(c.parse_iso("2026-09-11T01:15:59Z"), 17) == (
        "2026-09-11T01:17:00Z",
        -61,
    )
    # Well before the slot: the previous hour's slot, delta positive.
    assert c.expected_slot(c.parse_iso("2026-09-11T00:05:00Z"), 17) == (
        "2026-09-10T23:17:00Z",
        2880,
    )


def test_parse_rows_keeps_every_byte_inside_names_and_bodies_and_reads_null_as_empty():
    hostile = 'US\x1f RS\x1e pipe | quote " backslash \\ tab\t nl\n literal u001f ↻'
    text = _lines(
        [
            _rec(1, "AAAABBBBCCCC1", 10, hostile, sender="Ops | on\x1f-call"),
            {**_rec(2, "AAAABBBBCCCC2", 11, "x"), "body": None, "sender_name": None},
        ]
    )
    rows = c.parse_rows(text)
    assert [r["pk"] for r in rows] == [1, 2]
    assert rows[0]["sender_name"] == "Ops | on\x1f-call" and rows[0]["body"] == hostile
    assert rows[1]["body"] == "" and rows[1]["sender_name"] == ""
    assert c.parse_rows("") == [] and c.parse_rows("\n\n") == []
    rows5 = c.parse_rows(scan_text(0))
    assert [r["pk"] for r in rows5] == [1, 2, 3, 4, 5]
    assert rows5[3]["body"] == BODIES[3] and c.classify(rows5[0]["body"]) == "alert"


# Decision table for parse_rows(): one line per way a row can be undecodable. Each is counted
# as malformed (with only its raw hash), never guessed at and never silently dropped.
MALFORMED_LINES = (
    "not json at all",
    '"a json string, not an object"',
    json.dumps({**_rec(3, "AAAABBBBCCCC3", 12, "pk is text"), "pk": "3"}),
    json.dumps({**_rec(4, "AAAABBBBCCCC4", 13, "ts is text"), "timestamp": "13"}),
    json.dumps({**_rec(5, "AAAABBBBCCCC5", 14, "pk is bool"), "pk": True}),
    json.dumps({**_rec(6, "AAAABBBBCCCC6", 15, "null message id"), "message_id": None}),
    json.dumps(
        {
            k: v
            for k, v in _rec(7, "AAAABBBBCCCC7", 16, "no body").items()
            if k != "body"
        }
    ),
)


def test_parse_rows_counts_every_undecodable_line_as_malformed():
    text = (
        _lines([_rec(1, "AAAABBBBCCCC1", 10, "ok")]) + "\n".join(MALFORMED_LINES) + "\n"
    )
    rows = c.parse_rows(text)
    assert [r.get("malformed", False) for r in rows] == [False] + [True] * len(
        MALFORMED_LINES
    )
    assert all(set(r) == {"malformed", "raw_sha256"} for r in rows[1:])
    s = c.summarize(rows, 0)
    assert (s["rows_scanned"], s["rows_malformed"], s["rows_new"]) == (
        1 + len(MALFORMED_LINES),
        len(MALFORMED_LINES),
        1,
    )


# Decision table for classify(): one row per lifecycle class, both marker spellings included.
# Kept as a table so the precedence (escalation before repeat markers, storm close before open)
# is read in one place; the test walks every row and names the failing row.
CLASSIFY_TABLE = (
    ("Codex -> Q / gate nudge", "gate_nudge"),
    ("[maclab probe 2026] dispatcher DEGRADED", "maclab_probe_post"),
    ("BOT WARNING - Flap storm: x unstable", "flap_storm_open"),
    ("BOT INFO - Flap storm closed: x", "flap_storm_close"),
    ("BOT RECOVERY - x restored", "recovery"),
    ("✅ *q* resolved · 3m · src", "resolved_lifecycle"),
    ("\U0001f534 ↻ *Infra* · open 1d", "repeat_renotify"),
    (
        "BOT ERROR - BOT ERRORS heartbeat watchdog escalated: k\n> incident_still_open=true",
        "escalation_bypass_renotify",
    ),
    (
        "BOT ERROR - BOT ERRORS heartbeat watchdog escalated: k\n  > incident_still_open: true",
        "escalation_bypass_renotify",
    ),
    ("BOT ERROR - BOT ERRORS heartbeat watchdog escalated: k", "escalation_new"),
    (
        "BOT WARNING - BOT ERRORS heartbeat watchdog still open: k\n  > incident_still_open: true",
        "repeat_renotify",
    ),
    (
        "BOT WARNING - BOT ERRORS heartbeat watchdog still open: k\nincident_still_open=true",
        "repeat_renotify",
    ),
    ("BOT ERROR - x", "alert"),
    ("[J1 supervision] Re-armed", "lane_observation_post"),
    ("something else", "other"),
)


def test_classify_covers_every_lifecycle_class_and_both_marker_spellings():
    seen = set()
    for body, expected in CLASSIFY_TABLE:
        got = c.classify(body)
        assert got == expected, f"{body!r}: expected {expected}, got {got}"
        seen.add(got)
    # Every class the collector can emit is exercised by at least one row.
    assert seen == c.NOVELTY_EXCLUDED | c.ALERT_LIKE | c.REPEAT_LIKE


if HAVE_HYPOTHESIS:
    _plain = st.text(max_size=40)
    _record = st.fixed_dictionaries(
        {
            "pk": st.integers(min_value=0, max_value=10**9),
            "message_id": _plain,
            "timestamp": st.integers(min_value=0, max_value=2**31),
            "created_at": _plain,
            "sender_jid": _plain,
            "sender_name": _plain,
            "content_type": _plain,
            "is_from_me": st.sampled_from([0, 1]),
            "body": _plain,
        }
    )

    @given(records=st.lists(_record, max_size=12), prior_hw=st.integers(0, 10**9))
    @settings(max_examples=80, deadline=None)
    def test_parse_rows_roundtrips_any_text_and_summarize_accounts_every_row(
        records, prior_hw
    ):
        rows = c.parse_rows(_lines(records))
        assert [r.get("malformed", False) for r in rows] == [False] * len(records)
        assert [(r["pk"], r["message_id"], r["ts"], r["body"]) for r in rows] == [
            (rec["pk"], rec["message_id"], rec["timestamp"], rec["body"])
            for rec in records
        ]
        s = c.summarize(rows, prior_hw)
        assert (
            s["rows_scanned"]
            == s["rows_new"] + s["dedup_discarded"] + s["rows_malformed"]
        )
        assert s["rows_new"] == sum(1 for rec in records if rec["pk"] > prior_hw)
        nov = s["novelty"]
        assert nov["alert_like"] + nov["repeat_like"] + nov["excluded"] == s["rows_new"]
        assert (nov["ratio"] is None) == (nov["denominator"] == 0)


def test_summarize_reports_denominators_and_dedups_by_prior_high_water():
    rows = c.parse_rows(scan_text(0))
    s = c.summarize(rows, prior_hw_pk=2)
    assert (s["rows_scanned"], s["rows_new"], s["dedup_discarded"]) == (5, 3, 2)
    assert s["per_class"] == {
        "recovery": 1,
        "lane_observation_post": 1,
        "resolved_lifecycle": 1,
    }
    assert s["novelty"] == {
        "alert_like": 0,
        "repeat_like": 0,
        "excluded": 3,
        "denominator": 0,
        "ratio": None,
    }
    s_all = c.summarize(rows, prior_hw_pk=0)
    assert s_all["novelty"] == {
        "alert_like": 1,
        "repeat_like": 1,
        "excluded": 3,
        "denominator": 2,
        "ratio": 0.5,
    }
    assert s_all["distinct_incident_keys"] == 1 and s_all["rows_with_incident_key"] == 2


def test_parity_uses_message_ids_and_body_hash_multisets_and_ignores_malformed():
    q = c.parse_rows(scan_text(100))
    p = c.parse_rows(scan_text(200))
    par = c.parity(q, p)
    assert (
        par["message_id_intersection"] == 5 and par["body_hash_multiset_equal"] is True
    )
    par2 = c.parity(q, p[:-1] + [{"malformed": True, "raw_sha256": "x"}])
    assert par2["only_in_q"] == 1 and par2["body_hash_multiset_equal"] is False


def test_parse_planes_extracts_facts_and_nulls_failed_sections():
    facts = c.parse_planes(PLANES_OK, c.DEFAULT_UNITS)
    assert facts["failed_sections"] == [] and facts["section_rc"]["health"] == 0
    assert facts["health_http_code"] == 200
    assert facts["units"]["whatsoup@q.service"]["ActiveState"] == "active"
    assert facts["units"]["bot-errors-deadman.timer"] is None
    assert facts["units_failed_listing_rows"] == 0
    assert facts["liveness"]["q"] == [286503, 1789086197]
    assert facts["watchdog"]["recentlyRecovered"] == ["supervision_deadman"]
    assert facts["dispatch_outcomes"]["by_type_window"]["sent"] == 3
    assert facts["dispatch_outcomes"]["lines_24h"] == 46753
    assert facts["incident_inventory"]["status"] == {
        "awaiting_physical": 43,
        "open": 37,
    }
    assert facts["incident_inventory"]["flap_top"][0]["trips_in_window"] == 11
    assert facts["queues"]["quarantine"] == 42
    assert facts["supervision_pointer_sha256"].startswith("838d0616")
    assert (
        facts["deployed_head"].startswith("da3c801b")
        and facts["deployed_branch"] == "fix/some-branch"
    )
    # A failed section must not yield a confident zero.
    broken = PLANES_OK.replace(
        "SECTION_RC units-failed-listing 0", "SECTION_RC units-failed-listing 1"
    )
    broken = broken.replace("SECTION_RC health 0", "SECTION_RC health 7").replace(
        "http_code=200\n", ""
    )
    broken = broken.replace(
        "SECTION_RC dispatch-outcomes 0", "SECTION_RC dispatch-outcomes 1"
    )
    f2 = c.parse_planes(broken, c.DEFAULT_UNITS)
    assert f2["failed_sections"] == [
        "units-failed-listing",
        "health",
        "dispatch-outcomes",
    ]
    assert f2["units_failed_listing_rows"] is None and f2["health_http_code"] is None
    # A metric family whose section failed is None, never a confident empty inventory.
    assert f2["dispatch_outcomes"] is None
    assert f2["incident_inventory"]["open"] == 80
    # A pointer line whose first token is not a sha256 is not a sha.
    swapped = PLANES_OK.replace(
        "838d0616700d8ca26b9f1f26cb7ad1f7f47c18469c68327c4923a0d9aed46978  CURRENT.json\n",
        "",
    )
    assert (
        c.parse_planes(swapped, c.DEFAULT_UNITS)["supervision_pointer_sha256"] is None
    )
    empty = c.parse_planes("", c.DEFAULT_UNITS)
    assert (
        empty["health_http_code"] is None and empty["units_failed_listing_rows"] is None
    )
    assert empty["deployed_head"] is None and empty["failed_sections"] == []


def test_clock_skew_is_signed_remote_minus_local_and_none_when_unread():
    now = c.parse_iso("2026-09-11T01:17:00Z")
    assert c.clock_skew("2026-09-11T01:27:00Z", now) == 600
    assert c.clock_skew("2026-09-11T01:16:30Z", now) == -30
    assert c.clock_skew(None, now) is None and c.clock_skew("garbage", now) is None


def test_parse_canary_preserves_zero_counts_with_null_aggregates():
    f = c.parse_canary(CANARY_OK)
    assert (
        f["nonterminal"],
        f["rows_from_seq"],
        f["failed_from_seq"],
        f["max_seq"],
    ) == (0, 53, 19, 965)
    assert f["occurrences_top"][0] == ["20", "ok", "1788561638"]
    empty_window = "=== clock ===\n2026-09-11T00:25:44Z\n=== nonterminal ===\n0\n=== rows ===\n0||\n=== occurrences ===\n"
    g = c.parse_canary(empty_window)
    assert (
        g["nonterminal"],
        g["rows_from_seq"],
        g["failed_from_seq"],
        g["max_seq"],
    ) == (0, 0, None, None)
    assert c.parse_canary("")["nonterminal"] is None


def test_iso_roundtrip_and_utc_only():
    t = c.parse_iso("2026-09-11T01:17:00Z")
    assert t.tzinfo == dt.timezone.utc and c.iso(t) == "2026-09-11T01:17:00Z"


# Decision table for the cursor's high-water rule: every listed row must carry an integer pk
# (a digit string is the same number); anything else refuses the cursor instead of silently
# resetting the high water to 0 and re-counting seen rows as new.
HIGH_WATER_TABLE = (
    ([{"pk": 100}], 100),
    ([{"pk": "100"}], 100),
    ([{"pk": 7}, {"pk": "9"}], 9),
    ([], 0),
    ([{"pk": "bad"}], ValueError),
    ([{"pk": True}], ValueError),
    ([{"pk": None}], ValueError),
    ([{"pk": 1.5}], ValueError),
    (["not a row"], ValueError),
    (None, ValueError),
)


def test_cursor_high_water_accepts_integers_and_digit_strings_and_refuses_the_rest(
    tmp_path,
):
    for index, (rows, expected) in enumerate(HIGH_WATER_TABLE):
        case = tmp_path / f"case{index}"
        case.mkdir()
        sources = {
            "whatsapp_q": {"high_water_rows": rows},
            "whatsapp_personal": {"high_water_rows": [{"pk": 200}]},
        }
        root = make_root(case, high_water=sources)
        if expected is ValueError:
            with pytest.raises(ValueError):
                c.read_cursor(root)
        else:
            assert c.read_cursor(root)["high_water"] == {
                "whatsapp_q": expected,
                "whatsapp_personal": 200,
            }, f"case {index}: {rows!r}"


# ------------------------------------------------------------------------- end to end (fixture)


def test_end_to_end_writes_exactly_the_declared_set_and_prints_no_bodies(
    tmp_path, capsys
):
    root = make_root(tmp_path)
    fx = make_fixtures(tmp_path)
    before = snapshot(str(tmp_path))
    assert run(root, fx) == 0
    out = capsys.readouterr().out
    assert BODY_MARKER not in out and "CRM public path" not in out
    after = snapshot(str(tmp_path))
    for path, digest in before.items():
        assert after[path] == digest, f"pre-existing file changed: {path}"
    new = sorted(set(after) - set(before))
    assert new == [
        "loop/monitors/state/.collect.lock",
        "loop/runs/20260826T035004Z-run/collect/20260911T011700Z/mini3.out",
        "loop/runs/20260826T035004Z-run/collect/20260911T011700Z/nucles.out",
        "loop/runs/20260826T035004Z-run/collect/20260911T011700Z/whatsapp_personal.out",
        "loop/runs/20260826T035004Z-run/collect/20260911T011700Z/whatsapp_q.out",
        "loop/runs/20260826T035004Z-run/collect/collect-20260911T011700Z.json",
        "loop/supervision/COLLECTOR.json",
    ]
    rec_dir = os.path.join(root, "runs/20260826T035004Z-run/collect/20260911T011700Z")
    assert stat.S_IMODE(os.stat(rec_dir).st_mode) == 0o700
    for name in os.listdir(rec_dir):
        assert stat.S_IMODE(os.stat(os.path.join(rec_dir, name)).st_mode) == 0o600
    bundle_path = os.path.join(
        root, "runs/20260826T035004Z-run/collect/collect-20260911T011700Z.json"
    )
    assert stat.S_IMODE(os.stat(bundle_path).st_mode) == 0o600
    with open(bundle_path, encoding="utf-8") as f:
        bundle = json.load(f)
    assert bundle["schema_version"] == "1.2" and bundle["kind"] == c.BUNDLE_KIND
    assert bundle["metrics"]["measurement_mode"] == "live"
    assert bundle["metrics"]["dispatch_outcomes"]["lines_window"] == 1400
    assert bundle["metrics"]["incident_inventory"]["suppressed_total"] == 25118
    assert bundle["complete"] is False and bundle["collection_status"] == "collected"
    assert bundle["collector"]["mode"] == "fixture"
    assert bundle["sources"]["whatsapp_q"]["rows_new"] == 5
    assert bundle["sources"]["whatsapp_q"]["rows_malformed"] == 0
    assert bundle["sources"]["whatsapp_q"]["prior_high_water_pk"] == 100
    assert (
        bundle["sources"]["whatsapp_q"]["receipt_encoding"] == c.SCAN_RECEIPT_ENCODING
    )
    assert bundle["sources"]["gmail"]["status"] == "not_collected"
    assert bundle["parity"]["body_hash_multiset_equal"] is True
    assert bundle["planes"]["alert_host"]["facts"]["health_http_code"] == 200
    assert bundle["collector"]["slot_expected_utc"] == "2026-09-11T01:17:00Z"
    assert (
        bundle["collector"]["clock_skew_seconds"] == 3
        and bundle["collector"]["clock_skew_flag"] is False
    )
    assert bundle["redaction"] == c.REDACTION
    with open(os.path.join(root, "supervision/COLLECTOR.json"), encoding="utf-8") as f:
        ptr = json.load(f)
    assert ptr["kind"] == c.POINTER_KIND and ptr["previous_bundle"] is None
    assert (
        ptr["bundle_sha256"]
        == hashlib.sha256(open(bundle_path, "rb").read()).hexdigest()
    )
    assert run(root, fx, now="2026-09-11T02:17:00Z") == 0
    with open(os.path.join(root, "supervision/COLLECTOR.json"), encoding="utf-8") as f:
        ptr2 = json.load(f)
    assert (
        ptr2["previous_bundle"] == ptr["current_bundle"]
        and ptr2["previous_sha256"] == ptr["bundle_sha256"]
    )
    assert ptr2["previous_corrupt"] is False


def test_failed_plane_section_yields_partial_with_facts_kept(tmp_path, capsys):
    planes = PLANES_OK.replace("SECTION_RC queues 0", "SECTION_RC queues 1")
    root = make_root(tmp_path)
    fx = make_fixtures(tmp_path, planes=planes)
    assert run(root, fx) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["collection_status"] == "partial" and out["failed_sections"] == [
        "queues"
    ]
    with open(os.path.join(root, out["bundle"]), encoding="utf-8") as f:
        bundle = json.load(f)
    facts = bundle["planes"]["alert_host"]["facts"]
    assert facts["queues"] == {} and facts["health_http_code"] == 200
    assert out["metrics_families"] == ["dispatch_outcomes", "incident_inventory"]


def test_failed_metric_section_yields_partial_and_a_null_family(tmp_path, capsys):
    planes = PLANES_OK.replace(
        "SECTION_RC incident-inventory 0", "SECTION_RC incident-inventory 1"
    )
    root = make_root(tmp_path)
    fx = make_fixtures(tmp_path, planes=planes)
    assert run(root, fx) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["collection_status"] == "partial"
    assert out["failed_sections"] == ["incident-inventory"]
    assert out["metrics_families"] == ["dispatch_outcomes"]
    with open(os.path.join(root, out["bundle"]), encoding="utf-8") as f:
        bundle = json.load(f)
    assert bundle["metrics"]["incident_inventory"] is None
    assert bundle["metrics"]["dispatch_outcomes"]["lines_24h"] == 46753


def test_failed_store_scan_is_failed_not_partial(tmp_path, capsys):
    root = make_root(tmp_path)
    fx = make_fixtures(tmp_path)
    os.unlink(os.path.join(fx, "whatsapp_personal.out"))
    assert run(root, fx) == 0
    out = json.loads(capsys.readouterr().out)
    assert (
        out["collection_status"] == "failed"
        and out["sources"]["whatsapp_personal"] == "failed"
    )
    with open(os.path.join(root, out["bundle"]), encoding="utf-8") as f:
        bundle = json.load(f)
    assert bundle["parity"] is None and bundle["complete"] is False


def test_undecodable_scan_rows_are_counted_and_downgrade_the_bundle_to_partial(
    tmp_path, capsys
):
    root = make_root(tmp_path)
    fx = make_fixtures(tmp_path)
    with open(os.path.join(fx, "whatsapp_q.out"), "a", encoding="utf-8") as f:
        f.write("garbage line that is not a row\n")
    assert run(root, fx) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["collection_status"] == "partial"
    assert out["sources"] == {
        "whatsapp_q": "partial",
        "whatsapp_personal": "collected",
        "gmail": "not_collected",
    }
    with open(os.path.join(root, out["bundle"]), encoding="utf-8") as f:
        bundle = json.load(f)
    q = bundle["sources"]["whatsapp_q"]
    assert (q["rows_scanned"], q["rows_malformed"], q["rows_new"]) == (6, 1, 5)
    # The decodable rows still take part in parity; the malformed one is not guessed into it.
    assert bundle["parity"]["body_hash_multiset_equal"] is True
    assert bundle["failures"] == []


def test_missing_canary_yields_partial_not_a_crash(tmp_path):
    root = make_root(tmp_path)
    fx = make_fixtures(tmp_path)
    os.unlink(os.path.join(fx, "mini3.out"))
    assert run(root, fx) == 0
    with open(os.path.join(root, "supervision/COLLECTOR.json"), encoding="utf-8") as f:
        ptr = json.load(f)
    assert ptr["collection_status"] == "partial"
    with open(os.path.join(root, ptr["current_bundle"]), encoding="utf-8") as f:
        bundle = json.load(f)
    assert (
        bundle["planes"]["canary"]["status"] == "failed"
        and bundle["failures"][0]["receipt"] == "mini3.out"
    )


def test_corrupt_pointer_is_recorded_not_fatal(tmp_path):
    root = make_root(tmp_path)
    fx = make_fixtures(tmp_path)
    _write(os.path.join(root, "supervision", "COLLECTOR.json"), "{not json")
    assert run(root, fx) == 0
    with open(os.path.join(root, "supervision/COLLECTOR.json"), encoding="utf-8") as f:
        ptr = json.load(f)
    assert ptr["previous_corrupt"] is True and ptr["previous_bundle"] is None


def test_tampered_cursor_blocks_before_any_write(tmp_path, capsys):
    root = make_root(tmp_path)
    fx = make_fixtures(tmp_path)
    gen = os.path.join(root, "checkpoint", "gen-20260911T002459Z.json")
    with open(gen, "a", encoding="utf-8") as f:
        f.write("\n")
    before = snapshot(str(tmp_path))
    assert run(root, fx) == 2
    assert json.loads(capsys.readouterr().out)["class"] == "cursor-or-io"
    after = snapshot(str(tmp_path))
    assert {
        k: v for k, v in after.items() if k != "loop/monitors/state/.collect.lock"
    } == before
    assert not os.path.isdir(os.path.join(root, "runs")) and not os.path.exists(
        os.path.join(root, "supervision")
    )


HOSTILE_RUN_IDS = ("../../../escape", "/etc/cron.d", "../checkpoint", 7, "a b")


def test_hostile_run_id_is_refused_before_any_write(tmp_path, capsys):
    for index, run_id in enumerate(HOSTILE_RUN_IDS):
        case = tmp_path / f"case{index}"
        case.mkdir()
        root = make_root(case, run_id=run_id)
        fx = make_fixtures(case)
        before = snapshot(str(case))
        assert run(root, fx) == 2, f"run_id {run_id!r} was not refused"
        assert json.loads(capsys.readouterr().out)["class"] == "cursor-or-io"
        after = snapshot(str(case))
        assert {
            k: v for k, v in after.items() if k != "loop/monitors/state/.collect.lock"
        } == before, f"run_id {run_id!r} wrote outside the lock file"
        assert not os.path.exists(os.path.join(case, "escape"))
        assert not os.path.isdir(os.path.join(root, "runs"))


def test_generation_path_must_stay_under_root(tmp_path, capsys):
    root = make_root(tmp_path)
    fx = make_fixtures(tmp_path)
    outside = str(tmp_path / "outside.json")
    _write(outside, "{}")
    ptr_path = os.path.join(root, "checkpoint", "CURRENT.json")
    with open(ptr_path, encoding="utf-8") as f:
        ptr = json.load(f)
    for bad in [outside, "../outside.json", "checkpoint/../../outside.json"]:
        ptr["current_generation"] = bad
        _write(ptr_path, json.dumps(ptr))
        assert run(root, fx) == 2
        assert json.loads(capsys.readouterr().out)["class"] == "cursor-or-io"


def test_live_requires_flag_and_safe_arguments(tmp_path, capsys):
    root = make_root(tmp_path)
    assert c.main(["--root", root, "--group-jid", "12345@g.us"]) == 2
    assert json.loads(capsys.readouterr().out)["class"] == "live-not-requested"
    for bad in ["1234", "123 456@g.us", "x@g.us; rm -rf /", "a'b@g.us", "$(id)@g.us"]:
        assert c.main(["--root", root, "--live", "--group-jid", bad]) == 2
        assert json.loads(capsys.readouterr().out)["class"] == "group-jid-invalid"
    assert (
        c.main(
            [
                "--root",
                root,
                "--live",
                "--group-jid",
                "12345@g.us",
                "--canary-instance",
                "yl bot",
            ]
        )
        == 2
    )
    assert json.loads(capsys.readouterr().out)["class"] == "host-or-instance-invalid"
    assert (
        c.main(
            [
                "--root",
                root,
                "--live",
                "--group-jid",
                "12345@g.us",
                "--alert-host",
                "nucles;id",
            ]
        )
        == 2
    )
    assert json.loads(capsys.readouterr().out)["class"] == "host-or-instance-invalid"
    assert (
        c.main(["--root", str(tmp_path / "nowhere"), "--fixture-dir", str(tmp_path)])
        == 2
    )
    assert json.loads(capsys.readouterr().out)["class"] == "root-unusable"
    # An empty or missing fixture directory (a blank shell variable) is refused before any
    # backend is chosen: it must never fall through to the ssh backend without --live.
    for bad_dir in ["", str(tmp_path / "no-such-fixtures")]:
        assert c.main(["--root", root, "--fixture-dir", bad_dir]) == 2, repr(bad_dir)
        assert json.loads(capsys.readouterr().out)["class"] == "fixture-dir-invalid"
        assert not os.path.isdir(os.path.join(root, "runs"))
    # The backend predicate is "no fixture directory at all", never truthiness.
    assert c.Remote(None, 1).live is True and c.Remote("", 1).live is False


def test_lock_held_by_another_collector_skips_with_exit_3(tmp_path, capsys):
    root = make_root(tmp_path)
    fx = make_fixtures(tmp_path)
    lock_dir = os.path.join(root, "monitors", "state")
    os.makedirs(lock_dir, exist_ok=True)
    fd = os.open(os.path.join(lock_dir, ".collect.lock"), os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        assert run(root, fx) == 3
        assert json.loads(capsys.readouterr().out)["class"] == "lock-held"
        assert not os.path.isdir(os.path.join(root, "runs"))
    finally:
        os.close(fd)
    assert run(root, fx) == 0


def test_replace_atomic_leaves_no_temp_on_success_and_tolerates_stale_temp(tmp_path):
    target = str(tmp_path / "ptr.json")
    stale = str(tmp_path / ".tmp-stale")
    _write(stale, "old")
    c.replace_atomic(target, b"{}\n")
    assert open(target, "rb").read() == b"{}\n"
    assert stat.S_IMODE(os.stat(target).st_mode) == 0o600
    assert sorted(os.listdir(tmp_path)) == [".tmp-stale", "ptr.json"]
