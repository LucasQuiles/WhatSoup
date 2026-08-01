import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRANCH_STEPS, RELEASE_STEPS } from '../../scripts/push-gate.ts';
import { spawnSync } from 'node:child_process';

import { checkAgentDecisionPolls, run } from '../../scripts/agent-decision-polls-guard.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixtureDirs: string[] = [];

function makeFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-agent-polls-guard-'));
  fixtureDirs.push(dir);
  return dir;
}

function writeFixtureFile(fixture: string, relativePath: string, contents: string): void {
  const absolutePath = path.join(fixture, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function makeCompleteFixture(): string {
  const fixture = makeFixture();
  writeFixtureFile(fixture, 'src/runtimes/agent/session.ts', `
const POLL_DECISION_GUIDANCE = [
  'For blocking decisions, use AskUserQuestion.',
  'Use multiSelect: true when more than one answer is allowed.',
  'Do not ask the user to type "I voted".',
].join('\\n');

export function buildSystemPrompt(): string {
  return ['Agent prompt', POLL_DECISION_GUIDANCE].join('\\n');
}
`);
  writeFixtureFile(fixture, 'src/mcp/tools/messaging.ts', `
const POLL_OPTION_MAX_CHARS = 95;

export function registerMessagingTools(registry: any, z: any): void {
  registry.register({
    name: 'send_poll',
    description: 'For blocking user input, prefer AskUserQuestion when available.',
    schema: z.object({
      question: z.string().describe('Poll question text.'),
      options: z.array(z.string().describe('Short label.')).describe('Poll options.'),
      selectableCount: z.number().optional().describe('Use values above 1 for multi-select polls.'),
    }),
    handler: (params: { options: string[] }) => params.options.every((option) => option.length <= POLL_OPTION_MAX_CHARS),
  });
}
`);
  writeFixtureFile(fixture, 'src/mcp/registry.ts', `
function withZodDescription(schema: any, jsonSchema: Record<string, unknown>): Record<string, unknown> {
  return schema.description ? { ...jsonSchema, description: schema.description } : jsonSchema;
}

function zodToJsonSchema(schema: any): Record<string, unknown> {
  if (schema.kind === 'string') return withZodDescription(schema, { type: 'string' });
  return withZodDescription(schema, {});
}
`);
  writeFixtureFile(fixture, 'src/core/workspace.ts', `
export function writeSandboxArtifacts(
  hookPath: string,
  pollLintHookPath?: string,
  postToolUseLogHookPath?: string,
): Record<string, unknown> {
  const hooks: Record<string, unknown> = {
    PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: hookPath }] }],
  };
  const postToolUseHooks: Array<{ type: 'command'; command: string }> = [];
  if (pollLintHookPath) {
    postToolUseHooks.push({ type: 'command', command: pollLintHookPath });
  }
  if (postToolUseLogHookPath) {
    postToolUseHooks.push({ type: 'command', command: postToolUseLogHookPath });
  }
  if (postToolUseHooks.length > 0) {
    hooks.PostToolUse = [{ matcher: '', hooks: postToolUseHooks }];
  }
  return hooks;
}
`);
  for (const relativePath of [
    'deploy/hooks/poll-interaction-lint.mjs',
    'deploy/hooks/lib/rgp-state.mjs',
  ]) {
    writeFixtureFile(fixture, relativePath, readFileSync(path.join(repoRoot, relativePath), 'utf8'));
  }
  writeFixtureFile(fixture, 'docs/runbooks/agent-decision-polls.md', 'AskUserQuestion send_poll multiSelect selectableCount Known Limits\n');
  writeFixtureFile(fixture, 'CLAUDE.md', 'docs/runbooks/agent-decision-polls.md\n');
  writeFixtureFile(fixture, 'README.md', 'docs/runbooks/agent-decision-polls.md\n');
  writeFixtureFile(fixture, 'docs/tools.md', 'send_poll AskUserQuestion\n');
  writeFixtureFile(fixture, 'docs/configuration.md', 'poll-interaction-lint.mjs\n');
  writeFixtureFile(fixture, 'docs/public-surface.md', 'guard:agent-decision-polls poll-interaction-lint.mjs\n');
  writeFixtureFile(fixture, 'package.json', JSON.stringify({
    scripts: {
      'guard:agent-decision-polls': 'tsx scripts/agent-decision-polls-guard.ts',
      'verify:push:branch': 'npm run guard:agent-decision-polls && npm test',
      'verify:release': 'npm run guard:agent-decision-polls && npm test',
      'verify:publish': 'npm run guard:agent-decision-polls && npm test',
    },
  }, null, 2));
  return fixture;
}

function replaceFixtureText(fixture: string, relativePath: string, before: string, after: string): void {
  const absolutePath = path.join(fixture, relativePath);
  const current = readFileSync(absolutePath, 'utf8');
  expect(current, `fixture mutation anchor in ${relativePath}`).toContain(before);
  writeFileSync(absolutePath, current.replace(before, after));
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('agent decision polls guard', () => {
  it('passes for the tracked repository contract', () => {
    const result = run([], repoRoot);

    expect(process.exitCode).toBeUndefined();
    expect(result).toEqual({ ok: true, findings: [] });
  });

  it('reports missing protocol anchors with actionable file names', () => {
    const fixture = makeFixture();
    mkdirSync(path.join(fixture, 'src/runtimes/agent'), { recursive: true });
    writeFileSync(path.join(fixture, 'src/runtimes/agent/session.ts'), 'const placeholder = true;\n');
    writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ scripts: {} }, null, 2));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = run([], fixture);

    expect(process.exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining('src/runtimes/agent/session.ts'),
      expect.stringContaining('package.json: missing guard:agent-decision-polls script'),
    ]));
    expect(error.mock.calls.flat().join('\n')).toContain('agent decision polls guard failed');
  });

  it('passes a complete minimal structural and executable contract', () => {
    const result = checkAgentDecisionPolls(makeCompleteFixture());

    expect(result).toEqual({ ok: true, findings: [] });
  });

  it.each([
    {
      name: 'prompt terms moved into comments',
      file: 'src/runtimes/agent/session.ts',
      mutate: (fixture: string) => replaceFixtureText(
        fixture,
        'src/runtimes/agent/session.ts',
        `  'For blocking decisions, use AskUserQuestion.',\n  'Use multiSelect: true when more than one answer is allowed.',`,
        `  'Decision guidance is available.',\n  // For blocking decisions, use AskUserQuestion.\n  // Use multiSelect: true when more than one answer is allowed.`,
      ),
      rule: 'decision-polls.prompt-guidance',
    },
    {
      name: 'guidance identifier retained only inside a string',
      file: 'src/runtimes/agent/session.ts',
      mutate: (fixture: string) => {
        replaceFixtureText(fixture, 'src/runtimes/agent/session.ts', 'const POLL_DECISION_GUIDANCE =', 'const INERT_GUIDANCE =');
        replaceFixtureText(
          fixture,
          'src/runtimes/agent/session.ts',
          "return ['Agent prompt', POLL_DECISION_GUIDANCE].join('\\n');",
          "return ['Agent prompt mentioning POLL_DECISION_GUIDANCE', INERT_GUIDANCE].join('\\n');",
        );
      },
      rule: 'decision-polls.prompt-guidance',
    },
    {
      name: 'selectable count description detached from its schema field',
      file: 'src/mcp/tools/messaging.ts',
      mutate: (fixture: string) => replaceFixtureText(
        fixture,
        'src/mcp/tools/messaging.ts',
        "selectableCount: z.number().optional().describe('Use values above 1 for multi-select polls.'),",
        "selectableCount: z.number().optional(),\n      detachedDescription: 'Use values above 1 for multi-select polls.',",
      ),
      rule: 'decision-polls.mcp-schema',
    },
    {
      name: 'registry conversion bypasses the description wrapper',
      file: 'src/mcp/registry.ts',
      mutate: (fixture: string) => replaceFixtureText(
        fixture,
        'src/mcp/registry.ts',
        "if (schema.kind === 'string') return withZodDescription(schema, { type: 'string' });",
        "if (schema.kind === 'string') return { type: 'string' }; // withZodDescription must remain elsewhere",
      ),
      rule: 'decision-polls.registry-description',
    },
    {
      name: 'workspace keeps hook terms only in an unrelated object',
      file: 'src/core/workspace.ts',
      mutate: (fixture: string) => replaceFixtureText(
        fixture,
        'src/core/workspace.ts',
        `  if (pollLintHookPath) {\n    postToolUseHooks.push({ type: 'command', command: pollLintHookPath });\n  }`,
        `  const unrelated = { pollLintHookPath, PostToolUse: 'diagnostic label' };\n  void unrelated;`,
      ),
      rule: 'decision-polls.workspace-hook',
    },
    {
      name: 'lint hook becomes a textual no-op',
      file: 'deploy/hooks/poll-interaction-lint.mjs',
      mutate: (fixture: string) => writeFixtureFile(
        fixture,
        'deploy/hooks/poll-interaction-lint.mjs',
        "process.exit(0); // asks-user-to-type-i-voted poll-interaction-lint.jsonl\n",
      ),
      rule: 'decision-polls.hook-execution',
    },
  ])('rejects $name', ({ mutate, rule }) => {
    const fixture = makeCompleteFixture();
    mutate(fixture);

    const result = checkAgentDecisionPolls(fixture);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([expect.stringContaining(rule)]));
  });

  it('executes the fail-open hook for accepted and prohibited transcripts', () => {
    const fixture = makeCompleteFixture();
    const hookPath = path.join(fixture, 'deploy/hooks/poll-interaction-lint.mjs');
    const home = path.join(fixture, 'home');
    mkdirSync(home, { recursive: true });
    const runHook = (sessionId: string, text: string) => spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({
        session_id: sessionId,
        tool_name: 'send_message',
        tool_input: { text },
      }),
      encoding: 'utf8',
      env: { HOME: home },
      timeout: 2_000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    });

    const accepted = runHook('accepted', 'Please vote in the poll when ready.');
    const prohibited = runHook('prohibited', 'Please type I voted after choosing an option.');
    const acceptedLog = path.join(home, '.claude/session-env/accepted/poll-interaction-lint.jsonl');
    const prohibitedLog = path.join(home, '.claude/session-env/prohibited/poll-interaction-lint.jsonl');

    expect(accepted.error).toBeUndefined();
    expect(accepted.status).toBe(0);
    expect(existsSync(acceptedLog)).toBe(false);
    expect(prohibited.error).toBeUndefined();
    expect(prohibited.status).toBe(0);
    expect(readFileSync(prohibitedLog, 'utf8')).toContain('asks-user-to-type-i-voted');
  });

  it('verify chains invoke the protocol guard before expensive test phases', () => {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    // Gate composition lives in the declarative manifest (scripts/push-gate.ts)
    // since #2224; chain views over its ordered step arrays preserve the legacy
    // assertion idiom. verify:publish remains a package.json chain.
    const chainViews: Record<string, string> = {
      'verify:push:branch': BRANCH_STEPS.map((step) => step.cmd).join(' && '),
      'verify:release': RELEASE_STEPS.map((step) => step.cmd).join(' && '),
    };

    for (const scriptName of ['verify:push:branch', 'verify:release', 'verify:publish']) {
      const chain = chainViews[scriptName] ?? packageJson.scripts[scriptName];
      expect(chain, `${scriptName} script must exist`).toBeDefined();
      expect(chain).toMatch(/\bnpm run guard:agent-decision-polls\b/);
      const guardIndex = chain.indexOf('npm run guard:agent-decision-polls');
      const testIndex = chain.indexOf('npm test');
      if (testIndex >= 0) expect(guardIndex).toBeLessThan(testIndex);
    }
  });

  it('exposes a direct checker for automation without mutating process.exitCode', () => {
    const result = checkAgentDecisionPolls(repoRoot);

    expect(process.exitCode).toBeUndefined();
    expect(result.ok).toBe(true);
  });
});
