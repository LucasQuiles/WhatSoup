#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readText } from './lib/guard-core.ts';

export interface AgentDecisionPollsGuardResult {
  ok: boolean;
  findings: string[];
}

interface RequiredAnchor {
  file: string;
  anchors: string[];
}

const REQUIRED_ANCHORS: RequiredAnchor[] = [
  {
    file: 'src/runtimes/agent/session.ts',
    anchors: [
      'POLL_DECISION_GUIDANCE',
      'AskUserQuestion',
      'multiSelect: true',
      'Do not ask the user to type "I voted"',
    ],
  },
  {
    file: 'src/mcp/tools/messaging.ts',
    anchors: [
      'blocking user input, prefer AskUserQuestion',
      '.describe(',
      'POLL_OPTION_MAX_CHARS',
      'selectableCount',
    ],
  },
  {
    file: 'src/mcp/registry.ts',
    anchors: ['withZodDescription'],
  },
  {
    file: 'deploy/hooks/poll-interaction-lint.mjs',
    anchors: ['asks-user-to-type-i-voted', 'poll-interaction-lint.jsonl'],
  },
  {
    file: 'src/core/workspace.ts',
    anchors: ['pollLintHookPath', 'PostToolUse'],
  },
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

function checkAnchors(cwd: string, findings: string[]): void {
  for (const requirement of REQUIRED_ANCHORS) {
    const text = readText(cwd, requirement.file);
    if (text === null) {
      findings.push(`${requirement.file}: missing required file`);
      continue;
    }
    for (const anchor of requirement.anchors) {
      if (!text.includes(anchor)) {
        findings.push(`${requirement.file}: missing anchor ${JSON.stringify(anchor)}`);
      }
    }
  }
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

  for (const scriptName of ['verify:push:branch', 'verify:release', 'verify:publish']) {
    const chain = scripts[scriptName];
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
  checkAnchors(cwd, findings);
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
