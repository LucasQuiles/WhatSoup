import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerWarn = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn(() => true));
const fsyncSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async () => {
  const { childProcessMock } = await import('../helpers/child-process.ts');
  return childProcessMock();
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return {
    ...actual,
    existsSync: existsSyncMock,
    fsyncSync: fsyncSyncMock,
  };
});

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    warn: loggerWarn,
  }),
}));

import {
  clearAlertSource,
  clearAlertSourceChecked,
  emitAlert,
  emitAlertChecked,
  observeAlertEmission,
  resetEmitAlertThrottle,
} from '../../src/lib/emit-alert.ts';
import { buildBotErrorsEvent } from '../../src/lib/bot-errors-outbox.ts';

const ALERT_SCRIPT = join(homedir(), '.claude', 'scripts', 'whatsapp-alert.sh');
const SPAWN_OPTIONS = { stdio: 'ignore', timeout: 5_000, detached: false, killSignal: 'SIGKILL' as const };
const BOT_ERRORS_JID = '120363555555555000@g.us';
const AWS_KEY_SAMPLE = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const GITHUB_TOKEN_SAMPLE = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('_');
const JWT_SAMPLE = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjMifQ', 'signaturepart1234567890'].join('.');
const PRIVATE_KEY_SAMPLE = ['-----BEGIN ', 'PRIVATE KEY-----', '\nabc\n', '-----END ', 'PRIVATE KEY-----'].join('');
const URL_USERINFO_SAMPLE = `https://user:pass@${'example'}.com/path`;
const PHONE_SAMPLE = '+1 (555) 123-4567';
const WHATSAPP_JID_SAMPLE = '15555550123@s.whatsapp.net';
const CREDENTIAL_PATH_SAMPLE = '/home/testuser/.config/whatsoup/instances/agent-alpha/tokens.env';
const BOT_ERRORS_ENV_PATH_SAMPLE = '/home/testuser/.config/whatsoup/bot-errors.env';
const AUTH_PATH_SAMPLE = '/home/testuser/.local/share/whatsoup/instances/agent-alpha/auth/creds.json';
const BACKUP_PATH_SAMPLE = '/home/testuser/.local/state/whatsoup/auth-bond-backups/agent-alpha/latest';
let outboxDir = '';
let writefailDir = '';

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(filePath);
    if (entry.isFile() && filePath.endsWith('.ts')) return [filePath];
    return [];
  });
}

const AUDITED_STRUCTURED_ALERT_RESULT_CALLERS = new Set([
  'src/core/ingest.ts',
  'src/fleet/health-poller.ts',
  'src/runtimes/agent/turn-finalizer.ts',
]);

interface AlertGovernanceSource {
  path: string;
  text: string;
}

interface DirectAlertCall {
  functionName: 'emitAlert' | 'clearAlertSource';
  node: ts.CallExpression;
  resultName: string | null;
}

type AlertFunctionName = DirectAlertCall['functionName'];

function normalizeGovernancePath(filePath: string): string {
  const cwdPrefix = `${process.cwd()}${sep}`;
  const repoRelative = filePath.startsWith(cwdPrefix) ? relative(process.cwd(), filePath) : filePath;
  return repoRelative.split(sep).join('/');
}

function assignedResultName(call: ts.CallExpression): string | null {
  let expression: ts.Expression = call;
  while (
    (ts.isAwaitExpression(expression.parent) || ts.isParenthesizedExpression(expression.parent))
    && expression.parent.expression === expression
  ) {
    expression = expression.parent;
  }

  const parent = expression.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === expression && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (
    ts.isBinaryExpression(parent)
    && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && parent.right === expression
    && ts.isIdentifier(parent.left)
  ) {
    return parent.left.text;
  }
  return null;
}

function containingStatement(node: ts.Node): ts.Statement | null {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isStatement(current)) return current;
    current = current.parent;
  }
  return null;
}

function definitelyExits(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  if (ts.isBlock(statement)) {
    const lastStatement = statement.statements.at(-1);
    return lastStatement !== undefined && definitelyExits(lastStatement);
  }
  return false;
}

function nextSuccessPathStatement(call: ts.CallExpression): ts.Statement | null {
  const statement = containingStatement(call);
  if (!statement || (!ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent))) return null;

  const container = statement.parent;
  const statementIndex = container.statements.indexOf(statement);
  const nextInBlock = container.statements[statementIndex + 1];
  if (nextInBlock) return nextInBlock;

  const tryStatement = container.parent;
  if (
    !ts.isBlock(container)
    || !ts.isTryStatement(tryStatement)
    || tryStatement.tryBlock !== container
    || (tryStatement.finallyBlock?.statements.length ?? 0) > 0
    || !tryStatement.catchClause
    || !definitelyExits(tryStatement.catchClause.block)
    || (!ts.isBlock(tryStatement.parent) && !ts.isSourceFile(tryStatement.parent))
  ) {
    return null;
  }
  const parentContainer = tryStatement.parent;
  const tryIndex = parentContainer.statements.indexOf(tryStatement);
  return parentContainer.statements[tryIndex + 1] ?? null;
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isResultStatusAccess(expression: ts.Expression, resultName: string): boolean {
  const unwrapped = unwrapParentheses(expression);
  return (
    ts.isPropertyAccessExpression(unwrapped)
    && ts.isIdentifier(unwrapped.expression)
    && unwrapped.expression.text === resultName
    && unwrapped.name.text === 'status'
  );
}

function durableStatusDecisionKind(node: ts.Node, resultName: string): 'equal' | 'not_equal' | null {
  if (!ts.isExpression(node)) return null;
  const expression = unwrapParentheses(node);
  if (!ts.isBinaryExpression(expression)) return null;
  if (
    expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
    && expression.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken
  ) {
    return null;
  }

  const isDurableLiteral = (operand: ts.Expression): boolean => (
    ts.isStringLiteral(operand) && operand.text === 'durably_queued'
  );
  const comparesDurableStatus = (
    (isResultStatusAccess(expression.left, resultName) && isDurableLiteral(expression.right))
    || (isDurableLiteral(expression.left) && isResultStatusAccess(expression.right, resultName))
  );
  if (!comparesDurableStatus) return null;
  return expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? 'equal' : 'not_equal';
}

function containsDurableStatusDecision(node: ts.Node, resultName: string): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found || ts.isFunctionLike(child)) return;
    if (durableStatusDecisionKind(child, resultName) !== null) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function staticPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function isStrictDurableAcceptanceReturn(expression: ts.Expression, resultName: string): boolean {
  const returned = unwrapParentheses(expression);
  if (durableStatusDecisionKind(returned, resultName) === 'equal') return true;
  if (!ts.isObjectLiteralExpression(returned)) return false;
  if (returned.properties.length !== 2) return false;

  let hasAccepted = false;
  let hasStatus = false;
  for (const property of returned.properties) {
    if (!ts.isPropertyAssignment(property)) return false;
    const propertyName = staticPropertyName(property.name);
    if (propertyName === 'accepted') {
      if (hasAccepted || durableStatusDecisionKind(property.initializer, resultName) !== 'equal') return false;
      hasAccepted = true;
      continue;
    }
    if (propertyName === 'status') {
      if (hasStatus || !isResultStatusAccess(property.initializer, resultName)) return false;
      hasStatus = true;
      continue;
    }
    return false;
  }
  return hasAccepted && hasStatus;
}

function legacyAcceptanceOwner(expression: ts.Expression): string | null {
  const unwrapped = unwrapParentheses(expression);
  if (
    ts.isPropertyAccessExpression(unwrapped) &&
    ts.isIdentifier(unwrapped.expression) &&
    unwrapped.name.text === 'ok'
  ) {
    return unwrapped.expression.text;
  }
  if (
    ts.isElementAccessExpression(unwrapped) &&
    ts.isIdentifier(unwrapped.expression) &&
    unwrapped.argumentExpression !== undefined &&
    ts.isStringLiteral(unwrapParentheses(unwrapped.argumentExpression)) &&
    (unwrapParentheses(unwrapped.argumentExpression) as ts.StringLiteral).text === 'ok'
  ) {
    return unwrapped.expression.text;
  }
  return null;
}

