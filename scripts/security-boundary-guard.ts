#!/usr/bin/env node
/**
 * Mechanical security-boundary invariants that must hold independently of a
 * reviewer's memory. Each rule identifies a concrete bypass shape, scans the
 * complete production source inventory, and fails closed when that inventory
 * is unreadable or when a required canonical boundary disappears.
 *
 * Remote-memory rules:
 * - raw provider upserts stay inside the Pinecone adapter;
 * - MCP tools cannot use the generic upsert surface;
 * - direct memory writes use the dedicated provider method with a required
 *   before-provider-attempt admission gate;
 * - memory_write registration occurs once at the composition root and receives
 *   the root's lifecycle authority;
 * - the lifecycle and provider method contracts remain required, not optional.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  emitInventoryGuardReport,
  inventoryGuardCliFailure,
  inventorySourceFiles,
  parseInventoryGuardArgs,
  runInventoryGuardCliBoundary,
  sourceInventoryDiagnostics,
  type InventoryGuardExitCode,
  type InventoryGuardReport,
  type SourceInventoryCounts,
  type SourceInventoryFileSystem,
  type SourceInventoryIssue,
} from './lib/guard-core.ts';

export type SecurityBoundaryFindingCode =
  | 'security.remote-memory.raw-provider-upsert'
  | 'security.remote-memory.mcp-generic-upsert'
  | 'security.remote-memory.provider-attempt-gate-missing'
  | 'security.remote-memory.registration-outside-root'
  | 'security.remote-memory.lifecycle-authority-missing'
  | 'security.remote-memory.lifecycle-contract-optional'
  | 'security.remote-memory.provider-contract-optional'
  | 'security.remote-memory.canonical-count-drift';

export interface SecurityBoundaryFinding {
  code: SecurityBoundaryFindingCode;
  file: string;
  line: number;
  detail: string;
}

export interface SecurityBoundaryCounts {
  canonicalRegistrations: number;
  directMemoryWrites: number;
  providerUpserts: number;
  lifecycleContracts: number;
  providerDirectMethods: number;
}

export interface SecurityBoundaryScan {
  findings: SecurityBoundaryFinding[];
  filesExamined: number;
  typeScriptFilesParsed: number;
  scanIssues: SourceInventoryIssue[];
  scanIssueCount: number;
  scanIssuesOmitted: number;
  inventoryCounts: SourceInventoryCounts;
  counts: SecurityBoundaryCounts;
}

export interface SecurityBoundaryEvaluation {
  status: 'pass' | 'block' | 'inconclusive';
  exitCode: 0 | 1 | 2;
  scan: SecurityBoundaryScan;
}

const PROVIDER_ADAPTER = 'src/runtimes/chat/providers/pinecone.ts';
const MEMORY_TOOL = 'src/mcp/tools/memory-write.ts';
const COMPOSITION_ROOT = 'src/mcp/register-all.ts';
const TS_EXT_RE = /\.ts$/;

function requiresTypeScriptBoundaryParse(file: string, content: string): boolean {
  const probe = content
    .replace(/\\(?:\r\n|[\n\r\u2028\u2029])/g, '')
    .replace(
      /\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi,
      (match, braced: string | undefined, fixed: string | undefined, hex: string | undefined) => {
        const codePoint = Number.parseInt(braced ?? fixed ?? hex ?? '', 16);
        return codePoint <= 0x7f ? String.fromCodePoint(codePoint) : match;
      },
    )
    .replace(/\\([0-7]{1,3})/g, (match, octal: string) => {
      const codePoint = Number.parseInt(octal, 8);
      return codePoint <= 0x7f ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/\\/g, '');
  return probe.includes('upsertRecords')
    || probe.includes('upsertDirectMemory')
    || probe.includes('registerMemoryWriteTools')
    || (file.startsWith('src/mcp/') && probe.includes('upsert'));
}

function emptyCounts(): SecurityBoundaryCounts {
  return {
    canonicalRegistrations: 0,
    directMemoryWrites: 0,
    providerUpserts: 0,
    lifecycleContracts: 0,
    providerDirectMethods: 0,
  };
}

function nodeLine(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function propertyName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression)
    && expression.argumentExpression
    && ts.isStringLiteral(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }
  if (ts.isIdentifier(expression)) return expression.text;
  return undefined;
}

function objectHasProperty(expression: ts.Expression | undefined, name: string): boolean {
  if (!expression || !ts.isObjectLiteralExpression(expression)) return false;
  return expression.properties.some((property) => {
    if (
      !ts.isPropertyAssignment(property)
      && !ts.isShorthandPropertyAssignment(property)
      && !ts.isMethodDeclaration(property)
    ) return false;
    return propertyName(property.name as ts.Expression) === name;
  });
}

function requiredNamedParameter(
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  index: number,
  name: string,
): boolean {
  const parameter = parameters[index];
  return Boolean(
    parameter
    && ts.isIdentifier(parameter.name)
    && parameter.name.text === name
    && !parameter.questionToken
    && !parameter.initializer,
  );
}

export function scanFileForSecurityBoundaryViolations(
  relPath: string,
  content: string,
  counts: SecurityBoundaryCounts = emptyCounts(),
): SecurityBoundaryFinding[] {
  const file = relPath.split(path.sep).join('/');
  if (!requiresTypeScriptBoundaryParse(file, content)) return [];
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: SecurityBoundaryFinding[] = [];
  const add = (code: SecurityBoundaryFindingCode, node: ts.Node, detail: string) => {
    findings.push({ code, file, line: nodeLine(source, node), detail });
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node)
      && node.name?.text === 'registerMemoryWriteTools'
    ) {
      counts.lifecycleContracts += 1;
      if (!requiredNamedParameter(node.parameters, 1, 'lifecycle')) {
        add(
          'security.remote-memory.lifecycle-contract-optional',
          node,
          'registerMemoryWriteTools must require lifecycle as its second parameter',
        );
      }
    }

    if (ts.isMethodDeclaration(node) && propertyName(node.name as ts.Expression) === 'upsertDirectMemory') {
      counts.providerDirectMethods += 1;
      if (file !== PROVIDER_ADAPTER || !requiredNamedParameter(node.parameters, 1, 'context')) {
        add(
          'security.remote-memory.provider-contract-optional',
          node,
          'upsertDirectMemory must be owned by the Pinecone adapter and require its admission context',
        );
      }
    }

    if (ts.isCallExpression(node)) {
      const name = propertyName(node.expression);
      if (name === 'upsertRecords') {
        if (file === PROVIDER_ADAPTER) {
          counts.providerUpserts += 1;
        } else {
          add(
            'security.remote-memory.raw-provider-upsert',
            node,
            'raw provider upserts must stay inside the canonical Pinecone adapter',
          );
        }
      }

      if (name === 'upsert' && file.startsWith('src/mcp/')) {
        add(
          'security.remote-memory.mcp-generic-upsert',
          node,
          'MCP tools must use a capability-specific mutation method instead of generic upsert',
        );
      }

      if (name === 'upsertDirectMemory') {
        counts.directMemoryWrites += 1;
        if (file !== MEMORY_TOOL || !objectHasProperty(node.arguments[1], 'beforeProviderAttempt')) {
          add(
            'security.remote-memory.provider-attempt-gate-missing',
            node,
            'direct remote-memory writes require beforeProviderAttempt at the canonical tool boundary',
          );
        }
      }

      if (name === 'registerMemoryWriteTools') {
        if (file !== COMPOSITION_ROOT) {
          add(
            'security.remote-memory.registration-outside-root',
            node,
            'memory_write may only be registered by the canonical composition root',
          );
        } else {
          counts.canonicalRegistrations += 1;
          const lifecycle = node.arguments[1];
          if (!lifecycle || !ts.isIdentifier(lifecycle) || lifecycle.text !== 'remoteMemoryLifecycle') {
            add(
              'security.remote-memory.lifecycle-authority-missing',
              node,
              'the composition root must pass remoteMemoryLifecycle as the required authority',
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

function addCountFindings(scan: SecurityBoundaryScan): void {
  const expected: SecurityBoundaryCounts = {
    canonicalRegistrations: 1,
    directMemoryWrites: 1,
    providerUpserts: 1,
    lifecycleContracts: 1,
    providerDirectMethods: 1,
  };
  for (const [name, value] of Object.entries(expected) as Array<[
    keyof SecurityBoundaryCounts,
    number,
  ]>) {
    if (scan.counts[name] === value) continue;
    scan.findings.push({
      code: 'security.remote-memory.canonical-count-drift',
      file: 'src',
      line: 1,
      detail: `${name} expected ${value}, observed ${scan.counts[name]}`,
    });
  }
}

export function scanSecurityBoundaries(
  cwd: string,
  fileSystem?: SourceInventoryFileSystem,
): SecurityBoundaryScan {
  const inventory = inventorySourceFiles({
    repoRoot: cwd,
    roots: ['src'],
    includeFile: (file) => TS_EXT_RE.test(file) && !file.endsWith('.test.ts'),
    excludeDirectory: (directory) => ['node_modules', '.git', 'dist'].includes(path.basename(directory)),
    fileSystem,
  });
  const counts = emptyCounts();
  const findings: SecurityBoundaryFinding[] = [];
  let typeScriptFilesParsed = 0;
  for (const file of inventory.files) {
    if (requiresTypeScriptBoundaryParse(file.path, file.content)) typeScriptFilesParsed += 1;
    findings.push(...scanFileForSecurityBoundaryViolations(file.path, file.content, counts));
  }
  const scan: SecurityBoundaryScan = {
    findings,
    filesExamined: inventory.counts.filesRead,
    typeScriptFilesParsed,
    scanIssues: inventory.issues,
    scanIssueCount: inventory.counts.issuesTotal,
    scanIssuesOmitted: inventory.counts.issuesOmitted,
    inventoryCounts: inventory.counts,
    counts,
  };
  if (scan.scanIssueCount === 0 && scan.filesExamined > 0) addCountFindings(scan);
  return scan;
}

export function evaluateSecurityBoundaryGuard(
  cwd: string,
  fileSystem?: SourceInventoryFileSystem,
): SecurityBoundaryEvaluation {
  const scan = scanSecurityBoundaries(cwd, fileSystem);
  if (scan.scanIssueCount > 0 || scan.filesExamined === 0) {
    return { status: 'inconclusive', exitCode: 2, scan };
  }
  if (scan.findings.length > 0) return { status: 'block', exitCode: 1, scan };
  return { status: 'pass', exitCode: 0, scan };
}

const TAG = 'security-boundary-guard';

function reportFor(evaluation: SecurityBoundaryEvaluation): InventoryGuardReport {
  const { scan } = evaluation;
  return {
    schemaVersion: 1,
    guard: TAG,
    status: evaluation.status,
    exitCode: evaluation.exitCode,
    counts: {
      filesExamined: scan.filesExamined,
      findings: scan.findings.length,
      scanIssues: scan.scanIssueCount,
      scanIssuesOmitted: scan.scanIssuesOmitted,
      rootsScanned: scan.inventoryCounts.rootsScanned,
      directoriesScanned: scan.inventoryCounts.directoriesScanned,
      entriesInspected: scan.inventoryCounts.entriesInspected,
      candidatesFound: scan.inventoryCounts.candidatesFound,
      typeScriptFilesParsed: scan.typeScriptFilesParsed,
      ...scan.counts,
    },
    diagnostics: [
      ...sourceInventoryDiagnostics({ issues: scan.scanIssues }),
      ...scan.findings.map((finding) => ({
        code: finding.code,
        path: finding.file,
        line: finding.line,
      })),
    ],
  };
}

function humanLines(evaluation: SecurityBoundaryEvaluation): string[] {
  const { scan } = evaluation;
  if (scan.scanIssueCount > 0 || scan.filesExamined === 0) {
    return [
      `${TAG}: INCONCLUSIVE — source inventory unavailable or empty; ` +
        'the security-boundary invariants were not certified.',
    ];
  }
  if (scan.findings.length === 0) {
    return [
      `${TAG}: PASS — ${scan.filesExamined} source file(s); ` +
        `${scan.counts.canonicalRegistrations} canonical registration, ` +
        `${scan.counts.directMemoryWrites} gated direct write, ` +
        `${scan.counts.providerUpserts} provider upsert.`,
    ];
  }
  return [
    `${TAG}: BLOCK — ${scan.findings.length} security-boundary violation(s):`,
    ...scan.findings.map((finding) =>
      `  ${finding.file}:${finding.line} ${finding.code} ${finding.detail}`),
  ];
}

function main(argv: readonly string[] = process.argv.slice(2)): InventoryGuardExitCode {
  const parsed = parseInventoryGuardArgs(argv);
  if (!parsed.ok) {
    const report = inventoryGuardCliFailure(TAG, parsed.code);
    return emitInventoryGuardReport(report, parsed.mode, [`${TAG}: INCONCLUSIVE — ${parsed.code}`]);
  }
  const evaluation = evaluateSecurityBoundaryGuard(process.cwd());
  return emitInventoryGuardReport(reportFor(evaluation), parsed.mode, humanLines(evaluation));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  process.exitCode = runInventoryGuardCliBoundary(TAG, argv, () => main(argv));
}
