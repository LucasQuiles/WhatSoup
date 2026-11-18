"""What the main-as-oracle redaction suites share (owner ruling R78). Not a test file.

The rule: for every input, every secret that main's code hides on a path stays
hidden on the same path in this tree. The suites are
test_bot_errors_redaction_main_oracle.py (at rest, the read side, a raw read
and structured values) and test_bot_errors_redaction_main_oracle_card.py (the
public card helper and the whole delivered card);
tests/redaction-main-oracle.test.ts applies the rule to the TypeScript
redactor, logger and protected-message paths.

The floor is computed when the suites run, from main's own files: each one is
read out of this repository's object store by git blob id, checked against
that id and executed under its own module name. Nothing about main is frozen
into a fixture, so the floor cannot drift from main. A clone without main's
history, a timeout or a load failure is INCONCLUSIVE, never a skip and never a
redaction finding.

Inputs: tests/fixtures/redaction-main-oracle-cases.json, pinned by its sha256
(the five shapes the B7 final reviews reproduced, named siblings, the one
accepted residual, the key-word vocabulary and the fuzz grammar), and the two
redaction parity corpora, read at fixed blob ids.

Exposure, not only exact occurrence: each tracked secret is counted on several
measures (exact, case-folded, without whitespace, percent-decoded, letters and
digits only, and each fragment of at least max(6, half its length)
characters). This tree may show it no more often than main does on any of
them, so a redactor that splits, re-encodes, re-cases or partly masks a secret
that main hides fails.
"""
from __future__ import annotations

import builtins
import hashlib
import json
import re
import signal
import subprocess
import sys
import threading
import time
import types
import unicodedata
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator

INCONCLUSIVE = "INCONCLUSIVE:"


class OracleInconclusive(AssertionError):
    """The oracle could not decide: missing history, a timeout, a load failure or changed inputs."""


def inconclusive(reason: str) -> OracleInconclusive:
    """The error for an oracle infrastructure failure; its message says it is not a redaction finding."""
    return OracleInconclusive(
        f"{INCONCLUSIVE} {reason}. This is an oracle infrastructure failure, not a redaction finding."
    )


def inconclusive_reason(reason: str) -> str:
    """inconclusive()'s message, for an assert whose failure must still read as INCONCLUSIVE."""
    return str(inconclusive(reason))


SCRIPTS = Path(__file__).resolve().parents[1]
REPO_ROOT = SCRIPTS.parent.parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

try:
    import lib.bot_errors_redaction as head  # noqa: E402
except Exception as error:  # noqa: BLE001 - without this tree's redactor the oracle cannot judge anything
    raise inconclusive(
        f"this tree's lib.bot_errors_redaction does not import ({type(error).__name__}: {error})"
    ) from error