function isLegacyAcceptanceAccess(expression: ts.Expression, resultName: string): boolean {
  return legacyAcceptanceOwner(expression) === resultName;
}

function isResultAliasExpression(expression: ts.Expression, resultAliases: ReadonlySet<string>): boolean {
  const unwrapped = unwrapParentheses(expression);
  return ts.isIdentifier(unwrapped) && resultAliases.has(unwrapped.text);
}

function objectBindingReadsLegacyAcceptance(name: ts.ObjectBindingPattern): boolean {
  return name.elements.some((element) => {
    const selected = element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined);
    return selected !== undefined && staticPropertyName(selected) === 'ok';
  });
}

function containsLegacyAcceptanceAccess(node: ts.Node, resultName: string): boolean {
  const resultAliases = new Set([resultName]);
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found || ts.isFunctionLike(child)) return;
    if (
      ts.isVariableDeclaration(child) &&
      child.initializer !== undefined &&
      isResultAliasExpression(child.initializer, resultAliases)
    ) {
      if (ts.isIdentifier(child.name)) resultAliases.add(child.name.text);
      if (ts.isObjectBindingPattern(child.name) && objectBindingReadsLegacyAcceptance(child.name)) {
        found = true;
        return;
      }
    }
    if (
      ts.isBinaryExpression(child) &&
      child.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(child.left) &&
      isResultAliasExpression(child.right, resultAliases)
    ) {
      resultAliases.add(child.left.text);
    }
    if (
      ts.isExpression(child) &&
      resultAliases.has(legacyAcceptanceOwner(child) ?? '')
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function classifyFailClosedReturn(
  expression: ts.Expression | undefined,
  resultName: string,
): 'explicit_failure' | 'opaque' | 'unsafe' {
  if (expression === undefined) return 'explicit_failure';
  const returned = unwrapParentheses(expression);
  if (returned.kind === ts.SyntaxKind.FalseKeyword) return 'explicit_failure';
  if (returned.kind === ts.SyntaxKind.TrueKeyword || isLegacyAcceptanceAccess(returned, resultName)) {
    return 'unsafe';
  }
  if (!ts.isObjectLiteralExpression(returned)) return 'opaque';

  let hasExplicitFailureMarker = false;
  for (const property of returned.properties) {
    if (ts.isSpreadAssignment(property)) return 'unsafe';
    const propertyName = staticPropertyName(property.name);
    if (propertyName === 'ok') return 'unsafe';
    if (propertyName !== 'accepted' && propertyName !== 'mayAdvance') continue;
    if (
      !ts.isPropertyAssignment(property) ||
      unwrapParentheses(property.initializer).kind !== ts.SyntaxKind.FalseKeyword
    ) {
      return 'unsafe';
    }
    hasExplicitFailureMarker = true;
  }
  return hasExplicitFailureMarker ? 'explicit_failure' : 'opaque';
}

function definitelyExitsFailClosed(statement: ts.Statement, resultName: string): boolean {
  if (
    !definitelyExits(statement) ||
    containsLegacyAcceptanceAccess(statement, resultName)
  ) {
    return false;
  }

  let exitCount = 0;
  let opaqueExitCount = 0;
  let hasUnsafePath = false;
  const visit = (node: ts.Node): void => {
    if (hasUnsafePath || (node !== statement && ts.isFunctionLike(node))) return;
    if (ts.isReturnStatement(node)) {
      exitCount += 1;
      const classification = classifyFailClosedReturn(node.expression, resultName);
      if (classification === 'unsafe') hasUnsafePath = true;
      if (classification === 'opaque') opaqueExitCount += 1;
      return;
    }
    if (ts.isThrowStatement(node)) {
      exitCount += 1;
      return;
    }
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      hasUnsafePath = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return exitCount > 0 && !hasUnsafePath && opaqueExitCount === 0;
}

function isFailClosedDurableDecision(statement: ts.Statement, resultName: string): boolean {
  if (ts.isReturnStatement(statement) && statement.expression) {
    return isStrictDurableAcceptanceReturn(statement.expression, resultName);
  }
  if (!ts.isIfStatement(statement)) return false;
  return (
    durableStatusDecisionKind(statement.expression, resultName) === 'not_equal'
    && definitelyExitsFailClosed(statement.thenStatement, resultName)
  );
}

interface AlertBindings {
  direct: Map<string, AlertFunctionName>;
  namespaces: Set<string>;
}

function alertBindings(sourceFile: ts.SourceFile): AlertBindings {
  const direct = new Map<string, AlertFunctionName>([
    ['emitAlert', 'emitAlert'],
    ['clearAlertSource', 'clearAlertSource'],
  ]);
  const namespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || statement.importClause?.isTypeOnly
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !/(^|\/)emit-alert\.ts$/.test(statement.moduleSpecifier.text)
      || !statement.importClause?.namedBindings
    ) {
      continue;
    }
    const namedBindings = statement.importClause.namedBindings;
    if (ts.isNamespaceImport(namedBindings)) {
      namespaces.add(namedBindings.name.text);
      continue;
    }
    for (const specifier of namedBindings.elements) {
      if (specifier.isTypeOnly) continue;
      const importedName = specifier.propertyName?.text ?? specifier.name.text;
      if (importedName === 'emitAlert' || importedName === 'clearAlertSource') {
        direct.set(specifier.name.text, importedName);
      }
    }
  }
  return { direct, namespaces };
}

function alertFunctionForCallee(expression: ts.Expression, bindings: AlertBindings): AlertFunctionName | undefined {
  const callee = unwrapParentheses(expression);
  if (ts.isIdentifier(callee)) return bindings.direct.get(callee.text);
  if (ts.isPropertyAccessExpression(callee)) {
    const namespace = unwrapParentheses(callee.expression);
    if (
      ts.isIdentifier(namespace)
      && bindings.namespaces.has(namespace.text)
      && (callee.name.text === 'emitAlert' || callee.name.text === 'clearAlertSource')
    ) {
      return callee.name.text;
    }
  }
  if (ts.isElementAccessExpression(callee) && callee.argumentExpression) {
    const namespace = unwrapParentheses(callee.expression);
    const member = unwrapParentheses(callee.argumentExpression);
    if (
      ts.isIdentifier(namespace)
      && bindings.namespaces.has(namespace.text)
      && ts.isStringLiteral(member)
      && (member.text === 'emitAlert' || member.text === 'clearAlertSource')
    ) {
      return member.text;
    }
  }
  return undefined;
}

function scanAlertEmissionGovernance(sources: AlertGovernanceSource[]): string[] {
  return sources.flatMap((source) => {
    const normalizedPath = normalizeGovernancePath(source.path);
    if (normalizedPath === 'src/lib/emit-alert.ts') return [];

    const sourceFile = ts.createSourceFile(normalizedPath, source.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const bindings = alertBindings(sourceFile);
    const calls: DirectAlertCall[] = [];
    const collectCalls = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const functionName = alertFunctionForCallee(node.expression, bindings);
        if (functionName) {
          calls.push({
            functionName,
            node,
            resultName: assignedResultName(node),
          });
        }
      }
      ts.forEachChild(node, collectCalls);
    };
    collectCalls(sourceFile);

    return calls.flatMap((call) => {
      const { line } = sourceFile.getLineAndCharacterOfPosition(call.node.getStart(sourceFile));
      const location = `${normalizedPath}:${line + 1}`;
      if (!AUDITED_STRUCTURED_ALERT_RESULT_CALLERS.has(normalizedPath)) {
        return [`${location}: unallowlisted direct ${call.functionName} caller; use the checked wrapper`];
      }
      if (!call.resultName) {
        return [`${location}: audited direct ${call.functionName} caller must capture its structured result`];
      }

      const decisionStatement = nextSuccessPathStatement(call.node);
      if (decisionStatement && isFailClosedDurableDecision(decisionStatement, call.resultName)) return [];
      if (decisionStatement && containsDurableStatusDecision(decisionStatement, call.resultName)) {
        return [`${location}: audited direct ${call.functionName} caller lacks a fail-closed status ===/!== 'durably_queued' decision`];
      }
      return [`${location}: audited direct ${call.functionName} caller lacks an explicit status ===/!== 'durably_queued' decision`];
    });
  });
}

