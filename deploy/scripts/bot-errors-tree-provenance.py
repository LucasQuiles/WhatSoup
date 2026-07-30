#!/usr/bin/env python3
"""BOT ERRORS tree-provenance guard.

Answers, per bot host: "is this tree's running code traceable to a pushed
commit, or is it silently diverging?"  This is the regression guard for the
hub-32 anti-pattern -- 32 commits accumulated directly on production ``main``
on the nucles hub, never pushed, invisible to everyone, lost if the host died --
and for dirty/ahead-of-origin bot trees with no detection (mini1).

The five checks (see ``CHECK_*`` constants):

  1. DIRTY            -- ``git status --porcelain`` count above a threshold:
                         uncommitted runtime changes are a latent landmine and
                         lost provenance.  severity: info/warn.
  2. AHEAD-OF-UPSTREAM -- ``git rev-list @{u}..HEAD`` count > 0: unpushed local
                         commits, the hub-32 anti-pattern.  severity: warn.
  3. DIRECT-TO-PROTECTED -- on ``main``/``master`` AND ahead of origin: commits
                         landed directly on a protected branch on a production
                         host, bypassing PR review -- exactly how the hub
                         diverged.  severity: critical.
  4. DIVERGED         -- detached/unknown HEAD, or HEAD is neither an ancestor
                         nor descendant of ``origin/<branch>`` (rewritten or
                         forked history).  severity: critical.
  5. PHANTOM-SRC      -- (advisory) untracked ``.ts`` under ``src/`` that could
                         be phantom-import targets or abandoned WIP.  info.

Design constraints:
  * FAST -- git plumbing only.  No network unless ``--fetch`` is passed (default
    OFFLINE; compares against the last-known ``origin/<branch>`` ref already on
    disk).
  * Runs standalone (``--once`` emits an outbox event; ``--print`` is dry) AND
    is invoked from the daily health-check via :func:`tree_provenance_inventory`,
    which returns daily-health-style FAIL/WARN lines that the health-check's
    existing failure classifier + per-instance salient emitter pick up for free.
    ``--reporter`` selects a third, scheduler-oriented mode (combinable with
    ``--once``/``--print``, rejects ``--fetch``): exit 0 for any successfully
    observed finding state (clean/warning/critical), 2 for an inspection
    failure, 1 for an event-write failure -- so a systemd/launchd oneshot never
    reads a successfully-detected drift finding as a process failure. Without
    ``--reporter`` the interactive exit contract is unchanged:
    ``{"info": 0, "warning": 1, "critical": 2}``, GitError -> 1.
  * Every OFFLINE git invocation (everything routed through ``_git``) runs
    with ``--no-optional-locks``, so offline inspection never takes the
    ``.git/index`` lock and can't race a concurrent commit/checkout on the
    same bot tree.  The opt-in ``--fetch`` network call (``fetch_upstream``)
    is exempt: it does not go through ``_git`` and does not pass the flag.
  * Thresholds are configurable via environment (see the ``BOT_ERRORS_TREE_*``
    constants below).
  * All emitted text is redacted: branch names and paths are basename/fingerprint
    only -- no full filesystem paths, no leaked refs.

Emission format matches ``bot-errors-health-check.py``'s ``outbox_event()`` so
records flow through the existing bot-errors dispatcher pipeline unchanged.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from lib.bot_errors_envelope import new_event_fields


# ---------------------------------------------------------------------------
# Configurable thresholds (env-overridable).
# ---------------------------------------------------------------------------
def _env_int(key: str, default: int) -> int:
    raw = os.environ.get(key, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


# How many porcelain entries before DIRTY is reported.  0 means "any dirty
# entry is a finding".  Default 0: a production bot tree should be clean.
DIRTY_THRESHOLD = _env_int("BOT_ERRORS_TREE_DIRTY_THRESHOLD", 0)
# Severity floor for DIRTY: "info" (advisory) or "warning".  A dirty tree on a
# production host is at least advisory; default warning because uncommitted
# runtime edits are the mini1 restart-landmine precursor.
DIRTY_SEVERITY = os.environ.get("BOT_ERRORS_TREE_DIRTY_SEVERITY", "warning").strip() or "warning"
# Branches considered protected (direct commits there = critical).
PROTECTED_BRANCHES = tuple(
    b.strip()
    for b in os.environ.get("BOT_ERRORS_TREE_PROTECTED_BRANCHES", "main,master").split(",")
    if b.strip()
)
# Default upstream remote when no tracking ref is configured.
DEFAULT_REMOTE = os.environ.get("BOT_ERRORS_TREE_REMOTE", "origin").strip() or "origin"
# Cap on phantom .ts paths reported (advisory; avoid unbounded evidence).
PHANTOM_SRC_CAP = _env_int("BOT_ERRORS_TREE_PHANTOM_CAP", 10)
# git invocation timeout (seconds).  Plumbing is fast; this is a safety net.
GIT_TIMEOUT_S = _env_int("BOT_ERRORS_TREE_GIT_TIMEOUT", 15)

# Repo whose tree we inspect.  Default: the repo this script lives in.
REPO_ROOT = Path(os.environ.get("BOT_ERRORS_TREE_REPO_ROOT", "")).expanduser() if os.environ.get(
    "BOT_ERRORS_TREE_REPO_ROOT"
) else Path(__file__).resolve().parents[2]

HOST_PLATFORM = os.environ.get("BOT_ERRORS_DRY_PLATFORM", sys.platform)

CHECK_DIRTY = "dirty"
CHECK_AHEAD = "ahead_of_upstream"
CHECK_DIRECT_TO_PROTECTED = "direct_to_protected_branch"
CHECK_DIVERGED = "diverged"
CHECK_PHANTOM_SRC = "phantom_src"

SEVERITY_RANK = {"info": 0, "warning": 1, "critical": 2}


# ---------------------------------------------------------------------------
# Redaction (self-contained; mirrors health-check conventions so this module
# stays runnable standalone without importing the 200 KB health-check).
# ---------------------------------------------------------------------------
_PHONE_RUN_RE = re.compile(r"\d{8,}")


def _fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def redact_ref(value: str) -> str:
    """Redact a branch/ref name: keep a recognisable short label, fingerprint
    anything that could embed a path or a long digit run (e.g. a leaked phone
    number or a feature branch named after a number)."""
    value = value.strip()
    if not value:
        return "unknown"
    # Long digit runs (>=8) are scrubbed wholesale -- never leak them.
    value = _PHONE_RUN_RE.sub("[REDACTED_DIGITS]", value)
    if "/" in value or os.sep in value:
        # Path-shaped ref: keep only the final component + a fingerprint.
        tail = value.replace(os.sep, "/").rsplit("/", 1)[-1] or "unknown"
        return f"{tail}@{_fingerprint(value)}"
    return value


def redact_path_segment(value: str) -> str:
    """Redact a filesystem path to basename + fingerprint -- no leaked dirs."""
    raw = str(value)
    name = Path(raw).name or "unknown"
    name = _PHONE_RUN_RE.sub("[REDACTED_DIGITS]", name)
    return f"{name}@{_fingerprint(raw)}"


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ---------------------------------------------------------------------------
# git plumbing (offline by default).
# ---------------------------------------------------------------------------
class GitError(RuntimeError):
    """A git invocation failed in a way that blocks provenance inspection."""


def _git(repo: Path, *args: str) -> str:
    """Run a git plumbing command in ``repo`` and return stripped stdout.

    Never touches the network. Raises :class:`GitError` on every failed probe;
    callers use commands that represent expected absence with empty stdout.
    """
    try:
        proc = subprocess.run(
            ["git", "--no-optional-locks", "-C", str(repo), *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=GIT_TIMEOUT_S,
            check=False,
        )
    except FileNotFoundError as exc:
        raise GitError("git executable not found") from exc
    except subprocess.TimeoutExpired as exc:
        raise GitError(f"git {args[0] if args else ''} timed out") from exc
    if proc.returncode != 0:
        raise GitError(f"git {args[0] if args else ''} failed rc={proc.returncode}")
    return proc.stdout.strip()


def _git_lines(repo: Path, *args: str) -> list[str]:
    out = _git(repo, *args)
    return [line for line in out.splitlines() if line.strip()]


def fetch_upstream(repo: Path, remote: str) -> str | None:
    """Optionally refresh the remote ref (network).  Returns an error string on
    failure (so the caller can record it), or None on success."""
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo), "fetch", "--quiet", remote],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=GIT_TIMEOUT_S,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return f"fetch_failed:{type(exc).__name__}"
    if proc.returncode != 0:
        return f"fetch_failed:rc={proc.returncode}"
    return None


# ---------------------------------------------------------------------------
# Core inspection.
# ---------------------------------------------------------------------------
def _current_branch(repo: Path) -> str | None:
    """Return the current branch name, or None if HEAD is detached."""
    name = _git(repo, "branch", "--show-current")
    return name or None


def _upstream_ref(repo: Path, branch: str) -> str | None:
    """Return the configured upstream tracking ref (e.g. origin/main), or None."""
    ref = _git(
        repo,
        "for-each-ref",
        "--format=%(upstream:short)",
        f"refs/heads/{branch}",
    )
    return ref or None


def gather_tree_provenance(repo: Path, *, do_fetch: bool = False) -> dict[str, Any]:
    """Inspect ``repo`` and return a structured provenance snapshot.

    Pure git plumbing.  Offline unless ``do_fetch`` is True.  Never raises for
    expected states (detached HEAD, no upstream); records them in the snapshot.
    Raises :class:`GitError` only when the path is not a usable git repo.
    """
    repo = repo.resolve()
    try:
        is_repo = _git(repo, "rev-parse", "--is-inside-work-tree") == "true"
    except GitError as exc:
        raise GitError(f"not a usable git work tree: {redact_path_segment(str(repo))}") from exc
    if not is_repo:
        raise GitError(f"not a git work tree: {redact_path_segment(str(repo))}")

    head = _git(repo, "rev-parse", "HEAD")
    branch = _current_branch(repo)
    detached = branch is None
    upstream = _upstream_ref(repo, branch) if branch else None

    fetch_error: str | None = None
    if do_fetch:
        remote = DEFAULT_REMOTE
        if upstream and "/" in upstream:
            remote = upstream.split("/", 1)[0]
        fetch_error = fetch_upstream(repo, remote)

    # -uall so a wholly-untracked new dir (e.g. a fresh src/) is reported as its
    # individual files, not a single "?? src/" entry -- required to catch
    # phantom .ts under src/.
    porcelain = _git_lines(repo, "status", "--porcelain", "--untracked-files=all")
    dirty_count = len(porcelain)
    # Untracked .ts under src/ (advisory phantom-import targets).
    phantom_src: list[str] = []
    for entry in porcelain:
        # porcelain "?? path" marks untracked.
        if entry.startswith("?? "):
            path = entry[3:].strip().strip('"')
            if path.startswith("src/") and path.endswith(".ts"):
                phantom_src.append(path)

    ahead = 0
    behind = 0
    upstream_resolved = False
    ancestry = "unknown"  # one of: same | ahead | behind | diverged | unknown
    if upstream:
        counts = _git(repo, "rev-list", "--left-right", "--count", f"{upstream}...HEAD")
        # output: "<behind>\t<ahead>"
        parts = counts.split()
        if len(parts) == 2 and all(p.isdigit() for p in parts):
            behind, ahead = int(parts[0]), int(parts[1])
            upstream_resolved = True
            if ahead == 0 and behind == 0:
                ancestry = "same"
            elif ahead > 0 and behind == 0:
                ancestry = "ahead"
            elif ahead == 0 and behind > 0:
                ancestry = "behind"
            else:
                ancestry = "diverged"

    protected = (branch in PROTECTED_BRANCHES) if branch else False

    return {
        "repo_fingerprint": _fingerprint(str(repo)),
        "head": head,
        "branch": branch,
        "branch_redacted": redact_ref(branch) if branch else None,
        "detached": detached,
        "upstream": upstream,
        "upstream_redacted": redact_ref(upstream) if upstream else None,
        "upstream_resolved": upstream_resolved,
        "dirty_count": dirty_count,
        "ahead": ahead,
        "behind": behind,
        "ancestry": ancestry,
        "protected_branch": protected,
        "phantom_src": phantom_src,
        "fetch_attempted": do_fetch,
        "fetch_error": fetch_error,
    }


# ---------------------------------------------------------------------------
# Findings: snapshot -> list of (check, severity, evidence-line).
# ---------------------------------------------------------------------------
def provenance_findings(snap: dict[str, Any]) -> list[dict[str, str]]:
    """Map a provenance snapshot to structured findings.

    Severity policy (per the gap-matrix class-2 design):
      * dirty                   -> DIRTY_SEVERITY (default warning)
      * ahead-of-upstream       -> warning  (the hub-32 anti-pattern)
      * direct-to-protected+ahead -> critical (PR-bypass on production main)
      * diverged / detached     -> critical (rewritten/forked history)
      * phantom src .ts         -> info (advisory)
    """
    findings: list[dict[str, str]] = []
    branch = snap.get("branch_redacted") or "DETACHED"

    # 4. DIVERGED / DETACHED / unknown HEAD (critical).
    if snap["detached"]:
        findings.append({
            "check": CHECK_DIVERGED,
            "severity": "critical",
            "evidence": f"head_detached=true head={snap['head'][:12]} "
                        "no_branch=true diverged_or_unknown_head",
        })
    elif not snap["upstream"]:
        # No tracking ref: we cannot prove the tree traces to a pushed commit.
        findings.append({
            "check": CHECK_DIVERGED,
            "severity": "warning",
            "evidence": f"branch={branch} no_upstream_tracking_ref "
                        "cannot_verify_provenance",
        })
    elif not snap["upstream_resolved"]:
        # Upstream configured but the ref is missing locally (e.g. never
        # fetched) -- provenance unprovable offline.
        findings.append({
            "check": CHECK_DIVERGED,
            "severity": "warning",
            "evidence": f"branch={branch} upstream={snap['upstream_redacted']} "
                        "upstream_ref_unresolved offline_compare_unavailable",
        })
    elif snap["ancestry"] == "diverged":
        findings.append({
            "check": CHECK_DIVERGED,
            "severity": "critical",
            "evidence": f"branch={branch} upstream={snap['upstream_redacted']} "
                        f"ahead={snap['ahead']} behind={snap['behind']} "
                        "history_diverged_not_ancestor_or_descendant",
        })

    # 3. DIRECT-TO-PROTECTED-BRANCH AND ahead (critical) -- the hub-32 path.
    #    2. AHEAD-OF-UPSTREAM (warning) -- only when NOT already on a protected
    #    branch (else the critical above covers it; avoid double-emitting).
    if snap["upstream_resolved"] and snap["ahead"] > 0 and snap["ancestry"] in ("ahead", "diverged"):
        if snap["protected_branch"]:
            findings.append({
                "check": CHECK_DIRECT_TO_PROTECTED,
                "severity": "critical",
                "evidence": f"branch={branch} protected=true ahead={snap['ahead']} "
                            f"upstream={snap['upstream_redacted']} "
                            "commits_landed_directly_on_protected_branch_pr_bypass",
            })
        else:
            findings.append({
                "check": CHECK_AHEAD,
                "severity": "warning",
                "evidence": f"branch={branch} ahead={snap['ahead']} "
                            f"upstream={snap['upstream_redacted']} "
                            "unpushed_local_commits_invisible_until_pushed",
            })

    # 1. DIRTY (configurable severity).
    if snap["dirty_count"] > DIRTY_THRESHOLD:
        sev = DIRTY_SEVERITY if DIRTY_SEVERITY in SEVERITY_RANK else "warning"
        findings.append({
            "check": CHECK_DIRTY,
            "severity": sev,
            "evidence": f"branch={branch} dirty_count={snap['dirty_count']} "
                        f"threshold={DIRTY_THRESHOLD} "
                        "uncommitted_runtime_changes_lost_provenance",
        })

    # 5. PHANTOM SRC .ts (advisory info).
    phantom = snap.get("phantom_src") or []
    if phantom:
        shown = [redact_path_segment(p) for p in phantom[:PHANTOM_SRC_CAP]]
        findings.append({
            "check": CHECK_PHANTOM_SRC,
            "severity": "info",
            "evidence": f"branch={branch} untracked_src_ts_count={len(phantom)} "
                        f"samples={','.join(shown)} "
                        "possible_phantom_import_targets_or_abandoned_wip",
        })

    return findings


def overall_severity(findings: list[dict[str, str]]) -> str:
    sev = "info"
    for f in findings:
        if SEVERITY_RANK.get(f["severity"], 0) > SEVERITY_RANK.get(sev, 0):
            sev = f["severity"]
    return sev


# ---------------------------------------------------------------------------
# daily-health integration: emit FAIL/WARN lines the health-check classifies.
# ---------------------------------------------------------------------------
def _line_prefix(severity: str) -> str:
    # The health-check classifier treats "FAIL " lines as failures (-> critical)
    # and "WARN " lines as warnings.  info lines are plain.
    if severity == "critical":
        return "FAIL "
    if severity == "warning":
        return "WARN "
    return ""


def tree_provenance_inventory(profile: dict[str, Any] | None = None, *, do_fetch: bool = False) -> list[str]:
    """Return daily-health-style lines for embedding in the health-check's
    ``daily()`` ``lines`` list.

    Lines use the ``tree_provenance <branch>: ...`` shape so the health-check's
    ``_instance_from_fail_line`` keys a salient per-instance event on the
    (redacted) branch, never a path.  ``FAIL``/``WARN`` prefixes are honoured by
    the existing failure/warning classifier -- no health-check change needed
    beyond splicing this call into ``lines``.

    Gated by the ``expectTreeProvenance`` profile flag (default False, matching
    the health profile schema's opt-in convention); a host enables it in its
    local health profile. When disabled it emits a single skipped line.
    """
    profile = profile or {}
    expect = profile.get("expectTreeProvenance", False)
    if isinstance(expect, str):
        expect = expect.lower() in {"1", "true", "yes", "on"}
    if not expect:
        return ["tree_provenance: skipped by health profile"]

    try:
        snap = gather_tree_provenance(REPO_ROOT, do_fetch=do_fetch)
    except GitError as exc:
        # Inspection failure is itself a provenance gap, but not a host outage:
        # emit a WARN so it surfaces without storming criticals.
        return [f"WARN tree_provenance: inspection_error {str(exc)[:160]}"]

    findings = provenance_findings(snap)
    branch = snap.get("branch_redacted") or "DETACHED"
    if not findings:
        return [
            f"tree_provenance {branch}: clean dirty={snap['dirty_count']} "
            f"ahead={snap['ahead']} behind={snap['behind']} ancestry={snap['ancestry']}"
        ]
    lines: list[str] = []
    for f in findings:
        # Keep the instance token (branch) second so per-instance salient
        # emission keys on the branch.
        lines.append(f"{_line_prefix(f['severity'])}tree_provenance {branch}: "
                     f"{f['check']} {f['evidence']}")
    return lines


# ---------------------------------------------------------------------------
# Standalone outbox emission (format mirrors health-check outbox_event()).
# ---------------------------------------------------------------------------
def _state_root() -> Path:
    explicit = os.environ.get("BOT_ERRORS_STATE_DIR", "").strip()
    if explicit:
        return Path(explicit)
    return Path.home() / ".local/state/bot-errors"


def _resolve_outbox_dir() -> Path:
    return _state_root() / "outbox"


def _ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    try:
        path.chmod(0o700)
    except OSError:
        pass


def build_outbox_event(
    summary: str,
    evidence: str,
    severity: str,
    *,
    source: str = "tree-provenance",
    event_type: str = "alert",
    alert_source: str | None = None,
    snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Construct an outbox event dict matching the health-check schema."""
    outbox = _resolve_outbox_dir()
    event_id = f"treeprov-{time.time_ns()}-{os.getpid()}"
    envelope_event_type = "observation" if event_type == "alert" and severity == "info" else event_type
    event: dict[str, Any] = {
        **new_event_fields(envelope_event_type, severity),
        "id": event_id,
        "createdAt": now_iso(),
        "machine": socket.gethostname(),
        "platform": HOST_PLATFORM,
        "instance": "bot-errors-tree-provenance",
        "source": source,
        "summary": summary,
        "evidence": evidence,
        "process": {"pid": os.getpid(), "cwd": os.getcwd()},
        "diagnostics": {"queue": str(outbox)},
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    if alert_source is not None:
        event["alertSource"] = alert_source
    if snapshot is not None:
        event["treeProvenance"] = {
            "branch": snapshot.get("branch_redacted"),
            "detached": snapshot.get("detached"),
            "dirty_count": snapshot.get("dirty_count"),
            "ahead": snapshot.get("ahead"),
            "behind": snapshot.get("behind"),
            "ancestry": snapshot.get("ancestry"),
            "protected_branch": snapshot.get("protected_branch"),
            "repo_fingerprint": snapshot.get("repo_fingerprint"),
        }
    return event


def emit_outbox_event(event: dict[str, Any]) -> Path:
    outbox = _resolve_outbox_dir()
    root = _state_root()
    _ensure_private_dir(root)
    _ensure_private_dir(outbox)
    stamp = event["createdAt"].replace(":", "").replace("-", "")
    path = outbox / f"{stamp}.{event['id']}.json"
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(event, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    try:
        tmp.chmod(0o600)
    except OSError:
        pass
    os.replace(tmp, path)
    return path


def run_once(*, do_fetch: bool, dry: bool, reporter: bool = False) -> int:
    """Inspect the tree and (unless dry) emit one outbox event summarising
    provenance.  Returns 0 on info/clean, 1 on warning, 2 on critical.

    ``reporter=True`` selects scheduler mode instead: 0 for any successfully
    observed state (clean/warning/critical), 2 for an inspection failure, 1
    for an event-write failure. The default exit contract above is unchanged
    when ``reporter`` is False.
    """
    try:
        snap = gather_tree_provenance(REPO_ROOT, do_fetch=do_fetch)
    except GitError as exc:
        evidence = f"tree_provenance inspection_error {str(exc)[:200]}"
        if reporter:
            print(evidence, file=sys.stderr)
            return 2
        if not dry:
            emit_outbox_event(build_outbox_event(
                "BOT ERRORS tree-provenance inspection error",
                evidence,
                "warning",
                event_type="alert",
            ))
        print(evidence)
        return 1

    findings = provenance_findings(snap)
    sev = overall_severity(findings)
    branch = snap.get("branch_redacted") or "DETACHED"
    if not findings:
        evidence = (
            f"tree_provenance {branch}: clean dirty={snap['dirty_count']} "
            f"ahead={snap['ahead']} behind={snap['behind']} ancestry={snap['ancestry']}"
        )
        event_type, summary = "clear", "BOT ERRORS tree-provenance clean"
    else:
        evidence = "\n".join(
            f"{f['check']} severity={f['severity']} {f['evidence']}" for f in findings
        )
        event_type = "alert"
        summary = f"BOT ERRORS tree-provenance {sev}: {branch} ({len(findings)} finding(s))"

    if not dry:
        # Critical findings are salient: key the alert on the branch and request
        # notify so a direct-to-protected/diverged tree is never buried.
        alert_source = f"tree_provenance:{branch}" if sev == "critical" else None
        try:
            emit_outbox_event(build_outbox_event(
                summary, evidence, sev,
                event_type=event_type, alert_source=alert_source, snapshot=snap,
            ))
        except OSError as exc:
            print(f"tree_provenance event_write_error {str(exc)[:200]}", file=sys.stderr)
            return 1
    print(summary)
    print(evidence)
    if reporter:
        return 0
    return {"info": 0, "warning": 1, "critical": 2}[sev]


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="BOT ERRORS tree-provenance guard")
    parser.add_argument(
        "--repo", default=None,
        help="repo work tree to inspect (default: this script's repo)",
    )
    parser.add_argument(
        "--fetch", action="store_true",
        help="refresh origin ref before comparing (NETWORK; default offline)",
    )
    parser.add_argument(
        "--reporter", action="store_true",
        help="scheduler mode: exit 0 for any successfully observed finding state "
             "(clean/warning/critical), 2 for inspection failure, 1 for event-write "
             "failure; rejects --fetch",
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--once", action="store_true",
        help="inspect and emit one outbox event (default mode)",
    )
    group.add_argument(
        "--print", dest="dry", action="store_true",
        help="inspect and print findings WITHOUT emitting an outbox event",
    )
    group.add_argument(
        "--json", action="store_true",
        help="print the raw provenance snapshot as JSON and exit",
    )
    args = parser.parse_args(argv)
    if args.reporter and args.fetch:
        parser.error("--reporter rejects --fetch: scheduled runs must stay offline")
    if args.reporter and args.json:
        parser.error("--reporter does not combine with --json")
    return args


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    global REPO_ROOT
    if args.repo:
        REPO_ROOT = Path(args.repo).expanduser().resolve()
    if args.json:
        try:
            snap = gather_tree_provenance(REPO_ROOT, do_fetch=args.fetch)
        except GitError as exc:
            print(json.dumps({"error": str(exc)}))
            return 1
        # Drop raw branch/upstream/head detail; keep redacted view.
        safe = {k: v for k, v in snap.items() if k not in {"branch", "upstream", "head"}}
        safe["head_short"] = snap["head"][:12]
        print(json.dumps(safe, indent=2, sort_keys=True))
        return 0
    return run_once(do_fetch=args.fetch, dry=bool(args.dry), reporter=bool(args.reporter))


if __name__ == "__main__":
    sys.exit(main())
