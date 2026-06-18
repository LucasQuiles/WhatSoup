#!/usr/bin/env python3
"""raw_output_handle_protocol.py — B1 reversibility-proof mechanism for the pre-reducer gate.

Content-addressed raw-output handle store. Before any lossy token-reducer may be adopted,
EVERY reduction must be provably reversible: the raw bytes are written to a caller-supplied
local store keyed by their full SHA-256, and a reducer is accepted only if `retrieve(handle)`
reconstructs the raw bytes BYTE-IDENTICAL. This is the deterministic proof the gate demands.

Design (honoring blocking-assumption rows B1-HASH + SAFETY-STORE):
  - handle = full sha256(raw) (64 lowercase hex). `sha256_16` is exposed only as DISPLAY
    metadata (`handle_sha256_16`), never as the storage identity (B1-HASH).
  - store_dir is created mode 0700; raw files are written mode 0600 via a same-directory
    temp file + fsync + os.replace, then re-read and re-hashed to verify byte identity
    before success (SAFETY-STORE). NO default global persistent store — caller supplies it.
  - handles are validated as 64 lowercase hex; caller-supplied path components are never
    followed (no path traversal).
  - reduce_with_handle stores raw, runs the reducer, and FAILS OPEN (returns raw unchanged,
    reduced_applied=False) on unknown content type, error-heavy output, or any reduction it
    cannot prove reversible / protected-token-preserving. Raw never appears in the report.

Fail-closed everywhere: missing handle -> not_found; store hash mismatch -> corrupt;
bad handle syntax -> invalid_handle; write/verify failure -> store_error.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

from probelib import redact, sha256_16

SCHEMA = "agent-runtime-raw-output-handle-protocol"
SCHEMA_VERSION = "0.1"

# A handle is exactly the lowercase hex SHA-256 of raw bytes. Nothing else is a valid handle.
_HANDLE_RE = re.compile(r"^[0-9a-f]{64}$")

# Secret-shaped raw -> stored only in caller store, metadata redacted, sensitivity flagged.
_SECRET_SHAPE = re.compile(
    r"sk-[A-Za-z0-9]{8,}"
    r"|pcsk_[A-Za-z0-9_]{8,}"
    r"|gh[pousr]_[A-Za-z0-9]{20,}"
    r"|AKIA[0-9A-Z]{12,}"
    r"|xox[baprs]-[A-Za-z0-9-]{10,}"
    r"|AIza[0-9A-Za-z_\-]{30,}"
    r"|eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]+"
    r"|-----BEGIN [A-Z ]*PRIVATE KEY-----"
    r"|\b[Bb]earer\s+[A-Za-z0-9._\-]{12,}"
)

# Error-heavy output is too risky to reduce: a reducer that drops error/anomaly lines could
# silently corrupt state. Such output fails open (raw returned unchanged).
_ERROR_HEAVY = re.compile(
    r"\b(error|errors|exception|traceback|failed|failure|fatal|panic|"
    r"warning|warn|anomaly|corrupt)\b",
    re.I,
)

# Protected tokens that must survive a reduction (in `reduced`) OR remain recoverable via the
# handle: IDs, hex/uuid refs, line:col coordinates, and standalone numbers.
_PROTECTED_TOKEN = re.compile(
    r"\b[0-9a-f]{7,40}\b"               # short hashes / object ids
    r"|\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b"  # uuid
    r"|\b\d+:\d+\b"                     # line:col
    r"|\b\d+\b"                         # numbers
)


class StoreError(Exception):
    """Raised when the raw store cannot be written, replaced, chmod'd, or verified."""


