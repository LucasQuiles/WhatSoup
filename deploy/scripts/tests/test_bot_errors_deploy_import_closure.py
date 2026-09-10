"""The bot-errors deployer must ship every module its allowlist imports.

The deployer copies a fixed allowlist of files onto a target runtime root. A
TypeScript module in that allowlist is useless without the modules it imports:
Node resolves and links them at import time, so a missing dependency is not a
degraded feature, it is an unstartable runtime.

This is a closure property, not a one-file check. Any relative import reachable
from a deployed module has to be deployed too, transitively, and pinned in the
runtime manifest so a hash check can see drift in it.

The gap this pins is pre-existing: the allowlist has never carried the outbox
module's dependencies. It became load-bearing when the outbox began importing a
NEW export, because a target runtime then links a new importer against an old
dependency that does not provide the name. See the deployer-scope note on
#3452 for the same class of defect.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[3]
_DEPLOYER = _REPO / "deploy" / "scripts" / "whatsoup-bot-errors-deploy.sh"
_MANIFEST = _REPO / "deploy" / "bot-errors-runtime-manifest.json"

_RELATIVE_IMPORT = re.compile(r"""(?:from|import)\s+['"](\.{1,2}/[^'"]+)['"]""")


def _deployer_allowlist() -> list[str]:
    """Paths from the deployer's FILES=( ... ) array.

    Entries may carry a ``local:dest`` form; only the local path matters here.
    """
    text = _DEPLOYER.read_text()
    match = re.search(r"FILES=\(\n(.*?)\n\)", text, re.S)
    assert match, "deployer FILES=( ... ) array not found — the parser is stale"
    entries = [
        line.strip().strip('"').split(":")[0]
        for line in match.group(1).splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    assert entries, "deployer allowlist parsed as empty — the parser is stale"
    return entries


def _manifest_paths() -> set[str]:
    return {entry["path"] for entry in json.loads(_MANIFEST.read_text())["files"]}


def _relative_imports(repo_relative: str) -> list[str]:
    """Repo-relative targets of every relative import in `repo_relative`.

    Resolution is done on the REPO-RELATIVE dirname, never the absolute path:
    joining against an absolute parent yields absolute results that match
    nothing in the allowlist, which would make the whole walk silently return
    only its seeds. The coverage assertion below exists because that mistake
    was made here and passed three of four tests.
    """
    path = _REPO / repo_relative
    if path.suffix != ".ts" or not path.is_file():
        return []
    parent = os.path.dirname(repo_relative)
    return [
        os.path.normpath(os.path.join(parent, match.group(1)))
        for match in _RELATIVE_IMPORT.finditer(path.read_text())
    ]


def _import_closure(seeds: list[str]) -> set[str]:
    """Every repo-relative module transitively reachable from `seeds`."""
    seen: set[str] = set()
    queue = list(seeds)
    while queue:
        current = queue.pop()
        if current in seen:
            continue
        seen.add(current)
        for dependency in _relative_imports(current):
            if dependency not in seen:
                queue.append(dependency)
    return seen


def _deployed_source_closure() -> set[str]:
    seeds = [item for item in _deployer_allowlist() if item.startswith("src/")]
    assert seeds, "no src/ entries in the deployer allowlist — the parser is stale"
    return {item for item in _import_closure(seeds) if item.startswith("src/")}


def test_every_import_of_a_deployed_module_is_itself_deployed():
    allowlist = set(_deployer_allowlist())
    missing = sorted(_deployed_source_closure() - allowlist)
    assert not missing, (
        "the deployer ships modules whose imports it does not ship; a target "
        f"runtime cannot link them: {missing}"
    )


def test_every_import_of_a_deployed_module_is_pinned_in_the_manifest():
    """Unpinned means hash verification cannot see drift in it.

    A privacy-relevant module that is deployed but unpinned can change under
    the runtime without the manifest guard noticing.
    """
    pinned = _manifest_paths()
    missing = sorted(_deployed_source_closure() - pinned)
    assert not missing, (
        "the deployer ships modules the runtime manifest does not pin, so hash "
        f"verification cannot detect drift in them: {missing}"
    )


def test_the_closure_walk_actually_traverses(tmp_path):
    """Coverage assertion: a passing closure check must not be vacuous.

    If the import regex or the seed list silently matched nothing, both tests
    above would pass by finding an empty set. This pins that the walk really
    reaches a known dependency edge.
    """
    closure = _deployed_source_closure()
    assert "src/lib/bot-errors-outbox.ts" in closure, "seed missing from its own closure"
    assert len(closure) > 1, "closure found no dependencies at all — the walk is vacuous"
    # The outbox's dependency on the evidence-confinement module is the edge
    # that makes this suite necessary; if it disappears, this test should be
    # revisited rather than silently weakened.
    assert "src/lib/alert-evidence.ts" in closure


@pytest.mark.parametrize("module", ["src/lib/bot-errors-outbox.ts"])
def test_deployed_typescript_modules_exist(module):
    assert (_REPO / module).is_file()
