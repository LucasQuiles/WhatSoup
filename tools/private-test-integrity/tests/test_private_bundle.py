"""RED contract for private scanner-tree materialization without Git metadata."""

from __future__ import annotations

import contextlib
import hashlib
import io
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import tempfile
import types
import unittest
from unittest import mock


from private_scanner_candidate import (  # noqa: E402
    BoundaryError,
    TrustedScannerBundle,
    VerifiedScannerBundle,
    _manifest_digest,
)
import private_bundle  # noqa: E402
from private_bundle import GitLsTreeBlob, export_verified_bundle  # noqa: E402


COMMIT = "a" * 40
TREE = "b" * 40
ENTRYPOINT = "scripts/test-integrity"
FILES = {
    ENTRYPOINT: b"#!/usr/bin/env python3\nraise SystemExit(0)\n",
    "rules/default.json": b'{"rules": []}\n',
}
SELECTOR_MODULE = "scripts/test_integrity_core.py"
_SYNTHETIC_SELECTOR = b'''\
from dataclasses import dataclass
from pathlib import Path
import sys
sys.path.insert(0, "synthetic-private-vendor")

print("synthetic selector import stdout")
print("synthetic selector import stderr", file=sys.stderr)

@dataclass(frozen=True)
class SelectorRules:
    directory: str = "oracle"
    suffix: str = ".focus"

RULES = SelectorRules()

def is_test_surface(path):
    print("synthetic selector call stdout")
    print("synthetic selector call stderr", file=sys.stderr)
    if not isinstance(path, Path):
        raise RuntimeError("selector did not receive a pathlib.Path")
    return path.parts[:1] == (RULES.directory,) and path.name.endswith(RULES.suffix)
'''
_IMPORT_FAILURE_SELECTOR = b'''\
import sys
sys.path.insert(0, "synthetic-failed-vendor")
print("synthetic private import failure")
raise RuntimeError("private selector import detail")
'''
_RUNTIME_FAILURE_SELECTOR = b'''\
import sys

def is_test_surface(path):
    print("synthetic private selector failure")
    print("synthetic private selector failure", file=sys.stderr)
    raise RuntimeError("private selector runtime detail")
'''
_NON_BOOLEAN_SELECTOR = b'''\
def is_test_surface(path):
    return 1
'''
_NATIVE_FD_SELECTOR = b'''\
import os

os.write(1, b"private native import stdout")
os.write(2, b"private native import stderr")

def is_test_surface(path):
    os.write(1, b"private native predicate stdout")
    os.write(2, b"private native predicate stderr")
    return True
'''
_NATIVE_FD_FAILURE_SELECTOR = b'''\
import os

os.write(1, b"private native import stdout")
os.write(2, b"private native import stderr")

def is_test_surface(path):
    os.write(1, b"private native predicate stdout")
    os.write(2, b"private native predicate stderr")
    raise RuntimeError("private native predicate failure")
'''
_EXECUTION_MARKER_SELECTOR = b'''\
from pathlib import Path
Path(__file__).with_name("unexpected-execution").write_text("executed", encoding="utf-8")

def is_test_surface(path):
    return True
'''


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git_blob_oid(data: bytes) -> str:
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()


def tree_entries(
    files: dict[str, bytes],
    *,
    modes: dict[str, str] | None = None,
    object_types: dict[str, str] | None = None,
    object_ids: dict[str, str] | None = None,
    sizes: dict[str, int] | None = None,
) -> tuple[GitLsTreeBlob, ...]:
    return tuple(
        GitLsTreeBlob(
            path=path,
            mode=(modes or {}).get(path, "100644"),
            object_type=(object_types or {}).get(path, "blob"),
            object_id=(object_ids or {}).get(path, git_blob_oid(content)),
            size=(sizes or {}).get(path, len(content)),
        )
        for path, content in files.items()
    )


def full_manifest(files: dict[str, bytes]) -> dict[str, str]:
    return {path: sha256(content) for path, content in files.items()}


