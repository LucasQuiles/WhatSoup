/**
 * Transitive import closure of the bot-errors deployer's managed-file allowlist.
 *
 * THE GAP THIS CLOSES. `deploy/scripts/whatsoup-bot-errors-deploy.sh` ships an
 * explicit `FILES=()` allowlist. `do_verify` iterates exactly that list, so a
 * root that holds every allowlisted file — and nothing else — prints
 * `VERIFY_OK` even when the shipped daemons cannot import their own
 * dependencies. The allowlist has to be CLOSED UNDER IMPORT for that verdict to
 * mean anything, and nothing computed the closure.
 *
 * WHY THE EXPECTED SET IS BUILT FROM THE IMPORT GRAPH. The pre-existing parity
 * test derived its "covered" set from the pin list and then asserted the pin
 * list was contained in it — `FILES ⊆ FILES`, true by construction. An expected
 * set derived from the allowlist, or from the runtime manifest, can never detect
 * a missing closure member. Everything here is seeded from the allowlist but
 * EXPANDED by parsing real import statements out of real files.
 *
 * TWO LANGUAGES, TWO PARSERS, NO REGEX.
 *   - TypeScript: `buildModuleGraph` (scripts/lib/semantic-quality/module-graph.ts)
 *     parses with the TypeScript compiler and yields RUNTIME edges only —
 *     `import type` / `export type` and all-type-only named bindings are erased
 *     by the compiler and cannot be a runtime dependency. Dynamic `import('./x')`
 *     IS a runtime edge and is included. Reusing that builder keeps one
 *     definition of "runtime edge" in the repo.
 *   - Python: the real `ast` module in a `python3` subprocess (the same
 *     dependency the deployer itself already requires). No regex approximation.
 *
 * DOCUMENTED LIMITS. Both walks are STATIC, so they see only literal specifiers:
 *   - A module name assembled at runtime from non-literal parts is invisible.
 *   - `require()` in TypeScript is not treated as an edge (this repo's source is
 *     ESM; `buildModuleGraph` defines the runtime-edge set and it does not
 *     include CommonJS `require`).
 *   - Specifiers that do not resolve to a repository file (stdlib, node
 *     built-ins, third-party packages) are not edges. Unresolved RELATIVE
 *     TypeScript specifiers are reported separately so a graph that silently
 *     failed to build cannot read as a clean closure.
 *   - Non-code allowlist members (`.sh`, `.json`) contribute no edges.
 * A path-load heuristic covers the one runtime edge no import walk can see: a
 * string literal ending in `.py` that resolves to a real file under
 * `deploy/scripts` is treated as an edge, because that is how
 * `bot-errors-health-check.py` loads its hyphenated sibling
 * `bot-errors-tree-provenance.py` via `spec_from_file_location`. It
 * over-approximates by design — shipping a file named in a literal is cheap;
 * missing one the runtime loads is the bug this module exists to prevent.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { buildModuleGraph } from './semantic-quality/module-graph.ts';

export const DEPLOY_SCRIPT_REL = 'deploy/scripts/whatsoup-bot-errors-deploy.sh';
export const RUNTIME_MANIFEST_REL = 'deploy/bot-errors-runtime-manifest.json';

/** Directory the deployed python scripts prepend to `sys.path` at startup. */
export const PYTHON_ROOT_REL = 'deploy/scripts';
/** Directory tree scanned for TypeScript modules when resolving specifiers. */
export const TS_SOURCE_ROOT_REL = 'src';

export interface ImportClosure {
  /** Allowlist paths parsed out of `FILES=()`, in source order. */
  seeds: string[];
  /** Seeds plus every transitively imported repository file, sorted. */
  closure: string[];
  /** Closure members that are NOT in the allowlist, sorted. */
  uncovered: string[];
  /** `importer -> imported` pairs actually observed, sorted. */
  edges: Array<{ from: string; to: string }>;
  /** Python files whose source the `ast` walk parsed successfully. */
  pythonParsed: string[];
  /** TypeScript files whose source the compiler parsed. */
  tsParsed: string[];
  /** Relative TypeScript specifiers that resolved to nothing — holes in the graph. */
  unresolvedTsSpecifiers: Array<{ from: string; specifier: string }>;
}

