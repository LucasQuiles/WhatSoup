#!/usr/bin/env python3
"""Contract tests for the BOT ERRORS J1 unattended collector (read-only, no publication)."""

import datetime as dt
import hashlib
import json
import os
import stat
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bot_errors_j1_collector as c  # noqa: E402

GEN_ID = "2026-09-11T00:24:59Z"


def _write(path, data, mode=0o600):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(data)
    os.chmod(path, mode)


def _row(pk, mid, ts, body, is_from_me=0):
    return f"{pk}|{mid}|{ts}|2026-09-11 00:00:00|sender@x|Name|text|{is_from_me}|{body}"


def make_root(tmp_path):
    root = str(tmp_path / "loop")
    gen = {
        "schema_version": "bot-errors-checkpoint.v1",
        "run_id": "20260826T035004Z-run",
        "generation_id": GEN_ID,
        "interval": {
            "start_inclusive_utc": "2026-09-10T23:00:54Z",
            "end_exclusive_utc": GEN_ID,
            "overlap_seconds": 300,
        },
        "sources": {
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


def make_fixtures(tmp_path):
    fx = str(tmp_path / "fx")
    q_rows = (
        "\n".join(
            [
                _row(
                    101,
                    "AAAABBBBCCCC1",
                    1789086100,
                    "BOT ERROR - CRM public path DOWN\n  > severity: error\n  > incident_key: h|crm|public_path\n  > source: crm_probe",
                ),
                _row(
                    102,
                    "AAAABBBBCCCC2",
                    1789086160,
                    "\U0001f534 ↻ *Infra* · open 54d · last report: cert | expires",
                ),
                _row(
                    103,
                    "AAAABBBBCCCC3",
                    1789086200,
                    "BOT RECOVERY - CRM public path restored\n  > incident_key: h|crm|public_path",
                ),
                _row(
                    104,
                    "AAAABBBBCCCC4",
                    1789086300,
                    "[J1 supervision] Re-armed by lane\nsecond line",
                ),
                _row(
                    105,
                    "AAAABBBBCCCC5",
                    1789086400,
                    "✅ *q* resolved · 3m 2s · service-health-bridge",
                ),
            ]
        )
        + "\n"
    )
    p_rows = (
        "\n".join(
            [
                _row(
                    201,
                    "AAAABBBBCCCC1",
                    1789086100,
                    "BOT ERROR - CRM public path DOWN\n  > severity: error\n  > incident_key: h|crm|public_path\n  > source: crm_probe",
                ),
                _row(
                    202,
                    "AAAABBBBCCCC2",
                    1789086160,
                    "\U0001f534 ↻ *Infra* · open 54d · last report: cert | expires",
                ),
                _row(
                    203,
                    "AAAABBBBCCCC3",
                    1789086200,
                    "BOT RECOVERY - CRM public path restored\n  > incident_key: h|crm|public_path",
                ),
                _row(
                    204,
                    "AAAABBBBCCCC4",
                    1789086300,
                    "[J1 supervision] Re-armed by lane\nsecond line",
                ),
                _row(
                    205,
                    "AAAABBBBCCCC5",
                    1789086400,
                    "✅ *q* resolved · 3m 2s · service-health-bridge",
                ),
            ]
        )
        + "\n"
    )
    planes = (
        "=== SECTION clock ===\n2026-09-11T00:25:15Z\n"
        "=== SECTION units-failed-listing ===\n"
        "=== SECTION units-per-unit ===\n--- whatsoup@q.service\nActiveState=active\nNRestarts=0\n"
        "--- bot-errors-dispatcher.service\nActiveState=active\nNRestarts=0\n"
        "=== SECTION health ===\nhttp_code=200\n"
        "=== SECTION liveness ===\n--- q\n286503|1789086197\n--- personal\n444463|1789086198\n"
        "=== SECTION window-row-counts ===\n--- q\n5|101|105\n--- personal\n5|201|205\n"
        '=== SECTION dispatcher-state ===\n{"cycleCompletedAt": "2026-09-11T00:25:04Z", "lastError": null, "pid": 1}\n'
        '=== SECTION incident-state ===\n{"openIncidents_len": 79, "flapState_len": 169, "updatedAt": "x"}\n'
        '=== SECTION watchdog-state ===\n{"open": ["local_health:q"], "recentlyRecovered": ["supervision_deadman"], "generation": 7109, "writtenAt": "x"}\n'
        "=== SECTION queues ===\noutbox=0\nprocessing=0\nquarantine=42\nsent=10099\n"
        "=== SECTION supervision-pointer ===\n838d0616700d8ca26b9f1f26cb7ad1f7f47c18469c68327c4923a0d9aed46978  CURRENT.json\n1789086568\n"
        "=== SECTION deployed-checkout ===\nda3c801be5a8995f9033ebebc2b150388ac0a8b9\nfix/some-branch\n"
        "=== SECTION end ===\n2026-09-11T00:25:16Z\n"
    )
    canary = (
        "=== clock ===\n2026-09-11T00:25:44Z\n=== nonterminal ===\n0\n=== rows ===\n53|19|965\n"
        "=== occurrences ===\n20|ok|1788561638\n19|ok|1788560395\n"
    )
    _write(os.path.join(fx, "whatsapp_q.out"), q_rows)
    _write(os.path.join(fx, "whatsapp_personal.out"), p_rows)
    _write(os.path.join(fx, "nucles.out"), planes)
    _write(os.path.join(fx, "mini3.out"), canary)
    return fx


def snapshot(root):
    out = {}
    for base, _dirs, files in os.walk(root):
        for f in files:
            p = os.path.join(base, f)
            with open(p, "rb") as fh:
                out[os.path.relpath(p, root)] = hashlib.sha256(fh.read()).hexdigest()
    return out


def test_interval_is_half_open_with_overlap_and_refuses_inverted_end():
    now = c.parse_iso("2026-09-11T01:17:00Z")
    iv = c.interval(GEN_ID, now, 300)
    assert iv["start_inclusive_utc"] == "2026-09-11T00:19:59Z"
    assert iv["end_exclusive_utc"] == "2026-09-11T01:17:00Z"
    assert iv["end_ts"] - iv["start_ts"] == 3421
    with pytest.raises(ValueError):
        c.interval(GEN_ID, c.parse_iso("2026-09-11T00:19:00Z"), 300)


def test_expected_slot_is_latest_slot_at_or_before_now():
    assert (
        c.expected_slot(c.parse_iso("2026-09-11T01:17:00Z"), 17)
        == "2026-09-11T01:17:00Z"
    )
    assert (
        c.expected_slot(c.parse_iso("2026-09-11T01:16:59Z"), 17)
        == "2026-09-11T00:17:00Z"
    )
    assert (
        c.expected_slot(c.parse_iso("2026-09-11T00:05:00Z"), 17)
        == "2026-09-10T23:17:00Z"
    )


def test_parse_rows_keeps_multiline_bodies_and_pipes_inside_bodies():
    text = (
        _row(1, "AAAABBBBCCCC1", 10, "head | with pipe\nsecond | line")
        + "\n"
        + _row(2, "AAAABBBBCCCC2", 11, "x")
        + "\n"
    )
    rows = c.parse_rows(text)
    assert [r["pk"] for r in rows] == [1, 2]
    assert rows[0]["body"] == "head | with pipe\nsecond | line"


@pytest.mark.parametrize(
    "body,expected",
    [
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
        ("BOT ERROR - BOT ERRORS heartbeat watchdog escalated: k", "escalation_new"),
        ("BOT ERROR - x", "alert"),
        ("[J1 supervision] Re-armed", "lane_observation_post"),
        ("something else", "other"),
    ],
)
def test_classify_covers_every_lifecycle_class(body, expected):
    assert c.classify(body) == expected


def test_summarize_reports_denominators_and_dedups_by_prior_high_water(tmp_path):
    fx = make_fixtures(tmp_path)
    with open(os.path.join(fx, "whatsapp_q.out"), encoding="utf-8") as f:
        rows = c.parse_rows(f.read())
    s = c.summarize(rows, prior_hw_pk=102)
    assert (s["rows_scanned"], s["rows_new"], s["dedup_discarded"]) == (5, 3, 2)
    assert s["per_class"] == {
        "recovery": 1,
        "lane_observation_post": 1,
        "resolved_lifecycle": 1,
    }
    assert s["novelty"] == {
        "alert_like": 0,
        "repeat_like": 0,
        "denominator": 0,
        "ratio": None,
    }
    s_all = c.summarize(rows, prior_hw_pk=0)
    assert s_all["novelty"] == {
        "alert_like": 1,
        "repeat_like": 1,
        "denominator": 2,
        "ratio": 0.5,
    }
    assert s_all["distinct_incident_keys"] == 1 and s_all["rows_with_incident_key"] == 2


def test_parity_uses_message_ids_and_body_hash_multisets(tmp_path):
    fx = make_fixtures(tmp_path)
    with open(os.path.join(fx, "whatsapp_q.out"), encoding="utf-8") as f:
        q = c.parse_rows(f.read())
    with open(os.path.join(fx, "whatsapp_personal.out"), encoding="utf-8") as f:
        p = c.parse_rows(f.read())
    par = c.parity(q, p)
    assert (
        par["message_id_intersection"] == 5 and par["body_hash_multiset_equal"] is True
    )
    par2 = c.parity(q, p[:-1])
    assert par2["only_in_q"] == 1 and par2["body_hash_multiset_equal"] is False


def test_parse_planes_extracts_facts_and_leaves_missing_sections_none(tmp_path):
    fx = make_fixtures(tmp_path)
    with open(os.path.join(fx, "nucles.out"), encoding="utf-8") as f:
        facts = c.parse_planes(f.read(), c.DEFAULT_UNITS)
    assert facts["health_http_code"] == 200
    assert facts["units"]["whatsoup@q.service"]["ActiveState"] == "active"
    assert facts["units"]["bot-errors-deadman.timer"] is None
    assert facts["units_failed_listing_rows"] == 0
    assert facts["liveness"]["q"] == [286503, 1789086197]
    assert facts["watchdog"]["recentlyRecovered"] == ["supervision_deadman"]
    assert facts["queues"]["quarantine"] == 42
    assert facts["supervision_pointer_sha256"].startswith("838d0616")
    assert (
        facts["deployed_head"].startswith("da3c801b")
        and facts["deployed_branch"] == "fix/some-branch"
    )
    empty = c.parse_planes("", c.DEFAULT_UNITS)
    assert (
        empty["health_http_code"] is None and empty["units_failed_listing_rows"] is None
    )
    assert empty["deployed_head"] is None


def test_parse_canary():
    text = "=== clock ===\n2026-09-11T00:25:44Z\n=== nonterminal ===\n0\n=== rows ===\n53|19|965\n=== occurrences ===\n20|ok|1\n"
    f = c.parse_canary(text)
    assert (
        f["nonterminal"],
        f["rows_from_seq"],
        f["failed_from_seq"],
        f["max_seq"],
    ) == (0, 53, 19, 965)
    assert f["occurrences_top"] == [["20", "ok", "1"]]
    assert c.parse_canary("")["nonterminal"] is None


def test_end_to_end_writes_bundle_and_pointer_and_touches_nothing_else(tmp_path):
    root = make_root(tmp_path)
    fx = make_fixtures(tmp_path)
    before = snapshot(root)
    rc = c.main(["--root", root, "--fixture-dir", fx, "--now", "2026-09-11T01:17:00Z"])
    assert rc == 0
    after = snapshot(root)
    for path, digest in before.items():
        assert after[path] == digest, f"pre-existing file changed: {path}"
    new = sorted(set(after) - set(before))
    assert new == [
        "monitors/state/.collect.lock",
        "runs/20260826T035004Z-run/collect/20260911T011700Z/mini3.out",
        "runs/20260826T035004Z-run/collect/20260911T011700Z/nucles.out",
        "runs/20260826T035004Z-run/collect/20260911T011700Z/whatsapp_personal.out",
        "runs/20260826T035004Z-run/collect/20260911T011700Z/whatsapp_q.out",
        "runs/20260826T035004Z-run/collect/collect-20260911T011700Z.json",
        "supervision/COLLECTOR.json",
    ]
    assert not any(p.startswith("checkpoint/.lease") for p in new)
    bundle_path = os.path.join(
        root, "runs/20260826T035004Z-run/collect/collect-20260911T011700Z.json"
    )
    assert stat.S_IMODE(os.stat(bundle_path).st_mode) == 0o600
    with open(bundle_path, encoding="utf-8") as f:
        bundle = json.load(f)
    assert bundle["complete"] is False and bundle["collection_status"] == "collected"
    assert bundle["sources"]["whatsapp_q"]["rows_new"] == 5
    assert bundle["sources"]["whatsapp_q"]["prior_high_water_pk"] == 100
    assert bundle["sources"]["gmail"]["status"] == "not_collected"
    assert bundle["parity"]["body_hash_multiset_equal"] is True
    assert bundle["planes"]["alert_host"]["facts"]["health_http_code"] == 200
    assert bundle["collector"]["slot_expected_utc"] == "2026-09-11T01:17:00Z"
    with open(os.path.join(root, "supervision/COLLECTOR.json"), encoding="utf-8") as f:
        ptr = json.load(f)
    assert ptr["schema_version"] == c.POINTER_SCHEMA
    assert (
        ptr["bundle_sha256"]
        == hashlib.sha256(open(bundle_path, "rb").read()).hexdigest()
    )
    assert ptr["previous_bundle"] is None
    rc2 = c.main(["--root", root, "--fixture-dir", fx, "--now", "2026-09-11T02:17:00Z"])
    assert rc2 == 0
    with open(os.path.join(root, "supervision/COLLECTOR.json"), encoding="utf-8") as f:
        ptr2 = json.load(f)
    assert (
        ptr2["previous_bundle"] == ptr["current_bundle"]
        and ptr2["previous_sha256"] == ptr["bundle_sha256"]
    )


def test_missing_fixture_yields_partial_bundle_not_a_crash(tmp_path):
    root = make_root(tmp_path)
    fx = make_fixtures(tmp_path)
    os.unlink(os.path.join(fx, "mini3.out"))
    rc = c.main(["--root", root, "--fixture-dir", fx, "--now", "2026-09-11T01:17:00Z"])
    assert rc == 0
    with open(os.path.join(root, "supervision/COLLECTOR.json"), encoding="utf-8") as f:
        ptr = json.load(f)
    assert ptr["collection_status"] == "partial"
    with open(os.path.join(root, ptr["current_bundle"]), encoding="utf-8") as f:
        bundle = json.load(f)
    assert (
        bundle["planes"]["canary"]["status"] == "failed"
        and bundle["failures"][0]["receipt"] == "mini3.out"
    )


def test_tampered_cursor_blocks_before_any_write(tmp_path):
    root = make_root(tmp_path)
    fx = make_fixtures(tmp_path)
    gen = os.path.join(root, "checkpoint", "gen-20260911T002459Z.json")
    with open(gen, "a", encoding="utf-8") as f:
        f.write("\n")
    before = snapshot(root)
    rc = c.main(["--root", root, "--fixture-dir", fx, "--now", "2026-09-11T01:17:00Z"])
    assert rc == 2
    after = snapshot(root)
    assert {
        k: v for k, v in after.items() if k != "monitors/state/.collect.lock"
    } == before
    assert not os.path.isdir(os.path.join(root, "runs")) and not os.path.exists(
        os.path.join(root, "supervision")
    )


def test_unusable_root_and_missing_jid_are_refused(tmp_path):
    assert (
        c.main(["--root", str(tmp_path / "nowhere"), "--fixture-dir", str(tmp_path)])
        == 2
    )
    root = make_root(tmp_path)
    assert c.main(["--root", root]) == 2  # no jid and no fixtures


def test_iso_roundtrip_and_utc_only():
    t = c.parse_iso("2026-09-11T01:17:00Z")
    assert t.tzinfo == dt.timezone.utc and c.iso(t) == "2026-09-11T01:17:00Z"
