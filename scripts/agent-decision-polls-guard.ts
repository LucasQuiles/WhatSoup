#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRANCH_STEPS, RELEASE_STEPS } from './push-gate.ts';
import ts from 'typescript';
import { readText } from './lib/guard-core.ts';

export interface AgentDecisionPollsGuardResult {
  ok: boolean;
  findings: string[];
}

interface RequiredAnchor {
  file: string;
  anchors: string[];
}

const DOCUMENTATION_ANCHORS: RequiredAnchor[] = [
  {
    file: 'docs/runbooks/agent-decision-polls.md',
    anchors: ['AskUserQuestion', 'send_poll', 'multiSelect', 'selectableCount', 'Known Limits'],
  },
  {
    file: 'CLAUDE.md',
    anchors: ['docs/runbooks/agent-decision-polls.md'],
  },
  {
    file: 'README.md',
    anchors: ['docs/runbooks/agent-decision-polls.md'],
  },
  {
    file: 'docs/tools.md',
    anchors: ['send_poll', 'AskUserQuestion'],
  },
  {
    file: 'docs/configuration.md',
    anchors: ['poll-interaction-lint.mjs'],
  },
  {
    file: 'docs/public-surface.md',
    anchors: ['guard:agent-decision-polls', 'poll-interaction-lint.mjs'],
  },
];

const HOOK_TIMEOUT_MS = 2_000;
const HOOK_MAX_BUFFER_BYTES = 1024 * 1024;

function checkDocumentationAnchors(cwd: string, findings: string[]): void {
  for (const requirement of DOCUMENTATION_ANCHORS) {
    const text = readText(cwd, requirement.file);
    if (text === null) {
      findings.push(`decision-polls.docs ${requirement.file}: missing required file`);
      continue;
    }
    for (const anchor of requirement.anchors) {
      if (!text.includes(anchor)) {
        findings.push(`decision-polls.docs ${requirement.file}: missing documented promise ${JSON.stringify(anchor)}`);
      }
    }
  }
}

function visit(node: ts.Node, callback: (candidate: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function descendants(node: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  visit(node, (candidate) => nodes.push(candidate));
  return nodes;
}

function propertyNameText(name: ts.PropertyName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | null {
  const property = object.properties.find((candidate): candidate is ts.PropertyAssignment => (
    ts.isPropertyAssignment(candidate) && propertyNameText(candidate.name) === name
  ));
  return property ?? null;
}

function methodName(expression: ts.LeftHandSideExpression): string | null {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return null;
}

function expressionContainsIdentifier(node: ts.Node, name: string): boolean {
  return descendants(node).some((candidate) => ts.isIdentifier(candidate) && candidate.text === name);
}

function stringContent(node: ts.Node): string {
  return descendants(node)
    .filter((candidate): candidate is ts.StringLiteralLike => ts.isStringLiteralLike(candidate))
    .map((candidate) => candidate.text)
    .join('\n');
}

function parseTypeScript(cwd: string, relativePath: string, rule: string, findings: string[]): ts.SourceFile | null {
  const text = readText(cwd, relativePath);
  if (text === null) {
    findings.push(`${rule} ${relativePath}: missing required source file`);
    return null;
  }
  const source = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    const detail = parseDiagnostics
      .slice(0, 3)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))
      .join('; ');
    findings.push(`${rule} ${relativePath}: TypeScript parse failed: ${detail}`);
    return null;
  }
  return source;
}

function findFunction(source: ts.SourceFile, name: string): ts.FunctionLikeDeclaration | null {
  let match: ts.FunctionLikeDeclaration | null = null;
  visit(source, (node) => {
    if (match) return;
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && propertyNameText(node.name) === name) {
      match = node;
    }
  });
  return match;
}

