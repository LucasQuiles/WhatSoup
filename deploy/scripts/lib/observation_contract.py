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
from pathlib import Path
from typing import Any, Optional

CONTRACT_FILE_NAMES = (
    "adapter-registry.json",
    "authority-lattice.json",
    "claim-catalog.json",
    "envelope.schema.json",
    "outcome-projections.json",
)


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


def build_contract(docs: dict) -> dict:
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
    projections = docs["outcome-projections.json"]
    canonical_list = _string_list(
        projections.get("canonical_outcomes"), "canonical_outcomes"
    )
    if not canonical_list or len(set(canonical_list)) != len(canonical_list):
        raise ObservationContractError("canonical_outcomes must be non-empty and unique")
    canonical = set(canonical_list)
    surfaces = _build_surfaces(projections, canonical)
    claims = _build_keyed(docs["claim-catalog.json"].get("claims"), "claim_id", "claim catalog")
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
    return {
        "digest": digest,
        "docs": {name: docs[name] for name in CONTRACT_FILE_NAMES},
        "canonical_outcomes": canonical_list,
        "surfaces": surfaces,
        "claims": claims,
        "adapters": adapters,
        "authority_tiers": tiers,
    }


def load_contract(contract_dir: Optional[Path] = None) -> dict:
    """Read the five contract files from ``contract_dir`` and build the contract.

    Raises :class:`ObservationContractError` on any read/parse/structure fault.
    """
    resolved = Path(contract_dir) if contract_dir is not None else default_contract_dir()
    docs: dict[str, Any] = {}
    for name in CONTRACT_FILE_NAMES:
        path = resolved / name
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise ObservationContractError(
                f"cannot read contract document {path}: {type(exc).__name__}"
            ) from exc
        try:
            docs[name] = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ObservationContractError(f"invalid contract JSON {path}: {exc}") from exc
    return build_contract(docs)


def project_outcome(contract: dict, surface: str, raw_value: str) -> dict:
    """Project one legacy verdict to its canonical row, or raise.

    An unknown surface or a value outside the declared domain raises — the
    calling adapter classifies the input ``unsupported``/``invalid_evidence``
    itself; nothing here defaults.
    """
    surfaces = contract.get("surfaces")
    if not isinstance(surfaces, dict) or surface not in surfaces:
        raise ObservationContractError(f"unknown legacy surface: {surface}")
    rows = surfaces[surface]["rows"]
    if raw_value not in rows:
        raise ObservationContractError(
            f"legacy value outside the declared domain of {surface}: {raw_value}"
        )
    return rows[raw_value]


def _keyed_lookup(contract: dict, table: str, key: str, what: str) -> dict:
    rows = contract.get(table)
    if not isinstance(rows, dict) or key not in rows:
        raise ObservationContractError(f"unknown {what}: {key}")
    return rows[key]


def claim_row(contract: dict, claim_id: str) -> dict:
    return _keyed_lookup(contract, "claims", claim_id, "claim")


def adapter_row(contract: dict, adapter_id: str) -> dict:
    return _keyed_lookup(contract, "adapters", adapter_id, "adapter")