/**
 * Parse the `FILES=( ... )` bash array out of the deployer script.
 *
 * Terminates on a line that is exactly `)` — the array's real terminator — and
 * not on the first `)` character anywhere after `FILES=(`. A parenthesis inside
 * a comment between the entries silently truncates the naive form, and a
 * truncated allowlist under-seeds the closure while still looking well-formed.
 * This matches how the repo's other two parsers already read the array
 * (`deploy/scripts/tests/test_bot_errors_deploy_sha_failed.py` and
 * `deploy/scripts/tests/test_deployer_mutation.sh`).
 *
 * Fails closed on anything it does not recognise: an entry line must be a bare
 * quoted path. Splitting on the first `:` is retained for robustness against a
 * legacy hand-edited `"path:sha256"` entry; no current entry carries a `:`
 * suffix, because the expected sha256 is resolved at the deployer's runtime
 * from the runtime manifest, the single source of truth.
 */
export function parseDeployPinPaths(scriptText: string): string[] {
  const block = /^FILES=\(\n([\s\S]*?)^\)$/m.exec(scriptText);
  if (!block?.[1]) throw new Error(`could not locate FILES=( ... ) in ${DEPLOY_SCRIPT_REL}`);
  const paths: string[] = [];
  for (const rawLine of block[1].split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const quoted = /^"([^"]+)"$|^'([^']+)'$/.exec(line);
    if (!quoted) {
      throw new Error(`unrecognised FILES=( ) entry in ${DEPLOY_SCRIPT_REL}: ${line}`);
    }
    const pinPath = (quoted[1] ?? quoted[2] ?? '').split(':')[0]?.trim();
    if (pinPath) paths.push(pinPath);
  }
  if (paths.length === 0) throw new Error(`parsed FILES=( ) in ${DEPLOY_SCRIPT_REL} but found no entries`);
  return paths;
}

/** Read the allowlist straight from the deployer script on disk. */
export function readDeployPinPaths(repoRoot: string): string[] {
  return parseDeployPinPaths(readFileSync(path.join(repoRoot, DEPLOY_SCRIPT_REL), 'utf8'));
}

function walkFiles(root: string, relPrefix: string, out: string[]): void {
  for (const name of readdirSync(root)) {
    const absolute = path.join(root, name);
    const rel = relPrefix === '' ? name : `${relPrefix}/${name}`;
    if (statSync(absolute).isDirectory()) walkFiles(absolute, rel, out);
    else out.push(rel);
  }
}

/**
 * Python import walk, delegated to the real `ast` module.
 *
 * Runs one `python3` subprocess for the whole python side: python files in this
 * tree import only python, so the python and TypeScript graphs are disjoint and
 * each can be closed independently.
 */