function spawnedChild() {
  return vi.mocked(spawn).mock.results.at(-1)?.value;
}

function readOnlyEvent() {
  const files = readdirSync(outboxDir);
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(outboxDir, files[0]!), 'utf8')) as Record<string, unknown>;
}

function readOnlyWritefail() {
  const files = readdirSync(writefailDir).filter((file) => file.endsWith('.writefail'));
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(writefailDir, files[0]!), 'utf8')) as Record<string, any>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../../src/lib/bot-errors-outbox.ts');
  vi.resetModules();
  if (outboxDir) rmSync(outboxDir, { recursive: true, force: true });
  if (writefailDir) rmSync(writefailDir, { recursive: true, force: true });
  delete process.env['BOT_ERRORS_OUTBOX_DIR'];
  delete process.env['BOT_ERRORS_WRITEFAIL_DIR'];
  delete process.env['BOT_ERRORS_STATE_DIR'];
  delete process.env['WHATSOUP_ALERT_SINK'];
  delete process.env['BOT_ERRORS_REQUIRE_EXPECTED'];
  delete process.env['EMIT_ALERT_THROTTLE_MS'];
});

describe('emitAlert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loggerWarn.mockClear();
    existsSyncMock.mockReturnValue(true);
    fsyncSyncMock.mockClear();
    if (outboxDir) rmSync(outboxDir, { recursive: true, force: true });
    if (writefailDir) rmSync(writefailDir, { recursive: true, force: true });
    outboxDir = mkdtempSync(join(tmpdir(), 'bot-errors-outbox-'));
    writefailDir = mkdtempSync(join(tmpdir(), 'bot-errors-writefail-'));
    process.env['BOT_ERRORS_OUTBOX_DIR'] = outboxDir;
    process.env['BOT_ERRORS_WRITEFAIL_DIR'] = writefailDir;
    process.env['BOT_ERRORS_JID'] = BOT_ERRORS_JID;
    process.env['BOT_ERRORS_EXPECTED_JID'] = BOT_ERRORS_JID;
    delete process.env['BOT_ERRORS_REQUIRE_EXPECTED'];
    delete process.env['BOT_ERRORS_DRY_PLATFORM'];
    delete process.env['BOT_ERRORS_DRY_PLATFORM_RELEASE'];
    resetEmitAlertThrottle();
  });

  it('writes a durable outbox event with instance, source, summary, and evidence', () => {
    const result = emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    expect(readOnlyEvent()).toMatchObject({
      schemaVersion: 2,
      eventKind: 'incident_alert',
      eventType: 'alert',
      severity: 'critical',
      instance: 'whatsoup-prod',
      source: 'agent_respawn_failed',
    });
    expect(result).toMatchObject({
      ok: true,
      channel: 'outbox',
      status: 'durably_queued',
      outbox: { path: expect.stringContaining(outboxDir) },
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('normalizes informational emitAlert calls into typed observations', () => {
    const result = emitAlert('whatsoup-prod', 'provider_notice', 'provider notice', 'informational evidence', 'info');

    expect(readOnlyEvent()).toMatchObject({
      schemaVersion: 2,
      eventKind: 'observation',
      eventType: 'observation',
      severity: 'info',
      instance: 'whatsoup-prod',
      source: 'provider_notice',
    });
    expect(result).toMatchObject({ ok: true, channel: 'outbox', status: 'durably_queued' });
  });

  it('fsyncs both event contents and the outbox directory before returning', () => {
    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    expect(readOnlyEvent()).toMatchObject({ eventType: 'alert' });
    expect(fsyncSyncMock).toHaveBeenCalledTimes(2);
  });

  it('defaults to critical but honors an explicit non-critical severity override', () => {
    emitAlert(
      'whatsoup-prod',
      'instance_never_reachable',
      'configured but never came online',
      'connect ECONNREFUSED',
      'warning',
    );

    expect(readOnlyEvent()).toMatchObject({
      eventType: 'alert',
      severity: 'warning',
      instance: 'whatsoup-prod',
      source: 'instance_never_reachable',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('confines all secret material to bounded metadata (issue #2386)', () => {
    const secretEvidence = [
      'token=plain-secret',
      'Authorization: Bearer assignment-secret-token',
      'Bearer abc.def',
      AWS_KEY_SAMPLE,
      GITHUB_TOKEN_SAMPLE,
      JWT_SAMPLE,
      PRIVATE_KEY_SAMPLE,
      URL_USERINFO_SAMPLE,
      PHONE_SAMPLE,
      WHATSAPP_JID_SAMPLE,
      CREDENTIAL_PATH_SAMPLE,
      BOT_ERRORS_ENV_PATH_SAMPLE,
      AUTH_PATH_SAMPLE,
      BACKUP_PATH_SAMPLE,
    ].join('\n');

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', secretEvidence);

    // Issue #2386: evidence is confined to { failureClass, length,
    // correlationDigest } — raw secret strings must not survive.
    const event = readOnlyEvent() as { evidence: unknown };
    const serialized = JSON.stringify(event);
    expect(typeof event.evidence).toBe('object');
    expect(serialized).not.toContain('plain-secret');
    expect(serialized).not.toContain('assignment-secret-token');
    expect(serialized).not.toContain('abc.def');
    expect(serialized).not.toContain(AWS_KEY_SAMPLE);
    expect(serialized).not.toContain(GITHUB_TOKEN_SAMPLE);
    expect(serialized).not.toContain('eyJhbGci');
    expect(serialized).not.toContain('-----BEGIN');
    expect(serialized).not.toContain('-----END');
    expect(serialized).not.toContain(URL_USERINFO_SAMPLE);
    expect(serialized).not.toContain(PHONE_SAMPLE);
    expect(serialized).not.toContain(WHATSAPP_JID_SAMPLE);
    expect(serialized).not.toContain(CREDENTIAL_PATH_SAMPLE);
    expect(serialized).not.toContain(BOT_ERRORS_ENV_PATH_SAMPLE);
    expect(serialized).not.toContain(AUTH_PATH_SAMPLE);
    expect(serialized).not.toContain(BACKUP_PATH_SAMPLE);
  });

  it('never exposes a truncated temp file as a live event', () => {
    writeFileSync(join(outboxDir, '.truncated.tmp'), '');

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    const liveEvents = readdirSync(outboxDir).filter((file) => file.endsWith('.json') && !file.startsWith('.'));
    expect(liveEvents).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outboxDir, liveEvents[0]!), 'utf8')) as Record<string, unknown>;
    expect(event).toMatchObject({
      eventType: 'alert',
      instance: 'whatsoup-prod',
      source: 'agent_respawn_failed',
    });
  });

  it('strips platform, logHints, envKeys from every event (issue #2386)', () => {
    process.env['BOT_ERRORS_DRY_PLATFORM'] = 'darwin';
    process.env['BOT_ERRORS_DRY_PLATFORM_RELEASE'] = '25.4.0';

    const event = buildBotErrorsEvent({
      eventType: 'alert',
      instance: 'com.whatsoup.ana-bot',
      source: 'agent_respawn_failed',
      summary: 'respawn exhausted',
      evidence: 'crashed 3 times',
    });

    // Issue #2386: platform, machine, logHints, envKeys, cwd, execPath,
    // and argv are stripped — they embed host identifiers, paths, and
    // instance names.
    expect(event).not.toHaveProperty('platform');
    expect(event).not.toHaveProperty('machine');
    expect(event.diagnostics).not.toHaveProperty('logHints');
    expect(event.runtime).not.toHaveProperty('envKeys');
    expect(event.process).not.toHaveProperty('cwd');
    expect(event.process).not.toHaveProperty('execPath');
    expect(event.process).not.toHaveProperty('argv');
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('journalctl');
    expect(serialized).not.toContain('launchctl');
    expect(serialized).not.toContain('darwin 25.4.0');
  });

  it('falls back to the legacy helper when the outbox write fails', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';

    const result = emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    // Issue #2386: the legacy fallback now receives confined metadata JSON
    // (failureClass + source + truncated reason), not raw summary/evidence.
    expect(spawn).toHaveBeenCalledWith(
      ALERT_SCRIPT,
      [
        '--alert-target',
        BOT_ERRORS_JID,
        '--instance',
        'whatsoup-prod',
        '--source',
        'agent_respawn_failed',
        '--summary',
        expect.stringMatching(/^\{"failureClass":"legacy_fallback"/),
        '--evidence',
        '{}',
      ],
      SPAWN_OPTIONS,
    );
    expect(result).toMatchObject({
      ok: true,
      channel: 'legacy',
      status: 'legacy_accepted_unconfirmed',
      legacy: { attempted: true, accepted: true },
      outboxError: expect.any(String),
    });
    const child = spawnedChild();
    expect(child?.unref).toHaveBeenCalledOnce();
    expect(child?.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(loggerWarn).toHaveBeenCalledWith(
      {
        instance: 'whatsoup-prod',
        source: 'agent_respawn_failed',
        err: expect.any(String),
      },
      'bot-errors outbox write failed',
    );
  });

  it('logs legacy helper spawn errors after a fallback send is attempted', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');
    spawnedChild()?.emit('error', new Error('spawn denied'));

    expect(loggerWarn).toHaveBeenCalledWith(
      { instance: 'whatsoup-prod', source: 'agent_respawn_failed', err: 'spawn denied' },
      'alert emission failed; legacy helper failed',
    );
  });

  it('logs when both outbox write and legacy helper availability fail', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    existsSyncMock.mockReturnValue(false);

    const result = emitAlert(
      'whatsoup-prod',
      'agent_respawn_failed',
      'respawn exhausted',
      'Authorization: Bearer lost-secret-token',
    );

    expect(spawn).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      channel: 'none',
      status: 'failed',
      legacy: { attempted: false, accepted: false, reason: 'helper_unavailable' },
      outboxError: expect.any(String),
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      { instance: 'whatsoup-prod', source: 'agent_respawn_failed' },
      'alert emission failed; legacy helper script not present',
    );
    const crumb = readOnlyWritefail();
    expect(crumb).toMatchObject({
      kind: 'outbox_write_failure',
      failedTarget: expect.stringContaining('/dev/null/outbox'),
      event: {
        eventType: 'alert',
        severity: 'critical',
        instance: 'whatsoup-prod',
        source: 'agent_respawn_failed',
        summary: { failureClass: expect.any(String), length: expect.any(Number), correlationDigest: expect.any(String) },
        evidence: { failureClass: expect.any(String), length: expect.any(Number), correlationDigest: expect.any(String) },
      },
    });
    expect(JSON.stringify(crumb)).not.toContain('lost-secret-token');
    expect(fsyncSyncMock).toHaveBeenCalledTimes(2);
  });

  it('refuses legacy fallback when BOT_ERRORS_JID is missing', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    delete process.env['BOT_ERRORS_JID'];
    delete process.env['BOT_ERRORS_EXPECTED_JID'];

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    expect(spawn).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(
      {},
      'BOT_ERRORS_JID not configured; legacy alert helper disabled',
    );
    expect(loggerWarn).toHaveBeenCalledWith(
      { instance: 'whatsoup-prod', source: 'agent_respawn_failed' },
      'alert emission failed; legacy alert target not configured',
    );
  });

  it('suppresses repeated missing-target configuration warnings', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    delete process.env['BOT_ERRORS_JID'];
    delete process.env['BOT_ERRORS_EXPECTED_JID'];

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed once');
    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted again', 'crashed twice');

    const targetConfigWarnings = loggerWarn.mock.calls.filter(([, message]) => (
      message === 'BOT_ERRORS_JID not configured; legacy alert helper disabled'
    ));
    expect(targetConfigWarnings.length).toBeLessThanOrEqual(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      { instance: 'whatsoup-prod', source: 'agent_respawn_failed' },
      'alert emission failed; legacy alert target not configured',
    );
  });

  it('refuses legacy fallback when BOT_ERRORS_JID is not a group JID', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    process.env['BOT_ERRORS_JID'] = '15551234567@s.whatsapp.net';
    process.env['BOT_ERRORS_EXPECTED_JID'] = '15551234567@s.whatsapp.net';

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    expect(spawn).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(
      { targetSuffix: 's.whatsapp.net' },
      'BOT_ERRORS_JID is not a WhatsApp group JID; legacy alert helper disabled',
    );
    expect(loggerWarn).toHaveBeenCalledWith(
      { instance: 'whatsoup-prod', source: 'agent_respawn_failed' },
      'alert emission failed; legacy alert target not configured',
    );
  });

  it('suppresses repeated invalid-target configuration warnings', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    process.env['BOT_ERRORS_JID'] = 'not-a-group';
    process.env['BOT_ERRORS_EXPECTED_JID'] = 'not-a-group';

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed once');
    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted again', 'crashed twice');

    const invalidTargetWarnings = loggerWarn.mock.calls.filter(([, message]) => (
      message === 'BOT_ERRORS_JID is not a WhatsApp group JID; legacy alert helper disabled'
    ));
    expect(invalidTargetWarnings.length).toBeLessThanOrEqual(1);
  });

  it('refuses legacy fallback when BOT_ERRORS_JID drifts from BOT_ERRORS_EXPECTED_JID', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    process.env['BOT_ERRORS_JID'] = '120363555555555000@g.us';
    process.env['BOT_ERRORS_EXPECTED_JID'] = 'expected-group@g.us';

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    expect(spawn).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(
      {},
      'BOT_ERRORS_JID does not match BOT_ERRORS_EXPECTED_JID; legacy alert helper disabled',
    );
    expect(loggerWarn).toHaveBeenCalledWith(
      { instance: 'whatsoup-prod', source: 'agent_respawn_failed' },
      'alert emission failed; legacy alert target not configured',
    );
  });

  it('suppresses repeated drifted-target configuration warnings', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    process.env['BOT_ERRORS_JID'] = BOT_ERRORS_JID;
    process.env['BOT_ERRORS_EXPECTED_JID'] = BOT_ERRORS_JID.replace('000', '999');

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed once');
    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted again', 'crashed twice');

    const driftWarnings = loggerWarn.mock.calls.filter(([, message]) => (
      message === 'BOT_ERRORS_JID does not match BOT_ERRORS_EXPECTED_JID; legacy alert helper disabled'
    ));
    expect(driftWarnings.length).toBeLessThanOrEqual(1);
  });

  it('refuses legacy fallback when BOT_ERRORS_EXPECTED_JID is missing by default', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    process.env['BOT_ERRORS_JID'] = BOT_ERRORS_JID;
    delete process.env['BOT_ERRORS_EXPECTED_JID'];
    delete process.env['BOT_ERRORS_REQUIRE_EXPECTED'];

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    expect(spawn).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(
      {},
      'BOT_ERRORS_EXPECTED_JID not configured; legacy alert helper disabled',
    );
    expect(loggerWarn).toHaveBeenCalledWith(
      { instance: 'whatsoup-prod', source: 'agent_respawn_failed' },
      'alert emission failed; legacy alert target not configured',
    );
  });

  it('suppresses repeated missing-expected-target configuration warnings', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    process.env['BOT_ERRORS_JID'] = BOT_ERRORS_JID;
    delete process.env['BOT_ERRORS_EXPECTED_JID'];
    delete process.env['BOT_ERRORS_REQUIRE_EXPECTED'];

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed once');
    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted again', 'crashed twice');

    const missingExpectedWarnings = loggerWarn.mock.calls.filter(([, message]) => (
      message === 'BOT_ERRORS_EXPECTED_JID not configured; legacy alert helper disabled'
    ));
    expect(missingExpectedWarnings.length).toBeLessThanOrEqual(1);
  });

  it('allows legacy fallback without BOT_ERRORS_EXPECTED_JID only when explicitly disabled', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    process.env['BOT_ERRORS_JID'] = BOT_ERRORS_JID;
    delete process.env['BOT_ERRORS_EXPECTED_JID'];
    process.env['BOT_ERRORS_REQUIRE_EXPECTED'] = '0';

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    expect(spawn).toHaveBeenCalledWith(
      ALERT_SCRIPT,
      [
        '--alert-target',
        BOT_ERRORS_JID,
        '--instance',
        'whatsoup-prod',
        '--source',
        'agent_respawn_failed',
        '--summary',
        expect.stringMatching(/"failureClass"/),
        '--evidence',
        expect.any(String),
      ],
      SPAWN_OPTIONS,
    );
  });
});

