#!/usr/bin/env python3
"""attestation_purity_guard — the MECHANICAL interlock that keeps the plane-agnostic attestation
tier free of any verdict/plane/gate vocabulary, and pins its closed record field sets.

Why mechanical, not conventional: architecture A is correct on day 1 and fails on day N when a
well-meaning DRY refactor hoists a shared verdict predicate (e.g. `quality_not_worse`) UP into the
agnostic attestation module — silently making the two planes share verdict logic. A code-review
convention does not survive that refactor; an AST guard run in CI does.

Checks (fail-closed — a parse error or missing module is a FAIL, never a clean skip):
  1. No forbidden identifier (verdict / plane / gate vocabulary) appears anywhere in the module.
  2. No import from a known verdict-gate module.
  3. The `Attestation` and `Benefit` dataclass field sets EXACTLY match their closed allowlists, so
     nobody can append a `plane`/`verdict`/`adopt` field.

CLI: python3 tools/attestation_purity_guard.py [--module <path>] [--pretty]; exit 0 iff clean.
"""
from __future__ import annotations

import argparse
import ast
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from probelib import redact, sha256_16  # noqa: E402

SCHEMA = "agent-runtime-attestation-purity"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

DEFAULT_MODULE = Path(__file__).resolve().parent.parent / "mutation_proof_chain.py"

# Whole-word tokens banned from the attestation tier (split identifiers on "_" before matching, so
# "investigate" is fine but a bare "gate" or "quality_not_worse" is caught).
FORBIDDEN_WORDS = frozenset({
    "plane", "verdict", "adopt", "adopted", "reject", "rejected", "gate", "gates",
    "decide", "decision", "paired", "trial", "lift", "adoptable",
    # red-team G-A6 synonym family (verdict/plane/routing vocabulary). Excludes words the attestation
    # tier legitimately uses as identifiers (e.g. "classify" in classify_delta).
    "route", "routed", "routing", "reducer", "enricher", "lane", "arm", "tier",
    "dispatch", "dispatched", "accept", "accepted", "deny", "denied", "threshold",
})
# Import ALLOWLIST (red-team G-A4: a 2-name blocklist was evadable by renaming the helper module).
# Anything outside this set is a forbidden import — verdict/plane logic cannot be hoisted into an
# unscanned helper. Top-level module name only (dotted imports compared on their head).
ALLOWED_IMPORT_MODULES = frozenset({
    "__future__", "argparse", "ast", "hashlib", "json", "os", "re", "sys", "unicodedata",
    "dataclasses", "pathlib", "typing", "probelib", "math", "collections", "functools", "itertools",
})

ATTESTATION_FIELDS = frozenset({
    "chain_id", "step_index", "declared_purpose", "delta_type", "input_hash", "output_hash",
    "prev_record_hash", "determinism_ok", "benefit", "record_hash",
})
BENEFIT_FIELDS = frozenset({"value", "unit", "direction", "proof_class", "evidence_ref"})


class PurityError(ValueError):
    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message


def _forbidden_hit(identifier: str) -> str | None:
    parts = {p.lower() for p in identifier.split("_") if p}
    hit = parts & FORBIDDEN_WORDS
    return sorted(hit)[0] if hit else None


def _dataclass_fields(tree: ast.AST, class_name: str) -> set[str] | None:
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            fields = set()
            for stmt in node.body:
                if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                    fields.add(stmt.target.id)
            return fields
    return None


def scan_module(path: Path) -> dict:
    """Return a metadata-only purity report. Fail-closed on read/parse failure."""
    if not path.exists():
        raise PurityError("missing_module", f"module not found: sha256_16={sha256_16(str(path))}")
    try:
        source = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise PurityError("read_error", f"{type(exc).__name__}: sha256_16={sha256_16(str(path))}") from exc
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        raise PurityError("parse_error", f"SyntaxError: line {exc.lineno}") from exc

    findings: list[dict] = []

    # 1 + 2: vocabulary + imports.
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            hit = _forbidden_hit(node.id)
            if hit:
                findings.append({"kind": "forbidden_identifier", "word": hit, "line": node.lineno})
        elif isinstance(node, ast.Attribute):
            hit = _forbidden_hit(node.attr)
            if hit:
                findings.append({"kind": "forbidden_attribute", "word": hit, "line": node.lineno})
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            hit = _forbidden_hit(node.name)
            if hit:
                findings.append({"kind": "forbidden_def", "word": hit, "line": node.lineno})
        elif isinstance(node, ast.arg):
            hit = _forbidden_hit(node.arg)
            if hit:
                findings.append({"kind": "forbidden_arg", "word": hit, "line": node.lineno})
        elif isinstance(node, ast.ImportFrom):
            head = (node.module or "").split(".")[0]
            if node.level != 0 or head not in ALLOWED_IMPORT_MODULES:
                findings.append({"kind": "forbidden_import", "module": node.module, "line": node.lineno})
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] not in ALLOWED_IMPORT_MODULES:
                    findings.append({"kind": "forbidden_import", "module": alias.name, "line": node.lineno})
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ("getattr", "setattr"):
            # dynamic dispatch can reach a verdict-named method without spelling it (red-team G-A3).
            attr_arg = node.args[1] if len(node.args) >= 2 else None
            if not isinstance(attr_arg, ast.Constant):
                findings.append({"kind": "dynamic_dispatch", "call": node.func.id, "line": node.lineno})

    # 3: closed field sets.
    att = _dataclass_fields(tree, "Attestation")
    ben = _dataclass_fields(tree, "Benefit")
    field_findings = []
    if att is None:
        field_findings.append({"kind": "attestation_class_absent"})
    elif att != set(ATTESTATION_FIELDS):
        field_findings.append({
            "kind": "attestation_field_drift",
            "unexpected": sorted(att - set(ATTESTATION_FIELDS)),
            "missing": sorted(set(ATTESTATION_FIELDS) - att),
        })
    if ben is None:
        field_findings.append({"kind": "benefit_class_absent"})
    elif ben != set(BENEFIT_FIELDS):
        field_findings.append({
            "kind": "benefit_field_drift",
            "unexpected": sorted(ben - set(BENEFIT_FIELDS)),
            "missing": sorted(set(BENEFIT_FIELDS) - ben),
        })
    findings.extend(field_findings)

    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "module_sha256_16": sha256_16(str(path)),
        "vocabulary_clean": not any(
            f["kind"].startswith("forbidden") or f["kind"] == "dynamic_dispatch" for f in findings
        ),
        "fields_pinned": not field_findings,
        "finding_count": len(findings),
        "findings": findings,
        "verdict": "PASS" if not findings else "FAIL",
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Mechanical purity guard for the attestation tier.")
    ap.add_argument("--module", default=str(DEFAULT_MODULE))
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    try:
        report = scan_module(Path(args.module))
    except PurityError as exc:
        report = {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "error_type": exc.error_type, "_error": exc.message, "verdict": "FAIL",
        }
        json.dump(redact(report), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 1

    json.dump(redact(report), sys.stdout, indent=2 if args.pretty else None)
    sys.stdout.write("\n")
    return 0 if report["verdict"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
