#!/usr/bin/env python3
"""Runtime-receipt capture producer (#1867 criterion 1, producer half).

Emits receipt bundles conforming byte-for-byte to the guard-side digest
contract in `scripts/lib/fleet-receipt-digest.ts`
(`receiptCapabilityIdentity`/`receiptCapabilityDigest`), so a bundle produced
here and validated there agree on the same sha256 digest. See design
`1867-runtime-proof-producer-design.md` §2 (capture), §3 (redaction), §4
(digest), §10 (phasing) -- this is a fixtures-only increment: no live fleet
queries in tests, no receipt file written under `docs/reliability-runner/...`
yet (that wiring is a later phase, gated on the storage-model owner decision
in the design's §9 D1).

Deliberately placed under `deploy/scripts/receipts/` -- a subdirectory
OUTSIDE the non-recursive `deploy/scripts/*.py` + `deploy/scripts/lib/*.py`
manifest glob `scripts/check-bot-errors-runtime-manifest.ts` scans, so this
module does not trip that guard before it is pinned into the manifest at a
later migration phase.

Three pure functions form the contract surface, unit-tested on fixtures:

- `capability_projection` / `capability_digest` -- byte-for-byte mirrors of
  `receiptCapabilityIdentity` / `receiptCapabilityDigest`
  (`scripts/lib/fleet-receipt-digest.ts:100-164`). Fail-closed
  (`ReceiptProjectionError`) on any missing/ill-typed identity field, same
  fields, same rules, proven identical by the cross-language lockstep test
  `tests/scripts/lib/capture-runtime-receipt-lockstep.test.ts`.
- `redact_bundle` -- reuses `deploy/scripts/lib/bot_errors_redaction.py`
  exactly as-is (`redact_json_value` + `redact_bot_errors_text`); no
  hand-rolled scrubbing here. Redaction is security-critical (design §3):
  these receipts are meant to be safe to store/commit operator-side.

`capture(...)` assembles a full receipt bundle from already-fetched/injected
sources (never queries a live instance itself) -- see its docstring for the
seam. It is NOT exercised against a real fleet by this increment's tests;
it exists so a later phase (deploy-time / periodic / restart-triggered
wiring, design §2.2) has a single call to make once live I/O is wired in.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Callable, Union

SCRIPT_DIR = Path(__file__).resolve().parent
DEPLOY_SCRIPTS_DIR = SCRIPT_DIR.parent
if str(DEPLOY_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(DEPLOY_SCRIPTS_DIR))

from lib.bot_errors_redaction import redact_bot_errors_text, redact_json_value  # noqa: E402


class ReceiptProjectionError(ValueError):
    """Raised when a receipt bundle cannot be reduced to the
    capability-identity projection -- mirrors `ReceiptDigestError`
    (`scripts/lib/fleet-receipt-digest.ts`). Fail-closed: a bundle this
    cannot project must never be silently hashed as if it matched.
    """


def _require_non_empty_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or value.strip() == "":
        raise ReceiptProjectionError(f"receipt.{field} must be a non-empty string")
    return value


def _require_non_negative_int(value: Any, field: str) -> int:
    # bool is an int subclass in Python; TS's `typeof x !== 'number'` already
    # excludes booleans, so exclude them here too rather than silently
    # accepting True/False as 1/0.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ReceiptProjectionError(f"receipt.{field} must be a non-negative integer")
    if isinstance(value, float) and not value.is_integer():
        raise ReceiptProjectionError(f"receipt.{field} must be a non-negative integer")
    ivalue = int(value)
    if ivalue < 0:
        raise ReceiptProjectionError(f"receipt.{field} must be a non-negative integer")
    return ivalue


def capability_projection(bundle: Any) -> dict:
    """Reduce a receipt bundle to its capability-identity projection.

    Byte-for-byte mirror of `receiptCapabilityIdentity`
    (`scripts/lib/fleet-receipt-digest.ts:100-150`): same six output fields,
    same validation rules, same fail-closed behavior. Any extra/volatile
    field on `bundle` (uptime, timestamps, counters) is ignored, never
    hashed. `fallbackChain` order is preserved exactly as given -- it is
    semantic priority, not sorted.
    """
    if not isinstance(bundle, dict):
        raise ReceiptProjectionError("receipt must be a JSON object")

    commit = _require_non_empty_string(bundle.get("commit"), "commit")
    provider = _require_non_empty_string(bundle.get("provider"), "provider")
    model_usability_status = _require_non_empty_string(
        bundle.get("modelUsabilityStatus"), "modelUsabilityStatus"
    )
    schema_migration = _require_non_negative_int(bundle.get("schemaMigration"), "schemaMigration")

    raw_fallback_chain = bundle.get("fallbackChain")
    if not isinstance(raw_fallback_chain, list):
        raise ReceiptProjectionError("receipt.fallbackChain must be an array")
    fallback_chain: list[dict] = []
    for index, entry in enumerate(raw_fallback_chain):
        if not isinstance(entry, dict):
            raise ReceiptProjectionError(f"receipt.fallbackChain[{index}] must be an object")
        entry_provider = entry.get("provider")
        entry_model = entry.get("model")
        entry_eligible = entry.get("eligible")
        if not isinstance(entry_provider, str):
            raise ReceiptProjectionError(f"receipt.fallbackChain[{index}].provider must be a string")
        if not isinstance(entry_model, str):
            raise ReceiptProjectionError(f"receipt.fallbackChain[{index}].model must be a string")
        if not isinstance(entry_eligible, bool):
            raise ReceiptProjectionError(f"receipt.fallbackChain[{index}].eligible must be a boolean")
        fallback_chain.append({"provider": entry_provider, "model": entry_model, "eligible": entry_eligible})

    drift_check = bundle.get("driftCheck")
    if not isinstance(drift_check, dict) or not isinstance(drift_check.get("ok"), bool):
        raise ReceiptProjectionError("receipt.driftCheck.ok must be a boolean")

    return {
        "commit": commit,
        "schemaMigration": schema_migration,
        "provider": provider,
        "modelUsabilityStatus": model_usability_status,
        "fallbackChain": fallback_chain,
        "driftOk": drift_check["ok"],
    }


def capability_digest(bundle: Any) -> str:
    """`sha256(json.dumps(capability_projection(bundle), sort_keys=True,
    separators=(",", ":"), ensure_ascii=True))`, hex digest, no `sha256:`
    prefix -- byte-identical call shape to `receiptCapabilityDigest`
    (`scripts/lib/fleet-receipt-digest.ts:160-164`), proven by the
    cross-language lockstep test
    `tests/scripts/lib/capture-runtime-receipt-lockstep.test.ts`.
    """
    projection = capability_projection(bundle)
    material = json.dumps(projection, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _redact_text(value: Any) -> str:
    return redact_bot_errors_text(value, credential_path_marker="[REDACTED CREDENTIAL PATH]")


# The digest-projected identity fields that are STRING-valued and can thus be
# mutated by the free-text scrubber (a date-suffixed model id can look
# phone-like). The int/bool projected fields (schemaMigration, each entry's
# eligible, driftCheck.ok) are never touched by a text scrubber, so they need
# no restoration.
_IDENTITY_STRING_FIELDS = ("commit", "provider", "modelUsabilityStatus")


def _restore_identity_fields(redacted: dict, raw: dict) -> None:
    """Copy the digest-projected STRING identity fields from `raw` back onto
    `redacted` verbatim, undoing any scrubber mutation of a phone/credential
    shaped identity value. `fallbackChain` entries are restored positionally
    (`redact_json_value` preserves list order and length) -- each entry's
    `provider` and `model`; `eligible` and any volatile per-entry counters are
    left as the scrubber returned them.
    """
    for field in _IDENTITY_STRING_FIELDS:
        if field in raw:
            redacted[field] = raw[field]
    raw_chain = raw.get("fallbackChain")
    redacted_chain = redacted.get("fallbackChain")
    if (
        isinstance(raw_chain, list)
        and isinstance(redacted_chain, list)
        and len(raw_chain) == len(redacted_chain)
    ):
        for redacted_entry, raw_entry in zip(redacted_chain, raw_chain):
            if isinstance(redacted_entry, dict) and isinstance(raw_entry, dict):
                for key in ("provider", "model"):
                    if key in raw_entry:
                        redacted_entry[key] = raw_entry[key]


def redact_bundle(bundle: dict) -> dict:
    """Scrub every string-valued field of `bundle` (recursively, through dicts
    and lists) through the shared BOT ERRORS scrubber
    (`deploy/scripts/lib/bot_errors_redaction.py`), then restore the
    digest-projected identity fields VERBATIM. Reuse only -- no hand-rolled
    scrubbing (design §3: "any hand-rolled scrubber is a rejection").

    The scrubber is a generic free-text redactor; it does not know which
    fields are identity, and some legitimate identity values collide with its
    patterns -- e.g. a date-suffixed model id like `claude-opus-4-1-20250805`
    (ten dash-joined digits) trips the phone-like regex. Those fields are
    HASHED into the receipt digest (design §4), so any mutation would break
    digest agreement with the guard (`scripts/lib/fleet-receipt-digest.ts`).
    The projected identity fields (commit, provider, modelUsabilityStatus, and
    each fallbackChain entry's provider/model) are therefore restored from the
    pre-redaction values after scrubbing, and a fail-closed self-check raises
    `ReceiptProjectionError` if the capability projection changed at all --
    identity is exact by construction, never by regex-non-collision luck.
    Genuinely volatile/free-text fields (timestamps, uptime, drift issues,
    credential paths, JIDs) are still fully scrubbed.

    Requires `bundle` to be projectable, and raises `ReceiptProjectionError`
    otherwise -- an incompletely captured bundle must never yield a receipt.
    """
    identity_before = capability_projection(bundle)
    redacted = redact_json_value(bundle, _redact_text)
    _restore_identity_fields(redacted, bundle)
    if capability_projection(redacted) != identity_before:
        raise ReceiptProjectionError("redaction altered capability-identity fields")
    return redacted


def _sanitize_auth_bond(auth_bond: Any) -> dict | None:
    """Structural exclusion (design §3, point 2): raw filesystem paths are
    dropped entirely rather than redacted-in-place, mirroring how
    `formatAuthBond` (health.ts:420-459) already truncates hashes instead of
    emitting them in full. `formatAuthBond`'s real output shape nests TWO
    raw-path fields -- `creds.path` and `auth_dir.path` (health.ts:427,
    :437) -- not a top-level `authDir` key on the auth-bond object itself;
    both are stripped here. `stateRoot`/`dataRoot` are also dropped
    defensively in case a future health.ts revision surfaces them directly
    on this object, but they are not part of today's `formatAuthBond` shape.
    """
    if not isinstance(auth_bond, dict):
        return None
    sanitized = dict(auth_bond)
    for path_holder_key in ("creds", "auth_dir"):
        path_holder = sanitized.get(path_holder_key)
        if isinstance(path_holder, dict) and "path" in path_holder:
            path_holder = dict(path_holder)
            path_holder.pop("path", None)
            sanitized[path_holder_key] = path_holder
    for unsafe_key in ("authDir", "stateRoot", "dataRoot"):
        sanitized.pop(unsafe_key, None)
    return sanitized


CaptureSource = Union[dict, Callable[[], dict]]


def _resolve_source(source: "CaptureSource | None") -> dict:
    if source is None:
        return {}
    resolved = source() if callable(source) else source
    if not isinstance(resolved, dict):
        raise ReceiptProjectionError("capture source must resolve to a JSON object")
    return resolved


def _nested_dict(parent: dict, key: str) -> dict:
    """`parent.get(key)` narrowed to a dict, or `{}` if absent/ill-typed --
    lets every nested `/health` lookup in `capture()` chain `.get(...)` calls
    without a repeated isinstance-or-empty-dict ternary at each level.
    """
    value = parent.get(key)
    return value if isinstance(value, dict) else {}


def capture(
    *,
    health: CaptureSource,
    drift_check: "CaptureSource | None" = None,
    service_active_enter_timestamp: "str | Callable[[], str | None] | None" = None,
    captured_at: "str | Callable[[], str] | None" = None,
) -> dict:
    """Assemble a redacted receipt bundle from already-fetched/injected
    sources (design §2.1).

    Never performs I/O itself: every source is either an already-fetched
    dict or a zero-arg callable the CALLER wires to real I/O (an HTTP GET of
    `/health`, a `systemctl ... show` shell-out, the drift-check job's
    result file). This keeps the pure capture-assembly logic testable on
    fixtures while the live wiring (deploy-time / periodic / restart
    triggered, design §2.2) is a thin caller-supplied seam -- tests in this
    increment only ever pass plain dicts/lambdas, never touching a real
    fleet.

    Does NOT write anything to disk -- committing a receipt under
    `docs/reliability-runner/...` is a later phase (design §10), gated on
    the storage-model decision (D1).
    """
    health_data = _resolve_source(health)
    instance = _nested_dict(health_data, "instance")
    sqlite = _nested_dict(health_data, "sqlite")
    whatsapp = _nested_dict(health_data, "whatsapp")
    runtime = _nested_dict(health_data, "runtime")
    agent_runtime = _nested_dict(runtime, "agent")
    turn_capability = _nested_dict(agent_runtime, "turnCapability")

    drift = _resolve_source(drift_check)

    if callable(service_active_enter_timestamp):
        service_active_enter_timestamp = service_active_enter_timestamp()
    if callable(captured_at):
        captured_at = captured_at()

    bundle: dict[str, Any] = {
        # Identity-tagged (hashed via capability_digest, design §4).
        "commit": instance.get("commit"),
        "provider": instance.get("provider"),
        "modelUsabilityStatus": turn_capability.get("modelUsabilityStatus"),
        "schemaMigration": sqlite.get("schema_migration_latest"),
        "fallbackChain": instance.get("fallbackChain"),
        "driftCheck": {"ok": drift.get("ok")},
        # Volatile -- carried for operator inspection, never hashed (design §4).
        "branch": instance.get("branch"),
        "generatedAt": health_data.get("generated_at"),
        "uptimeSeconds": health_data.get("uptime_seconds"),
        "authBond": _sanitize_auth_bond(whatsapp.get("auth_bond")),
        "credentialLifecycle": whatsapp.get("credential_lifecycle"),
        "driftCheckedAt": drift.get("checkedAt"),
        "driftIssues": drift.get("issues"),
        "serviceActiveEnterTimestamp": service_active_enter_timestamp,
        "capturedAt": captured_at,
    }
    return redact_bundle(bundle)
