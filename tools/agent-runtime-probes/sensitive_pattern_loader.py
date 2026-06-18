#!/usr/bin/env python3
"""sensitive_pattern_loader.py — Bead 2.1: the SECURITY SSOT for sensitive patterns.

ONE loader, consumed by BOTH `prompt_sanitizer` (2.2, mask/find_spans) and the
residual scan, so the masker and the residual check can NEVER diverge — that
divergence is a documented leak risk.

F4 finding: `/Users/testuser/.claude/config/secret-patterns.json` covers ONLY provider
API-token shapes. It has ZERO patterns for filesystem paths, `$USER`, hostnames,
repo/branch names, or long IDs — which are this machine's PRIMARY sensitive class
for the masker. Therefore this module:
  - LOADS provider-token patterns from that JSON, READ-ONLY. It NEVER mutates the
    shared global config file (other tools depend on it).
  - PROVIDES CAPE-embedded extended STRUCTURAL patterns for the missing classes:
    absolute paths, `$USER`/bare username, hostnames, git repo/branch tokens, and
    long numeric/hex IDs. Each carries a TYPE label (PATH, USER, HOST, REPO, ID)
    used by the masker's placeholder `<TYPE>`.

Fail-closed: a missing or malformed SSOT NEVER yields an empty pattern set that
silently passes everything. Missing → pattern_source_status="missing"; malformed →
"invalid" + parse_status="invalid". In BOTH cases the embedded structural patterns
are STILL returned (conservative fallback) so masking degrades SAFE, not open.

Reports are metadata-only: COUNTS + checksum only. NEVER the raw patterns or any
matched value.

CLI: python3 sensitive_pattern_loader.py [--config <secret-patterns.json>] [--pretty]
Output: JSON report to stdout.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

from probelib import redact, sha256_16

SCHEMA = "agent-runtime-sensitive-pattern-loader"
SCHEMA_VERSION = "0.1"

# Canonical SSOT path. READ-ONLY. This loader must never write to it.
DEFAULT_CONFIG_PATH = str(Path.home() / ".claude/config/secret-patterns.json")

# --- CAPE-embedded structural patterns (F4 closure) -----------------------
# These cover the masker's PRIMARY sensitive class which the provider-token JSON
# does NOT: filesystem paths, $USER/usernames, hostnames, repo/branch tokens, and
# long IDs. Each entry is (TYPE, raw_regex). TYPE feeds the masker's <TYPE>
# placeholder. Ordering is longest/most-specific first so a downstream
# longest-first span replacement is well-defined; the loader preserves this order.
_STRUCTURAL_SOURCES: tuple[tuple[str, str], ...] = (
    # PATH: a /Users/<name>/... home path, then general system roots. The first is
    # more specific (home dir) and intentionally precedes the general root form.
    ("PATH", r"/Users/[^/\s]+/\S*"),
    ("PATH", r"/(?:Users|home|var|opt|tmp|private)/\S+"),
    # USER: $USER / ${USER} env reference, then a bare-username token after "user".
    ("USER", r"\$\{?USER\}?"),
    ("USER", r"(?<=\buser\s)[A-Za-z_][A-Za-z0-9_-]{0,31}\b"),
    # HOST: FQDN-ish hostnames including the common *.local / *.lan / *.lab fleet
    # suffixes on this machine. Requires at least one dot to avoid matching bare
    # words.
    ("HOST", r"\b[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9-]{1,63})+\b"),
    # REPO: git repo/branch-ish tokens — owner/repo slugs and common branch refs.
    ("REPO", r"\b(?:refs/(?:heads|remotes|tags)/\S+|origin/\S+|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git)\b"),
    ("REPO", r"\b(?:feature|bugfix|hotfix|release|preserve)/[A-Za-z0-9._/-]+\b"),
    # ID: long numeric or hex identifiers (session ids, object hashes, etc.).
    ("ID", r"\b[0-9a-fA-F]{16,}\b"),
    ("ID", r"\b[0-9]{12,}\b"),
)


@dataclass
class PatternSet:
    """The SSOT surface imported by both the masker (2.2) and the residual scan.

    provider_patterns / structural_patterns are lists of (TYPE, compiled_regex).
    status        ∈ {ok, invalid, missing}  (== report's pattern_source_status)
    parse_status  ∈ {ok, invalid}
    checksum_sha256_16 — sha256_16 of the loaded config BYTES, or None if absent.
    """
    provider_patterns: list[tuple[str, "re.Pattern[str]"]] = field(default_factory=list)
    structural_patterns: list[tuple[str, "re.Pattern[str]"]] = field(default_factory=list)
    status: str = "ok"
    parse_status: str = "ok"
    checksum_sha256_16: str | None = None
    malformed_pattern_count: int = 0  # external regexes that failed to compile (recorded, not skipped)

    @property
    def provider_count(self) -> int:
        return len(self.provider_patterns)

    @property
    def structural_count(self) -> int:
        return len(self.structural_patterns)


def _compile_structural() -> list[tuple[str, "re.Pattern[str]"]]:
    """Compile the CAPE-embedded structural patterns (the conservative fallback).

    These are always available, even when the provider SSOT is missing/malformed,
    so masking can never degrade to an empty (fail-open) pattern set.
    """
    compiled: list[tuple[str, "re.Pattern[str]"]] = []
    for typ, src in _STRUCTURAL_SOURCES:
        try:
            compiled.append((typ, re.compile(src)))
        except re.error as exc:  # typed marker; a bad embedded pattern must surface
            raise ValueError(
                f"embedded structural pattern failed to compile [{typ}]: {type(exc).__name__}"
            ) from exc
    return compiled


def _extract_provider_patterns(
    data: dict,
) -> tuple[list[tuple[str, "re.Pattern[str]"]], int]:
    """Pull provider token-prefix + structural patterns from the SSOT dict.

    READ-ONLY: we only read; the dict came from a read of the file. A provider
    entry's TYPE label is "TOKEN"; the SSOT's own structural_patterns section maps
    to TYPE "SECRET". A single unparseable regex is skipped (not fatal) but does
    not silently empty the set — the caller still has the embedded fallback.
    """
    out: list[tuple[str, "re.Pattern[str]"]] = []
    malformed = 0  # malformed external regexes are RECORDED, never silently skipped
    providers = data.get("providers")
    if isinstance(providers, dict):
        for _name, entry in sorted(providers.items()):
            if not isinstance(entry, dict):
                continue
            for src in entry.get("token_prefix_patterns", []) or []:
                if not isinstance(src, str):
                    continue
                try:
                    out.append(("TOKEN", re.compile(src)))
                except re.error:
                    # One bad external regex does not fail the whole load (embedded
                    # fallback still guarantees coverage), but it is COUNTED and
                    # surfaced — never a silent fail-open skip.
                    malformed += 1
    structural = data.get("structural_patterns")
    if isinstance(structural, dict):
        for _name, entry in sorted(structural.items()):
            if not isinstance(entry, dict):
                continue
            for src in entry.get("patterns", []) or []:
                if not isinstance(src, str):
                    continue
                try:
                    out.append(("SECRET", re.compile(src)))
                except re.error:
                    malformed += 1
    return out, malformed


def load_patterns(config_path: str | None = None) -> PatternSet:
    """Load the sensitive-pattern SSOT. Fail-closed with conservative fallback.

    Returns a PatternSet whose structural_patterns are ALWAYS the embedded set
    (so masking never degrades open). provider_patterns are populated only when the
    SSOT is present and valid. status reflects the source health.
    """
    path = Path(config_path) if config_path else Path(DEFAULT_CONFIG_PATH)
    structural = _compile_structural()

    if not path.exists():
        # Conservative fallback: structural patterns only, typed "missing".
        return PatternSet(
            provider_patterns=[],
            structural_patterns=structural,
            status="missing",
            parse_status="ok",
            checksum_sha256_16=None,
        )

    # READ-ONLY read of the shared global config. Never opened for write.
    try:
        raw_bytes = path.read_bytes()
    except OSError:
        # Present but unreadable — treat as missing source (still fail-closed).
        return PatternSet(
            provider_patterns=[],
            structural_patterns=structural,
            status="missing",
            parse_status="ok",
            checksum_sha256_16=None,
        )

    checksum = sha256_16(raw_bytes.decode("utf-8", errors="replace"))

    try:
        data = json.loads(raw_bytes.decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        # Malformed SSOT: invalid status + conservative fallback. NOT a silent pass.
        return PatternSet(
            provider_patterns=[],
            structural_patterns=structural,
            status="invalid",
            parse_status="invalid",
            checksum_sha256_16=checksum,
        )

    if not isinstance(data, dict):
        # Valid JSON but wrong shape (e.g. a list): unsupported → invalid + fallback.
        return PatternSet(
            provider_patterns=[],
            structural_patterns=structural,
            status="invalid",
            parse_status="invalid",
            checksum_sha256_16=checksum,
        )

    provider, malformed = _extract_provider_patterns(data)
    return PatternSet(
        provider_patterns=provider,
        structural_patterns=structural,
        status="ok",
        parse_status="ok",
        checksum_sha256_16=checksum,
        malformed_pattern_count=malformed,
    )


def report(config_path: str | None = None) -> dict:
    """Metadata-only CLI report. Emits COUNTS + checksum, never raw patterns."""
    ps = load_patterns(config_path)
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only",
        "pattern_source_status": ps.status,
        "provider_count": ps.provider_count,
        "structural_count": ps.structural_count,
        "malformed_pattern_count": ps.malformed_pattern_count,
        "checksum_sha256_16": ps.checksum_sha256_16,
        "parse_status": ps.parse_status,
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Load the sensitive-pattern SSOT and emit a metadata-only report."
    )
    ap.add_argument(
        "--config",
        default=None,
        help=f"Path to secret-patterns.json (default: {DEFAULT_CONFIG_PATH})",
    )
    ap.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    args = ap.parse_args()

    rep = report(args.config)
    # Defense-in-depth: run the shared redactor over the (already metadata-only) report.
    rep = redact(rep)

    json.dump(rep, sys.stdout, indent=2 if args.pretty else None)
    sys.stdout.write("\n")

    # Fail-closed exit: any non-ok source status is a nonzero (unhappy) exit so a
    # caller/CI never mistakes a degraded SSOT for a clean load.
    if rep["pattern_source_status"] != "ok":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
