#!/usr/bin/env node
/**
 * Fail closed when a production killSessionTree caller lacks a canonical
 * diagnostic source or when the reviewed caller inventory drifts.
 *
 * This is an AST guard, not a text search. It recognizes named imports,
 * renamed named imports, namespace property calls, and namespace element calls.
 * The import must resolve syntactically to the canonical process-tree module;
 * unrelated local functions with the same name are ignored.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  PROCESS_TREE_DIAGNOSTIC_SOURCES,
  type ProcessTreeDiagnosticSource,
} from '../src/runtimes/agent/process-tree.ts';
import { parseClosedOptions } from './lib/cli-args.ts';

const SCHEMA_VERSION = 'process-tree-diagnostic-adoption.v1';
const EXIT_PASS = 0;
const EXIT_BLOCK = 1;
const EXIT_INCONCLUSIVE = 2;

export type ProcessTreeDiagnosticAdoptionErrorKind =
  | 'PROCESS_TREE_DIAGNOSTIC_SOURCE_MISSING'
  | 'PROCESS_TREE_DIAGNOSTIC_SOURCE_INVALID'
  | 'PROCESS_TREE_OUTCOME_OBSERVER_MISSING'
  | 'PROCESS_TREE_OUTCOME_OBSERVER_INVALID'
  | 'PROCESS_TREE_DIVERGENCE_OBSERVER_MISSING'
  | 'PROCESS_TREE_DIVERGENCE_OBSERVER_INVALID'
  | 'PROCESS_TREE_OPTIONS_UNRESOLVED'
  | 'PROCESS_TREE_CALLER_INVENTORY_DRIFT'
  | 'PROCESS_TREE_SOURCE_PARSE_FAILED'
  | 'PROCESS_TREE_SOURCE_READ_FAILED'
  | 'PROCESS_TREE_DIRECTORY_READ_FAILED'
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
  readonly source: ProcessTreeDiagnosticSource | null;
  readonly outcomeObserver: boolean;
  readonly divergenceObserver: boolean;
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
  stat: (file) => statSync(file),
  readText: (file) => readFileSync(file, 'utf8'),
};

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

function isCanonicalProcessTreeModule(specifier: string): boolean {
  return /(?:^|\/)process-tree(?:\.ts)?$/.test(specifier);
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

function diagnosticSourceFromOptions(
  options: ts.Expression | undefined,
): { state: 'missing' | 'invalid' | 'unresolved' | 'valid'; source: ProcessTreeDiagnosticSource | null } {
  if (!options || !ts.isObjectLiteralExpression(options)) {
    return { state: 'unresolved', source: null };
  }
  const property = options.properties.find((candidate): candidate is ts.PropertyAssignment =>
    ts.isPropertyAssignment(candidate)
    && ((ts.isIdentifier(candidate.name) && candidate.name.text === 'diagnosticSource')
      || (ts.isStringLiteral(candidate.name) && candidate.name.text === 'diagnosticSource')),
  );
  if (!property) return { state: 'missing', source: null };
  const value = literalText(property.initializer);
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

function observerState(
  options: ts.Expression | undefined,
  name: string,
): 'missing' | 'invalid' | 'valid' {
  if (!options || !ts.isObjectLiteralExpression(options)) return 'missing';
  const property = options.properties.find((candidate) => objectPropertyName(candidate) === name);
  if (!property) return 'missing';
  if (ts.isMethodDeclaration(property)) return 'valid';
  if (
    ts.isPropertyAssignment(property)
    && (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer))
  ) return 'valid';
  return 'invalid';
}

export function scanProcessTreeDiagnosticAdoptionSource(
  file: string,
  text: string,
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

  const directBindings = new Set<string>();
  const namespaceBindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !isCanonicalProcessTreeModule(statement.moduleSpecifier.text)
    ) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaceBindings.add(bindings.name.text);
      continue;
    }
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === 'killSessionTree') {
        directBindings.add(element.name.text);
      }
    }
  }

  const isCanonicalCall = (call: ts.CallExpression): boolean => {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) return directBindings.has(callee.text);
    if (ts.isPropertyAccessExpression(callee)) {
      return ts.isIdentifier(callee.expression)
        && namespaceBindings.has(callee.expression.text)
        && callee.name.text === 'killSessionTree';
    }
    if (ts.isElementAccessExpression(callee) && callee.argumentExpression) {
      return ts.isIdentifier(callee.expression)
        && namespaceBindings.has(callee.expression.text)
        && literalText(callee.argumentExpression) === 'killSessionTree';
    }
    return false;
  };

  const callSites: ProcessTreeCallSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isCanonicalCall(node)) {
      const where = location(sourceFile, node);
      const diagnostic = diagnosticSourceFromOptions(node.arguments[2]);
      const outcomeObserverState = observerState(node.arguments[2], 'onOutcome');
      const divergenceObserverState = observerState(node.arguments[2], 'onCgroupDivergence');
      const outcomeObserver = outcomeObserverState === 'valid';
      const divergenceObserver = divergenceObserverState === 'valid';
      callSites.push({
        file: normalizedFile,
        ...where,
        source: diagnostic.source,
        outcomeObserver,
        divergenceObserver,
      });
      if (diagnostic.state === 'missing') {
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
      } else if (diagnostic.state === 'unresolved') {
        findings.push(finding(
          'PROCESS_TREE_OPTIONS_UNRESOLVED',
          normalizedFile,
          where,
          'killSessionTree options are not an inline object literal.',
          'Keep production options inline so the guard can prove diagnostic adoption.',
        ));
      }
      if (diagnostic.state !== 'unresolved' && outcomeObserverState === 'missing') {
        findings.push(finding(
          'PROCESS_TREE_OUTCOME_OBSERVER_MISSING',
          normalizedFile,
          where,
          'killSessionTree call omits onOutcome.',
          'Add an onOutcome observer that preserves unresolved ambiguity semantics.',
        ));
      } else if (diagnostic.state !== 'unresolved' && outcomeObserverState === 'invalid') {
        findings.push(finding(
          'PROCESS_TREE_OUTCOME_OBSERVER_INVALID',
          normalizedFile,
          where,
          'killSessionTree onOutcome is not an inline callable observer.',
          'Use an inline arrow function, function expression, or object method for onOutcome.',
        ));
      }
      if (diagnostic.state !== 'unresolved' && divergenceObserverState === 'missing') {
        findings.push(finding(
          'PROCESS_TREE_DIVERGENCE_OBSERVER_MISSING',
          normalizedFile,
          where,
          'killSessionTree call omits onCgroupDivergence.',
          'Add an onCgroupDivergence observer with bounded diagnostic fields.',
        ));
      } else if (diagnostic.state !== 'unresolved' && divergenceObserverState === 'invalid') {
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
  let entries;
  try {
    entries = io.readdir(directory);
  } catch {
    const relativeDirectory = normalizePath(path.relative(root, directory)) || '.';
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
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkTypeScriptFiles(root, absolute, files, findings, io);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(normalizePath(path.relative(root, absolute)));
    }
  }
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

  for (const file of candidates.sort()) {
    let text: string;
    try {
      if (!io.stat(path.join(root, file)).isFile()) continue;
      text = io.readText(path.join(root, file));
      filesExamined += 1;
    } catch (error) {
      findings.push(finding(
        'PROCESS_TREE_SOURCE_READ_FAILED',
        file,
        { line: 1, column: 1 },
        `Unable to read candidate source: ${error instanceof Error ? error.message : String(error)}`,
        'Restore readable source permissions and rerun the adoption guard.',
        true,
      ));
      continue;
    }
    const scan = scanProcessTreeDiagnosticAdoptionSource(file, text);
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
      'PROCESS_TREE_DIAGNOSTIC_SOURCE_MISSING',
      'PROCESS_TREE_DIAGNOSTIC_SOURCE_INVALID',
      'PROCESS_TREE_OUTCOME_OBSERVER_MISSING',
      'PROCESS_TREE_OUTCOME_OBSERVER_INVALID',
      'PROCESS_TREE_DIVERGENCE_OBSERVER_MISSING',
      'PROCESS_TREE_DIVERGENCE_OBSERVER_INVALID',
      'PROCESS_TREE_OPTIONS_UNRESOLVED',
      'PROCESS_TREE_CALLER_INVENTORY_DRIFT',
      'PROCESS_TREE_SOURCE_PARSE_FAILED',
      'PROCESS_TREE_SOURCE_READ_FAILED',
      'PROCESS_TREE_DIRECTORY_READ_FAILED',
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