class PrivateBundleTests(unittest.TestCase):
    def test_rejects_a_symlinked_destination_parent_before_blob_reads(self) -> None:
        with tempfile.TemporaryDirectory(prefix="private-bundle-test-") as scratch:
            root = Path(scratch).resolve()
            target = root / "target"
            target.mkdir()
            alias = root / "alias"
            alias.symlink_to(target, target_is_directory=True)
            reads = []
            with self.assertRaises(BoundaryError):
                self._materialize(alias / "scanner", tree_entries(FILES),
                                  lambda oid: reads.append(oid) or FILES[ENTRYPOINT])
            self.assertEqual(reads, [])
            self.assertEqual(list(target.iterdir()), [])

    def _materialize(
        self,
        destination: Path,
        entries,
        reader,
        *,
        verified_commit: str = COMMIT,
        expected_commit: str = COMMIT,
        verified_tree: str = TREE,
        expected_tree: str = TREE,
        entrypoint: str = ENTRYPOINT,
        max_files: int = 8,
        max_total_bytes: int = 4096,
        expected_manifest_digest: str | None = None,
    ):
        manifest_digest = _manifest_digest(full_manifest(FILES)) if expected_manifest_digest is None else expected_manifest_digest
        return export_verified_bundle(
            verified_commit,
            verified_tree,
            entries,
            reader,
            destination,
            expected_commit=expected_commit,
            expected_tree=expected_tree,
            expected_manifest_digest=manifest_digest,
            entrypoint=entrypoint,
            max_files=max_files,
            max_total_bytes=max_total_bytes,
        )

    def test_materializes_exact_private_tree_and_marks_entrypoint_executable(self) -> None:
        entries = [
            {
                "path": entry.path,
                "mode": entry.mode,
                "object_type": entry.object_type,
                "object_id": entry.object_id,
                "size": entry.size,
            }
            for entry in tree_entries(FILES)
        ]
        blobs = {entry["object_id"]: FILES[entry["path"]] for entry in entries}
        reads: list[str] = []

        def read_blob(object_id: str) -> bytes:
            reads.append(object_id)
            return blobs[object_id]

        with tempfile.TemporaryDirectory(prefix="private-bundle-test-") as scratch:
            destination = Path(scratch) / "scanner"
            verified = self._materialize(destination, entries, read_blob)

            self.assertEqual(verified.bundle.root, destination)
            self.assertEqual(verified.bundle.entrypoint, destination / ENTRYPOINT)
            self.assertEqual(verified.bundle.manifest_digest, _manifest_digest(full_manifest(FILES)))
            self.assertEqual((destination / ENTRYPOINT).read_bytes(), FILES[ENTRYPOINT])
            self.assertEqual((destination / "rules/default.json").read_bytes(), FILES["rules/default.json"])
            self.assertFalse((destination / ".git").exists())
            self.assertTrue((destination / ENTRYPOINT).stat().st_mode & stat.S_IXUSR)
            self.assertEqual(set(reads), {entry["object_id"] for entry in entries})

    def test_rejects_untrusted_metadata_before_reading_any_blob(self) -> None:
        baseline = tree_entries(FILES)
        cases = [
            ("wrong-commit", {"expected_commit": "c" * 40}, baseline),
            ("wrong-tree", {"expected_tree": "d" * 40}, baseline),
            ("malformed-verified-commit", {"verified_commit": "not-a-sha"}, baseline),
            ("nonregular-mode", {}, tree_entries(FILES, modes={ENTRYPOINT: "120000"})),
            ("nonblob-object", {}, tree_entries(FILES, object_types={ENTRYPOINT: "tree"})),
            ("path-escape", {}, tree_entries({"../escape": b"no"})),
            ("git-metadata", {}, tree_entries({".git/config": b"no"})),
            ("duplicate-path", {}, baseline + (baseline[0],)),
            ("ancestor-collision", {}, tree_entries({**FILES, "scripts": b"collision"})),
            ("missing-entrypoint", {"entrypoint": "scripts/missing"}, baseline),
            ("file-budget", {"max_files": 1}, baseline),
            ("byte-budget", {"max_total_bytes": len(FILES[ENTRYPOINT])}, baseline),
        ]

        for label, overrides, entries in cases:
            with self.subTest(label=label), tempfile.TemporaryDirectory(prefix="private-bundle-test-") as scratch:
                reads: list[str] = []

                def read_blob(object_id: str) -> bytes:
                    reads.append(object_id)
                    self.fail(f"{label} read untrusted blob {object_id}")

                with self.assertRaises(BoundaryError):
                    self._materialize(Path(scratch) / "scanner", entries, read_blob, **overrides)
                self.assertEqual(reads, [])

    def test_rejects_blob_content_that_does_not_match_tree_object_or_declared_size(self) -> None:
        original_entry = tree_entries(FILES)[0]
        mismatched_oid = "f" * 40
        cases = [
            (
                "tree-object",
                GitLsTreeBlob(
                    path=original_entry.path,
                    mode=original_entry.mode,
                    object_type=original_entry.object_type,
                    object_id=mismatched_oid,
                    size=original_entry.size,
                ),
                mismatched_oid,
            ),
            (
                "declared-size",
                GitLsTreeBlob(
                    path=original_entry.path,
                    mode=original_entry.mode,
                    object_type=original_entry.object_type,
                    object_id=original_entry.object_id,
                    size=original_entry.size + 1,
                ),
                original_entry.object_id,
            ),
        ]

        for label, changed_entry, expected_read in cases:
            with self.subTest(label=label), tempfile.TemporaryDirectory(prefix="private-bundle-test-") as scratch:
                entries = (changed_entry, tree_entries(FILES)[1])
                reads: list[str] = []

                def read_blob(object_id: str) -> bytes:
                    reads.append(object_id)
                    return FILES[ENTRYPOINT] if object_id == expected_read else FILES["rules/default.json"]

                with self.assertRaises(BoundaryError):
                    self._materialize(Path(scratch) / "scanner", entries, read_blob)
                self.assertIn(expected_read, reads)

    def test_rejects_missing_extra_or_self_consistent_but_unpinned_blobs(self) -> None:
        changed = {**FILES, "extra.py": b"print('extra')\n"}
        cases = [
            ("missing", tree_entries(FILES)[:1], {entry.object_id: FILES[entry.path] for entry in tree_entries(FILES)}),
            ("extra", tree_entries(changed), {entry.object_id: changed[entry.path] for entry in tree_entries(changed)}),
            (
                "untrusted-manifest-digest",
                tree_entries(FILES),
                {entry.object_id: FILES[entry.path] for entry in tree_entries(FILES)},
            ),
        ]

        for label, entries, blobs in cases:
            with self.subTest(label=label), tempfile.TemporaryDirectory(prefix="private-bundle-test-") as scratch:
                kwargs = {"expected_manifest_digest": "0" * 64} if label == "untrusted-manifest-digest" else {}
                with self.assertRaises(BoundaryError):
                    self._materialize(Path(scratch) / "scanner", entries, blobs.__getitem__, **kwargs)

    def test_rejects_relative_or_preexisting_destination_before_reading_any_blob(self) -> None:
        entries = tree_entries(FILES)
        with tempfile.TemporaryDirectory(prefix="private-bundle-test-") as scratch:
            root = Path(scratch)
            for label, destination in [("relative", Path("scanner")), ("existing", root / "scanner")]:
                with self.subTest(label=label):
                    if label == "existing":
                        destination.mkdir()
                    reads: list[str] = []

                    def read_blob(object_id: str) -> bytes:
                        reads.append(object_id)
                        self.fail(f"{label} read untrusted blob {object_id}")

                    with self.assertRaises(BoundaryError):
                        self._materialize(destination, entries, read_blob)
                    self.assertEqual(reads, [])


