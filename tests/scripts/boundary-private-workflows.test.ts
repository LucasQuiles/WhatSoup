/**
 * Wiring of the two hosted private boundary workflows.
 *
 * - `.github/workflows/boundary-private.yml` runs after Quality (workflow_run) and publishes the
 *   `boundary (private)` check run on the candidate head.
 * - `.github/workflows/boundary-private-text.yml` scans issue text and comments on their events
 *   and lists changed issues, comments, reviews and review comments every hour.
 *
 * Both run only trusted code: the exact files of the scan driver's import closure, read from the
 * default-branch commit, and one pinned action. The term list reaches one step, as a file with
 * mode 0600 that an always() step removes. No run block holds an expression, and nothing uploads,
 * comments, labels or edits. The secret steps run here under bash.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { CHECK_NAME } from '../../scripts/boundary-private-scan.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SETUP_NODE = 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020';
const DRIVER = 'scripts/boundary-private-scan.ts';

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, string>;
  readonly run?: string;
  readonly shell?: string;
}

interface Workflow {
  readonly name: string;
  readonly on: Record<string, unknown>;
  readonly permissions: unknown;
  readonly concurrency?: unknown;
  readonly jobs: Record<string, Record<string, unknown> & { steps: Step[] }>;
}

const readWorkflow = (file: string): Workflow => parse(readFileSync(resolve(repoRoot, '.github/workflows', file), 'utf8')) as Workflow;

/** The driver's static import closure, from its source: every relative `from '…'` specifier, followed. */
function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    const id = relative(repoRoot, file);
    if (seen.has(id)) return;
    seen.add(id);
    for (const match of readFileSync(file, 'utf8').matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
      visit(resolve(dirname(file), match[1]!));
    }
  };
  visit(resolve(repoRoot, entry));
  return [...seen].sort();
}

const trustedFiles = (step: Step | undefined): string[] =>
  String(step?.env?.['TRUSTED_FILES'] ?? '').split('\n').filter((line) => line !== '').sort();

const WORKFLOWS = [
  {
    file: 'boundary-private.yml',
    prefix: 'boundary (private):',
    permissions: { actions: 'read', contents: 'read', 'pull-requests': 'read', checks: 'write' },
  },
  {
    file: 'boundary-private-text.yml',
    prefix: 'boundary text:',
    permissions: { actions: 'read', contents: 'read', issues: 'read', 'pull-requests': 'read' },
  },
] as const;

