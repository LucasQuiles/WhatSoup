#!/usr/bin/env node
/**
 * Fail closed when a production killSessionTree caller lacks a canonical
 * diagnostic source or when the reviewed caller inventory drifts.
 *
 * This is an AST guard, not a text search. It recognizes named imports,
 * renamed named imports, namespace property calls, and namespace element calls.
 * The import must resolve syntactically to the repository's canonical process-tree module;
 * unrelated local functions with the same name are ignored.
 */
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  PROCESS_TREE_DIAGNOSTIC_SOURCES,
  type ProcessTreeDiagnosticSource,
} from './lib/process-tree-diagnostic-contract.ts';
import { parseClosedOptions } from './lib/cli-args.ts';

const SCHEMA_VERSION = 'process-tree-diagnostic-adoption.v1';
const EXIT_PASS = 0;
const EXIT_BLOCK = 1;
const EXIT_INCONCLUSIVE = 2;

export type ProcessTreeDiagnosticAdoptionErrorKind =
  | 'PROCESS_TREE_ROOT_AUTHORITY_MISSING'
  | 'PROCESS_TREE_ROOT_AUTHORITY_INVALID'
  | 'PROCESS_TREE_DIAGNOSTIC_SOURCE_MISSING'
  | 'PROCESS_TREE_DIAGNOSTIC_SOURCE_INVALID'
  | 'PROCESS_TREE_OUTCOME_OBSERVER_MISSING'
  | 'PROCESS_TREE_OUTCOME_OBSERVER_INVALID'
  | 'PROCESS_TREE_DIVERGENCE_OBSERVER_MISSING'
  | 'PROCESS_TREE_DIVERGENCE_OBSERVER_INVALID'
  | 'PROCESS_TREE_OPTIONS_UNRESOLVED'
  | 'PROCESS_TREE_CANONICAL_REFERENCE_UNSUPPORTED'
  | 'PROCESS_TREE_CALLER_INVENTORY_DRIFT'
  | 'PROCESS_TREE_SOURCE_PARSE_FAILED'
  | 'PROCESS_TREE_SOURCE_READ_FAILED'
  | 'PROCESS_TREE_DIRECTORY_READ_FAILED'
  | 'PROCESS_TREE_SOURCE_ENTRY_UNSUPPORTED'
  | 'PROCESS_TREE_SCAN_EMPTY'
  | 'PROCESS_TREE_ARGUMENT_INVALID';

export interface ProcessTreeDiagnosticAdoptionFinding {
  readonly kind: ProcessTreeDiagnosticAdoptionErrorKind;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly hint: string;
  readonly retryable: boolean;
}

interface ProcessTreeCallSite {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly rootAuthority: boolean;
  readonly source: ProcessTreeDiagnosticSource | null;
  readonly outcomeObserver: boolean;
  readonly divergenceObserver: boolean;
}

interface ProcessTreeSourceResolution {
  readonly canonicalExportsBySpecifier?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly canonicalExportsByFile?: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface ProcessTreeDiagnosticAdoptionSourceScan {
  readonly callsExamined: number;
  readonly findings: ProcessTreeDiagnosticAdoptionFinding[];
  readonly callSites?: readonly ProcessTreeCallSite[];
}

export interface ProcessTreeDiagnosticAdoptionRepoScan {
  readonly filesExamined: number;
  readonly callsExamined: number;
  readonly findings: ProcessTreeDiagnosticAdoptionFinding[];
  readonly sourceCounts: Readonly<Record<ProcessTreeDiagnosticSource, number>>;
  readonly callSites: readonly ProcessTreeCallSite[];
}

export interface ProcessTreeDiagnosticAdoptionIo {
  readonly readdir: (directory: string) => Dirent[];
  readonly stat: (file: string) => Stats;
  readonly readText: (file: string) => string;
}

const DEFAULT_IO: ProcessTreeDiagnosticAdoptionIo = {
  readdir: (directory) => readdirSync(directory, { withFileTypes: true }),
  stat: (file) => lstatSync(file),
  readText: (file) => readFileSync(file, 'utf8'),
};

const CANONICAL_PROCESS_TREE_FILE = 'src/runtimes/agent/process-tree.ts';

const EXPECTED_INVENTORY: Readonly<
  Record<string, Readonly<Partial<Record<ProcessTreeDiagnosticSource, number>>>>
> = {
  'src/runtimes/agent/session.ts': { session_shutdown: 1 },
  'src/runtimes/agent/runtime.ts': {
    stale_session_sweep: 1,
    ownership_loss_cleanup: 1,
  },
};

function normalizePath(value: string): string {
  return value.split(path.sep).join('/');
}

function localTypeScriptModuleCandidates(fromFile: string, specifier: string): string[] {
  if (!specifier.startsWith('.')) return [];
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(normalizePath(fromFile)), specifier),
  );
  const withoutRuntimeExtension = base.replace(/\.(?:[cm]?js|ts)$/, '');
  return base.endsWith('.ts')
    ? [base]
    : [`${withoutRuntimeExtension}.ts`, path.posix.join(withoutRuntimeExtension, 'index.ts')];
}

function isCanonicalProcessTreeImport(fromFile: string, specifier: string): boolean {
  return localTypeScriptModuleCandidates(fromFile, specifier)
    .includes(CANONICAL_PROCESS_TREE_FILE);
}

function literalText(expression: ts.Expression): string | null {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  return null;
}

function location(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): Pick<ProcessTreeCallSite, 'line' | 'column'> {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: start.line + 1, column: start.character + 1 };
}

function finding(
  kind: ProcessTreeDiagnosticAdoptionErrorKind,
  file: string,
  where: Pick<ProcessTreeCallSite, 'line' | 'column'>,
  message: string,
  hint: string,
  retryable = false,
): ProcessTreeDiagnosticAdoptionFinding {
  return { kind, file, ...where, message, hint, retryable };
}

type EffectiveOptionProperty =
  | { readonly state: 'missing' | 'unresolved' }
  | { readonly state: 'present'; readonly property: ts.ObjectLiteralElementLike };

function effectiveOptionProperty(
  options: ts.Expression | undefined,
  name: string,
): EffectiveOptionProperty {
  if (!options || !ts.isObjectLiteralExpression(options)) return { state: 'unresolved' };
  let result: EffectiveOptionProperty = { state: 'missing' };
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) {
      result = { state: 'unresolved' };
      continue;
    }
    if (objectPropertyName(property) === name) result = { state: 'present', property };
  }
  return result;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAwaitExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function capturedRootAuthorityState(
  options: ts.Expression | undefined,
): 'missing' | 'invalid' | 'unresolved' | 'valid' {
  const effective = effectiveOptionProperty(options, 'rootAuthority');
  if (effective.state !== 'present') return effective.state;
  if (ts.isShorthandPropertyAssignment(effective.property)) return 'valid';
  if (!ts.isPropertyAssignment(effective.property)) return 'invalid';
  const value = unwrapExpression(effective.property.initializer);
  if (ts.isIdentifier(value)) return value.text === 'undefined' ? 'invalid' : 'valid';
  return ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)
    ? 'valid'
    : 'invalid';
}

function diagnosticSourceFromOptions(
  options: ts.Expression | undefined,
): { state: 'missing' | 'invalid' | 'unresolved' | 'valid'; source: ProcessTreeDiagnosticSource | null } {
  const effective = effectiveOptionProperty(options, 'diagnosticSource');
  if (effective.state !== 'present') return { state: effective.state, source: null };
  if (!ts.isPropertyAssignment(effective.property)) {
    return { state: 'invalid', source: null };
  }
  const value = literalText(effective.property.initializer);
  if (!value || !PROCESS_TREE_DIAGNOSTIC_SOURCES.includes(value as ProcessTreeDiagnosticSource)) {
    return { state: 'invalid', source: null };
  }
  return { state: 'valid', source: value as ProcessTreeDiagnosticSource };
}

function objectPropertyName(property: ts.ObjectLiteralElementLike): string | null {
  const name = property.name;
  if (!name) return null;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : null;
}

function bindingElementPropertyName(element: ts.BindingElement): string | null {
  const property = element.propertyName;
  if (!property) return ts.isIdentifier(element.name) ? element.name.text : null;
  if (
    ts.isIdentifier(property)
    || ts.isStringLiteral(property)
    || ts.isNumericLiteral(property)
  ) return property.text;
  return ts.isComputedPropertyName(property) ? literalText(property.expression) : null;
}

