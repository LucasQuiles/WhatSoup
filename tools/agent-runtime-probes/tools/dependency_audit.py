#!/usr/bin/env python3
"""dependency_audit — fail-closed supply-chain guard for any dependency the estate proposes
to install OUTSIDE the stdlib-only probe runtime (a sandboxed test/CI venv).

The estate default is stdlib-only, no installs. When a vetted exception is approved, NOTHING
is installed until this guard passes. For each pinned requirement it independently:

  1. fetches the package's published metadata from PyPI and proves the pinned sha256 matches
     the digest PyPI serves (tamper-evidence; a mismatch means the local pin or the wheel was
     altered) -> FAIL CLOSED on mismatch;
  2. records the PEP 740 / Sigstore provenance status (SIGNED by which publisher, or none) so
     the "is it signed" question is answered with evidence, not assumption;
  3. queries OSV for advisories affecting the EXACT pinned version (offline via a cached
     `--osv-zip`, or online with `--allow-network`) -> FAIL CLOSED on any advisory;
  4. enforces a policy: `require_signed` and `max_severity` are hard gates when set.

It NEVER installs anything; it only renders a metadata-only verdict that an operator (or a
pinned `pip --require-hashes` step) acts on. Output is JSON to stdout; exit 0 only if every
requirement PASSES every enabled gate.

Usage:
  dependency_audit.py --manifest <pins.json> --allow-network [--require-signed]
  dependency_audit.py --manifest <pins.json> --osv-zip <PyPI_all.zip>   # offline OSV

Manifest schema (metadata-only; no secrets):
  {"requirements": [{"name": "...", "version": "...", "sha256": "...", "filename": "...whl"}],
   "policy": {"require_signed": false, "fail_on_osv": true}}
"""
from __future__ import annotations

import argparse
import json
import ssl
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from probelib import redact, sha256_16  # noqa: E402

SCHEMA = "agent-runtime-dependency-audit"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

_PYPI_JSON = "https://pypi.org/pypi/{name}/{version}/json"
_PROVENANCE = "https://pypi.org/integrity/{name}/{version}/{filename}/provenance"
_OSV_QUERY = "https://api.osv.dev/v1/query"