describe.each(WORKFLOWS)('$file', ({ file, permissions }) => {
  const workflow = readWorkflow(file);
  const jobs = Object.entries(workflow.jobs);
  const job = workflow.jobs['scan']!;
  const steps = job.steps;
  const step = (name: string): Step | undefined => steps.find((entry) => entry.name === name);
  const index = (name: string): number => steps.findIndex((entry) => entry.name === name);

  it('runs one job in the trusted environment with no top-level and only read-or-check permissions', () => {
    expect(workflow.permissions).toEqual({});
    expect(jobs.map(([id]) => id)).toEqual(['scan']);
    expect(job['environment']).toBe('private-scanner-trusted');
    expect(job['permissions']).toEqual(permissions);
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(String(job['if'])).toContain("github.repository == 'LucasQuiles/WhatSoup'");
    // Actions makes a check run per job; only the driver may publish the check name.
    expect(job['name']).toBeUndefined();
    expect(JSON.stringify(workflow)).not.toContain('secrets: inherit');
  });

  it('uses one action, pinned by full commit sha, that reads no workspace configuration', () => {
    const uses = steps.filter((entry) => entry.uses !== undefined);
    expect(uses.map((entry) => entry.uses)).toEqual([SETUP_NODE]);
    expect(uses[0]!.with).toEqual({ 'node-version': '24.x' });
  });

  it('reads exactly the driver\'s import closure from the default-branch commit', () => {
    const read = step('Read exact trusted scanner files');
    expect(read?.env?.['TRUSTED_SHA']).toBe('${{ github.sha }}');
    expect(trustedFiles(read)).toEqual(importClosure(DRIVER));
    for (const fragment of [
      '--max-filesize 1048576',
      "--proto '=https'",
      "--header 'Accept: application/vnd.github.raw+json'",
      'contents/$file?ref=$TRUSTED_SHA',
      'test "$status" = 200',
      `printf '{"type":"module"}\\n' > "$trusted/package.json"`,
    ]) {
      expect(read?.run, fragment).toContain(fragment);
    }
    expect(index('Read exact trusted scanner files')).toBeLessThan(index('Set up Node.js 24'));
  });

  it('keeps every expression out of run blocks and every write verb out of the job', () => {
    expect(steps.filter((entry) => /\$\{\{/.test(entry.run ?? '')).map((entry) => entry.name)).toEqual([]);
    for (const entry of steps) {
      expect(entry.run ?? '', String(entry.name)).not.toMatch(/\bgh\s|--data|--request|\s-X\s|set -x|github-script|upload-artifact/);
    }
  });

  it('gives the secret to the write step only, and removes the file in an always() step before anything else runs', () => {
    const secretSteps = steps.filter((entry) => JSON.stringify(entry).includes('secrets.'));
    expect(secretSteps.map((entry) => entry.name)).toEqual(['Write the private term file']);
    expect(secretSteps[0]!.env).toEqual({ WHATSOUP_PRIVATE_TERMS_JSON: '${{ secrets.WHATSOUP_PRIVATE_TERMS_JSON }}' });
    const remove = step('Remove the private term file');
    expect(remove?.if).toBe('always()');
    const removeAt = index('Remove the private term file');
    expect(removeAt).toBeGreaterThan(index('Write the private term file'));
    for (const later of steps.slice(removeAt + 1)) expect(later.if, String(later.name)).toBe('always()');
  });

  it('runs node only under env -i, and never with the token and the term file in one process', () => {
    let nodeCalls = 0;
    for (const entry of steps) {
      for (const call of (entry.run ?? '').split(/\n(?=\s*env -i )/)) {
        if (!/\bnode "\$scratch\/trusted\/scripts\/boundary-private-scan\.ts"/.test(call)) continue;
        nodeCalls += 1;
        expect(call.trimStart().startsWith('env -i '), String(entry.name)).toBe(true);
        const token = call.includes('GITHUB_TOKEN=');
        const terms = call.includes('WHATSOUP_PRIVATE_TERMS_FILE=');
        expect(token && terms, String(entry.name)).toBe(false);
      }
    }
    expect(nodeCalls).toBeGreaterThanOrEqual(2);
  });
});

describe('boundary-private.yml triggers and publication', () => {
  const workflow = readWorkflow('boundary-private.yml');
  const steps = workflow.jobs['scan']!.steps;
  const names = steps.map((entry) => entry.name);

  it('starts only when Quality completes, and binds only its pull_request runs', () => {
    expect(workflow.on).toEqual({ workflow_run: { workflows: ['Quality'], types: ['completed'] } });
    expect(String(workflow.jobs['scan']!['if'])).toContain("github.event.workflow_run.event == 'pull_request'");
  });

  it('passes event values through env only, then binds, fetches, scans and publishes in that order', () => {
    expect(names).toEqual([
      'Create the owned scratch folder',
      'Read exact trusted scanner files',
      'Set up Node.js 24',
      'Bind the candidate to the Quality run',
      'Fetch the candidate commits as data',
      'Write the private term file',
      'Scan the candidate',
      'Remove the private term file',
      `Publish the ${CHECK_NAME} check run`,
    ]);
    const bind = steps.find((entry) => entry.name === 'Bind the candidate to the Quality run');
    expect(bind?.env).toEqual({
      GITHUB_TOKEN: '${{ github.token }}',
      QUALITY_RUN_ID: '${{ github.event.workflow_run.id }}',
      QUALITY_HEAD_SHA: '${{ github.event.workflow_run.head_sha }}',
    });
    expect(steps.at(-1)?.run).toContain(' publish --out "$scratch"');
    expect(CHECK_NAME).toBe('boundary (private)');
  });

  it('queues the runs for one head so they publish in order, and lets publication re-read the pull request', () => {
    expect(workflow.concurrency).toEqual({
      group: 'boundary-private-${{ github.event.workflow_run.head_sha }}',
      'cancel-in-progress': false,
    });
    const publish = steps.at(-1);
    expect(publish?.env).toMatchObject({ QUALITY_RUN_ID: '${{ github.event.workflow_run.id }}' });
    expect(publish?.run).toContain('QUALITY_RUN_ID="$QUALITY_RUN_ID"');
  });
});

describe('boundary-private-text.yml triggers', () => {
  const workflow = readWorkflow('boundary-private-text.yml');

  it('reads issues and comments on their events and everything else hourly, never in a pull request context', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['issue_comment', 'issues', 'schedule']);
    expect(workflow.on['issues']).toEqual({ types: ['opened', 'edited'] });
    expect(workflow.on['issue_comment']).toEqual({ types: ['created', 'edited'] });
    expect(workflow.on['schedule']).toEqual([{ cron: expect.stringMatching(/^[0-5]?[0-9] \* \* \* \*$/) }]);
  });
});

describe.each(WORKFLOWS)('the secret steps of $file, run under bash', ({ file, prefix }) => {
  const steps = readWorkflow(file).jobs['scan']!.steps;
  const script = (name: string): string => String(steps.find((entry) => entry.name === name)?.run);
  let runnerTemp: string;

  beforeEach(() => {
    runnerTemp = mkdtempSync(join(tmpdir(), 'whatsoup-boundary-secret-'));
  });
  afterEach(() => {
    rmSync(runnerTemp, { recursive: true, force: true });
  });

  const run = (name: string, secret?: string): { status: number | null; lines: string[] } => {
    const result = spawnSync('bash', ['-c', script(name)], {
      cwd: runnerTemp,
      env: { PATH: process.env['PATH'] ?? '', RUNNER_TEMP: runnerTemp, ...(secret === undefined ? {} : { WHATSOUP_PRIVATE_TERMS_JSON: secret }) },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { status: result.status, lines: `${result.stdout}${result.stderr}`.split('\n').filter((line) => line !== '') };
  };
  const termsFile = (): string => join(runnerTemp, 'private-terms.json');

  it.each([['an empty', ''], ['a missing', undefined]])('fails closed with one fixed line on %s secret', (_label, secret) => {
    expect(run('Write the private term file', secret)).toEqual({
      status: 1,
      lines: [`${prefix} the private term secret is missing or empty; the check fails closed`],
    });
    expect(existsSync(termsFile())).toBe(false);
  });

  it('writes the secret as an owner-only file, prints nothing, and the always() step removes it', () => {
    const secret = '{"schema":"whatsoup-private-terms","version":1,"terms":[]}';
    expect(run('Write the private term file', secret)).toEqual({ status: 0, lines: [] });
    expect(readFileSync(termsFile(), 'utf8')).toBe(secret);
    expect(statSync(termsFile()).mode & 0o777).toBe(0o600);
    expect(run('Remove the private term file')).toEqual({ status: 0, lines: [] });
    expect(existsSync(termsFile())).toBe(false);
    expect(run('Remove the private term file')).toEqual({ status: 0, lines: [] });
  });
});
