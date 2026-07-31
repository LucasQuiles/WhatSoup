#!/usr/bin/env python3
"""corpus_guard.py — fitness function for the AGENT-RUNTIME-* corpus.

Mechanically enforces the regression + lean invariants that a manual review keeps
having to re-catch. Read-only. Fail-closed: exits non-zero if any HIGH check fails,
so it can gate a writer pass or run in the monitoring loop.

Checks (each emits a versioned, machine-readable verdict):
  1. mcp_consistency (HIGH)  — no canonical doc may assert the stale "plugin MCP not
     live / does not list plugin MCP" reading or list Sentry as an active codex MCP,
     since the 2026-06-15 20:53 live probe settled: 5 plugin MCP CONNECTED (pinecone,
     episodic-memory, chrome, tmup, microsoft_365); no Sentry in `codex mcp list`.
  2. lean_corpus (HIGH on doc-count ceiling, MED on section dup) — doc count must stay
     <= ceiling; canonical-only sections (Safety Boundaries / Gap Register / Proof
     Artifacts) must not re-accumulate across docs; retire/merge targets (D4) flagged
     while still present.
  3. probe_hygiene (HIGH/MED) — every probe should carry a schema_version envelope,
     declare a redaction posture, use dotted schema versions, have README parity, and
     avoid copy-pasting the security-critical redact() helper.

Usage: python3 corpus_guard.py [--root DIR] [--pretty] [--ceiling N]
Output: JSON to stdout. Exit 0 = clean, 2 = HIGH violation(s), 1 = internal error.
"""
from __future__ import annotations
import argparse
import ast
import json
import re
import sys
import time
from pathlib import Path

SCHEMA = "agent-runtime-corpus-guard"
SCHEMA_VERSION = "0.1"

# Docs that are process logs / historical audit records — they legitimately quote the
# OLD (stale) readings as history, so the consistency check must not flag them.
HISTORICAL = {
    "AGENT-RUNTIME-MONITORING-LOG.md",
    "AGENT-RUNTIME-AUDIT-FINDINGS-2026-06-14.md",
    "AGENT-RUNTIME-SWARM-REVIEW-2026-06-14.md",
    "AGENT-RUNTIME-GOALS.md",
    # Goals runner leaf/branch docs — process docs, not reference corpus.
    "AGENT-RUNTIME-GOALS-OBJECTIVES.md",
    "AGENT-RUNTIME-GOALS-FRONTIER.md",
    "AGENT-RUNTIME-GOALS-WORKSURFACE.md",
}

# A stale-pattern match is exculpated if its ±2-line window labels the old reading as
# superseded/reconciled (multi-line reconciliation prose is common in this corpus).
EXCULPATORY = re.compile(
    r"supersed|predated|missed the plugin|no longer stale|earlier|historical|"
    r"stale until|was stale|RESOLVES it|correction|reconcil|live re-probe|"
    r"re-probe|delta|now connected|5 plugin mcp", re.I)

STALE_MCP_PATTERNS = [
    re.compile(r"does not (list|report)[^.\n]{0,40}plugin mcp", re.I),
    re.compile(r"plugin mcp availability as (stale|not live)", re.I),
    re.compile(r"treat plugin mcp[^.\n]{0,30}(stale|not live)", re.I),
]
# Sentry asserted as an ACTIVE codex MCP: the word must sit within 40 chars of an
# enabled/connected marker. Negations, wrapper-inventory, and API-harness refs are clean.
SENTRY_ACTIVE = re.compile(
    r"sentry[^|\n]{0,40}(enabled|connected|✔)|(enabled|connected|✔)[^|\n]{0,40}sentry", re.I)
SENTRY_OK = re.compile(
    r"no sentry|not in|does not|not list|isn't|api[- ]harness|wrapper|sentry-mcp|"
    r"archived|absent|removed|discoverable|historical|without sentry|deleted|stale", re.I)

