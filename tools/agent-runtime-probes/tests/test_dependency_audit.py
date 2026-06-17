#!/usr/bin/env python3
"""Tests for tools/dependency_audit — the fail-closed supply-chain guard.

Standalone runner (test_pi_presence_probe.py style; no pytest). NETWORK-FREE: every PyPI/OSV
HTTP call is monkeypatched, so the suite is deterministic and offline. Covers digest
match/mismatch, provenance signed/unsigned/404, OSV clean/dirty/offline-zip/parse-error, the
policy hard gates, malformed/missing manifest, and CLI e2e for both PASS and FAIL.

Provenance: synthetic in-memory fixtures (no real network, no secrets).
"""
import io
import json
import sys
import tempfile
import urllib.error
import zipfile
from contextlib import redirect_stdout
from pathlib import Path

TOOL_DIR = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOL_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import dependency_audit as da  # noqa: E402

GOOD_SHA = "ede5a3d142d9c5c9f70cb3075541905b228d6c3a682bcec3d4fe0722e9eda127"


def _req(name="hypothesis", version="6.155.3", sha=GOOD_SHA, filename="hypothesis-6.155.3-py3-none-any.whl"):
    return {"name": name, "version": version, "sha256": sha, "filename": filename}


def _raises(exc_types, fn, *a, **k):
    try:
        fn(*a, **k)
    except exc_types:
        return True
    return False


# --- _http_json exercised via a fake urlopen (covers the real request code) ------

class _FakeResp:
    def __init__(self, body):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_http_json_parses_via_fake_urlopen():
    orig = da.urllib.request.urlopen
    da.urllib.request.urlopen = lambda req, timeout=20, context=None: _FakeResp(b'{"ok": 1}')
    try:
        assert da._http_json("https://example/x", data=b"{}") == {"ok": 1}
        assert da._http_json("https://example/y") == {"ok": 1}
    finally:
        da.urllib.request.urlopen = orig


# --- verify_digest ---------------------------------------------------------------

def test_verify_digest_match():
    da._http_json = lambda url, data=None: {
        "info": {"license_expression": "MPL-2.0"},
        "urls": [{"filename": "f.whl", "digests": {"sha256": GOOD_SHA}}],
    }
    out = da.verify_digest("hypothesis", "6.155.3", "f.whl", GOOD_SHA)
    assert out["digest_match"] is True and out["license"] == "MPL-2.0"


def test_verify_digest_mismatch_fails_closed():
    da._http_json = lambda url, data=None: {
        "info": {}, "urls": [{"filename": "f.whl", "digests": {"sha256": "beef" + GOOD_SHA[4:]}}],
    }
    assert _raises(da.AuditError, da.verify_digest, "h", "1", "f.whl", GOOD_SHA)
    try:
        da.verify_digest("h", "1", "f.whl", GOOD_SHA)
    except da.AuditError as exc:
        assert exc.error_type == "digest_mismatch"


def test_verify_digest_artifact_absent_fails_closed():
    da._http_json = lambda url, data=None: {"info": {}, "urls": []}
    try:
        da.verify_digest("h", "1", "missing.whl", GOOD_SHA)
    except da.AuditError as exc:
        assert exc.error_type == "artifact_absent"


def test_verify_digest_pypi_http_error_fails_closed():
    def boom(url, data=None):
        raise urllib.error.HTTPError(url, 500, "boom", {}, None)
    da._http_json = boom
    try:
        da.verify_digest("h", "1", "f.whl", GOOD_SHA)
    except da.AuditError as exc:
        assert exc.error_type == "pypi_unreachable"


# --- check_provenance ------------------------------------------------------------

def test_provenance_signed():
    da._http_json = lambda url, data=None: {
        "attestation_bundles": [{"publisher": {"kind": "GitHub", "repository": "python-attrs/attrs"}}]
    }
    out = da.check_provenance("attrs", "26.1.0", "a.whl")
    assert out["signed"] is True and out["publishers"] == ["GitHub:python-attrs/attrs"]


