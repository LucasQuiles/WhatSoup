"""Main is the oracle (owner ruling R78): on each Python path, this tree hides every secret main hides.

Paths, each compared with main's redactor on the same path and the same input:
  at_rest   redact_bot_errors_text(raw), the stored-text redactor
  read      alert_text(stored), the funnel every alert-content read passes through;
            the group message runs the redactor once more after it, a second pass
            this suite deliberately does not count
  raw_read  alert_text(raw): a raw or legacy record read with no storage pass
  json      redact_json_value over a structured event built from the input
For each tracked secret, this tree may show it no more often than main does, on
every exposure measure (redaction_main_oracle_support.py beside this file holds
the measures, the floor, the inputs and the fuzz seed and size). The public card
is test_bot_errors_redaction_main_oracle_card.py, a separate file because the
dispatcher it loads imports names that main's redactor does not define.

A failure whose message starts with INCONCLUSIVE: is an oracle infrastructure
failure (missing history, a timeout, changed inputs, a main file that does not
load or a floor that is not live), never a redaction finding.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Iterator

import pytest


def _support():
    name = "redaction_main_oracle_support"
    if name not in sys.modules:
        try:
            spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(f"{name}.py"))
            assert spec is not None and spec.loader is not None
            module = importlib.util.module_from_spec(spec)
            sys.modules[name] = module
            spec.loader.exec_module(module)
        except Exception as error:
            sys.modules.pop(name, None)
            if str(error).startswith("INCONCLUSIVE:"):
                raise
            raise AssertionError(
                f"INCONCLUSIVE: the oracle support module did not load ({type(error).__name__}: {error}). "
                "This is an oracle infrastructure failure, not a redaction finding."
            ) from error
    return sys.modules[name]


S = _support()
PATHS = tuple(S.PATHS)
RESIDUAL_PATHS = tuple(path for path in PATHS if path not in S.RESIDUAL_EXCLUDED_PATHS)
# Paths whose main floor is the full redactor; raw_read only replaces links.
FULL_PATHS = ("at_rest", "read", "json")


def _floor(path: str, text: str) -> str:
    return S.from_main(f"the {path} path", lambda: S.PATHS[path](S.main, text))


def _shown(row, path: str) -> tuple[list[str], str]:
    rendered = S.PATHS[path](S.head, row.text)
    return S.shown_beyond_main(row, _floor(path, row.text), rendered), rendered


def _corpus_failures(rows, path: str) -> list[str]:
    deadline = S.Deadline(f"the {path} aggregate")
    failures = []
    for done, row in enumerate(rows):
        deadline.check(done, len(rows))
        shown, rendered = _shown(row, path)
        if shown:
            failures.append(f"{row.id} ({row.family}) shows {shown}: {rendered!r}")
    return failures


@pytest.fixture(autouse=True)
def _test_pins(monkeypatch: pytest.MonkeyPatch) -> None:
    S.use_test_pins(monkeypatch)


@pytest.fixture(autouse=True)
def _bounded(request: pytest.FixtureRequest) -> Iterator[None]:
    with S.alarm(request.node.nodeid):
        yield


def test_the_oracle_is_mains_code_and_its_inputs_are_pinned() -> None:
    assert S.main is not S.head
    assert S.main.__file__.endswith(f"main-oracle-git-blob-{S.MAIN_REDACTOR_BLOB}-bot_errors_redaction.py")
    assert S.LOADED_MAIN_BLOBS["deploy/scripts/lib/bot_errors_redaction.py"] == S.MAIN_REDACTOR_BLOB
    assert all(S.MAIN_BLOBS[path] == blob for path, blob in S.LOADED_MAIN_BLOBS.items())
    wrong = {path: blob for path, blob in S.MAIN_BLOBS.items() if S.main_tree_blob(path) != blob}
    if wrong:
        raise S.inconclusive(f"these pinned blob ids are not main's files at {S.MAIN_COMMIT}: {sorted(wrong)}")
    assert S.pinned_input_problems() == []
    assert (S.FUZZ_SEED, S.FUZZ_SIZE) == (20261116, 4000)
    assert tuple(row.id for row in S.SHAPES) == S.SHAPE_IDS
    assert tuple(sorted(row.id for row in S.NAMED)) == S.NAMED_IDS
    assert (S.RESIDUAL.id, S.CASES["acceptedResidual"]["template"]) == (S.RESIDUAL_ID, S.RESIDUAL_TEMPLATE)
    assert S.RESIDUAL_EXCLUDED_PATHS == ("at_rest", "read", "json")
    assert len(S.FUZZ) > 3000
    assert len(S.PARITY) > 100
    assert all(row.declared for row in [*S.SHAPES, *S.NAMED, S.RESIDUAL])
    # The residual is in no other input list, so only the paths that name it skip it.
    assert S.RESIDUAL.id not in {row.id for row in [*S.SHAPES, *S.NAMED, *S.FUZZ, *S.PARITY]}


@pytest.mark.parametrize("row", S.SHAPES, ids=lambda row: row.id)
def test_main_hides_each_reproduced_shape_at_rest(row) -> None:
    """The floor is live: main's redactor hides the credential of each reproduced shape."""
    stored = _floor("at_rest", row.text)
    shown = [secret for secret in row.declared if secret in stored]
    assert not shown, S.inconclusive_reason(f"main's redactor no longer hides {row.id} at rest: {stored!r}")


