# Semantic Boundary Foundation Implementation Plan

**Status:** Pending — specification and experiment complete; production implementation not started

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first semantic-boundary tranche: exact-commit TypeScript/TSX production reachability, executable guard negative-control proof, structural decision-poll verification, contextual receipts, and shadow-mode local/CI feedback.

**Architecture:** Pure AST and policy functions live under `scripts/lib/semantic-quality/`; Git is accessed through an exact-revision source provider; `scripts/semantic-quality-check.ts` is the only CLI adapter. The experiment evaluator imports the production functions instead of retaining a second implementation. Local verification and the existing Quality workflow invoke the same command in shadow mode; no required context or ruleset changes occur in this tranche.

**Tech Stack:** Node `24.15.0`, npm `11.12.1`, TypeScript `5.9.3` compiler API, Vitest `4.1.8`, Git CLI, existing WhatSoup guard-core and Git environment helpers.

## Global Constraints

- The authoritative specification is `docs/superpowers/specs/2026-07-15-semantic-boundary-hygiene-design.md`. PR A directly implements SBH-001, SBH-002, SBH-003, SBH-006, SBH-007, SBH-008, SBH-009, and SBH-010. SBH-004, SBH-005, and SBH-011 constrain later tranches; SBH-012 applies to PR A subprocess probes while the outer pre-push process-group watchdog remains PR C.
- This plan authorizes repository code, test, workflow, and documentation changes only. It does not authorize pushes, PR creation, comments, labels, merges, ruleset changes, workflow reruns, or external producer writes.
- PR A runs new findings in `shadow` mode. The semantic decision remains `block`, `warn`, or `inconclusive` in receipts, but shadow mode exits zero after emitting visible feedback. Existing unrelated guards keep their current exit behavior.
- The only production roots are `src/main.ts`, `src/bootstrap.ts`, `src/bootstrap-auth.ts`, `src/fleet/standalone.ts`, and `src/transport/auth.ts`.
- Added and renamed production modules are the first block-capable reachability delta. Modified pre-existing islands and full-tree inventory remain warning-only in this tranche.
- Type-only imports/re-exports, comments, strings, tests, and unresolved computed imports do not prove runtime reachability. Static imports, side-effect imports, runtime re-exports, and literal dynamic imports do.
- Missing Git objects, parse errors, unreadable policy, and unresolved candidate identity are `inconclusive`; they are never converted to pass.
- The experiment evaluator is a test oracle, not a second production engine. Move reusable logic behind the interfaces in this plan and import it from `scripts/experiments/semantic-boundary-eval.ts`.
- Overrides are path-qualified records with owner, reason, expiry, and re-entry condition. Do not introduce environment-variable bypasses or magic-comment allowlists.
- Receipts contain no secrets or raw GitHub comment bodies. Source references are URLs, Git OIDs, repo-relative paths, or bounded disposition identifiers.
- Node commands use `bash scripts/run-with-pinned-node.sh`; npm commands use `bash scripts/run-with-pinned-npm.sh`. Heavy suites run through `loadgate`.
- Tests use `--pool=forks --fileParallelism=false` when isolation or deterministic process cleanup matters.
- Stage explicit paths only. Commit messages use conventional prefixes and contain no attribution trailers, model names, internal names, or personal/work emails.
- New documentation under `docs/superpowers/` requires a `PRIVATE-ARCHIVE` row in `docs/publication-audit.md` and regenerated `docs/work-index.json` / `docs/work-index.md`.
- The current experiment branch contains an intentionally untracked `experiment-results.tsv`; implementation tasks must not stage it.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scripts/lib/semantic-quality/module-graph.ts` | create | Parse runtime import/re-export edges and compute production reachability |
| `scripts/lib/semantic-quality/git-tree.ts` | create | Read exact Git revisions, changed statuses, and blobs without consulting working-tree content |
| `scripts/lib/semantic-quality/policy.ts` | create | Validate policy/allowlist and classify changed modules |
| `scripts/lib/semantic-quality/receipt.ts` | create | Canonical receipt types, aggregation, human/JSON rendering, atomic local receipt write |
| `config/semantic-quality.json` | create | Versioned roots, source globs, exclusions, and empty structured allowlist |
| `scripts/semantic-quality-check.ts` | create | CLI adapter for branch/tree scopes and shadow/enforce exit behavior |
| `tests/scripts/semantic-module-graph.test.ts` | create | Pure AST graph negative, positive, and false-positive controls |
| `tests/scripts/semantic-quality-policy.test.ts` | create | Policy validation, allowlist expiry, decision, and aggregation tests |
| `tests/scripts/semantic-quality-check.test.ts` | create | Exact Git-object and CLI/receipt black-box tests |
| `tests/fixtures/semantic-quality/` | create | Minimal Git/source fixtures used by the production guard tests |
| `scripts/guard-test-coverage-check.ts` | modify | Add semantic companion-test proof taxonomy and shadow reporting |
| `tests/scripts/guard-test-coverage-check.test.ts` | modify | Prove comments, no-op tests, success-only calls, and unasserted subprocesses fail semantic proof |
| `scripts/agent-decision-polls-guard.ts` | modify | Replace raw source anchors with AST structure and executable hook probes |
| `tests/scripts/agent-decision-polls-guard.test.ts` | modify | Mutation fixtures plus accepted/prohibited transcript execution |
| `src/runtimes/agent/route-events.ts` | modify | Remove the test-only delegation-receipt island while preserving route events |
| `tests/runtimes/agent/route-events.test.ts` | modify | Remove isolated delegation-receipt tests and retain route-event behavior proof |
| `scripts/experiments/semantic-boundary-eval.ts` | modify | Import production graph/receipt functions; retain experiment-only history/provenance cases |
| `tests/scripts/semantic-boundary-eval.test.ts` | modify | Prove the evaluator delegates semantic decisions to production code |
| `package.json` | modify | Add `guard:semantic-quality`, `verify:semantic`, and `verify:semantic:shadow`; wire shadow mode |
| `.github/workflows/quality.yml` | modify | Run one pinned-Node semantic shadow step before the expensive suite |
| `scripts/safeguard-diagnostics.ts` | modify | Require semantic shadow composition and ordering |
| `tests/scripts/safeguard-diagnostics.test.ts` | modify | Assert local/CI semantic command parity |
| `tests/scripts/pre-push-guard.test.ts` | modify | Assert `verify:push:branch` invokes semantic shadow before tests |
| `docs/public-surface.md` | modify | Document scripts, decisions, modes, and receipt location |
| `docs/publication-audit.md` | modify | Classify new internal docs/fixtures where applicable |
| `docs/work-index.json` / `docs/work-index.md` | regenerate | Keep tracked planning inventory current |

The module graph, Git provider, policy, and receipt files are deliberately separate. A later history/provenance tranche can consume the receipt without importing the semantic CLI, and a module parser change does not require Git or renderer rewrites.

---

### Task 1: Build the pure runtime module graph

**Files:**
- Create: `scripts/lib/semantic-quality/module-graph.ts`
- Create: `tests/scripts/semantic-module-graph.test.ts`
- Create: `tests/fixtures/semantic-quality/module-graphs/`

**Interfaces:**
- Consumes: in-memory repo-relative source records; no Git, filesystem, or process state.
- Produces:

```ts
export interface ModuleSource {
  path: string;
  text: string;
}