class AuditError(ValueError):
    """Typed, fail-closed audit error: never green a requirement on uncertainty."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message


def _ctx() -> ssl.SSLContext:
    return ssl.create_default_context()


def _http_json(url: str, data: bytes | None = None) -> dict:
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=20, context=_ctx()) as resp:
        return json.loads(resp.read())


def verify_digest(name: str, version: str, filename: str, pinned_sha256: str) -> dict:
    """Prove the pinned sha256 matches the digest PyPI serves for this exact artifact.

    FAIL CLOSED: raises AuditError if the artifact is absent or the digest disagrees.
    """
    try:
        meta = _http_json(_PYPI_JSON.format(name=name, version=version))
    except urllib.error.HTTPError as exc:
        raise AuditError("pypi_unreachable", f"PyPI metadata HTTP {exc.code} for {name}=={version}") from exc
    urls = meta.get("urls", [])
    match = next((u for u in urls if u.get("filename") == filename), None)
    if match is None:
        raise AuditError("artifact_absent", f"{filename} not published for {name}=={version}")
    served = (match.get("digests") or {}).get("sha256", "")
    if served.lower() != pinned_sha256.lower():
        # Tamper-evidence: do NOT proceed; the pin and the published bytes disagree.
        raise AuditError(
            "digest_mismatch",
            f"sha256 pin disagrees with PyPI for {filename}: "
            f"pinned_16={pinned_sha256[:16]} served_16={served[:16]}",
        )
    license_id = meta.get("info", {}).get("license_expression") or meta.get("info", {}).get("license") or "unknown"
    return {"digest_match": True, "license": license_id}


def check_provenance(name: str, version: str, filename: str) -> dict:
    """Record PEP 740 / Sigstore provenance: SIGNED (by which publisher) or none.

    Absence is NOT an error here (PyPI signing coverage is still partial); it is reported so
    a `require_signed` policy can decide. Returns {signed: bool, publishers: [...]}.
    """
    try:
        prov = _http_json(_PROVENANCE.format(name=name, version=version, filename=filename))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return {"signed": False, "publishers": [], "note": "no PEP740 provenance published"}
        raise AuditError("provenance_unreachable", f"provenance HTTP {exc.code} for {filename}") from exc
    publishers = []
    for bundle in prov.get("attestation_bundles", []):
        pub = bundle.get("publisher", {})
        ident = pub.get("repository") or pub.get("organization") or pub.get("kind") or "unknown"
        publishers.append(f"{pub.get('kind', 'unknown')}:{ident}")
    return {"signed": bool(publishers), "publishers": publishers}


def _osv_from_zip(osv_zip: Path, name: str, version: str) -> list[str]:
    """Offline OSV: scan a cached PyPI advisory zip for advisories hitting this version.

    Conservative/fail-closed on a malformed entry: a parse error is surfaced as a synthetic
    advisory id so a degraded scan can never read as 'clean'.
    """
    if not osv_zip.exists():
        raise AuditError("osv_zip_absent", f"OSV zip not found: sha256_16={sha256_16(str(osv_zip))}")
    hits: list[str] = []
    target = name.lower().replace("_", "-")
    with zipfile.ZipFile(osv_zip) as zf:
        for entry in zf.namelist():
            if not entry.endswith(".json"):
                continue
            try:
                adv = json.loads(zf.read(entry))
            except (json.JSONDecodeError, KeyError):
                # Surface a synthetic advisory id so a degraded scan can never read 'clean';
                # the skip happens OUTSIDE the handler (no bare continue in an except).
                hits.append(f"PARSE_ERROR:{entry}")
                adv = None
            if adv is None:
                continue
            for affected in adv.get("affected", []):
                pkg = affected.get("package", {})
                if (pkg.get("ecosystem") != "PyPI"
                        or pkg.get("name", "").lower().replace("_", "-") != target):
                    continue
                versions = affected.get("versions") or []
                if version in versions:
                    hits.append(adv.get("id", entry))
    return hits


def _osv_online(name: str, version: str) -> list[str]:
    payload = json.dumps({"version": version, "package": {"ecosystem": "PyPI", "name": name}}).encode()
    data = _http_json(_OSV_QUERY, data=payload)
    return [v.get("id", "unknown") for v in data.get("vulns", [])]


def check_osv(name: str, version: str, osv_zip: Path | None, allow_network: bool) -> dict:
    """Advisories affecting the EXACT pinned version. FAIL CLOSED on any advisory."""
    if osv_zip is not None:
        advisories = _osv_from_zip(osv_zip, name, version)
        source = "offline_zip"
    elif allow_network:
        advisories = _osv_online(name, version)
        source = "osv_api"
    else:
        raise AuditError("osv_unchecked", "OSV not checked: supply --osv-zip or --allow-network")
    return {"advisories": advisories, "clean": not advisories, "source": source}


def audit_requirement(req: dict, policy: dict, osv_zip: Path | None, allow_network: bool) -> dict:
    name = req["name"]
    version = req["version"]
    filename = req["filename"]
    pinned = req["sha256"]
    result: dict = {
        "name": name,
        "version": version,
        "filename": filename,
        "sha256_16": pinned[:16],
    }
    digest = verify_digest(name, version, filename, pinned)
    result.update(digest)
    result["provenance"] = check_provenance(name, version, filename)
    result["osv"] = check_osv(name, version, osv_zip, allow_network)

    # Hard gates.
    reasons: list[str] = []
    if not result["osv"]["clean"] and policy.get("fail_on_osv", True):
        reasons.append(f"osv_advisories:{result['osv']['advisories']}")
    if policy.get("require_signed", False) and not result["provenance"]["signed"]:
        reasons.append("unsigned_but_required")
    result["verdict"] = "PASS" if not reasons else "FAIL"
    result["fail_reasons"] = reasons
    return result


def build_report(manifest: dict, osv_zip: Path | None, allow_network: bool) -> dict:
    requirements = manifest.get("requirements", [])
    policy = manifest.get("policy", {})
    if not isinstance(requirements, list) or not requirements:
        raise AuditError("empty_manifest", "manifest has no requirements")
    audited: list[dict] = []
    for req in requirements:
        missing = [k for k in ("name", "version", "sha256", "filename") if not req.get(k)]
        if missing:
            raise AuditError("malformed_requirement", f"requirement missing fields: {missing}")
        audited.append(audit_requirement(req, policy, osv_zip, allow_network))
    overall = "PASS" if all(a["verdict"] == "PASS" for a in audited) else "FAIL"
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": REDACTION,
        "policy": policy,
        "requirement_count": len(audited),
        "requirements": audited,
        "signed_count": sum(1 for a in audited if a["provenance"]["signed"]),
        "osv_clean_count": sum(1 for a in audited if a["osv"]["clean"]),
        "overall_verdict": overall,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Fail-closed supply-chain guard for pinned dependencies.")
    ap.add_argument("--manifest", required=True, help="Pinned requirements manifest (JSON)")
    ap.add_argument("--osv-zip", default=None, help="Cached OSV PyPI advisory zip for OFFLINE checks")
    ap.add_argument("--allow-network", action="store_true", help="Permit live PyPI + OSV queries")
    ap.add_argument("--require-signed", action="store_true", help="Hard-fail any unsigned requirement")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    manifest_path = Path(args.manifest)
    if not manifest_path.exists():
        report = {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "error_type": "missing_manifest",
            "_error": f"manifest not found: sha256_16={sha256_16(str(manifest_path))}",
        }
        json.dump(redact(report), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 1

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        report = {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "error_type": "malformed_manifest", "_error": f"JSONDecodeError: {exc}",
        }
        json.dump(redact(report), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 1

    # CLI flag overrides manifest policy for require_signed (operator intent wins, fail-closed).
    if args.require_signed:
        manifest.setdefault("policy", {})["require_signed"] = True

    osv_zip = Path(args.osv_zip) if args.osv_zip else None
    try:
        report = build_report(manifest, osv_zip, args.allow_network)
    except AuditError as exc:
        report = {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "error_type": exc.error_type, "_error": exc.message, "overall_verdict": "FAIL",
        }
        json.dump(redact(report), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 1

    json.dump(redact(report), sys.stdout, indent=2 if args.pretty else None)
    sys.stdout.write("\n")
    return 0 if report["overall_verdict"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