# These headers recur across docs. Direct content sampling (2026-06-15) confirmed each is
# doc-SPECIFIC (a doc's own safety rules / gaps / proofs), NOT verbatim boilerplate — so
# per-doc presence is legitimate, not waste. Only EGREGIOUS re-accumulation (the original
# x5-6 problem) fails; 2-SECTION_HARD_LIMIT holders is an informational note.
CANONICAL_SECTIONS = ("## Safety Boundaries", "## Gap Register", "## Proof Artifacts")
SECTION_HARD_LIMIT = 4
PROCESS_DOCS_CURRENT_HEAD_AUTHORITY = {
    "AGENT-RUNTIME-GOALS.md",
    "AGENT-RUNTIME-GOALS-OBJECTIVES.md",
    "AGENT-RUNTIME-GOALS-FRONTIER.md",
    "AGENT-RUNTIME-GOALS-WORKSURFACE.md",
}
VOLATILE_WHATSOUP_HEAD_REF = re.compile(
    r"\btest/coverage-ratchet-next-20260615d@[0-9a-f]{7,40}\b")
RETIRE_TARGETS = [  # D4 merge/retire backlog — flagged while still present
    "AGENT-RUNTIME-INVESTIGATION-PACKET.md",
    "AGENT-RUNTIME-CONTEXT-AND-PROVIDER-PATH.md",
    "AGENT-RUNTIME-CORE-OPTIMIZATION-RESEARCH-2026-06-14.md",
    "AGENT-RUNTIME-SWARM-REVIEW-2026-06-14.md",
]
LIBRARIES = {"bot_errors_probe_observation.py", "corpus_guard.py", "probelib.py"}
SCHEMA_CONST = re.compile(r"\bSCHEMA_VERSION\s*=\s*['\"]([^'\"]+)['\"]")
SCHEMA_FIELD = re.compile(r"['\"]schema_version['\"]\s*:\s*['\"]([^'\"]+)['\"]")
SCHEMA_VALUE_OK = re.compile(r"^\d+\.\d+$")
README_SCRIPT_ROW = re.compile(r"^\|\s*`([^`]+\.py)`\s*\|")
FAIL_OPEN_EMPTY_KINDS = {"none", "empty_list", "empty_dict", "bare_return"}
UNHAPPY_TEST_TERMS = (
    "malformed",
    "invalid",
    "missing",
    "permission",
    "timeout",
    "nonzero",
    "error",
    "_error",
    "degraded",
    "parse_status",
    "read_error",
    "jsondecodeerror",
    "oserror",
    "filenotfounderror",
    "timeoutexpired",
    "systemexit",
    "not_present",
    "not_available",
    "not_probed",
    "absent",
)


def check_mcp_consistency(docs: dict[str, list[str]]) -> dict:
    violations = []
    for name, lines in docs.items():
        if name in HISTORICAL:
            continue
        n = len(lines)
        for i, line in enumerate(lines, 1):
            window = " ".join(lines[max(0, i - 3):min(n, i + 2)])
            for pat in STALE_MCP_PATTERNS:
                if pat.search(line) and not EXCULPATORY.search(window):
                    violations.append({"doc": name, "line": i, "kind": "stale_plugin_mcp",
                                       "text": line.strip()[:160]})
            if SENTRY_ACTIVE.search(line) and not SENTRY_OK.search(line):
                violations.append({"doc": name, "line": i, "kind": "active_sentry",
                                   "text": line.strip()[:160]})
    return {"name": "mcp_consistency", "severity": "high",
            "status": "fail" if violations else "pass", "violations": violations}


