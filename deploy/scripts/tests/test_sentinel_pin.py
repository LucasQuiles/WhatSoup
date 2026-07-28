"""TDD tests for sentinel_pin.py — Fleet Runtime Sentinel Plan 1 (Pin Foundation)."""
from __future__ import annotations
import json, os, pathlib, sys
import pytest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "lib"))
import sentinel_pin as sp


def _manifest(tmp_path, files, head=None):
    m = {"schemaVersion": 1, "files": files}
    if head is not None: m["expected_head_sha"] = head
    p = tmp_path / "manifest.json"; p.write_text(json.dumps(m)); return p


def test_load_pin_extracts_files_head_and_f10(tmp_path):
    files = [
        {"path": "deploy/scripts/lib/bot_errors_redaction.py", "sha256": "1448da21" + "0"*56},
        {"path": "deploy/scripts/bot-errors-emit.py", "sha256": "bb97461a" + "0"*56},
    ]
    pin = sp.load_pin(_manifest(tmp_path, files, head="a"*40))
    assert pin.head_sha == "a"*40
    assert pin.files["deploy/scripts/bot-errors-emit.py"] == "bb97461a" + "0"*56
    assert pin.f10_sha == "1448da21" + "0"*56


def test_load_pin_head_absent_is_none(tmp_path):
    pin = sp.load_pin(_manifest(tmp_path, [{"path": "deploy/scripts/lib/bot_errors_redaction.py", "sha256": "1448da21"+"0"*56}]))
    assert pin.head_sha is None


def test_load_pin_missing_file_raises_pinloaderror(tmp_path):
    with pytest.raises(sp.PinLoadError):
        sp.load_pin(tmp_path / "does-not-exist.json")


def test_load_pin_malformed_json_raises_pinloaderror(tmp_path):
    p = tmp_path / "bad.json"; p.write_text("{not json")
    with pytest.raises(sp.PinLoadError):
        sp.load_pin(p)


@pytest.mark.parametrize(
    "payload",
    [
        {"schemaVersion": 2, "files": []},
        {"schemaVersion": 1, "files": "not-a-list"},
        {"schemaVersion": 1, "files": ["not-an-object"]},
        {"schemaVersion": 1, "files": [{"path": "", "sha256": "0"*64}]},
        {"schemaVersion": 1, "files": [{"path": "../escape", "sha256": "0"*64}]},
        {"schemaVersion": 1, "files": [{"path": "/absolute", "sha256": "0"*64}]},
        {"schemaVersion": 1, "files": [{"path": "deploy//double", "sha256": "0"*64}]},
        {"schemaVersion": 1, "files": [{"path": "deploy/scripts/x.py", "sha256": "not-a-sha"}]},
        {"schemaVersion": 1, "expected_head_sha": "not-a-sha", "files": []},
        {
            "schemaVersion": 1,
            "files": [
                {"path": "deploy/scripts/x.py", "sha256": "0"*64},
                {"path": "deploy/scripts/x.py", "sha256": "1"*64},
            ],
        },
    ],
)
def test_load_pin_rejects_untrusted_manifest_shapes(tmp_path, payload):
    p = tmp_path / "manifest.json"; p.write_text(json.dumps(payload))
    with pytest.raises(sp.PinLoadError):
        sp.load_pin(p)


# ---------------------------------------------------------------------------
# Increment 2 — trust anchor (commit-exists + F10 ledger floor)
# ---------------------------------------------------------------------------

def _pin(head="a"*40, f10="1448da21"+"0"*56):
    return sp.Pin(head_sha=head, files={sp.F10_PATH: f10}, f10_sha=f10)


def test_trust_ok_when_commit_exists_and_f10_approved():
    ok, reason = sp.verify_pin_trust(_pin(), approved_f10={"1448da21"+"0"*56}, commit_exists=lambda s: True)
    assert ok is True and reason == "ok"


def test_trust_rejects_unknown_commit():
    ok, reason = sp.verify_pin_trust(_pin(), approved_f10={"1448da21"+"0"*56}, commit_exists=lambda s: False)
    assert ok is False and "commit" in reason


def test_trust_rejects_f10_not_in_ledger():
    ok, reason = sp.verify_pin_trust(_pin(f10="d62148b8"+"0"*56), approved_f10={"1448da21"+"0"*56}, commit_exists=lambda s: True)
    assert ok is False and "f10" in reason


def test_trust_rejects_unstamped_pin():
    ok, reason = sp.verify_pin_trust(_pin(head=None), approved_f10={"1448da21"+"0"*56}, commit_exists=lambda s: True)
    assert ok is False and "unstamped" in reason


def test_load_approved_f10_reads_ledger(tmp_path):
    led = tmp_path / "ledger.json"; led.write_text(json.dumps({"approved_f10": ["1448da21"+"0"*56]}))
    assert sp.load_approved_f10(led) == {"1448da21"+"0"*56}


def test_load_approved_heads_reads_optional_ledger_floor(tmp_path):
    led = tmp_path / "ledger.json"
    led.write_text(json.dumps({"approved_f10": ["1448da21"+"0"*56], "approved_heads": ["a"*40]}))
    assert sp.load_approved_heads(led) == {"a"*40}