describe('emitAlert — in-process throttle (legacy fallback path)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loggerWarn.mockClear();
    existsSyncMock.mockReturnValue(true);
    fsyncSyncMock.mockClear();
    if (outboxDir) rmSync(outboxDir, { recursive: true, force: true });
    if (writefailDir) rmSync(writefailDir, { recursive: true, force: true });
    writefailDir = mkdtempSync(join(tmpdir(), 'bot-errors-writefail-'));
    // Force outbox to fail so every call exercises the legacy spawn path.
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    process.env['BOT_ERRORS_WRITEFAIL_DIR'] = writefailDir;
    process.env['BOT_ERRORS_JID'] = BOT_ERRORS_JID;
    process.env['BOT_ERRORS_EXPECTED_JID'] = BOT_ERRORS_JID;
    delete process.env['BOT_ERRORS_REQUIRE_EXPECTED'];
    resetEmitAlertThrottle();
  });

  it('spawns only once when the same (instance, source, summary) triple is emitted twice within the throttle window', () => {
    emitAlert('inst', 'src', 'summary', 'evidence 1');
    emitAlert('inst', 'src', 'summary', 'evidence 2');

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  it('spawns twice when source differs (different key -> not throttled)', () => {
    emitAlert('inst', 'src-a', 'summary', 'evidence');
    emitAlert('inst', 'src-b', 'summary', 'evidence');

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
  });

  it('spawns twice when EMIT_ALERT_THROTTLE_MS=0 disables the throttle', () => {
    process.env['EMIT_ALERT_THROTTLE_MS'] = '0';

    emitAlert('inst', 'src', 'summary', 'evidence 1');
    emitAlert('inst', 'src', 'summary', 'evidence 2');

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
  });

  it('uses the module default throttle when runtime env is non-finite', () => {
    process.env['EMIT_ALERT_THROTTLE_MS'] = 'not-a-number';

    emitAlert('inst', 'src', 'summary', 'evidence 1');
    emitAlert('inst', 'src', 'summary', 'evidence 2');

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  it('prunes expired throttle entries before accepting a new legacy fallback', () => {
    process.env['EMIT_ALERT_THROTTLE_MS'] = '10';
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1_000).mockReturnValueOnce(1_011);

    emitAlert('inst', 'src', 'summary', 'evidence 1');
    emitAlert('inst', 'src', 'summary', 'evidence 2');

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
  });

  it('logs legacy helper exits that fail by code or signal', () => {
    emitAlert('inst', 'src', 'summary', 'evidence');
    const child = spawnedChild();

    child?.emit('exit', 1, null);
    child?.emit('exit', 0, 'SIGTERM');
    child?.emit('exit', 0, null);

    expect(loggerWarn).toHaveBeenCalledWith(
      { instance: 'inst', source: 'src', exitCode: 1, signal: null },
      'alert emission failed; legacy helper exited non-zero or via signal',
    );
    expect(loggerWarn).toHaveBeenCalledWith(
      { instance: 'inst', source: 'src', exitCode: 0, signal: 'SIGTERM' },
      'alert emission failed; legacy helper exited non-zero or via signal',
    );
  });

  it('returns a failed fallback result when legacy spawn throws', () => {
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error('spawn denied');
    });

    const result = emitAlert('inst', 'src', 'summary', 'evidence');

    expect(result).toMatchObject({
      ok: false,
      channel: 'none',
      status: 'failed',
      legacy: {
        attempted: true,
        accepted: false,
        reason: 'spawn_failed',
        error: 'spawn denied',
      },
      outboxError: expect.any(String),
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      { instance: 'inst', source: 'src', err: 'spawn denied' },
      'alert emission failed; legacy helper failed',
    );
  });

  it('stringifies non-Error legacy spawn failures', () => {
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw 'spawn denied string';
    });

    const result = emitAlert('inst', 'src', 'summary', 'evidence');

    expect(result).toMatchObject({
      ok: false,
      channel: 'none',
      status: 'failed',
      legacy: {
        attempted: true,
        accepted: false,
        reason: 'spawn_failed',
        error: 'spawn denied string',
      },
      outboxError: expect.any(String),
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      { instance: 'inst', source: 'src', err: 'spawn denied string' },
      'alert emission failed; legacy helper failed',
    );
  });

  it('killSignal: SIGKILL is present in the spawn options', () => {
    emitAlert('inst', 'src', 'summary', 'evidence');

    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ killSignal: 'SIGKILL' }),
    );
  });
});