def check_lean_corpus(root: Path, docs: dict[str, list[str]], ceiling: int) -> dict:
    violations = []
    # Process logs (monitoring/audit records) are not reference-corpus bloat; the lean
    # ceiling governs REFERENCE docs only. Lean reference target = 13 (the original ~11
    # estimate predated RUNNER/SCOPE/CURRENT-STATE, which are load-bearing additions).
    ref_docs = [n for n in docs if n not in HISTORICAL]
    doc_count = len(ref_docs)
    if doc_count > ceiling:
        violations.append({"kind": "doc_count_ceiling", "severity": "high",
                           "observed": doc_count, "ceiling": ceiling,
                           "note": f"{doc_count} reference docs (excl. process logs); lean target {ceiling}"})
    # section re-accumulation: per-doc sections are doc-specific (sampled) and legitimate;
    # only counts beyond SECTION_HARD_LIMIT fail. 2..LIMIT holders -> informational note.
    notes = []
    for header in CANONICAL_SECTIONS:
        holders = [n for n, ls in docs.items()
                   if n not in HISTORICAL and any(l.strip() == header for l in ls)]
        if len(holders) > SECTION_HARD_LIMIT:
            violations.append({"kind": "section_dup", "severity": "medium",
                               "section": header, "count": len(holders),
                               "limit": SECTION_HARD_LIMIT, "docs": holders})
        elif len(holders) > 1:
            notes.append({"section": header, "count": len(holders), "docs": holders,
                          "note": "doc-specific content (sampled 2026-06-15); verbatim dedup is a manual judgment"})
    # retire/merge backlog still present
    present = [t for t in RETIRE_TARGETS if (root / t).exists()]
    if present:
        violations.append({"kind": "retire_backlog", "severity": "medium",
                           "note": "D4 retire/merge targets still present", "docs": present})
    volatile_refs = []
    for name in sorted(PROCESS_DOCS_CURRENT_HEAD_AUTHORITY):
        for i, line in enumerate(docs.get(name, []), 1):
            if VOLATILE_WHATSOUP_HEAD_REF.search(line):
                volatile_refs.append({"doc": name, "line": i, "text": line.strip()[:160]})
    if volatile_refs:
        violations.append({"kind": "process_doc_volatile_head_ref", "severity": "medium",
                           "note": "GOALS process docs must point to CURRENT-STATE for moving WhatSoup heads",
                           "refs": volatile_refs})
    high = any(v.get("severity") == "high" for v in violations)
    return {"name": "lean_corpus", "severity": "high" if high else "medium",
            "status": "fail" if violations else "pass",
            "doc_count": doc_count, "ceiling": ceiling,
            "violations": violations, "notes": notes}


def non_library_probes(probe_dir: Path) -> list[Path]:
    return sorted(p for p in probe_dir.glob("*.py") if p.name not in LIBRARIES)


def uses_shared_redact(text: str) -> bool:
    for line in text.splitlines():
        if line.strip().startswith("from probelib import") and re.search(r"\bredact\b", line):
            return True
    return "probelib.redact" in text


def has_redaction_posture(text: str) -> bool:
    return uses_shared_redact(text) or re.search(r"['\"]redaction['\"]\s*:", text) is not None


def schema_version_values(text: str) -> list[str]:
    values = SCHEMA_CONST.findall(text)
    values.extend(SCHEMA_FIELD.findall(text))
    return values


def readme_script_rows(probe_dir: Path) -> set[str]:
    readme = probe_dir / "README.md"
    if not readme.exists():
        return set()
    in_scripts = False
    rows: set[str] = set()
    for line in readme.read_text(errors="replace").splitlines():
        stripped = line.strip()
        if stripped == "## Scripts":
            in_scripts = True
            continue
        if in_scripts and stripped.startswith("## "):
            break
        if not in_scripts:
            continue
        match = README_SCRIPT_ROW.match(stripped)
        if match:
            rows.add(match.group(1))
    return rows


def has_unhappy_assert_test(test_text: str) -> tuple[bool, str | None]:
    try:
        tree = ast.parse(test_text)
    except SyntaxError as exc:
        return False, f"SyntaxError:{exc.lineno}"
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef) or not node.name.startswith("test_"):
            continue
        func_text = ast.get_source_segment(test_text, node) or ""
        lowered = f"{node.name}\n{func_text}".lower()
        if not any(term in lowered for term in UNHAPPY_TEST_TERMS):
            continue
        if any(isinstance(child, ast.Assert) for child in ast.walk(node)):
            return True, None
    return False, None


