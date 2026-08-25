from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import sys


REPO_ROOT = Path(__file__).resolve().parents[3]


def test_manifest_bundle_imports_bounded_jsonl_from_isolated_bundle(tmp_path: Path) -> None:
    manifest_path = REPO_ROOT / "deploy" / "bot-errors-runtime-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    bundle = tmp_path / "bundle"
    for entry in manifest["files"]:
        source = REPO_ROOT / entry["path"]
        target = bundle / entry["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)

    probe = r'''
import importlib.util
from pathlib import Path
import sys

bundle = Path(sys.argv[1]).resolve()
checkout = Path(sys.argv[2]).resolve()
scripts = bundle / "deploy" / "scripts"
sys.path.insert(0, str(scripts))
assert all(str(checkout) not in entry for entry in sys.path)
loaded = []
for index, filename in enumerate(
    ("bot-errors-dispatcher.py", "bot-errors-heartbeat-watchdog.py")
):
    module_name = f"bundle_probe_{index}"
    spec = importlib.util.spec_from_file_location(module_name, scripts / filename)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    publisher_path = Path(module.append_bounded_jsonl.__code__.co_filename).resolve()
    assert publisher_path == scripts / "lib" / "bounded_jsonl.py"
    assert str(checkout) not in str(publisher_path)
    loaded.append(filename)
print("BUNDLE_IMPORT_OK=" + ",".join(loaded))
'''
    completed = subprocess.run(
        [sys.executable, "-I", "-c", probe, str(bundle), str(REPO_ROOT)],
        cwd=bundle,
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == (
        "BUNDLE_IMPORT_OK=bot-errors-dispatcher.py,"
        "bot-errors-heartbeat-watchdog.py"
    )
