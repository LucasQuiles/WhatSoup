import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  commandSchema,
  parseArgs,
  renderRegistryMarkdown,
  run,
  type CliRuntime,
} from '../../scripts/open-issue-triage.ts';
import {
  LIVE_LABELS,
  canonicalRegistryJson,
  parseLedger,
  sha256,
  type OpenIssueRegistry,
} from '../../scripts/lib/open-issue-triage/model.ts';
import {
  GitHubClientError,
  type GitHubIssueClient,
  type GitHubWriteResult,
  type IssuePatch,
  type LiveInventory,
  type LiveIssue,
} from '../../scripts/lib/open-issue-triage/github.ts';
import {
  acquireProcessLock,
  getCurrentBootId,
  releaseProcessLock,
} from '../../src/lib/process-lock.ts';

const MAIN_SHA = 'b'.repeat(40);
const OWNER_BODY = 'Owner-authored body.\n';
const REPOSITORY = 'LucasQuiles/WhatSoup';

function utf8Sort(values: readonly string[]): string[] {
  return [...values].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function registry(): OpenIssueRegistry {
  return {
    schema_version: 1,
    repository: REPOSITORY,
    generated_at: '2026-07-26T12:30:00Z',
    pinned_main_revision: MAIN_SHA,
    inventory: {
      captured_at: '2026-07-26T12:30:00Z',
      open_issue_count: 1,
      open_pull_request_count: 0,
      draft_pull_request_count: 0,
      label_count: LIVE_LABELS.length,
      labels: utf8Sort(LIVE_LABELS),
    },
    issues: [{
      issue_number: 101,
      issue_node_id: 'I_kwDOExample101',
      title: 'Example finding',
      recommended_title: null,
      url: 'https://github.com/LucasQuiles/WhatSoup/issues/101',
      updated_at: '2026-07-26T12:00:00Z',
      pre_review_body_sha256: sha256(OWNER_BODY),
      current_labels: ['bug'],
      recommended_labels: ['bug', 'reliability'],
      classification: 'leaf',
      evidence_state: 'verified',
      pinned_revision: MAIN_SHA,
      decisive_source_paths: ['src/example.ts'],
      decisive_test_paths: ['tests/example.test.ts'],
      evidence_summary: 'The production caller does not preserve ownership.',
      falsifier_or_remaining_gap: 'Run the focused example test.',
      partial_findings: [],
      suggested_remediation: 'Give the operation one durable owner.',
      impact: 'Accepted work can be lost.',
      blast_radius: 'One runtime path.',
      affected_paths: ['src/example.ts'],
      owner_boundary: 'runtime-owner',
      acceptance_criteria: ['The focused ownership test passes.'],
      dependency_issue_numbers: [],
      duplicate_of_issue_number: null,
      implementation_after_issue_numbers: [],
      pull_request_overlaps: [],
      proposed_cohort_id: null,
      pull_request_owner_pr_number: null,
      review_confidence: 'high',
      lead_verification_obligations: ['Re-read the decisive source before mutation.'],
    }],
  };
}

function liveIssue(): LiveIssue {
  return {
    number: 101,
    nodeId: 'I_kwDOExample101',
    repository: REPOSITORY,
    url: 'https://github.com/LucasQuiles/WhatSoup/issues/101',
    title: 'Example finding',
    body: OWNER_BODY,
    labels: ['bug'],
    state: 'open',
    updatedAt: '2026-07-26T12:00:00Z',
    isPullRequest: false,
  };
}

function inventory(issueNumbers = [101]): LiveInventory {
  return {
    repository: REPOSITORY,
    openIssueNumbers: issueNumbers,
    openPullRequests: [],
    labels: utf8Sort(LIVE_LABELS),
    counts: {
      openIssues: issueNumbers.length,
      openPullRequests: 0,
      draftPullRequests: 0,
      labels: LIVE_LABELS.length,
    },
    pagination: {
      issuesComplete: true,
      pullRequestsComplete: true,
      labelsComplete: true,
    },
  };
}

class FakeClient implements GitHubIssueClient {
  readonly updates: Array<{ number: number; patch: IssuePatch }> = [];
  readonly calls: string[] = [];
  liveInventory = inventory();
  issue = liveIssue();

  async readMainSha(): Promise<string> {
    this.calls.push('main');
    return MAIN_SHA;
  }

  async readInventory(): Promise<LiveInventory> {
    this.calls.push('inventory');
    return structuredClone(this.liveInventory);
  }

  async readIssue(number: number): Promise<{ issue: LiveIssue; etag: string | null }> {
    this.calls.push(`issue:${number}`);
    return { issue: structuredClone(this.issue), etag: '"fixture-etag"' };
  }

  async updateIssue(number: number, patch: IssuePatch): Promise<GitHubWriteResult> {
    this.calls.push(`update:${number}`);
    this.updates.push({ number, patch: structuredClone(patch) });
    this.issue = {
      ...this.issue,
      title: patch.title,
      body: patch.body,
      labels: [...patch.labels],
    };
    return { kind: 'success', issue: structuredClone(this.issue), etag: '"after-etag"' };
  }
}

interface Harness {
  stdout: string[];
  stderr: string[];
  runtime: CliRuntime;
}

function harness(overrides: Partial<CliRuntime> = {}): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    runtime: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      now: () => '2026-07-26T14:00:00Z',
      delay: async () => undefined,
      git: () => ({ status: 0, stdout: '', stderr: '' }),
      ...overrides,
    },
  };
}