# The oracle: main at ad3b0f9ae76e (its redactor is the same blob as at
# 928ce7f0, the main that B7 merged). Every file of main that the Python suites
# execute, by path at MAIN_COMMIT; the identity tests check each id against
# main's tree and every load checks the bytes against the id.
MAIN_COMMIT = "ad3b0f9ae76e328a66246d3e02494c37954ccd3d"
MAIN_REDACTOR_BLOB = "5ad42abcfea90858689eb21426a8881a4c2ca1e5"
MAIN_DISPATCHER_BLOB = "59231fda9b739e6b387fad3ed31c894a4576005c"
MAIN_BLOBS: dict[str, str] = {
    "deploy/scripts/lib/bot_errors_redaction.py": MAIN_REDACTOR_BLOB,
    "deploy/scripts/bot-errors-dispatcher.py": MAIN_DISPATCHER_BLOB,
    # The lib modules main's dispatcher imports, directly or through each other.
    "deploy/scripts/lib/__init__.py": "50df3dd167d8dc6626a9e7f5889fcfd1add936c5",
    "deploy/scripts/lib/bot_errors_daily_health.py": "65f8c70ca737a4ef751f227b28cbeeb5370f8910",
    "deploy/scripts/lib/bot_errors_envelope.py": "e39d83ae792bffb60d1283021ac15a49cf5c12da",
    "deploy/scripts/lib/bot_errors_roster.py": "e921fc3040c60656d3ab3781834c7e783ddd85d8",
    "deploy/scripts/lib/bounded_jsonl.py": "faef0f5fd1bf8df9d66bb410fbfc28e8b5c84ed5",
    "deploy/scripts/lib/controller_log.py": "3909deb36834b1b2788cc0ea9735ec6208660805",
    "deploy/scripts/lib/controller_state.py": "758ec2069fb3b2333042ef4bb576b142bda4e3f6",
    # The id stands on a line of its own: the secret scan's generic-api-key
    # rule reads a key word in a name followed by a quoted hex id as a secret.
    "deploy/scripts/lib/credential_repage.py": (
        "1699e6ad50eac93a7491013cb834c1ecb60b81fc"
    ),
    "deploy/scripts/lib/durable_json.py": "ca58b26245e0f50bd80bfd53dddc57de6f9a88c5",
    "deploy/scripts/lib/fleet_config.py": "7a7e30ca5c8290da4c23614ac802fc4c1e1be2c4",
    "deploy/scripts/lib/owner_route.py": "9498e478e1a93071125cb3ebff2cb30dc5165d8f",
    "deploy/scripts/lib/send_acceptance.py": "9525d80ac3011d837c86018c9345f40af67e71f3",
    "deploy/scripts/lib/state_files.py": "39d6f7723d365fe9e576a820e6030d69abc5f22e",
    "deploy/scripts/lib/state_root.py": "6ef58cc48ae510d44360d395584fe02ad743945a",
}
# The parity corpora, read at these blob ids rather than from the tree.
PARITY_BLOBS: dict[str, str] = {
    # The same blob on main and on this branch.
    "redaction-parity-corpus.jsonl": "658600445524e3562ff076f85b76254b756f2cae",
    # This branch's blob: main has no authorization corpus.
    "redaction-parity-corpus-authorization.jsonl": "ee634e44ab01f03bac0c72e841d634da2e4af7dd",
}
# What a fixer must not change. CASES_SHA256 pins the whole cases fixture; the
# lines after it name what it holds, so a mismatch says which part moved.
CASES_FILE = "redaction-main-oracle-cases.json"
CASES_SHA256 = "6de0f22837a0086c1688e55819c99a1e42f782be7a6ba8cba4c9d88098c36446"
SHAPE_IDS = (
    "B1-overlapping-keyed-values",
    "B2-chained-key-space-before-value",
    "F1-bearer-plus-link",
    "F2-key-in-value",
    "F3-quote-closes-at-later-key",
)
NAMED_IDS = (
    # A line break after an id holding a key word keeps the secret scan's
    # generic-api-key rule from reading it and the next id as an assignment.
    "B1-overlap-bearer", "B1-overlap-password",
    "B2-chained-key-plain",
    "B2-chained-key-tab",
    "F1-bearer-comma-slash-link", "F1-bearer-dot-link", "F1-bearer-eq-link", "F1-bearer-plus-www",
    "F1-bearer-slash-bare", "F1-bearer-slash-link", "F1-bearer-space-link", "F1-bearer-tilde-link",
    "F1-bearer-underscore-link", "F1-token-plus-link", "F2-dash-pat", "F2-dash-secret-space",
    "F2-dot-session-eq", "F2-dot-token", "F2-json-dash-api-key", "F2-link-comma-api-key",
    "F2-link-quoted-pat", "F2-proxy-authorization", "F2-single-dot-password", "F2-underscore-session",
    "F2-underscore-token-eq", "F2b-card-after-link", "F3-no-final-quote", "F3-single-quotes",
    "F3-unquoted-later-value", "N-auth-after-fragment-crlf-bearer", "N-auth-whole-line-two-links",
    "N-basic-after-fragment", "N-bearer-after-fragment-tab", "N-bearer-amp-http-link",
    "N-block-after-fragment", "N-block-end-glued-key", "N-block-then-auth", "N-chain-colon-colon",
    "N-chain-eq-eq", "N-chain-hyphen-key-value", "N-chain-link2-key", "N-chain-quoted",
    "N-chain-triple-quoted", "N-chain-two-secrets", "N-cookie-holds-link", "N-crlf-fold-auth",
    "N-glued-key-in-fragment-middle", "N-json-url-then-token", "N-key-after-fragment-crlf",
    "N-key-then-block-after-fragment", "N-phone-after-fragment", "N-quoted-value-holds-link",
    "N-value-ends-in-link2-quote",
)
RESIDUAL_ID = "accepted-residual-unknown-first-word"
RESIDUAL_TEMPLATE = "'token': &Bearer {B64}"
# The only exclusion (owner ruling, lane LEDGER.md:2223): at rest, the value
# after an unknown first word that follows a secret key is accepted. The paths
# derived from the stored text skip that one case; every other path compares
# it with main, and the card suite asserts it absolutely.
RESIDUAL_EXCLUDED_PATHS = ("at_rest", "read", "json")
# The seeded fuzz set: a Lehmer generator (multiplier 48271, modulus 2**31 - 1),
# one draw for the family and one per slot. The TypeScript suite draws the same
# templates with the same seed and size.
FUZZ_SEED = 20261116
FUZZ_SIZE = 4000
GIT_TIMEOUT_SECONDS = 60
# An aggregate loop stops itself at AGGREGATE_SECONDS; TEST_SECONDS is the
# alarm for a test that hangs inside one call.
AGGREGATE_SECONDS = 240
TEST_SECONDS = 300
CREDENTIAL_PATH_MARKER = "[REDACTED CREDENTIAL PATH]"
FIXTURES = REPO_ROOT / "tests" / "fixtures"


