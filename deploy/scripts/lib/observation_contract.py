"""Shared observation-plane contract reader (task-obs-03).

One implementation of: load the governed contract data set under
``deploy/observation-plane/`` fail-closed, expose deterministic lookups, and
derive ONE canonical contract digest that downstream evidence binds to
(req-obs-02/req-obs-09). The TypeScript port (``scripts/lib/observation-contract.ts``)
reproduces the digest byte-for-byte and is kept honest by a cross-language
lockstep test (``tests/scripts/lib/observation-contract-lockstep.test.ts``).

Fail-closed semantics (plan task-obs-03): malformed or structurally invalid
contract data raises :class:`ObservationContractError` — there is no fallback
parser. A legacy value outside a surface's declared domain NEVER projects to a
default: :func:`project_outcome` raises and the calling adapter classifies the
input ``unsupported``/``invalid_evidence`` itself.

Deep contract validity (projection totality against the schema's surface enum,
claim/adapter cross-references, fixture replay) is owned by the push-gate guard
``scripts/observation-contract-guard.ts``; this reader re-checks only the
structure it depends on for its own lookups, so a contract set the guard would
reject cannot be silently half-read here.
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from pathlib import Path
from types import MappingProxyType
from typing import Any, Optional

CONTRACT_FILE_NAMES = (
    "adapter-registry.json",
    "authority-lattice.json",
    "claim-catalog.json",
    "envelope.schema.json",
    "outcome-projections.json",
)

# The only contract version these readers understand. Enforced at build time
# (not only by the guard): a runtime consumer must never interpret an
# unsupported future contract version. Mirrored by
# SUPPORTED_CONTRACT_SCHEMA_VERSION in scripts/lib/observation-contract.ts.
SUPPORTED_SCHEMA_VERSION = "0.1"

# Data documents that carry schema_version (the envelope schema documents the
# ENVELOPE's version field; the document itself is a JSON Schema).
_VERSIONED_DOCS = (
    "adapter-registry.json",
    "authority-lattice.json",
    "claim-catalog.json",
    "outcome-projections.json",
)

# Closed minimum-projection vocabulary (see envelope projection.scope; a
# MINIMUM of "unobserved" is meaningless). A typo must never weaken authority.
MIN_PROJECTIONS = frozenset({"diagnostic", "public", "not_applicable"})

# Closed-world authority model (deploy/observation-plane/README.md): every
# governed field below is MANDATORY, and every vocabulary is closed. Missing
# or misspelled authority metadata must fail closed — a claim whose authority
# tier, generation binding, or staleness rule is absent cannot be ranked, and
# an adapter whose projection scope or status is absent cannot be bounded.
REQUIRED_CLAIM_FIELDS = (
    "claim_id",
    "family",
    "subject_kind",
    "min_projection",
    "authority_tier",
    "generation_binding",
    "staleness_rule",
    "producing_adapters",
    "cannot_establish",
)
REQUIRED_ADAPTER_FIELDS = (
    "adapter_id",
    "wraps",
    "platforms",
    "privilege",
    "prerequisites",
    "projection_scope",
    "can_establish",
    "cannot_establish",
    "status",
)
GENERATION_BINDINGS = frozenset(
    {"none", "config", "process", "credential", "process+credential"}
)
# Closed staleness vocabulary. `window_seconds` is CONDITIONAL on the kind:
# only a fixed_window rule carries (and requires) an explicit window. An
# event_bound or scheduler_deadline rule derives freshness from the producer,
# so a window on one of those would describe a bound nothing enforces —
# fail closed rather than let it read as an enforced freshness limit.
STALENESS_KINDS = frozenset({"event_bound", "scheduler_deadline", "fixed_window"})
_WINDOWED_STALENESS_KINDS = frozenset({"fixed_window"})
# Declared property set: an undeclared key is rejected rather than ignored, so
# a misspelled window (`window_secs`) cannot silently disable the bound.
_STALENESS_KEYS = frozenset({"kind", "window_seconds", "note"})
PROJECTION_SCOPES = frozenset({"diagnostic", "public", "not_applicable"})
ADAPTER_STATUSES = frozenset({"available", "gated", "producer_pending"})


def _describe_value(value: Any) -> str:
    """Describe a rejected value for an error message without ever raising.

    Mirrors ``describeValue`` in scripts/lib/observation-contract.ts so both
    readers name a malformed value the same way. ``ensure_ascii=False`` is
    required for that parity to hold: the default would render a non-ASCII
    string as ``"caf\\u00e9"`` where ``JSON.stringify`` yields ``"café"``.
    """
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, (list, tuple)):
        return "array"
    if isinstance(value, Mapping):
        return "object"
    return type(value).__name__


class ObservationContractError(RuntimeError):
    """Raised when the contract set cannot be read or is structurally invalid.

    Callers treat this as fail-closed: contract data that cannot be
    independently loaded and validated must not be silently trusted.
    """


def _repo_root() -> Path:
    # lib/observation_contract.py -> lib -> scripts -> deploy -> <repo root>
    return Path(__file__).resolve().parents[3]


def default_contract_dir() -> Path:
    return _repo_root() / "deploy" / "observation-plane"


def contract_identity(docs: dict) -> dict:
    """Normalized identity the digest is computed over: the five parsed
    documents keyed by their file names. Content-sensitive (any semantic or
    descriptive change alters it) but formatting-insensitive (whitespace and
    key order do not survive parsing)."""
    if not isinstance(docs, dict):
        raise ObservationContractError("contract docs must be a mapping")
    missing = [name for name in CONTRACT_FILE_NAMES if name not in docs]
    if missing:
        raise ObservationContractError(f"missing contract document(s): {', '.join(missing)}")
    for name in CONTRACT_FILE_NAMES:
        if not isinstance(docs[name], dict):
            raise ObservationContractError(f"contract document must be a JSON object: {name}")
    return {"files": {name: docs[name] for name in CONTRACT_FILE_NAMES}}


# Digest domain (req-obs-02): the digest is defined only over values both
# encoders accept AND serialize byte-identically. Numbers must be integral
# with |n| <= 2**53-1 — JS ``JSON.parse`` normalizes integral literals
# (``1.0``, ``1e0``, ``-0``) to integers before any reader code runs, so this
# side canonicalizes integral floats to the same integers; non-integral or
# out-of-range numbers fail closed on BOTH sides (repr(1e-07) here vs
# String(1e-7) in JS would otherwise diverge). Object KEYS must stay inside
# the BMP (Python sorts keys by code point, JS by UTF-16 code unit — the
# orders disagree beyond it, at any nesting depth). String VALUES are
# unrestricted: surrogate escaping is parity-proven by the lockstep suite.
_MAX_DIGEST_INT = 2**53 - 1


def _normalize_for_digest(value: Any, at: str) -> Any:
    """Return ``value`` with integral floats canonicalized to int, or raise
    :class:`ObservationContractError` for anything outside the digest domain."""
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        if abs(value) > _MAX_DIGEST_INT:
            raise ObservationContractError(
                f"digest domain violation at {at}: integers must satisfy |n| <= 2**53-1"
            )
        return value
    if isinstance(value, float):
        if not value.is_integer():
            raise ObservationContractError(
                f"digest domain violation at {at}: numbers must be integral (fractional "
                "values do not serialize identically across the Python/TS encoders)"
            )
        as_int = int(value)
        if abs(as_int) > _MAX_DIGEST_INT:
            raise ObservationContractError(
                f"digest domain violation at {at}: integers must satisfy |n| <= 2**53-1"
            )
        return as_int
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return [_normalize_for_digest(item, f"{at}[{index}]") for index, item in enumerate(value)]
    if isinstance(value, dict):
        normalized: dict = {}
        for key, item in value.items():
            if not isinstance(key, str) or any(ord(ch) > 0xFFFF for ch in key):
                raise ObservationContractError(
                    f"digest domain violation at {at}: object keys must be BMP-only strings "
                    "(key sort order diverges across encoders beyond the BMP)"
                )
            normalized[key] = _normalize_for_digest(item, f"{at}.{key}")
        return normalized
    raise ObservationContractError(
        f"digest domain violation at {at}: unsupported value type {type(value).__name__}"
    )


def contract_digest(docs: dict) -> str:
    identity = _normalize_for_digest(contract_identity(docs), "contract")
    material = json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def _string_list(value: Any, what: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ObservationContractError(f"{what} must be a list of strings")
    return list(value)


def _build_surfaces(projections: dict, canonical: set[str]) -> dict:
    raw_surfaces = projections.get("surfaces")
    if not isinstance(raw_surfaces, dict) or not raw_surfaces:
        raise ObservationContractError("outcome-projections surfaces must be a non-empty object")
    surfaces: dict[str, dict] = {}
    for surface_name, surface in raw_surfaces.items():
        if not isinstance(surface, dict):
            raise ObservationContractError(f"surface must be an object: {surface_name}")
        domain = _string_list(surface.get("domain"), f"surface {surface_name} domain")
        if not domain or len(set(domain)) != len(domain):
            raise ObservationContractError(f"surface {surface_name} domain must be non-empty and unique")
        raw_rows = surface.get("rows")
        if not isinstance(raw_rows, list):
            raise ObservationContractError(f"surface {surface_name} rows must be a list")
        rows: dict[str, dict] = {}
        for row in raw_rows:
            if (
                not isinstance(row, dict)
                or not isinstance(row.get("legacy_value"), str)
                or not isinstance(row.get("canonical"), str)
                or not isinstance(row.get("lossy"), bool)
            ):
                raise ObservationContractError(f"malformed projection row in {surface_name}")
            legacy_value = row["legacy_value"]
            if legacy_value in rows:
                raise ObservationContractError(f"duplicate projection row {surface_name}: {legacy_value}")
            if legacy_value not in domain:
                raise ObservationContractError(
                    f"projection row outside declared domain {surface_name}: {legacy_value}"
                )
            if row["canonical"] not in canonical:
                raise ObservationContractError(
                    f"canonical outcome outside the closed vocabulary {surface_name}: {row['canonical']}"
                )
            rows[legacy_value] = dict(row)
        for member in domain:
            if member not in rows:
                raise ObservationContractError(f"surface {surface_name} is not total: missing row for {member}")
        surfaces[surface_name] = {"domain": domain, "rows": rows}
    return surfaces


def _build_keyed(entries: Any, key: str, what: str) -> dict[str, dict]:
    if not isinstance(entries, list) or not entries:
        raise ObservationContractError(f"{what} must be a non-empty list")
    keyed: dict[str, dict] = {}
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get(key), str) or not entry[key]:
            raise ObservationContractError(f"{what} entry missing {key}")
        if entry[key] in keyed:
            raise ObservationContractError(f"duplicate {key} in {what}: {entry[key]}")
        keyed[entry[key]] = dict(entry)
    return keyed


def build_contract(docs: dict) -> Mapping:
    """Validate the parsed contract documents and return the lookup structure.

    Pure function over parsed docs so the lockstep test can exercise mutated
    document sets without touching the committed files.
    """
    digest = contract_digest(docs)  # also validates presence/shape of every doc
    # Build the returned structure from the NORMALIZED documents so Python
    # consumers see the same values a TS consumer sees after JSON.parse
    # (integral floats already canonicalized to int) — req-obs-02 covers the
    # returned contract data, not only the digest bytes.
    docs = _normalize_for_digest(contract_identity(docs), "contract")["files"]
    for name in _VERSIONED_DOCS:
        version = docs[name].get("schema_version")
        if version != SUPPORTED_SCHEMA_VERSION:
            raise ObservationContractError(
                f"unsupported schema_version in {name}: {version!r} "
                f"(supported: {SUPPORTED_SCHEMA_VERSION})"
            )
    projections = docs["outcome-projections.json"]
    canonical_list = _string_list(
        projections.get("canonical_outcomes"), "canonical_outcomes"
    )
    if not canonical_list or len(set(canonical_list)) != len(canonical_list):
        raise ObservationContractError("canonical_outcomes must be non-empty and unique")
    canonical = set(canonical_list)
    surfaces = _build_surfaces(projections, canonical)
    claims = _build_keyed(docs["claim-catalog.json"].get("claims"), "claim_id", "claim catalog")
    for claim_id, claim in claims.items():
        min_projection = claim.get("min_projection")
        # Type BEFORE membership: `x in frozenset` raises TypeError on an
        # unhashable dict/list, which would escape ObservationContractError and
        # leave callers unable to classify the evidence as invalid_evidence.
        if not isinstance(min_projection, str) or min_projection not in MIN_PROJECTIONS:
            raise ObservationContractError(
                f"claim {claim_id}: min_projection {_describe_value(min_projection)} "
                f"outside the closed vocabulary {sorted(MIN_PROJECTIONS)}"
            )
    adapters = _build_keyed(
        docs["adapter-registry.json"].get("adapters"), "adapter_id", "adapter registry"
    )
    raw_tiers = docs["authority-lattice.json"].get("tiers")
    if not isinstance(raw_tiers, list) or not raw_tiers:
        raise ObservationContractError("authority-lattice tiers must be a non-empty list")
    tiers: list[str] = []
    for tier in raw_tiers:
        if not isinstance(tier, dict) or not isinstance(tier.get("tier"), str):
            raise ObservationContractError("malformed authority-lattice tier entry")
        if tier["tier"] in tiers:
            raise ObservationContractError(f"duplicate authority tier: {tier['tier']}")
        tiers.append(tier["tier"])
    _validate_authority_metadata(claims, adapters, tiers)
    return _deep_freeze(
        {
            "digest": digest,
            "docs": {name: docs[name] for name in CONTRACT_FILE_NAMES},
            "canonical_outcomes": canonical_list,
            "surfaces": surfaces,
            "claims": claims,
            "adapters": adapters,
            "authority_tiers": tiers,
        }
    )


def _validate_authority_metadata(claims: dict, adapters: dict, tiers: list[str]) -> None:
    """Enforce the closed-world authority model over the built tables."""
    tier_set = set(tiers)
    for claim_id, claim in claims.items():
        for field in REQUIRED_CLAIM_FIELDS:
            if field not in claim:
                raise ObservationContractError(f"claim {claim_id}: missing required field {field}")
        if not isinstance(claim["authority_tier"], str) or claim["authority_tier"] not in tier_set:
            raise ObservationContractError(
                f"claim {claim_id}: authority_tier {_describe_value(claim['authority_tier'])} "
                f"is not a declared lattice tier"
            )
        if (
            not isinstance(claim["generation_binding"], str)
            or claim["generation_binding"] not in GENERATION_BINDINGS
        ):
            raise ObservationContractError(
                f"claim {claim_id}: generation_binding {_describe_value(claim['generation_binding'])} "
                f"outside the closed vocabulary {sorted(GENERATION_BINDINGS)}"
            )
        rule = claim["staleness_rule"]
        if not isinstance(rule, Mapping):
            raise ObservationContractError(
                f"claim {claim_id}: staleness_rule must be an object"
            )
        undeclared = sorted(set(rule) - _STALENESS_KEYS)
        if undeclared:
            raise ObservationContractError(
                f"claim {claim_id}: staleness_rule has undeclared propert(ies) {undeclared} "
                f"(declared: {sorted(_STALENESS_KEYS)})"
            )
        kind = rule.get("kind")
        if not isinstance(kind, str) or kind not in STALENESS_KINDS:
            raise ObservationContractError(
                f"claim {claim_id}: staleness_rule.kind {kind!r} outside the closed "
                f"vocabulary {sorted(STALENESS_KINDS)}"
            )
        if "note" in rule and not isinstance(rule["note"], str):
            raise ObservationContractError(
                f"claim {claim_id}: staleness_rule.note must be a string when present"
            )
        # Presence, not non-null: an explicit ``"window_seconds": null`` is a
        # declared window of no value and must fail on BOTH sides. Testing
        # ``.get(...) is not None`` here would accept it while the TS reader
        # (where ``null !== undefined``) rejects it — a divergent boundary.
        has_window = "window_seconds" in rule
        if kind in _WINDOWED_STALENESS_KINDS:
            if not has_window:
                raise ObservationContractError(
                    f"claim {claim_id}: staleness_rule.kind {kind!r} requires window_seconds"
                )
            window = rule["window_seconds"]
            if isinstance(window, bool) or not isinstance(window, int):
                raise ObservationContractError(
                    f"claim {claim_id}: staleness_rule.window_seconds must be an integer"
                )
            if window <= 0 or window > _MAX_DIGEST_INT:
                raise ObservationContractError(
                    f"claim {claim_id}: staleness_rule.window_seconds must be a positive "
                    f"integer <= 2**53-1 (got {window})"
                )
        elif has_window:
            raise ObservationContractError(
                f"claim {claim_id}: staleness_rule.kind {kind!r} prohibits window_seconds "
                f"(only {sorted(_WINDOWED_STALENESS_KINDS)} carry an explicit window)"
            )
        _string_list(claim["producing_adapters"], f"claim {claim_id} producing_adapters")
        _string_list(claim["cannot_establish"], f"claim {claim_id} cannot_establish")

    for adapter_id, adapter in adapters.items():
        for field in REQUIRED_ADAPTER_FIELDS:
            if field not in adapter:
                raise ObservationContractError(
                    f"adapter {adapter_id}: missing required field {field}"
                )
        if (
            not isinstance(adapter["projection_scope"], str)
            or adapter["projection_scope"] not in PROJECTION_SCOPES
        ):
            raise ObservationContractError(
                f"adapter {adapter_id}: projection_scope {_describe_value(adapter['projection_scope'])} "
                f"outside the closed vocabulary {sorted(PROJECTION_SCOPES)}"
            )
        if not isinstance(adapter["status"], str) or adapter["status"] not in ADAPTER_STATUSES:
            raise ObservationContractError(
                f"adapter {adapter_id}: status {_describe_value(adapter['status'])} outside the "
                f"closed vocabulary {sorted(ADAPTER_STATUSES)}"
            )
        for field in ("wraps", "platforms", "prerequisites", "can_establish", "cannot_establish"):
            _string_list(adapter[field], f"adapter {adapter_id} {field}")
        if not isinstance(adapter["privilege"], str) or not adapter["privilege"]:
            raise ObservationContractError(f"adapter {adapter_id}: privilege must be a non-empty string")
        overlap = set(adapter["can_establish"]) & set(adapter["cannot_establish"])
        if overlap:
            raise ObservationContractError(
                f"adapter {adapter_id}: {sorted(overlap)} appear in both can_establish and cannot_establish"
            )

    # Cross-references resolve, and producer relationships are symmetric in
    # BOTH directions: a claim's producer must declare the claim, and an
    # adapter's establishable claim must name the adapter as a producer.
    for claim_id, claim in claims.items():
        for other in claim["cannot_establish"]:
            if other not in claims:
                raise ObservationContractError(
                    f"claim {claim_id}: cannot_establish references unknown claim {other}"
                )
        for adapter_id in claim["producing_adapters"]:
            adapter = adapters.get(adapter_id)
            if adapter is None:
                raise ObservationContractError(
                    f"claim {claim_id}: producing_adapters references unknown adapter {adapter_id}"
                )
            if claim_id not in adapter["can_establish"]:
                raise ObservationContractError(
                    f"claim {claim_id}: producer {adapter_id} does not declare it in can_establish"
                )
    for adapter_id, adapter in adapters.items():
        for claim_id in adapter["can_establish"]:
            claim = claims.get(claim_id)
            if claim is None:
                raise ObservationContractError(
                    f"adapter {adapter_id}: can_establish references unknown claim {claim_id}"
                )
            if adapter_id not in claim["producing_adapters"]:
                raise ObservationContractError(
                    f"adapter {adapter_id}: claim {claim_id} does not name it in producing_adapters"
                )
        for claim_id in adapter["cannot_establish"]:
            if claim_id not in claims:
                raise ObservationContractError(
                    f"adapter {adapter_id}: cannot_establish references unknown claim {claim_id}"
                )


def _deep_freeze(value: Any) -> Any:
    """Recursively immutable view: dicts become read-only mapping proxies over
    private copies, lists become tuples. Digest-bound state must refuse direct
    mutation (mirrors the TS deepFreeze) or evaluated policy could drift from
    the digest that names it."""
    if isinstance(value, dict):
        return MappingProxyType({key: _deep_freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_deep_freeze(item) for item in value)
    return value


def _thaw(value: Any) -> Any:
    """Plain mutable JSON-shaped copy of a frozen subtree — what the lookup
    accessors hand out, so callers may annotate without touching the store."""
    if isinstance(value, Mapping):
        return {key: _thaw(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [_thaw(item) for item in value]
    return value


def contract_snapshot(contract: Mapping) -> dict:
    """Plain JSON-compatible, mutable, detached deep copy of the whole
    contract — the official cross-language snapshot operation (TS:
    ``contractSnapshot``). The frozen contract itself stays the digest
    authority and is not JSON-serializable by design."""
    return _thaw(contract)


def load_contract(contract_dir: Optional[Path] = None) -> Mapping:
    """Read the five contract files from ``contract_dir`` and build the contract.

    Raises :class:`ObservationContractError` on any read/parse/structure fault.
    """
    resolved = Path(contract_dir) if contract_dir is not None else default_contract_dir()
    docs: dict[str, Any] = {}
    for name in CONTRACT_FILE_NAMES:
        path = resolved / name
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            # Strict decode is deliberate: the TS loader rejects the same
            # bytes fatally instead of lossily replacing them with U+FFFD.
            raise ObservationContractError(
                f"contract document is not valid UTF-8: {path}"
            ) from exc
        except OSError as exc:
            raise ObservationContractError(
                f"cannot read contract document {path}: {type(exc).__name__}"
            ) from exc
        try:
            docs[name] = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ObservationContractError(f"invalid contract JSON {path}: {exc}") from exc
    return build_contract(docs)


def project_outcome(contract: Mapping, surface: str, raw_value: str) -> dict:
    """Project one legacy verdict to its canonical row, or raise.

    An unknown surface or a value outside the declared domain raises — the
    calling adapter classifies the input ``unsupported``/``invalid_evidence``
    itself; nothing here defaults.
    """
    surfaces = contract.get("surfaces")
    if not isinstance(surfaces, Mapping) or surface not in surfaces:
        raise ObservationContractError(f"unknown legacy surface: {surface}")
    rows = surfaces[surface]["rows"]
    if raw_value not in rows:
        raise ObservationContractError(
            f"legacy value outside the declared domain of {surface}: {raw_value}"
        )
    # Defensive copy: digest-bound state must not be mutable through lookups.
    return _thaw(rows[raw_value])


def _keyed_lookup(contract: Mapping, table: str, key: str, what: str) -> dict:
    rows = contract.get(table)
    if not isinstance(rows, Mapping) or key not in rows:
        raise ObservationContractError(f"unknown {what}: {key}")
    # Defensive copy: digest-bound state must not be mutable through lookups.
    return _thaw(rows[key])


def claim_row(contract: Mapping, claim_id: str) -> dict:
    return _keyed_lookup(contract, "claims", claim_id, "claim")


def adapter_row(contract: Mapping, adapter_id: str) -> dict:
    return _keyed_lookup(contract, "adapters", adapter_id, "adapter")