describe('BOT ERRORS alert emission governance', () => {
  it('requires checked wrappers except audited callers that inspect durable status', () => {
    const sources = listTsFiles(join(process.cwd(), 'src')).map((filePath) => ({
      path: filePath,
      text: readFileSync(filePath, 'utf8'),
    }));

    expect(scanAlertEmissionGovernance(sources)).toEqual([]);
  });

  it('rejects an unallowlisted direct caller even when it checks durable status', () => {
    const findings = scanAlertEmissionGovernance([{
      path: 'src/core/unreviewed.ts',
      text: `const result = emitAlert('i', 's', 'sum', 'evidence');\nif (result.status === 'durably_queued') advanceState();`,
    }]);

    expect(findings).toEqual([
      expect.stringContaining('unallowlisted direct emitAlert caller'),
    ]);
  });

  it('rejects an allowlisted caller that does not check durable status', () => {
    const findings = scanAlertEmissionGovernance([{
      path: 'src/core/ingest.ts',
      text: `const result = emitAlert('i', 's', 'sum', 'evidence');\nif (result.ok) advanceState();`,
    }]);

    expect(findings).toEqual([
      expect.stringContaining("lacks an explicit status ===/!== 'durably_queued' decision"),
    ]);
  });

  it('rejects an allowlisted caller that advances state before checking durable status', () => {
    const findings = scanAlertEmissionGovernance([{
      path: 'src/core/ingest.ts',
      text: `const result = emitAlert('i', 's', 'sum', 'evidence');\nadvanceState();\nif (result.status === 'durably_queued') markAccepted();`,
    }]);

    expect(findings).toEqual([
      expect.stringContaining("lacks an explicit status ===/!== 'durably_queued' decision"),
    ]);
  });

  it('rejects a non-terminating negative durable-status guard', () => {
    const findings = scanAlertEmissionGovernance([{
      path: 'src/core/ingest.ts',
      text: `const result = emitAlert('i', 's', 'sum', 'evidence');\nif (result.status !== 'durably_queued') log.warn();\nadvanceState();`,
    }]);

    expect(findings).toEqual([
      expect.stringContaining("lacks a fail-closed status ===/!== 'durably_queued' decision"),
    ]);
  });

  it('rejects legacy acceptance nested inside a negative durable-status guard', () => {
    const findings = scanAlertEmissionGovernance([{
      path: 'src/runtimes/agent/turn-finalizer.ts',
      text: `const result = emitAlert('i', 's', 'sum', 'evidence');\nif (result.status !== 'durably_queued') { if (result.ok) return durableFailure(); return dualFailure(); }\nreturn durableFailure();`,
    }]);

    expect(findings).toEqual([
      expect.stringContaining("lacks a fail-closed status ===/!== 'durably_queued' decision"),
    ]);
  });

  it.each([
    {
      label: 'an extra returned object field',
      body: `return { kind: 'dual_sink_failure', mayAdvance: false, ok: result.ok };`,
    },
    {
      label: 'a side-effect call argument',
      body: `advanceState(result.ok); return { kind: 'dual_sink_failure', mayAdvance: false };`,
    },
    {
      label: 'an element-access alias',
      body: `const legacyAccepted = result['ok']; audit(legacyAccepted); return { kind: 'dual_sink_failure', mayAdvance: false };`,
    },
  ])('rejects legacy acceptance used as $label in the non-durable branch', ({ body }) => {
    const findings = scanAlertEmissionGovernance([{
      path: 'src/runtimes/agent/turn-finalizer.ts',
      text: `const result = emitAlert('i', 's', 'sum', 'evidence');\nif (result.status !== 'durably_queued') { ${body} }\nreturn { kind: 'durable_failure_incident', mayAdvance: true };`,
    }]);

    expect(findings).toEqual([
      expect.stringContaining("lacks a fail-closed status ===/!== 'durably_queued' decision"),
    ]);
  });

  it.each([
    {
      label: 'a structured-result alias',
      body: `const legacy = result; advanceState(legacy.ok); return { kind: 'dual_sink_failure', mayAdvance: false };`,
    },
    {
      label: 'a destructured legacy flag',
      body: `const { ok } = result; advanceState(ok); return { kind: 'dual_sink_failure', mayAdvance: false };`,
    },
  ])('rejects legacy acceptance obtained through $label', ({ body }) => {
    const findings = scanAlertEmissionGovernance([{
      path: 'src/runtimes/agent/turn-finalizer.ts',
      text: `const result = emitAlert('i', 's', 'sum', 'evidence');\nif (result.status !== 'durably_queued') { ${body} }\nreturn { kind: 'durable_failure_incident', mayAdvance: true };`,
    }]);

    expect(findings).toEqual([
      expect.stringContaining("lacks a fail-closed status ===/!== 'durably_queued' decision"),
    ]);
  });

  it('rejects a parenthesized aliased direct caller outside the audited allowlist', () => {
    const findings = scanAlertEmissionGovernance([{
      path: 'src/core/unreviewed.ts',
      text: `import { emitAlert as sendAlert } from '../lib/emit-alert.ts';\nconst result = ((sendAlert))('i', 's', 'sum', 'evidence');\nreturn result.status === 'durably_queued';`,
    }]);

    expect(findings).toEqual([
      expect.stringContaining('unallowlisted direct emitAlert caller'),
    ]);
  });

  it('rejects a durable-status return weakened by a truthy fallback', () => {
    const findings = scanAlertEmissionGovernance([{
      path: 'src/core/ingest.ts',
      text: `const result = emitAlert('i', 's', 'sum', 'evidence');\nreturn result.status === 'durably_queued' || result.ok;`,
    }]);

    expect(findings).toEqual([
      expect.stringContaining("lacks a fail-closed status ===/!== 'durably_queued' decision"),
    ]);
  });

  it('rejects an object that accepts independently of its durable-status observation', () => {
    const findings = scanAlertEmissionGovernance([{
      path: 'src/core/ingest.ts',
      text: `const result = emitAlert('i', 's', 'sum', 'evidence');\nreturn { accepted: true, observedDurable: result.status === 'durably_queued' };`,
    }]);

    expect(findings).toEqual([
      expect.stringContaining("lacks a fail-closed status ===/!== 'durably_queued' decision"),
    ]);
  });

  it('rejects an object with a competing legacy-compatible acceptance field', () => {
    const findings = scanAlertEmissionGovernance([{
      path: 'src/core/ingest.ts',
      text: `const result = emitAlert('i', 's', 'sum', 'evidence');\nreturn { accepted: result.status === 'durably_queued', ok: result.ok };`,
    }]);

    expect(findings).toEqual([
      expect.stringContaining("lacks a fail-closed status ===/!== 'durably_queued' decision"),
    ]);
  });

  it('rejects an accepted object with any extra truthy field', () => {
    const findings = scanAlertEmissionGovernance([{
      path: 'src/core/ingest.ts',
      text: `const result = emitAlert('i', 's', 'sum', 'evidence');\nreturn { accepted: result.status === 'durably_queued', status: result.status, success: true };`,
    }]);

    expect(findings).toEqual([
      expect.stringContaining("lacks a fail-closed status ===/!== 'durably_queued' decision"),
    ]);
  });

  it('rejects a namespace-imported direct caller outside the audited allowlist', () => {
    const findings = scanAlertEmissionGovernance([{
      path: 'src/core/unreviewed.ts',
      text: `import * as alerts from '../lib/emit-alert.ts';\nconst result = alerts.emitAlert('i', 's', 'sum', 'evidence');\nreturn result.status === 'durably_queued';`,
    }]);

    expect(findings).toEqual([
      expect.stringContaining('unallowlisted direct emitAlert caller'),
    ]);
  });

  it('accepts the strict boolean, structured object, and H2 guard styles', () => {
    const findings = scanAlertEmissionGovernance([
      {
        path: 'src/core/ingest.ts',
        text: `const result = emitAlert('i', 's', 'sum', 'evidence');\nreturn result.status === 'durably_queued';`,
      },
      {
        path: 'src/core/ingest.ts',
        text: `const result = emitAlert('i', 's', 'sum', 'evidence');\nreturn { accepted: result.status === 'durably_queued', status: result.status };`,
      },
      {
        path: 'src/fleet/health-poller.ts',
        text: `let result;\ntry { result = emitAlert('i', 's', 'sum', 'evidence'); } catch { return false; }\nif (result.status !== 'durably_queued') { log.warn(); return false; }\nreturn true;`,
      },
    ]);

    expect(findings).toEqual([]);
  });

  it('requires the turn finalizer to reject legacy truth before callers may advance', () => {
    const weakened = scanAlertEmissionGovernance([{
      path: 'src/runtimes/agent/turn-finalizer.ts',
      text: `const result = emitAlert('i', 's', 'sum', 'evidence');\nreturn result.status === 'durably_queued' || result.ok;`,
    }]);
    const strict = scanAlertEmissionGovernance([{
      path: 'src/runtimes/agent/turn-finalizer.ts',
      text: `const result = emitAlert('i', 's', 'sum', 'evidence');\nif (result.status !== 'durably_queued') return { kind: 'dual_sink_failure', mayAdvance: false };\nreturn { kind: 'durable_failure_incident', mayAdvance: true };`,
    }]);

    expect(weakened).toEqual([
      expect.stringContaining("lacks a fail-closed status ===/!== 'durably_queued' decision"),
    ]);
    expect(strict).toEqual([]);
  });

  it('rejects an opaque return from the non-durable branch', () => {
    const findings = scanAlertEmissionGovernance([{
      path: 'src/runtimes/agent/turn-finalizer.ts',
      text: `const result = emitAlert('i', 's', 'sum', 'evidence');\nif (result.status !== 'durably_queued') return durableFailure();\nreturn durableFailure();`,
    }]);

    expect(findings).toEqual([
      expect.stringContaining("lacks a fail-closed status ===/!== 'durably_queued' decision"),
    ]);
  });
});

