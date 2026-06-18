#!/usr/bin/env python3
"""sterilize_for_delegation — mask sensitive shapes out of a file BEFORE it is staged to a
third-party (opencode) worker, and rehydrate the worker's findings afterward.

This is the production sanitize-then-delegate boundary. It reuses the CAPE masker
(`prompt_sanitizer`, Bead 2.2) and the SSOT pattern source (`sensitive_pattern_loader`,
Bead 2.1). The load-bearing guarantee: a sterilized artifact is emitted ONLY if it is
residual-clean — if ANY sensitive shape (path/$USER/host/repo/ID/secret) survives the mask,
sterilization FAILS CLOSED and refuses to write the output, so unsanitized data can never
cross the trust boundary.

The swapmap (placeholder -> original) is written to a LOCAL map file that must NEVER be
staged to a worker; it is used only to rehydrate findings back on this machine.

Modes:
  sterilize  --in <file> --out <masked> --map <swapmap.json> [--session-key <str>]
  rehydrate  --findings <file> --map <swapmap.json> --out <rehydrated>

CLI emits a metadata-only JSON report to stdout (counts/status; never raw values).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# Reuse the estate's single-home helpers + the CAPE masker/SSOT (no reimplementation).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from probelib import redact, sha256_16  # noqa: E402
import sensitive_pattern_loader as spl  # noqa: E402
import prompt_sanitizer as ps  # noqa: E402

SCHEMA = "agent-runtime-sterilize-for-delegation"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"


class SterilizeError(ValueError):
    """Typed, fail-closed error: never emit an unsanitized artifact."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message

    def as_marker(self) -> dict:
        return {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "redaction": REDACTION,
            "error_type": self.error_type,
            "_error": self.message,
            "status": "blocked",
        }


def _fresh_session_key(supplied: str | None) -> str:
    """A non-empty per-run session key. A caller value is honored; otherwise a fresh
    random key is generated so the placeholder nonce is unique per sterilization run."""
    if supplied:
        return supplied
    return os.urandom(16).hex()


def sterilize(src_text: str, session_key: str) -> tuple[str, dict]:
    """Mask sensitive shapes out of src_text. Returns (masked_text, swapmap).

    FAIL-CLOSED: raises SterilizeError if any sensitive shape survives masking, so the
    caller never writes/egresses unsanitized content.
    """
    patterns = spl.load_patterns()
    if patterns.status not in ("ok", "missing", "invalid"):
        raise SterilizeError("pattern_source", f"unexpected pattern status {patterns.status!r}")
    nonce = ps.session_nonce(session_key)
    masked, swapmap = ps.mask(src_text, nonce, patterns)
    residual = ps.residual_scan(masked, patterns)
    if residual:
        # Do NOT return a partially-masked artifact; refuse to cross the boundary.
        raise SterilizeError(
            "residual_leak",
            f"{len(residual)} sensitive shape(s) survived masking; refusing to emit",
        )
    return masked, swapmap


def rehydrate_findings(findings_text: str, swapmap: dict) -> str:
    """Swap every known placeholder back to its original value in a worker's findings.

    Unlike strict round-trip rehydration, findings are free prose that contain SOME
    placeholders; we replace each known placeholder occurrence and leave all other text
    untouched. A placeholder the worker hallucinated (not in the map) is left as-is.
    """
    if not isinstance(swapmap, dict):
        raise SterilizeError("invalid_map", "swapmap must be a dict")
    out = findings_text
    # Replace longest placeholders first so no placeholder is a prefix of another.
    for placeholder in sorted(swapmap, key=len, reverse=True):
        out = out.replace(placeholder, str(swapmap[placeholder]))
    return out


def _read_text(path: Path) -> str:
    if not path.exists():
        raise SterilizeError("missing_input", f"input not found: sha256_16={sha256_16(str(path))}")
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        # H4: the OSError message embeds the raw path (e.g. "[Errno 13] ...: '/Users/testuser/...'");
        # hash it so no raw absolute path crosses the metadata-only boundary.
        raise SterilizeError("read_error", f"{type(exc).__name__}: path_sha256_16={sha256_16(str(path))}") from exc


def _do_sterilize(args: argparse.Namespace) -> dict:
    src = _read_text(Path(args.__dict__["in"]))
    masked, swapmap = sterilize(src, _fresh_session_key(args.session_key))
    # Write the masked artifact (safe to stage) and the swapmap (LOCAL ONLY, never staged).
    out_path = Path(args.out)
    map_path = Path(args.map)
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    tmp.write_text(masked, encoding="utf-8")
    os.replace(tmp, out_path)
    map_path.write_text(json.dumps(swapmap, sort_keys=True), encoding="utf-8")
    try:
        os.chmod(map_path, 0o600)
    except OSError as exc:
        raise SterilizeError("map_chmod", f"could not 0600 the swapmap: {exc}") from exc
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": REDACTION,
        "mode": "sterilize",
        "input_sha256_16": sha256_16(src),
        "masked_sha256_16": sha256_16(masked),
        "placeholder_count": len(swapmap),
        "residual_clean": True,
        "status": "ok",
    }


def _do_rehydrate(args: argparse.Namespace) -> dict:
    findings = _read_text(Path(args.findings))
    map_path = Path(args.map)
    raw_map = _read_text(map_path)
    try:
        swapmap = json.loads(raw_map)
    except json.JSONDecodeError as exc:
        raise SterilizeError("invalid_map", f"swapmap parse failed: {exc}") from exc
    rehydrated = rehydrate_findings(findings, swapmap)
    out_path = Path(args.out)
    # C1: atomic write (temp + os.replace) so an interrupted rehydrate can't leave a
    # partially-written output silently reported as ok; emit an integrity hash.
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    tmp.write_text(rehydrated, encoding="utf-8")
    os.replace(tmp, out_path)
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": REDACTION,
        "mode": "rehydrate",
        "placeholders_in_map": len(swapmap),
        "rehydrated_sha256_16": sha256_16(rehydrated),
        "status": "ok",
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Sterilize a file for third-party delegation, or rehydrate findings.")
    sub = ap.add_subparsers(dest="mode", required=True)
    s = sub.add_parser("sterilize")
    s.add_argument("--in", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--map", required=True)
    s.add_argument("--session-key", default=None)
    r = sub.add_parser("rehydrate")
    r.add_argument("--findings", required=True)
    r.add_argument("--map", required=True)
    r.add_argument("--out", required=True)
    args = ap.parse_args()

    try:
        if args.mode == "sterilize":
            report = _do_sterilize(args)
        else:
            report = _do_rehydrate(args)
    except SterilizeError as exc:
        json.dump(redact(exc.as_marker()), sys.stdout)
        sys.stdout.write("\n")
        return 1

    json.dump(redact(report), sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