def _read_cases() -> tuple[bytes, dict[str, Any]]:
    try:
        data = (FIXTURES / CASES_FILE).read_bytes()
        return data, json.loads(data.decode("utf-8"))
    except (OSError, ValueError) as error:
        raise inconclusive(f"{CASES_FILE} is not readable JSON ({type(error).__name__}: {error})") from error


CASES_BYTES, CASES = _read_cases()


def pinned_input_problems() -> list[str]:
    """Each way the oracle's inputs differ from the pinned ones; empty when they are the pinned inputs."""
    problems = []
    digest = hashlib.sha256(CASES_BYTES).hexdigest()
    if digest != CASES_SHA256:
        problems.append(f"{CASES_FILE} has sha256 {digest}, not the pinned {CASES_SHA256}")
    try:
        if tuple(case["id"] for case in CASES["shapes"]) != SHAPE_IDS:
            problems.append("the reproduced shapes differ from the pinned ids")
        if tuple(sorted(case["id"] for case in CASES["named"])) != NAMED_IDS:
            problems.append("the named case ids differ from the pinned list")
        residual = CASES["acceptedResidual"]
        if (residual["id"], residual["template"]) != (RESIDUAL_ID, RESIDUAL_TEMPLATE):
            problems.append("the accepted residual's id or template differs from the pinned one")
        if tuple(residual["excludedPaths"]) != RESIDUAL_EXCLUDED_PATHS:
            problems.append("the accepted residual's excluded paths differ from the pinned ones")
        if tuple(CASES["parityCorpora"]) != tuple(PARITY_BLOBS):
            problems.append("the parity corpora differ from the pinned ones")
    except (KeyError, TypeError) as error:
        problems.append(f"the cases fixture lacks a pinned field ({type(error).__name__}: {error})")
    return problems


if pinned_input_problems():
    raise inconclusive("the oracle's inputs are not the pinned ones: " + "; ".join(pinned_input_problems()))


def _git(*args: str) -> bytes:
    command = " ".join(args)
    try:
        result = subprocess.run(
            ["git", "-C", str(REPO_ROOT), *args], capture_output=True, check=False, timeout=GIT_TIMEOUT_SECONDS
        )
    except subprocess.TimeoutExpired as error:
        raise inconclusive(f"git {command} did not finish within {GIT_TIMEOUT_SECONDS} s") from error
    except OSError as error:
        raise inconclusive(f"git could not run ({error})") from error
    if result.returncode != 0:
        raise inconclusive(
            f"git {command} failed; the oracle needs main's history in this clone: "
            + result.stderr.decode("utf-8", "replace").strip()
        )
    return result.stdout


def git_blob(blob_id: str) -> bytes:
    """One file read from this repository's object store and checked against its blob id."""
    data = _git("cat-file", "blob", blob_id)
    actual = hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()
    if actual != blob_id:
        raise inconclusive(f"git returned blob {actual} for {blob_id}")
    return data


def main_tree_blob(path: str) -> str:
    """The blob id that `path` has in main's tree at MAIN_COMMIT."""
    return _git("rev-parse", f"{MAIN_COMMIT}:{path}").decode("ascii", "replace").strip()


