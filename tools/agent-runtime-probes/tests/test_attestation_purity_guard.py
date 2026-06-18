#!/usr/bin/env python3
"""Tests for tools/attestation_purity_guard — the mechanical separation interlock.

Standalone runner (no pytest). Proves the guard PASSES the real attestation module and FAILS closed
on every leak class: forbidden verdict/plane/gate vocabulary, a forbidden gate import, drifted/absent
closed field sets, a missing module, an unreadable path, and a parse error. Synthetic fixtures.
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

TOOL_DIR = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOL_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import attestation_purity_guard as apg  # noqa: E402

CLEAN_FIELDS = '''
from dataclasses import dataclass
@dataclass(frozen=True)
class Benefit:
    value: float
    unit: str
    direction: str
    proof_class: str
    evidence_ref: str
@dataclass(frozen=True)
class Attestation:
    chain_id: str
    step_index: int
    declared_purpose: str
    delta_type: str
    input_hash: str
    output_hash: str
    prev_record_hash: str
    determinism_ok: bool
    benefit: Benefit
    record_hash: str
'''


def _write(tmp: Path, name: str, src: str) -> Path:
    p = tmp / name
    p.write_text(src, encoding="utf-8")
    return p


def _err_type(fn, *a, **k):
    try:
        fn(*a, **k)
    except apg.PurityError as exc:
        return exc.error_type
    return None


# --- clean real module passes --------------------------------------------------

def test_real_module_is_pure():
    rep = apg.scan_module(apg.DEFAULT_MODULE)
    assert rep["verdict"] == "PASS"
    assert rep["vocabulary_clean"] is True and rep["fields_pinned"] is True


def test_forbidden_hit_helper():
    assert apg._forbidden_hit("quality_not_worse") is None  # none of those words are forbidden
    assert apg._forbidden_hit("adopt_step") == "adopt"
    assert apg._forbidden_hit("the_gate") == "gate"
    assert apg._forbidden_hit("investigate") is None  # 'gate' is not a whole underscore-token here


# --- forbidden vocabulary + imports fail closed --------------------------------

def test_forbidden_vocabulary_fails():
    src = CLEAN_FIELDS + '''
the_plane = 1
def adopt_it():
    return 0
def use(gate):
    return gate
obj = use(the_plane)
val = obj.verdict
from enricher_lift_gate import thing
'''
    with tempfile.TemporaryDirectory() as d:
        p = _write(Path(d), "leaky.py", src)
        rep = apg.scan_module(p)
    kinds = {f["kind"] for f in rep["findings"]}
    assert rep["verdict"] == "FAIL" and rep["vocabulary_clean"] is False
    assert {"forbidden_identifier", "forbidden_def", "forbidden_arg",
            "forbidden_attribute", "forbidden_import"} <= kinds


# --- field drift / absence fail closed -----------------------------------------

def test_field_drift_fails():
    src = '''
from dataclasses import dataclass
@dataclass
class Benefit:
    value: float
    surprise: int
@dataclass
class Attestation:
    chain_id: str
'''
    with tempfile.TemporaryDirectory() as d:
        p = _write(Path(d), "drift.py", src)
        rep = apg.scan_module(p)
    kinds = {f["kind"] for f in rep["findings"]}
    assert rep["verdict"] == "FAIL" and rep["fields_pinned"] is False
    assert "attestation_field_drift" in kinds and "benefit_field_drift" in kinds


def test_import_allowlist_dynamic_dispatch_and_synonyms_fail():
    src = CLEAN_FIELDS + '''
import numpy
from some_helper import route_to_plane
reducer_table = {}
def f(name, obj):
    return getattr(obj, "_" + name)()
'''
    with tempfile.TemporaryDirectory() as d:
        rep = apg.scan_module(_write(Path(d), "evasive.py", src))
    kinds = {f["kind"] for f in rep["findings"]}
    assert rep["verdict"] == "FAIL" and rep["vocabulary_clean"] is False
    assert {"forbidden_import", "dynamic_dispatch", "forbidden_identifier"} <= kinds
    mods = {f.get("module") for f in rep["findings"] if f["kind"] == "forbidden_import"}
    assert "numpy" in mods and "some_helper" in mods


def test_constant_getattr_is_allowed():
    # a getattr with a constant attribute name is NOT dynamic dispatch (covers the allowed branch).
    src = CLEAN_FIELDS + 'v = getattr(object, "real")\n'
    with tempfile.TemporaryDirectory() as d:
        rep = apg.scan_module(_write(Path(d), "ok.py", src))
    assert rep["verdict"] == "PASS"
    assert not any(f["kind"] == "dynamic_dispatch" for f in rep["findings"])


def test_missing_classes_fail():
    with tempfile.TemporaryDirectory() as d:
        p = _write(Path(d), "empty.py", "x = 1\n")
        rep = apg.scan_module(p)
    kinds = {f["kind"] for f in rep["findings"]}
    assert "attestation_class_absent" in kinds and "benefit_class_absent" in kinds


# --- IO / parse errors fail closed ---------------------------------------------

def test_missing_module_fails_closed():
    assert _err_type(apg.scan_module, Path("/nonexistent/x.py")) == "missing_module"


def test_unreadable_path_fails_closed():
    with tempfile.TemporaryDirectory() as d:
        # a directory exists but read_text raises OSError -> read_error (path hashed, not leaked)
        et = _err_type(apg.scan_module, Path(d))
        assert et == "read_error"


def test_parse_error_fails_closed():
    with tempfile.TemporaryDirectory() as d:
        p = _write(Path(d), "broken.py", "def (:\n")
        assert _err_type(apg.scan_module, p) == "parse_error"


# --- CLI e2e -------------------------------------------------------------------

def _run_main(argv):
    saved = sys.argv
    sys.argv = ["attestation_purity_guard.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = apg.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_pass_on_default_and_fail_on_missing():
    rc, rep = _run_main(["--pretty"])  # default module is clean
    assert rc == 0 and rep["verdict"] == "PASS"

    rc, rep = _run_main(["--module", "/nonexistent/x.py"])
    assert rc == 1 and rep["error_type"] == "missing_module" and "/nonexistent" not in rep["_error"]


def test_main_fail_on_leaky_module():
    with tempfile.TemporaryDirectory() as d:
        p = _write(Path(d), "leaky.py", CLEAN_FIELDS + "the_gate = 1\n")
        rc, rep = _run_main(["--module", str(p)])
        assert rc == 1 and rep["verdict"] == "FAIL"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} attestation_purity_guard tests passed")
