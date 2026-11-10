import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { resolveTestPython } from '../helpers/python-interpreter.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runner = join(repoRoot, 'tools/private-test-integrity/run_tests.py');

interface CurlResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

function runCurl(args: string[]): Promise<CurlResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('curl', args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    if (child.stderr === null) {
      rejectPromise(new Error('curl stderr pipe is unavailable'));
      return;
    }
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', rejectPromise);
    child.once('close', (status, signal) => resolvePromise({ status, signal, stderr }));
  });
}

async function startPayloadServer(payload: Buffer): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    if (request.url === '/unknown-length') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.end(payload);
      return;
    }
    if (request.url === '/short-content-length') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '1' });
      response.end(payload);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('payload server did not bind TCP');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
}

function runTrustedDriverBootstrap(bootstrap: string, curlVersion: string): { status: number; stderr: string; curlLog: string } {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'private-test-integrity-bootstrap-')));
  const script = join(scratch, 'trusted-driver.sh');
  const fakeCurl = join(scratch, 'curl');
  const curlLog = join(scratch, 'curl.log');
  const scannerRoot = join(scratch, 'scanner');
  try {
    mkdirSync(scannerRoot);
    writeFileSync(script, bootstrap);
    writeFileSync(fakeCurl, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  printf "version:%s\\n" "$FAKE_CURL_VERSION" >> "$CURL_LOG"',
      '  printf "curl %s mock\\n" "$FAKE_CURL_VERSION"',
      '  exit 0',
      'fi',
      'output=""',
      'max_filesize=""',
      'while (($#)); do',
      '  case "$1" in',
      '    --output) output="$2"; shift 2 ;;',
      '    --max-filesize) max_filesize="$2"; shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      'test -n "$output"',
      'test -n "$max_filesize"',
      'printf "%s\\n" "$max_filesize" >> "$CURL_LOG"',
      'printf x > "$output"',
      'printf 200',
    ].join('\n'));
    chmodSync(fakeCurl, 0o700);
    const result = spawnSync('/bin/bash', [script], {
      cwd: scratch,
      env: {
        PATH: `${scratch}:${process.env.PATH}`,
        TRUSTED_SHA: 'a'.repeat(40),
        SCANNER_ROOT: scannerRoot,
        GITHUB_TOKEN: 'test-token',
        FAKE_CURL_VERSION: curlVersion,
        CURL_LOG: curlLog,
      },
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      shell: false,
    });
    if (result.error !== undefined) throw result.error;
    if (result.signal !== null) throw new Error(`trusted driver bootstrap terminated by ${result.signal}`);
    if (result.status === null) throw new Error('trusted driver bootstrap has no exit status');
    return { status: result.status, stderr: result.stderr, curlLog: existsSync(curlLog) ? readFileSync(curlLog, 'utf8') : '' };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

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
    "github.event.workflow_run.status == 'completed' &&",
    'github.event.workflow_run.head_repository.full_name == github.repository && (',
    "github.event.workflow_run.event == 'pull_request' ||",
    "(github.event.workflow_run.event == 'push' && (github.event.workflow_run.head_branch == 'main' || startsWith(github.event.workflow_run.head_branch, 'v'))) ||",
    "(github.event.workflow_run.event == 'schedule' && github.event.workflow_run.head_branch == 'main') )",
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
  const setupPython = job.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/setup-python@'));
  expect(setupPython?.uses).toBe('actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065');
  const credentialConsumers = job.steps.filter((step: object) => JSON.stringify(step).includes('secrets.'));
  expect(credentialConsumers).toEqual(checkouts);
  expect(job.steps.some((step: { uses?: string }) => /(?:cache|download-artifact)@/.test(step.uses ?? ''))).toBe(false);

  const bootstrap = job.steps.find((step: { id?: string }) => step.id === 'trusted-driver');
  expect(bootstrap.env.TRUSTED_SHA).toBe('${{ github.sha }}');
  expect(bootstrap.run).not.toContain('github.event.workflow_run.head_sha');
  expect(bootstrap.run).toContain('scanner_grammars.py');
  const grammars = job.steps.find((step: { id?: string }) => step.id === 'grammars');
  expect(grammars.env).toEqual({ SCANNER_ROOT: '${{ steps.scratch.outputs.root }}' });
  expect(job.steps.indexOf(grammars)).toBeGreaterThan(job.steps.indexOf(bootstrap));
  expect(job.steps.indexOf(grammars)).toBeLessThan(job.steps.indexOf(checkouts[0]));
  expect(grammars.run).toContain('--max-filesize 19134009');
  expect(grammars.run).toContain('"$SCANNER_ROOT/driver/scanner_grammars.py" "$archive" "$SCANNER_ROOT/grammar-cache"');
  const scan = job.steps.find((step: { id?: string }) => step.id === 'scan');
  expect(scan.env.QUALITY_RUN_ID).toBe('${{ github.event.workflow_run.id }}');
  expect(scan.env.GITHUB_TOKEN).toBe('${{ github.token }}');
  expect(scan.run).toContain('-I -S -B');
  expect(scan.run).toContain('>/dev/null 2>&1');
  const cleanupIndex = job.steps.findIndex((step: { id?: string }) => step.id === 'cleanup');
  const uploadIndex = job.steps.findIndex((step: { uses?: string }) => step.uses?.startsWith('actions/upload-artifact@'));
  expect(cleanupIndex).toBeGreaterThan(job.steps.indexOf(scan));
  expect(job.steps[cleanupIndex].if).toBe('always()');
  expect(uploadIndex).toBeGreaterThan(cleanupIndex);
  expect(job.steps[uploadIndex].with.path).toBe('${{ runner.temp }}/private-integrity/receipt.json');
  expect(job.steps.at(-1).name).toBe('Enforce private scanner conclusion');
  expect(job.steps.at(-1).if).toBe('always()');
});

