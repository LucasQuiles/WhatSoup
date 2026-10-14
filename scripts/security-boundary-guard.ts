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
 *
 * BOT ERRORS rules:
 * - raw notification and e-mail transports stay behind the authority wrapper;
 * - the dispatcher runs one authority preflight before incident-state passes;
 * - the Q loop authorizes outbound notices and never turns chat text into
 *   approval or remediation phase authority;
 * - the authenticated phase route remains installed.
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
  | 'security.remote-memory.canonical-count-drift'
  | 'security.incident-authority.raw-dispatch-send'
  | 'security.incident-authority.raw-dispatch-email'
  | 'security.incident-authority.raw-owner-send'
  | 'security.incident-authority.raw-owner-email'
  | 'security.incident-authority.raw-q-send'
  | 'security.incident-authority.q-chat-grants-phase'
  | 'security.incident-authority.dry-config-in-service'
  | 'security.incident-authority.shared-producer-credential'
  | 'security.incident-authority.authority-order-drift'
  | 'security.incident-authority.canonical-count-drift';

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
  incidentAuthorityPreflights: number;
  dispatcherAuthorizedSends: number;
  dispatcherAuthorizedEmails: number;
  ownerRouteAuthorityChecks: number;
  qAuthorityChecks: number;
  phaseRouteInstallations: number;
  dispatcherCredentialReads: number;
  qCredentialReads: number;
  launchdAuthorityBindings: number;
}