describe('emitAlert module initialization', () => {
  it('honors a finite default throttle value captured at import time', async () => {
    vi.clearAllMocks();
    loggerWarn.mockClear();
    process.env['EMIT_ALERT_THROTTLE_MS'] = '-5';
    vi.resetModules();
    const { emitAlert: emitWithImportedThrottle, resetEmitAlertThrottle: resetImportedThrottle } = await import('../../src/lib/emit-alert.ts');
    resetImportedThrottle();
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    writefailDir = writefailDir || mkdtempSync(join(tmpdir(), 'bot-errors-writefail-'));
    process.env['BOT_ERRORS_WRITEFAIL_DIR'] = writefailDir;
    process.env['BOT_ERRORS_JID'] = BOT_ERRORS_JID;
    process.env['BOT_ERRORS_EXPECTED_JID'] = BOT_ERRORS_JID;
    delete process.env['EMIT_ALERT_THROTTLE_MS'];

    emitWithImportedThrottle('inst', 'src', 'summary', 'evidence 1');
    emitWithImportedThrottle('inst', 'src', 'summary', 'evidence 2');

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
  });
});

describe('emitAlert non-Error outbox failures', () => {
  it('stringifies non-Error outbox failures for alert and clear fallback results', async () => {
    vi.clearAllMocks();
    loggerWarn.mockClear();
    existsSyncMock.mockReturnValue(true);
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    process.env['BOT_ERRORS_JID'] = BOT_ERRORS_JID;
    process.env['BOT_ERRORS_EXPECTED_JID'] = BOT_ERRORS_JID;
    vi.resetModules();
    vi.doMock('../../src/lib/bot-errors-outbox.ts', () => ({
      writeBotErrorsEvent: vi.fn((input: { eventType: string }) => {
        throw `${input.eventType} string failure`;
      }),
    }));
    const {
      clearAlertSource: clearWithStringFailure,
      emitAlert: emitWithStringFailure,
    } = await import('../../src/lib/emit-alert.ts');

    const alert = emitWithStringFailure('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed');
    const clear = clearWithStringFailure('whatsoup-prod', 'agent_respawn_failed');

    expect(alert).toMatchObject({
      ok: true,
      channel: 'legacy',
      status: 'legacy_accepted_unconfirmed',
      outboxError: 'alert string failure',
    });
    expect(clear).toMatchObject({
      ok: true,
      channel: 'legacy',
      status: 'legacy_accepted_unconfirmed',
      outboxError: 'clear string failure',
    });
  });
});

