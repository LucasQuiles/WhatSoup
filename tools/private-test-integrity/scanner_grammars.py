"""Native parser assets for the pinned Linux scanner, acquired once per trusted job.

Upstream v1.6.2 at 6bb9761028dfc3a72329d15f0f339ec7ccb56159:
https://github.com/xberg-io/tree-sitter-language-pack/releases/tag/v1.6.2
The private scanner's extension mapping and doctor use exactly these seven parsers.
The caller owns the cache and excludes concurrent writers; this is provenance
verification, not filesystem or network isolation.
"""

import hashlib
from pathlib import Path
import stat
import subprocess
import sys


ARCHIVE_SIZE = 19_134_009
ARCHIVE_SHA256 = "5b5a4d2d5319b7d2fae6c7a87e8bf8618c6c827842dba7641a93693980e6b5ea"
GRAMMARS = {
    "rust": (1136552, "5541d5007209312899af87b439ed8e6431e67d4b5ef0ec0b6a3405df49a97f06"),
    "go": (237992, "597d6c0839e3894536e2736be93a0c8e95ab155a831ad0bce7dc8685e3a27ed4"),
    "python": (484464, "f1f5c1c2666125c745cc03da157b5a1ce2e98c4720bcdfdfe2946f6af90645ee"),
    "bash": (1352384, "20755ddb8b30ab077943c089e2f78dea2dccaed3b5d662efc632a87af5ecc3bf"),
    "javascript": (435688, "66b5e3b955e2441bf5761bfba88a06e929440248738e3bc38a713e64df3743e8"),
    "typescript": (1439376, "41ec0b9435857a746d45454a5fe5683714c1e51f09907d918e5b85f5e0a45f03"),
    "tsx": (1472168, "bc1a3cb9402c3c2ce1c3d42240bc728fb9e3a5a30ad70df5b5058745d17fa977"),
}
LIBRARIES = Path("tree-sitter-language-pack/v1.6.2/libs")


def _verify_file(path: Path, size: int, digest: str) -> None:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size != size or path.resolve(strict=True) != path:
        raise ValueError("grammar asset is not the pinned regular file")
    with path.open("rb") as source:
        content = source.read(size + 1)
    if len(content) != size or hashlib.sha256(content).hexdigest() != digest:
        raise ValueError("grammar asset digest differs")


def verify_grammar_cache(cache: Path) -> None:
    if not cache.is_absolute() or cache.resolve(strict=True) != cache or not cache.is_dir():
        raise ValueError("grammar cache must be canonical and owned by the caller")
    libraries = cache / LIBRARIES
    expected = {f"libtree_sitter_{name}.so" for name in GRAMMARS}
    if libraries.resolve(strict=True) != libraries or {p.name for p in libraries.iterdir()} != expected:
        raise ValueError("grammar cache coverage differs")
    for name, (size, digest) in GRAMMARS.items():
        _verify_file(libraries / f"libtree_sitter_{name}.so", size, digest)


def prepare_grammar_cache(archive: Path, cache: Path) -> None:
    # Authenticate the entire archive before tar interprets any member metadata.
    _verify_file(archive, ARCHIVE_SIZE, ARCHIVE_SHA256)
    if not cache.is_absolute() or cache.parent.resolve(strict=True) != cache.parent:
        raise ValueError("grammar cache parent is not canonical")
    cache.mkdir(mode=0o700)
    libraries = cache / LIBRARIES
    libraries.mkdir(mode=0o700, parents=True)
    subprocess.run(
        ["/usr/bin/tar", "-xf", str(archive), "-C", str(libraries),
         *(f"./libtree_sitter_{name}.so" for name in GRAMMARS)],
        check=True, timeout=30, stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
    )
    verify_grammar_cache(cache)
    for path in libraries.iterdir():
        path.chmod(0o400)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("expected pinned archive and new cache paths")
    prepare_grammar_cache(Path(sys.argv[1]), Path(sys.argv[2]))
