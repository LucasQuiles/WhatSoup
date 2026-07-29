#!/usr/bin/env python3
"""Fail-closed AST guard for BOT ERRORS durable JSON publishers."""

from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path
import sys
from typing import Any


DURABLE_PUBLISHERS = {"publish_event_json", "publish_state_json"}
ROW_KEYS = {
    "site_id",
    "script",
    "function",
    "logical_publication",
    "kind",
    "operation_identity_source",
    "result_policy",
    "result_consumer",
    "fault_test_ids",
}
KINDS = {
    "event_create_once",
    "state_replace_expected",
    "diagnostic_state",
    "lifecycle_move_deferred_draft_3",
}
IDENTITY_SOURCES = {"durable_json.operation_id.v1", "deferred_draft_3"}
RESULT_POLICIES = {
    "require_advance",
    "explicit_advance_check",
    "propagate_result",
    "aggregate_all",
    "deferred_draft_3",
}


def _call_name(call: ast.Call) -> str:
    if isinstance(call.func, ast.Name):
        return call.func.id
    if isinstance(call.func, ast.Attribute):
        return call.func.attr
    return ""


def _constant_keyword(call: ast.Call, name: str) -> str | None:
    for keyword in call.keywords:
        if keyword.arg == name and isinstance(keyword.value, ast.Constant) and isinstance(keyword.value.value, str):
            return keyword.value.value
    return None


def _function_nodes(tree: ast.Module) -> dict[str, list[ast.AST]]:
    functions: dict[str, list[ast.AST]] = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.setdefault(node.name, []).append(node)
    return functions


def _parent_map(node: ast.AST) -> dict[ast.AST, ast.AST]:
    return {
        child: parent
        for parent in ast.walk(node)
        for child in ast.iter_child_nodes(parent)
    }


def _assigned_name(call: ast.Call, parents: dict[ast.AST, ast.AST]) -> str | None:
    parent = parents.get(call)
    if not isinstance(parent, (ast.Assign, ast.AnnAssign)):
        return None
    target = parent.target if isinstance(parent, ast.AnnAssign) else (
        parent.targets[0] if len(parent.targets) == 1 else None
    )
    return target.id if isinstance(target, ast.Name) else None


def _scope_walk(function: ast.AST) -> list[ast.AST]:
    nodes: list[ast.AST] = []
    stack = list(reversed(list(ast.iter_child_nodes(function))))
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            continue
        nodes.append(node)
        stack.extend(reversed(list(ast.iter_child_nodes(node))))
    return nodes


def _is_name_read(function: ast.AST, name: str, assignment: ast.AST) -> bool:
    return any(
        isinstance(node, ast.Name)
        and isinstance(node.ctx, ast.Load)
        and node.id == name
        and node is not assignment
        for node in _scope_walk(function)
    )


def _contains_loaded_name(node: ast.AST, name: str) -> bool:
    return any(
        isinstance(child, ast.Name)
        and isinstance(child.ctx, ast.Load)
        and child.id == name
        for child in ast.walk(node)
    )


def _result_satisfies_policy(
    call: ast.Call,
    function: ast.AST,
    parents: dict[ast.AST, ast.AST],
    policy: str,
) -> bool:
    parent = parents.get(call)
    if (
        isinstance(parent, ast.Call)
        and isinstance(parent.func, ast.Name)
        and parent.func.id == "require_advance"
    ):
        return policy == "require_advance"
    if isinstance(parent, ast.Return):
        return policy == "propagate_result"

    assigned_name = _assigned_name(call, parents)
    if assigned_name is None or assigned_name == "_":
        return False
    if policy == "require_advance":
        for node in _scope_walk(function):
            if (
                not isinstance(node, ast.Call)
                or not isinstance(node.func, ast.Name)
                or node.func.id != "require_advance"
                or not any(_contains_loaded_name(argument, assigned_name) for argument in node.args)
            ):
                continue
            rebound = any(
                isinstance(candidate, ast.Name)
                and isinstance(candidate.ctx, ast.Store)
                and candidate.id == assigned_name
                and getattr(call, "lineno", -1) < getattr(candidate, "lineno", -1) < getattr(node, "lineno", -1)
                for candidate in _scope_walk(function)
            )
            if not rebound:
                return True
        return False
    if policy == "propagate_result":
        return any(
            isinstance(node, ast.Return)
            and node.value is not None
            and _contains_loaded_name(node.value, assigned_name)
            for node in _scope_walk(function)
        )
    if policy == "explicit_advance_check":
        return any(
            isinstance(node, ast.If)
            and any(
                isinstance(child, ast.Attribute)
                and child.attr == "advance_allowed"
                and isinstance(child.value, ast.Name)
                and child.value.id == assigned_name
                for child in ast.walk(node.test)
            )
            for node in _scope_walk(function)
        )
    if policy == "aggregate_all":
        return any(
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in {"aggregate_all", "require_all_advance"}
            and any(_contains_loaded_name(argument, assigned_name) for argument in node.args)
            for node in _scope_walk(function)
        )
    return False


