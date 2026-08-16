#!/usr/bin/env python3
"""Fleet ground-truth panel — one call, one instance, the non-circular picture.

Reliability-program Pillar 1 (see the proxy-vs-ground-truth table in
docs and ~/Documents/ops-audits/fleet-reliability-program-2026-08-16.md rev 2).
Every fleet misdiagnosis on record is the same error: a PROXY read as truth
(local creds file vs server bond; a cached usability verdict vs a fresh probe;
an emit counter vs a state transition; the public /health envelope vs the
authed diagnostic). This tool renders the authoritative signal on each axis,
timestamps every observation, and applies the program's evidence-ordering rule:
NEWER evidence supersedes older on a contradiction — no single field (including
outbound message flow) overrides a fresher contradicting probe.

Axes (each with its authoritative source):
  bond   — authed /health whatsapp.connection (terminal 401/serverside logout
           reads "physical re-pair required; restart will not fix")
  model  — authed /health instance.primaryModelUsability (+ checkedAt AGE:
           a fresh failed probe is genuine; a stale verdict suspects the probe)
  flow   — messages table counts/timestamps ONLY (PII-safe; proves serving
           strictly *as of* its own timestamp)
  flap   — dispatcher flapState cumulative-vs-window ratio (steady persistent
           condition vs genuine burst — the 728/1 vs 5/5 discriminator)

Missing evidence is reported UNOBSERVED, never guessed: absence is not
evidence. The panel is PII-safe by construction — counts, timestamps and
status enums only; message content never enters the data model.

Usage:
  fleet-ground-truth.py --instance ad-bot [--port 9096] [--json]
  (local mode: reads the instance token from ~/.config/whatsoup/instances/
  <name>/tokens.env and queries http://127.0.0.1:<port>/health; run it ON the
  bot host — over ssh if operating remotely — so tokens never leave the host.)

The build_panel() core is pure and deterministic for unit tests; only the
adapters at the bottom do I/O.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any, Optional

HOUR_MS = 3_600_000
DAY_MS = 24 * HOUR_MS

# A primaryModelUsability verdict older than this is treated as STALE: the
# periodic re-probe runs on a sub-hour cadence in production (observed 30-67min,
# runtime-fallback.ts periodic probe), so a verdict >2h old means the probe
# path itself is suspect — the credential may be fine.
PROBE_FRESH_MS = 2 * HOUR_MS

# Idle horizon: no inbound AND no outbound inside this window → the bot has no
# live turns, so runtime verdicts are probe-derived (failures are LATENT).
IDLE_HORIZON_MS = 7 * DAY_MS

# Flap discriminator: cumulative >> window with a near-empty window is a
# persistent steady condition surfacing through a throttled re-emit (a
# monitoring artifact — ml-bot's 728/1); cumulative ≈ window is a genuine
# burst (yl-bot's 5/5).
FLAP_PERSISTENT_RATIO = 20
FLAP_BURST_RATIO = 3

# PII-safe flow query: counts and timestamps grouped by direction — no content
# column, no chat identifiers. timestamp is epoch-SECONDS in the messages table.
FLOW_QUERY = (
    "SELECT is_from_me, COUNT(*) AS n, MAX(timestamp) AS latest, "
    "SUM(CASE WHEN timestamp > :since THEN 1 ELSE 0 END) AS recent "
    "FROM messages GROUP BY is_from_me"
)


# /health answers 200 on BOTH legs: with a valid instance token it returns the
# privileged diagnostic body, and WITHOUT one it returns a public envelope whose
# status field is hardcoded-shaped and can read "healthy" while the privileged
# body of the same process reads "degraded" (live-confirmed 2026-08-16 on a
# production instance via a valid/bogus/absent three-leg compare against one
# process; raw bodies held in the operator evidence archive, not in this repo).
# The panel must never
# mistake a non-disclosing answer for a clean one, so detect the envelope and
# mark the axes UNOBSERVED rather than deriving all-None axes from it.
PUBLIC_SCHEMA_PREFIX = "health.public."


def _verdict(axis: str, verdict: str, because: str, evidence_ms: dict) -> dict:
    return {"axis": axis, "verdict": verdict, "because": because,
            "evidence_ms": evidence_ms}


def health_body_is_disclosed(health: dict) -> bool:
    """True only for the privileged diagnostic body.

    Fail-closed: an unrecognised shape counts as NOT disclosed. Both axes this
    panel derives read `whatsapp` / `instance`, which the public envelope omits
    entirely, so its absence is the deterministic discriminator.
    """
    schema = health.get("schema_version")
    if isinstance(schema, str) and schema.startswith(PUBLIC_SCHEMA_PREFIX):
        return False
    return "whatsapp" in health


def _bond_axis(health: dict, now_ms: int, verdicts: list) -> dict:
    wa = health.get("whatsapp") or {}
    conn = wa.get("connection") or {}
    axis = {
        "connected": wa.get("connected"),
        "state": conn.get("state"),
        "auth_failure_class": conn.get("auth_failure_class"),
        "last_status_code": conn.get("last_status_code"),
        "observed_at_ms": health.get("generated_at_ms"),
    }
    terminal = (
        conn.get("auth_failure_class") == "serverside_logout_irreversible"
        or (wa.get("connected") is False and conn.get("last_status_code") == 401)
    )
    if terminal:
        verdicts.append(_verdict(
            "bond", "needs_physical_repair",
            "server revoked the linked-device bond (401/serverside_logout_"
            "irreversible): restart_will_not_fix — a human must re-pair via "
            "QR/pairing-code on the primary phone",
            {"observed_at_ms": axis["observed_at_ms"]},
        ))
    return axis


def _model_axis(health: dict, now_ms: int, verdicts: list) -> dict:
    inst = health.get("instance") or {}
    pmu = inst.get("primaryModelUsability") or {}
    checked_at = pmu.get("checkedAt")
    age_ms = (now_ms - checked_at) if isinstance(checked_at, (int, float)) else None
    axis = {
        "status": pmu.get("status"),
        "checked_at_ms": checked_at,
        "checked_age_ms": age_ms,
        "probe_in_flight": pmu.get("probeInFlight"),
        "effective_provider": inst.get("effectiveProvider"),
        "fallback_reason": inst.get("fallbackReason"),
        "observed_at_ms": checked_at,
    }
    if pmu.get("status") == "credential-unavailable":
        if age_ms is not None and age_ms <= PROBE_FRESH_MS:
            verdicts.append(_verdict(
                "model", "credential_unavailable_genuine",
                "the periodic usability probe is FRESH and repeatedly finds the "
                "credential unavailable at runtime — this is a genuine "
                "credential failure, not a stale verdict",
                {"checked_at_ms": checked_at, "age_ms": age_ms},
            ))
        else:
            verdicts.append(_verdict(
                "model", "model_verdict_stale_suspect_probe",
                "the usability verdict is STALE (probe not re-running on its "
                "expected cadence) — suspect the probe path before the "
                "credential; re-observe before acting",
                {"checked_at_ms": checked_at, "age_ms": age_ms},
            ))
    return axis


def _flow_axis(flow: dict, now_ms: int, verdicts: list) -> dict:
    axis = dict(flow)
    last_out = flow.get("last_outbound_ms")
    last_in = flow.get("last_inbound_ms")
    newest = max([t for t in (last_out, last_in) if t is not None], default=None)
    idle = newest is None or (now_ms - newest) > IDLE_HORIZON_MS
    axis["idle"] = idle
    if idle:
        verdicts.append(_verdict(
            "flow", "latent_while_idle",
            "no inbound or outbound traffic inside the idle horizon: runtime "
            "verdicts here are probe-derived; failures are latent and will "
            "surface on the next real turn",
            {"last_outbound_ms": last_out, "last_inbound_ms": last_in},
        ))
    elif last_out is not None:
        verdicts.append(_verdict(
            "flow", "serving_as_of",
            "outbound flow proves the bot was serving AS OF this timestamp — "
            "and only as of it; a fresher failed probe supersedes this",
            {"last_outbound_ms": last_out},
        ))
    return axis


def _order_evidence(verdicts: list) -> None:
    """Apply the evidence-ordering rule to the flow-vs-model contradiction.

    If both a fresh-genuine credential failure and recent outbound exist, the
    NEWER of (probe checkedAt, last outbound) wins; the older verdict is
    replaced with an 'outdated' marker rather than silently dropped.
    """
    model_v = next((v for v in verdicts
                    if v["verdict"] in ("credential_unavailable_genuine",
                                        "model_verdict_stale_suspect_probe")), None)
    flow_v = next((v for v in verdicts if v["verdict"] == "serving_as_of"), None)
    if not model_v or not flow_v:
        return
    probe_ms = model_v["evidence_ms"].get("checked_at_ms") or 0
    out_ms = flow_v["evidence_ms"].get("last_outbound_ms") or 0
    if out_ms > probe_ms:
        verdicts.remove(model_v)
        verdicts.append(_verdict(
            "model", "model_verdict_outdated_by_flow",
            "outbound flow is NEWER than the failed probe: the probe verdict "
            "is outdated, not the flow — re-probe before treating the "
            "credential as broken",
            {"checked_at_ms": probe_ms, "last_outbound_ms": out_ms},
        ))
    else:
        # probe is newer: flow only proves the past; keep serving_as_of (it is
        # already scoped to its own timestamp) and the genuine verdict stands.
        pass


def _flap_axis(flap: dict, verdicts: list) -> dict:
    axis = dict(flap)
    cumulative = flap.get("cumulative") or 0
    in_window = flap.get("in_window") or 0
    if in_window and cumulative <= in_window * FLAP_BURST_RATIO:
        verdicts.append(_verdict(
            "flap", "genuine_burst",
            "trips-in-window ≈ cumulative: a real oscillation burst — "
            "actionable signal, investigate the underlying instability",
            {"cumulative": cumulative, "in_window": in_window},
        ))
    elif cumulative >= max(in_window, 1) * FLAP_PERSISTENT_RATIO:
        verdicts.append(_verdict(
            "flap", "persistent_steady_condition",
            "cumulative ≫ window: a permanently-true condition surfacing "
            "through a throttled re-emit — the 'storm' label is an artifact; "
            "fix the underlying open condition, not the detector threshold",
            {"cumulative": cumulative, "in_window": in_window},
        ))
    return axis


def build_panel(*, host: str, instance: str, now_ms: int,
                health: Optional[dict] = None,
                health_error: Optional[str] = None,
                flow: Optional[dict] = None,
                flap: Optional[dict] = None) -> dict:
    """Pure, deterministic panel assembly (unit-tested; no I/O)."""
    verdicts: list[dict] = []
    axes: dict[str, Any] = {}
    unobserved: list[str] = []

    if health and not health_body_is_disclosed(health):
        # Answered, but not with the diagnostic body. Its status field is NOT a
        # fleet health verdict; treating it as one is the #2515 health-split
        # trap. Report the axes as unobserved and say so loudly.
        unobserved.extend(["bond", "model"])
        axes["health_envelope"] = {
            "disclosed": False,
            "schema_version": health.get("schema_version"),
            "reported_status": health.get("status"),
        }
        verdicts.append(_verdict(
            "health", "health_body_not_disclosed",
            "the endpoint answered with the PUBLIC envelope, not the privileged "
            "diagnostic body — its status field is NOT a health verdict and must "
            "not be read as one (the public envelope reports healthy on a bot "
            "whose privileged body reports degraded; live-confirmed on a "
            "production instance 2026-08-16). Bond and model are UNOBSERVED "
            "here, not clean. Re-run "
            "with a valid instance health token.",
            {"observed_at_ms": health.get("generated_at_ms")},
        ))
    elif health:
        axes["bond"] = _bond_axis(health, now_ms, verdicts)
        axes["model"] = _model_axis(health, now_ms, verdicts)
        axes["status"] = health.get("status")
    else:
        unobserved.extend(["bond", "model"])
        if health_error is not None:
            axes["health_error"] = health_error

    if flow:
        axes["flow"] = _flow_axis(flow, now_ms, verdicts)
    else:
        unobserved.append("flow")

    if flap:
        axes["flap"] = _flap_axis(flap, verdicts)
    else:
        unobserved.append("flap")

    _order_evidence(verdicts)

    return {
        "identity": {"host": host, "instance": instance},
        "now_ms": now_ms,
        "axes": axes,
        "verdicts": verdicts,
        "unobserved": unobserved,
    }


# ---------------------------------------------------------------------------
# I/O adapters (thin; run on the bot host so tokens never leave it)

def read_instance_token(instance: str) -> Optional[str]:
    path = Path.home() / ".config" / "whatsoup" / "instances" / instance / "tokens.env"
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith("WHATSOUP_HEALTH_TOKEN="):
                return line.split("=", 1)[1].strip()
    except OSError:
        return None
    return None


def fetch_local_health(port: int, token: str, timeout: float = 8.0) -> dict:
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/health",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        body = urllib.request.urlopen(req, timeout=timeout).read()
    except urllib.error.HTTPError as e:  # 503 carries the diagnostic body
        body = e.read()
    parsed = json.loads(body)
    # normalize generated_at (ISO) to generated_at_ms when present
    gen = parsed.get("generated_at")
    if isinstance(gen, str) and "generated_at_ms" not in parsed:
        try:
            import datetime as _dt
            parsed["generated_at_ms"] = int(
                _dt.datetime.fromisoformat(gen.replace("Z", "+00:00")).timestamp() * 1000
            )
        except ValueError:
            pass
    return parsed


def read_flow(db_path: Path, now_ms: int) -> Optional[dict]:
    if not db_path.exists():
        return None
    since_s = (now_ms - DAY_MS) // 1000
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = con.execute(FLOW_QUERY, {"since": since_s}).fetchall()
    finally:
        con.close()
    flow = {"last_outbound_ms": None, "last_inbound_ms": None,
            "outbound_24h": 0, "inbound_24h": 0, "observed_at_ms": now_ms}
    for is_from_me, _n, latest, recent in rows:
        latest_ms = int(latest) * 1000 if latest else None
        if is_from_me:
            flow["last_outbound_ms"] = latest_ms
            flow["outbound_24h"] = int(recent or 0)
        else:
            flow["last_inbound_ms"] = latest_ms
            flow["inbound_24h"] = int(recent or 0)
    return flow


def render_text(panel: dict) -> str:
    ident = panel["identity"]
    lines = [f"ground truth — {ident['host']}/{ident['instance']}"]
    for name, axis in sorted(panel["axes"].items()):
        lines.append(f"  {name}: {json.dumps(axis, default=str)}")
    for v in panel["verdicts"]:
        lines.append(f"  ⚖ [{v['axis']}] {v['verdict']} — {v['because']}")
    if panel["unobserved"]:
        lines.append(f"  ∅ unobserved (no verdicts drawn): {', '.join(panel['unobserved'])}")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--instance", required=True)
    ap.add_argument("--host", default=os.uname().nodename)
    ap.add_argument("--port", type=int, help="health port (required for the health axes)")
    ap.add_argument("--db", type=Path, help="override bot.db path for the flow axis")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    now_ms = int(time.time() * 1000)
    health = None
    health_error = None
    if args.port:
        token = read_instance_token(args.instance)
        if token is None:
            health_error = "no WHATSOUP_HEALTH_TOKEN in instance tokens.env"
        else:
            try:
                health = fetch_local_health(args.port, token)
            except Exception as e:  # surfaced verbatim, never swallowed
                health_error = f"{type(e).__name__}: {e}"
    else:
        health_error = "no --port given"

    db = args.db or (Path.home() / ".local" / "share" / "whatsoup"
                     / "instances" / args.instance / "bot.db")
    flow = read_flow(db, now_ms)

    panel = build_panel(host=args.host, instance=args.instance, now_ms=now_ms,
                        health=health, health_error=health_error, flow=flow)
    print(json.dumps(panel, indent=2, default=str) if args.json
          else render_text(panel))
    return 0


if __name__ == "__main__":
    sys.exit(main())