# Directories that hold third-party / installed / cached code — NEVER estate source. The
# fail-open scan must skip them, else any out-of-band test-lane venv (e.g. .venv-test holding
# Hypothesis, vetted via tools/dependency_audit.py) floods the gate with foreign handlers.
_NON_ESTATE_DIRS = frozenset({
    "__pycache__", "tests", "vendor",
    ".venv", ".venv-test", "venv", "env", "site-packages", ".tox", ".eggs",
})


def source_files_for_fail_open_scan(probe_dir: Path) -> list[Path]:
    files: list[Path] = []
    for path in sorted(probe_dir.rglob("*.py")):
        parts = set(path.relative_to(probe_dir).parts)
        if parts & _NON_ESTATE_DIRS or any(p.endswith((".venv", "site-packages")) for p in parts):
            continue
        files.append(path)
    return files


def empty_return_kind(value: ast.AST | None) -> str | None:
    if value is None:
        return "bare_return"
    if isinstance(value, ast.Constant) and value.value is None:
        return "none"
    if isinstance(value, ast.List) and not value.elts:
        return "empty_list"
    if isinstance(value, ast.Dict) and not value.keys:
        return "empty_dict"
    if isinstance(value, ast.Tuple):
        item_kinds = [empty_return_kind(item) for item in value.elts]
        if item_kinds and all(kind in FAIL_OPEN_EMPTY_KINDS for kind in item_kinds):
            return "empty_tuple"
    return None


def handler_has_error_signal(handler: ast.ExceptHandler) -> bool:
    for stmt in ast.walk(ast.Module(body=handler.body, type_ignores=[])):
        if isinstance(stmt, ast.Raise):
            return True
        if isinstance(stmt, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            return True
        if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call):
            func = stmt.value.func
            if isinstance(func, ast.Attribute) and func.attr in {"append", "extend", "add", "update"}:
                target = ast.unparse(func.value).lower()
                if any(word in target for word in ("error", "invalid", "ignored", "violation", "failure", "degraded", "unreadable")):
                    return True
        if isinstance(stmt, ast.Return):
            value = stmt.value
            if isinstance(value, ast.Dict):
                keys = []
                for key in value.keys:
                    if isinstance(key, ast.Constant) and isinstance(key.value, str):
                        keys.append(key.value.lower())
                if any(k in {"_error", "error", "status", "parse_status", "error_type", "degraded"} for k in keys):
                    return True
            if isinstance(value, ast.Tuple):
                for item in value.elts:
                    if isinstance(item, ast.Dict):
                        keys = []
                        for key in item.keys:
                            if isinstance(key, ast.Constant) and isinstance(key.value, str):
                                keys.append(key.value.lower())
                        if any(k in {"_error", "error", "status", "parse_status", "error_type", "degraded"} for k in keys):
                            return True
                    if isinstance(item, ast.Constant) and isinstance(item.value, str):
                        lowered = item.value.lower()
                        if any(word in lowered for word in ("error", "invalid", "failed", "timeout", "not_found", "plain_text", "unsupported")):
                            return True
    return False


def fail_open_handler_violations(path: Path, tree: ast.AST) -> list[dict]:
    violations: list[dict] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.ExceptHandler):
            continue
        signal = handler_has_error_signal(node)
        handler_type = ast.unparse(node.type) if node.type else "bare"
        for stmt in node.body:
            kind = None
            if isinstance(stmt, ast.Pass):
                kind = "pass"
            elif isinstance(stmt, ast.Continue) and not signal:
                kind = "continue"
            elif isinstance(stmt, ast.Return):
                empty_kind = empty_return_kind(stmt.value)
                if empty_kind and not signal:
                    kind = f"return_{empty_kind}"
            if kind:
                violations.append({
                    "file": str(path.name if path.parent.name != "tools" else Path("tools") / path.name),
                    "line": stmt.lineno,
                    "handler": handler_type,
                    "kind": kind,
                })
    return violations