def test_load_approved_heads_missing_field_defaults_empty(tmp_path):
    led = tmp_path / "ledger.json"; led.write_text(json.dumps({"approved_f10": ["1448da21"+"0"*56]}))
    assert sp.load_approved_heads(led) == set()


@pytest.mark.parametrize("payload", [{"approved_f10": "bad"}, {"approved_f10": ["not-a-sha"]}, []])
def test_load_approved_f10_rejects_bad_ledger(tmp_path, payload):
    led = tmp_path / "ledger.json"; led.write_text(json.dumps(payload))
    with pytest.raises(sp.PinLoadError):
        sp.load_approved_f10(led)


@pytest.mark.parametrize("payload", [{"approved_f10": ["1448da21"+"0"*56], "approved_heads": "bad"}, {"approved_f10": ["1448da21"+"0"*56], "approved_heads": ["not-a-sha"]}])
def test_load_approved_heads_rejects_bad_ledger(tmp_path, payload):
    led = tmp_path / "ledger.json"; led.write_text(json.dumps(payload))
    with pytest.raises(sp.PinLoadError):
        sp.load_approved_heads(led)


def test_trust_rejects_invalid_head_shape_without_calling_git():
    called = False

    def commit_exists(_sha):
        nonlocal called
        called = True
        return True

    ok, reason = sp.verify_pin_trust(_pin(head="abc123"), approved_f10={"1448da21"+"0"*56}, commit_exists=commit_exists)
    assert ok is False and "invalid expected_head_sha" in reason
    assert called is False


def test_trust_rejects_commit_probe_exception():
    def commit_exists(_sha):
        raise RuntimeError("git unavailable")

    ok, reason = sp.verify_pin_trust(_pin(), approved_f10={"1448da21"+"0"*56}, commit_exists=commit_exists)
    assert ok is False and "commit check failed" in reason


def test_trust_allows_deploy_approved_head_when_git_unavailable():
    def commit_exists(_sha):
        raise RuntimeError("not a git repository")

    ok, reason = sp.verify_pin_trust(
        _pin(),
        approved_f10={"1448da21"+"0"*56},
        commit_exists=commit_exists,
        approved_heads={"a"*40},
    )
    assert ok is True and reason == "ok: approved head ledger"


def test_trust_rejects_invalid_f10_shape():
    ok, reason = sp.verify_pin_trust(_pin(f10="abc123"), approved_f10={"abc123"}, commit_exists=lambda s: True)
    assert ok is False and "invalid f10" in reason


# ---------------------------------------------------------------------------
# Increment 3 — bundle integrity
# ---------------------------------------------------------------------------

import hashlib


def _write(p, content):
    p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(content); return hashlib.sha256(content).hexdigest()


def test_bundle_ok_when_all_files_match(tmp_path):
    b = tmp_path / "bundle"
    s1 = _write(b / "deploy/scripts/bot-errors-emit.py", b"emit\n")
    s2 = _write(b / sp.F10_PATH, b"redact\n")
    pin = sp.Pin(head_sha="a"*40, files={"deploy/scripts/bot-errors-emit.py": s1, sp.F10_PATH: s2}, f10_sha=s2)
    ok, mismatches = sp.verify_bundle(b, pin)
    assert ok is True and mismatches == []


def test_bundle_flags_missing_and_mismatch(tmp_path):
    b = tmp_path / "bundle"; _write(b / sp.F10_PATH, b"WRONG\n")
    pin = sp.Pin(head_sha="a"*40, files={"deploy/scripts/bot-errors-emit.py": "0"*64, sp.F10_PATH: "1"*64}, f10_sha="1"*64)
    ok, mismatches = sp.verify_bundle(b, pin)
    assert ok is False and {m[1] for m in mismatches} == {"missing", "sha"}


def test_bundle_rejects_unsafe_path_without_touching_outside_bundle(tmp_path):
    outside = tmp_path / "outside.txt"; outside.write_text("outside")
    pin = sp.Pin(head_sha="a"*40, files={"../outside.txt": "0"*64}, f10_sha=None)
    ok, mismatches = sp.verify_bundle(tmp_path / "bundle", pin)
    assert ok is False and mismatches == [("../outside.txt", "unsafe_path")]


def test_bundle_rejects_symlinked_file(tmp_path):
    b = tmp_path / "bundle"; target = tmp_path / "target.py"; target.write_text("redact\n")
    link = b / sp.F10_PATH; link.parent.mkdir(parents=True)
    os.symlink(target, link)
    pin = sp.Pin(head_sha="a"*40, files={sp.F10_PATH: hashlib.sha256(b"redact\n").hexdigest()}, f10_sha=None)
    ok, mismatches = sp.verify_bundle(b, pin)
    assert ok is False and mismatches == [(sp.F10_PATH, "symlink")]


# ---------------------------------------------------------------------------
# Increment 3b — descriptor-confined observation (#2479)
# Intermediate parent symlinks, symlinked root, and external-target
# confinement are now rejected at every path component.
# ---------------------------------------------------------------------------

