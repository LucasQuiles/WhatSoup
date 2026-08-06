#!/usr/bin/env python3
"""Sync open-issue-registry.json pinned_revision from per-issue review files.

Each issue in the top-level registry carries a pinned_revision that should
match the per-issue review file under docs/triage/reviews/. This script
authoritatively syncs the field per the refresh protocol.
"""

import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
REGISTRY_PATH = REPO_ROOT / "docs/triage/open-issue-registry.json"
REVIEWS_DIR = REPO_ROOT / "docs/triage/reviews/open-issue-refresh-20260728-current"


def load_per_issue_pins() -> dict[int, str]:
    """Load per-issue revision pins from the review directory."""
    pins: dict[int, str] = {}
    if not REVIEWS_DIR.is_dir():
        print(f"warning: reviews dir not found: {REVIEWS_DIR}", file=sys.stderr)
        return pins
    for f in sorted(REVIEWS_DIR.iterdir()):
        if not f.name.endswith(".json"):
            continue
        try:
            issue_num = int(f.stem)
        except ValueError:
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            pin = data.get("pinned_revision")
            if pin and isinstance(pin, str):
                pins[issue_num] = pin
        except (json.JSONDecodeError, OSError):
            continue
    return pins


def sync(registry_path: str | Path, dry_run: bool = False) -> int:
    """Sync pinned_revision from per-issue files. Returns distinct-pin count."""
    registry = json.loads(Path(registry_path).read_text(encoding="utf-8"))
    per_issue_pins = load_per_issue_pins()
    issues = registry["issues"]

    updated = 0
    for issue in issues:
        num = issue.get("issue_number")
        if num is None or num not in per_issue_pins:
            continue
        new_pin = per_issue_pins[num]
        old_pin = issue.get("pinned_revision")
        if new_pin != old_pin:
            issue["pinned_revision"] = new_pin
            updated += 1

    if updated > 0 and not dry_run:
        # Update top-level pinned_main_revision to the most common pin
        pin_counts: dict[str, int] = {}
        for issue in issues:
            p = issue.get("pinned_revision", "")
            pin_counts[p] = pin_counts.get(p, 0) + 1
        most_common = max(pin_counts, key=pin_counts.get)
        registry["pinned_main_revision"] = most_common

        Path(registry_path).write_text(
            json.dumps(registry, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    distinct = len(set(i.get("pinned_revision", "") for i in issues))
    print(f"synced: {updated}/{len(issues)} entries updated, {distinct} distinct pins")
    return distinct


if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    distinct = sync(REGISTRY_PATH, dry_run=dry)
    print(f"distinct_pins={distinct}")
