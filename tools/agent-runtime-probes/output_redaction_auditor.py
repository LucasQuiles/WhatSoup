#!/usr/bin/env python3
"""output_redaction_auditor — Phase 4 bead 4.4: mechanical metadata-only enforcement.

Every CAPE report CLAIMS to be metadata-only; this gate AUDITS that claim. It walks a report's string
values (recursively) and flags any that carry a HIGH-PRECISION sensitive shape — a secret, an API token, an
absolute filesystem path, or a repo reference — reusing the SSOT patterns via `prompt_sanitizer.residual_scan`
(which returns TYPE + hash, never the raw value). A leak fails the gate fail-closed.

PRECISION (load-bearing, verified): this runs on EVERY report, so a false positive is fatal. The loose
SSOT classes HOST / USER / ID match benign numeric metadata (e.g. the HOST pattern matches `0.4`), so they
are DELIBERATELY EXCLUDED here — those PII shapes are handled at the field-name redaction layer
(`probelib.redact`). The auditor flags only {TOKEN, SECRET, PATH, REPO}, which do not trip on ratios /
counts / scores. HONEST SCOPE: it detects sensitive SHAPES, not arbitrary raw prose/schema (which cannot be
recognized generically); a CAPE placeholder (`__CAPE_..._PATH_1__`) is masked, not a leak, so it does not match.

Reuses `prompt_sanitizer.residual_scan` + `sensitive_pattern_loader` (neither is a plane verdict gate);
fail-closed; metadata-only itself (field paths + leak types + value HASHES, never the raw leaked value).
proof_class `deterministic_verifier`.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact  # noqa: E402
import prompt_sanitizer as ps  # noqa: E402
import sensitive_pattern_loader as spl  # noqa: E402

SCHEMA = "agent-runtime-output-redaction-auditor"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

# High-precision leak classes only — these do not false-positive on numeric metadata. HOST/USER/ID are
# excluded (they match bare numbers/words) and rely on field-name redaction instead.
LEAK_TYPES = frozenset({"TOKEN", "SECRET", "PATH", "REPO"})


def _walk(obj, prefix: str = ""):
    """Yield (field_path, string_value) for every string leaf in a JSON-like structure."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from _walk(v, f"{prefix}.{k}" if prefix else str(k))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from _walk(v, f"{prefix}[{i}]")
    elif isinstance(obj, str):
        yield (prefix or "<root>", obj)


def audit_report(report, patterns=None) -> dict:
    """Scan one report for high-precision sensitive-shape leaks. Fail-closed; metadata-only."""
    patterns = patterns if patterns is not None else spl.load_patterns(None)
    leaks: list = []
    scanned = 0
    for field_path, value in _walk(report):
        scanned += 1
        for hit in ps.residual_scan(value, patterns):
            leak_type, _, value_hash = hit.partition(":")
            if leak_type in LEAK_TYPES:
                leaks.append({"field_path": field_path, "leak_type": leak_type,
                              "value_sha256_16": value_hash})
    return redact({
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "scanned_string_count": scanned,
        "leak_count": len(leaks),
        "leaks": leaks,
        "audited_leak_types": sorted(LEAK_TYPES),
        "overall_verdict": "FAIL" if leaks else "PASS",
    })


def audit_reports(reports: list, patterns=None) -> dict:
    """Audit a corpus of reports. Worst-case, fail-closed: PASS only if EVERY report is leak-free."""
    if not isinstance(reports, list) or not reports:
        return {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "proof_class": "deterministic_verifier", "report_count": 0,
            "overall_verdict": "FAIL", "error_type": "empty_corpus",
        }
    patterns = patterns if patterns is not None else spl.load_patterns(None)
    results = [audit_report(r, patterns) for r in reports]
    leaky = [i for i, r in enumerate(results) if r["overall_verdict"] != "PASS"]
    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "report_count": len(results),
        "leaky_report_count": len(leaky),
        "leaky_report_indices": leaky,
        "total_leak_count": sum(r["leak_count"] for r in results),
        "results": results,
        "overall_verdict": "PASS" if not leaky else "FAIL",
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Audit a CAPE report (or list of reports) for sensitive-shape "
                                             "leaks — enforce metadata-only fail-closed.")
    ap.add_argument("--report", required=True, help="JSON file: a report dict, or a list of report dicts")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    def _emit(obj: dict, rc: int) -> int:
        json.dump(redact(obj), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return rc

    path = Path(args.report)
    if not path.exists():
        return _emit({"schema": SCHEMA, "error_type": "missing_report",
                      "_error": "report not found", "overall_verdict": "FAIL"}, 1)
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return _emit({"schema": SCHEMA, "error_type": "malformed_report",
                      "_error": f"JSONDecodeError: {exc}", "overall_verdict": "FAIL"}, 1)
    report = audit_reports(obj) if isinstance(obj, list) else audit_report(obj)
    return _emit(report, 0 if report["overall_verdict"] == "PASS" else 1)


if __name__ == "__main__":
    raise SystemExit(main())
