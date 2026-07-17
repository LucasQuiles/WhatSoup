"""Tests for the runtime-receipt capture producer (#1867 criterion 1, producer
half; design `1867-runtime-proof-producer-design.md` §2-4).

`capability_projection`/`capability_digest` must be byte-for-byte equivalent
to the guard-side `receiptCapabilityIdentity`/`receiptCapabilityDigest`
(`scripts/lib/fleet-receipt-digest.ts`) -- the cross-language agreement itself
is proven separately by the vitest lockstep test
(`tests/scripts/lib/capture-runtime-receipt-lockstep.test.ts`), which reads
the same fixture file this module's tests use. This file covers the
producer's own contract: projection correctness, digest determinism, the
volatile-field-exclusion discriminator, fail-closed validation, and reuse of
the shared redaction module.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_MOD_PATH = Path(__file__).resolve().parents[1] / "capture_runtime_receipt.py"
_FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "lockstep-receipt.json"


def _load_module():
    spec = importlib.util.spec_from_file_location("capture_runtime_receipt", _MOD_PATH)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()


def _load_fixture() -> dict:
    return json.loads(_FIXTURE_PATH.read_text(encoding="utf-8"))


def _receipt(**overrides) -> dict:
    base = {
        "commit": "a" * 40,
        "schemaMigration": 44,
        "provider": "claude-cli",
        "modelUsabilityStatus": "usable",
        "fallbackChain": [
            {"provider": "openai", "model": "gpt-fallback", "eligible": True, "turnCount": 3},
        ],
        "driftCheck": {"ok": True, "releasePath": "ignored-volatile-field"},
        # Volatile fields (design §4): carried, never hashed.
        "generatedAt": "2026-06-18T00:00:00Z",
        "uptimeSeconds": 12345,
        "lastProbeAt": "2026-06-18T00:00:00Z",
    }
    base.update(overrides)
    return base


def test_capability_projection_matches_the_fixture_shape():
    receipt = _load_fixture()
    projection = _mod.capability_projection(receipt)
    assert projection == {
        "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "schemaMigration": 44,
        "provider": "claude-cli",
        "modelUsabilityStatus": "usable",
        "fallbackChain": [
            {"provider": "openai", "model": "gpt-fallback", "eligible": True},
            {"provider": "google", "model": "gemini-fallback", "eligible": False},
        ],
        "driftOk": True,
    }


def test_capability_projection_preserves_fallback_chain_order_not_sorted():
    receipt = _receipt(
        fallbackChain=[
            {"provider": "zzz-last", "model": "m1", "eligible": True},
            {"provider": "aaa-first", "model": "m2", "eligible": False},
        ]
    )
    projection = _mod.capability_projection(receipt)
    assert [entry["provider"] for entry in projection["fallbackChain"]] == ["zzz-last", "aaa-first"]


def test_capability_digest_is_deterministic_for_the_same_bundle():
    first_digest = _mod.capability_digest(_load_fixture())
    second_digest = _mod.capability_digest(_load_fixture())
    assert first_digest == second_digest


def test_capability_digest_is_a_64_char_hex_sha256():
    digest = _mod.capability_digest(_load_fixture())
    assert len(digest) == 64
    int(digest, 16)  # hex, raises ValueError otherwise


def test_capability_digest_excludes_volatile_fields():
    base = _receipt()
    touched = _receipt(
        generatedAt="2027-01-01T00:00:00Z",
        uptimeSeconds=999999,
        lastProbeAt="2027-01-01T00:00:00Z",
        fallbackChain=[
            {"provider": "openai", "model": "gpt-fallback", "eligible": True, "turnCount": 9999},
        ],
    )
    assert _mod.capability_digest(touched) == _mod.capability_digest(base)


@pytest.mark.parametrize(
    "identity_field,new_value",
    [
        ("commit", "b" * 40),
        ("schemaMigration", 45),
        ("provider", "openai-cli"),
        ("modelUsabilityStatus", "unusable"),
    ],
)
def test_capability_digest_changes_when_an_identity_field_changes(identity_field, new_value):
    base = _receipt()
    changed = _receipt(**{identity_field: new_value})
    assert _mod.capability_digest(changed) != _mod.capability_digest(base)


def test_capability_digest_changes_when_fallback_chain_eligible_changes():
    base = _receipt()
    changed = _receipt(
        fallbackChain=[{"provider": "openai", "model": "gpt-fallback", "eligible": False, "turnCount": 3}]
    )
    assert _mod.capability_digest(changed) != _mod.capability_digest(base)


def test_capability_digest_changes_when_drift_ok_changes():
    base = _receipt()
    changed = _receipt(driftCheck={"ok": False, "releasePath": "ignored-volatile-field"})
    assert _mod.capability_digest(changed) != _mod.capability_digest(base)


def test_fails_closed_when_bundle_is_not_an_object():
    for bad in ("not-an-object", None, [], 42):
        with pytest.raises(_mod.ReceiptProjectionError):
            _mod.capability_projection(bad)


def test_fails_closed_on_missing_or_ill_typed_commit():
    with pytest.raises(_mod.ReceiptProjectionError):
        _mod.capability_projection(_receipt(commit=123))
    with pytest.raises(_mod.ReceiptProjectionError):
        _mod.capability_projection({k: v for k, v in _receipt().items() if k != "commit"})
    with pytest.raises(_mod.ReceiptProjectionError):
        _mod.capability_projection(_receipt(commit="   "))


def test_fails_closed_on_missing_or_ill_typed_provider():
    with pytest.raises(_mod.ReceiptProjectionError):
        _mod.capability_projection(_receipt(provider=""))
    with pytest.raises(_mod.ReceiptProjectionError):
        _mod.capability_projection({k: v for k, v in _receipt().items() if k != "provider"})


def test_fails_closed_on_missing_or_ill_typed_model_usability_status():
    with pytest.raises(_mod.ReceiptProjectionError):
        _mod.capability_projection(_receipt(modelUsabilityStatus=None))
    with pytest.raises(_mod.ReceiptProjectionError):
        _mod.capability_projection({k: v for k, v in _receipt().items() if k != "modelUsabilityStatus"})


def test_fails_closed_on_ill_typed_schema_migration():
    with pytest.raises(_mod.ReceiptProjectionError):
        _mod.capability_projection(_receipt(schemaMigration="not-a-number"))
    with pytest.raises(_mod.ReceiptProjectionError):
        _mod.capability_projection(_receipt(schemaMigration=-1))
    with pytest.raises(_mod.ReceiptProjectionError):
        _mod.capability_projection(_receipt(schemaMigration=44.5))
    with pytest.raises(_mod.ReceiptProjectionError):
        _mod.capability_projection(_receipt(schemaMigration=True))
    with pytest.raises(_mod.ReceiptProjectionError):
        _mod.capability_projection({k: v for k, v in _receipt().items() if k != "schemaMigration"})


def test_fails_closed_on_ill_typed_fallback_chain():
    with pytest.raises(_mod.ReceiptProjectionError):
        _mod.capability_projection(_receipt(fallbackChain="not-an-array"))
    with pytest.raises(_mod.ReceiptProjectionError):
        _mod.capability_projection(_receipt(fallbackChain=[{"provider": "openai", "model": "x"}]))
    with pytest.raises(_mod.ReceiptProjectionError):
        _mod.capability_projection(
            _receipt(fallbackChain=[{"provider": 1, "model": "x", "eligible": True}])
        )
    with pytest.raises(_mod.ReceiptProjectionError):
        _mod.capability_projection(
            _receipt(fallbackChain=[{"provider": "openai", "model": "x", "eligible": "yes"}])
        )


def test_fails_closed_on_ill_typed_drift_check():
    with pytest.raises(_mod.ReceiptProjectionError):
        _mod.capability_projection(_receipt(driftCheck={"ok": "yes"}))
    with pytest.raises(_mod.ReceiptProjectionError):
        _mod.capability_projection({k: v for k, v in _receipt().items() if k != "driftCheck"})
    with pytest.raises(_mod.ReceiptProjectionError):
        _mod.capability_projection(_receipt(driftCheck="not-an-object"))


def test_redact_bundle_reuses_the_shared_scrubber_and_preserves_identity_fields():
    receipt = _receipt(
        commit="c" * 40,
        # Volatile free-text fields carrying sensitive-shaped content.
        driftIssues=["auth check for +1 212 555 0134 failed"],
        serviceActiveEnterTimestamp="/Users/testuser/.config/whatsoup/secrets/fleet.env was touched",
    )

    redacted = _mod.redact_bundle(receipt)

    # Volatile fields ARE scrubbed.
    assert "212" not in redacted["driftIssues"][0] and "555" not in redacted["driftIssues"][0]
    assert "[REDACTED PHONE]" in redacted["driftIssues"][0]
    assert "/Users/testuser" not in redacted["serviceActiveEnterTimestamp"]
    assert "[REDACTED CREDENTIAL PATH]" in redacted["serviceActiveEnterTimestamp"]

    # Identity-tagged fields survive untouched -- they are not phone/cred-like.
    assert redacted["commit"] == "c" * 40
    assert redacted["provider"] == "claude-cli"
    assert redacted["modelUsabilityStatus"] == "usable"
    assert redacted["schemaMigration"] == 44
    assert redacted["fallbackChain"] == receipt["fallbackChain"]
    assert redacted["driftCheck"] == receipt["driftCheck"]

    # The digest computed over the redacted bundle equals an independent
    # digest computed over a freshly-built, unredacted equivalent bundle --
    # proving redaction never touches a hashed (identity) field.
    unredacted_equivalent = _receipt(commit="c" * 40)
    assert _mod.capability_digest(redacted) == _mod.capability_digest(unredacted_equivalent)


def test_capture_assembles_a_bundle_from_injected_sources_without_live_io():
    health = {
        "generated_at": "2026-07-16T03:00:00Z",
        "uptime_seconds": 42,
        "instance": {
            "commit": "d" * 40,
            "branch": "main",
            "provider": "claude-cli",
            "fallbackChain": [{"provider": "openai", "model": "gpt-fallback", "eligible": True}],
        },
        "sqlite": {"schema_migration_latest": 44},
        "runtime": {"agent": {"turnCapability": {"modelUsabilityStatus": "usable"}}},
        "whatsapp": {
            # Real shape per `formatAuthBond` (health.ts:420-459): TWO nested
            # raw-path fields, `creds.path` AND `auth_dir.path` -- both must
            # be structurally excluded, not just one.
            "auth_bond": {
                "status": "ok",
                "auth_dir": {"path": "/Users/testuser/.local/share/whatsoup/instances/q/auth", "exists": True},
                "creds": {
                    "path": "/Users/testuser/.local/share/whatsoup/instances/q/auth/creds.json",
                    "hash": "abc123",
                },
            },
            "credential_lifecycle": {"status": "stable"},
        },
    }
    drift = {"ok": True, "checkedAt": "2026-07-16T02:00:00Z", "issues": []}

    bundle = _mod.capture(
        health=health,
        drift_check=drift,
        service_active_enter_timestamp=lambda: "2026-07-16T01:00:00Z",
        captured_at=lambda: "2026-07-16T03:00:00Z",
    )

    # Assembled bundle projects cleanly (proves the identity fields were wired
    # to the right health.ts sources, design §2.1).
    projection = _mod.capability_projection(bundle)
    assert projection["commit"] == "d" * 40
    assert projection["provider"] == "claude-cli"
    assert projection["modelUsabilityStatus"] == "usable"
    assert projection["schemaMigration"] == 44
    assert projection["driftOk"] is True

    # No live I/O: sources were plain dicts/callables the caller supplied.
    assert bundle["serviceActiveEnterTimestamp"] == "2026-07-16T01:00:00Z"
    assert bundle["capturedAt"] == "2026-07-16T03:00:00Z"

    # Structural exclusion (design §3): BOTH raw-path fields on the real
    # `formatAuthBond` shape (`creds.path` and `auth_dir.path`) never
    # survive, redacted or otherwise.
    assert "path" not in bundle["authBond"]["creds"]
    assert "path" not in bundle["authBond"]["auth_dir"]
    assert "/Users/testuser" not in json.dumps(bundle)