function observerState(
  options: ts.Expression | undefined,
  name: string,
): 'missing' | 'invalid' | 'unresolved' | 'valid' {
  const effective = effectiveOptionProperty(options, name);
  if (effective.state !== 'present') return effective.state;
  const property = effective.property;
  if (ts.isMethodDeclaration(property)) {
    return property.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      ? 'invalid'
      : 'valid';
  }
  if (
    ts.isPropertyAssignment(property)
    && (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer))
  ) {
    return property.initializer.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    ) ? 'invalid' : 'valid';
  }
  return 'invalid';
}

export function scanProcessTreeDiagnosticAdoptionSource(
  file: string,
  text: string,
  resolution: ProcessTreeSourceResolution = {},
): ProcessTreeDiagnosticAdoptionSourceScan {
  const normalizedFile = normalizePath(file);
  const sourceFile = ts.createSourceFile(
    normalizedFile,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const findings: ProcessTreeDiagnosticAdoptionFinding[] = [];
  const parseDiagnostics = (
    sourceFile as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    for (const diagnostic of parseDiagnostics) {
      const start = diagnostic.start ?? 0;
      const where = sourceFile.getLineAndCharacterOfPosition(start);
      findings.push(finding(
        'PROCESS_TREE_SOURCE_PARSE_FAILED',
        normalizedFile,
        { line: where.line + 1, column: where.character + 1 },
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        'Repair the TypeScript syntax before rerunning the adoption guard.',
        true,
      ));
    }
    return { callsExamined: 0, findings, callSites: [] };
  }

  const bindingIdentifier = (
    binding: ts.BindingName,
    name: string,
  ): ts.Identifier | null => {
    if (ts.isIdentifier(binding)) return binding.text === name ? binding : null;
    for (const element of binding.elements) {
      if (ts.isOmittedExpression(element)) continue;
      const found = bindingIdentifier(element.name, name);
      if (found) return found;
    }
    return null;
  };
  const statementBinding = (
    statement: ts.Statement,
    name: string,
    includeFunctionScopedVariables: boolean,
  ): ts.Identifier | null => {
    if (ts.isVariableStatement(statement)) {
      if (
        !includeFunctionScopedVariables
        && (statement.declarationList.flags & ts.NodeFlags.BlockScoped) === 0
      ) return null;
      for (const declaration of statement.declarationList.declarations) {
        const found = bindingIdentifier(declaration.name, name);
        if (found) return found;
      }
      return null;
    }
    if (
      (ts.isFunctionDeclaration(statement)
        || ts.isClassDeclaration(statement)
        || ts.isEnumDeclaration(statement))
      && statement.name?.text === name
    ) return statement.name;
    if (
      ts.isModuleDeclaration(statement)
      && ts.isIdentifier(statement.name)
      && statement.name.text === name
    ) return statement.name;
    if (ts.isImportEqualsDeclaration(statement) && statement.name.text === name) {
      return statement.name;
    }
    if (!ts.isImportDeclaration(statement)) return null;
    const clause = statement.importClause;
    if (clause?.name?.text === name) return clause.name;
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name) {
      return bindings.name;
    }
    if (bindings && ts.isNamedImports(bindings)) {
      return bindings.elements.find((element) => element.name.text === name)?.name ?? null;
    }
    return null;
  };
  const statementsBinding = (
    statements: ts.NodeArray<ts.Statement>,
    name: string,
    includeFunctionScopedVariables: boolean,
  ): ts.Identifier | null => {
    for (const statement of statements) {
      const found = statementBinding(statement, name, includeFunctionScopedVariables);
      if (found) return found;
    }
    return null;
  };
  const functionScopedVarBindings = new WeakMap<ts.Node, ReadonlyMap<string, ts.Identifier>>();
  const functionScopedVarBinding = (scope: ts.Node, name: string): ts.Identifier | null => {
    const cached = functionScopedVarBindings.get(scope);
    if (cached) return cached.get(name) ?? null;

    const bindings = new Map<string, ts.Identifier>();
    const collect = (binding: ts.BindingName): void => {
      if (ts.isIdentifier(binding)) {
        if (!bindings.has(binding.text)) bindings.set(binding.text, binding);
        return;
      }
      for (const element of binding.elements) {
        if (!ts.isOmittedExpression(element)) collect(element.name);
      }
    };
    const visit = (node: ts.Node): void => {
      if (
        node !== scope
        && (
          ts.isFunctionLike(node)
          || ts.isClassDeclaration(node)
          || ts.isClassExpression(node)
          || ts.isModuleDeclaration(node)
        )
      ) return;
      if (
        ts.isVariableDeclaration(node)
        && ts.isVariableDeclarationList(node.parent)
        && (node.parent.flags & ts.NodeFlags.BlockScoped) === 0
      ) {
        collect(node.name);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(scope, visit);
    functionScopedVarBindings.set(scope, bindings);
    return bindings.get(name) ?? null;
  };
  const resolveBinding = (identifier: ts.Identifier): ts.Identifier | null => {
    const name = identifier.text;
    let current: ts.Node | undefined = identifier.parent;
    while (current) {
      if (ts.isFunctionLike(current)) {
        for (const parameter of current.parameters) {
          const found = bindingIdentifier(parameter.name, name);
          if (found) return found;
        }
        if (ts.isFunctionExpression(current) && current.name?.text === name) {
          return current.name;
        }
        const found = functionScopedVarBinding(current, name);
        if (found) return found;
      }
      if (ts.isClassExpression(current) && current.name?.text === name) return current.name;
      if (ts.isCatchClause(current) && current.variableDeclaration) {
        const found = bindingIdentifier(current.variableDeclaration.name, name);
        if (found) return found;
      }
      if (
        (ts.isForStatement(current)
          || ts.isForInStatement(current)
          || ts.isForOfStatement(current))
        && current.initializer
        && ts.isVariableDeclarationList(current.initializer)
        && (current.initializer.flags & ts.NodeFlags.BlockScoped) !== 0
      ) {
        for (const declaration of current.initializer.declarations) {
          const found = bindingIdentifier(declaration.name, name);
          if (found) return found;
        }
      }
      if (ts.isCaseBlock(current)) {
        for (const clause of current.clauses) {
          const found = statementsBinding(clause.statements, name, false);
          if (found) return found;
        }
      }
      if (ts.isBlock(current)) {
        const found = statementsBinding(current.statements, name, false);
        if (found) return found;
      }
      if (ts.isModuleBlock(current) || ts.isSourceFile(current)) {
        const found = statementsBinding(current.statements, name, true)
          ?? functionScopedVarBinding(current, name);
        if (found) return found;
      }
      current = current.parent;
    }
    return null;
  };

  const staticModuleSpecifier = (
    input: ts.Expression,
    seen: ReadonlySet<ts.Identifier> = new Set(),
    depth = 0,
  ): string | null => {
    if (depth > 16) return null;
    const expression = unwrapExpression(input);
    const literal = literalText(expression);
    if (literal !== null) return literal.length <= 4_096 ? literal : null;
    if (
      ts.isBinaryExpression(expression)
      && expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = staticModuleSpecifier(expression.left, seen, depth + 1);
      const right = staticModuleSpecifier(expression.right, seen, depth + 1);
      if (left === null || right === null || left.length + right.length > 4_096) return null;
      return left + right;
    }
    if (ts.isTemplateExpression(expression)) {
      let value = expression.head.text;
      for (const span of expression.templateSpans) {
        const substitution = staticModuleSpecifier(span.expression, seen, depth + 1);
        if (substitution === null) return null;
        value += substitution + span.literal.text;
        if (value.length > 4_096) return null;
      }
      return value;
    }
    if (!ts.isIdentifier(expression)) return null;
    const binding = resolveBinding(expression);
    if (!binding || seen.has(binding)) return null;
    const declaration = binding.parent;
    if (
      !ts.isVariableDeclaration(declaration)
      || declaration.name !== binding
      || !declaration.initializer
      || !ts.isVariableDeclarationList(declaration.parent)
      || (declaration.parent.flags & ts.NodeFlags.Const) === 0
    ) return null;
    return staticModuleSpecifier(
      declaration.initializer,
      new Set([...seen, binding]),
      depth + 1,
    );
  };

  const dynamicImportCall = (input: ts.Expression): ts.CallExpression | null => {
    const expression = unwrapExpression(input);
    return ts.isCallExpression(expression)
      && expression.expression.kind === ts.SyntaxKind.ImportKeyword
      && expression.arguments.length >= 1
      && expression.arguments.length <= 2
      ? expression
      : null;
  };

  const directBindings = new Set<ts.Identifier>();
  const importedDirectBindings = new Set<ts.Identifier>();
  const shiftedDirectBindings = new Set<ts.Identifier>();
  const namespaceBindings = new Map<ts.Identifier, ReadonlySet<string>>();
  const objectBindings = new Map<ts.Identifier, ReadonlySet<string>>();
  const shiftedObjectBindings = new Map<ts.Identifier, ReadonlySet<string>>();
  const canonicalExportsForSpecifier = (
    specifier: string,
  ): ReadonlySet<string> | undefined => {
    if (isCanonicalProcessTreeImport(normalizedFile, specifier)) {
      return new Set(['killSessionTree']);
    }
    const exact = resolution.canonicalExportsBySpecifier?.get(specifier);
    if (exact !== undefined) return exact.size > 0 ? exact : undefined;
    for (const candidate of localTypeScriptModuleCandidates(normalizedFile, specifier)) {
      if (resolution.canonicalExportsByFile?.has(candidate)) {
        const canonicalExports = resolution.canonicalExportsByFile.get(candidate);
        return canonicalExports && canonicalExports.size > 0 ? canonicalExports : undefined;
      }
    }
    return undefined;
  };
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
    ) continue;
    const moduleSpecifier = statement.moduleSpecifier.text;
    const canonicalExports = canonicalExportsForSpecifier(moduleSpecifier);
    if (!canonicalExports || canonicalExports.size === 0) continue;
    const importClause = statement.importClause;
    if (importClause?.name && canonicalExports.has('default')) {
      directBindings.add(importClause.name);
      importedDirectBindings.add(importClause.name);
    }
    const bindings = importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaceBindings.set(bindings.name, canonicalExports);
      continue;
    }
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (canonicalExports.has((element.propertyName ?? element.name).text)) {
        directBindings.add(element.name);
        importedDirectBindings.add(element.name);
      }
    }
  }

  const unwrap = unwrapExpression;

  const canonicalDynamicImportExports = (
    dynamicImport: ts.CallExpression,
  ): ReadonlySet<string> | undefined => {
    const specifier = staticModuleSpecifier(dynamicImport.arguments[0]!);
    return specifier === null ? undefined : canonicalExportsForSpecifier(specifier);
  };

  const namespaceForExpression = (expression: ts.Expression): ReadonlySet<string> | undefined => {
    const current = unwrap(expression);
    if (ts.isIdentifier(current)) {
      const binding = resolveBinding(current);
      return binding ? namespaceBindings.get(binding) : undefined;
    }
    if (
      ts.isCallExpression(current)
      && dynamicImportCall(current) === current
    ) {
      return canonicalDynamicImportExports(current);
    }
    return undefined;
  };

  const canonicalReference = (input: ts.Expression): boolean => {
    const expression = unwrap(input);
    if (ts.isIdentifier(expression)) {
      const binding = resolveBinding(expression);
      return binding !== null && directBindings.has(binding);
    }
    if (ts.isCallExpression(expression)) {
      const callee = unwrap(expression.expression);
      if (
        ts.isPropertyAccessExpression(callee)
        && callee.name.text === 'bind'
      ) return canonicalReference(callee.expression);
      if (
        ts.isElementAccessExpression(callee)
        && callee.argumentExpression
        && literalText(callee.argumentExpression) === 'bind'
      ) return canonicalReference(callee.expression);
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const namespace = namespaceForExpression(expression.expression);
      if (namespace?.has(expression.name.text)) return true;
      if (!ts.isIdentifier(expression.expression)) return false;
      const binding = resolveBinding(expression.expression);
      return binding !== null
        && (objectBindings.get(binding)?.has(expression.name.text) ?? false);
    }
    if (
      ts.isElementAccessExpression(expression)
      && expression.argumentExpression
    ) {
      const member = literalText(expression.argumentExpression);
      return member !== null
        && (
          namespaceForExpression(expression.expression)?.has(member) === true
          || (ts.isIdentifier(expression.expression)
            && (() => {
              const binding = resolveBinding(expression.expression);
              return binding !== null && objectBindings.get(binding)?.has(member) === true;
            })())
        );
    }
    return false;
  };

  const shiftedCanonicalReference = (input: ts.Expression): boolean => {
    const expression = unwrap(input);
    if (ts.isIdentifier(expression)) {
      const binding = resolveBinding(expression);
      return binding !== null && shiftedDirectBindings.has(binding);
    }
    if (ts.isCallExpression(expression)) {
      const callee = unwrap(expression.expression);
      if (
        ts.isPropertyAccessExpression(callee)
        && callee.name.text === 'bind'
        && canonicalReference(callee.expression)
      ) {
        return expression.arguments.some((argument) => ts.isSpreadElement(argument))
          || expression.arguments.length > 1
          || shiftedCanonicalReference(callee.expression);
      }
      if (
        ts.isElementAccessExpression(callee)
        && callee.argumentExpression
        && literalText(callee.argumentExpression) === 'bind'
        && canonicalReference(callee.expression)
      ) {
        return expression.arguments.some((argument) => ts.isSpreadElement(argument))
          || expression.arguments.length > 1
          || shiftedCanonicalReference(callee.expression);
      }
    }
    if (
      ts.isPropertyAccessExpression(expression)
      && ts.isIdentifier(expression.expression)
    ) {
      const binding = resolveBinding(expression.expression);
      return binding !== null
        && (shiftedObjectBindings.get(binding)?.has(expression.name.text) ?? false);
    }
    if (
      ts.isElementAccessExpression(expression)
      && ts.isIdentifier(expression.expression)
      && expression.argumentExpression
    ) {
      const member = literalText(expression.argumentExpression);
      const binding = resolveBinding(expression.expression);
      return member !== null
        && binding !== null
        && (shiftedObjectBindings.get(binding)?.has(member) ?? false);
    }
    return false;
  };

  const canonicalObjectMembers = (
    expression: ts.Expression,
  ): ReadonlySet<string> | undefined => {
    const current = unwrap(expression);
    if (ts.isIdentifier(current)) {
      const binding = resolveBinding(current);
      return binding ? objectBindings.get(binding) : undefined;
    }
    if (!ts.isObjectLiteralExpression(current)) return undefined;
    const members = new Set<string>();
    for (const property of current.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = canonicalObjectMembers(property.expression);
        if (spread) for (const name of spread) members.add(name);
        continue;
      }
      const name = objectPropertyName(property);
      if (name === null) continue;
      if (
        (ts.isPropertyAssignment(property) && canonicalReference(property.initializer))
        || (ts.isShorthandPropertyAssignment(property) && canonicalReference(property.name))
      ) {
        members.add(name);
      }
    }
    return members.size > 0 ? members : undefined;
  };

  const shiftedCanonicalObjectMembers = (
    expression: ts.Expression,
  ): ReadonlySet<string> | undefined => {
    const current = unwrap(expression);
    if (ts.isIdentifier(current)) {
      const binding = resolveBinding(current);
      return binding ? shiftedObjectBindings.get(binding) : undefined;
    }
    if (!ts.isObjectLiteralExpression(current)) return undefined;
    const members = new Set<string>();
    for (const property of current.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = shiftedCanonicalObjectMembers(property.expression);
        if (spread) for (const name of spread) members.add(name);
        continue;
      }
      const name = objectPropertyName(property);
      if (name === null) continue;
      if (
        (ts.isPropertyAssignment(property) && shiftedCanonicalReference(property.initializer))
        || (
          ts.isShorthandPropertyAssignment(property)
          && shiftedCanonicalReference(property.name)
        )
      ) {
        members.add(name);
      }
    }
    return members.size > 0 ? members : undefined;
  };

  const addObjectMember = (
    bindings: Map<ts.Identifier, ReadonlySet<string>>,
    object: ts.Identifier,
    member: string,
  ): boolean => {
    const binding = resolveBinding(object);
    if (binding === null) return false;
    const existing = bindings.get(binding) ?? new Set<string>();
    if (existing.has(member)) return false;
    bindings.set(binding, new Set([...existing, member]));
    return true;
  };

  const mergeTrackedMembers = (
    bindings: Map<ts.Identifier, ReadonlySet<string>>,
    identifier: ts.Identifier,
    members: ReadonlySet<string>,
  ): boolean => {
    if (members.size === 0) return false;
    const binding = resolveBinding(identifier) ?? identifier;
    const existing = bindings.get(binding) ?? new Set<string>();
    const merged = new Set([...existing, ...members]);
    if (merged.size === existing.size) return false;
    bindings.set(binding, merged);
    return true;
  };

  let changed = true;
  while (changed) {
    changed = false;
    const visitAlias = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) {
          const binding = resolveBinding(node.name) ?? node.name;
          if (canonicalReference(node.initializer)) {
            if (!directBindings.has(binding)) {
              directBindings.add(binding);
              changed = true;
            }
            if (
              shiftedCanonicalReference(node.initializer)
              && !shiftedDirectBindings.has(binding)
            ) {
              shiftedDirectBindings.add(binding);
              changed = true;
            }
          } else {
            const namespace = namespaceForExpression(node.initializer);
            if (namespace && mergeTrackedMembers(namespaceBindings, binding, namespace)) {
              changed = true;
            }
            const members = canonicalObjectMembers(node.initializer);
            if (members && mergeTrackedMembers(objectBindings, binding, members)) changed = true;
            const shiftedMembers = shiftedCanonicalObjectMembers(node.initializer);
            if (
              shiftedMembers
              && mergeTrackedMembers(shiftedObjectBindings, binding, shiftedMembers)
            ) changed = true;
          }
        } else if (
          ts.isObjectBindingPattern(node.name)
        ) {
          const canonicalMembers = namespaceForExpression(node.initializer)
            ?? canonicalObjectMembers(node.initializer);
          const shiftedMembers = shiftedCanonicalObjectMembers(node.initializer);
          if (canonicalMembers || shiftedMembers) {
            const remainingCanonical = new Set(canonicalMembers ?? []);
            const remainingShifted = new Set(shiftedMembers ?? []);
            for (const element of node.name.elements) {
              if (element.dotDotDotToken) {
                if (ts.isIdentifier(element.name)) {
                  if (
                    mergeTrackedMembers(objectBindings, element.name, remainingCanonical)
                  ) changed = true;
                  if (
                    mergeTrackedMembers(
                      shiftedObjectBindings,
                      element.name,
                      remainingShifted,
                    )
                  ) changed = true;
                }
                continue;
              }
              const importedName = bindingElementPropertyName(element);
              if (importedName === null) continue;
              if (
                canonicalMembers?.has(importedName)
                && ts.isIdentifier(element.name)
              ) {
                const binding = resolveBinding(element.name) ?? element.name;
                if (!directBindings.has(binding)) {
                  directBindings.add(binding);
                  changed = true;
                }
              }
              if (
                shiftedMembers?.has(importedName)
                && ts.isIdentifier(element.name)
              ) {
                const binding = resolveBinding(element.name) ?? element.name;
                if (!shiftedDirectBindings.has(binding)) {
                  shiftedDirectBindings.add(binding);
                  changed = true;
                }
              }
              remainingCanonical.delete(importedName);
              remainingShifted.delete(importedName);
            }
          }
        }
      }
      if (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        if (ts.isIdentifier(node.left)) {
          const leftBinding = resolveBinding(node.left);
          if (canonicalReference(node.right)) {
            if (leftBinding !== null && !directBindings.has(leftBinding)) {
              directBindings.add(leftBinding);
              changed = true;
            }
            if (
              shiftedCanonicalReference(node.right)
              && leftBinding !== null
              && !shiftedDirectBindings.has(leftBinding)
            ) {
              shiftedDirectBindings.add(leftBinding);
              changed = true;
            }
          }
          const namespace = namespaceForExpression(node.right);
          if (namespace && leftBinding !== null && !namespaceBindings.has(leftBinding)) {
            namespaceBindings.set(leftBinding, namespace);
            changed = true;
          }
          const members = canonicalObjectMembers(node.right);
          if (members && leftBinding !== null && !objectBindings.has(leftBinding)) {
            objectBindings.set(leftBinding, members);
            changed = true;
          }
        } else if (canonicalReference(node.right)) {
          const memberTarget = ts.isPropertyAccessExpression(node.left)
            && ts.isIdentifier(node.left.expression)
            ? { object: node.left.expression, member: node.left.name.text }
            : ts.isElementAccessExpression(node.left)
              && ts.isIdentifier(node.left.expression)
              && node.left.argumentExpression
              && literalText(node.left.argumentExpression) !== null
                ? {
                  object: node.left.expression,
                  member: literalText(node.left.argumentExpression)!,
                }
              : null;
          if (memberTarget !== null) {
            if (addObjectMember(objectBindings, memberTarget.object, memberTarget.member)) {
              changed = true;
            }
            if (
              shiftedCanonicalReference(node.right)
              && addObjectMember(
                shiftedObjectBindings,
                memberTarget.object,
                memberTarget.member,
              )
            ) {
              changed = true;
            }
          }
        }
      }
      ts.forEachChild(node, visitAlias);
    };
    visitAlias(sourceFile);
  }

  const invocationMemberName = (expression: ts.Expression): string | null => {
    const current = unwrap(expression);
    if (ts.isPropertyAccessExpression(current)) return current.name.text;
    if (ts.isElementAccessExpression(current) && current.argumentExpression) {
      return literalText(current.argumentExpression);
    }
    return null;
  };

  const invocationReceiver = (expression: ts.Expression): ts.Expression | null => {
    const current = unwrap(expression);
    return ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)
      ? current.expression
      : null;
  };

  const canonicalInvocationOptions = (
    call: ts.CallExpression,
  ): ts.Expression | undefined | null => {
    if (canonicalReference(call.expression)) {
      return shiftedCanonicalReference(call.expression)
        || call.arguments.slice(0, 3).some((argument) => ts.isSpreadElement(argument))
        ? undefined
        : call.arguments[2];
    }

    const member = invocationMemberName(call.expression);
    const receiver = invocationReceiver(call.expression);
    if (!receiver || !canonicalReference(receiver)) return null;
    if (shiftedCanonicalReference(receiver)) return undefined;
    if (member === 'call') {
      return call.arguments.slice(0, 4).some((argument) => ts.isSpreadElement(argument))
        ? undefined
        : call.arguments[3];
    }
    if (member !== 'apply') return null;

    const argumentList = call.arguments[1];
    if (!argumentList) return undefined;
    const resolvedArgumentList = unwrap(argumentList);
    if (!ts.isArrayLiteralExpression(resolvedArgumentList)) return undefined;
    if (resolvedArgumentList.elements.some((element) => ts.isSpreadElement(element))) {
      return undefined;
    }
    const options = resolvedArgumentList.elements[2];
    return options && ts.isExpression(options) ? options : undefined;
  };

  const isTransparentReferenceParent = (node: ts.Expression): boolean => {
    const parent = node.parent;
    return (
      ts.isParenthesizedExpression(parent)
      || ts.isAwaitExpression(parent)
      || ts.isAsExpression(parent)
      || ts.isTypeAssertionExpression(parent)
      || ts.isNonNullExpression(parent)
    ) && parent.expression === node;
  };

  const isDeclarationIdentifier = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (
      (ts.isVariableDeclaration(parent)
        || ts.isParameter(parent)
        || ts.isFunctionDeclaration(parent)
        || ts.isFunctionExpression(parent)
        || ts.isClassDeclaration(parent)
        || ts.isClassExpression(parent)
        || ts.isEnumDeclaration(parent)
        || ts.isModuleDeclaration(parent)
        || ts.isImportEqualsDeclaration(parent))
      && parent.name === node
    ) return true;
    if (
      ts.isBindingElement(parent)
      && (parent.name === node || parent.propertyName === node)
    ) return true;
    if (
      (ts.isPropertyDeclaration(parent)
        || ts.isPropertySignature(parent)
        || ts.isPropertyAssignment(parent)
        || ts.isMethodDeclaration(parent)
        || ts.isMethodSignature(parent)
        || ts.isGetAccessorDeclaration(parent)
        || ts.isSetAccessorDeclaration(parent))
      && parent.name === node
    ) return true;
    if (
      (ts.isLabeledStatement(parent)
        || ts.isBreakStatement(parent)
        || ts.isContinueStatement(parent))
      && parent.label === node
    ) return true;
    return ts.isPropertyAccessExpression(parent) && parent.name === node;
  };

  const outerTrackedObjectLiteral = (
    input: ts.ObjectLiteralExpression,
  ): ts.ObjectLiteralExpression => {
    let current = input;
    while (
      ts.isSpreadAssignment(current.parent)
      && ts.isObjectLiteralExpression(current.parent.parent)
    ) {
      current = current.parent.parent;
    }
    return current;
  };

  const trackedObjectLiteralUse = (input: ts.ObjectLiteralExpression): boolean => {
    let current: ts.Expression = outerTrackedObjectLiteral(input);
    while (isTransparentReferenceParent(current)) current = current.parent as ts.Expression;
    const parent = current.parent;
    if (
      ts.isVariableDeclaration(parent)
      && parent.initializer === current
      && ts.isIdentifier(parent.name)
    ) {
      const binding = resolveBinding(parent.name) ?? parent.name;
      return objectBindings.has(binding);
    }
    if (
      ts.isBinaryExpression(parent)
      && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && parent.right === current
      && ts.isIdentifier(parent.left)
    ) {
      const binding = resolveBinding(parent.left);
      return binding !== null && objectBindings.has(binding);
    }
    return false;
  };

  const supportedCanonicalReferenceUse = (input: ts.Expression): boolean => {
    let expression = input;
    while (isTransparentReferenceParent(expression)) {
      expression = expression.parent as ts.Expression;
    }
    const parent = expression.parent;
    if (ts.isCallExpression(parent) && parent.expression === expression) {
      return canonicalInvocationOptions(parent) !== null;
    }
    if (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
      && parent.expression === expression
      && ts.isCallExpression(parent.parent)
      && parent.parent.expression === parent
    ) {
      const member = invocationMemberName(parent);
      return member === 'bind' || member === 'call' || member === 'apply';
    }
    if (
      ts.isVariableDeclaration(parent)
      && parent.initializer === expression
      && ts.isIdentifier(parent.name)
    ) {
      const binding = resolveBinding(parent.name) ?? parent.name;
      return directBindings.has(binding);
    }
    if (
      ts.isBinaryExpression(parent)
      && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && parent.right === expression
    ) {
      if (ts.isIdentifier(parent.left)) {
        const binding = resolveBinding(parent.left);
        return binding !== null && directBindings.has(binding);
      }
      const member = ts.isPropertyAccessExpression(parent.left)
        && ts.isIdentifier(parent.left.expression)
        ? { object: parent.left.expression, name: parent.left.name.text }
        : ts.isElementAccessExpression(parent.left)
          && ts.isIdentifier(parent.left.expression)
          && parent.left.argumentExpression
            ? {
              object: parent.left.expression,
              name: literalText(parent.left.argumentExpression),
            }
          : null;
      return member !== null
        && member.name !== null
        && (() => {
          const binding = resolveBinding(member.object);
          return binding !== null && (objectBindings.get(binding)?.has(member.name!) ?? false);
        })();
    }
    if (
      (ts.isPropertyAssignment(parent) && parent.initializer === expression)
      || (ts.isShorthandPropertyAssignment(parent) && parent.name === expression)
    ) {
      return ts.isObjectLiteralExpression(parent.parent)
        && trackedObjectLiteralUse(parent.parent);
    }
    return false;
  };

  const unsupportedReferencePositions = new Set<number>();
  const reportUnsupportedReference = (node: ts.Node): void => {
    const position = node.getStart(sourceFile);
    if (unsupportedReferencePositions.has(position)) return;
    unsupportedReferencePositions.add(position);
    findings.push(finding(
      'PROCESS_TREE_CANONICAL_REFERENCE_UNSUPPORTED',
      normalizedFile,
      location(sourceFile, node),
      'killSessionTree escapes through a value flow the adoption guard cannot prove.',
      'Use a direct call or a statically tracked alias, bind, or object member.',
    ));
  };
  const visitCanonicalExternalImportEquals = (node: ts.Node): void => {
    if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
    ) {
      const specifier = staticModuleSpecifier(node.moduleReference.expression);
      if (
        specifier !== null
        && (canonicalExportsForSpecifier(specifier)?.size ?? 0) > 0
      ) reportUnsupportedReference(node);
    }
    ts.forEachChild(node, visitCanonicalExternalImportEquals);
  };
  visitCanonicalExternalImportEquals(sourceFile);
  const visitCanonicalNamespaceMembers = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isVariableDeclarationList(node.parent)
      && ts.isVariableStatement(node.parent.parent)
      && ts.isModuleBlock(node.parent.parent.parent)
    ) {
      const inspectBinding = (name: ts.BindingName): boolean => {
        if (ts.isIdentifier(name)) {
          const binding = resolveBinding(name) ?? name;
          return directBindings.has(binding)
            || namespaceBindings.has(binding)
            || objectBindings.has(binding);
        }
        return name.elements.some((element) =>
          !ts.isOmittedExpression(element) && inspectBinding(element.name));
      };
      if (inspectBinding(node.name)) reportUnsupportedReference(node);
    }
    ts.forEachChild(node, visitCanonicalNamespaceMembers);
  };
  visitCanonicalNamespaceMembers(sourceFile);
  const visitCanonicalReferences = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node)
      || ts.isExportDeclaration(node)
      || ts.isInterfaceDeclaration(node)
      || ts.isTypeAliasDeclaration(node)
      || ts.isTypeNode(node)
    ) return;
    if (ts.isIdentifier(node) && isDeclarationIdentifier(node)) return;
    if (
      ts.isExpression(node)
      && canonicalReference(node)
      && !isTransparentReferenceParent(node)
      && !supportedCanonicalReferenceUse(node)
    ) {
      reportUnsupportedReference(node);
    }
    ts.forEachChild(node, visitCanonicalReferences);
  };
  visitCanonicalReferences(sourceFile);

  const canonicalContainerBinding = (identifier: ts.Identifier): ts.Identifier | null => {
    const binding = resolveBinding(identifier);
    return binding !== null
      && (namespaceBindings.has(binding) || objectBindings.has(binding))
      ? binding
      : null;
  };
  const supportedObjectBindingPattern = (
    pattern: ts.ObjectBindingPattern,
    canonicalMembers: ReadonlySet<string>,
  ): boolean => {
    const remaining = new Set(canonicalMembers);
    for (const element of pattern.elements) {
      if (element.dotDotDotToken) {
        if (remaining.size === 0) continue;
        if (!ts.isIdentifier(element.name)) return false;
        const binding = resolveBinding(element.name) ?? element.name;
        const tracked = objectBindings.get(binding);
        if (!tracked || [...remaining].some((member) => !tracked.has(member))) return false;
        continue;
      }
      const member = bindingElementPropertyName(element);
      if (member === null) return false;
      if (remaining.has(member)) {
        if (!ts.isIdentifier(element.name)) return false;
        const binding = resolveBinding(element.name) ?? element.name;
        if (!directBindings.has(binding)) return false;
      }
      remaining.delete(member);
    }
    return true;
  };
  const supportedCanonicalContainerUse = (
    identifier: ts.Identifier,
    binding: ts.Identifier,
  ): boolean => {
    const parent = identifier.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === identifier) return true;
    if (ts.isElementAccessExpression(parent) && parent.expression === identifier) {
      return parent.argumentExpression !== undefined
        && literalText(parent.argumentExpression) !== null;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === identifier) {
      if (ts.isIdentifier(parent.name)) {
        const target = resolveBinding(parent.name) ?? parent.name;
        return namespaceBindings.has(target) || objectBindings.has(target);
      }
      const members = namespaceBindings.get(binding) ?? objectBindings.get(binding);
      return ts.isObjectBindingPattern(parent.name)
        && members !== undefined
        && supportedObjectBindingPattern(parent.name, members);
    }
    if (
      ts.isBinaryExpression(parent)
      && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && parent.right === identifier
      && ts.isIdentifier(parent.left)
    ) {
      const target = resolveBinding(parent.left);
      return target !== null
        && (
          (namespaceBindings.has(binding) && namespaceBindings.has(target))
          || (objectBindings.has(binding) && objectBindings.has(target))
        );
    }
    if (
      ts.isSpreadAssignment(parent)
      && ts.isObjectLiteralExpression(parent.parent)
      && objectBindings.has(binding)
    ) return trackedObjectLiteralUse(parent.parent);
    return false;
  };
  const visitCanonicalContainers = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node)
      || ts.isInterfaceDeclaration(node)
      || ts.isTypeAliasDeclaration(node)
      || ts.isTypeNode(node)
    ) return;
    if (ts.isIdentifier(node) && !isDeclarationIdentifier(node)) {
      const binding = canonicalContainerBinding(node);
      if (binding !== null && !supportedCanonicalContainerUse(node, binding)) {
        reportUnsupportedReference(node);
      }
    }
    ts.forEachChild(node, visitCanonicalContainers);
  };
  visitCanonicalContainers(sourceFile);

  const supportedCanonicalDynamicImportUse = (
    dynamicImport: ts.CallExpression,
    canonicalExports: ReadonlySet<string>,
  ): boolean => {
    let expression: ts.Expression = dynamicImport;
    let awaited = false;
    while (isTransparentReferenceParent(expression)) {
      expression = expression.parent as ts.Expression;
      if (ts.isAwaitExpression(expression)) awaited = true;
    }
    if (!awaited) return false;

    const parent = expression.parent;
    if (ts.isVariableDeclaration(parent) && parent.initializer === expression) {
      if (ts.isIdentifier(parent.name)) {
        const binding = resolveBinding(parent.name) ?? parent.name;
        const tracked = namespaceBindings.get(binding);
        return tracked !== undefined
          && [...canonicalExports].every((member) => tracked.has(member));
      }
      return ts.isObjectBindingPattern(parent.name)
        && supportedObjectBindingPattern(parent.name, canonicalExports);
    }
    if (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
      && parent.expression === expression
    ) {
      const member = invocationMemberName(parent);
      if (member === null) return false;
      return !canonicalExports.has(member) || supportedCanonicalReferenceUse(parent);
    }
    return false;
  };
  const visitCanonicalDynamicImports = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && dynamicImportCall(node) === node) {
      const canonicalExports = canonicalDynamicImportExports(node);
      if (
        canonicalExports
        && !supportedCanonicalDynamicImportUse(node, canonicalExports)
      ) reportUnsupportedReference(node);

      if (staticModuleSpecifier(node.arguments[0]!) === null) {
        let expression: ts.Expression = node;
        let awaited = false;
        while (isTransparentReferenceParent(expression)) {
          expression = expression.parent as ts.Expression;
          if (ts.isAwaitExpression(expression)) awaited = true;
        }
        if (!(awaited && ts.isExpressionStatement(expression.parent))) {
          reportUnsupportedReference(node);
        }
      }
    }
    ts.forEachChild(node, visitCanonicalDynamicImports);
  };
  visitCanonicalDynamicImports(sourceFile);

  const hasExportModifier = (node: ts.Node & { readonly modifiers?: ts.NodeArray<ts.ModifierLike> }) =>
    node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const exportedBindings: ts.Identifier[] = [];
        const collectBindings = (name: ts.BindingName): void => {
          if (ts.isIdentifier(name)) {
            exportedBindings.push(name);
            return;
          }
          for (const element of name.elements) {
            if (!ts.isOmittedExpression(element)) collectBindings(element.name);
          }
        };
        collectBindings(declaration.name);
        for (const exported of exportedBindings) {
          if (
            (directBindings.has(exported) && !importedDirectBindings.has(exported))
            || namespaceBindings.has(exported)
            || objectBindings.has(exported)
          ) reportUnsupportedReference(exported);
        }
      }
      continue;
    }
    if (!ts.isExportDeclaration(statement)) continue;
    if (
      statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.exportClause
      && ts.isNamespaceExport(statement.exportClause)
      && (canonicalExportsForSpecifier(statement.moduleSpecifier.text)?.size ?? 0) > 0
    ) {
      reportUnsupportedReference(statement.exportClause);
      continue;
    }
    if (
      statement.moduleSpecifier
      || !statement.exportClause
      || !ts.isNamedExports(statement.exportClause)
    ) continue;
    for (const element of statement.exportClause.elements) {
      const local = element.propertyName ?? element.name;
      if (!ts.isIdentifier(local)) continue;
      const binding = resolveBinding(local);
      if (
        binding !== null
        && (
          (directBindings.has(binding) && !importedDirectBindings.has(binding))
          || namespaceBindings.has(binding)
          || objectBindings.has(binding)
        )
      ) reportUnsupportedReference(local);
    }
  }

  const callSites: ProcessTreeCallSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const options = canonicalInvocationOptions(node);
      if (options === null) {
        ts.forEachChild(node, visit);
        return;
      }
      const where = location(sourceFile, node);
      const rootAuthorityState = capturedRootAuthorityState(options);
      const diagnostic = diagnosticSourceFromOptions(options);
      const outcomeObserverState = observerState(options, 'onOutcome');
      const divergenceObserverState = observerState(options, 'onCgroupDivergence');
      const outcomeObserver = outcomeObserverState === 'valid';
      const divergenceObserver = divergenceObserverState === 'valid';
      callSites.push({
        file: normalizedFile,
        ...where,
        rootAuthority: rootAuthorityState === 'valid',
        source: diagnostic.source,
        outcomeObserver,
        divergenceObserver,
      });
      const optionsUnresolved = rootAuthorityState === 'unresolved'
        || diagnostic.state === 'unresolved'
        || outcomeObserverState === 'unresolved'
        || divergenceObserverState === 'unresolved';
      if (optionsUnresolved) {
        findings.push(finding(
          'PROCESS_TREE_OPTIONS_UNRESOLVED',
          normalizedFile,
          where,
          'killSessionTree options cannot be proven after expression or spread resolution.',
          'Keep production options inline and place every required property after the final spread.',
        ));
      } else if (rootAuthorityState === 'missing') {
        findings.push(finding(
          'PROCESS_TREE_ROOT_AUTHORITY_MISSING',
          normalizedFile,
          where,
          'killSessionTree call omits captured rootAuthority.',
          'Pass the spawn-time or classification-time rootAuthority retained by the lifecycle owner.',
        ));
      } else if (rootAuthorityState === 'invalid') {
        findings.push(finding(
          'PROCESS_TREE_ROOT_AUTHORITY_INVALID',
          normalizedFile,
          where,
          'killSessionTree rootAuthority is not a captured authority reference.',
          'Use a retained authority identifier or property; do not construct authority at the signal site.',
        ));
      }
      if (!optionsUnresolved && diagnostic.state === 'missing') {
        findings.push(finding(
          'PROCESS_TREE_DIAGNOSTIC_SOURCE_MISSING',
          normalizedFile,
          where,
          'killSessionTree call omits diagnosticSource.',
          `Add one canonical diagnosticSource: ${PROCESS_TREE_DIAGNOSTIC_SOURCES.join(', ')}.`,
        ));
      } else if (diagnostic.state === 'invalid') {
        findings.push(finding(
          'PROCESS_TREE_DIAGNOSTIC_SOURCE_INVALID',
          normalizedFile,
          where,
          'killSessionTree call uses a non-canonical or dynamic diagnosticSource.',
          `Use one literal diagnosticSource: ${PROCESS_TREE_DIAGNOSTIC_SOURCES.join(', ')}.`,
        ));
      }
      if (!optionsUnresolved && outcomeObserverState === 'missing') {
        findings.push(finding(
          'PROCESS_TREE_OUTCOME_OBSERVER_MISSING',
          normalizedFile,
          where,
          'killSessionTree call omits onOutcome.',
          'Add an onOutcome observer that preserves unresolved ambiguity semantics.',
        ));
      } else if (!optionsUnresolved && outcomeObserverState === 'invalid') {
        findings.push(finding(
          'PROCESS_TREE_OUTCOME_OBSERVER_INVALID',
          normalizedFile,
          where,
          'killSessionTree onOutcome is not an inline callable observer.',
          'Use an inline arrow function, function expression, or object method for onOutcome.',
        ));
      }
      if (!optionsUnresolved && divergenceObserverState === 'missing') {
        findings.push(finding(
          'PROCESS_TREE_DIVERGENCE_OBSERVER_MISSING',
          normalizedFile,
          where,
          'killSessionTree call omits onCgroupDivergence.',
          'Add an onCgroupDivergence observer with bounded diagnostic fields.',
        ));
      } else if (!optionsUnresolved && divergenceObserverState === 'invalid') {
        findings.push(finding(
          'PROCESS_TREE_DIVERGENCE_OBSERVER_INVALID',
          normalizedFile,
          where,
          'killSessionTree onCgroupDivergence is not an inline callable observer.',
          'Use an inline arrow function, function expression, or object method for onCgroupDivergence.',
        ));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { callsExamined: callSites.length, findings, callSites };
}

