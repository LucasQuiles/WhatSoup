#!/usr/bin/env python3
"""AST mutation sweep for the equality / boolean / not / relational class.

Reproducibility tool for the CAPE mutation-audit campaign. `mutmut` is
unavailable offline, so this is a self-contained stdlib harness that answers a
single question per probe: *can any test in this probe's standalone suite be
gamed by a one-node logic flip?*

For a target probe it enumerates every

    Compare(Eq|NotEq)        -> flipped to its opposite          (kind "cmp")
    Compare(Lt|LtE|Gt|GtE)   -> flipped to the adjacent boundary (kind "rel")
    BoolOp(And|Or)           -> flipped And<->Or                 (kind "bool")
    UnaryOp(Not)             -> the `not` is removed             (kind "not")

node, applies EXACTLY ONE mutation at a time to a throwaway copy of the estate,
runs the probe's standalone test from that copy, and records the verdict:

    SURVIVED  test still passed  -> the mutant is INDISTINGUISHABLE by the
                                    suite: either a gameable/under-asserted test
                                    (a REAL gap to pin with a red-green proof) or
                                    a genuinely EQUIVALENT mutant (no program
                                    INPUT distinguishes it -- document it).
    killed    test failed        -> the boundary is pinned in at least one
                                    direction. Good.

A clean run is `SURVIVORS: 0/N`, OR a small residue of survivors each of which
has been MANUALLY classified EQUIVALENT (identity-filtered, measure-zero float
boundary, update-to-same-value no-op, double-guarded by a second check, dead
code, parameterless self-test) and documented in the test file / ledger. A
survivor is NOT automatically a bug and NOT automatically equivalent -- the
verdict here only tells you the suite cannot tell the two programs apart; the
classification is a human judgement recorded next to the pinning test.

Usage (run from the repo root, the dir that contains this `tools/` folder):

    python3 tools/mutation_sweep.py <probe_name>
    # e.g.
    python3 tools/mutation_sweep.py enrichment_control_fixtures

`<probe_name>` is the probe module stem; the suite is `tests/test_<probe>.py`.
The repo root is resolved from this file's location, so the tool is portable
across checkouts -- it does not assume any absolute path. The mutated copy is
written under a TemporaryDirectory and removed on exit; the live tree is never
modified. Stdlib only, offline, no provider/host side effects.
"""
import ast
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Repo root = the parent of this tools/ directory; portable across checkouts.
SRC_DIR = Path(__file__).resolve().parents[1]


def _is_cmp(n):
    return isinstance(n, ast.Compare) and any(isinstance(o, (ast.Eq, ast.NotEq)) for o in n.ops)


def _is_rel(n):
    return isinstance(n, ast.Compare) and any(
        isinstance(o, (ast.Lt, ast.LtE, ast.Gt, ast.GtE)) for o in n.ops
    )


class Flip(ast.NodeTransformer):
    """Apply exactly one mutation to the node matching target_id."""

    def __init__(self, target_id, kind):
        self.target_id = target_id
        self.kind = kind
        self.applied = False

    def visit_Compare(self, node):
        self.generic_visit(node)
        if self.kind == "cmp" and id(node) == self.target_id:
            new_ops = []
            for op in node.ops:
                if isinstance(op, ast.Eq):
                    new_ops.append(ast.NotEq())
                elif isinstance(op, ast.NotEq):
                    new_ops.append(ast.Eq())
                else:
                    new_ops.append(op)
            node.ops = new_ops
            self.applied = True
        elif self.kind == "rel" and id(node) == self.target_id:
            bmap = {ast.Lt: ast.LtE, ast.LtE: ast.Lt, ast.Gt: ast.GtE, ast.GtE: ast.Gt}
            node.ops = [bmap[type(op)]() if type(op) in bmap else op for op in node.ops]
            self.applied = True
        return node

    def visit_BoolOp(self, node):
        self.generic_visit(node)
        if self.kind == "bool" and id(node) == self.target_id:
            node.op = ast.Or() if isinstance(node.op, ast.And) else ast.And()
            self.applied = True
        return node

    def visit_UnaryOp(self, node):
        self.generic_visit(node)
        if self.kind == "not" and id(node) == self.target_id:
            # remove the `not`: replace the UnaryOp with its operand
            self.applied = True
            return node.operand
        return node