function checkPromptGuidance(cwd: string, findings: string[]): void {
  const rule = 'decision-polls.prompt-guidance';
  const relativePath = 'src/runtimes/agent/session.ts';
  const source = parseTypeScript(cwd, relativePath, rule, findings);
  if (!source) return;

  const declaration = descendants(source).find((node): node is ts.VariableDeclaration => (
    ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'POLL_DECISION_GUIDANCE'
  ));

  if (!declaration) {
    findings.push(`${rule} ${relativePath}: declare POLL_DECISION_GUIDANCE as executable prompt data, not a comment or string mention`);
    return;
  }

  const initializer = declaration.initializer;
  const guidanceArray = initializer && ts.isCallExpression(initializer)
    && methodName(initializer.expression) === 'join'
    && ts.isPropertyAccessExpression(initializer.expression)
    && ts.isArrayLiteralExpression(initializer.expression.expression)
    ? initializer.expression.expression
    : null;
  if (!guidanceArray) {
    findings.push(`${rule} ${relativePath}: POLL_DECISION_GUIDANCE must be an array of prompt lines joined for runtime injection`);
    return;
  }

  const guidance = guidanceArray.elements
    .filter((element): element is ts.StringLiteralLike => ts.isStringLiteralLike(element))
    .map((element) => element.text)
    .join('\n');
  const missing: string[] = [];
  if (!guidance.includes('AskUserQuestion')) missing.push('AskUserQuestion routing');
  if (!/multiSelect\s*:\s*true/.test(guidance)) missing.push('multiSelect: true guidance');
  if (!/do not ask[\s\S]*type[\s\S]*i voted/i.test(guidance)) missing.push('prohibition on asking the user to type I voted');
  if (missing.length > 0) {
    findings.push(`${rule} ${relativePath}: executable guidance is missing ${missing.join(', ')}`);
  }

  const promptBuilder = findFunction(source, 'buildSystemPrompt');
  if (!promptBuilder?.body || !expressionContainsIdentifier(promptBuilder.body, 'POLL_DECISION_GUIDANCE')) {
    findings.push(`${rule} ${relativePath}: buildSystemPrompt must inject POLL_DECISION_GUIDANCE by identifier reference`);
  }
}

function findRegisteredTool(source: ts.SourceFile, toolName: string): ts.ObjectLiteralExpression | null {
  let match: ts.ObjectLiteralExpression | null = null;
  visit(source, (node) => {
    if (match || !ts.isCallExpression(node) || methodName(node.expression) !== 'register') return;
    const declaration = node.arguments[0];
    if (!declaration || !ts.isObjectLiteralExpression(declaration)) return;
    const name = objectProperty(declaration, 'name');
    if (name && ts.isStringLiteralLike(name.initializer) && name.initializer.text === toolName) match = declaration;
  });
  return match;
}