def check_fail_open_scan(probe_dir: Path) -> dict:
    violations: list[dict] = []
    parse_errors: list[dict] = []
    for path in source_files_for_fail_open_scan(probe_dir):
        try:
            tree = ast.parse(path.read_text(errors="replace"))
        except SyntaxError as exc:
            parse_errors.append({"file": str(path.relative_to(probe_dir)), "line": exc.lineno, "error": "SyntaxError"})
            continue
        except OSError as exc:
            parse_errors.append({"file": str(path.relative_to(probe_dir)), "error": type(exc).__name__})
            continue
        violations.extend(fail_open_handler_violations(path, tree))
    all_violations = []
    if parse_errors:
        all_violations.append({"kind": "fail_open_scan_parse_error", "severity": "high", "errors": parse_errors})
    if violations:
        all_violations.append({
            "kind": "silent_fail_open_exception_handler",
            "severity": "high",
            "note": "except handlers must raise or emit typed _error/degraded/status markers; clean-empty return/pass/continue is fail-open",
            "sites": violations,
        })
    return {
        "name": "fail_open_scan",
        "severity": "high",
        "status": "fail" if all_violations else "pass",
        "violations": all_violations,
    }


# --- two-plane separation (H5: planes never share verdict logic) ----------------
# Release gate proving the reducer gate (B3 paired_trial_harness) and the enricher gate
# (enricher_lift_gate) stay verdict-independent, and that only the sanctioned adoption_orchestrator
# bridges the two planes — and then ONLY via each gate's SCHEMA constant (the pure-projector contract).
# Becomes meaningful once adoption_orchestrator exists (plan bead 4.3 gate).
_PLANE_GATES = frozenset({"paired_trial_harness", "enricher_lift_gate"})
_PLANE_DISPATCHER = "adoption_orchestrator.py"
_DISPATCHER_ALLOWED_GATE_ATTRS = frozenset({"SCHEMA"})


def gate_import_aliases(tree: ast.AST) -> tuple[dict, set]:
    """`import <gate> [as alias]` -> {alias: gate}; `from <gate> import name` -> {(gate, name)}."""
    aliases: dict = {}
    from_symbols: set = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name in _PLANE_GATES:
                    aliases[a.asname or a.name] = a.name
        elif isinstance(node, ast.ImportFrom) and node.module in _PLANE_GATES:
            for a in node.names:
                from_symbols.add((node.module, a.name))
    return aliases, from_symbols


def gate_attr_accesses(tree: ast.AST, aliases: dict) -> list:
    """All `<alias>.<attr>` accesses where alias resolves to a plane gate module."""
    out: list = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            gate = aliases.get(node.value.id)
            if gate is not None:
                out.append((gate, node.attr))
    return out


def two_plane_violations_for(name: str, tree: ast.AST) -> list[dict]:
    """The per-file H5 violations: a gate importing the other gate; an unsanctioned module bridging
    both planes or importing a gate verdict symbol; the dispatcher touching gate logic beyond SCHEMA."""
    violations: list[dict] = []
    aliases, from_symbols = gate_import_aliases(tree)
    imported_gates = set(aliases.values()) | {g for g, _ in from_symbols}

    self_gate = name[:-3] if name.endswith(".py") and name[:-3] in _PLANE_GATES else None
    if self_gate is not None:
        for g in sorted(imported_gates - {self_gate}):
            violations.append({"kind": "gate_imports_other_gate", "severity": "high",
                               "file": name, "imports": g})

    if name != _PLANE_DISPATCHER:
        if len(imported_gates) >= 2:
            violations.append({"kind": "unsanctioned_plane_bridge", "severity": "high",
                               "file": name, "imports": sorted(imported_gates)})
        for gate, sym in sorted(from_symbols):
            if sym != "SCHEMA":
                violations.append({"kind": "gate_symbol_import", "severity": "high",
                                   "file": name, "symbol": f"{gate}.{sym}"})
    else:
        # the dispatcher is a PURE PROJECTOR: it may reference the gate modules only via .SCHEMA.
        for gate, attr in gate_attr_accesses(tree, aliases):
            if attr not in _DISPATCHER_ALLOWED_GATE_ATTRS:
                violations.append({"kind": "dispatcher_uses_gate_logic", "severity": "high",
                                   "file": name, "access": f"{gate}.{attr}"})
        for gate, sym in sorted(from_symbols):
            if sym not in _DISPATCHER_ALLOWED_GATE_ATTRS:
                violations.append({"kind": "dispatcher_imports_gate_symbol", "severity": "high",
                                   "file": name, "symbol": f"{gate}.{sym}"})
    return violations


