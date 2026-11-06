import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { resolveTestPython } from '../helpers/python-interpreter.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runner = join(repoRoot, 'tools/private-test-integrity/run_tests.py');

it('runs the private scanner adapter tests without private scanner access', () => {
  const python = resolveTestPython();
  const scratch = mkdtempSync(join(tmpdir(), 'private-test-integrity-'));
  try {
    const canonicalScratch = realpathSync(scratch);
    const result = spawnSync(python, ['-I', '-S', '-B', runner], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH,
        HOME: canonicalScratch,
        TMPDIR: canonicalScratch,
        LANG: 'C',
        LC_ALL: 'C',
      },
      encoding: 'utf8',
      timeout: 50_000,
      maxBuffer: 1024 * 1024,
      shell: false,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.tests_run).toBeGreaterThan(0);
    expect(summary).toMatchObject({
      no_child_guard_canary: 'passed',
      unexpected_process_attempts: [],
      failures: 0,
      errors: 0,
      skipped: 0,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);

it('confines the private scanner credential to the trusted default-branch workflow', () => {
  const workflow = parse(readFileSync(join(repoRoot, '.github/workflows/private-test-integrity.yml'), 'utf8'));
  expect(workflow.on).toEqual({ workflow_run: { workflows: ['Quality'], types: ['completed'] } });
  expect(workflow.permissions).toEqual({});
  expect(Object.keys(workflow.jobs)).toEqual(['private-scanner']);
  const job = workflow.jobs['private-scanner'];
  expect(job.environment).toBe('private-scanner-trusted');
  expect(job['runs-on']).toBe('ubuntu-24.04');
  expect(job['timeout-minutes']).toBeLessThanOrEqual(30);
  expect(job.permissions).toEqual({
    actions: 'read', contents: 'read', 'pull-requests': 'read', checks: 'write',
  });
  expect(job.if.replace(/\s+/g, ' ').trim()).toBe([
    "github.repository == 'LucasQuiles/WhatSoup' &&",
    "github.event.workflow_run.event == 'pull_request' &&",
    "github.event.workflow_run.status == 'completed' &&",
    'github.event.workflow_run.head_repository.full_name == github.repository',
  ].join(' '));

  const checkouts = job.steps.filter((step: { uses?: string }) => step.uses?.startsWith('actions/checkout@'));
  expect(checkouts).toHaveLength(1);
  expect(checkouts[0].uses).toBe('actions/checkout@11d5960a326750d5838078e36cf38b85af677262');
  expect(checkouts[0].with).toMatchObject({
    repository: 'LucasQuiles/test-integrity',
    ref: 'ea0b01a4e3d99dc58a9a475c57e22ee204b04a7c',
    'ssh-key': "${{ secrets.TEST_INTEGRITY_DEPLOY_KEY || 'missing-private-scanner-key' }}",
    'persist-credentials': false,
    submodules: false,
    lfs: false,
  });
  const credentialConsumers = job.steps.filter((step: object) => JSON.stringify(step).includes('secrets.'));
  expect(credentialConsumers).toEqual(checkouts);
  expect(job.steps.some((step: { uses?: string }) => /(?:cache|download-artifact)@/.test(step.uses ?? ''))).toBe(false);

  const bootstrap = job.steps.find((step: { id?: string }) => step.id === 'trusted-driver');
  expect(bootstrap.env.TRUSTED_SHA).toBe('${{ github.sha }}');
  expect(bootstrap.run).not.toContain('github.event.workflow_run.head_sha');
  const scan = job.steps.find((step: { id?: string }) => step.id === 'scan');
  expect(scan.env.QUALITY_RUN_ID).toBe('${{ github.event.workflow_run.id }}');
  expect(scan.env.GITHUB_TOKEN).toBe('${{ github.token }}');
  expect(scan.run).toContain('-I -S -B');
  expect(scan.run).toContain('>/dev/null 2>&1');
  expect(job.steps.at(-1).if).toBe('always()');
});