export interface SecurityBoundaryScan {
  findings: SecurityBoundaryFinding[];
  filesExamined: number;
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

function emptyCounts(): SecurityBoundaryCounts {
  return {
    canonicalRegistrations: 0,
    directMemoryWrites: 0,
    providerUpserts: 0,
    lifecycleContracts: 0,
    providerDirectMethods: 0,
    incidentAuthorityPreflights: 0,
    dispatcherAuthorizedSends: 0,
    dispatcherAuthorizedEmails: 0,
    ownerRouteAuthorityChecks: 0,
    qAuthorityChecks: 0,
    phaseRouteInstallations: 0,
    dispatcherCredentialReads: 0,
    qCredentialReads: 0,
    launchdAuthorityBindings: 0,
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
  if (
    file.endsWith('.py')
    || file.endsWith('.service')
    || file.endsWith('.plist')
    || file.endsWith('.sh')
  ) {
    return scanOperationalSecurityBoundaries(file, content, counts);
  }
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

function scanOperationalSecurityBoundaries(
  file: string,
  content: string,
  counts: SecurityBoundaryCounts,
): SecurityBoundaryFinding[] {
  const findings: SecurityBoundaryFinding[] = [];
  const lines = content.split(/\r?\n/);
  let currentFunction = '';
  const add = (code: SecurityBoundaryFindingCode, line: number, detail: string) => {
    findings.push({ code, file, line, detail });
  };
  const addRawTransportReference = (name: string, line: number) => {
    if (file === 'deploy/scripts/bot-errors-dispatcher.py' && name === 'send_whatsapp') {
      add('security.incident-authority.raw-dispatch-send', line,
        'dispatcher WhatsApp transport cannot be aliased or dynamically resolved');
    } else if (file === 'deploy/scripts/bot-errors-dispatcher.py' && name === 'email_fallback') {
      add('security.incident-authority.raw-dispatch-email', line,
        'dispatcher e-mail transport cannot be aliased or dynamically resolved');
    } else if (file === 'deploy/scripts/bot-errors-q-loop.py' && name === 'rpc_call') {
      add('security.incident-authority.raw-q-send', line,
        'Q-loop RPC transport cannot be aliased or dynamically resolved');
    } else if (file === 'deploy/scripts/lib/owner_route.py' && name === 'json_rpc_call') {
      add('security.incident-authority.raw-owner-send', line,
        'owner-route WhatsApp transport cannot be aliased or dynamically resolved');
    } else if (file === 'deploy/scripts/lib/owner_route.py' && name === 'email_fallback') {
      add('security.incident-authority.raw-owner-email', line,
        'owner-route e-mail transport cannot be aliased or dynamically resolved');
    }
  };
  for (const [index, line] of lines.entries()) {
    const definition = /^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
    if (definition) currentFunction = definition[1]!;
    const lineNumber = index + 1;
    const alias = /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(send_whatsapp|email_fallback|rpc_call|json_rpc_call)\b(?!\s*\()/.exec(line);
    if (alias && alias[1] !== alias[2]) addRawTransportReference(alias[2]!, lineNumber);
    const dynamic = /(?:\b(?:globals|locals)\(\)\s*\[|\bgetattr\([^,]+,)\s*["'](send_whatsapp|email_fallback|rpc_call|json_rpc_call)["']/.exec(line);
    if (dynamic) addRawTransportReference(dynamic[1]!, lineNumber);
    if (file === 'deploy/scripts/bot-errors-dispatcher.py') {
      if (/\bsend_authorized_whatsapp\s*\(/.test(line) && !definition) {
        counts.dispatcherAuthorizedSends += 1;
      }
      if (/\bsend_authorized_email\s*\(/.test(line) && !definition) {
        counts.dispatcherAuthorizedEmails += 1;
      }
      if (/\bauthorize_ready_events\s*\(/.test(line) && !definition) {
        counts.incidentAuthorityPreflights += 1;
      }
      if (/BOT_ERRORS_DISPATCHER_AUTHORITY_CREDENTIAL_FILE/.test(line)) {
        counts.dispatcherCredentialReads += 1;
      }
      if (/\bsend_whatsapp\s*\(/.test(line) && !definition && currentFunction !== 'send_authorized_whatsapp') {
        add('security.incident-authority.raw-dispatch-send', lineNumber,
          'dispatcher WhatsApp effects must pass through send_authorized_whatsapp');
      }
      if (/\bemail_fallback\s*\(/.test(line) && !definition && currentFunction !== 'send_authorized_email') {
        add('security.incident-authority.raw-dispatch-email', lineNumber,
          'dispatcher e-mail effects must pass through send_authorized_email');
      }
    }
    if (file === 'deploy/scripts/bot-errors-q-loop.py') {
      if (/\b_authorize_notification\s*\(/.test(line) && !definition) counts.qAuthorityChecks += 1;
      if (/BOT_ERRORS_Q_LOOP_AUTHORITY_CREDENTIAL_FILE/.test(line)) counts.qCredentialReads += 1;
      if (/\brpc_call\s*\(/.test(line) && !definition && currentFunction !== 'send_message') {
        add('security.incident-authority.raw-q-send', lineNumber,
          'Q-loop RPC effects must stay inside the authority-gated send_message wrapper');
      }
      if (/state\[["'](?:phase|scope_approved_at)["']\]\s*=/.test(line) && currentFunction === 'classify_activity') {
        add('security.incident-authority.q-chat-grants-phase', lineNumber,
          'chat classification may record a receipt but cannot grant phase authority');
      }
    }
    if (file === 'deploy/scripts/lib/owner_route.py') {
      if (/\bgrant_from_record\s*\(/.test(line) && !definition) {
        counts.ownerRouteAuthorityChecks += 1;
      }
      if (/\bjson_rpc_call\s*\(/.test(line) && !definition && currentFunction !== '_send_owner_message') {
        add('security.incident-authority.raw-owner-send', lineNumber,
          'owner-route WhatsApp effects must stay inside the receipt-validating sender');
      }
      if (/\bemail_fallback\s*\(/.test(line) && !definition && currentFunction !== '_send_owner_message') {
        add('security.incident-authority.raw-owner-email', lineNumber,
          'owner-route e-mail effects must stay inside the receipt-validating sender');
      }
    }
    if (
      file === 'deploy/scripts/install-bot-errors-launchd.sh'
      && /<key>BOT_ERRORS_(?:INCIDENT_AUTHORITY_URL|DISPATCHER_AUTHORITY_CREDENTIAL_FILE)<\/key>/.test(line)
    ) {
      counts.launchdAuthorityBindings += 1;
    }
    if (/BOT_ERRORS_INCIDENT_AUTHORITY_CREDENTIAL_FILE/.test(line)) {
      add('security.incident-authority.shared-producer-credential', lineNumber,
        'dispatcher and Q-loop identities require separate credential-file settings');
    }
    if (
      (file.endsWith('.service') || file.endsWith('.plist') || file.endsWith('install-bot-errors-launchd.sh'))
      && /BOT_ERRORS_(?:DRY_(?:AUTHORITY|SEND)|TEST_MODE)/.test(line)
    ) {
      add('security.incident-authority.dry-config-in-service', lineNumber,
        'production service definitions must not enable test authority or notification seams');
    }
  }
  if (file === 'deploy/scripts/bot-errors-dispatcher.py') {
    const runOnceStart = content.indexOf('\ndef run_once(');
    const runOnceEnd = runOnceStart < 0 ? -1 : content.indexOf('\ndef ', runOnceStart + 2);
    const runOnce = runOnceStart < 0
      ? ''
      : content.slice(runOnceStart, runOnceEnd < 0 ? content.length : runOnceEnd);
    const preflight = runOnce.indexOf('authority_preflight = authorize_ready_events(paths)');
    const protectedEffects = [
      'observe_credential_members(paths)',
      'suppress_ready_recovery_duplicates(paths, incident=_incident_cycle)',
      'flap_scan_outbox(paths, incident=_incident_cycle)',
      'suppress_alerts_recovered_before_delivery(paths, incident=_incident_cycle)',
      'collapse_ready_storms(paths, incident=_incident_cycle)',
      'process_one(path, paths',
    ];
    if (
      preflight < 0
      || protectedEffects.some((effect) => {
        const effectIndex = runOnce.indexOf(effect);
        return effectIndex < 0 || effectIndex < preflight;
      })
    ) {
      const line = runOnceStart < 0
        ? 1
        : content.slice(0, runOnceStart).split(/\r?\n/).length;
      add(
        'security.incident-authority.authority-order-drift',
        line,
        'run_once must accept ready events before incident mutation, suppression, or delivery passes',
      );
    }
  }
  return findings;
}

function addCountFindings(scan: SecurityBoundaryScan): void {
  const expected: SecurityBoundaryCounts = {
    canonicalRegistrations: 1,
    directMemoryWrites: 1,
    providerUpserts: 1,
    lifecycleContracts: 1,
    providerDirectMethods: 1,
    incidentAuthorityPreflights: 1,
    dispatcherAuthorizedSends: 7,
    dispatcherAuthorizedEmails: 3,
    ownerRouteAuthorityChecks: 2,
    qAuthorityChecks: 1,
    phaseRouteInstallations: 1,
    dispatcherCredentialReads: 1,
    qCredentialReads: 1,
    launchdAuthorityBindings: 2,
  };
  for (const [name, value] of Object.entries(expected) as Array<[
    keyof SecurityBoundaryCounts,
    number,
  ]>) {
    if (scan.counts[name] === value) continue;
    scan.findings.push({
      code: name.startsWith('incident') || name.startsWith('dispatcher') || name.startsWith('owner')
        || name.startsWith('q') || name.startsWith('phase') || name.startsWith('launchd')
        ? 'security.incident-authority.canonical-count-drift'
        : 'security.remote-memory.canonical-count-drift',
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
    roots: ['src', 'deploy'],
    includeFile: (file) => (
      (TS_EXT_RE.test(file) && !file.endsWith('.test.ts'))
      || file === 'deploy/scripts/bot-errors-dispatcher.py'
      || file === 'deploy/scripts/bot-errors-q-loop.py'
      || file === 'deploy/scripts/lib/owner_route.py'
      || file === 'deploy/scripts/install-bot-errors-launchd.sh'
      || file.endsWith('.service')
      || file.endsWith('.plist')
    ),
    excludeDirectory: (directory) => ['node_modules', '.git', 'dist'].includes(path.basename(directory)),
    fileSystem,
  });
  const counts = emptyCounts();
  const findings: SecurityBoundaryFinding[] = [];
  for (const file of inventory.files) {
    findings.push(...scanFileForSecurityBoundaryViolations(file.path, file.content, counts));
    if (file.path === 'src/fleet/index.ts') {
      counts.phaseRouteInstallations += (file.content.match(/pathname === '\/api\/incident-phases'/g) ?? []).length;
    }
  }
  const scan: SecurityBoundaryScan = {
    findings,
    filesExamined: inventory.counts.filesRead,
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
        `${scan.counts.providerUpserts} provider upsert, ` +
        `${scan.counts.incidentAuthorityPreflights} incident preflight, ` +
        `${scan.counts.ownerRouteAuthorityChecks} owner-route receipt checks, ` +
        `${scan.counts.phaseRouteInstallations} phase route.`,
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