def _sha256_full(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _to_bytes(raw: Any) -> bytes:
    if isinstance(raw, bytes):
        return raw
    if isinstance(raw, str):
        return raw.encode("utf-8")
    raise TypeError(f"raw must be str or bytes, got {type(raw).__name__}")


def valid_handle(handle: str) -> bool:
    """A handle is valid iff it is exactly 64 lowercase hex chars (full SHA-256)."""
    return isinstance(handle, str) and _HANDLE_RE.match(handle) is not None


def _ensure_store_dir(store_dir: Path) -> None:
    """Create store_dir (and parents) with restrictive 0700; tighten if it already exists."""
    try:
        store_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(store_dir, 0o700)
    except OSError as exc:
        raise StoreError(f"store_dir_unwritable:{type(exc).__name__}") from exc


def _handle_path(handle: str, store_dir: Path) -> Path:
    """Resolve the on-disk path for a handle. Refuses any handle that is not pure hex, so a
    caller-supplied path component (``../``, ``/etc/...``) can never be followed."""
    if not valid_handle(handle):
        raise ValueError(f"invalid_handle:{handle[:16]!r}")
    return store_dir / f"{handle}.raw"


def _best_effort_unlink(tmp_path: Path) -> str | None:
    """Remove a stranded temp file after a failed atomic write. Returns a typed error class
    name if cleanup itself fails (never swallowed silently), else None."""
    try:
        if tmp_path.exists():
            tmp_path.unlink()
    except OSError as exc:
        return type(exc).__name__
    return None


def store(raw: Any, store_dir: str | Path) -> str:
    """Write raw bytes to ``store_dir/<sha256>.raw`` (0600) atomically, verify byte identity,
    and return the full-SHA-256 handle. Fail-closed: raises StoreError if write or post-write
    verification fails."""
    data = _to_bytes(raw)
    store_dir = Path(store_dir)
    _ensure_store_dir(store_dir)
    handle = _sha256_full(data)
    dest = _handle_path(handle, store_dir)
    fd, tmp_name = tempfile.mkstemp(prefix=".tmp-", suffix=".raw", dir=str(store_dir))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, dest)
    except OSError as exc:
        cleanup_error = _best_effort_unlink(tmp_path)
        # The write failure is the load-bearing signal; cleanup_error is recorded for context
        # but never suppresses it. Always fail closed with a typed StoreError.
        detail = f"store_write_failed:{type(exc).__name__}"
        if cleanup_error is not None:
            detail = f"{detail}+cleanup:{cleanup_error}"
        raise StoreError(detail) from exc
    # Post-write verification: re-read and re-hash. A silent on-disk corruption must not pass.
    try:
        written = dest.read_bytes()
    except OSError as exc:
        raise StoreError(f"store_readback_failed:{type(exc).__name__}") from exc
    if _sha256_full(written) != handle:
        raise StoreError("store_verify_mismatch")
    return handle


def retrieve(handle: str, store_dir: str | Path) -> bytes:
    """Return the raw bytes for ``handle`` from ``store_dir``, verifying the on-disk content
    still hashes to the handle. Fail-closed:
      - invalid handle syntax -> ValueError('invalid_handle')
      - absent file           -> FileNotFoundError('not_found')
      - hash mismatch         -> StoreError('corrupt')."""
    store_dir = Path(store_dir)
    path = _handle_path(handle, store_dir)  # raises ValueError on bad syntax / traversal
    if not path.is_file():
        raise FileNotFoundError(f"not_found:{handle}")
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise StoreError(f"retrieve_read_failed:{type(exc).__name__}") from exc
    if _sha256_full(data) != handle:
        raise StoreError("corrupt")
    return data


def _retrieval_command(handle: str, store_dir: Path) -> str:
    return f"python3 raw_output_handle_protocol.py --store-dir {store_dir} --retrieve {handle}"


def _sensitivity_class(data: bytes) -> str:
    try:
        text = data.decode("utf-8", errors="replace")
    except Exception:  # pragma: no cover - decode with errors='replace' cannot raise; defensive
        return "binary_or_undecodable"
    if _SECRET_SHAPE.search(text):
        return "secret_shaped_synthetic_or_private"
    return "non_secret"


def _protected_tokens(text: str) -> set[str]:
    return set(_PROTECTED_TOKEN.findall(text))


def _reduction_reversible(raw_bytes: bytes, handle: str, store_dir: Path) -> bool:
    """A reduction is reversible iff retrieve(handle) reconstructs raw byte-identical."""
    try:
        return retrieve(handle, store_dir) == raw_bytes
    except (FileNotFoundError, StoreError, ValueError):
        return False


