#!/usr/bin/env python3
"""Metadata-only lint for ambiguous `Q` namespace references.

This probe scans local runtime/fleet research docs and selected WhatSoup
cross-over docs. It does not read secrets, call providers, SSH to hosts, or
inspect live services.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from probelib import git_head


HOME = Path.home()
DEFAULT_DOC_GLOBS = [
    "AGENT-RUNTIME-*.md",
]
DEFAULT_WHATSOUP_REFS = [
    "deploy/scripts/bot-errors-q-loop.py",
    "deploy/scripts/README-bot-errors.md",
    "deploy/health-profiles/runtime-host.json",
    "docs/runbooks/runtime-host-deadman.md",
    "docs/runbooks/examplefleet-deployment.md",
]

Q_PATTERN = re.compile(r"(?<![A-Za-z0-9_-])Q(?![A-Za-z0-9_&-])|Q-host|Q-loop|q-loop")
Q_HOST_HINT = re.compile(
    r"Q-host|Q host|Q's\b|Q's Mac|Q's laptop|Q's global|Q's local|Q local|Q Claude|"
    r"Current Q run|absent on Q|Not local on Q|Q-local|Q's harness|This Mac \(`Q`\)|this workstation|"
    r"/Users/testuser|local Mac|workstation|q's local agent runtime|Q/OpenCode/Codex",
    re.I,
)
NAMESPACE_META_HINT = re.compile(
    r"Q namespace|Q naming|Q/fleet|bare `Q`|bare Q|classif(?:y|ies) Q|Q mentions",
    re.I,
)
BOT_ERRORS_HINT = re.compile(
    r"BOT ERRORS|q-loop|Q-loop|heal|Codex\s*->\s*Q|Lucas/Q/Codex|Q supervisor|control-plane participant|dispatcher|collector",
    re.I,
)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(HOME))
    except ValueError:
        return str(path)


def doc_paths(include_whatsoup: bool) -> list[Path]:
    paths: set[Path] = set()
    for pattern in DEFAULT_DOC_GLOBS:
        paths.update(HOME.glob(pattern))
    if include_whatsoup:
        repo = HOME / "LAB/WhatSoup"
        for rel_path in DEFAULT_WHATSOUP_REFS:
            paths.add(repo / rel_path)
    return sorted(path for path in paths if path.exists() and path.is_file())


def classify(path: Path, line: str) -> str:
    path_text = rel(path)
    path_control_hint = "bot-errors-q-loop.py" in path_text or "runtime-host-deadman.md" in path_text
    has_meta = bool(NAMESPACE_META_HINT.search(line))
    has_host = bool(Q_HOST_HINT.search(line))
    has_control = path_control_hint or bool(BOT_ERRORS_HINT.search(line))
    if has_meta and not has_host and not has_control:
        return "namespace_meta_reference"
    if has_host and has_control:
        return "mixed_q_host_and_control_plane"
    if has_host:
        return "q_host_explicit"
    if has_control:
        return "bot_errors_control_plane_explicit"
    return "bare_q_candidate"


def short_snippet(line: str) -> str:
    return re.sub(r"\s+", " ", line.strip())[:220]


def scan_path(path: Path) -> list[dict[str, Any]]:
    mentions: list[dict[str, Any]] = []
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError as exc:
        return [
            {
                "path": rel(path),
                "line": None,
                "classification": "read_error",
                "snippet": "",
                "error_type": type(exc).__name__,
            }
        ]
    for line_no, line in enumerate(lines, 1):
        if not Q_PATTERN.search(line):
            continue
        mentions.append(
            {
                "path": rel(path),
                "line": line_no,
                "classification": classify(path, line),
                "snippet": short_snippet(line),
            }
        )
    return mentions


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--include-whatsoup", action="store_true", default=True, help="include selected WhatSoup crossover docs")
    parser.add_argument("--no-whatsoup", action="store_false", dest="include_whatsoup", help="scan only AGENT-RUNTIME docs")
    parser.add_argument("--pretty", action="store_true", help="pretty-print JSON")
    args = parser.parse_args()

    paths = doc_paths(args.include_whatsoup)
    mentions = [mention for path in paths for mention in scan_path(path)]
    class_counts = Counter(str(mention["classification"]) for mention in mentions)
    path_counts = Counter(str(mention["path"]) for mention in mentions)

    report = {
        "schema": "q-namespace-lint-report",
        "schema_version": "0.1",
        "redaction": "metadata-only; scans local docs/source refs, emits line snippets only, no secrets/auth/session/provider payloads",
        "what_soup_head": git_head(HOME / "LAB/WhatSoup"),
        "scanned_path_count": len(paths),
        "mention_count": len(mentions),
        "summary": {
            "by_classification": dict(sorted(class_counts.items())),
            "read_error_count": class_counts.get("read_error", 0),
            "top_paths": dict(path_counts.most_common(20)),
        },
        "mentions": mentions,
        "verdict": {
            "bare_q_candidate": "Needs human review or glossary rewrite before automation treats the line as either Q-host or BOT ERRORS Q.",
            "q_host_explicit": "Line has workstation-local namespace cues.",
            "bot_errors_control_plane_explicit": "Line has BOT ERRORS/q-loop/heal/control-plane cues.",
            "mixed_q_host_and_control_plane": "Line intentionally or accidentally bridges namespaces; review before extracting rules.",
            "namespace_meta_reference": "Line discusses the Q namespace audit rather than using Q as an operational actor.",
            "read_error": "Probe could not read the path; treat as degraded rather than as no Q mentions.",
        },
    }
    json.dump(report, sys.stdout, indent=2 if args.pretty else None, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
