"""T05 deterministic qID identity and collision contracts."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import unicodedata
from dataclasses import FrozenInstanceError
from pathlib import Path
from typing import Any

import pytest
from qsesh.qid import (
    QidCollisionError,
    QidError,
    SessionIdentity,
    compute_identity,
    is_collision,
    qid_from_digest,
    require_no_collision,
)

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
VECTORS_PATH = Path(__file__).parent / "fixtures/qid-vectors.json"


def _fixture() -> dict[str, Any]:
    return json.loads(VECTORS_PATH.read_text(encoding="utf-8"))


def test_all_independent_vectors_match_full_production_identity() -> None:
    vectors = _fixture()["vectors"]
    observed = []

    for vector in vectors:
        identity = compute_identity(
            vector["host_id"], vector["harness"], vector["native_id"]
        )
        observed.append(vector["name"])
        assert identity.preimage.hex() == vector["preimage_hex"]
        assert identity.digest.hex() == vector["digest_hex"]
        assert identity.qid == vector["qid"]

    assert observed == [
        "claude-basic",
        "codex-basic",
        "opencode-basic",
        "separator-native",
        "unicode-native",
        "boundary-left",
        "boundary-right",
    ]


def test_visible_qid_shape_and_full_digest_width_are_fixed() -> None:
    identity = compute_identity("host-test-001", "claude", "session-claude-001")

    assert re.fullmatch(r"qs-[a-z2-7]{10}", identity.qid)
    assert len(identity.digest) == 32
    assert qid_from_digest(identity.digest) == identity.qid


def test_preimage_has_domain_and_unsigned_big_endian_byte_lengths() -> None:
    identity = compute_identity("host-test-001", "codex", "séssion-東京-🚀")
    cursor = len(b"qsesh-qid-v1\0")
    decoded = []
    for expected in ("host-test-001", "codex", "séssion-東京-🚀"):
        length = int.from_bytes(identity.preimage[cursor : cursor + 4], "big")
        cursor += 4
        value = identity.preimage[cursor : cursor + length]
        cursor += length
        decoded.append(value.decode("utf-8"))
        assert length == len(expected.encode("utf-8"))

    assert identity.preimage.startswith(b"qsesh-qid-v1\0")
    assert decoded == ["host-test-001", "codex", "séssion-東京-🚀"]
    assert cursor == len(identity.preimage)


def test_length_prefixes_defeat_equal_naive_concatenation_boundaries() -> None:
    left = compute_identity("host", "claude", "xclaudey")
    right = compute_identity("hostclaudex", "claude", "y")

    assert left.host_id + left.harness + left.native_id == (
        right.host_id + right.harness + right.native_id
    )
    assert left.preimage != right.preimage
    assert left.digest != right.digest
    assert left.qid != right.qid


def test_empty_native_id_fails_with_safe_typed_error() -> None:
    with pytest.raises(QidError) as caught:
        compute_identity("host-test-001", "opencode", "")

    assert caught.value.code == "QS-E-USAGE"
    assert caught.value.field == "native_id"
    assert str(caught.value) == "command input failed validation at native_id"


def test_invalid_host_id_fails_without_echoing_value() -> None:
    canary = "Mutable-MDNS-Host"

    with pytest.raises(QidError) as caught:
        compute_identity(canary, "claude", "session-001")

    assert caught.value.field == "host_id"
    assert canary not in str(caught.value)


def test_unknown_harness_fails_without_echoing_value() -> None:
    canary = "future-harness"

    with pytest.raises(QidError) as caught:
        compute_identity("host-test-001", canary, "session-001")

    assert caught.value.field == "harness"
    assert canary not in str(caught.value)


def test_native_unicode_is_not_normalized() -> None:
    composed = "session-é"
    decomposed = unicodedata.normalize("NFD", composed)

    left = compute_identity("host-test-001", "codex", composed)
    right = compute_identity("host-test-001", "codex", decomposed)

    assert composed != decomposed
    assert left.preimage != right.preimage
    assert left.digest != right.digest


def test_non_utf8_surrogate_native_id_fails_closed() -> None:
    with pytest.raises(QidError) as caught:
        compute_identity("host-test-001", "claude", "session-\ud800")

    assert caught.value.field == "native_id"
    assert "surrogate" not in str(caught.value)


def test_vector_repeats_byte_identically_in_a_subprocess() -> None:
    vector = _fixture()["vectors"][4]
    code = (
        "import json; from qsesh.qid import compute_identity; "
        f"x=compute_identity({vector['host_id']!r},{vector['harness']!r},"
        f"{vector['native_id']!r}); "
        "print(json.dumps({'preimage_hex':x.preimage.hex(),"
        "'digest_hex':x.digest.hex(),'qid':x.qid},sort_keys=True))"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        check=False,
        env=dict(
            os.environ,
            PYTHONPATH=str(PACKAGE_ROOT),
            PYTHONDONTWRITEBYTECODE="1",
        ),
    )

    assert result.returncode == 0
    assert result.stderr == b""
    assert json.loads(result.stdout) == {
        "digest_hex": vector["digest_hex"],
        "preimage_hex": vector["preimage_hex"],
        "qid": vector["qid"],
    }


def test_same_visible_prefix_with_distinct_digest_fails_loud() -> None:
    existing = bytes(32)
    incoming = bytes(6) + b"\x01" + bytes(25)
    assert existing != incoming
    assert qid_from_digest(existing) == qid_from_digest(incoming)
    assert is_collision(existing, incoming) is True

    with pytest.raises(QidCollisionError) as caught:
        require_no_collision(existing, incoming)

    assert caught.value.code == "QS-E-QID-COLLISION"
    assert caught.value.qid == qid_from_digest(existing)
    assert str(caught.value) == (
        "visible qID maps to a different full identity digest at identity"
    )
    assert existing.hex() not in str(caught.value)
    assert incoming.hex() not in str(caught.value)


def test_equal_digest_and_different_visible_prefix_are_not_collisions() -> None:
    existing = bytes(32)
    other_prefix = b"\xff" + bytes(31)

    assert is_collision(existing, existing) is False
    assert is_collision(existing, other_prefix) is False
    assert require_no_collision(existing, existing) is None
    assert require_no_collision(existing, other_prefix) is None


def test_session_identity_is_frozen() -> None:
    identity = compute_identity("host-test-001", "claude", "session-001")

    with pytest.raises(FrozenInstanceError):
        identity.qid = "qs-aaaaaaaaaa"  # type: ignore[misc]

    assert isinstance(identity, SessionIdentity)