def check_two_plane_separation(probe_dir: Path) -> dict:
    """Mechanical H5 release gate over the top-level probe sources (tests excluded — they may import
    gates freely). Fail-closed on parse error."""
    violations: list[dict] = []
    parse_errors: list[dict] = []
    for path in non_library_probes(probe_dir):
        try:
            tree = ast.parse(path.read_text(errors="replace"))
        except SyntaxError as exc:
            parse_errors.append({"file": path.name, "line": exc.lineno, "error": "SyntaxError"})
            continue
        except OSError as exc:
            parse_errors.append({"file": path.name, "error": type(exc).__name__})
            continue
        violations.extend(two_plane_violations_for(path.name, tree))

    all_violations: list[dict] = []
    if parse_errors:
        all_violations.append({"kind": "two_plane_separation_parse_error", "severity": "high",
                               "errors": parse_errors})
    if violations:
        all_violations.append({
            "kind": "plane_verdict_logic_shared", "severity": "high",
            "note": "H5: reducer/enricher gates must not share verdict logic; only adoption_orchestrator "
                    "may bridge planes, and only via gate.SCHEMA",
            "sites": violations,
        })
    return {
        "name": "two_plane_separation",
        "severity": "high",
        "status": "fail" if all_violations else "pass",
        "violations": all_violations,
    }


# Minimum number of probe *.py files (excluding corpus_guard.py) expected under
# <root>/agent-runtime-probes/. Actual count as of 2026-06-16 is 61; floor is
# conservative (40) to leave headroom for deliberate pruning without false alarms.
PROBE_COUNT_FLOOR = 40


def check_corpus_presence(root: Path) -> dict:
    """Fail-closed presence floor: asserts the corpus and probe directory exist and
    are populated. Returns HIGH severity FAIL on empty/mislocated input so a missing
    or mispointed --root can never silently greenlight the host-touch gate."""
    violations: list[dict] = []

    doc_paths = sorted(root.glob("AGENT-RUNTIME-*.md"))
    doc_count = len(doc_paths)
    if doc_count == 0:
        violations.append({
            "kind": "no_agent_runtime_docs",
            "severity": "high",
            "note": f"no AGENT-RUNTIME-*.md files found under {root}; mislocated or empty root",
        })

    probe_dir = root / "agent-runtime-probes"
    if not probe_dir.is_dir():
        violations.append({
            "kind": "probe_dir_missing",
            "severity": "high",
            "note": f"expected directory {probe_dir} does not exist",
        })
    else:
        probe_py = [p for p in probe_dir.glob("*.py") if p.name != "corpus_guard.py"]
        probe_count = len(probe_py)
        if probe_count < PROBE_COUNT_FLOOR:
            violations.append({
                "kind": "probe_count_below_floor",
                "severity": "high",
                "observed": probe_count,
                "floor": PROBE_COUNT_FLOOR,
                "note": f"found {probe_count} probe files; expected >= {PROBE_COUNT_FLOOR}",
            })

    return {
        "name": "corpus_presence",
        "severity": "high",
        "status": "fail" if violations else "pass",
        "doc_count": doc_count,
        "violations": violations,
    }