describe('clearAlertSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loggerWarn.mockClear();
    existsSyncMock.mockReturnValue(true);
    if (outboxDir) rmSync(outboxDir, { recursive: true, force: true });
    if (writefailDir) rmSync(writefailDir, { recursive: true, force: true });
    outboxDir = mkdtempSync(join(tmpdir(), 'bot-errors-outbox-'));
    writefailDir = mkdtempSync(join(tmpdir(), 'bot-errors-writefail-'));
    process.env['BOT_ERRORS_OUTBOX_DIR'] = outboxDir;
    process.env['BOT_ERRORS_WRITEFAIL_DIR'] = writefailDir;
    process.env['BOT_ERRORS_JID'] = BOT_ERRORS_JID;
    process.env['BOT_ERRORS_EXPECTED_JID'] = BOT_ERRORS_JID;
    delete process.env['BOT_ERRORS_REQUIRE_EXPECTED'];
    delete process.env['BOT_ERRORS_DRY_PLATFORM'];
    delete process.env['BOT_ERRORS_DRY_PLATFORM_RELEASE'];
    resetEmitAlertThrottle();
  });

  it('writes a durable clear event', () => {
    const result = clearAlertSource('whatsoup-prod', 'agent_respawn_failed');

    expect(readOnlyEvent()).toMatchObject({
      schemaVersion: 2,
      eventKind: 'incident_recovery',
      eventType: 'clear',
      severity: 'info',
      instance: 'whatsoup-prod',
      source: 'agent_respawn_failed',
    });
    expect(result).toMatchObject({
      ok: true,
      channel: 'outbox',
      status: 'durably_queued',
      outbox: { path: expect.stringContaining(outboxDir) },
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('falls back to the legacy helper when clear outbox write fails', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';

    const result = clearAlertSource('whatsoup-prod', 'agent_respawn_failed');

    expect(spawn).toHaveBeenCalledWith(
      ALERT_SCRIPT,
      ['--alert-target', BOT_ERRORS_JID, '--clear', 'repair_lane:whatsoup-prod', '--source', 'agent_respawn_failed'],
      SPAWN_OPTIONS,
    );
    const child = spawnedChild();
    expect(child?.unref).toHaveBeenCalledOnce();
    expect(child?.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(loggerWarn).toHaveBeenCalledWith(
      {
        instance: 'whatsoup-prod',
        source: 'agent_respawn_failed',
        err: expect.any(String),
      },
      'bot-errors clear outbox write failed',
    );
    expect(result).toMatchObject({
      ok: true,
      channel: 'legacy',
      status: 'legacy_accepted_unconfirmed',
      legacy: { attempted: true, accepted: true },
      outboxError: expect.any(String),
    });
    const crumb = readOnlyWritefail();
    expect(crumb.event).toMatchObject({
      eventType: 'clear',
      severity: 'info',
      instance: 'whatsoup-prod',
      source: 'agent_respawn_failed',
    });
  });

  it('requires an outbox-backed clear when causal ordering is mandatory', () => {
    const sinkPath = join(outboxDir, 'dry-run-capture.jsonl');
    process.env['WHATSOUP_ALERT_SINK'] = sinkPath;

    expect(clearAlertSourceChecked(
      'whatsoup-prod',
      'outbound_delivery_ambiguous',
      undefined,
      undefined,
      { requireDurableOutbox: true },
    )).toBe(true);
    expect(readdirSync(outboxDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    expect(() => readFileSync(sinkPath, 'utf8')).toThrow();

    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    expect(clearAlertSourceChecked(
      'whatsoup-prod',
      'outbound_delivery_ambiguous',
      undefined,
      undefined,
      { requireDurableOutbox: true },
    )).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns a failed result when both clear outbox and legacy helper fail', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    existsSyncMock.mockReturnValue(false);

    const result = clearAlertSource('whatsoup-prod', 'agent_respawn_failed');

    expect(spawn).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      channel: 'none',
      status: 'failed',
      legacy: { attempted: false, accepted: false, reason: 'helper_unavailable' },
      outboxError: expect.any(String),
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      { instance: 'whatsoup-prod', source: 'agent_respawn_failed' },
      'alert clear failed; legacy helper script not present',
    );
    const crumb = readOnlyWritefail();
    expect(crumb.event).toMatchObject({
      eventType: 'clear',
      severity: 'info',
      instance: 'whatsoup-prod',
      source: 'agent_respawn_failed',
    });
  });

  it('logs legacy fallback as accepted but unconfirmed when callers observe the result', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';

    const result = emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');
    const ok = observeAlertEmission(result, {
      instance: 'whatsoup-prod',
      source: 'agent_respawn_failed',
      operation: 'alert',
    });

    expect(ok).toBe(true);
    expect(loggerWarn).toHaveBeenCalledWith(
      {
        instance: 'whatsoup-prod',
        source: 'agent_respawn_failed',
        operation: 'alert',
        channel: 'legacy',
        status: 'legacy_accepted_unconfirmed',
        legacyAccepted: true,
      },
      'bot-errors legacy helper accepted alert; delivery is unconfirmed',
    );
  });

  it('returns true without warning when callers observe a durable outbox result', () => {
    const result = emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    expect(observeAlertEmission(result, {
      instance: 'whatsoup-prod',
      source: 'agent_respawn_failed',
      operation: 'alert',
    })).toBe(true);
    expect(loggerWarn).not.toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'outbox' }),
      expect.any(String),
    );
  });

  it('logs legacy observation even when the accepted flag is absent', () => {
    const ok = observeAlertEmission({
      ok: true,
      channel: 'legacy',
      status: 'legacy_accepted_unconfirmed',
    }, {
      instance: 'whatsoup-prod',
      source: 'agent_respawn_failed',
      operation: 'alert',
    });

    expect(ok).toBe(true);
    expect(loggerWarn).toHaveBeenCalledWith(
      {
        instance: 'whatsoup-prod',
        source: 'agent_respawn_failed',
        operation: 'alert',
        channel: 'legacy',
        status: 'legacy_accepted_unconfirmed',
        legacyAccepted: false,
      },
      'bot-errors legacy helper accepted alert; delivery is unconfirmed',
    );
  });

  it('returns false when callers observe a total emission failure', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    existsSyncMock.mockReturnValue(false);

    const result = emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');
    const ok = observeAlertEmission(result, {
      instance: 'whatsoup-prod',
      source: 'agent_respawn_failed',
      operation: 'alert',
    });

    expect(ok).toBe(false);
    expect(loggerWarn).toHaveBeenCalledWith(
      {
        instance: 'whatsoup-prod',
        source: 'agent_respawn_failed',
        operation: 'alert',
        channel: 'none',
        status: 'failed',
        outboxError: expect.any(String),
        legacyReason: 'helper_unavailable',
        legacyError: undefined,
      },
      'bot-errors alert emission failed in every channel',
    );
  });

  it('checked wrappers observe default alert severity and clear evidence', () => {
    expect(emitAlertChecked('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times')).toBe(true);
    expect(clearAlertSourceChecked('whatsoup-prod', 'agent_respawn_failed')).toBe(true);

    const events = readdirSync(outboxDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => JSON.parse(readFileSync(join(outboxDir, file), 'utf8')) as Record<string, unknown>);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: 'alert',
        severity: 'critical',
        instance: 'whatsoup-prod',
        source: 'agent_respawn_failed',
      }),
      expect.objectContaining({
        eventType: 'clear',
        severity: 'info',
        instance: 'whatsoup-prod',
        source: 'agent_respawn_failed',
        evidence: { failureClass: expect.any(String), length: expect.any(Number), correlationDigest: expect.any(String) },
      }),
    ]));
  });
});