def test_provenance_unsigned_404_is_not_error():
    def notfound(url, data=None):
        raise urllib.error.HTTPError(url, 404, "nf", {}, None)
    da._http_json = notfound
    out = da.check_provenance("hypothesis", "6.155.3", "h.whl")
    assert out["signed"] is False and "no PEP740" in out["note"]


def test_provenance_other_http_error_fails_closed():
    def boom(url, data=None):
        raise urllib.error.HTTPError(url, 503, "down", {}, None)
    da._http_json = boom
    try:
        da.check_provenance("x", "1", "x.whl")
    except da.AuditError as exc:
        assert exc.error_type == "provenance_unreachable"


# --- OSV: offline zip, online, parse-error, absent -------------------------------

def _make_osv_zip(path: Path, advisories: list[dict], junk: bool = False):
    with zipfile.ZipFile(path, "w") as zf:
        for i, adv in enumerate(advisories):
            zf.writestr(f"PyPI/ADV-{i}.json", json.dumps(adv))
        if junk:
            zf.writestr("PyPI/broken.json", "{not json")
        zf.writestr("README.txt", "ignored non-json")


def test_osv_zip_hit_and_clean():
    with tempfile.TemporaryDirectory() as d:
        zp = Path(d) / "osv.zip"
        _make_osv_zip(zp, [{
            "id": "GHSA-xxxx",
            "affected": [{"package": {"ecosystem": "PyPI", "name": "hypothesis"}, "versions": ["6.155.3"]}],
        }])
        assert da._osv_from_zip(zp, "hypothesis", "6.155.3") == ["GHSA-xxxx"]
        # A different version is clean.
        assert da._osv_from_zip(zp, "hypothesis", "1.0.0") == []
        # A different package is clean.
        assert da._osv_from_zip(zp, "attrs", "6.155.3") == []


def test_osv_zip_parse_error_fails_closed_not_clean():
    with tempfile.TemporaryDirectory() as d:
        zp = Path(d) / "osv.zip"
        _make_osv_zip(zp, [], junk=True)
        hits = da._osv_from_zip(zp, "hypothesis", "6.155.3")
        assert any(h.startswith("PARSE_ERROR:") for h in hits)


def test_osv_zip_absent_fails_closed():
    try:
        da._osv_from_zip(Path("/nonexistent/osv.zip"), "h", "1")
    except da.AuditError as exc:
        assert exc.error_type == "osv_zip_absent"


def test_osv_online():
    da._http_json = lambda url, data=None: {"vulns": [{"id": "OSV-1"}, {"id": "OSV-2"}]}
    assert da._osv_online("h", "1") == ["OSV-1", "OSV-2"]


def test_check_osv_unchecked_fails_closed():
    try:
        da.check_osv("h", "1", None, allow_network=False)
    except da.AuditError as exc:
        assert exc.error_type == "osv_unchecked"


def test_check_osv_online_clean():
    da._http_json = lambda url, data=None: {"vulns": []}
    out = da.check_osv("h", "1", None, allow_network=True)
    assert out["clean"] is True and out["source"] == "osv_api"


# --- audit_requirement gates -----------------------------------------------------

def _stub_all_clean_signed(signed=True, advisories=None):
    da.verify_digest = lambda *a: {"digest_match": True, "license": "MIT"}
    da.check_provenance = lambda *a: {"signed": signed, "publishers": ["GitHub:x"] if signed else []}
    da.check_osv = lambda *a, **k: {"advisories": advisories or [], "clean": not advisories, "source": "stub"}


def test_audit_requirement_pass():
    _stub_all_clean_signed(signed=True, advisories=None)
    out = da.audit_requirement(_req(), {"fail_on_osv": True}, None, True)
    assert out["verdict"] == "PASS" and out["fail_reasons"] == []


def test_audit_requirement_osv_fail():
    _stub_all_clean_signed(signed=True, advisories=["GHSA-1"])
    out = da.audit_requirement(_req(), {"fail_on_osv": True}, None, True)
    assert out["verdict"] == "FAIL" and any("osv_advisories" in r for r in out["fail_reasons"])