function walkTypeScriptFiles(
  root: string,
  directory: string,
  files: string[],
  findings: ProcessTreeDiagnosticAdoptionFinding[],
  io: ProcessTreeDiagnosticAdoptionIo,
): void {
  const relativeDirectory = normalizePath(path.relative(root, directory)) || '.';
  try {
    if (!io.stat(directory).isDirectory()) {
      findings.push(finding(
        'PROCESS_TREE_SOURCE_ENTRY_UNSUPPORTED',
        relativeDirectory,
        { line: 1, column: 1 },
        'Candidate source root is not a regular directory.',
        'Restore a stable regular source directory and rerun the adoption guard.',
        true,
      ));
      return;
    }
  } catch {
    findings.push(finding(
      'PROCESS_TREE_DIRECTORY_READ_FAILED',
      relativeDirectory,
      { line: 1, column: 1 },
      'Unable to inspect candidate source directory.',
      'Restore readable source-directory access and rerun the adoption guard.',
      true,
    ));
    return;
  }
  let entries;
  try {
    entries = io.readdir(directory);
  } catch {
    findings.push(finding(
      'PROCESS_TREE_DIRECTORY_READ_FAILED',
      relativeDirectory,
      { line: 1, column: 1 },
      'Unable to enumerate candidate source directory.',
      'Restore readable source-directory access and rerun the adoption guard.',
      true,
    ));
    return;
  }
  for (const entry of entries) {
    try {
      const name = entry.name;
      if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
      const absolute = path.join(directory, name);
      if (entry.isDirectory()) {
        walkTypeScriptFiles(root, absolute, files, findings, io);
      } else if (entry.isFile() && name.endsWith('.ts')) {
        files.push(normalizePath(path.relative(root, absolute)));
      } else if (!entry.isFile()) {
        findings.push(finding(
          'PROCESS_TREE_SOURCE_ENTRY_UNSUPPORTED',
          normalizePath(path.relative(root, absolute)),
          { line: 1, column: 1 },
          'Candidate source inventory contains an unsupported entry type.',
          'Replace the entry with a regular file or directory and rerun the adoption guard.',
          true,
        ));
      }
    } catch {
      const relativeDirectory = normalizePath(path.relative(root, directory)) || '.';
      findings.push(finding(
        'PROCESS_TREE_DIRECTORY_READ_FAILED',
        relativeDirectory,
        { line: 1, column: 1 },
        'Unable to inspect a candidate source-directory entry.',
        'Restore a stable readable source inventory and rerun the adoption guard.',
        true,
      ));
    }
  }
}

