"""Tests for #2438: prune_action_outbox errors logged, not silently swallowed."""
import sys, os, io, contextlib, tempfile, types, json
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-sentinel.py"
LIB = SCRIPT.parent / "lib"

_mod_name = "sentinel_test_2438"
_mod = types.ModuleType(_mod_name)
_mod.__file__ = str(SCRIPT)
sys.modules[_mod_name] = _mod
sys.path.insert(0, str(LIB))

exec(compile(SCRIPT.read_text(), str(SCRIPT), "exec"), _mod.__dict__)

mod = _mod

from dataclasses import dataclass

@dataclass
class FakeConfig:
    state_dir: Path
    action_outbox_dir: Path | None = None
    action_outbox_retention: int = 10

# Test 1: missing outbox logs to stderr
tmp = Path(tempfile.mkdtemp())
tmp.chmod(0o700)
cfg = FakeConfig(tmp)
buf = io.StringIO()
with contextlib.redirect_stderr(buf):
    depth = mod.prune_action_outbox(cfg)
assert depth == 0, f"expected 0, got {depth}"
stderr = buf.getvalue()
assert "[bot-errors-sentinel]" in stderr and "does not exist" in stderr
print("PASS: missing_outbox_logged")

# Test 2: happy path returns correct depth
outbox = tmp / "actions"
outbox.mkdir()
for i in range(5):
    (outbox / f"event-{i}.json").write_text(json.dumps({"i": i}))
buf = io.StringIO()
with contextlib.redirect_stderr(buf):
    depth = mod.prune_action_outbox(cfg)
stderr = buf.getvalue()
assert depth == 5, f"expected depth 5, got {depth}"
assert stderr == "", f"expected no stderr on happy path, got: {stderr}"
print("PASS: happy_path_returns_depth")

print()
print("ALL 2 TESTS PASS (TRUE_RC=0)")