# ── main's code, executed from its blobs ────────────────────────────────────
# Each file runs under its own module name with an __import__ that serves every
# lib.* import from main's pinned blobs, so main's dispatcher runs main's
# envelope, roster and redactor, never this tree's. Main's redactor is the one
# module object the suites call `main`, so the test pins set on it reach the
# dispatcher too. Every other import is the usual one.
_REAL_IMPORT = builtins.__import__
_MAIN_PACKAGE = "main_oracle_lib"
_MAIN_REDACTOR = "main_oracle_bot_errors_redaction"
_MAIN_DISPATCHER = "main_oracle_bot_errors_dispatcher"
LOADED_MAIN_BLOBS: dict[str, str] = {}


def _main_import(name: str, globals: Any = None, locals: Any = None, fromlist: Any = (), level: int = 0) -> Any:
    if level:
        if level != 1 or not isinstance(globals, dict) or globals.get("__package__") != _MAIN_PACKAGE:
            raise inconclusive(f"main's code makes a relative import of {name!r} that the oracle does not serve")
        name = f"lib.{name}" if name else "lib"
    if name != "lib" and not name.startswith("lib."):
        return _REAL_IMPORT(name, globals, locals, fromlist, 0)
    package = _main_package()
    if name == "lib":
        for item in fromlist or ():
            if item != "*" and not isinstance(getattr(package, item, None), types.ModuleType):
                _main_lib_module(item)
        return package
    module = _main_lib_module(name[len("lib."):])
    return module if fromlist else package


_MAIN_BUILTINS = {**vars(builtins), "__import__": _main_import}


def _exec_main_file(name: str, path: str, *, package: bool = False) -> types.ModuleType:
    """Execute one of main's files from its pinned blob as module `name`."""
    blob = MAIN_BLOBS.get(path)
    if blob is None:
        raise inconclusive(f"main's code imports {path}, which has no pinned blob")
    real = REPO_ROOT / path
    module = types.ModuleType(name)
    # Beside the real file, so code that finds its sibling files through
    # __file__ still finds them; the name says which blob ran.
    module.__file__ = str(real.with_name(f"main-oracle-git-blob-{blob}-{real.name}"))
    module.__dict__["__builtins__"] = _MAIN_BUILTINS
    if package:
        module.__path__ = []  # type: ignore[attr-defined]
        module.__package__ = name
    else:
        module.__package__ = name.rpartition(".")[0]
    source = git_blob(blob).decode("utf-8")
    # Registered first: a dataclass resolves its module through sys.modules,
    # and an import cycle finds the module it is still executing.
    sys.modules[name] = module
    parent, _, short = name.rpartition(".")
    if parent:
        setattr(sys.modules[parent], short, module)
    try:
        exec(compile(source, module.__file__, "exec"), module.__dict__)  # noqa: S102
    except OracleInconclusive:
        sys.modules.pop(name, None)
        raise
    except Exception as error:  # noqa: BLE001 - a main file that does not run leaves no floor
        sys.modules.pop(name, None)
        raise inconclusive(f"main's {path} (blob {blob}) did not execute ({type(error).__name__}: {error})") from error
    LOADED_MAIN_BLOBS[path] = blob
    return module


def _main_package() -> types.ModuleType:
    package = sys.modules.get(_MAIN_PACKAGE)
    if package is None:
        package = _exec_main_file(_MAIN_PACKAGE, "deploy/scripts/lib/__init__.py", package=True)
    return package


def _main_lib_module(short: str) -> types.ModuleType:
    if short == "bot_errors_redaction":
        setattr(_main_package(), short, main)
        return main
    module = sys.modules.get(f"{_MAIN_PACKAGE}.{short}")
    if module is None:
        module = _exec_main_file(f"{_MAIN_PACKAGE}.{short}", f"deploy/scripts/lib/{short}.py")
    return module


main = sys.modules.get(_MAIN_REDACTOR) or _exec_main_file(_MAIN_REDACTOR, "deploy/scripts/lib/bot_errors_redaction.py")


def main_dispatcher() -> types.ModuleType:
    """main's bot-errors-dispatcher.py, executed from its blob; every lib module it imports is main's too."""
    module = sys.modules.get(_MAIN_DISPATCHER)
    if module is None:
        module = _exec_main_file(_MAIN_DISPATCHER, "deploy/scripts/bot-errors-dispatcher.py")
    return module


def from_main(label: str, call: Callable[[], str]) -> str:
    """A floor from main's code; an error inside main's code leaves the oracle unable to judge."""
    try:
        return call()
    except OracleInconclusive:
        raise
    except Exception as error:  # noqa: BLE001
        raise inconclusive(f"main's code raised on {label} ({type(error).__name__}: {error})") from error