def test_bundle_rejects_intermediate_parent_symlink(tmp_path):
    """A symlink in any intermediate directory component must fail closed
    with 'parent_symlink', even when the final leaf is a regular file with
    the expected hash living outside the bundle root."""
    b = tmp_path / "bundle"
    outside = tmp_path / "outside_tree"
    # Create the real directory structure outside the bundle
    real_dir = outside / "deploy" / "scripts" / "lib"
    real_dir.mkdir(parents=True)
    content = b"redact\n"
    real_file = real_dir / "bot_errors_redaction.py"
    real_file.write_bytes(content)
    expected_sha = hashlib.sha256(content).hexdigest()

    # Create bundle root with deploy/scripts/ as a symlink to the outside tree
    (b / "deploy" / "scripts").mkdir(parents=True)
    os.symlink(outside / "deploy" / "scripts" / "lib", b / "deploy" / "scripts" / "lib")

    pin = sp.Pin(head_sha="a"*40, files={sp.F10_PATH: expected_sha}, f10_sha=None)
    ok, mismatches = sp.verify_bundle(b, pin)
    assert ok is False
    assert mismatches == [(sp.F10_PATH, "parent_symlink")], f"got {mismatches}"


def test_bundle_rejects_symlinked_root(tmp_path):
    """A bundle root that is itself a symlink must fail closed with 'root_symlink'."""
    real_root = tmp_path / "real_root"
    real_dir = real_root / sp.F10_PATH
    real_dir.parent.mkdir(parents=True)
    content = b"redact\n"
    real_dir.write_bytes(content)
    expected_sha = hashlib.sha256(content).hexdigest()

    linked_root = tmp_path / "linked_root"
    os.symlink(real_root, linked_root)

    pin = sp.Pin(head_sha="a"*40, files={sp.F10_PATH: expected_sha}, f10_sha=None)
    ok, mismatches = sp.verify_bundle(linked_root, pin)
    assert ok is False
    assert mismatches == [(sp.F10_PATH, "root_symlink")], f"got {mismatches}"


def test_bundle_rejects_external_target_with_matching_hash(tmp_path):
    """A canonical target outside the trusted root cannot pass even when its
    bytes have the expected hash (verified via the descriptor-confined path)."""
    b = tmp_path / "bundle"
    outside = tmp_path / "outside"
    outside.mkdir()
    content = b"redact\n"
    outside_file = outside / "bot_errors_redaction.py"
    outside_file.write_bytes(content)
    expected_sha = hashlib.sha256(content).hexdigest()

    # Create intermediate symlink so the manifest path resolves outside
    (b / "deploy" / "scripts").mkdir(parents=True)
    os.symlink(outside, b / "deploy" / "scripts" / "lib")

    pin = sp.Pin(head_sha="a"*40, files={sp.F10_PATH: expected_sha}, f10_sha=None)
    ok, mismatches = sp.verify_bundle(b, pin)
    assert ok is False
    assert mismatches == [(sp.F10_PATH, "parent_symlink")], f"got {mismatches}"


def test_bundle_rejects_file_kind_for_directory_leaf(tmp_path):
    """A directory where a regular file is expected fails closed with 'file_kind'."""
    b = tmp_path / "bundle"
    leaf_dir = b / sp.F10_PATH
    leaf_dir.mkdir(parents=True)
    pin = sp.Pin(head_sha="a"*40, files={sp.F10_PATH: "0"*64}, f10_sha=None)
    ok, mismatches = sp.verify_bundle(b, pin)
    assert ok is False
    assert mismatches == [(sp.F10_PATH, "file_kind")], f"got {mismatches}"


def test_bundle_regular_files_still_verify_after_hardening(tmp_path):
    """Regression guard: regular in-root files at multiple directory depths
    still verify successfully with the descriptor-confined traversal."""
    b = tmp_path / "bundle"
    s1 = _write(b / "deploy/scripts/bot-errors-emit.py", b"emit\n")
    s2 = _write(b / sp.F10_PATH, b"redact\n")
    s3 = _write(b / "deploy/scripts/bot-errors-runner.py", b"runner\n")
    pin = sp.Pin(
        head_sha="a"*40,
        files={
            "deploy/scripts/bot-errors-emit.py": s1,
            sp.F10_PATH: s2,
            "deploy/scripts/bot-errors-runner.py": s3,
        },
        f10_sha=s2,
    )
    ok, mismatches = sp.verify_bundle(b, pin)
    assert ok is True and mismatches == [], f"got {ok} {mismatches}"


# ---------------------------------------------------------------------------
# Increment 4 — edge cases for coverage >= 98%
# ---------------------------------------------------------------------------

def test_sha256_file_large_chunked(tmp_path):
    p = tmp_path / "big.bin"; data = b"x" * (65536 * 2 + 7); p.write_bytes(data)
    assert sp._sha256_file(p) == hashlib.sha256(data).hexdigest()


def test_trust_reason_when_f10_none():
    ok, reason = sp.verify_pin_trust(sp.Pin(head_sha="a"*40, files={}, f10_sha=None), approved_f10={"x"}, commit_exists=lambda s: True)
    assert ok is False and "none" in reason