describe('WHATSOUP_ALERT_SINK dry-run capture', () => {
  let sinkDir = '';
  let sinkPath = '';

  beforeEach(() => {
    vi.clearAllMocks();
    loggerWarn.mockClear();
    existsSyncMock.mockReturnValue(true);
    if (outboxDir) rmSync(outboxDir, { recursive: true, force: true });
    outboxDir = mkdtempSync(join(tmpdir(), 'bot-errors-outbox-'));
    process.env['BOT_ERRORS_OUTBOX_DIR'] = outboxDir;
    process.env['BOT_ERRORS_JID'] = BOT_ERRORS_JID;
    process.env['BOT_ERRORS_EXPECTED_JID'] = BOT_ERRORS_JID;
    sinkDir = mkdtempSync(join(tmpdir(), 'alert-sink-'));
    sinkPath = join(sinkDir, 'alerts.jsonl');
    process.env['WHATSOUP_ALERT_SINK'] = sinkPath;
    resetEmitAlertThrottle();
  });

  afterEach(() => {
    delete process.env['WHATSOUP_ALERT_SINK'];
    if (sinkDir) rmSync(sinkDir, { recursive: true, force: true });
    sinkDir = '';
  });

  it('captures the alert tuple to the sink and pages nothing (no outbox event, no legacy spawn)', () => {
    const ok = emitAlertChecked(
      'whatsoup-prod',
      'provider_fallback_activated',
      'Provider fallback window activated',
      'reason=empty-output provider=opencode-cli',
    );

    const lines = readFileSync(sinkPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      eventType: 'alert',
      severity: 'critical',
      instance: 'whatsoup-prod',
      source: 'provider_fallback_activated',
      summary: { failureClass: expect.any(String), length: expect.any(Number), correlationDigest: expect.any(String) },
      evidence: { failureClass: expect.any(String), length: expect.any(Number), correlationDigest: expect.any(String) },
    });
    // The whole point: NO durable outbox event, NO operator page.
    expect(readdirSync(outboxDir)).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(ok).toBe(true);
  });

  it('appends multiple records and routes clears through the sink too', () => {
    emitAlertChecked('i', 's1', 'sum1', 'reason=probe-unusable');
    clearAlertSourceChecked('i', 's1', 'repair_lane:i');

    const lines = readFileSync(sinkPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ eventType: 'alert', source: 's1', evidence: { failureClass: expect.any(String), length: expect.any(Number), correlationDigest: expect.any(String) } });
    expect(JSON.parse(lines[1]!)).toMatchObject({ eventType: 'clear', source: 's1', severity: 'info' });
    expect(readdirSync(outboxDir)).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('redacts secrets before they reach the sink file (parity with the outbox)', () => {
    emitAlertChecked('i', 'leak_probe', 'token leak', `key ${AWS_KEY_SAMPLE} leaked`);

    const raw = readFileSync(sinkPath, 'utf8');
    expect(raw).not.toContain(AWS_KEY_SAMPLE);
  });

  // ── #2287: an unwritable sink must not take the instance down ─────────────
  //
  // captureToAlertSink used to call appendFileSync bare. Both emitAlert and
  // clearAlertSource return through it BEFORE their own try/catch, so a sink
  // write failure (disk full, EACCES, path invalidated by a config reload)
  // escaped the whole emission path. Those are reached from `void`-ed async
  // paths, so the throw lands as an unhandled rejection and main.ts shuts the
  // instance down — the alerting path killing the host it exists to report on.
  describe('unwritable sink (#2287)', () => {
    // A sink under a directory that does not exist: appendFileSync raises
    // ENOENT. Deterministic and needs no fs mocking, so it exercises the real
    // failure path rather than a simulated one.
    function pointSinkAtUnwritablePath(): void {
      process.env['WHATSOUP_ALERT_SINK'] = join(sinkDir, 'missing-dir', 'alerts.jsonl');
    }

    it('does not throw, and reports the failure without paging', () => {
      pointSinkAtUnwritablePath();

      expect(() => emitAlert('whatsoup-prod', 'connection_exhausted', 'sum', 'evidence')).not.toThrow();

      const result = emitAlert('whatsoup-prod', 'connection_exhausted', 'sum2', 'evidence2');
      expect(result.ok).toBe(false);
      expect(result.channel).toBe('sink');
      expect(result.status).toBe('failed');

      // The load-bearing assertion. Sink mode's contract is that NOTHING is
      // paged; falling through to the outbox on a write failure would turn an
      // unwritable dry-run sink into a real operator page — the exact thing the
      // sink exists to prevent.
      expect(readdirSync(outboxDir)).toHaveLength(0);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('does not throw on the CLEAR path either, and also does not page', () => {
      // clearAlertSource shares captureToAlertSink and had the identical
      // defect; #2287's write-up only named emitAlert.
      pointSinkAtUnwritablePath();

      expect(() => clearAlertSource('whatsoup-prod', 'connection_exhausted')).not.toThrow();

      const result = clearAlertSource('whatsoup-prod', 'connection_exhausted');
      expect(result.ok).toBe(false);
      expect(result.channel).toBe('sink');
      expect(readdirSync(outboxDir)).toHaveLength(0);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('warns about the failed sink write rather than failing silently', () => {
      pointSinkAtUnwritablePath();
      loggerWarn.mockClear();

      emitAlert('whatsoup-prod', 'connection_exhausted', 'sum', 'evidence');

      const warned = loggerWarn.mock.calls.some(
        (call) => typeof call[1] === 'string' && call[1].includes('alert sink capture failed'),
      );
      expect(warned).toBe(true);
    });

    // The production callers are the *Checked wrappers, not the bare functions.
    // A wrapper that reported success on a failed capture would be exactly the
    // silent-success mode this fix exists to prevent, so the contract is
    // asserted at the layer production actually calls.
    it('reports failure through emitAlertChecked/clearAlertSourceChecked', () => {
      pointSinkAtUnwritablePath();

      expect(emitAlertChecked('whatsoup-prod', 'connection_exhausted', 'sum', 'evidence')).toBe(false);
      expect(clearAlertSourceChecked('whatsoup-prod', 'connection_exhausted', 'evidence')).toBe(false);
      expect(readdirSync(outboxDir)).toHaveLength(0);
    });

    it('still prefers the sink when it IS writable, and reports success', () => {
      // Over-correction guard: catching the capture error must not turn the
      // sink branch into a no-op. Asserting through emitAlertChecked covers the
      // success half of the same contract the failure case asserts above — the
      // earlier form of this test only re-asserted what the writable-sink tests
      // above already prove, so it passed with or without the fix.
      expect(emitAlertChecked('whatsoup-prod', 'connection_exhausted', 'sum', 'evidence')).toBe(true);

      expect(readFileSync(sinkPath, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(readdirSync(outboxDir)).toHaveLength(0);
    });

    // The guard has to cover event CONSTRUCTION, not just the write.
    // buildBotErrorsEvent reads ambient process state — process.cwd() throws
    // ENOENT outright once the working directory is deleted out from under a
    // long-lived instance. Built above the try, that throw escapes on the same
    // `void`-ed async path and kills the instance, which is the precise failure
    // this fix claims to prevent.
    it('survives the event itself failing to build (deleted cwd)', () => {
      const cwdSpy = vi.spyOn(process, 'cwd').mockImplementation(() => {
        throw Object.assign(new Error('ENOENT: process.cwd failed'), { code: 'ENOENT' });
      });

      try {
        expect(() => emitAlert('whatsoup-prod', 'connection_exhausted', 'sum', 'evidence')).not.toThrow();

        const result = emitAlert('whatsoup-prod', 'connection_exhausted', 'sum2', 'evidence2');
        // cwd() no longer called during event building (issue #2386 stripped
        // cwd/execPath/argv), so the event builds successfully. Channel
        // reflects the sink path; status reflects the durable outbox write.
        expect(result.ok).toBe(true);
        expect(result.channel).toBe('sink');
        expect(result.status).toBe('durably_queued');

        // Still must not page: a construction failure is not a licence to fall
        // through to the outbox ladder any more than a write failure is.
        expect(readdirSync(outboxDir)).toHaveLength(0);
      } finally {
        cwdSpy.mockRestore();
      }
    });
  });
});
