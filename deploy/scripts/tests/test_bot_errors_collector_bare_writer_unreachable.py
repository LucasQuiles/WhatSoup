"""Pin the collector's bare primary-state writer as unreachable.

Background (#3053/#3054 follow-up). ``bot-errors-dispatcher.py`` carried 14
``save_incident_state`` call sites, 13 gated behind ``if incident:
incident.commit()``. The one ungated branch bare-wrote the primary over an
adopted store, destroyed the ``_controllerState`` envelope, and crash-looped the
service on exit 78 -- twice, 24 hours apart.

``bot-errors-collector.py`` owns a structurally identical bare writer,
``save_state`` (:1621): it calls ``publish_state_json`` directly rather than
going through a controller-state session, so post-adoption it would overwrite
the envelope exactly the way the dispatcher's branch did.

**It is currently dead code.** An AST walk of the collector finds the definition
and *zero* references -- no call, no attribute access, no string literal for
indirect dispatch. The live write path is
``save_collector_state(session, state, capability) -> session.save(...)``, which
is inside a cycle and therefore correct. So the collector does not have the
dispatcher's defect today, and adding a runtime guard to a function nobody calls
would add surface without removing risk.

What *is* worth enforcing is the property that makes that true. This test fails
the moment anyone wires ``save_state`` back up, so the corruption path cannot be
reintroduced silently -- a reviewer is forced to route the new caller through
the session instead. That is the cheapest durable form of the fix: the guard is
the test, not more code in the writer.

If a legitimate caller is ever needed, do not simply delete this test. Give
``save_state`` the adoption guard first (``lib.controller_state`` owns the
``.initialized`` marker that marks a store adopted), then narrow the assertion
to the reviewed caller.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

_SCRIPTS = Path(__file__).resolve().parents[1]
_COLLECTOR = _SCRIPTS / "bot-errors-collector.py"

# The bare writer, and the session-routed helper that is the supported path.
_BARE_WRITER = "save_state"
_SUPPORTED_WRITER = "save_collector_state"


def _tree() -> ast.Module:
    return ast.parse(_COLLECTOR.read_text(encoding="utf-8"))


def _definitions(tree: ast.Module, name: str) -> list[int]:
    return [
        node.lineno
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == name
    ]


def _references(tree: ast.Module, name: str) -> list[tuple[str, int]]:
    """Every non-definition mention of ``name``, including indirect-dispatch shapes.

    A bare ``grep`` for the identifier cannot distinguish a call from a
    definition, and misses ``getattr(module, "save_state")`` entirely. Walking
    the AST for Name loads, attribute access, and the string literal covers
    direct calls, aliasing, and registry/dispatch-table lookups alike.
    """
    found: list[tuple[str, int]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id == name:
            if not isinstance(node.ctx, ast.Store):
                found.append(("Name", node.lineno))
        elif isinstance(node, ast.Attribute) and node.attr == name:
            found.append(("Attribute", node.lineno))
        elif isinstance(node, ast.Constant) and node.value == name:
            found.append(("StringLiteral", node.lineno))
    return found


def test_collector_source_is_parseable():
    """Coverage assertion: a parse failure must not read as 'no references'.

    Without this, a syntax error or a moved file would make every assertion
    below vacuously true -- the scope error that a positive control cannot
    catch.
    """
    assert _COLLECTOR.is_file(), f"collector not found at {_COLLECTOR}"
    tree = _tree()
    assert _definitions(tree, _BARE_WRITER) == [1621] or _definitions(
        tree, _BARE_WRITER
    ), f"{_BARE_WRITER} definition not found -- has it been renamed or removed?"


def test_bare_writer_has_no_callers_in_the_collector():
    """The corruption path stays unreachable.

    If this fails, someone has given the collector a bare primary-state write.
    Post-adoption that overwrites ``_controllerState`` and crash-loops the
    service on exit 78. Route the caller through
    ``save_collector_state(session, ...)`` instead.
    """
    tree = _tree()
    refs = _references(tree, _BARE_WRITER)
    assert refs == [], (
        f"{_BARE_WRITER} is referenced at {refs} in {_COLLECTOR.name}. It writes "
        "the primary state file directly, bypassing the controller-state "
        "session; post-adoption that destroys the _controllerState envelope "
        "(the #3053 corruption, exit 78 crash loop). Use "
        f"{_SUPPORTED_WRITER}(session, state, capability) instead."
    )


def test_the_supported_writer_is_the_one_actually_used():
    """Non-vacuity: prove the assertion above is not passing by accident.

    If neither writer were referenced -- wrong file, renamed symbols, a parse
    that silently yielded nothing -- the test above would pass while proving
    nothing. The collector must genuinely persist state through the session.
    """
    tree = _tree()
    assert _definitions(tree, _SUPPORTED_WRITER), (
        f"{_SUPPORTED_WRITER} is not defined; this test no longer describes "
        "the collector and its sibling assertion is vacuous."
    )
    assert _references(tree, _SUPPORTED_WRITER), (
        f"{_SUPPORTED_WRITER} is defined but never called -- the collector has "
        "no live state-write path, so the unreachability assertion above is "
        "vacuous rather than meaningful."
    )


def test_supported_writer_persists_through_the_session():
    """The supported path must go through ``session.save``, not a bare write.

    Pins *why* ``save_collector_state`` is safe. If its body is ever changed to
    publish directly, the unreachability test above would still pass while the
    corruption path had simply moved.
    """
    tree = _tree()
    body = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == _SUPPORTED_WRITER
    ]
    assert len(body) == 1, f"expected exactly one {_SUPPORTED_WRITER} definition"
    calls = [
        node.func.attr
        for node in ast.walk(body[0])
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
    ]
    assert "save" in calls, (
        f"{_SUPPORTED_WRITER} no longer calls session.save(...); the collector's "
        "supported write path has stopped routing through the controller-state "
        "session."
    )


@pytest.mark.parametrize("suffix", [".initialized"])
def test_adoption_marker_suffix_is_still_what_the_guard_assumes(suffix):
    """The dispatcher's guard keys on this suffix; the library owns it.

    ``lib/controller_state.py`` spells ``.initialized`` as a bare literal in
    ~11 places and exports no constant, so the dispatcher's adoption guard
    re-derives a private detail by string concatenation. If the library ever
    renames the marker, that guard fails *open* -- it would stop guarding and
    nothing else would say so. This asserts the coupling still holds, so the
    rename shows up here as a red test rather than as a silent regression.
    """
    library = _SCRIPTS / "lib" / "controller_state.py"
    assert library.is_file(), f"controller_state library not found at {library}"
    source = library.read_text(encoding="utf-8")
    assert f'"{suffix}"' in source, (
        f"controller_state.py no longer spells {suffix!r}. The adoption guard in "
        "bot-errors-dispatcher.py derives the marker path from this suffix and "
        "will silently stop guarding. Export a constant from the library and "
        "point the guard at it."
    )