def check_probe_hygiene(probe_dir: Path) -> dict:
    violations = []
    # Libraries/guards emit no output envelope and are exempt from script-level checks
    # (but every *.py is still scanned for the single-redactor-home invariant).
    all_python = sorted(probe_dir.glob("*.py"))
    counted_probes = sorted(p for p in all_python if p.name != "corpus_guard.py")
    probes = non_library_probes(probe_dir)
    missing_schema, bad_schema_versions, missing_redaction, redact_homes, missing_test = [], [], [], [], []
    unreadable_sources: list[dict[str, str]] = []
    tests_dir = probe_dir / "tests"
    readme_rows = readme_script_rows(probe_dir)
    probe_names = {p.name for p in probes}
    missing_direct_test, missing_unhappy_signal = [], []
    for p in all_python:
        try:
            text = p.read_text(errors="replace")
        except OSError as exc:
            unreadable_sources.append({"probe": p.name, "error_type": type(exc).__name__})
            continue
        if re.search(r"^def redact\(", text, re.M):
            redact_homes.append(p.name)
    for p in probes:
        try:
            text = p.read_text(errors="replace")
        except OSError as exc:
            unreadable_sources.append({"probe": p.name, "error_type": type(exc).__name__})
            continue
        versions = schema_version_values(text)
        if not versions:
            missing_schema.append(p.name)
        malformed = [value for value in versions if not SCHEMA_VALUE_OK.match(value)]
        if malformed:
            bad_schema_versions.append({"probe": p.name, "values": malformed})
        if not has_redaction_posture(text):
            missing_redaction.append(p.name)
        # Value-emitting probes that use probelib.redact must carry a regression test
        # asserting no secret/payload leak — the redactor/tmup set the bar.
        if uses_shared_redact(text):
            if not (tests_dir / f"test_{p.stem}.py").exists():
                missing_test.append(p.name)
        direct_test = tests_dir / f"test_{p.stem}.py"
        if not direct_test.exists():
            missing_direct_test.append(p.name)
        else:
            try:
                test_text = direct_test.read_text(errors="replace")
            except OSError as exc:
                unreadable_sources.append({"probe": direct_test.name, "error_type": type(exc).__name__})
                continue
            has_signal_assert, parse_error = has_unhappy_assert_test(test_text)
            if parse_error is not None:
                unreadable_sources.append({"probe": direct_test.name, "error_type": parse_error})
                continue
            if not has_signal_assert:
                missing_unhappy_signal.append(direct_test.name)
    missing_readme_rows = sorted(probe_names - readme_rows)
    orphan_readme_rows = sorted(readme_rows - probe_names)
    if missing_redaction:
        violations.append({"kind": "redaction_discipline", "severity": "high",
                           "note": "non-library probes must import probelib.redact or emit a top-level redaction field",
                           "probes": missing_redaction})
    if missing_schema:
        violations.append({"kind": "missing_schema_envelope", "severity": "medium",
                           "probes": missing_schema})
    if bad_schema_versions:
        violations.append({"kind": "schema_version_consistency", "severity": "medium",
                           "note": "schema_version values must match ^\\d+\\.\\d+$",
                           "probes": bad_schema_versions})
    if missing_readme_rows or orphan_readme_rows:
        violations.append({"kind": "readme_drift", "severity": "medium",
                           "missing_rows": missing_readme_rows,
                           "orphan_rows": orphan_readme_rows})
    if len(redact_homes) > 1:
        violations.append({"kind": "duplicated_redactor", "severity": "medium",
                           "note": "redact() copy-pasted; needs single shared home (fail-open risk)",
                           "probes": redact_homes})
    if missing_test:
        violations.append({"kind": "missing_test", "severity": "medium",
                           "note": "value-emitting probes (use probelib.redact) need tests/test_<name>.py asserting no leak",
                           "probes": missing_test})
    if missing_direct_test:
        violations.append({"kind": "missing_direct_probe_test", "severity": "medium",
                           "note": "each non-library probe should have a direct tests/test_<probe>.py file",
                           "probes": missing_direct_test})
    if missing_unhappy_signal:
        violations.append({"kind": "missing_unhappy_path_test_signal", "severity": "medium",
                           "note": "each direct probe test should include a test_* function with an assert and explicit malformed/missing/error/degraded/absence signal",
                           "tests": missing_unhappy_signal})
    if unreadable_sources:
        violations.append({"kind": "source_read_error", "severity": "high",
                           "note": "probe hygiene cannot silently skip unreadable sources",
                           "sources": unreadable_sources})
    severity = "high" if any(v.get("severity") == "high" for v in violations) else "medium"
    return {"name": "probe_hygiene", "severity": severity,
            "status": "fail" if violations else "pass",
            "probe_count": len(counted_probes),
            "script_count": len(probes),
            "violations": violations}