# The reserved .test hosts stand in for the production pins, which name no
# test host; the same hosts the TypeScript helper pins. A frozenset, so neither
# module can change the other's.
TEST_PINS = frozenset(hashlib.sha256(host.encode("utf-8")).hexdigest() for host in CASES["linkHosts"])


def use_test_pins(monkeypatch: Any) -> None:
    """Pin the .test hosts on both redactors and keep the default credential-path marker."""
    monkeypatch.delenv("BOT_ERRORS_SAFE_SHAPE_CRED_PATH", raising=False)
    monkeypatch.setattr(head, "PROTECTED_LINK_HOST_SHA256", TEST_PINS)
    monkeypatch.setattr(main, "PROTECTED_LINK_HOST_SHA256", TEST_PINS)


# ── time bounds ─────────────────────────────────────────────────────────────


class Deadline:
    """A cooperative time budget for an aggregate loop; running out is INCONCLUSIVE."""

    def __init__(self, label: str, seconds: float = AGGREGATE_SECONDS) -> None:
        self.label = label
        self.seconds = seconds
        self.end = time.monotonic() + seconds

    def check(self, done: int, total: int) -> None:
        if time.monotonic() > self.end:
            raise inconclusive(f"{self.label} ran out of its {self.seconds:g} s budget after {done} of {total} rows")


@contextmanager
def alarm(label: str, seconds: float = TEST_SECONDS) -> Iterator[None]:
    """Stop a test that hangs inside one call (a regex scan checks for signals); INCONCLUSIVE, not RED."""
    usable = (
        hasattr(signal, "setitimer")
        and threading.current_thread() is threading.main_thread()
        and signal.getitimer(signal.ITIMER_REAL)[0] == 0
    )
    if not usable:
        yield
        return

    def stop(_signum: int, _frame: Any) -> None:
        raise inconclusive(f"{label} did not finish within {seconds:g} s")

    previous = signal.signal(signal.SIGALRM, stop)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous if previous is not None else signal.SIG_DFL)


# ── inputs ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Row:
    id: str
    family: str
    text: str
    # A template row's canaries, or a parity row's declared secrets.
    declared: tuple[str, ...]
    # A parity row also tracks the input tokens that main's output lacks.
    inferred: bool = False


_CANARIES = {name: "".join(parts) for name, parts in CASES["canaries"].items()}
_VALUES = {**_CANARIES, **{name: "".join(parts) for name, parts in CASES["armour"].items()}}
_PLACEHOLDER = re.compile(r"\{(" + "|".join(map(re.escape, _VALUES)) + r")\}")


def template_row(row_id: str, family: str, template: str) -> Row:
    """A template expanded with the canaries; its secrets are the canaries it holds."""
    text = _PLACEHOLDER.sub(lambda match: _VALUES[match.group(1)], template)
    secrets = tuple(value for name, value in _CANARIES.items() if "{" + name + "}" in template)
    return Row(row_id, family, text, secrets)


def _fuzz_rows() -> list[Row]:
    grammar = CASES["fuzz"]
    state = FUZZ_SEED

    def draw(count: int) -> int:
        nonlocal state
        state = state * 48271 % 2147483647
        return state % count

    weighted = [family for family in grammar["families"] for _ in range(family["weight"])]
    seen: set[str] = set()
    rows = []
    for index in range(FUZZ_SIZE):
        family = weighted[draw(len(weighted))]
        parts = []
        for slot in family["slots"]:
            options = slot if isinstance(slot, list) else grammar["slots"][slot]
            parts.append(options[draw(len(options))])
        template = "".join(parts)
        if template not in seen:
            seen.add(template)
            rows.append(template_row(f"fuzz-{index}", f"fuzz:{family['name']}", template))
    return rows


def _parity_rows() -> list[Row]:
    declared = CASES["declaredSecrets"]
    rows, seen = [], set()
    for name, blob in PARITY_BLOBS.items():
        for line in git_blob(blob).decode("utf-8").splitlines():
            if not line.strip():
                continue
            source = json.loads(line)
            text = source["input"]
            # A row that supersedes another holds the same input; it is judged once.
            if text in seen:
                continue
            seen.add(text)
            row_id = f"parity:{name}:{source['id']}"
            rows.append(Row(row_id, "parity", text, tuple(declared.get(row_id, ())), inferred=True))
    return rows


