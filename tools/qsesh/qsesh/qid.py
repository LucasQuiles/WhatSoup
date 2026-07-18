"""Domain-separated deterministic qID identity."""

from __future__ import annotations

import base64
import hashlib
import re
from dataclasses import dataclass

from .errors import QseshError

QID_ERROR_CODE = "QS-E-USAGE"
QID_COLLISION_CODE = "QS-E-QID-COLLISION"
QID_DOMAIN = b"qsesh-qid-v1\0"
QID_DIGEST_BYTES = 32
QID_VISIBLE_CHARS = 10
_HOST_ID = re.compile(r"[a-z][a-z0-9._-]{0,63}").fullmatch
_HARNESSES = frozenset({"claude", "codex", "opencode"})


class QidError(QseshError):
    """Safe qID input failure without raw value disclosure."""

    def __init__(self, field: str) -> None:
        self.field = field
        super().__init__(QID_ERROR_CODE, phase=field)


class QidCollisionError(QseshError):
    """Fail-closed visible-prefix collision."""

    def __init__(self, qid: str) -> None:
        self.qid = qid
        super().__init__(QID_COLLISION_CODE, phase="identity")


@dataclass(frozen=True)
class SessionIdentity:
    host_id: str
    harness: str
    native_id: str
    preimage: bytes
    digest: bytes
    qid: str


def _encoded_field(value: str, field: str) -> bytes:
    try:
        encoded = value.encode("utf-8", errors="strict")
        length = len(encoded).to_bytes(4, "big", signed=False)
    except (UnicodeError, OverflowError):
        raise QidError(field) from None
    return length + encoded


def _validate_identity_fields(host_id: str, harness: str, native_id: str) -> None:
    if not isinstance(host_id, str) or _HOST_ID(host_id) is None:
        raise QidError("host_id")
    if not isinstance(harness, str) or harness not in _HARNESSES:
        raise QidError("harness")
    if not isinstance(native_id, str) or native_id == "":
        raise QidError("native_id")


def compute_identity(host_id: str, harness: str, native_id: str) -> SessionIdentity:
    _validate_identity_fields(host_id, harness, native_id)
    try:
        preimage = QID_DOMAIN + b"".join(
            _encoded_field(value, field)
            for field, value in (
                ("host_id", host_id),
                ("harness", harness),
                ("native_id", native_id),
            )
        )
    except QidError:
        raise
    digest = hashlib.blake2b(preimage, digest_size=QID_DIGEST_BYTES).digest()
    return SessionIdentity(
        host_id=host_id,
        harness=harness,
        native_id=native_id,
        preimage=preimage,
        digest=digest,
        qid=qid_from_digest(digest),
    )


def qid_from_digest(digest: bytes) -> str:
    if not isinstance(digest, bytes) or len(digest) != QID_DIGEST_BYTES:
        raise QidError("digest")
    encoded = base64.b32encode(digest).decode("ascii").lower().rstrip("=")
    return "qs-" + encoded[:QID_VISIBLE_CHARS]


def is_collision(existing_digest: bytes, incoming_digest: bytes) -> bool:
    existing_qid = qid_from_digest(existing_digest)
    incoming_qid = qid_from_digest(incoming_digest)
    return existing_qid == incoming_qid and existing_digest != incoming_digest


def require_no_collision(existing_digest: bytes, incoming_digest: bytes) -> None:
    if is_collision(existing_digest, incoming_digest):
        raise QidCollisionError(qid_from_digest(existing_digest))