function resolveLocalSourceFile(
  fromFile: string,
  specifier: string,
  sources: ReadonlyMap<string, string>,
): string | null {
  return localTypeScriptModuleCandidates(fromFile, specifier)
    .find((candidate) => sources.has(candidate)) ?? null;
}

function parsedSources(sources: ReadonlyMap<string, string>): Map<string, ts.SourceFile> {
  return new Map([...sources].map(([file, text]) => [
    file,
    ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  ]));
}

function remoteCanonicalExports(
  file: string,
  specifier: string,
  sources: ReadonlyMap<string, string>,
  exportsByFile: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  if (isCanonicalProcessTreeImport(file, specifier)) return new Set(['killSessionTree']);
  const resolved = resolveLocalSourceFile(file, specifier, sources);
  return resolved ? exportsByFile.get(resolved) ?? new Set() : new Set();
}

function canonicalExportsByFile(
  sources: ReadonlyMap<string, string>,
  syntax: ReadonlyMap<string, ts.SourceFile>,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>(
    [...sources.keys()].map((file) => [
      file,
      new Set(file === CANONICAL_PROCESS_TREE_FILE ? ['killSessionTree'] : []),
    ]),
  );

  for (let pass = 0; pass <= sources.size; pass += 1) {
    let changed = false;
    for (const [file, sourceFile] of syntax) {
      const localCanonicalBindings = new Set<string>();
      for (const statement of sourceFile.statements) {
        if (
          !ts.isImportDeclaration(statement)
          || !ts.isStringLiteral(statement.moduleSpecifier)
        ) continue;
        const remote = remoteCanonicalExports(
          file,
          statement.moduleSpecifier.text,
          sources,
          result,
        );
        const importClause = statement.importClause;
        if (importClause?.name && remote.has('default')) {
          localCanonicalBindings.add(importClause.name.text);
        }
        const bindings = importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        for (const element of bindings.elements) {
          if (remote.has((element.propertyName ?? element.name).text)) {
            localCanonicalBindings.add(element.name.text);
          }
        }
      }

      const exported = result.get(file) ?? new Set<string>();
      for (const statement of sourceFile.statements) {
        if (!ts.isExportDeclaration(statement)) continue;
        let remote: ReadonlySet<string> | null = null;
        if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          remote = remoteCanonicalExports(
            file,
            statement.moduleSpecifier.text,
            sources,
            result,
          );
        }
        if (!statement.exportClause) {
          for (const name of remote ?? []) {
            if (!exported.has(name)) {
              exported.add(name);
              changed = true;
            }
          }
          continue;
        }
        if (!ts.isNamedExports(statement.exportClause)) continue;
        for (const element of statement.exportClause.elements) {
          const originalName = (element.propertyName ?? element.name).text;
          const isCanonical = remote
            ? remote.has(originalName)
            : localCanonicalBindings.has(originalName);
          if (isCanonical && !exported.has(element.name.text)) {
            exported.add(element.name.text);
            changed = true;
          }
        }
      }
      result.set(file, exported);
    }
    if (!changed) break;
  }
  return result;
}