function checkMcpSchema(cwd: string, findings: string[]): void {
  const rule = 'decision-polls.mcp-schema';
  const relativePath = 'src/mcp/tools/messaging.ts';
  const source = parseTypeScript(cwd, relativePath, rule, findings);
  if (!source) return;
  const tool = findRegisteredTool(source, 'send_poll');
  if (!tool) {
    findings.push(`${rule} ${relativePath}: registry.register must receive the send_poll declaration object`);
    return;
  }

  const description = objectProperty(tool, 'description');
  const descriptionText = description ? stringContent(description.initializer) : '';
  if (!descriptionText.includes('blocking user input') || !descriptionText.includes('AskUserQuestion')) {
    findings.push(`${rule} ${relativePath}: send_poll description must route blocking input to AskUserQuestion`);
  }

  const schema = objectProperty(tool, 'schema');
  const schemaCall = schema?.initializer;
  const schemaObject = schemaCall && ts.isCallExpression(schemaCall) && methodName(schemaCall.expression) === 'object'
    ? schemaCall.arguments[0]
    : undefined;
  if (!schemaObject || !ts.isObjectLiteralExpression(schemaObject)) {
    findings.push(`${rule} ${relativePath}: send_poll schema must be a statically inspectable z.object declaration`);
    return;
  }
  const describedFields: Record<string, string> = {
    question: 'Poll question',
    options: 'Poll options',
    selectableCount: 'multi-select',
  };
  for (const [fieldName, requiredGuidance] of Object.entries(describedFields)) {
    const field = objectProperty(schemaObject, fieldName);
    if (!field || !ts.isCallExpression(field.initializer) || methodName(field.initializer.expression) !== 'describe') {
      findings.push(`${rule} ${relativePath}: send_poll schema field ${fieldName} must own its .describe(...) guidance`);
    } else if (!stringContent(field.initializer.arguments[0] ?? field.initializer).includes(requiredGuidance)) {
      findings.push(`${rule} ${relativePath}: send_poll schema field ${fieldName} description must explain ${requiredGuidance}`);
    }
  }

  const optionLimitReferences = descendants(source).filter((node) => (
    ts.isIdentifier(node) && node.text === 'POLL_OPTION_MAX_CHARS'
  )).length;
  if (optionLimitReferences < 2) {
    findings.push(`${rule} ${relativePath}: POLL_OPTION_MAX_CHARS must be enforced by the send_poll implementation`);
  }
}

function nearestFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current)
      || ts.isMethodDeclaration(current)
      || ts.isFunctionExpression(current)
      || ts.isArrowFunction(current)
      || ts.isGetAccessorDeclaration(current)
      || ts.isSetAccessorDeclaration(current)
      || ts.isConstructorDeclaration(current)) return current;
    current = current.parent;
  }
  return null;
}

function checkRegistryDescriptions(cwd: string, findings: string[]): void {
  const rule = 'decision-polls.registry-description';
  const relativePath = 'src/mcp/registry.ts';
  const source = parseTypeScript(cwd, relativePath, rule, findings);
  if (!source) return;
  const wrapper = findFunction(source, 'withZodDescription');
  const converter = findFunction(source, 'zodToJsonSchema');
  if (!wrapper?.body) {
    findings.push(`${rule} ${relativePath}: withZodDescription wrapper function is missing`);
  } else {
    const schemaParameter = wrapper.parameters[0]?.name;
    const schemaParameterName = schemaParameter && ts.isIdentifier(schemaParameter) ? schemaParameter.text : null;
    const propagatesDescription = schemaParameterName !== null && descendants(wrapper.body).some((node) => (
      ts.isPropertyAssignment(node)
      && propertyNameText(node.name) === 'description'
      && ts.isPropertyAccessExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression)
      && node.initializer.expression.text === schemaParameterName
      && node.initializer.name.text === 'description'
    ));
    if (!propagatesDescription) {
      findings.push(`${rule} ${relativePath}: withZodDescription must propagate the Zod description field`);
    }
  }
  if (!converter?.body) {
    findings.push(`${rule} ${relativePath}: zodToJsonSchema converter function is missing`);
    return;
  }

  const returns = descendants(converter.body).filter((node): node is ts.ReturnStatement => (
    ts.isReturnStatement(node) && nearestFunction(node) === converter
  ));
  const bypass = returns.find((statement) => {
    const expression = statement.expression;
    return !expression || !ts.isCallExpression(expression)
      || !ts.isIdentifier(expression.expression)
      || expression.expression.text !== 'withZodDescription';
  });
  if (returns.length === 0 || bypass) {
    findings.push(`${rule} ${relativePath}: every zodToJsonSchema return path must call withZodDescription`);
  }
}

function isPollHookPush(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || methodName(node.expression) !== 'push') return false;
  if (!ts.isPropertyAccessExpression(node.expression) || !ts.isIdentifier(node.expression.expression)
    || node.expression.expression.text !== 'postToolUseHooks') return false;
  const argument = node.arguments[0];
  if (!argument || !ts.isObjectLiteralExpression(argument)) return false;
  const type = objectProperty(argument, 'type');
  const command = objectProperty(argument, 'command');
  return Boolean(
    type && ts.isStringLiteralLike(type.initializer) && type.initializer.text === 'command'
    && command && ts.isIdentifier(command.initializer) && command.initializer.text === 'pollLintHookPath',
  );
}