const PYTHON_CLOSURE_PROGRAM = String.raw`
import ast, json, os, sys

repo = sys.argv[1]
seeds = sys.argv[2:]
BASE = "deploy/scripts"


def exists(rel):
    return os.path.isfile(os.path.join(repo, rel))


def add_module(dotted, out):
    if not dotted:
        return
    p = dotted.replace(".", "/")
    for cand in (BASE + "/" + p + ".py", BASE + "/" + p + "/__init__.py"):
        if exists(cand):
            out.add(cand)
            return


def edges_for(rel):
    with open(os.path.join(repo, rel), encoding="utf-8") as handle:
        tree = ast.parse(handle.read(), filename=rel)
    pkg_dir = os.path.dirname(rel)
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                add_module(alias.name, out)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = pkg_dir
                for _ in range(node.level - 1):
                    base = os.path.dirname(base)
                prefix = base[len(BASE) + 1:].replace("/", ".") if base.startswith(BASE + "/") else ""
                module = ".".join(part for part in (prefix, node.module or "") if part)
            else:
                module = node.module or ""
            if module:
                add_module(module, out)
                for alias in node.names:
                    add_module(module + "." + alias.name, out)
        elif isinstance(node, ast.Call):
            func = node.func
            name = func.attr if isinstance(func, ast.Attribute) else (func.id if isinstance(func, ast.Name) else "")
            if name in ("import_module", "__import__"):
                for arg in node.args:
                    if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                        add_module(arg.value, out)
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value.endswith(".py"):
            for cand in (node.value, BASE + "/" + os.path.basename(node.value)):
                if exists(cand):
                    out.add(cand)
                    break
    return out


closure = set(seeds)
parsed = []
edges = []
frontier = list(seeds)
while frontier:
    current = frontier.pop()
    parsed.append(current)
    for target in sorted(edges_for(current)):
        edges.append([current, target])
        if target not in closure:
            closure.add(target)
            frontier.append(target)

json.dump(
    {"closure": sorted(closure), "parsed": sorted(parsed), "edges": sorted(edges)},
    sys.stdout,
)
`;

interface PythonClosurePayload {
  closure: string[];
  parsed: string[];
  edges: Array<[string, string]>;
}

function pythonClosure(repoRoot: string, seeds: string[]): PythonClosurePayload {
  if (seeds.length === 0) return { closure: [], parsed: [], edges: [] };
  const stdout = execFileSync(
    'python3',
    ['-B', '-c', PYTHON_CLOSURE_PROGRAM, repoRoot, ...seeds],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as PythonClosurePayload;
}

/**
 * Compute the transitive import closure of `seeds` inside `repoRoot`.
 *
 * The result is derived ONLY from parsed import statements. Neither the
 * allowlist nor the runtime manifest contributes a member.
 */
export function computeImportClosure(repoRoot: string, seeds: readonly string[]): ImportClosure {
  const seedList = [...seeds];
  const edges: Array<{ from: string; to: string }> = [];

  const python = pythonClosure(repoRoot, seedList.filter((seed) => seed.endsWith('.py')));
  for (const [from, to] of python.edges) edges.push({ from, to });

  const tsFiles: string[] = [];
  walkFiles(path.join(repoRoot, TS_SOURCE_ROOT_REL), TS_SOURCE_ROOT_REL, tsFiles);
  const tsSources = tsFiles
    .filter((rel) => /\.tsx?$/.test(rel) && !rel.endsWith('.d.ts'))
    .map((rel) => ({ path: rel, text: readFileSync(path.join(repoRoot, rel), 'utf8') }));
  const graph = buildModuleGraph(tsSources);

  const unresolvedTsSpecifiers: Array<{ from: string; specifier: string }> = [];
  const tsClosure = new Set<string>();
  const tsFrontier = seedList.filter((seed) => /\.tsx?$/.test(seed));
  for (const seed of tsFrontier) tsClosure.add(seed);
  while (tsFrontier.length > 0) {
    const current = tsFrontier.pop()!;
    for (const specifier of graph.unresolvedRuntimeSpecifiers.get(current) ?? []) {
      unresolvedTsSpecifiers.push({ from: current, specifier });
    }
    for (const target of graph.runtimeEdges.get(current) ?? []) {
      edges.push({ from: current, to: target });
      if (!tsClosure.has(target)) {
        tsClosure.add(target);
        tsFrontier.push(target);
      }
    }
  }

  const closure = new Set<string>([...seedList, ...python.closure, ...tsClosure]);
  const seedSet = new Set(seedList);
  return {
    seeds: seedList,
    closure: [...closure].sort(),
    uncovered: [...closure].filter((member) => !seedSet.has(member)).sort(),
    edges: edges.sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from))),
    pythonParsed: python.parsed,
    tsParsed: [...tsClosure].sort(),
    unresolvedTsSpecifiers,
  };
}