function sourceResolution(
  exportsByFile: ReadonlyMap<string, ReadonlySet<string>>,
): ProcessTreeSourceResolution {
  return { canonicalExportsByFile: exportsByFile };
}

function inventoryKey(callSite: ProcessTreeCallSite): string {
  return `${callSite.file}\0${callSite.source ?? 'missing'}`;
}

function expectedInventoryCounts(): Map<string, number> {
  const expected = new Map<string, number>();
  for (const [file, sources] of Object.entries(EXPECTED_INVENTORY)) {
    for (const [source, count] of Object.entries(sources)) {
      if (count) expected.set(`${file}\0${source}`, count);
    }
  }
  return expected;
}

export function scanProcessTreeDiagnosticAdoptionRepo(
  root: string,
  ioOverrides: Partial<ProcessTreeDiagnosticAdoptionIo> = {},
): ProcessTreeDiagnosticAdoptionRepoScan {
  const io: ProcessTreeDiagnosticAdoptionIo = { ...DEFAULT_IO, ...ioOverrides };
  const candidates: string[] = [];
  const findings: ProcessTreeDiagnosticAdoptionFinding[] = [];
  walkTypeScriptFiles(root, path.join(root, 'src'), candidates, findings, io);
  const callSites: ProcessTreeCallSite[] = [];
  let filesExamined = 0;
  const sources = new Map<string, string>();

  for (const file of candidates.sort()) {
    let text: string;
    try {
      if (!io.stat(path.join(root, file)).isFile()) {
        findings.push(finding(
          'PROCESS_TREE_SOURCE_ENTRY_UNSUPPORTED',
          file,
          { line: 1, column: 1 },
          'Candidate source changed to an unsupported entry type during the scan.',
          'Restore a stable regular source file and rerun the adoption guard.',
          true,
        ));
        continue;
      }
      text = io.readText(path.join(root, file));
      filesExamined += 1;
      sources.set(file, text);
    } catch {
      findings.push(finding(
        'PROCESS_TREE_SOURCE_READ_FAILED',
        file,
        { line: 1, column: 1 },
        'Unable to read candidate source.',
        'Restore readable source permissions and rerun the adoption guard.',
        true,
      ));
      continue;
    }
  }

  const syntax = parsedSources(sources);
  const exportsByFile = canonicalExportsByFile(sources, syntax);
  for (const [file, text] of sources) {
    const scan = scanProcessTreeDiagnosticAdoptionSource(
      file,
      text,
      sourceResolution(exportsByFile),
    );
    findings.push(...scan.findings);
    callSites.push(...(scan.callSites ?? []));
  }

  if (filesExamined === 0 || callSites.length === 0) {
    findings.push(finding(
      'PROCESS_TREE_SCAN_EMPTY',
      'src',
      { line: 1, column: 1 },
      `Adoption scan examined ${filesExamined} source files and ${callSites.length} calls.`,
      'Run the guard from a complete WhatSoup checkout with the production source tree present.',
      true,
    ));
  }

  const actual = new Map<string, number>();
  for (const callSite of callSites) {
    const key = inventoryKey(callSite);
    actual.set(key, (actual.get(key) ?? 0) + 1);
  }
  const expected = expectedInventoryCounts();
  const keys = new Set([...expected.keys(), ...actual.keys()]);
  for (const key of [...keys].sort()) {
    const expectedCount = expected.get(key) ?? 0;
    const actualCount = actual.get(key) ?? 0;
    if (expectedCount === actualCount) continue;
    const [file, source] = key.split('\0');
    findings.push(finding(
      'PROCESS_TREE_CALLER_INVENTORY_DRIFT',
      file ?? 'src',
      { line: 1, column: 1 },
      `Expected ${expectedCount} ${source ?? 'unknown'} caller(s), observed ${actualCount}.`,
      'Review the new or removed lifecycle owner, update its diagnostics, tests, and this explicit inventory together.',
    ));
  }

  const sourceCounts = Object.fromEntries(
    PROCESS_TREE_DIAGNOSTIC_SOURCES.map((source) => [
      source,
      callSites.filter((callSite) => callSite.source === source).length,
    ]),
  ) as Record<ProcessTreeDiagnosticSource, number>;

  return {
    filesExamined,
    callsExamined: callSites.length,
    findings,
    sourceCounts,
    callSites,
  };
}

