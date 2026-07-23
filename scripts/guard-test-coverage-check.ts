import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

/**
 * Meta-guard: every guard-family script under `scripts/` must ship a companion
 * test that is actually wired into the `verify:push:branch` gate.
 *
 * The public-surface-drift check already forces each `guard:*` npm script to
 * carry a row in `docs/public-surface.md`, but NOTHING forced the guard to ship
 * a test that runs in the pre-push gate. A guard could therefore ship entirely
 * untested. This guard closes that gap.
 *
 * A guard PASSES when EITHER:
 *   (a) its companion test file exists under `tests/scripts/` AND that test's
 *       path appears in the `verify:push:branch` script string in package.json
 *       (so the test actually runs in the gate); OR
 *   (b) the guard carries a top-of-file `// meta-guard:no-test <reason>` comment
 *       opting out (for guards genuinely covered by a broader suite test).
 *
 * Companion-test resolution: a guard `scripts/<name>.ts` maps to
 * `tests/scripts/<name>.test.ts`. As a documented alias, a `check-<x>.ts` guard
 * may instead ship `tests/scripts/<x>.test.ts` (the `check-` prefix dropped) —
 * an established convention in this repo (e.g. `check-node-pin-consistency.ts`
 * is covered by `tests/scripts/node-pin-consistency.test.ts`).
 */

export interface GuardTestCoverageOptions {
  cwd?: string;
  semanticMode?: 'shadow' | 'enforce';
}

export type GuardTestCoverageReason =
  | 'no-test'
  | 'test-not-wired'
  | 'test-does-not-import-or-invoke-guard'
  | 'test-does-not-exercise-failure';

export interface GuardCoverageGap {
  /** Guard script path relative to repo root, e.g. `scripts/repo-hygiene-guard.ts`. */
  guard: string;
  /** Why the guard failed coverage. */
  reason: GuardTestCoverageReason;
  /** Companion test path we looked for / found, relative to repo root. */
  expectedTest: string;
  /** Contextual correction detail for semantic proof gaps. */
  detail?: string;
}

export interface GuardAllowlistEntry {
  guard: string;
  reason: string;
}

export interface GuardCoverageResult {
  /** Guards that pass (have a wired companion test). */
  covered: string[];
  /** Guards opted out via `// meta-guard:no-test <reason>`. */
  allowlisted: GuardAllowlistEntry[];
  /** Guards missing a wired companion test (failures). */
  gaps: GuardCoverageGap[];
  /** Wired tests whose AST does not prove a guard failure path. */
  semanticGaps: GuardCoverageGap[];
}

const SCRIPTS_DIR = 'scripts';
const TESTS_DIR = 'tests/scripts';
const ALLOWLIST_PATTERN = /^\s*\/\/\s*meta-guard:no-test\s+(.+?)\s*$/m;

/**
 * Enumerate guard-family scripts: `scripts/*guard*.ts` plus `scripts/check-*.ts`.
 * Type-declaration files and the meta-guard's own helpers are folded in naturally
 * because the meta-guard itself (`guard-test-coverage-check.ts`) matches the
 * `*guard*` glob and so is held to the same standard.
 */
export function enumerateGuardScripts(cwd: string): string[] {
  const dir = path.join(cwd, SCRIPTS_DIR);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    const detail = err instanceof Error && err.message ? `: ${err.message}` : '';
    throw new Error(`unable to scan guard scripts directory ${dir}${detail}`);
  }
  const guards = entries.filter((name) => {
    if (!name.endsWith('.ts')) return false;
    if (name.endsWith('.d.ts')) return false;
    return name.includes('guard') || name.startsWith('check-');
  });
  guards.sort();
  return guards.map((name) => `${SCRIPTS_DIR}/${name}`);
}

/**
 * Candidate companion-test paths (repo-relative) for a guard, in priority order.
 * Primary: same basename. Alias: drop a leading `check-` prefix.
 */
export function companionTestCandidates(guardRelPath: string): string[] {
  const base = path.basename(guardRelPath).replace(/\.ts$/, '');
  const candidates = [`${TESTS_DIR}/${base}.test.ts`];
  if (base.startsWith('check-')) {
    candidates.push(`${TESTS_DIR}/${base.slice('check-'.length)}.test.ts`);
  }
  return candidates;
}