const roots: string[] = [];

function fixtureRoot(options: { generatedView?: boolean; git?: boolean } = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'whatsoup-triage-cli-')));
  roots.push(root);
  mkdirSync(join(root, 'docs/triage/plans'), { recursive: true });
  mkdirSync(join(root, 'docs/triage/snapshots'), { recursive: true });
  writeFileSync(
    join(root, 'docs/triage/open-issue-registry.json'),
    canonicalRegistryJson(registry()),
  );
  writeFileSync(join(root, 'docs/triage/open-issue-review-ledger.jsonl'), '\n');
  if (options.generatedView === true) {
    writeFileSync(
      join(root, 'docs/triage/open-issue-registry.md'),
      renderRegistryMarkdown(registry()),
    );
  }
  if (options.git === true) {
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
    execFileSync(
      'git',
      ['config', 'user.email', 'fixture@users.noreply.github.com'],
      { cwd: root },
    );
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root });
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    execFileSync('rm', ['-rf', root]);
  }
});

describe('open issue triage CLI', () => {
  it('exports an import-safe command boundary', () => {
    expect(typeof parseArgs).toBe('function');
    expect(typeof run).toBe('function');
    expect(commandSchema()).toMatchObject({
      schema_version: 1,
      command: 'schema',
    });
  });

  it('rejects missing confirmations, unknown commands and flags, duplicates, and bad types', () => {
    expect(() => parseArgs([
      'issue',
      'apply',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--plan',
      'docs/triage/plans/batch-101.json',
    ])).toThrow(/confirm-plan-sha256/);
    expect(() => parseArgs([
      'issue',
      'dry-run',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--issue-number',
      '101',
      '--expected-main-oid',
      MAIN_SHA,
      '--output',
      'docs/triage/plans/batch-101.json',
      '--unknown',
    ])).toThrow(/unknown/i);
    expect(() => parseArgs(['unknown'])).toThrow(/unknown/i);
    expect(() => parseArgs(['check', '--registry', 'a', '--registry', 'b']))
      .toThrow(/duplicate/i);
    expect(() => parseArgs([
      'snapshot',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--output',
      'docs/triage/snapshots/snapshot.json',
      '--limit',
      '1.5',
    ])).toThrow(/limit/i);
    expect(() => parseArgs(['check'])).toThrow(/registry/i);
    expect(() => parseArgs([
      'render',
      '--registry',
      'docs/triage/open-issue-registry.json',
    ])).toThrow(/check|write/i);
    expect(() => parseArgs([
      'snapshot',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--output',
      'docs/triage/snapshots/example.json',
      '--limit',
      '-1',
    ])).toThrow(/positive integer/i);
  });

  it('discovers compact schemas fully offline with TTY-independent JSON and effects', async () => {
    const client = new FakeClient();
    const nonTty = harness({ isTTY: false });
    const tty = harness({ isTTY: true });

    expect(await run(['schema'], '/does/not/exist', client, nonTty.runtime)).toBe(0);
    expect(await run(['schema'], '/does/not/exist', client, tty.runtime)).toBe(0);
    expect(nonTty.stdout).toEqual(tty.stdout);
    expect(nonTty.stderr).toEqual([]);
    expect(client.calls).toEqual([]);
    const document = JSON.parse(nonTty.stdout.join('')) as {
      commands: Array<{
        name: string;
        effects: Record<string, boolean>;
        input_schema: unknown;
        output_schema: unknown;
        confirmation: unknown;
        retry: unknown;
      }>;
    };
    expect(document.commands.map((command) => command.name)).toEqual([
      'check',
      'issue apply',
      'issue dry-run',
      'issue re-read',
      'render --check',
      'render --write',
      'schema',
      'snapshot',
    ]);
    expect(document.commands.every((command) =>
      Object.keys(command.effects).sort().join(',') ===
        'destructive,idempotent,open_world,read_only,supports_dry_run')).toBe(true);
    expect(document.commands.every((command) =>
      command.input_schema !== undefined
      && command.output_schema !== undefined
      && command.confirmation !== undefined
      && command.retry !== undefined)).toBe(true);
    const apply = document.commands.find((command) => command.name === 'issue apply')!;
    expect(apply.effects.supports_dry_run).toBe(false);
    expect(apply.input_schema).toMatchObject({
      properties: {
        plan: {
          pattern: '^docs\\/triage\\/plans\\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.json$',
        },
      },
    });
    const reRead = document.commands.find((command) => command.name === 'issue re-read')!;
    expect(reRead.input_schema).toMatchObject({
      properties: {
        plan: {
          pattern: '^docs\\/triage\\/plans\\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.json$',
        },
      },
    });
    const schema = document.commands.find((command) => command.name === 'schema')!;
    expect(schema.output_schema).toMatchObject({
      required: expect.arrayContaining(['commands']),
      properties: { commands: { type: 'array' } },
    });
  });

  it('checks registry, empty ledger, hash chain, and generated Markdown entirely offline', async () => {
    const root = fixtureRoot({ generatedView: true });
    const client = new FakeClient();
    const io = harness();

    expect(await run([
      'check',
      '--registry',
      'docs/triage/open-issue-registry.json',
    ], root, client, io.runtime)).toBe(0);
    expect(client.calls).toEqual([]);
    expect(io.stderr).toEqual([]);

    writeFileSync(join(root, 'docs/triage/open-issue-registry.md'), '# drift\n');
    const drift = harness();
    expect(await run([
      'render',
      '--check',
      '--registry',
      'docs/triage/open-issue-registry.json',
    ], root, client, drift.runtime)).toBe(1);
    expect(drift.stdout).toEqual([]);
    expect(JSON.parse(drift.stderr.join(''))).toMatchObject({
      kind: 'generated-view-drift',
      retryable: false,
    });
    expect(client.calls).toEqual([]);
  });

  it('writes the generated view only through the explicit render mutation', async () => {
    const root = fixtureRoot();
    const client = new FakeClient();
    const io = harness();
    const output = join(root, 'docs/triage/open-issue-registry.md');

    expect(existsSync(output)).toBe(false);
    expect(await run([
      'render',
      '--write',
      '--registry',
      'docs/triage/open-issue-registry.json',
    ], root, client, io.runtime)).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(renderRegistryMarkdown(registry()));
    expect(client.calls).toEqual([]);

    writeFileSync(output, '# stale generated view\n');
    const rewrite = harness();
    expect(await run([
      'render',
      '--write',
      '--registry',
      'docs/triage/open-issue-registry.json',
    ], root, client, rewrite.runtime)).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(renderRegistryMarkdown(registry()));

    unlinkSync(output);
    symlinkSync('missing-target.md', output);
    const dangling = harness();
    expect(await run([
      'render',
      '--write',
      '--registry',
      'docs/triage/open-issue-registry.json',
    ], root, client, dangling.runtime)).toBe(4);
    expect(JSON.parse(dangling.stderr.join(''))).toMatchObject({
      kind: 'unsafe-generated-view',
      retryable: false,
    });
  });

  it('creates a body-free dry-run plan exclusively and never PATCHes', async () => {
    const root = fixtureRoot();
    const client = new FakeClient();
    const io = harness();
    const args = [
      'issue',
      'dry-run',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--issue-number',
      '101',
      '--expected-main-oid',
      MAIN_SHA,
      '--output',
      'docs/triage/plans/batch-101.json',
    ];

    expect(await run(args, root, client, io.runtime)).toBe(0);
    expect(client.updates).toEqual([]);
    const artifact = readFileSync(join(root, 'docs/triage/plans/batch-101.json'), 'utf8');
    expect(artifact).not.toContain(OWNER_BODY.trim());
    expect(artifact).not.toContain('"body":');
    expect(JSON.parse(io.stdout.join(''))).toMatchObject({
      schema_version: 1,
      ok: true,
      command: 'issue dry-run',
      summary: {
        artifact_path: 'docs/triage/plans/batch-101.json',
        issue_numbers: [101],
      },
    });

    const second = harness();
    expect(await run(args, root, client, second.runtime)).toBe(4);
    expect(second.stdout).toEqual([]);
    expect(JSON.parse(second.stderr.join(''))).toMatchObject({
      kind: 'artifact-exists',
      retryable: false,
    });
  });

  it('re-reads only a tracked, clean, digest-valid plan bound to the registry', async () => {
    const root = fixtureRoot();
    const client = new FakeClient();
    const output = 'docs/triage/plans/batch-101.json';
    const planned = harness();

    expect(await run([
      'issue',
      'dry-run',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--issue-number',
      '101',
      '--expected-main-oid',
      MAIN_SHA,
      '--output',
      output,
    ], root, client, planned.runtime)).toBe(0);

    const cleanGit = (gitArgs: string[]) => gitArgs[0] === 'ls-files'
      ? { status: 0, stdout: `${output}\n`, stderr: '' }
      : { status: 0, stdout: '', stderr: '' };
    const reread = harness({ git: cleanGit });
    expect(await run([
      'issue',
      're-read',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--plan',
      output,
    ], root, client, reread.runtime)).toBe(0);
    expect(JSON.parse(reread.stdout.join(''))).toMatchObject({
      summary: {
        status: 'review-required',
        issues: [{ issue_number: 101, state: 'before' }],
      },
    });

    const originalIssue = structuredClone(client.issue);
    for (const identityDrift of [
      { nodeId: 'I_kwDODifferent' },
      { repository: 'LucasQuiles/Different' },
      { url: 'https://github.com/LucasQuiles/WhatSoup/issues/999' },
      { state: 'closed' as const },
      { isPullRequest: true },
    ]) {
      client.issue = { ...originalIssue, ...identityDrift };
      const drifted = harness({ git: cleanGit });
      expect(await run([
        'issue',
        're-read',
        '--registry',
        'docs/triage/open-issue-registry.json',
        '--plan',
        output,
      ], root, client, drifted.runtime)).toBe(0);
      expect(JSON.parse(drifted.stdout.join(''))).toMatchObject({
        summary: {
          status: 'review-required',
          issues: [{ issue_number: 101, state: 'third-state' }],
        },
      });
    }
    client.issue = originalIssue;

    const planPath = join(root, output);
    const forged = JSON.parse(readFileSync(planPath, 'utf8')) as Array<Record<string, unknown>>;
    forged[0]!.issue_node_id = 'I_kwDOForged';
    writeFileSync(planPath, `${JSON.stringify(forged)}\n`);
    const invalid = harness({ git: cleanGit });
    expect(await run([
      'issue',
      're-read',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--plan',
      output,
    ], root, client, invalid.runtime)).toBe(3);

    const untracked = harness({
      git: () => ({ status: 1, stdout: '', stderr: '' }),
    });
    expect(await run([
      'issue',
      're-read',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--plan',
      output,
    ], root, client, untracked.runtime)).toBe(4);
    expect(client.updates).toEqual([]);
  });

  it('classifies unsafe live-body rendering as a public-safety rejection', async () => {
    const root = fixtureRoot();
    const client = new FakeClient();
    const unsafeBody = ['Owner path: ', 'Users', 'privateoperator', 'project'].join('/');
    client.issue.body = unsafeBody;
    const updatedRegistry = registry();
    updatedRegistry.issues[0]!.pre_review_body_sha256 = sha256(unsafeBody);
    writeFileSync(
      join(root, 'docs/triage/open-issue-registry.json'),
      canonicalRegistryJson(updatedRegistry),
    );
    const io = harness();

    expect(await run([
      'issue',
      'dry-run',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--issue-number',
      '101',
      '--expected-main-oid',
      MAIN_SHA,
      '--output',
      'docs/triage/plans/unsafe.json',
    ], root, client, io.runtime)).toBe(4);
    expect(io.stdout).toEqual([]);
    expect(JSON.parse(io.stderr.join(''))).toMatchObject({
      kind: 'public-safety-rejection',
      retryable: false,
    });
    expect(client.updates).toEqual([]);
  });

  it('rejects escaped, symlinked, and hardlinked output surfaces', async () => {
    const root = fixtureRoot();
    const client = new FakeClient();
    const common = [
      'issue',
      'dry-run',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--issue-number',
      '101',
      '--expected-main-oid',
      MAIN_SHA,
    ];

    const escaped = harness();
    expect(await run([
      ...common,
      '--output',
      '../outside.json',
    ], root, client, escaped.runtime)).toBe(4);

    const real = join(root, 'docs/triage/real-plans');
    mkdirSync(real);
    symlinkSync(real, join(root, 'docs/triage/plans-link'));
    const symlinked = harness();
    expect(await run([
      ...common,
      '--output',
      'docs/triage/plans-link/batch.json',
    ], root, client, symlinked.runtime)).toBe(4);

    const existing = join(root, 'docs/triage/plans/existing.json');
    writeFileSync(existing, '');
    linkSync(existing, join(root, 'docs/triage/plans/alias.json'));
    const hardlinked = harness();
    expect(await run([
      ...common,
      '--output',
      'docs/triage/plans/alias.json',
    ], root, client, hardlinked.runtime)).toBe(4);

    symlinkSync('missing-target.json', join(root, 'docs/triage/plans/dangling.json'));
    const dangling = harness();
    expect(await run([
      ...common,
      '--output',
      'docs/triage/plans/dangling.json',
    ], root, client, dangling.runtime)).toBe(4);
    expect(JSON.parse(dangling.stderr.join(''))).toMatchObject({
      kind: 'artifact-exists',
      retryable: false,
    });
    expect(client.updates).toEqual([]);
  });

  it('fails closed when the plans ancestor is swapped before artifact open', async () => {
    const root = fixtureRoot();
    const external = fixtureRoot();
    const sentinel = join(external, 'sentinel.txt');
    writeFileSync(sentinel, 'unchanged\n');
    const plans = join(root, 'docs/triage/plans');
    const displaced = join(root, 'docs/triage/plans-displaced');
    const output = 'docs/triage/plans/before-open.json';
    const client = new FakeClient();
    const io = harness({
      artifactHooks: {
        beforeOpen: () => {
          renameSync(plans, displaced);
          symlinkSync(external, plans);
        },
      },
    });

    expect(await run([
      'issue',
      'dry-run',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--issue-number',
      '101',
      '--expected-main-oid',
      MAIN_SHA,
      '--output',
      output,
    ], root, client, io.runtime)).toBe(4);
    expect(JSON.parse(io.stderr.join(''))).toMatchObject({
      kind: 'artifact-identity-changed',
      retryable: false,
    });
    expect(readFileSync(sentinel, 'utf8')).toBe('unchanged\n');
    expect(existsSync(join(external, 'before-open.json'))).toBe(false);
    expect(client.updates).toEqual([]);
  });

  it('does not create a leaf through a symlinked ancestor before rejecting it', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'whatsoup-triage-cli-')));
    const external = realpathSync(mkdtempSync(join(tmpdir(), 'whatsoup-triage-external-')));
    roots.push(root, external);
    mkdirSync(join(root, 'docs'));
    symlinkSync(external, join(root, 'docs/triage'));
    writeFileSync(join(root, 'registry.json'), canonicalRegistryJson(registry()));
    const client = new FakeClient();
    const io = harness();

    expect(await run([
      'issue',
      'dry-run',
      '--registry',
      'registry.json',
      '--issue-number',
      '101',
      '--expected-main-oid',
      MAIN_SHA,
      '--output',
      'docs/triage/plans/no-external-write.json',
    ], root, client, io.runtime)).toBe(4);
    expect(JSON.parse(io.stderr.join(''))).toMatchObject({
      kind: 'unsafe-path',
      retryable: false,
    });
    expect(existsSync(join(external, 'plans'))).toBe(false);
    expect(client.updates).toEqual([]);
  });

  it('refuses an artifact write while a cooperating writer lock exists', async () => {
    const root = fixtureRoot();
    const lock = join(root, '.open-issue-triage-artifact-write.lock');
    const held = acquireProcessLock(lock, { token: 'held-artifact-writer' });
    const client = new FakeClient();
    const io = harness();

    try {
      expect(await run([
        'issue',
        'dry-run',
        '--registry',
        'docs/triage/open-issue-registry.json',
        '--issue-number',
        '101',
        '--expected-main-oid',
        MAIN_SHA,
        '--output',
        'docs/triage/plans/locked.json',
      ], root, client, io.runtime)).toBe(4);
      expect(JSON.parse(io.stderr.join(''))).toMatchObject({
        kind: 'artifact-write-locked',
        retryable: true,
      });
      expect(existsSync(join(root, 'docs/triage/plans/locked.json'))).toBe(false);
      expect(client.updates).toEqual([]);
    } finally {
      expect(releaseProcessLock(held)).toBe(true);
    }
  });

  it('recovers a dead same-boot artifact writer lock without operator cleanup', async () => {
    const root = fixtureRoot();
    const lock = join(root, '.open-issue-triage-artifact-write.lock');
    const deadChild = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8',
    });
    writeFileSync(lock, JSON.stringify({
      pid: Number(deadChild),
      token: 'dead-artifact-writer',
      startedAt: '2026-07-26T14:00:00.000Z',
      bootId: getCurrentBootId(),
    }));
    const client = new FakeClient();
    const io = harness();

    expect(await run([
      'issue',
      'dry-run',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--issue-number',
      '101',
      '--expected-main-oid',
      MAIN_SHA,
      '--output',
      'docs/triage/plans/recovered.json',
    ], root, client, io.runtime)).toBe(0);
    expect(existsSync(join(root, 'docs/triage/plans/recovered.json'))).toBe(true);
    expect(existsSync(lock)).toBe(false);
    expect(client.updates).toEqual([]);
  });

  it('rejects an identical-payload artifact lock replacement before artifact open', async () => {
    const root = fixtureRoot();
    const lock = join(root, '.open-issue-triage-artifact-write.lock');
    const displaced = `${lock}.displaced`;
    const client = new FakeClient();
    const io = harness({
      artifactHooks: {
        beforeOpen: () => {
          const payload = readFileSync(lock, 'utf8');
          renameSync(lock, displaced);
          writeFileSync(lock, payload, { mode: 0o600 });
        },
      },
    });

    expect(await run([
      'issue',
      'dry-run',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--issue-number',
      '101',
      '--expected-main-oid',
      MAIN_SHA,
      '--output',
      'docs/triage/plans/replaced-lock.json',
    ], root, client, io.runtime)).toBe(4);
    expect(JSON.parse(io.stderr.join(''))).toMatchObject({
      kind: 'artifact-identity-changed',
      retryable: false,
    });
    expect(existsSync(join(root, 'docs/triage/plans/replaced-lock.json'))).toBe(false);
    expect(client.updates).toEqual([]);
  });

  it('fails closed when the triage ancestor is swapped after open before mutation', async () => {
    const root = fixtureRoot();
    const external = fixtureRoot();
    mkdirSync(join(external, 'plans'), { recursive: true });
    const sentinel = join(external, 'sentinel.txt');
    writeFileSync(sentinel, 'unchanged\n');
    const triage = join(root, 'docs/triage');
    const displaced = join(root, 'docs/triage-displaced');
    const output = 'docs/triage/plans/after-open.json';
    const client = new FakeClient();
    const io = harness({
      artifactHooks: {
        afterOpenBeforeMutation: () => {
          renameSync(triage, displaced);
          symlinkSync(external, triage);
        },
      },
    });

    expect(await run([
      'issue',
      'dry-run',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--issue-number',
      '101',
      '--expected-main-oid',
      MAIN_SHA,
      '--output',
      output,
    ], root, client, io.runtime)).toBe(4);
    expect(JSON.parse(io.stderr.join(''))).toMatchObject({
      kind: 'artifact-identity-changed',
      retryable: false,
    });
    expect(readFileSync(sentinel, 'utf8')).toBe('unchanged\n');
    expect(existsSync(join(external, 'plans/after-open.json'))).toBe(false);
    expect(client.updates).toEqual([]);
  });

  it('supports bounded inventory projection without leaking unrequested fields', async () => {
    const root = fixtureRoot();
    const client = new FakeClient();
    client.liveInventory = inventory(Array.from({ length: 50 }, (_, index) => index + 1));
    const io = harness();

    expect(await run([
      'snapshot',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--output',
      'docs/triage/snapshots/projected.json',
      '--fields',
      'counts,open_issue_numbers',
      '--limit',
      '3',
    ], root, client, io.runtime)).toBe(0);
    const snapshot = JSON.parse(
      readFileSync(join(root, 'docs/triage/snapshots/projected.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      schema_version: 1,
      fields: ['counts', 'open_issue_numbers'],
      open_issue_numbers: [1, 2, 3],
      truncated: { open_issue_numbers: true },
    });
    expect(snapshot).not.toHaveProperty('labels');
    expect(snapshot).not.toHaveProperty('open_pull_requests');
    expect(io.stderr).toEqual([]);
  });

  it('applies a tracked clean plan once and emits only body-free receipt summaries', async () => {
    const root = fixtureRoot();
    const client = new FakeClient();
    const output = 'docs/triage/plans/apply-101.json';
    const planned = harness();
    expect(await run([
      'issue',
      'dry-run',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--issue-number',
      '101',
      '--expected-main-oid',
      MAIN_SHA,
      '--output',
      output,
    ], root, client, planned.runtime)).toBe(0);
    const plans = JSON.parse(readFileSync(join(root, output), 'utf8')) as Array<{
      plan_sha256: string;
    }>;
    const clean = harness({
      git: (gitArgs) => gitArgs[0] === 'ls-files'
        ? { status: 0, stdout: `${output}\n`, stderr: '' }
        : { status: 0, stdout: '', stderr: '' },
    });
    const args = [
      'issue',
      'apply',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--plan',
      output,
      '--confirm-plan-sha256',
      plans[0]!.plan_sha256,
      '--confirm-issues',
      '101',
      '--idempotency-key',
      'apply-101-v1',
    ];

    expect(await run(args, root, client, clean.runtime)).toBe(0);
    expect(client.updates).toHaveLength(1);
    expect(clean.stderr).toEqual([]);
    const outputJson = clean.stdout.join('');
    expect(outputJson).not.toContain(OWNER_BODY.trim());
    expect(outputJson).not.toContain('"body":');
    expect(JSON.parse(outputJson)).toMatchObject({
      summary: {
        status: 'verified',
        operation_id: 'apply-101-v1',
        receipt_count: 3,
        issue_results: [{
          issue_number: 101,
          result: 'applied-verified',
        }],
      },
    });
    const ledger = readFileSync(
      join(root, 'docs/triage/open-issue-review-ledger.jsonl'),
      'utf8',
    );
    expect(parseLedger(ledger)).toHaveLength(3);
    expect(ledger).not.toContain(OWNER_BODY.trim());
  });

  it('stops with exit 5 and durable target-unknown evidence after an ambiguous write', async () => {
    class AmbiguousClient extends FakeClient {
      override async updateIssue(
        number: number,
        patch: IssuePatch,
      ): Promise<GitHubWriteResult> {
        this.calls.push(`update:${number}`);
        this.updates.push({ number, patch: structuredClone(patch) });
        return { kind: 'ambiguous', diagnosticCode: 'transport-timeout' };
      }
    }

    const root = fixtureRoot();
    const client = new AmbiguousClient();
    const output = 'docs/triage/plans/ambiguous-101.json';
    expect(await run([
      'issue',
      'dry-run',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--issue-number',
      '101',
      '--expected-main-oid',
      MAIN_SHA,
      '--output',
      output,
    ], root, client, harness().runtime)).toBe(0);
    const plans = JSON.parse(readFileSync(join(root, output), 'utf8')) as Array<{
      plan_sha256: string;
    }>;
    const io = harness({
      git: (gitArgs) => gitArgs[0] === 'ls-files'
        ? { status: 0, stdout: `${output}\n`, stderr: '' }
        : { status: 0, stdout: '', stderr: '' },
    });

    expect(await run([
      'issue',
      'apply',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--plan',
      output,
      '--confirm-plan-sha256',
      plans[0]!.plan_sha256,
      '--confirm-issues',
      '101',
      '--idempotency-key',
      'ambiguous-101-v1',
    ], root, client, io.runtime)).toBe(5);
    expect(io.stdout).toEqual([]);
    expect(JSON.parse(io.stderr.join(''))).toMatchObject({
      kind: 'write-outcome-unknown',
    });
    expect(client.updates).toHaveLength(1);
    expect(parseLedger(readFileSync(
      join(root, 'docs/triage/open-issue-review-ledger.jsonl'),
      'utf8',
    )).map((receipt) => receipt.receipt_type)).toEqual([
      'batch_started',
      'target_unknown',
    ]);
  });

  it('maps a pre-mutation GitHub transport failure to exit 6', async () => {
    class FailingClient extends FakeClient {
      override async readMainSha(): Promise<string> {
        throw new GitHubClientError(
          'gh-timeout',
          'fixture timeout',
          { operation: 'read-main', retryable: true },
        );
      }
    }

    const root = fixtureRoot();
    const client = new FailingClient();
    const io = harness();
    expect(await run([
      'issue',
      'dry-run',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--issue-number',
      '101',
      '--expected-main-oid',
      MAIN_SHA,
      '--output',
      'docs/triage/plans/transport-failure.json',
    ], root, client, io.runtime)).toBe(6);
    expect(io.stdout).toEqual([]);
    expect(JSON.parse(io.stderr.join(''))).toMatchObject({
      kind: 'gh-timeout',
      retryable: true,
    });
    expect(client.updates).toEqual([]);
  });

  it('refuses untracked or dirty apply plans before client access', async () => {
    const root = fixtureRoot({ git: true });
    const client = new FakeClient();
    const planPath = join(root, 'docs/triage/plans/batch-101.json');
    writeFileSync(planPath, '[]\n');
    const args = [
      'issue',
      'apply',
      '--registry',
      'docs/triage/open-issue-registry.json',
      '--plan',
      'docs/triage/plans/batch-101.json',
      '--confirm-plan-sha256',
      'c'.repeat(64),
      '--confirm-issues',
      '101',
      '--idempotency-key',
      'batch-101-v1',
    ];
    const untracked = harness({
      git: (gitArgs) => gitArgs[0] === 'ls-files'
        ? { status: 1, stdout: '', stderr: '' }
        : { status: 0, stdout: '', stderr: '' },
    });
    expect(await run(args, root, client, untracked.runtime)).toBe(4);
    expect(client.calls).toEqual([]);
    expect(client.updates).toEqual([]);

    const dirty = harness({
      git: (gitArgs) => gitArgs[0] === 'ls-files'
        ? { status: 0, stdout: 'docs/triage/plans/batch-101.json\n', stderr: '' }
        : { status: 1, stdout: '', stderr: '' },
    });
    expect(await run(args, root, client, dirty.runtime)).toBe(4);
    expect(client.calls).toEqual([]);
  });

  it('emits one bounded structured error on stderr and leaves stdout empty', async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, 'docs/triage/open-issue-registry.json'), '{broken');
    const io = harness();

    expect(await run([
      'check',
      '--registry',
      'docs/triage/open-issue-registry.json',
    ], root, new FakeClient(), io.runtime)).toBe(2);
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toHaveLength(1);
    const error = JSON.parse(io.stderr[0]!) as Record<string, unknown>;
    expect(error).toMatchObject({
      schema_version: 1,
      ok: false,
      kind: 'invalid-json',
      retryable: false,
    });
    expect(error.message).toEqual(expect.any(String));
    expect(error.hint).toEqual(expect.any(String));
    expect(JSON.stringify(error).length).toBeLessThan(4096);
  });

  it('classifies PUBLIC-safety rejection as workflow policy rather than schema invalidity', async () => {
    const root = fixtureRoot({ generatedView: true });
    const unsafe = registry();
    unsafe.issues[0]!.evidence_summary = ['', 'Users', 'privateoperator', 'project'].join('/');
    writeFileSync(
      join(root, 'docs/triage/open-issue-registry.json'),
      canonicalRegistryJson(unsafe),
    );
    const io = harness();

    expect(await run([
      'check',
      '--registry',
      'docs/triage/open-issue-registry.json',
    ], root, new FakeClient(), io.runtime)).toBe(4);
    expect(io.stdout).toEqual([]);
    expect(JSON.parse(io.stderr.join(''))).toMatchObject({
      kind: 'public-safety-rejection',
      retryable: false,
    });
  });
});