it('provides tag and daily Quality producers for private receipt qualification', () => {
  const workflow = parse(readFileSync(join(repoRoot, '.github/workflows/quality.yml'), 'utf8'));
  expect(workflow.on.push.tags).toEqual(['v*']);
  expect(workflow.on.schedule).toEqual([{ cron: '23 6 * * *' }]);
  expect(workflow.concurrency['cancel-in-progress']).toBe("${{ github.event_name != 'merge_group' && !startsWith(github.ref, 'refs/tags/') }}");
});

it.each(['scratch', 'cleanup'])('refuses a failed filesystem operation during %s', (stepId) => {
  const workflow = parse(readFileSync(join(repoRoot, '.github/workflows/private-test-integrity.yml'), 'utf8'));
  const step = workflow.jobs['private-scanner'].steps.find((item: { id?: string }) => item.id === stepId);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'private-scanner-filesystem-')));
  const workspace = join(scratch, 'workspace');
  const scannerRoot = join(workspace, '.private-scanner.fixture');
  try {
    mkdirSync(scannerRoot, { recursive: true });
    writeFileSync(join(scannerRoot, 'preserved'), 'owned scanner data');
    writeFileSync(join(scratch, 'sudo'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$OPERATION_LOG"\nexit 23\n');
    writeFileSync(join(scratch, 'mountpoint'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(scratch, 'sudo'), 0o700);
    chmodSync(join(scratch, 'mountpoint'), 0o700);
    const result = spawnSync('/bin/bash', ['-c', step.run], {
      env: { PATH: `${scratch}:${process.env.PATH}`, GITHUB_WORKSPACE: workspace,
        GITHUB_OUTPUT: join(scratch, 'output'), SCANNER_ROOT: scannerRoot,
        OPERATION_LOG: join(scratch, 'operations'), TMPDIR: scratch },
      encoding: 'utf8', timeout: 10_000, shell: false,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(23);
    const operation = readFileSync(join(scratch, 'operations'), 'utf8');
    expect(operation).toContain(stepId === 'scratch' ? 'mount -t tmpfs' : 'umount --');
    if (stepId === 'scratch') {
      expect(operation).toContain('size=512m,nr_inodes=16384');
    } else {
      expect(readFileSync(join(scannerRoot, 'preserved'), 'utf8')).toBe('owned scanner data');
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

it('refuses an old curl before trusted-driver downloads and executes the supported bootstrap path', () => {
  const workflow = parse(readFileSync(join(repoRoot, '.github/workflows/private-test-integrity.yml'), 'utf8'));
  const bootstrap = workflow.jobs['private-scanner'].steps.find((step: { id?: string }) => step.id === 'trusted-driver');

  const oldCurl = runTrustedDriverBootstrap(bootstrap.run, '8.3.0');
  expect(oldCurl.curlLog).toBe('version:8.3.0\n');
  expect(oldCurl.status, oldCurl.stderr).toBe(2);
  expect(oldCurl.stderr).toContain('curl 8.4.0 or newer is required for bounded trusted-driver downloads');

  const supportedCurl = runTrustedDriverBootstrap(bootstrap.run, '8.4.0');
  expect(supportedCurl.status, supportedCurl.stderr).toBe(0);
  expect(supportedCurl.curlLog.split('\n').filter(Boolean)).toEqual(expect.arrayContaining(['version:8.4.0', '1048576', '16384']));
});

it('installed curl bounds an unknown-length response and honors short Content-Length framing', async () => {
  const version = spawnSync('curl', ['--version'], { encoding: 'utf8', shell: false });
  expect(version.status, version.stderr).toBe(0);
  const match = /^curl (\d+)\.(\d+)\.(\d+)/m.exec(version.stdout);
  expect(match).not.toBeNull();
  const [, major, minor] = match!;
  expect(Number(major) > 8 || (Number(major) === 8 && Number(minor) >= 4)).toBe(true);

  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'private-test-integrity-curl-')));
  let server: Server | undefined;
  try {
    const started = await startPayloadServer(Buffer.alloc(512, 'x'));
    server = started.server;
    const unknownOutput = join(scratch, 'unknown.bin');
    const unknown = await runCurl(['--silent', '--show-error', '--connect-timeout', '1', '--max-time', '3', '--max-filesize', '128', '--output', unknownOutput, `${started.baseUrl}/unknown-length`]);
    expect(unknown.signal).toBeNull();
    expect(unknown.status, unknown.stderr).toBe(63);
    expect(statSync(unknownOutput).size).toBeLessThanOrEqual(128);

    const shortOutput = join(scratch, 'short.bin');
    const short = await runCurl(['--silent', '--show-error', '--connect-timeout', '1', '--max-time', '3', '--max-filesize', '128', '--output', shortOutput, `${started.baseUrl}/short-content-length`]);
    expect(short.signal).toBeNull();
    expect(short.status, short.stderr).toBe(0);
    expect(statSync(shortOutput).size).toBe(1);
  } finally {
    try {
      if (server !== undefined) await closeServer(server);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});
