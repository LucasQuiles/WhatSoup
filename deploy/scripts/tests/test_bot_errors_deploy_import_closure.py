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

import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
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


def _seed_deployed_tree_without_fleet_lines(root: Path) -> None:
    for relative_path in _deployer_allowlist():
        source = _REPO / relative_path
        destination = root / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    (root / "deploy/scripts/lib/fleet_lines.py").unlink()


def _write_current_sources_manifest(tmp_path: Path) -> Path:
    manifest = tmp_path / "runtime-manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "files": [
                    {
                        "path": relative_path,
                        "sha256": hashlib.sha256(
                            (_REPO / relative_path).read_bytes()
                        ).hexdigest(),
                    }
                    for relative_path in _deployer_allowlist()
                ],
            }
        ),
        encoding="utf-8",
    )
    return manifest


def _write_import_observing_cp(tmp_path: Path) -> Path:
    observer = tmp_path / "observe_import.py"
    observer.write_text(
        """\
import importlib.util
import sys
from pathlib import Path

entry = Path(sys.argv[1])
scripts_root = sys.argv[2]
sys.path.insert(0, scripts_root)
module_name = f"deploy_copy_{entry.stem.replace('-', '_')}"
spec = importlib.util.spec_from_file_location(module_name, entry)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
sys.modules[module_name] = module
spec.loader.exec_module(module)
""",
        encoding="utf-8",
    )
    cp_dir = tmp_path / "bin"
    cp_dir.mkdir()
    cp_path = cp_dir / "cp"
    real_cp = shutil.which("cp")
    assert real_cp
    cp_path.write_text(
        f"""#!/usr/bin/env bash
set -euo pipefail
{shlex.quote(real_cp)} "$@"
destination="${{!#}}"
if [[ "$destination" == "$DEPLOY_IMPORT_ROOT/deploy/scripts/bot-errors-dispatcher.py" || \\
      "$destination" == "$DEPLOY_IMPORT_ROOT/deploy/scripts/bot-errors-health-check.py" ]]; then
    if "$DEPLOY_IMPORT_PYTHON" "$DEPLOY_IMPORT_OBSERVER" "$destination" \\
        "$DEPLOY_IMPORT_ROOT/deploy/scripts"; then
        result=ok
    else
        result=failed
    fi
    printf '%s\\t%s\\n' "$(basename "$destination")" "$result" >> "$DEPLOY_IMPORT_LOG"
fi
""",
        encoding="utf-8",
    )
    cp_path.chmod(0o755)
    return cp_dir


def test_deploy_materializes_fleet_lines_before_consumers_can_import(tmp_path: Path) -> None:
    target = tmp_path / "target"
    _seed_deployed_tree_without_fleet_lines(target)
    cp_dir = _write_import_observing_cp(tmp_path)
    manifest = _write_current_sources_manifest(tmp_path)
    observations = tmp_path / "imports.tsv"
    environment = os.environ | {
        "PATH": f"{cp_dir}{os.pathsep}{os.environ['PATH']}",
        "DEPLOY_IMPORT_ROOT": str(target),
        "DEPLOY_IMPORT_LOG": str(observations),
        "DEPLOY_IMPORT_OBSERVER": str(tmp_path / "observe_import.py"),
        "DEPLOY_IMPORT_PYTHON": sys.executable,
        "BOT_ERRORS_RUNTIME_MANIFEST_PATH": str(manifest),
    }

    completed = subprocess.run(
        [str(_DEPLOYER), "deploy", str(target), str(_REPO)],
        cwd=_REPO,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
        timeout=60,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    copied_imports = dict(
        line.split("\t", 1)
        for line in observations.read_text(encoding="utf-8").splitlines()
    )
    assert copied_imports == {
        "bot-errors-dispatcher.py": "ok",
        "bot-errors-health-check.py": "ok",
    }, completed.stdout + completed.stderr


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