SHAPES = [template_row(case["id"], "shape", case["template"]) for case in CASES["shapes"]]
NAMED = [template_row(case["id"], "named", case["template"]) for case in CASES["named"]]
RESIDUAL = template_row(CASES["acceptedResidual"]["id"], "residual", CASES["acceptedResidual"]["template"])
LIVENESS = template_row(CASES["liveness"]["id"], "liveness", CASES["liveness"]["template"])
FUZZ = _fuzz_rows()
PARITY = _parity_rows()
CANARY_VALUES = tuple(_CANARIES.values())


# ── tracked secrets ─────────────────────────────────────────────────────────

_TOKEN = re.compile(r"[A-Za-z0-9._~+/%-]+")
_TOKEN_EDGE = "._~+/%-"
_KEY_PART_SPLIT = re.compile(r"[-_.]+|(?<=[a-z])(?=[A-Z])")
KEY_WORDS = frozenset(word.lower() for word in CASES["keyWords"])
MIN_TOKEN = 4


def input_tokens(text: str) -> list[tuple[int, int, str]]:
    """(start, end, token) for each token of 4 or more characters, edge punctuation trimmed."""
    tokens = []
    for match in _TOKEN.finditer(text):
        raw = match.group(0)
        token = raw.strip(_TOKEN_EDGE)
        if len(token) >= MIN_TOKEN:
            start = match.start() + len(raw) - len(raw.lstrip(_TOKEN_EDGE))
            tokens.append((start, start + len(token), token))
    return tokens


def is_key_word(token: str) -> bool:
    """A key or scheme word in any case and separator spelling (api_key, Proxy-Authorization, sessionToken)."""
    parts = [part.lower() for part in _KEY_PART_SPLIT.split(token) if part]
    return bool(parts) and all(part in KEY_WORDS for part in parts)


def tracked(row: Row, floor: str) -> list[str]:
    """The row's secrets on one path.

    A template row's canaries. For a parity row also every input token that is
    not a key word and that main's output on the path (`floor`) no longer
    contains, so a key word main swallows and a value main keeps are never
    secrets. Declared secrets only add.
    """
    secrets = list(row.declared)
    if row.inferred:
        for _start, _end, token in input_tokens(row.text):
            if token not in secrets and token not in floor and not is_key_word(token):
                secrets.append(token)
    return secrets


# ── exposure measures ───────────────────────────────────────────────────────

_WHITESPACE = re.compile(r"[\s​‌‍⁠﻿]+")
_PERCENT = re.compile(r"%([0-9A-Fa-f]{2})")
_NOT_ALNUM = re.compile(r"[^a-z0-9]+")
FRAGMENT_MIN = 6


def percent_decoded(text: str) -> str:
    """%XX sequences decoded, up to three times for text encoded more than once."""
    for _ in range(3):
        decoded = _PERCENT.sub(lambda match: chr(int(match.group(1), 16)), text)
        if decoded == text:
            break
        text = decoded
    return text


VIEWS: dict[str, Callable[[str], str]] = {
    "exact": lambda text: text,
    "folded": lambda text: text.lower(),
    "unspaced": lambda text: _WHITESPACE.sub("", text),
    "decoded": percent_decoded,
    "alnum": lambda text: _NOT_ALNUM.sub("", unicodedata.normalize("NFKC", percent_decoded(text)).lower()),
}
MEASURES = tuple(VIEWS)


@dataclass(frozen=True)
class Probe:
    measure: str
    view: str
    key: str

    @property
    def label(self) -> str:
        return self.measure if self.measure != "fragment" else f"fragment {self.key}"