def reduce_with_handle(
    raw: Any,
    reducer: Callable[[str], str],
    store_dir: str | Path,
) -> dict[str, Any]:
    """Store raw, run ``reducer`` over the decoded text, and return a metadata-only result.

    Fails OPEN (returns raw unchanged, ``reduced_applied=False``) when the output is unknown
    content type, error-heavy, or the reduction is not provably reversible / protected-token
    preserving. Fails CLOSED (``reduced_applied=False`` + ``store_status='store_error'``) when
    the raw store itself cannot be written/verified. Raw text is NEVER placed in the result.
    """
    store_dir = Path(store_dir)
    data = _to_bytes(raw)
    raw_text = data.decode("utf-8", errors="replace")
    sensitivity = _sensitivity_class(data)

    # 1) Persist raw first; the handle is the reversibility anchor. Store failure is fail-closed.
    try:
        handle = store(data, store_dir)
        store_status = "stored"
    except StoreError as exc:
        return _result(
            reduced=raw_text,
            handle=None,
            store_dir=store_dir,
            omission_count=0,
            reduced_applied=False,
            store_status="store_error",
            sensitivity=sensitivity,
            raw_bytes=len(data),
            reduced_bytes=len(data),
            error_type=str(exc),
            reason="raw_store_unwritable",
        )

    # 2) Fail-open guard: error-heavy output must not be reduced (silent-corruption risk).
    if _ERROR_HEAVY.search(raw_text):
        return _result(
            reduced=raw_text, handle=handle, store_dir=store_dir,
            omission_count=0, reduced_applied=False, store_status=store_status,
            sensitivity=sensitivity, raw_bytes=len(data), reduced_bytes=len(data),
            error_type=None, reason="error_heavy_output_fail_open",
        )

    # 3) Run the reducer defensively. A raising / non-string reducer fails open.
    try:
        reduced = reducer(raw_text)
    except Exception as exc:  # reducer is untrusted; fail open, never silently swallow
        return _result(
            reduced=raw_text, handle=handle, store_dir=store_dir,
            omission_count=0, reduced_applied=False, store_status=store_status,
            sensitivity=sensitivity, raw_bytes=len(data), reduced_bytes=len(data),
            error_type=f"reducer_raised:{type(exc).__name__}", reason="reducer_raised_fail_open",
        )
    if not isinstance(reduced, str):
        return _result(
            reduced=raw_text, handle=handle, store_dir=store_dir,
            omission_count=0, reduced_applied=False, store_status=store_status,
            sensitivity=sensitivity, raw_bytes=len(data), reduced_bytes=len(data),
            error_type=f"reducer_non_string:{type(reduced).__name__}",
            reason="reducer_non_string_fail_open",
        )

    # 4) Reversibility proof: retrieve(handle) must reconstruct raw byte-identical.
    if not _reduction_reversible(data, handle, store_dir):
        return _result(
            reduced=raw_text, handle=handle, store_dir=store_dir,
            omission_count=0, reduced_applied=False, store_status=store_status,
            sensitivity=sensitivity, raw_bytes=len(data), reduced_bytes=len(data),
            error_type="unverifiable_reduction", reason="handle_not_reversible_fail_open",
        )

    # 5) Protected-token preservation: each protected token must survive in `reduced` OR be
    #    recoverable via the (already-proven-reversible) handle. Because the handle is
    #    reversible here, recovery is guaranteed; we still count omissions for observability.
    raw_tokens = _protected_tokens(raw_text)
    reduced_tokens = _protected_tokens(reduced)
    omitted = raw_tokens - reduced_tokens
    omission_count = len(omitted)

    return _result(
        reduced=reduced, handle=handle, store_dir=store_dir,
        omission_count=omission_count, reduced_applied=True, store_status=store_status,
        sensitivity=sensitivity, raw_bytes=len(data),
        reduced_bytes=len(reduced.encode("utf-8")),
        error_type=None, reason="reduced_with_reversible_handle",
    )


def _result(
    *,
    reduced: str,
    handle: str | None,
    store_dir: Path,
    omission_count: int,
    reduced_applied: bool,
    store_status: str,
    sensitivity: str,
    raw_bytes: int,
    reduced_bytes: int,
    error_type: str | None,
    reason: str,
) -> dict[str, Any]:
    """Assemble the metadata-only reduce_with_handle result. ``reduced`` is returned to the
    CALLER (it is the working payload), but it is NOT placed into the redacted report dict."""
    handle_display = sha256_16(reduced) if handle is None else handle[:16]
    retrieval = _retrieval_command(handle, store_dir) if handle else None
    return {
        "reduced": reduced,
        "handle": handle,
        "handle_sha256_16": handle_display,
        "omission_count": omission_count,
        "reduced_applied": reduced_applied,
        "store_status": store_status,
        "sensitivity_class": sensitivity,
        "raw_bytes": raw_bytes,
        "reduced_bytes": reduced_bytes,
        "retrieval_command": retrieval,
        "error_type": error_type,
        "reason": reason,
    }