function readVerifyPushBranch(cwd: string): string {
  const pkgPath = path.join(cwd, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts?.['verify:push:branch'] ?? '';
}

function readAllowlistReason(absGuardPath: string): string | null {
  let text: string;
  try {
    text = readFileSync(absGuardPath, 'utf8');
  } catch {
    return null;
  }
  const match = text.match(ALLOWLIST_PATTERN);
  return match ? (match[1] ?? '').trim() || null : null;
}

interface TestBindings {
  guardDirect: Set<string>;
  guardNamespaces: Set<string>;
  childDirect: Set<string>;
  childNamespaces: Set<string>;
}

interface GuardInvocation {
  node: ts.CallExpression;
  kind: 'guard' | 'subprocess';
  resultName: string | null;
}

interface Expectation {
  subject: ts.Expression;
  chain: string[];
  arguments: readonly ts.Expression[];
}

function normalizeRelativePath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function importResolvesToGuard(
  testRelPath: string,
  specifier: string,
  guardRelPath: string,
): boolean {
  if (!specifier.startsWith('.')) return false;
  const joined = normalizeRelativePath(
    path.posix.join(path.posix.dirname(testRelPath), specifier),
  );
  const candidates = [joined];
  if (/\.(?:mjs|cjs|js)$/.test(joined)) {
    candidates.push(joined.replace(/\.(?:mjs|cjs|js)$/, '.ts'));
  } else if (!/\.[a-z0-9]+$/i.test(joined)) {
    candidates.push(`${joined}.ts`, `${joined}/index.ts`);
  }
  return candidates.includes(normalizeRelativePath(guardRelPath));
}

function collectTestBindings(
  sourceFile: ts.SourceFile,
  testRelPath: string,
  guardRelPath: string,
): TestBindings {
  const bindings: TestBindings = {
    guardDirect: new Set<string>(),
    guardNamespaces: new Set<string>(),
    childDirect: new Set<string>(),
    childNamespaces: new Set<string>(),
  };

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || statement.importClause?.isTypeOnly
      || !statement.importClause
      || !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const clause = statement.importClause;
    const specifier = statement.moduleSpecifier.text;
    const isGuard = importResolvesToGuard(testRelPath, specifier, guardRelPath);
    const isChildProcess = specifier === 'node:child_process' || specifier === 'child_process';
    if (!isGuard && !isChildProcess) continue;

    if (clause.name && isGuard) bindings.guardDirect.add(clause.name.text);
    const namedBindings = clause.namedBindings;
    if (!namedBindings) continue;
    if (ts.isNamespaceImport(namedBindings)) {
      if (isGuard) bindings.guardNamespaces.add(namedBindings.name.text);
      if (isChildProcess) bindings.childNamespaces.add(namedBindings.name.text);
      continue;
    }
    for (const element of namedBindings.elements) {
      if (element.isTypeOnly) continue;
      const importedName = element.propertyName?.text ?? element.name.text;
      if (isGuard) bindings.guardDirect.add(element.name.text);
      if (
        isChildProcess
        && (importedName === 'spawnSync' || importedName === 'execFileSync')
      ) {
        bindings.childDirect.add(element.name.text);
      }
    }
  }
  return bindings;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function testRootName(expression: ts.Expression): string | null {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) return current.text;
  if (ts.isPropertyAccessExpression(current)) return testRootName(current.expression);
  if (ts.isCallExpression(current)) return testRootName(current.expression);
  return null;
}

function hasDisabledTestModifier(expression: ts.Expression): boolean {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) {
    return current.name.text === 'skip'
      || current.name.text === 'skipIf'
      || current.name.text === 'todo'
      || hasDisabledTestModifier(current.expression);
  }
  if (ts.isCallExpression(current)) return hasDisabledTestModifier(current.expression);
  return false;
}

function isWithinTestBody(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current?.parent) {
    const parent: ts.Node = current.parent;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current))
      && ts.isCallExpression(parent)
      && parent.arguments.some((argument) => argument === current)
    ) {
      const root = testRootName(parent.expression);
      if (
        (root === 'it' || root === 'test')
        && !hasDisabledTestModifier(parent.expression)
      ) {
        return true;
      }
    }
    current = parent;
  }
  return false;
}

function directOrNamespaceCall(
  expression: ts.Expression,
  direct: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
  allowedNamespaceMembers?: ReadonlySet<string>,
): boolean {
  const callee = unwrapExpression(expression);
  if (ts.isIdentifier(callee)) return direct.has(callee.text);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const namespace = unwrapExpression(callee.expression);
  return (
    ts.isIdentifier(namespace)
    && namespaces.has(namespace.text)
    && (!allowedNamespaceMembers || allowedNamespaceMembers.has(callee.name.text))
  );
}

