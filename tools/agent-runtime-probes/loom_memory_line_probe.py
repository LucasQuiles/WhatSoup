#!/usr/bin/env python3
"""Metadata-only N6 bridge over the local Loom memory implementation.

This probe answers whether the memory-line work named in the agent-runtime
goals exists as local code/tests/docs, without reading private memory bodies or
calling providers. It intentionally treats Loom as an external implementation
surface and reports relative refs, counts, line hashes, and gate metadata only.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from collections import Counter
from pathlib import Path
from typing import Any

from probelib import sha256_16

HOME = Path.home()
DEFAULT_LOOM_ROOT = HOME / "LAB/Loom"
SCHEMA = "agent-runtime-loom-memory-line"
SCHEMA_VERSION = "0.1"


CAPABILITY_FILES = {
    "contracts": [
        "loom/contracts/memory_note.py",
        "loom/contracts/handoff.py",
        "loom/contracts/read_impact.py",
        "loom/contracts/frontmatter.py",
    ],
    "vault_admission": [
        "loom/vault/admission.py",
        "loom/vault/store.py",
        "tests/vault/test_admission.py",
        "tests/vault/test_properties.py",
        "tests/vault/test_wave2_hardening.py",
    ],
    "governance_lint": [
        "loom/governance/lint.py",
        "tests/governance/test_lint.py",
    ],
    "memory_conflict_detector": [
        "loom/governance/conflict.py",
        "tests/governance/test_conflict.py",
    ],
    "source_ref_resolver": [
        "loom/governance/source_refs.py",
        "tests/governance/test_source_refs.py",
    ],
    "pipeline_admission": [
        "loom/pipeline.py",
        "tests/pipeline/test_pipeline.py",
    ],
    "handoff_envelope": [
        "loom/handoff/envelope.py",
        "loom/handoff/tmup_client.py",
        "tests/handoff/test_envelope.py",
        "tests/handoff/test_handoff_contract.py",
        "tests/handoff/test_tmup_client.py",
    ],
    "read_path_budgeter": [
        "loom/readpath/budgeter.py",
        "loom/readpath/federation.py",
        "loom/readpath/dm_mcp.py",
        "loom/readpath/pinecone_mcp.py",
        "tests/readpath/test_budgeter.py",
        "tests/readpath/test_federation.py",
    ],
    "mcp_read_only_surface": [
        "loom/mcp/server.py",
        "tests/mcp/test_server_dispatch.py",
        "tests/mcp/test_memory_search.py",
        "tests/mcp/test_memory_get.py",
    ],
}

LINE_REF_SPECS = {
    "contract_validate_memory_note": ("loom/contracts/memory_note.py", r"def validate_memory_note"),
    "contract_injection_ceiling": ("loom/contracts/memory_note.py", r"injection_too_broad"),
    "vault_admit": ("loom/vault/admission.py", r"def admit"),
    "vault_secret_registry": ("loom/vault/admission.py", r"secret-patterns\.json"),
    "governance_lint_note": ("loom/governance/lint.py", r"def lint_note"),
    "governance_source_refs": ("loom/governance/lint.py", r"source_refs"),
    "conflict_detector": ("loom/governance/conflict.py", r"def detect_conflicts"),
    "source_ref_resolver": ("loom/governance/source_refs.py", r"def resolve_source_ref"),
    "source_refs_verified_predicate": ("loom/governance/source_refs.py", r"def all_source_refs_verified"),
    "pipeline_admit_note": ("loom/pipeline.py", r"def admit_note"),
    "mcp_memory_search": ("loom/mcp/server.py", r"memory_search"),
    "mcp_memory_get": ("loom/mcp/server.py", r"memory_get"),
    "readme_stale_not_started": ("README.md", r"code not yet started"),
}

SAFE_TEST_OUTPUT = re.compile(r"(?P<passed>\d+)\s+passed(?:,\s+(?P<skipped>\d+)\s+skipped)?\s+in\s+(?P<seconds>[0-9.]+)s")


def rel(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return f"sha256:{sha256_16(str(path))}"


def path_row(root: Path, relative: str) -> dict[str, Any]:
    path = root / relative
    return {
        "ref": relative,
        "exists": path.exists(),
        "kind": "file" if path.is_file() else ("directory" if path.is_dir() else "missing"),
        "size_bytes": path.stat().st_size if path.is_file() else 0,
        "path_sha256_16": sha256_16(str(path)),
    }


def count_files(root: Path, relative: str) -> int:
    base = root / relative
    if not base.exists():
        return 0
    return sum(
        1
        for path in base.rglob("*.py")
        if "__pycache__" not in path.parts and ".venv" not in path.parts
    )


def count_test_functions(root: Path) -> int:
    tests = root / "tests"
    if not tests.exists():
        return 0
    total = 0
    for path in tests.rglob("test_*.py"):
        if "__pycache__" in path.parts:
            continue
        total += len(re.findall(r"^def test_", path.read_text(encoding="utf-8", errors="replace"), flags=re.MULTILINE))
    return total


def git_metadata(root: Path) -> dict[str, Any]:
    if not (root / ".git").exists():
        return {"is_git_repo": False, "root_sha256_16": sha256_16(str(root))}
    branch = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "--abbrev-ref", "HEAD"],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )
    head = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "--short=12", "HEAD"],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )
    status = subprocess.run(
        ["git", "-C", str(root), "status", "--short", "--untracked-files=all"],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )
    lines = [line for line in status.stdout.splitlines() if line.strip()] if status.returncode == 0 else []
    status_codes = Counter(line[:2].strip() or "unknown" for line in lines)
    return {
        "is_git_repo": True,
        "root_sha256_16": sha256_16(str(root)),
        "branch": branch.stdout.strip() if branch.returncode == 0 else None,
        "head_short": head.stdout.strip() if head.returncode == 0 else None,
        "dirty_entry_count": len(lines),
        "status_code_counts": dict(sorted(status_codes.items())),
    }


def line_ref(root: Path, label: str, relative: str, pattern: str) -> dict[str, Any]:
    path = root / relative
    row = {
        "label": label,
        "ref": relative,
        "path_sha256_16": sha256_16(str(path)),
        "found": False,
        "line": None,
        "line_sha256_16": None,
    }
    if not path.exists():
        return row
    regex = re.compile(pattern)
    for index, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        if regex.search(line):
            row.update({"found": True, "line": index, "line_sha256_16": sha256_16(line.strip())})
            return row
    return row


def capability_status(root: Path, name: str, relatives: list[str]) -> dict[str, Any]:
    rows = [path_row(root, item) for item in relatives]
    present = sum(1 for row in rows if row["exists"])
    required_source = [row for row in rows if row["ref"].startswith("loom/")]
    required_tests = [row for row in rows if row["ref"].startswith("tests/")]
    source_present = all(row["exists"] for row in required_source)
    tests_present = all(row["exists"] for row in required_tests)
    return {
        "name": name,
        "status": "present_with_tests" if source_present and tests_present else ("partial" if present else "absent"),
        "file_count": len(rows),
        "present_count": present,
        "source_present": source_present,
        "tests_present": tests_present,
        "missing_refs": [row["ref"] for row in rows if not row["exists"]],
        "refs": rows,
    }


def parse_metrics(root: Path) -> dict[str, Any]:
    path = root / ".loom-poller/metrics.jsonl"
    row = {
        "path_sha256_16": sha256_16(str(path)),
        "exists": path.exists(),
        "record_count": 0,
        "latest": None,
        "latest_with_mutation": None,
        "invalid_json_lines": 0,
    }
    if not path.exists():
        return row
    records = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            row["invalid_json_lines"] += 1
            continue
        if isinstance(parsed, dict):
            records.append(parsed)
    row["record_count"] = len(records)
    if records:
        row["latest"] = public_metric_record(records[-1])
    with_mutation = [record for record in records if isinstance(record.get("mutation"), dict)]
    if with_mutation:
        row["latest_with_mutation"] = public_metric_record(with_mutation[-1])
    return row


def public_metric_record(record: dict[str, Any]) -> dict[str, Any]:
    gates = record.get("gates") if isinstance(record.get("gates"), dict) else {}
    mutation = record.get("mutation") if isinstance(record.get("mutation"), dict) else None
    failed_gate_names = sorted(str(name) for name, ok in gates.items() if ok is not True)
    return {
        "passed": bool(record.get("passed")),
        "coverage_pct": record.get("coverage_pct"),
        "cov_min": record.get("cov_min"),
        "gate_count": len(gates),
        "passed_gate_count": sum(1 for ok in gates.values() if ok is True),
        "gate_names": sorted(str(name) for name in gates),
        "failed_gate_names": failed_gate_names,
        "has_mutation": mutation is not None,
        "mutation": {
            "killed": mutation.get("killed"),
            "total": mutation.get("total"),
        } if mutation else None,
        "sidecar_sha256_16": sha256_16(str(record.get("sidecar") or "")),
        "stamp_present": bool(record.get("stamp")),
    }


def parse_pytest_summary(text: str) -> dict[str, Any]:
    match = SAFE_TEST_OUTPUT.search(text)
    if not match:
        return {"status": "not_parsed", "stdout_bytes": len(text.encode("utf-8", errors="replace"))}
    return {
        "status": "parsed",
        "passed": int(match.group("passed")),
        "skipped": int(match.group("skipped") or 0),
        "seconds": float(match.group("seconds")),
        "stdout_bytes": len(text.encode("utf-8", errors="replace")),
    }


def run_pytest(root: Path) -> dict[str, Any]:
    python = root / ".venv/bin/python"
    if not python.exists():
        python = Path("python3")
    proc = subprocess.run(
        [str(python), "-m", "pytest", "tests", "-q", "-p", "no:cov"],
        cwd=root,
        text=True,
        capture_output=True,
        check=False,
        timeout=120,
    )
    parsed = parse_pytest_summary(proc.stdout + proc.stderr)
    parsed.update({"rc": proc.returncode, "status": "passed" if proc.returncode == 0 else "failed"})
    return parsed


def source_ref_resolver_status(root: Path) -> dict[str, Any]:
    resolver_candidates = [
        "loom/source_refs/resolver.py",
        "loom/governance/source_refs.py",
        "loom/contracts/source_ref.py",
    ]
    rows = [path_row(root, item) for item in resolver_candidates]
    found = [row for row in rows if row["exists"]]
    resolver_status_hits = []
    for relative in ("loom/vault/admission.py", "loom/governance/lint.py", "tests/vault/test_admission.py", "tests/governance/test_lint.py"):
        path = root / relative
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        resolver_status_hits.append({
            "ref": relative,
            "path_sha256_16": sha256_16(str(path)),
            "hit_count": len(re.findall(r"resolver_status", text)),
        })
    status = "dedicated_resolver_present" if found else (
        "contract_and_admission_gate_only" if any(row["hit_count"] for row in resolver_status_hits) else "absent"
    )
    return {
        "status": status,
        "dedicated_resolver_candidates": rows,
        "resolver_status_hit_count": sum(row["hit_count"] for row in resolver_status_hits),
        "resolver_status_refs": resolver_status_hits,
    }


def build_findings(report: dict[str, Any]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    summary = report["summary"]
    if summary["module_py_count"] > 0 and report["line_refs"]["readme_stale_not_started"]["found"]:
        findings.append({
            "code": "loom_readme_status_stale",
            "severity": "medium",
            "evidence": {
                "module_py_count": summary["module_py_count"],
                "readme_line": report["line_refs"]["readme_stale_not_started"]["line"],
                "readme_line_sha256_16": report["line_refs"]["readme_stale_not_started"]["line_sha256_16"],
            },
        })
    if report["source_ref_resolver"]["status"] != "dedicated_resolver_present":
        findings.append({
            "code": "source_ref_resolver_not_dedicated",
            "severity": "medium",
            "evidence": {
                "status": report["source_ref_resolver"]["status"],
                "resolver_status_hit_count": report["source_ref_resolver"]["resolver_status_hit_count"],
            },
        })
    latest = (report["loom_metrics"].get("latest") or {})
    if latest and latest.get("passed") is False:
        findings.append({
            "code": "latest_battery_record_failed",
            "severity": "high",
            "evidence": {
                "latest_gate_count": latest.get("gate_count"),
                "latest_passed_gate_count": latest.get("passed_gate_count"),
                "latest_failed_gate_names": latest.get("failed_gate_names"),
                "latest_coverage_pct": latest.get("coverage_pct"),
            },
        })
    if latest and not latest.get("has_mutation"):
        findings.append({
            "code": "latest_battery_record_without_mutation",
            "severity": "low",
            "evidence": {
                "latest_gate_count": latest.get("gate_count"),
                "latest_passed": latest.get("passed"),
                "latest_with_mutation_available": report["loom_metrics"].get("latest_with_mutation") is not None,
            },
        })
    if report.get("pytest", {}).get("status") == "failed":
        findings.append({
            "code": "loom_pytest_failed",
            "severity": "high",
            "evidence": {
                "rc": report["pytest"].get("rc"),
                "stdout_bytes": report["pytest"].get("stdout_bytes"),
            },
        })
    return findings


def build_report(root: Path = DEFAULT_LOOM_ROOT, *, run_tests: bool = False) -> dict[str, Any]:
    root = root.expanduser()
    capabilities = [capability_status(root, name, refs) for name, refs in sorted(CAPABILITY_FILES.items())]
    line_refs = {
        label: line_ref(root, label, relative, pattern)
        for label, (relative, pattern) in LINE_REF_SPECS.items()
    }
    source_ref_status = source_ref_resolver_status(root)
    module_count = count_files(root, "loom")
    test_file_count = count_files(root, "tests")
    metrics = parse_metrics(root)
    report: dict[str, Any] = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "proof_class": "local_source_test_metrics_metadata",
        "redaction": (
            "metadata-only Loom memory-line probe; emits relative refs, line numbers, line hashes, "
            "module/test counts, gate summaries, capability status, git counts, and findings; does not emit "
            "raw memory notes, test stdout bodies, source line text, absolute paths, credentials, provider payloads, "
            "MCP outputs, transcript bodies, or secret-shaped values"
        ),
        "loom_root": {
            "exists": root.exists(),
            "root_sha256_16": sha256_16(str(root)),
            "basename": root.name,
        },
        "summary": {
            "module_py_count": module_count,
            "test_py_count": test_file_count,
            "test_function_count": count_test_functions(root),
            "capability_count": len(capabilities),
            "capability_status_counts": dict(sorted(Counter(row["status"] for row in capabilities).items())),
            "line_ref_found_count": sum(1 for row in line_refs.values() if row["found"]),
            "source_ref_resolver_status": source_ref_status["status"],
            "latest_metrics_passed": (metrics.get("latest") or {}).get("passed"),
            "latest_metrics_has_mutation": (metrics.get("latest") or {}).get("has_mutation"),
            "latest_mutation_killed": ((metrics.get("latest_with_mutation") or {}).get("mutation") or {}).get("killed"),
            "latest_mutation_total": ((metrics.get("latest_with_mutation") or {}).get("mutation") or {}).get("total"),
            "pytest_status": "not_run",
        },
        "git": git_metadata(root),
        "capabilities": capabilities,
        "line_refs": line_refs,
        "source_ref_resolver": source_ref_status,
        "loom_metrics": metrics,
        "pytest": {"status": "not_run"},
        "limitations": [
            "Source/test/metrics metadata only; this does not prove Loom MCP is registered in Claude, Codex, OpenCode, or WhatSoup.",
            "No provider calls, MCP calls, DreamMachine/Pinecone live calls, tmup task creation, or memory-store mutation are performed by default.",
            "Relative line refs prove local code presence, not semantic correctness beyond the cited tests and metrics.",
            "Loom README/status prose can drift from implementation state; findings call this out instead of trusting the README alone.",
        ],
    }
    if run_tests:
        pytest = run_pytest(root)
        report["pytest"] = pytest
        report["summary"]["pytest_status"] = pytest["status"]
        report["summary"]["pytest_passed"] = pytest.get("passed")
        report["summary"]["pytest_skipped"] = pytest.get("skipped")
    report["findings"] = build_findings(report)
    report["summary"]["finding_count"] = len(report["findings"])
    report["summary"]["severity_counts"] = dict(sorted(Counter(item["severity"] for item in report["findings"]).items()))
    report["summary"]["issue_code_counts"] = dict(sorted(Counter(item["code"] for item in report["findings"]).items()))
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Emit metadata-only Loom memory-line implementation proof.")
    parser.add_argument("--root", type=Path, default=DEFAULT_LOOM_ROOT)
    parser.add_argument("--run-tests", action="store_true", help="Run local Loom pytest without coverage or providers.")
    parser.add_argument("--pretty", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(args.root, run_tests=args.run_tests)
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))
    high_fail = any(item["severity"] == "high" for item in report["findings"])
    return 2 if high_fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
