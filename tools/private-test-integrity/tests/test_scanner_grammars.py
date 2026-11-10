"""Pinned grammar provenance and refusal before native scanner execution."""

import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace

import scanner_grammars
from private_scanner_candidate import RunnerPlan, run_scanner_privately


class GrammarCacheTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=os.environ["TMPDIR"])
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.cache = self.root / "cache"
        self.libs = self.cache / "tree-sitter-language-pack/v1.6.2/libs"
        self.libs.mkdir(parents=True)
        self.contents = {name: (name + " fixture").encode() for name in
                         ("python", "javascript", "typescript", "tsx", "bash", "go", "rust")}
        pins = {name: (len(value), hashlib.sha256(value).hexdigest()) for name, value in self.contents.items()}
        for name, content in self.contents.items():
            (self.libs / f"libtree_sitter_{name}.so").write_bytes(content)
        patch = mock.patch.object(scanner_grammars, "GRAMMARS", pins)
        patch.start()
        self.addCleanup(patch.stop)

    def test_accepts_complete_cache_without_mutating_it(self):
        self.assertIsNone(scanner_grammars.verify_grammar_cache(self.cache))
        self.assertEqual({p.name: p.read_bytes() for p in self.libs.iterdir()},
                         {f"libtree_sitter_{name}.so": value for name, value in self.contents.items()})

    def test_refuses_missing_changed_extra_and_linked_native_code(self):
        target = self.libs / "libtree_sitter_python.so"
        original = target.read_bytes()
        for fault in ("missing", "same-size-corruption", "oversize", "extra", "symlink"):
            with self.subTest(fault=fault):
                extra = self.libs / "libtree_sitter_unknown.so"
                if fault == "missing": target.unlink()
                elif fault == "same-size-corruption": target.write_bytes(b"x" * len(original))
                elif fault == "oversize": target.write_bytes(original + b"x")
                elif fault == "extra": extra.write_bytes(b"untrusted native code")
                else:
                    target.unlink()
                    outside = self.root / "outside.so"
                    outside.write_bytes(original)
                    target.symlink_to(outside)
                with self.assertRaises(ValueError):
                    scanner_grammars.verify_grammar_cache(self.cache)
                if target.exists() or target.is_symlink(): target.unlink()
                target.write_bytes(original)
                if extra.exists(): extra.unlink()

    def test_refuses_cache_root_alias(self):
        alias = self.root / "alias"
        alias.symlink_to(self.cache, target_is_directory=True)
        with self.assertRaises(ValueError):
            scanner_grammars.verify_grammar_cache(alias)

    def test_corrupt_cache_never_starts_scanner_or_download_fallback(self):
        plan = RunnerPlan(command=("/trusted/scanner",), environment={"XDG_CACHE_HOME": str(self.cache)},
                          cwd=self.root, check_name="private integrity", head_sha="a" * 40)
        child = mock.Mock(return_value=SimpleNamespace(pid=123, wait=mock.Mock(return_value=0)))
        with mock.patch.dict(os.environ, {"TMPDIR": str(self.root)}):
            positive = run_scanner_privately(plan, timeout_seconds=5, popen=child,
                                            killpg=mock.Mock(side_effect=ProcessLookupError))
            self.assertEqual(positive, {"check_name": "private integrity", "head_sha": "a" * 40,
                                        "conclusion": "pass"})
            child.assert_called_once()
            child.reset_mock()
            child.side_effect = AssertionError("native execution is forbidden")
            (self.libs / "libtree_sitter_python.so").write_bytes(b"tampered")
            result = run_scanner_privately(plan, timeout_seconds=5, popen=child)
        self.assertEqual(result, {"check_name": "private integrity", "head_sha": "a" * 40,
                                  "conclusion": "inconclusive"})
        child.assert_not_called()

    def test_unverified_archive_never_reaches_extractor(self):
        archive = self.root / "parsers.tar.zst"
        for size in (1, 32):
            with self.subTest(size=size):
                archive.write_bytes(b"x" * size)
                with (
                    mock.patch.object(scanner_grammars, "ARCHIVE_SIZE", 32),
                    mock.patch.object(scanner_grammars.subprocess, "run") as extract,
                ):
                    with self.assertRaises(ValueError):
                        scanner_grammars.prepare_grammar_cache(archive, self.root / "new-cache")
                extract.assert_not_called()
                self.assertFalse((self.root / "new-cache").exists())