def _is_json_write_call(call: ast.Call) -> bool:
    if not isinstance(call.func, ast.Attribute):
        return False
    if (
        call.func.attr == "dump"
        and isinstance(call.func.value, ast.Name)
        and call.func.value.id == "json"
    ):
        return True
    if call.func.attr in {"write_text", "write_bytes"}:
        return True
    return call.func.attr == "write" and any(
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "json"
        and node.func.attr == "dumps"
        for argument in call.args
        for node in ast.walk(argument)
    )


def _inline_writer_functions(tree: ast.Module) -> list[str]:
    violations: list[str] = []
    for function in (
        node
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    ):
        calls = [node for node in ast.walk(function) if isinstance(node, ast.Call)]
        named_clone = function.name in {"atomic_write_json", "_atomic_write_json", "fsync_parent"}
        semantic_clone = any(_is_json_write_call(call) for call in calls)
        if named_clone or semantic_clone:
            violations.append(function.name)
    return violations


def _finding(code: str, row: dict[str, Any], detail: str) -> dict[str, str]:
    return {
        "code": code,
        "site_id": str(row.get("site_id", "")),
        "script": str(row.get("script", "")),
        "function": str(row.get("function", "")),
        "detail": detail,
    }


def _inventory_findings(inventory: Any) -> list[dict[str, str]]:
    invalid = {
        "code": "inventory-invalid",
        "site_id": "",
        "script": "",
        "function": "",
        "detail": "inventory schema is malformed",
    }
    if not isinstance(inventory, dict):
        return [invalid]
    if inventory.get("schema_version") != 1 or inventory.get("helper_generation") != 1:
        return [invalid]
    list_fields = (
        "principal_scripts",
        "cooperating_scripts",
        "embedded_publishers",
        "diagnostic_only_weaker_callers",
        "callers",
    )
    if any(not isinstance(inventory.get(field), list) for field in list_fields):
        return [invalid]
    callers = inventory["callers"]
    if not callers:
        return [invalid]
    site_ids: set[str] = set()
    for row in callers:
        if not isinstance(row, dict) or set(row) != ROW_KEYS:
            return [invalid]
        site_id = row.get("site_id")
        if not isinstance(site_id, str) or not site_id:
            return [invalid]
        if site_id in site_ids:
            return [{
                "code": "duplicate-site-id",
                "site_id": site_id,
                "script": str(row.get("script", "")),
                "function": str(row.get("function", "")),
                "detail": "inventory site identifier is duplicated",
            }]
        site_ids.add(site_id)
        if (
            row.get("kind") not in KINDS
            or row.get("operation_identity_source") not in IDENTITY_SOURCES
            or row.get("result_policy") not in RESULT_POLICIES
        ):
            return [invalid]
        for field in ("script", "function", "logical_publication", "result_consumer"):
            if not isinstance(row.get(field), str) or not row[field]:
                return [invalid]
        fault_ids = row.get("fault_test_ids")
        if (
            not isinstance(fault_ids, list)
            or not fault_ids
            or any(not isinstance(value, str) or not value for value in fault_ids)
        ):
            return [invalid]
        deferred = row["kind"] == "lifecycle_move_deferred_draft_3"
        identity_is_deferred = row["operation_identity_source"] == "deferred_draft_3"
        policy_is_deferred = row["result_policy"] == "deferred_draft_3"
        if (
            deferred
            and (not identity_is_deferred or not policy_is_deferred)
        ) or (
            not deferred
            and (identity_is_deferred or policy_is_deferred)
        ):
            return [invalid]
    return []