class PrivateSelectorTests(unittest.TestCase):
    """RED contract for the fixed private selector loaded from verified bytes."""

    def _bundle_files(self, selector_source: bytes = _SYNTHETIC_SELECTOR) -> dict[str, bytes]:
        return {
            **FILES,
            SELECTOR_MODULE: selector_source,
        }

    def _materialize_selector(
        self,
        destination: Path,
        files: dict[str, bytes],
        *,
        entrypoint: str = ENTRYPOINT,
    ) -> tuple[VerifiedScannerBundle, dict[str, str]]:
        entries = tree_entries(files)
        blobs = {entry.object_id: files[entry.path] for entry in entries}
        manifest = full_manifest(files)
        scanner = export_verified_bundle(
            COMMIT,
            TREE,
            entries,
            blobs.__getitem__,
            destination,
            expected_commit=COMMIT,
            expected_tree=TREE,
            expected_manifest_digest=_manifest_digest(manifest),
            entrypoint=entrypoint,
            max_files=16,
            max_total_bytes=8192,
        )
        return scanner, manifest

    def _loader(self):
        loader = getattr(private_bundle, "load_verified_selector", None)
        self.assertTrue(callable(loader), "private selector loader is not implemented")
        return loader

    def _assert_sanitized(self, error: BoundaryError, detail: str) -> None:
        if detail:
            self.assertNotIn(detail, str(error))

    @contextlib.contextmanager
    def _capture_native_file_descriptors(self):
        saved_stdout = os.dup(1)
        saved_stderr = os.dup(2)
        try:
            with tempfile.TemporaryFile(mode="w+b") as stdout, tempfile.TemporaryFile(mode="w+b") as stderr:
                os.dup2(stdout.fileno(), 1)
                os.dup2(stderr.fileno(), 2)
                try:
                    yield stdout, stderr
                finally:
                    os.dup2(saved_stdout, 1)
                    os.dup2(saved_stderr, 2)
        finally:
            os.close(saved_stdout)
            os.close(saved_stderr)

    def test_discards_native_selector_output_and_restores_descriptors_after_success_or_failure(self) -> None:
        cases = (
            ("success", _NATIVE_FD_SELECTOR, False),
            ("failure", _NATIVE_FD_FAILURE_SELECTOR, True),
        )
        for label, source, fails in cases:
            with self.subTest(selector=label), tempfile.TemporaryDirectory(prefix="private-bundle-test-") as scratch:
                scanner, _manifest = self._materialize_selector(
                    Path(scratch) / "scanner", self._bundle_files(source)
                )
                with self._capture_native_file_descriptors() as (stdout, stderr):
                    selector = self._loader()(scanner)
                    if fails:
                        with self.assertRaises(BoundaryError):
                            selector(PurePosixPath("oracle/needle.focus"))
                    else:
                        self.assertTrue(selector(PurePosixPath("oracle/needle.focus")))
                    os.write(1, b"caller stdout restored")
                    os.write(2, b"caller stderr restored")
                    stdout.seek(0)
                    stderr.seek(0)
                    self.assertEqual(stdout.read(), b"caller stdout restored")
                    self.assertEqual(stderr.read(), b"caller stderr restored")

    def test_loads_exact_private_selector_without_output_or_global_state_leakage(self) -> None:
        with tempfile.TemporaryDirectory(prefix="private-bundle-test-") as scratch:
            scanner, manifest = self._materialize_selector(
                Path(scratch) / "scanner", self._bundle_files()
            )
            module_name = f"_whatsoup_private_selector_{scanner.bundle.manifest_digest}"
            public_module = types.ModuleType("test_integrity_core")
            public_module.is_test_surface = lambda path: False
            original_path = list(sys.path)
            original_environment = dict(os.environ)
            stdout = io.StringIO()
            stderr = io.StringIO()

            with mock.patch.dict(sys.modules, {"test_integrity_core": public_module}):
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    selector = self._loader()(scanner)
                    self.assertTrue(selector(PurePosixPath("oracle/needle.focus")))
                    self.assertFalse(selector(PurePosixPath("tests/needle.test.ts")))
                self.assertIs(sys.modules["test_integrity_core"], public_module)
                self.assertNotIn(module_name, sys.modules)
                self.assertEqual(sys.path, original_path)
                self.assertEqual(dict(os.environ), original_environment)

            self.assertEqual(stdout.getvalue(), "")
            self.assertEqual(stderr.getvalue(), "")
            self.assertFalse(any(scanner.bundle.root.rglob("__pycache__")))
            self.assertFalse(any(scanner.bundle.root.rglob("*.pyc")))

    def test_refuses_collision_and_wrong_entrypoint_without_replacing_existing_module(self) -> None:
        with tempfile.TemporaryDirectory(prefix="private-bundle-test-") as scratch:
            scanner, manifest = self._materialize_selector(
                Path(scratch) / "scanner", self._bundle_files()
            )
            module_name = f"_whatsoup_private_selector_{scanner.bundle.manifest_digest}"
            collision = types.ModuleType(module_name)
            with mock.patch.dict(sys.modules, {module_name: collision}):
                with self.assertRaises(BoundaryError):
                    self._loader()(scanner)
                self.assertIs(sys.modules[module_name], collision)

            wrong_entrypoint = VerifiedScannerBundle(
                bundle=TrustedScannerBundle(
                    root=scanner.bundle.root,
                    entrypoint=scanner.bundle.root / SELECTOR_MODULE,
                    manifest_digest=scanner.bundle.manifest_digest,
                ),
                manifest=scanner.manifest,
            )
            with self.assertRaises(BoundaryError):
                self._loader()(wrong_entrypoint)

    def test_revalidates_entire_bundle_and_refuses_missing_or_linked_selector_before_execution(self) -> None:
        cases = ("changed-selector", "changed-other", "missing-selector", "linked-selector")
        for label in cases:
            with self.subTest(label=label), tempfile.TemporaryDirectory(prefix="private-bundle-test-") as scratch:
                root = Path(scratch)
                files = self._bundle_files(
                    _EXECUTION_MARKER_SELECTOR if label != "missing-selector" else _SYNTHETIC_SELECTOR
                )
                if label == "missing-selector":
                    files.pop(SELECTOR_MODULE)
                scanner, manifest = self._materialize_selector(root / "scanner", files)
                selector_path = scanner.bundle.root / SELECTOR_MODULE
                marker = selector_path.with_name("unexpected-execution")
                if label == "changed-selector":
                    selector_path.write_bytes(_EXECUTION_MARKER_SELECTOR + b"\n# altered\n")
                elif label == "changed-other":
                    (scanner.bundle.root / "rules/default.json").write_text("changed", encoding="utf-8")
                elif label == "linked-selector":
                    outside = root / "outside-selector.py"
                    outside.write_bytes(_EXECUTION_MARKER_SELECTOR)
                    selector_path.unlink()
                    selector_path.symlink_to(outside)

                stdout = io.StringIO()
                stderr = io.StringIO()
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    with self.assertRaises(BoundaryError):
                        self._loader()(scanner)
                self.assertEqual(stdout.getvalue(), "")
                self.assertEqual(stderr.getvalue(), "")
                self.assertFalse(marker.exists(), f"{label} imported an unverified selector")

    def test_rejects_invalid_paths_and_sanitizes_private_import_selector_and_result_errors(self) -> None:
        cases = (
            ("import", _IMPORT_FAILURE_SELECTOR, None, "private selector import detail"),
            ("runtime", _RUNTIME_FAILURE_SELECTOR, PurePosixPath("oracle/needle.focus"), "private selector runtime detail"),
            ("non-boolean", _NON_BOOLEAN_SELECTOR, PurePosixPath("oracle/needle.focus"), ""),
            ("missing-export", b"OTHER_VALUE = True\n", None, ""),
            ("noncallable-export", b"is_test_surface = True\n", None, ""),
        )
        for label, source, path, detail in cases:
            with self.subTest(label=label), tempfile.TemporaryDirectory(prefix="private-bundle-test-") as scratch:
                scanner, manifest = self._materialize_selector(
                    Path(scratch) / "scanner", self._bundle_files(source)
                )
                stdout = io.StringIO()
                stderr = io.StringIO()
                original_path = list(sys.path)
                module_name = f"_whatsoup_private_selector_{scanner.bundle.manifest_digest}"
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    with self.assertRaises(BoundaryError) as raised:
                        selector = self._loader()(scanner)
                        if path is not None:
                            selector(path)
                self._assert_sanitized(raised.exception, detail)
                self.assertEqual(sys.path, original_path)
                self.assertNotIn(module_name, sys.modules)
                self.assertEqual(stdout.getvalue(), "")
                self.assertEqual(stderr.getvalue(), "")

        with tempfile.TemporaryDirectory(prefix="private-bundle-test-") as scratch:
            scanner, manifest = self._materialize_selector(
                Path(scratch) / "scanner", self._bundle_files()
            )
            selector = self._loader()(scanner)
            for invalid_path in ("oracle/needle.focus", PurePosixPath("/oracle/needle.focus"), PurePosixPath("../oracle/needle.focus")):
                with self.subTest(path=invalid_path):
                    with self.assertRaises(BoundaryError):
                        selector(invalid_path)


if __name__ == "__main__":
    unittest.main()