def record_guard_run(report: dict, rc: int, duration_ms: int, output_text: str) -> None:
    try:
        tools_dir = Path(__file__).resolve().parent / "tools"
        sys.path.insert(0, str(tools_dir))
        import run_ledger
    except Exception as exc:
        marker = {"status": "degraded", "_error": f"run_ledger_import_failed:{type(exc).__name__}"}
        print(f"RUN_LEDGER_DEGRADED {json.dumps(marker, sort_keys=True)}", file=sys.stderr)
        return
    status = run_ledger.record({
        "kind": "guard",
        "name": "corpus_guard.py",
        "duration_ms": duration_ms,
        "exit": rc,
        "schema_version": report.get("schema_version"),
        "leak_hits": run_ledger.count_secret_hits(output_text),
        "_error": report.get("error"),
    })
    if status.get("status") not in {"ok", "disabled"}:
        marker = {"status": "degraded", "_error": status.get("_error") or status.get("error_type") or "ledger_write_failed"}
        print(f"RUN_LEDGER_DEGRADED {json.dumps(marker, sort_keys=True)}", file=sys.stderr)


def main() -> int:
    started = time.monotonic()
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(Path.home()))
    ap.add_argument("--ceiling", type=int, default=13)
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()
    root = Path(args.root)
    try:
        doc_paths = sorted(root.glob("AGENT-RUNTIME-*.md"))
        docs = {p.name: p.read_text(errors="replace").splitlines() for p in doc_paths}
        checks = [
            check_corpus_presence(root),
            check_mcp_consistency(docs),
            check_lean_corpus(root, docs, args.ceiling),
            check_probe_hygiene(root / "agent-runtime-probes"),
            check_fail_open_scan(root / "agent-runtime-probes"),
            check_two_plane_separation(root / "agent-runtime-probes"),
        ]
    except Exception as e:  # fail-closed: never silently pass
        report = {"schema": SCHEMA, "schema_version": SCHEMA_VERSION,
                  "error": f"{type(e).__name__}: {e}"}
        output = json.dumps(report)
        print(output)
        record_guard_run(report, 1, int((time.monotonic() - started) * 1000), output)
        return 1
    high_fail = any(c["status"] == "fail" and c["severity"] == "high" for c in checks)
    med_fail = any(c["status"] == "fail" and c["severity"] != "high" for c in checks)
    report = {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; emits doc names, line numbers, and matched-line snippets of research docs; no secret-file values",
        "summary": {"high_fail": high_fail, "med_fail": med_fail,
                    "verdict": "FAIL" if high_fail else ("WARN" if med_fail else "PASS")},
        "checks": checks,
    }
    rc = 2 if high_fail else 0
    output = json.dumps(report, indent=2 if args.pretty else None)
    print(output)
    record_guard_run(report, rc, int((time.monotonic() - started) * 1000), output)
    return rc


if __name__ == "__main__":
    sys.exit(main())