def test_audit_requirement_require_signed_fail():
    _stub_all_clean_signed(signed=False, advisories=None)
    out = da.audit_requirement(_req(), {"require_signed": True}, None, True)
    assert out["verdict"] == "FAIL" and "unsigned_but_required" in out["fail_reasons"]


# --- build_report ----------------------------------------------------------------

def test_build_report_pass():
    _stub_all_clean_signed(signed=True, advisories=None)
    rep = da.build_report({"requirements": [_req(), _req(name="attrs")], "policy": {}}, None, True)
    assert rep["overall_verdict"] == "PASS" and rep["requirement_count"] == 2


def test_build_report_empty_manifest_fails_closed():
    try:
        da.build_report({"requirements": []}, None, True)
    except da.AuditError as exc:
        assert exc.error_type == "empty_manifest"


def test_build_report_malformed_requirement_fails_closed():
    try:
        da.build_report({"requirements": [{"name": "x"}]}, None, True)
    except da.AuditError as exc:
        assert exc.error_type == "malformed_requirement"


# --- CLI e2e ---------------------------------------------------------------------

def _run_main(argv):
    saved = sys.argv
    sys.argv = ["dependency_audit.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = da.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_missing_manifest():
    with tempfile.TemporaryDirectory() as d:
        rc, rep = _run_main(["--manifest", str(Path(d) / "nope.json"), "--allow-network"])
        assert rc == 1 and rep["error_type"] == "missing_manifest"
        assert "/Users/" not in rep["_error"] and "sha256_16=" in rep["_error"]


def test_main_malformed_manifest():
    with tempfile.TemporaryDirectory() as d:
        mp = Path(d) / "m.json"
        mp.write_text("{not json", encoding="utf-8")
        rc, rep = _run_main(["--manifest", str(mp), "--allow-network"])
        assert rc == 1 and rep["error_type"] == "malformed_manifest"


def test_main_pass_e2e():
    _stub_all_clean_signed(signed=True, advisories=None)
    with tempfile.TemporaryDirectory() as d:
        mp = Path(d) / "m.json"
        mp.write_text(json.dumps({"requirements": [_req()], "policy": {}}), encoding="utf-8")
        rc, rep = _run_main(["--manifest", str(mp), "--allow-network", "--pretty"])
        assert rc == 0 and rep["overall_verdict"] == "PASS"


def test_main_fail_e2e_require_signed_flag_overrides():
    _stub_all_clean_signed(signed=False, advisories=None)
    with tempfile.TemporaryDirectory() as d:
        mp = Path(d) / "m.json"
        mp.write_text(json.dumps({"requirements": [_req()], "policy": {}}), encoding="utf-8")
        rc, rep = _run_main(["--manifest", str(mp), "--allow-network", "--require-signed"])
        assert rc == 1 and rep["overall_verdict"] == "FAIL"
        assert rep["requirements"][0]["fail_reasons"] == ["unsigned_but_required"]


def test_main_audit_error_path_fails_closed():
    # empty manifest -> build_report raises AuditError -> main renders FAIL marker, rc 1.
    with tempfile.TemporaryDirectory() as d:
        mp = Path(d) / "m.json"
        mp.write_text(json.dumps({"requirements": []}), encoding="utf-8")
        rc, rep = _run_main(["--manifest", str(mp), "--allow-network"])
        assert rc == 1 and rep["error_type"] == "empty_manifest" and rep["overall_verdict"] == "FAIL"


# Originals snapshot — tests monkeypatch module globals; restore before each test so
# alphabetical run-order can't leak a stub from one test into another.
_PATCHABLE = ("_http_json", "verify_digest", "check_provenance", "check_osv")
_ORIG = {name: getattr(da, name) for name in _PATCHABLE}


def _restore():
    for name, fn in _ORIG.items():
        setattr(da, name, fn)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        _restore()
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} dependency_audit tests passed")