function checkWorkspaceHook(cwd: string, findings: string[]): void {
  const rule = 'decision-polls.workspace-hook';
  const relativePath = 'src/core/workspace.ts';
  const source = parseTypeScript(cwd, relativePath, rule, findings);
  if (!source) return;
  const writer = findFunction(source, 'writeSandboxArtifacts');
  if (!writer?.body) {
    findings.push(`${rule} ${relativePath}: writeSandboxArtifacts function is missing`);
    return;
  }

  const pollRegistration = descendants(writer.body).some((node) => (
    ts.isIfStatement(node)
    && expressionContainsIdentifier(node.expression, 'pollLintHookPath')
    && descendants(node.thenStatement).some(isPollHookPush)
  ));
  if (!pollRegistration) {
    findings.push(`${rule} ${relativePath}: pollLintHookPath must be pushed as a command into postToolUseHooks`);
  }

  const postToolUseAssignment = descendants(writer.body).some((node) => (
    ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(node.left)
    && ts.isIdentifier(node.left.expression)
    && node.left.expression.text === 'hooks'
    && node.left.name.text === 'PostToolUse'
    && expressionContainsIdentifier(node.right, 'postToolUseHooks')
  ));
  if (!postToolUseAssignment) {
    findings.push(`${rule} ${relativePath}: hooks.PostToolUse must be assigned the collected postToolUseHooks`);
  }
}

function checkHookProcess(
  label: string,
  result: ReturnType<typeof spawnSync>,
  findings: string[],
): boolean {
  const prefix = `decision-polls.hook-execution deploy/hooks/poll-interaction-lint.mjs: ${label}`;
  if (result.error) {
    findings.push(`${prefix} probe failed to execute within ${HOOK_TIMEOUT_MS}ms and ${HOOK_MAX_BUFFER_BYTES} output bytes: ${result.error.message}`);
    return false;
  }
  if (result.signal) {
    findings.push(`${prefix} probe terminated by signal ${result.signal}`);
    return false;
  }
  if (result.status === null) {
    findings.push(`${prefix} probe returned no exit status`);
    return false;
  }
  if (result.status !== 0) {
    findings.push(`${prefix} probe exited ${result.status}; this diagnostic hook must remain fail-open`);
    return false;
  }
  return true;
}