def _enumerate(tree):
    """Return [(lineno, kind)] for every mutable node in source order."""
    out = []
    for node in ast.walk(tree):
        if _is_cmp(node):
            out.append((node.lineno, "cmp"))
        if _is_rel(node):
            out.append((node.lineno, "rel"))
        elif isinstance(node, ast.BoolOp):
            out.append((node.lineno, "bool"))
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            out.append((node.lineno, "not"))
    return out


def _fresh_match(kind, lineno):
    """Re-parse src and return the first node of `kind` at `lineno`, or None."""
    fresh = ast.parse(SRC)
    nodes = []
    for n in ast.walk(fresh):
        if kind == "cmp" and _is_cmp(n):
            nodes.append(n)
        elif kind == "rel" and _is_rel(n):
            nodes.append(n)
        elif kind == "bool" and isinstance(n, ast.BoolOp):
            nodes.append(n)
        elif kind == "not" and isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.Not):
            nodes.append(n)
    match = [n for n in nodes if n.lineno == lineno]
    return (fresh, match[0]) if match else (None, None)


def main():
    if len(sys.argv) != 2:
        print("usage: python3 tools/mutation_sweep.py <probe_name>", file=sys.stderr)
        return 2
    probe = sys.argv[1]
    test = f"tests/test_{probe}.py"
    probe_path = SRC_DIR / f"{probe}.py"
    if not probe_path.exists():
        print(f"no such probe: {probe_path}", file=sys.stderr)
        return 2
    if not (SRC_DIR / test).exists():
        print(f"no such test: {SRC_DIR / test}", file=sys.stderr)
        return 2

    global SRC
    SRC = probe_path.read_text()
    src_lines = SRC.splitlines()
    candidates = _enumerate(ast.parse(SRC))

    results = []
    for lineno, kind in candidates:
        fresh, node = _fresh_match(kind, lineno)
        if node is None:
            continue
        fn = Flip(id(node), kind)
        mutated = fn.visit(fresh)
        if not fn.applied:
            continue
        ast.fix_missing_locations(mutated)
        try:
            mutated_src = ast.unparse(mutated)
        except Exception as e:  # pragma: no cover - defensive
            # emit a typed error marker (not a clean-empty fail-open); the
            # `continue` lives outside the handler so the boundary is explicit.
            results.append((lineno, kind, f"UNPARSE_ERR:{e}", ""))
            mutated_src = None
        if mutated_src is None:
            continue
        with tempfile.TemporaryDirectory() as td:
            dst = Path(td) / "probes"
            shutil.copytree(
                SRC_DIR, dst,
                ignore=shutil.ignore_patterns("__pycache__", ".venv-test", "vendor", ".git"),
            )
            (dst / f"{probe}.py").write_text(mutated_src)
            proc = subprocess.run(
                [sys.executable, test], cwd=dst,
                capture_output=True, text=True, timeout=120,
            )
            verdict = "SURVIVED" if proc.returncode == 0 else "killed"
        snippet = src_lines[lineno - 1].strip()[:70]
        results.append((lineno, kind, verdict, snippet))

    results.sort(key=lambda r: r[0])
    print(f"=== {probe}: {len(results)} eq/bool/not/rel mutants ===")
    survivors = 0
    scored = [r for r in results if r[2] in ("SURVIVED", "killed")]
    for r in results:
        if r[2] == "SURVIVED":
            survivors += 1
            print(f"  L{r[0]:<4} {r[1]:<5} *** SURVIVED *** | {r[3]}")
        elif r[2] == "killed":
            print(f"  L{r[0]:<4} {r[1]:<5} killed          | {r[3]}")
        else:
            print(f"  L{r[0]:<4} {r[1]:<5} {r[2]}")
    print(f"SURVIVORS: {survivors}/{len(scored)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