def fragment_windows(secret: str) -> list[str]:
    """Each distinct substring of max(6, half its length) characters; none for a secret that short."""
    width = max(FRAGMENT_MIN, (len(secret) + 1) // 2)
    windows: list[str] = []
    for start in range(len(secret) - width + 1 if len(secret) > width else 0):
        window = secret[start:start + width]
        if window not in windows:
            windows.append(window)
    return windows


def probes(secret: str, context: str) -> list[Probe]:
    """The measures that can see `secret`.

    `context` is the input without the secret itself. A measure whose key
    already matches there (a case variant or a fragment that other input text
    also holds) cannot tell the secret from that text, so it is left out
    rather than counted against either side.
    """
    found = []
    for measure in MEASURES:
        key = VIEWS[measure](secret)
        if not key or (measure == "alnum" and len(key) < FRAGMENT_MIN):
            continue
        if key not in VIEWS[measure](context):
            found.append(Probe(measure, measure, key))
    for window in fragment_windows(secret):
        if window not in context:
            found.append(Probe("fragment", "exact", window))
    return found


def secret_context(row: Row, secret: str) -> str:
    """The row's input with the secret's own occurrences blanked: whole tokens for an inferred secret."""
    if row.inferred and secret not in row.declared:
        pieces: list[str] = []
        cursor = 0
        for start, end, token in input_tokens(row.text):
            if token == secret:
                pieces += (row.text[cursor:start], "\0")
                cursor = end
        return "".join(pieces) + row.text[cursor:]
    return row.text.replace(secret, "\0")


_PROBES: dict[tuple[str, str], tuple[Probe, ...]] = {}


def row_probes(row: Row, secret: str) -> tuple[Probe, ...]:
    key = (row.id, secret)
    cached = _PROBES.get(key)
    if cached is None:
        cached = _PROBES[key] = tuple(probes(secret, secret_context(row, secret)))
    return cached


class Views:
    """The measure views of one rendered text, each computed once."""

    __slots__ = ("_text", "_views")

    def __init__(self, text: str) -> None:
        self._text = text
        self._views: dict[str, str] = {}

    def count(self, probe: Probe) -> int:
        view = self._views.get(probe.view)
        if view is None:
            view = self._views[probe.view] = VIEWS[probe.view](self._text)
        return view.count(probe.key)


def shown_beyond_main(row: Row, floor: str, rendered: str, *, presence: bool = False, noise: str = "") -> list[str]:
    """What this tree's rendering shows of the row's secrets beyond main's output on the same path.

    Occurrence-based by default: on no measure may this tree's count exceed
    main's, so a repeated secret is checked occurrence by occurrence.
    presence=True (the whole delivered card): where main's output shows nothing
    on a measure, this tree's shows nothing either. A measure that already
    matches in `noise` (text a path adds by design, such as the card's fixed
    lines) is not counted.
    """
    floor_views, mine, noise_views = Views(floor), Views(rendered), Views(noise)
    shown = []
    for secret in tracked(row, floor):
        for probe in row_probes(row, secret):
            if noise and noise_views.count(probe):
                continue
            here, there = mine.count(probe), floor_views.count(probe)
            if (here > 0 and there == 0) if presence else here > there:
                shown.append(f"{secret} [{probe.label}] this tree {here}, main {there}")
    return shown


def shown_at_all(row: Row, rendered: str) -> list[str]:
    """Every measure on which the rendering shows one of the row's declared secrets (the residual's card check)."""
    views = Views(rendered)
    shown = []
    for secret in row.declared:
        for probe in row_probes(row, secret):
            count = views.count(probe)
            if count:
                shown.append(f"{secret} [{probe.label}] {count}")
    return shown


def failure_report(failures: list[str], path: str) -> str:
    return f"{len(failures)} rows show on {path} a secret main hides there:\n" + "\n".join(failures[:60])


# ── the Python paths ────────────────────────────────────────────────────────


def stored(module: Any, text: str) -> str:
    """The at-rest path: the stored-text redactor."""
    return module.redact_bot_errors_text(text, credential_path_marker=CREDENTIAL_PATH_MARKER)


def read_side(module: Any, text: str) -> str:
    """The read path: alert_text, the funnel every alert-content read passes through, over the stored text."""
    return module.alert_text(stored(module, text))


def raw_read(module: Any, text: str) -> str:
    """A raw or legacy record read with no storage pass in front of alert_text."""
    return module.alert_text(text)


def structured(module: Any, text: str) -> str:
    """redact_json_value over a structured event built from the input, serialized for counting."""
    event = {"summary": text, "evidence": [text, {"detail": text}], "diagnostics": {"logHints": [text]}}
    redacted = module.redact_json_value(event, lambda value: stored(module, value))
    return json.dumps(redacted, ensure_ascii=False, sort_keys=True)


PATHS: dict[str, Callable[[Any, str], str]] = {
    "at_rest": stored,
    "read": read_side,
    "raw_read": raw_read,
    "json": structured,
}


def main_display(text: str) -> str:
    """main's group-message content transform, redact(alert_text(text)): the card helper's floor."""
    return stored(main, main.alert_text(text))