const EFFECT = Object.freeze({
  read_only: true,
  destructive: false,
  idempotent: true,
  open_world: false,
  supports_dry_run: false,
});

function schemaDocument(): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    command: 'guard:process-tree-diagnostics',
    effect: EFFECT,
    exit_codes: {
      '0': 'pass',
      '1': 'invariant violation',
      '2': 'inconclusive scan or invalid invocation',
    },
    formats: ['text', 'json'],
    diagnostic_sources: PROCESS_TREE_DIAGNOSTIC_SOURCES,
    error_kinds: [
      'PROCESS_TREE_ROOT_AUTHORITY_MISSING',
      'PROCESS_TREE_ROOT_AUTHORITY_INVALID',
      'PROCESS_TREE_DIAGNOSTIC_SOURCE_MISSING',
      'PROCESS_TREE_DIAGNOSTIC_SOURCE_INVALID',
      'PROCESS_TREE_OUTCOME_OBSERVER_MISSING',
      'PROCESS_TREE_OUTCOME_OBSERVER_INVALID',
      'PROCESS_TREE_DIVERGENCE_OBSERVER_MISSING',
      'PROCESS_TREE_DIVERGENCE_OBSERVER_INVALID',
      'PROCESS_TREE_OPTIONS_UNRESOLVED',
      'PROCESS_TREE_CANONICAL_REFERENCE_UNSUPPORTED',
      'PROCESS_TREE_CALLER_INVENTORY_DRIFT',
      'PROCESS_TREE_SOURCE_PARSE_FAILED',
      'PROCESS_TREE_SOURCE_READ_FAILED',
      'PROCESS_TREE_DIRECTORY_READ_FAILED',
      'PROCESS_TREE_SOURCE_ENTRY_UNSUPPORTED',
      'PROCESS_TREE_SCAN_EMPTY',
      'PROCESS_TREE_ARGUMENT_INVALID',
    ],
  };
}