export interface ModuleGraph {
  files: ReadonlySet<string>;
  runtimeEdges: ReadonlyMap<string, ReadonlySet<string>>;
  unresolvedRuntimeSpecifiers: ReadonlyMap<string, ReadonlySet<string>>;
  runtimeExports: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface ReachabilityResult {
  roots: string[];
  reachable: Set<string>;
  unreachableCandidates: string[];
  unresolved: Array<{ importer: string; specifier: string }>;
}

export interface ExportOwnershipResult {
  unowned: Array<{ path: string; name: string }>;
  owned: Array<{ path: string; name: string; owners: string[] }>;
}

export function buildModuleGraph(sources: ModuleSource[]): ModuleGraph;
export function analyzeReachability(
  graph: ModuleGraph,
  roots: string[],
  candidates: string[],
): ReachabilityResult;
export function analyzeExportOwnership(
  sources: ModuleSource[],
  graph: ModuleGraph,
  reachable: ReadonlySet<string>,
): ExportOwnershipResult;
```

- [ ] **Step 1: Write the failing graph tests**

Create table-driven tests that use the exact configured root `src/main.ts` and assert these outcomes:

```ts
it.each([
  ['runtime import', `import { feature } from './lib/feature.ts';\nfeature();`, []],
  ['side-effect import', `import './lib/feature.ts';`, []],
  ['literal dynamic import', `await import('./lib/feature.ts');`, []],
  ['type-only import', `import type { Feature } from './lib/feature.ts';`, ['src/lib/feature.ts']],
  ['type-only re-export', `export type { Feature } from './lib/feature.ts';`, ['src/lib/feature.ts']],
  ['comment', `// import './lib/feature.ts'`, ['src/lib/feature.ts']],
  ['string', `const note = "./lib/feature.ts";`, ['src/lib/feature.ts']],
  ['computed import', `const p = './lib/feature.ts'; await import(p);`, ['src/lib/feature.ts']],
])('%s', (_name, mainText, expected) => {
  const graph = buildModuleGraph([
    { path: 'src/main.ts', text: mainText },
    { path: 'src/lib/feature.ts', text: 'export const feature = () => true;' },
  ]);
  expect(analyzeReachability(graph, ['src/main.ts'], ['src/lib/feature.ts']).unreachableCandidates)
    .toEqual(expected);
});
```

Add separate cases for `.js` specifier-to-`.ts` source resolution, extensionless `index.ts`, mixed `type`/value imports, TSX, disconnected multi-module islands, missing roots, and a literal import whose target does not exist. Missing roots and unresolved literal imports must be observable in the result rather than silently dropped.

Add export-ownership cases proving that an exported runtime value imported/called by a reachable
module is owned; a same-module runtime reference counts; a type export, test-only import, comment,
string, or isolated declaration does not count; namespace-property use resolves to the exported
member; and `default` exports are tracked without inventing a source identifier.

- [ ] **Step 2: Run the test and confirm RED**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-module-graph.test.ts --pool=forks --fileParallelism=false
```

Expected: FAIL because `scripts/lib/semantic-quality/module-graph.ts` does not exist.

- [ ] **Step 3: Implement runtime-edge extraction**

Use `typescript.createSourceFile` and visit only these runtime edge shapes:

```ts
function runtimeSpecifiers(source: ts.SourceFile): string[] {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const allNamedTypeOnly =
        bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly);
      if (!clause?.isTypeOnly && !(allNamedTypeOnly && !clause?.name)) {
        found.add(node.moduleSpecifier.text);
      }
    } else if (
      ts.isExportDeclaration(node) && !node.isTypeOnly &&
      node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])
    ) {
      found.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found];
}
```

Resolve only repo-relative specifiers. Try the exact path, `.ts`, `.tsx`, `/index.ts`, `/index.tsx`, and `.js`/`.mjs` mapped to `.ts`/`.tsx`. Never treat a bare package import as an internal edge. Traverse breadth- or depth-first from existing roots and sort every externally returned path for stable receipts.

Enumerate exported runtime declarations and connect them to production owners through resolved
import bindings, re-exports, namespace property accesses, and same-module runtime references.
Exclude interfaces, type aliases, `export type`, declaration-name occurrences, and references in
unreachable modules. Return full owner paths so the receipt can explain why an export is considered
owned rather than relying on a count.

- [ ] **Step 4: Run graph tests GREEN and typecheck scripts**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-module-graph.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
```

Expected: graph suite PASS; script typecheck exits 0.

- [ ] **Step 5: Commit Task 1**

```bash
git add scripts/lib/semantic-quality/module-graph.ts tests/scripts/semantic-module-graph.test.ts tests/fixtures/semantic-quality/module-graphs
git commit -m "feat(quality): add semantic runtime module graph"
```

---

### Task 2: Read exact Git trees and classify candidate deltas

**Files:**
- Create: `scripts/lib/semantic-quality/git-tree.ts`
- Create: `scripts/lib/semantic-quality/policy.ts`
- Create: `config/semantic-quality.json`
- Create: `tests/scripts/semantic-quality-policy.test.ts`
- Create: `tests/fixtures/semantic-quality/git-repos/README.md`

**Interfaces:**
- Consumes: Task 1 `ModuleSource`, `ModuleGraph`, and `ReachabilityResult`; existing `cleanGitEnv()` from `src/lib/git-env.ts`.
- Produces:

```ts
export type SemanticScope = 'branch' | 'tree';
export type ChangedStatus = 'added' | 'copied' | 'modified' | 'renamed' | 'deleted';

export interface ChangedPath {
  status: ChangedStatus;
  path: string;
  oldPath?: string;
}

export interface CandidateTree {
  headOid: string;
  baseOid: string | null;
  mergeBaseOid: string | null;
  sources: ModuleSource[];
  changedPaths: ChangedPath[];
  limitations: string[];
}

export interface SemanticQualityPolicy {
  schemaVersion: 1;
  roots: string[];
  sourcePrefixes: string[];
  excludedSuffixes: string[];
  allowlist: Array<{
    path: string;
    owner: string;
    reason: string;
    expiresOn: string;
    reentryCondition: string;
  }>;
}

export interface SemanticPolicyFinding {
  ruleId: 'semantic.production-reachability' | 'semantic.export-ownership' | 'semantic.unresolved-runtime-edge' | 'semantic.invalid-allowlist';
  decision: 'warn' | 'block' | 'inconclusive';
  paths: string[];
  evidence: Array<{ label: string; value: string }>;
}

export function readCandidateTree(input: {
  cwd: string;
  head: string;
  baseRef?: string;
  scope: SemanticScope;
}): CandidateTree;
export function loadSemanticPolicy(cwd: string): SemanticQualityPolicy;
export function evaluateSemanticPolicy(input: {
  tree: CandidateTree;
  policy: SemanticQualityPolicy;
  now: Date;
}): SemanticPolicyFinding[];
```

- [ ] **Step 1: Write exact-object and policy failure tests**

Use a temporary Git repository created by the test. Commit a reachable baseline, then create exact commits for:

1. added module imported by `src/main.ts` → no reachability finding;
2. added module imported only by a test → `block` finding;
3. renamed module left unreachable → `block` finding naming the new path;
4. modified pre-existing unreachable module → `warn`, not `block`;
5. deleted module → ignored by reachability;
6. working-tree edit after `HEAD` → not visible when `head: 'HEAD'` is inspected;
7. missing base ref or malformed diff → `inconclusive` with the failed evidence operation;
8. expired allowlist → `semantic.invalid-allowlist` block;
9. well-formed active allowlist → suppress only its exact path and record the allowlist reason;
10. missing owner/reason/expiry/re-entry field → policy validation failure.

Assert the returned `headOid`, `baseOid`, and `mergeBaseOid` against `git rev-parse` output. Do not accept abbreviated OIDs.

- [ ] **Step 2: Run the policy test and confirm RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-quality-policy.test.ts --pool=forks --fileParallelism=false
```

Expected: FAIL because Git-tree and policy modules do not exist.

- [ ] **Step 3: Add the versioned policy**

Create `config/semantic-quality.json` exactly as:

```json
{
  "schemaVersion": 1,
  "roots": [
    "src/main.ts",
    "src/bootstrap.ts",
    "src/bootstrap-auth.ts",
    "src/fleet/standalone.ts",
    "src/transport/auth.ts"
  ],
  "sourcePrefixes": ["src/"],
  "excludedSuffixes": [".d.ts"],
  "allowlist": []
}
```

The loader rejects unknown top-level keys, duplicate roots, paths outside `src/`, invalid ISO dates, expired entries, and duplicate allowlist paths.

- [ ] **Step 4: Implement the exact Git provider**

Run Git only with `execFileSync`, `cleanGitEnv()`, bounded buffers, and explicit arguments. Resolve `head` with `git rev-parse --verify <head>^{commit}`. In branch scope resolve `baseRef`, compute `git merge-base`, enumerate changes with `git diff --name-status -z --find-renames --find-copies <merge-base>..<head> -- src`, enumerate source paths with `git ls-tree -r --name-only -z <head> -- src`, and read blobs with `git show <head>:<path>`.

Every Git failure is caught at the provider boundary and returned as a limitation that makes the policy `inconclusive`. It must not return an empty source list as a healthy tree.

- [ ] **Step 5: Implement decision classification**

Build the Task 1 graph from `CandidateTree.sources`. For `added`, `copied`, and `renamed` TypeScript/TSX paths, unreachable means `block`. For `modified` paths, unreachable means `warn`. Full-tree unowned runtime exports produce `semantic.export-ownership` warnings in PR A; they never become block findings in this tranche. Literal unresolved edges originating in changed production modules warn in shadow mode. An invalid/expired allowlist blocks because it would otherwise hide evidence.

- [ ] **Step 6: Run tests GREEN and commit Task 2**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-module-graph.test.ts tests/scripts/semantic-quality-policy.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
git add config/semantic-quality.json scripts/lib/semantic-quality/git-tree.ts scripts/lib/semantic-quality/policy.ts tests/scripts/semantic-quality-policy.test.ts tests/fixtures/semantic-quality/git-repos/README.md
git commit -m "feat(quality): classify exact semantic candidate deltas"
```

---

### Task 3: Emit complete receipts and the single semantic CLI

**Files:**
- Create: `scripts/lib/semantic-quality/receipt.ts`
- Create: `scripts/semantic-quality-check.ts`
- Create: `tests/scripts/semantic-quality-check.test.ts`

**Interfaces:**
- Consumes: Task 2 findings and exact candidate metadata.
- Produces:

```ts
export type BoundaryDecision = 'pass' | 'warn' | 'block' | 'inconclusive';
export type EnforcementMode = 'shadow' | 'enforce';

export interface BoundaryFinding {
  ruleId: string;
  decision: Exclude<BoundaryDecision, 'pass'>;
  action: 'push';
  summary: string;
  why: string;
  observed: Array<{ label: string; value: string }>;
  matchedArtifacts: [];
  correction: string[];
  rerun: string;
  sourceRefs: string[];
}

export interface BoundaryReceipt {
  schemaVersion: 1;
  repository: 'LucasQuiles/WhatSoup';
  invocation: 'semantic-quality';
  enforcementMode: EnforcementMode;
  decision: BoundaryDecision;
  base: {
    headOid: string | null;
    baseOid: string | null;
    mergeBaseOid: string | null;
    evidenceSource: string;
  };
  fingerprints: Record<string, string | null>;
  findings: BoundaryFinding[];
  limitations: string[];
}

export function buildSemanticReceipt(input: BuildSemanticReceiptInput): BoundaryReceipt;
export function renderSemanticReceipt(receipt: BoundaryReceipt): string;
export function semanticExitCode(receipt: BoundaryReceipt): 0 | 1 | 2;
export function writeLocalReceipt(cwd: string, receipt: BoundaryReceipt): string;
```

- [ ] **Step 1: Write CLI and renderer failure tests**

Test human, JSON, and process behavior:

- `pass` prints one line with the head OID and receipt path;
- `warn`, `block`, and `inconclusive` print decision, rule, attempted action, exact evidence, why, correction, rerun, and sources in that order;
- `--format json` emits one parseable receipt and no human prose on stdout;
- shadow `block` and shadow `inconclusive` exit 0 while preserving their receipt decision;
- enforce `block` exits 1 and enforce `inconclusive` exits 2;
- unknown arguments, unreadable policy, and missing head are `inconclusive`, never uncaught success;
- local receipt path resolves through `git rev-parse --git-path whatsoup/receipts/semantic-quality.json`;
- receipt writes use an exclusive temporary file, rename atomically, and do not follow a symlinked destination;
- the current wired PR #1835 shape passes while its historical disconnected shape blocks, using local fixture commits rather than network access.

- [ ] **Step 2: Confirm RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-quality-check.test.ts --pool=forks --fileParallelism=false
```

Expected: FAIL because the receipt and CLI modules do not exist.

- [ ] **Step 3: Implement aggregation and complete findings**

Aggregate `block` over `inconclusive` over `warn` over `pass`. Each policy finding maps to one complete `BoundaryFinding`. The production-reachability correction is:

```ts
[
  'Integrate the module through one declared production root and add a behavior test through that owner.',
  'If the module is intentionally non-runtime, move it outside src/ or add a scoped, expiring owner allowlist record.'
]
```

Its rerun command is `npm run verify:semantic -- --base origin/main`. Do not render raw stack traces as the `why` field; place bounded error class/message text under observed evidence.

- [ ] **Step 4: Implement CLI arguments**

Support only:

```text
--scope branch|tree
--head <commit-ish>
--base <commit-ish>
--mode shadow|enforce
--format human|json
--receipt <path>
--no-receipt
```

Defaults are `--scope branch --head HEAD --base origin/main --mode shadow --format human`. `--no-receipt` is intended for hermetic tests; local commands write under Git metadata. An explicit `--receipt` path is required in CI.

- [ ] **Step 5: Run GREEN and commit Task 3**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-module-graph.test.ts tests/scripts/semantic-quality-policy.test.ts tests/scripts/semantic-quality-check.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
git add scripts/lib/semantic-quality/receipt.ts scripts/semantic-quality-check.ts tests/scripts/semantic-quality-check.test.ts
git commit -m "feat(quality): add semantic quality receipts"
```

---

### Task 4: Make companion guard-test proof semantic

**Files:**
- Modify: `scripts/guard-test-coverage-check.ts`
- Modify: `tests/scripts/guard-test-coverage-check.test.ts`

**Interfaces:**
- Consumes: existing guard enumeration and `verify:push:branch` wiring checks.
- Produces the extended taxonomy:

```ts
export type GuardTestCoverageReason =
  | 'no-test'
  | 'test-not-wired'
  | 'test-does-not-import-or-invoke-guard'
  | 'test-does-not-exercise-failure';

export interface GuardTestCoverageOptions {
  cwd?: string;
  semanticMode?: 'shadow' | 'enforce';
}
```

- [ ] **Step 1: Replace the no-op fixture with semantic controls**

Extend `makeFixture` so each test body is explicit. Add these cases:

1. comment/string containing the guard name only → `test-does-not-import-or-invoke-guard`;
2. imports guard but never calls it → same reason;
3. calls analyzer but asserts only success → `test-does-not-exercise-failure`;
4. calls analyzer on unsafe input and asserts non-empty findings → covered;
5. invokes the guard as a subprocess but never checks status → failure;
6. invokes the guard as a subprocess and asserts non-zero status → covered;
7. semantic gap in shadow mode → reported but process exit remains unchanged;
8. same gap in enforce mode → process exit 1.

Keep existing missing-test and not-wired tests unchanged so the new logic cannot weaken them.

- [ ] **Step 2: Confirm RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/guard-test-coverage-check.test.ts --pool=forks --fileParallelism=false
```

Expected: new semantic cases FAIL against the current two-reason implementation.

- [ ] **Step 3: Implement conservative AST proof**

Parse the companion test with the TypeScript compiler API. Accept either:

- a relative import from the guard module, a call whose callee resolves to an imported guard binding, and a matcher on that call/result proving `ok === false`, non-empty findings, throw/rejection, or non-zero status; or
- a subprocess call whose argument includes the exact guard path and a matcher proving non-zero status or failure output.

Do not count comments, string-only mentions, an import without a call, a call outside a test body, or a success-only matcher. Semantic proof findings are a separate array in `GuardCoverageResult` so shadow mode can display them without weakening current hard gaps.

- [ ] **Step 4: Inventory the real repo in shadow mode**

```bash
bash scripts/run-with-pinned-node.sh scripts/guard-test-coverage-check.ts --semantic-mode shadow
```

Expected: exit 0 if existing missing/wiring checks pass; every semantic gap is printed with guard/test path and the exact missing proof. Record the count in the implementation notes. Do not add mass exceptions in this task.

- [ ] **Step 5: Run GREEN and commit Task 4**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/guard-test-coverage-check.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
git add scripts/guard-test-coverage-check.ts tests/scripts/guard-test-coverage-check.test.ts
git commit -m "fix(quality): prove guard negative controls semantically"
```

---

### Task 5: Replace decision-poll text anchors with structure and execution

**Files:**
- Modify: `scripts/agent-decision-polls-guard.ts`
- Modify: `tests/scripts/agent-decision-polls-guard.test.ts`

**Interfaces:**
- Consumes: tracked TypeScript source plus `deploy/hooks/poll-interaction-lint.mjs`.
- Produces: the existing `AgentDecisionPollsGuardResult`; findings become rule-prefixed structural/executable diagnostics without changing `run()` callers.

- [ ] **Step 1: Add source-mutation negative controls**

Build a complete minimal fixture and prove these mutations fail:

- moving `AskUserQuestion` and `multiSelect: true` into comments;
- leaving only a string containing `POLL_DECISION_GUIDANCE`;
- removing the MCP `.describe(...)` relationship while retaining its text elsewhere;
- removing `withZodDescription` from the registry call;
- replacing the workspace `PostToolUse` registration with an unrelated object containing the same strings;
- replacing the lint hook with `process.exit(0)`;
- accepted and prohibited transcripts both preserve the documented fail-open exit 0 contract;
  accepted input produces no diagnostic, while prohibited “type I voted” input produces the exact
  session-local diagnostic. The guard fails when either behavior is absent.

- [ ] **Step 2: Confirm RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/agent-decision-polls-guard.test.ts --pool=forks --fileParallelism=false
```

Expected: current anchor implementation incorrectly passes at least the comment/string/object mutations.

- [ ] **Step 3: Implement structural and executable checks**

Parse TypeScript with `createSourceFile`. Match the guidance declaration and runtime reference, the MCP schema description call, the registry wrapper call, and the workspace hook registration object by AST kind and property/callee relationships. Execute the lint hook twice through `spawnSync` with an isolated home and bounded fixture input, `timeout: 2_000`, `killSignal: 'SIGKILL'`, and a 1 MiB output cap: one accepted transcript and one prohibited transcript. Require exit 0 for both because the tracked hook is a fail-open PostToolUse diagnostic; prove behavior through absence/presence of the exact session-local finding. Treat spawn errors, timeouts, signals, missing status, output overflow, or a missing/incorrect diagnostic as findings rather than pass.

Documentation references remain textual because they are documentation promises, but code and hook behavior cannot be satisfied by textual anchors.

- [ ] **Step 4: Run GREEN and commit Task 5**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/agent-decision-polls-guard.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-node.sh scripts/agent-decision-polls-guard.ts
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
git add scripts/agent-decision-polls-guard.ts tests/scripts/agent-decision-polls-guard.test.ts
git commit -m "fix(quality): verify decision poll behavior structurally"
```

---

### Task 6: Remove the proven production-orphaned delegation receipt API

**Files:**
- Modify: `src/runtimes/agent/route-events.ts`
- Modify: `tests/runtimes/agent/route-events.test.ts`
- Test: `tests/scripts/semantic-quality-check.test.ts`

**Interfaces:**
- Consumes: Task 3 semantic guard output proving `emitDelegationReceipt` has no production root path.
- Produces: unchanged `ModelRouteEvent`, `deriveChatScope`, and `emitRouteEvent` public behavior; removes `DelegationReason`, `DelegationReceipt`, `emitDelegationReceipt`, and their private validation constants/functions.

- [ ] **Step 1: Add a regression assertion for the existing orphan**

In `tests/scripts/semantic-quality-check.test.ts`, inspect the current tree in `tree` scope and assert that the report identifies `src/runtimes/agent/route-events.ts` as containing a production-unowned exported runtime surface only if export-level inventory is enabled. The module itself is reachable, so this assertion must exercise the export inventory—not fabricate a disconnected module.

- [ ] **Step 2: Confirm the orphan evidence before deletion**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-quality-check.test.ts -t "delegation receipt" --pool=forks --fileParallelism=false
```

Expected: PASS and receipt evidence naming `emitDelegationReceipt`; if the export has gained a real caller by execution time, stop this task and update the specification instead of deleting it.

- [ ] **Step 3: Remove the isolated API and tests**

Delete these exact declarations from `route-events.ts`: `DelegationReason`, `DELEGATION_REASONS`, `DelegationReceipt`, `receiptProblem`, and `emitDelegationReceipt`. Remove their imports, receipt factory, and `describe('emitDelegationReceipt', ...)` block from the test. Do not change route-event types, retention, validation, or append behavior.

- [ ] **Step 4: Verify route behavior and commit Task 6**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/runtimes/agent/route-events.test.ts tests/scripts/semantic-quality-check.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run typecheck:all
git add src/runtimes/agent/route-events.ts tests/runtimes/agent/route-events.test.ts tests/scripts/semantic-quality-check.test.ts
git commit -m "refactor(agent): remove orphaned delegation receipt API"
```

---

### Task 7: Reuse the production engine and wire shadow feedback locally and in CI

**Files:**
- Modify: `scripts/experiments/semantic-boundary-eval.ts`
- Modify: `tests/scripts/semantic-boundary-eval.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/quality.yml`
- Modify: `scripts/safeguard-diagnostics.ts`
- Modify: `tests/scripts/safeguard-diagnostics.test.ts`
- Modify: `tests/scripts/pre-push-guard.test.ts`
- Modify: `docs/public-surface.md`

**Interfaces:**
- Consumes: Tasks 1–5 production commands and receipt schema.
- Produces package scripts:

```json
{
  "guard:semantic-quality": "bash scripts/run-with-pinned-node.sh scripts/semantic-quality-check.ts",
  "verify:semantic": "npm run guard:semantic-quality -- --mode enforce",
  "verify:semantic:shadow": "npm run guard:semantic-quality -- --mode shadow"
}
```

- [ ] **Step 1: Write composition and reuse tests**

Add assertions that:

- the experiment imports `buildModuleGraph`, `analyzeReachability`, and receipt helpers from `scripts/lib/semantic-quality/` rather than declaring its own copies;
- `verify:push:branch` and `verify:release` invoke `npm run verify:semantic:shadow` before `npm test` or coverage;
- safeguard diagnostics require the same ordering;
- Quality contains exactly one `Semantic quality (shadow)` step before the test-integrity/plugin and expensive suite steps;
- the workflow passes `--base "origin/$GITHUB_BASE_REF"` for PRs and `--base HEAD^` for main pushes;
- CI writes its receipt under `${RUNNER_TEMP}` and appends the human summary to `$GITHUB_STEP_SUMMARY` without uploading or commenting;
- the workflow remains `permissions: contents: read` and does not add `pull_request_target`.

- [ ] **Step 2: Confirm RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-boundary-eval.test.ts tests/scripts/safeguard-diagnostics.test.ts tests/scripts/pre-push-guard.test.ts --pool=forks --fileParallelism=false
```

Expected: new composition assertions FAIL because no production semantic command is wired.

- [ ] **Step 3: Replace experiment duplicates with imports**

Move only generic module-graph and receipt behavior out of the evaluator. Leave experiment-only content fingerprint/history/provenance rules in the experiment file for later tranches. The locked 40-case and 18-case holdout scores must remain unchanged.

- [ ] **Step 4: Wire package and workflow shadow mode**

Add the three scripts exactly as defined above. Add `npm run verify:semantic:shadow` before expensive tests in `verify:push:branch` and `verify:release`. In Quality, run only on pinned Node `24.x` to avoid duplicate semantic observations from the matrix:

```yaml
- name: Semantic quality (shadow)
  if: matrix.node == '24.x'
  env:
    SEMANTIC_RECEIPT: ${{ runner.temp }}/semantic-quality.json
  run: |
    if [ -n "${GITHUB_BASE_REF:-}" ]; then
      base="origin/$GITHUB_BASE_REF"
    else
      base="HEAD^"
    fi
    npm run guard:semantic-quality -- --mode shadow --base "$base" --receipt "$SEMANTIC_RECEIPT"
    node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.env.SEMANTIC_RECEIPT,"utf8")); process.stdout.write(`### Semantic quality (shadow)\n\nDecision: **${r.decision}**\n\nFindings: ${r.findings.length}\n`)' >> "$GITHUB_STEP_SUMMARY"
```

Do not add a new job, required context, artifact upload, comment, label, or token permission in PR A.

- [ ] **Step 5: Document the public command surface**

Add `guard:semantic-quality`, `verify:semantic`, and `verify:semantic:shadow` to `docs/public-surface.md`. State that `verify:semantic:shadow` is composed into local/CI gates, `verify:semantic` is manual until promotion, receipts live under Git metadata locally, and shadow mode may report a would-block decision while exiting zero.

- [ ] **Step 6: Run evaluator, composition, and workflow guards GREEN**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-boundary-eval.test.ts tests/scripts/safeguard-diagnostics.test.ts tests/scripts/pre-push-guard.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-node.sh scripts/experiments/semantic-boundary-eval.ts --engine baseline --format json
bash scripts/run-with-pinned-node.sh scripts/experiments/semantic-boundary-eval.ts --engine candidate --verify-git --format json
bash scripts/run-with-pinned-node.sh scripts/experiments/semantic-boundary-eval.ts --engine candidate --verify-git --corpus tests/fixtures/semantic-boundary-eval/holdout.json --format json
```

Expected: tests PASS; baseline remains 13/40; candidate remains 40/40; frozen holdout remains 18/18; zero candidate false blocks.

- [ ] **Step 7: Commit Task 7**

```bash
git add scripts/experiments/semantic-boundary-eval.ts tests/scripts/semantic-boundary-eval.test.ts package.json .github/workflows/quality.yml scripts/safeguard-diagnostics.ts tests/scripts/safeguard-diagnostics.test.ts tests/scripts/pre-push-guard.test.ts docs/public-surface.md
git commit -m "ci(quality): report semantic findings in shadow mode"
```

---

### Task 8: Measure the tranche and write the promotion packet

**Files:**
- Modify: `docs/superpowers/handoffs/2026-07-15-semantic-boundary-hygiene-implementation-notes.md`
- Modify: `docs/publication-audit.md`
- Regenerate: `docs/work-index.json`
- Regenerate: `docs/work-index.md`

**Interfaces:**
- Consumes: all prior task receipts, tests, and timings.
- Produces: a dated implementation evidence section; no enforcement promotion.

- [ ] **Step 1: Run the focused verification set**

```bash
loadgate --label semantic-foundation-tests --max-wait 120 -- bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-module-graph.test.ts tests/scripts/semantic-quality-policy.test.ts tests/scripts/semantic-quality-check.test.ts tests/scripts/guard-test-coverage-check.test.ts tests/scripts/agent-decision-polls-guard.test.ts tests/scripts/semantic-boundary-eval.test.ts tests/scripts/safeguard-diagnostics.test.ts tests/scripts/pre-push-guard.test.ts tests/runtimes/agent/route-events.test.ts --pool=forks --fileParallelism=false
loadgate --label semantic-foundation-types --max-wait 120 -- bash -lc 'bash scripts/run-with-pinned-npm.sh run typecheck:scripts && bash scripts/run-with-pinned-npm.sh run typecheck:all'
```

Expected: all listed files PASS and both typechecks exit 0. A loadgate admission timeout with `--strict`, a signal, or masked command failure is inconclusive, not pass.

- [ ] **Step 2: Measure cold and warm semantic duration**

Run the shadow command 10 times under loadgate against the same exact head/base. Record each wall time, host load, head OID, base OID, and whether Git object caches were warm. Do not set a production timeout from a single run. Report median and p95 separately for local and CI observations.

- [ ] **Step 3: Capture shadow inventory**

Record:

- number of added/renamed block findings;
- number of modified/full-tree warnings;
- semantic companion-test gaps;
- decision-poll structural/executable findings;
- false-block review outcomes;
- whether a subsequent agent attempt corrected the cited path or repeated it.

Do not quote unbounded GitHub comment bodies or include credentials. Link source artifacts instead.

- [ ] **Step 4: Run documentation and repository guards**

```bash
bash scripts/run-with-pinned-npm.sh run work-index:regen
bash scripts/run-with-pinned-npm.sh run guard:publication:staged
bash scripts/run-with-pinned-npm.sh run guard:work-index
bash scripts/run-with-pinned-npm.sh run guard:doc-drift
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
bash scripts/run-with-pinned-npm.sh run guard:safeguard-diagnostics
git diff --check
```

Expected: all guards exit 0 and work-index inconsistencies are empty.

- [ ] **Step 5: Run the complete branch gate**

```bash
loadgate --label semantic-foundation-branch --max-wait 120 -- bash scripts/run-with-pinned-npm.sh run verify:push:branch
```

Expected: exit 0. If interrupted, timed out, load-gate strict admission fails, or any subprocess result is masked, report the run as inconclusive and preserve the last confirmed phase.

- [ ] **Step 6: Update notes and commit the evidence packet**

Update the implementation notes with exact commands, exit codes, counts, timings, limitations, and the decision to remain shadow-only. Then:

```bash
git add docs/superpowers/handoffs/2026-07-15-semantic-boundary-hygiene-implementation-notes.md docs/publication-audit.md docs/work-index.json docs/work-index.md
git commit -m "docs(quality): record semantic foundation evidence"
```

---

## Plan Self-Review Checklist

- [x] Every PR A requirement in the specification maps to a task above.
- [x] No history-provider, supply-chain migration, external producer, pre-commit adapter, watchdog, ruleset, or GitHub mutation work leaked into PR A.
- [x] The experiment and production engine do not retain duplicate semantic graph or receipt logic.
- [x] Every new block-capable rule has unsafe, legitimate, and false-positive fixtures.
- [x] Shadow decision and process exit semantics are tested independently.
- [x] All exact paths, type names, CLI arguments, commands, and commit boundaries agree across tasks.
- [x] No placeholder text or broad “add tests/error handling” step remains.
- [x] The final handoff explicitly says production enforcement is not promoted.

## Execution Handoff

Execute this plan inline with `superpowers:executing-plans` unless a later owner request explicitly authorizes an available multi-agent/tmup lane. The current Codex session has no tmup tool, so no SDLC runner/sentinel receipts exist for this documentation pass. Before implementation, confirm the intended base branch and preserve the experiment branch; do not delete a branch as superseded without `git range-diff` and `git cherry -v` evidence.