def scan(root: Path, inventory_path: Path) -> list[dict[str, str]]:
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    schema_findings = _inventory_findings(inventory)
    if schema_findings:
        return schema_findings
    findings: list[dict[str, str]] = []
    covered_scripts = [
        *inventory.get("principal_scripts", []),
        *inventory.get("cooperating_scripts", []),
    ]
    missing_scripts = {
        str(script)
        for script in covered_scripts
        if not (root / str(script)).is_file()
    }
    findings.extend(
        {
            "code": "script-missing",
            "site_id": "",
            "script": script,
            "function": "",
            "detail": "inventory-covered script is missing",
        }
        for script in sorted(missing_scripts)
    )
    trees: dict[str, ast.Module] = {}
    parent_maps: dict[str, dict[ast.AST, ast.AST]] = {}
    inventoried_calls: set[ast.Call] = set()
    for script in covered_scripts:
        script = str(script)
        if script in missing_scripts:
            continue
        script_path = root / script
        tree = ast.parse(script_path.read_text(encoding="utf-8"), filename=str(script_path))
        trees[script] = tree
        parent_maps[script] = _parent_map(tree)
        findings.extend(
            {
                "code": "component-not-literal",
                "site_id": "",
                "script": script,
                "function": "",
                "detail": "durable publisher component must be a string literal",
            }
            for call in ast.walk(tree)
            if isinstance(call, ast.Call)
            and _call_name(call) in DURABLE_PUBLISHERS
            and _constant_keyword(call, "component") is None
        )
        findings.extend(
            {
                "code": "inline-writer",
                "site_id": "",
                "script": script,
                "function": function,
                "detail": "inline JSON publication primitive bypasses the shared helper",
            }
            for function in _inline_writer_functions(tree)
        )
    for row in inventory.get("callers", []):
        if row.get("kind") == "lifecycle_move_deferred_draft_3":
            continue
        script = str(row["script"])
        if script in missing_scripts:
            continue
        script_path = root / script
        tree = trees.get(script)
        if tree is None:
            tree = ast.parse(script_path.read_text(encoding="utf-8"), filename=str(script_path))
            trees[script] = tree
            parent_maps[script] = _parent_map(tree)
        candidates = _function_nodes(tree).get(str(row["function"]), [])
        calls = [
            node
            for function in candidates
            for node in ast.walk(function)
            if isinstance(node, ast.Call)
            and _call_name(node) in DURABLE_PUBLISHERS
            and _constant_keyword(node, "component") == row.get("logical_publication")
        ]
        if not calls:
            findings.append(_finding("inventory-call-missing", row, "named function contains no durable publisher"))
            continue
        for call in calls:
            inventoried_calls.add(call)
            function = next(function for function in candidates if call in set(ast.walk(function)))
            parents = _parent_map(function)
            parent = parents.get(call)
            if isinstance(parent, ast.Expr):
                findings.append(_finding("result-unconsumed", row, "durable publisher result is discarded"))
                continue
            assigned_name = _assigned_name(call, parents)
            if assigned_name is not None and not _is_name_read(function, assigned_name, parent):
                findings.append(_finding("result-unconsumed", row, "durable publisher result is not read"))
                continue
            if not _result_satisfies_policy(
                call,
                function,
                parents,
                str(row.get("result_policy", "")),
            ):
                findings.append(
                    _finding(
                        "result-unconsumed",
                        row,
                        "durable publisher result does not reach its declared advance policy",
                    )
                )
    for script in covered_scripts:
        script = str(script)
        if script in missing_scripts:
            continue
        script_path = root / script
        tree = trees.get(script)
        if tree is None:
            tree = ast.parse(script_path.read_text(encoding="utf-8"), filename=str(script_path))
            trees[script] = tree
            parent_maps[script] = _parent_map(tree)
        parents = parent_maps[script]
        for call in (
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and _call_name(node) in DURABLE_PUBLISHERS
        ):
            if call in inventoried_calls:
                continue
            function_name = "<module>"
            cursor: ast.AST = call
            while cursor in parents:
                cursor = parents[cursor]
                if isinstance(cursor, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    function_name = cursor.name
                    break
            findings.append(
                {
                    "code": "publisher-uninventoried",
                    "site_id": "",
                    "script": script,
                    "function": function_name,
                    "detail": "durable publisher call is absent from the inventory",
                }
            )
    return findings


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument(
        "--inventory",
        type=Path,
        default=Path("deploy/bot-errors-durable-writer-inventory.json"),
    )
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        root = args.root.resolve(strict=True)
        inventory_path = args.inventory
        if not inventory_path.is_absolute():
            inventory_path = root / inventory_path
        findings = scan(root, inventory_path)
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, SyntaxError) as exc:
        result = {"status": "inconclusive", "findings": [], "reason": type(exc).__name__}
        print(json.dumps(result, sort_keys=True))
        return 2
    status = "violation" if findings else "pass"
    print(json.dumps({"status": status, "findings": findings}, sort_keys=True))
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