function emitJson(document: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(document)}\n`);
}

function usage(): string {
  return [
    'usage: process-tree-diagnostic-adoption-guard [--root PATH] [--format text|json] [--verbose] [--schema]',
    '',
    'Read-only AST guard for production killSessionTree diagnostic adoption.',
  ].join('\n');
}

export function main(argv = process.argv.slice(2)): number {
  const parsed = parseClosedOptions(argv, {
    booleanOptions: ['--help', '-h', '--verbose', '--schema'],
    valueOptions: ['--root', '--format'],
  });
  const requestedFormat = parsed.values.get('--format')
    ?? (argv.includes('--format') && argv[argv.indexOf('--format') + 1] === 'json' ? 'json' : 'text');

  if (parsed.error || !['text', 'json'].includes(requestedFormat)) {
    const error = {
      kind: 'PROCESS_TREE_ARGUMENT_INVALID',
      message: parsed.error ?? `Unsupported output format: ${requestedFormat}`,
      hint: usage(),
      retryable: false,
    };
    if (requestedFormat === 'json') {
      emitJson({ schema_version: SCHEMA_VERSION, status: 'inconclusive', effect: EFFECT, errors: [error] });
    } else {
      process.stderr.write(`${error.kind}: ${error.message}\n${error.hint}\n`);
    }
    return EXIT_INCONCLUSIVE;
  }

  if (parsed.flags.has('--help') || parsed.flags.has('-h')) {
    process.stdout.write(`${usage()}\n`);
    return EXIT_PASS;
  }
  if (parsed.flags.has('--schema')) {
    if (requestedFormat === 'json') emitJson(schemaDocument());
    else process.stdout.write(`${JSON.stringify(schemaDocument(), null, 2)}\n`);
    return EXIT_PASS;
  }

  const root = path.resolve(parsed.values.get('--root') ?? process.cwd());
  const scan = scanProcessTreeDiagnosticAdoptionRepo(root);
  const inconclusive = scan.findings.some((item) =>
    item.kind === 'PROCESS_TREE_SCAN_EMPTY'
    || item.kind === 'PROCESS_TREE_SOURCE_READ_FAILED'
    || item.kind === 'PROCESS_TREE_DIRECTORY_READ_FAILED'
    || item.kind === 'PROCESS_TREE_SOURCE_PARSE_FAILED',
  );
  const status = scan.findings.length === 0 ? 'pass' : inconclusive ? 'inconclusive' : 'fail';
  const exitCode = status === 'pass' ? EXIT_PASS : status === 'fail' ? EXIT_BLOCK : EXIT_INCONCLUSIVE;

  if (requestedFormat === 'json') {
    emitJson({
      schema_version: SCHEMA_VERSION,
      status,
      effect: EFFECT,
      files_examined: scan.filesExamined,
      calls_examined: scan.callsExamined,
      source_counts: scan.sourceCounts,
      errors: scan.findings,
      ...(parsed.flags.has('--verbose')
        ? { call_sites: scan.callSites, expected_inventory: EXPECTED_INVENTORY }
        : {}),
    });
    return exitCode;
  }

  if (status === 'pass') {
    process.stdout.write(
      `process-tree-diagnostic-adoption: PASS — ${scan.callsExamined} callers across `
      + `${scan.filesExamined} source files; sources=${JSON.stringify(scan.sourceCounts)}\n`,
    );
    if (parsed.flags.has('--verbose')) {
      for (const callSite of scan.callSites) {
        process.stdout.write(`  ${callSite.file}:${callSite.line}:${callSite.column} ${callSite.source}\n`);
      }
    }
    return exitCode;
  }

  process.stderr.write(
    `process-tree-diagnostic-adoption: ${status.toUpperCase()} — ${scan.findings.length} finding(s)\n`,
  );
  for (const item of scan.findings) {
    process.stderr.write(
      `  ${item.kind} ${item.file}:${item.line}:${item.column} ${item.message} Hint: ${item.hint}\n`,
    );
  }
  return exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