@pytest.mark.parametrize("path", ("read", "raw_read"))
def test_main_replaces_a_protected_link_on_its_read_paths(path: str) -> None:
    """The read floors are live: main's alert_text replaces a pinned link, so its fragment is hidden."""
    rendered = _floor(path, S.LIVENESS.text)
    assert not S.shown_at_all(S.LIVENESS, rendered), S.inconclusive_reason(
        f"main's {path} floor no longer replaces a pinned protected link: {rendered!r}"
    )


def test_the_key_word_vocabulary() -> None:
    """Key and scheme words in any case and separator spelling are never tracked; values are."""
    assert [word for word in S.CASES["keyWordSamples"] if not S.is_key_word(word)] == []
    assert [word for word in [*S.CASES["valueSamples"], *S.CANARY_VALUES] if S.is_key_word(word)] == []
    assert [token for _start, _end, token in S.input_tokens("token: password: x")] == ["token", "password"]
    assert S.tracked(S.Row("vocabulary", "check", "token: password: refused", (), inferred=True), "token: [x]") == [
        "refused"
    ]


def test_a_value_main_keeps_is_never_tracked() -> None:
    """A benign value that main leaves in place, such as a build number, is not a secret on any path."""
    row = next((row for row in S.PARITY if row.id.endswith(":make-version-not-phone")), None)
    if row is None:
        raise S.inconclusive("the build-number parity row is missing")
    if row.text not in _floor("at_rest", row.text):
        raise S.inconclusive("main's redactor no longer keeps the build-number row unchanged")
    for path in PATHS:
        floor = _floor(path, row.text)
        # json serializes the structured event, so its floor holds the text
        # rather than equalling it; a floor that rewrites the row says nothing
        # about kept values.
        if row.text in floor:
            assert S.tracked(row, floor) == [], path


@pytest.mark.parametrize("path", PATHS)
def test_parity_rows_track_secrets_on_every_path(path: str) -> None:
    """The parity corpora still hold secrets that main hides on each path."""
    rows = [row for row in S.PARITY if S.tracked(row, _floor(path, row.text))]
    assert len(rows) > (20 if path in FULL_PATHS else 3), S.inconclusive_reason(
        f"only {len(rows)} parity rows hold a secret that main hides on {path}"
    )


def test_declared_secrets_belong_to_their_rows() -> None:
    by_id = {row.id: row for row in S.PARITY}
    for row_id, secrets in S.CASES["declaredSecrets"].items():
        assert row_id in by_id, row_id
        assert all(secret in by_id[row_id].text for secret in secrets), row_id


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("row", S.SHAPES, ids=lambda row: row.id)
def test_reproduced_shape_hides_what_main_hides(row, path: str) -> None:
    shown, rendered = _shown(row, path)
    assert not shown, f"{row.id} shows on {path} {shown} where main hides it: {rendered!r}"


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("row", S.NAMED, ids=lambda row: row.id)
def test_named_case_hides_what_main_hides(row, path: str) -> None:
    shown, rendered = _shown(row, path)
    assert not shown, f"{row.id} shows on {path} {shown} where main hides it: {rendered!r}"


@pytest.mark.parametrize("path", RESIDUAL_PATHS)
def test_the_accepted_residual_hides_what_main_hides_off_the_stored_paths(path: str) -> None:
    """The residual is accepted only on the paths derived from the stored text; elsewhere main is its floor."""
    shown, rendered = _shown(S.RESIDUAL, path)
    assert not shown, f"{S.RESIDUAL.id} shows on {path} {shown} where main hides it: {rendered!r}"


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("corpus", ("fuzz", "parity"))
def test_corpus_hides_what_main_hides(corpus: str, path: str) -> None:
    failures = _corpus_failures(S.FUZZ if corpus == "fuzz" else S.PARITY, path)
    assert not failures, S.failure_report(failures, path)