function checkHookExecution(cwd: string, findings: string[]): void {
  const relativePath = 'deploy/hooks/poll-interaction-lint.mjs';
  const hookPath = path.join(cwd, relativePath);
  if (!existsSync(hookPath)) {
    findings.push(`decision-polls.hook-execution ${relativePath}: missing executable hook`);
    return;
  }

  const probeRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-poll-hook-probe-'));
  const home = path.join(probeRoot, 'home');
  const runProbe = (sessionId: string, text: string) => spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      session_id: sessionId,
      tool_name: 'send_message',
      tool_input: { text },
    }),
    encoding: 'utf8',
    env: { HOME: home },
    timeout: HOOK_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: HOOK_MAX_BUFFER_BYTES,
  });

  try {
    const accepted = runProbe('accepted', 'Please vote in the poll when ready.');
    const prohibited = runProbe('prohibited', 'Please type I voted after choosing an option.');
    const acceptedOk = checkHookProcess('accepted transcript', accepted, findings);
    const prohibitedOk = checkHookProcess('prohibited transcript', prohibited, findings);
    const acceptedLog = path.join(home, '.claude/session-env/accepted/poll-interaction-lint.jsonl');
    const prohibitedLog = path.join(home, '.claude/session-env/prohibited/poll-interaction-lint.jsonl');
    if (acceptedOk && existsSync(acceptedLog)) {
      findings.push(`decision-polls.hook-execution ${relativePath}: accepted transcript produced a poll-friction diagnostic`);
    }
    if (prohibitedOk) {
      if (!existsSync(prohibitedLog)) {
        findings.push(`decision-polls.hook-execution ${relativePath}: prohibited transcript produced no session-local diagnostic`);
      } else {
        const log = readFileSync(prohibitedLog, 'utf8');
        if (!log.includes('asks-user-to-type-i-voted')) {
          findings.push(`decision-polls.hook-execution ${relativePath}: prohibited transcript diagnostic omitted asks-user-to-type-i-voted`);
        }
      }
    }
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

function checkStructuralContract(cwd: string, findings: string[]): void {
  checkPromptGuidance(cwd, findings);
  checkMcpSchema(cwd, findings);
  checkRegistryDescriptions(cwd, findings);
  checkWorkspaceHook(cwd, findings);
  checkHookExecution(cwd, findings);
}

function checkPackageScripts(cwd: string, findings: string[]): void {
  const text = readText(cwd, 'package.json');
  if (text === null) {
    findings.push('package.json: missing required file');
    return;
  }

  const pkg = JSON.parse(text) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  const guard = scripts['guard:agent-decision-polls'];
  if (!guard) {
    findings.push('package.json: missing guard:agent-decision-polls script');
  } else if (!guard.includes('scripts/agent-decision-polls-guard.ts')) {
    findings.push('package.json: guard:agent-decision-polls must run scripts/agent-decision-polls-guard.ts');
  }

  // Gate composition lives in the declarative manifest (scripts/push-gate.ts)
  // since #2224; chain views over its ordered step arrays preserve the legacy
  // 'a && b && c' assertion idiom. verify:publish remains a package.json chain.
  const chainViews: Record<string, string> = {
    'verify:push:branch': BRANCH_STEPS.map((step) => step.cmd).join(' && '),
    'verify:release': RELEASE_STEPS.map((step) => step.cmd).join(' && '),
  };
  for (const scriptName of ['verify:push:branch', 'verify:release', 'verify:publish']) {
    const chain = chainViews[scriptName] ?? scripts[scriptName];
    if (!chain) {
      findings.push(`package.json: missing ${scriptName} script`);
      continue;
    }
    const guardIndex = chain.indexOf('npm run guard:agent-decision-polls');
    if (guardIndex < 0) {
      findings.push(`package.json: ${scriptName} must invoke guard:agent-decision-polls`);
      continue;
    }
    const testIndex = chain.indexOf('npm test');
    if (testIndex >= 0 && guardIndex > testIndex) {
      findings.push(`package.json: ${scriptName} must invoke guard:agent-decision-polls before npm test`);
    }
  }
}

export function checkAgentDecisionPolls(cwd = process.cwd()): AgentDecisionPollsGuardResult {
  const findings: string[] = [];
  checkStructuralContract(cwd, findings);
  checkDocumentationAnchors(cwd, findings);
  checkPackageScripts(cwd, findings);
  return { ok: findings.length === 0, findings };
}

function printHelp(): void {
  console.log(`Usage: npm run guard:agent-decision-polls

Verifies the AskUserQuestion-to-WhatsApp-poll protocol is wired across prompt guidance,
MCP schema descriptions, sandbox diagnostics, documentation, and release verification chains.`);
}

export function run(argv: string[] = process.argv.slice(2), cwd = process.cwd()): AgentDecisionPollsGuardResult {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return { ok: true, findings: [] };
  }

  const result = checkAgentDecisionPolls(cwd);
  if (!result.ok) {
    console.error('agent decision polls guard failed');
    for (const finding of result.findings) console.error(`- ${finding}`);
    process.exitCode = 1;
  } else {
    console.log('agent decision polls guard passed');
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