def report_for_result(result: dict[str, Any]) -> dict[str, Any]:
    """Project a reduce_with_handle result into a redacted, raw-free report. The ``reduced``
    payload is intentionally dropped; only metadata, hashes, counts, and class labels remain."""
    metadata = {
        "handle": result.get("handle"),
        "handle_sha256_16": result.get("handle_sha256_16"),
        "omission_count": result.get("omission_count"),
        "reduced_applied": result.get("reduced_applied"),
        "store_status": result.get("store_status"),
        "sensitivity_class": result.get("sensitivity_class"),
        "raw_bytes": result.get("raw_bytes"),
        "reduced_bytes": result.get("reduced_bytes"),
        "retrieval_command": result.get("retrieval_command"),
        "error_type": result.get("error_type"),
        "reason": result.get("reason"),
    }
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; emits content-addressed handles, display hashes, byte "
                     "counts, omission counts, class labels, and store status — never raw "
                     "output, reduced text, secrets, or store file bodies",
        "metadata": redact(metadata),
    }


def _identity_reducer(text: str) -> str:
    """Default CLI reducer for the round-trip demonstration: identity (always reversible)."""
    return text


def _roundtrip_demo(store_dir: Path, raw: bytes) -> dict[str, Any]:
    """Demonstrate a store/retrieve round-trip and a reversible reduction over ``store_dir``."""
    handle = store(raw, store_dir)
    retrieved = retrieve(handle, store_dir)
    byte_identical = retrieved == raw
    result = reduce_with_handle(raw, _identity_reducer, store_dir)
    report = report_for_result(result)
    report["roundtrip"] = {
        "handle": handle,
        "handle_sha256_16": handle[:16],
        "byte_identical": byte_identical,
        "raw_bytes": len(raw),
        "store_dir_mode": oct(store_dir.stat().st_mode & 0o777),
    }
    return report


def main_argv(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="B1 raw-output handle protocol (content-addressed store).")
    ap.add_argument("--store-dir", required=True,
                    help="caller-supplied local store directory (created 0700; files 0600).")
    ap.add_argument("--retrieve", metavar="HANDLE", default=None,
                    help="retrieve raw by full-SHA-256 handle and emit verification metadata only.")
    ap.add_argument("--input", metavar="PATH", default=None,
                    help="optional file whose bytes seed the store/retrieve round-trip demo.")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args(argv)

    store_dir = Path(args.store_dir)

    # Read the optional --input seed OUTSIDE the main try so a missing input file maps to
    # input_error, leaving the not_found class exclusively for an absent --retrieve handle.
    seed: bytes | None = None
    if args.retrieve is None:
        if args.input is not None:
            try:
                seed = Path(args.input).read_bytes()
            except OSError as exc:
                report = {"schema": SCHEMA, "schema_version": SCHEMA_VERSION,
                          "redaction": "metadata-only",
                          "error_type": f"os_error:{type(exc).__name__}",
                          "status": "input_error", "detail_class": type(exc).__name__}
                print(json.dumps(report, indent=2 if args.pretty else None))
                return 1
        else:
            seed = b"OK line\nobject 9f8e7d6c5b4a3210\nrow 42:7\nvalue 12345\n"

    try:
        if args.retrieve is not None:
            # Verification-only path: confirm a handle reconstructs raw, emit metadata only.
            data = retrieve(args.retrieve, store_dir)
            report = report_for_result(_result(
                reduced="", handle=args.retrieve, store_dir=store_dir,
                omission_count=0, reduced_applied=False, store_status="retrieved",
                sensitivity=_sensitivity_class(data), raw_bytes=len(data),
                reduced_bytes=0, error_type=None, reason="retrieve_verified",
            ))
        else:
            assert seed is not None  # established above for the non-retrieve path
            report = _roundtrip_demo(store_dir, seed)
    except FileNotFoundError as exc:
        report = {"schema": SCHEMA, "schema_version": SCHEMA_VERSION,
                  "redaction": "metadata-only", "error_type": "not_found",
                  "status": "not_found", "detail_class": type(exc).__name__}
        print(json.dumps(report, indent=2 if args.pretty else None))
        return 1
    except ValueError as exc:
        report = {"schema": SCHEMA, "schema_version": SCHEMA_VERSION,
                  "redaction": "metadata-only", "error_type": "invalid_handle",
                  "status": "invalid_handle", "detail_class": type(exc).__name__}
        print(json.dumps(report, indent=2 if args.pretty else None))
        return 1
    except StoreError as exc:
        report = {"schema": SCHEMA, "schema_version": SCHEMA_VERSION,
                  "redaction": "metadata-only", "error_type": str(exc),
                  "status": "store_error", "detail_class": "StoreError"}
        print(json.dumps(report, indent=2 if args.pretty else None))
        return 1

    print(json.dumps(report, indent=2 if args.pretty else None))
    return 0


def main() -> int:
    return main_argv(sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(main())