function containsExactGuardPath(node: ts.Node, guardRelPath: string): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (
      (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current))
      && normalizeRelativePath(current.text) === normalizeRelativePath(guardRelPath)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function assignedResultName(call: ts.CallExpression): string | null {
  let current: ts.Node = call;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isVariableDeclaration(parent) && parent.initializer && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
    if (ts.isStatement(parent) || ts.isSourceFile(parent)) return null;
    current = parent;
  }
  return null;
}

function collectGuardInvocations(
  sourceFile: ts.SourceFile,
  bindings: TestBindings,
  guardRelPath: string,
): GuardInvocation[] {
  const invocations: GuardInvocation[] = [];
  const childMembers = new Set(['spawnSync', 'execFileSync']);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isWithinTestBody(node)) {
      if (directOrNamespaceCall(node.expression, bindings.guardDirect, bindings.guardNamespaces)) {
        invocations.push({ node, kind: 'guard', resultName: assignedResultName(node) });
      } else if (
        directOrNamespaceCall(
          node.expression,
          bindings.childDirect,
          bindings.childNamespaces,
          childMembers,
        )
        && containsExactGuardPath(node, guardRelPath)
      ) {
        invocations.push({ node, kind: 'subprocess', resultName: assignedResultName(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return invocations;
}

function parseExpectation(call: ts.CallExpression): Expectation | null {
  const chain: string[] = [];
  let expression: ts.Expression = call.expression;
  while (ts.isPropertyAccessExpression(expression)) {
    chain.unshift(expression.name.text);
    expression = expression.expression;
  }
  // One or two arguments. Vitest's `expect(actual, 'message')` takes an assertion message
  // as its second argument, and requiring exactly one made that idiomatic form invisible
  // here — 54 of the 123 files in tests/scripts/ use it. A guard whose only failure
  // assertion carried a message was reported as `test-does-not-exercise-failure`, which
  // pushes the author toward the allowlist or toward deleting the message. The subject is
  // `arguments[0]` either way, so nothing downstream changes: this widens what gets
  // PARSED, never what counts as proof.
  if (
    !ts.isCallExpression(expression)
    || !ts.isIdentifier(expression.expression)
    || expression.expression.text !== 'expect'
    || expression.arguments.length < 1
    || expression.arguments.length > 2
  ) {
    return null;
  }
  const subject = expression.arguments[0];
  return subject ? { subject, chain, arguments: call.arguments } : null;
}

function containsNode(root: ts.Node, expected: ts.Node): boolean {
  if (root === expected) return true;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node === expected) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function expressionPath(expression: ts.Expression): { root: string; properties: string[] } | null {
  const properties: string[] = [];
  let current = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(current)) {
    properties.unshift(current.name.text);
    current = unwrapExpression(current.expression);
  }
  if (!ts.isIdentifier(current)) return null;
  return { root: current.text, properties };
}

function containsIdentifier(root: ts.Node, expected: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === expected) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function containsProperty(root: ts.Node, expected: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(node) && expected.has(node.name.text)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function containsMemberCall(root: ts.Node, member: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === member
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function linkedToInvocation(expectation: Expectation, invocation: GuardInvocation): boolean {
  if (containsNode(expectation.subject, invocation.node)) return true;
  if (!invocation.resultName) return false;
  const subjectPath = expressionPath(expectation.subject);
  return subjectPath?.root === invocation.resultName
    || containsIdentifier(expectation.subject, invocation.resultName);
}

function numericArgument(expectation: Expectation): number | null {
  const argument = expectation.arguments[0];
  if (!argument || !ts.isNumericLiteral(argument)) return null;
  return Number(argument.text);
}

function booleanArgument(expectation: Expectation): boolean | null {
  const argument = expectation.arguments[0];
  if (!argument) return null;
  if (argument.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (argument.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

function failureTextArgument(expectation: Expectation): boolean {
  const argument = expectation.arguments[0];
  if (!argument || !ts.isStringLiteralLike(argument)) return false;
  return /(fail|error|unsafe|invalid|reject|block|missing|violation)/i.test(argument.text);
}

function assertionProvesFailure(
  expectation: Expectation,
  invocation: GuardInvocation,
): boolean {
  if (!linkedToInvocation(expectation, invocation)) return false;
  const matcher = expectation.chain.at(-1);
  const modifiers = new Set(expectation.chain.slice(0, -1));
  const subjectPath = expressionPath(expectation.subject);
  const properties = subjectPath?.properties ?? [];
  const lastProperty = properties.at(-1);

  if (matcher === 'toThrow' || matcher === 'toThrowError') {
    return containsNode(expectation.subject, invocation.node);
  }

  if (invocation.kind === 'guard') {
    const collectionNames = new Set([
      'findings',
      'issues',
      'violations',
      'gaps',
      'mismatches',
      'errors',
      'problems',
      'failures',
      'orphans',
    ]);
    const directSubject = containsNode(expectation.subject, invocation.node);
    const collectionSignal = properties.some((property) => collectionNames.has(property))
      || (invocation.resultName !== null && collectionNames.has(invocation.resultName))
      || containsProperty(expectation.subject, collectionNames);
    const numeric = numericArgument(expectation);

    if ((directSubject || collectionSignal) && matcher === 'toHaveLength') {
      return (numeric !== null && numeric > 0) || (numeric === 0 && modifiers.has('not'));
    }
    if (
      (directSubject || collectionSignal)
      && (matcher === 'toEqual' || matcher === 'toStrictEqual')
      && expectation.arguments[0]
      && ts.isArrayLiteralExpression(expectation.arguments[0])
    ) {
      return expectation.arguments[0].elements.length > 0;
    }
    if (
      collectionSignal
      && containsMemberCall(expectation.subject, 'some')
      && (matcher === 'toBe' || matcher === 'toEqual')
    ) {
      const expected = booleanArgument(expectation);
      return expected === true || (expected === false && modifiers.has('not'));
    }
    if (collectionSignal && matcher === 'toContain' && expectation.arguments.length > 0) {
      return true;
    }
    if (
      directSubject
      && (matcher === 'toBe' || matcher === 'toEqual')
      && numeric !== null
    ) {
      return (numeric !== 0 && !modifiers.has('not'))
        || (numeric === 0 && modifiers.has('not'));
    }
    if (lastProperty === 'ok' && (matcher === 'toBe' || matcher === 'toEqual')) {
      const expected = booleanArgument(expectation);
      return expected === false || (expected === true && modifiers.has('not'));
    }
    if (properties.includes('findings')) {
      if (matcher === 'toHaveLength') {
        return (numeric !== null && numeric > 0) || (numeric === 0 && modifiers.has('not'));
      }
      if (lastProperty === 'length') {
        if (matcher === 'toBeGreaterThan') return numeric !== null && numeric >= 0;
        if (matcher === 'toBeGreaterThanOrEqual') return numeric !== null && numeric >= 1;
        if (matcher === 'toBe' || matcher === 'toEqual') {
          return (numeric !== null && numeric > 0) || (numeric === 0 && modifiers.has('not'));
        }
      }
    }
    return false;
  }

  if (lastProperty === 'status') {
    const numeric = numericArgument(expectation);
    if (matcher === 'toBe' || matcher === 'toEqual') {
      return (numeric !== null && numeric !== 0) || (numeric === 0 && modifiers.has('not'));
    }
    if (matcher === 'toBeGreaterThan') return numeric !== null && numeric >= 0;
    if (matcher === 'toBeLessThan') return numeric !== null && numeric <= 0;
  }
  if (
    (lastProperty === 'stderr' || lastProperty === 'stdout')
    && (matcher === 'toContain' || matcher === 'toMatch')
  ) {
    return failureTextArgument(expectation);
  }
  return false;
}

function hasFailureAssertion(
  sourceFile: ts.SourceFile,
  invocations: GuardInvocation[],
): boolean {
  let proved = false;
  const visit = (node: ts.Node): void => {
    if (proved) return;
    if (ts.isCallExpression(node) && isWithinTestBody(node)) {
      const expectation = parseExpectation(node);
      if (
        expectation
        && invocations.some((invocation) => assertionProvesFailure(expectation, invocation))
      ) {
        proved = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return proved;
}

function semanticCoverageGap(
  cwd: string,
  guardRelPath: string,
  testRelPath: string,
): GuardCoverageGap | null {
  const testText = readFileSync(path.join(cwd, testRelPath), 'utf8');
  const diagnostic = ts
    .transpileModule(testText, {
      fileName: testRelPath,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.Latest,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.Preserve,
      },
    })
    .diagnostics?.find((item) => item.category === ts.DiagnosticCategory.Error);
  if (diagnostic) {
    return {
      guard: guardRelPath,
      reason: 'test-does-not-import-or-invoke-guard',
      expectedTest: testRelPath,
      detail: `${testRelPath}: could not parse companion test: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
    };
  }

  const sourceFile = ts.createSourceFile(
    testRelPath,
    testText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const bindings = collectTestBindings(sourceFile, testRelPath, guardRelPath);
  const invocations = collectGuardInvocations(sourceFile, bindings, guardRelPath);
  if (invocations.length === 0) {
    return {
      guard: guardRelPath,
      reason: 'test-does-not-import-or-invoke-guard',
      expectedTest: testRelPath,
      detail: `${testRelPath}: import the exact guard module and invoke it inside an it/test body, or execute the exact guard path as a subprocess`,
    };
  }
  if (!hasFailureAssertion(sourceFile, invocations)) {
    return {
      guard: guardRelPath,
      reason: 'test-does-not-exercise-failure',
      expectedTest: testRelPath,
      detail: `${testRelPath}: link the guard result to an assertion proving ok=false, non-empty findings, throw/rejection, non-zero status, or bounded failure output`,
    };
  }
  return null;
}

export function findGuardsMissingTests(
  options: GuardTestCoverageOptions = {},
): GuardCoverageResult {
  const cwd = options.cwd ?? process.cwd();
  const verifyScript = readVerifyPushBranch(cwd);
  const guards = enumerateGuardScripts(cwd);

  const covered: string[] = [];
  const allowlisted: GuardAllowlistEntry[] = [];
  const gaps: GuardCoverageGap[] = [];
  const semanticGaps: GuardCoverageGap[] = [];

  for (const guard of guards) {
    const allowReason = readAllowlistReason(path.join(cwd, guard));
    if (allowReason) {
      allowlisted.push({ guard, reason: allowReason });
      continue;
    }

    const candidates = companionTestCandidates(guard);
    const existing = candidates.find((rel) => existsSync(path.join(cwd, rel)));

    if (!existing) {
      // No companion test under any recognised name.
      gaps.push({ guard, reason: 'no-test', expectedTest: candidates[0] ?? '' });
      continue;
    }

    // The test exists — but does it actually run in the pre-push gate?
    const wired = candidates.some((rel) => verifyScript.includes(rel));
    if (!wired) {
      gaps.push({ guard, reason: 'test-not-wired', expectedTest: existing });
      continue;
    }

    covered.push(guard);
    const semanticGap = semanticCoverageGap(cwd, guard, existing);
    if (semanticGap) semanticGaps.push(semanticGap);
  }

  return { covered, allowlisted, gaps, semanticGaps };
}

function printResult(result: GuardCoverageResult): void {
  for (const gap of result.gaps) {
    if (gap.reason === 'no-test') {
      console.error(
        `  MISSING-TEST ${gap.guard}: no companion test found (expected ${gap.expectedTest}). ` +
          `Add it under tests/scripts/ and wire its path into verify:push:branch, ` +
          `or add a top-of-file '// meta-guard:no-test <reason>' comment.`,
      );
    } else if (gap.reason === 'test-not-wired') {
      console.error(
        `  TEST-NOT-WIRED ${gap.guard}: companion test ${gap.expectedTest} exists but is ` +
          `not listed in the verify:push:branch 'npm test --' arg list, so it never runs in the gate.`,
      );
    }
  }
  for (const gap of result.semanticGaps) {
    console.error(
      `  SEMANTIC-TEST-GAP ${gap.guard}: ${gap.reason}; ${gap.detail ?? gap.expectedTest}`,
    );
  }
}

function parseSemanticMode(argv: string[]): 'shadow' | 'enforce' {
  let mode: 'shadow' | 'enforce' = 'shadow';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== '--semantic-mode') throw new Error(`unknown argument: ${String(arg)}`);
    const value = argv[index + 1];
    if (value !== 'shadow' && value !== 'enforce') {
      throw new Error('--semantic-mode must be shadow or enforce');
    }
    mode = value;
    index += 1;
  }
  return mode;
}

export function run(
  argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
  _env: NodeJS.ProcessEnv = process.env,
): GuardCoverageResult {
  const semanticMode = parseSemanticMode(argv);
  const result = findGuardsMissingTests({ cwd, semanticMode });
  if (result.gaps.length > 0) {
    console.error(
      `guard-test-coverage check failed: ${result.gaps.length} guard script(s) lack a wired companion test`,
    );
    printResult(result);
    process.exitCode = 1;
  } else {
    if (result.semanticGaps.length > 0) {
      console.error(
        `guard-test-coverage semantic ${semanticMode}: ${result.semanticGaps.length} wired companion test(s) lack failure-path proof`,
      );
      printResult(result);
      if (semanticMode === 'enforce') process.exitCode = 1;
    }
    const allowNote =
      result.allowlisted.length > 0
        ? ` (${result.allowlisted.length} allowlisted: ${result.allowlisted
            .map((entry) => `${entry.guard} — ${entry.reason}`)
            .join('; ')})`
        : '';
    console.log(
      `guard-test-coverage check passed: ${result.covered.length} guard(s) have a wired companion test${allowNote}` +
        (result.semanticGaps.length > 0 ? `; semantic gaps=${result.semanticGaps.length} (${semanticMode})` : ''),
    );
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
