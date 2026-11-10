import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isRecord } from '../src/lib/type-guards.ts';
import { cleanGitEnv } from '../src/lib/git-env.ts';

const REPOSITORY = 'LucasQuiles/WhatSoup';
const QUALITY_ID = 272306769;
const PRIVATE_PATH = '.github/workflows/private-test-integrity.yml';
const MAX_RECEIPT_BYTES = 4096;

export interface ReleaseSource { runId: number; attempt: number; head: string }
export interface ScannerArtifact {
  artifactId: number;
  scannerRunId: number;
  scannerAttempt: number;
  scannerConclusion: 'success' | 'failure';
}
type GetJson = (suffix: string) => unknown;

export class IntegrityReleaseError extends Error {
  readonly exitCode: 1 | 125;
  constructor(message: string, exitCode: 1 | 125 = 125) {
    super(message);
    this.exitCode = exitCode;
  }
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function releaseSource(environment: NodeJS.ProcessEnv): ReleaseSource {
  const runId = Number(environment.QUALITY_RUN_ID);
  const attempt = Number(environment.QUALITY_RUN_ATTEMPT);
  const head = environment.QUALITY_HEAD_SHA ?? '';
  if (!positive(runId) || !positive(attempt) || !/^[a-f0-9]{40}$/.test(head)) {
    throw new IntegrityReleaseError('Exact Quality run, attempt and head are required');
  }
  return { runId, attempt, head };
}

function artifactName(source: ReleaseSource): string {
  return `private-integrity-${source.runId}-${source.attempt}`;
}

function sameRepository(value: unknown): boolean {
  return isRecord(value) && value.full_name === REPOSITORY;
}

function requireQuality(get: GetJson, source: ReleaseSource): void {
  const run = get(`actions/runs/${source.runId}`);
  if (!isRecord(run) || run.id !== source.runId || run.workflow_id !== QUALITY_ID
    || run.name !== 'Quality' || run.path !== '.github/workflows/quality.yml'
    || run.event !== 'push' || run.status !== 'completed' || run.run_attempt !== source.attempt
    || run.head_sha !== source.head || typeof run.head_branch !== 'string' || !run.head_branch.startsWith('v')
    || !sameRepository(run.repository) || !sameRepository(run.head_repository)) {
    throw new IntegrityReleaseError('Quality source binding is unavailable or changed');
  }
  if (run.conclusion !== 'success') throw new IntegrityReleaseError('Quality did not succeed for this release', 1);
}

function privateWorkflowId(get: GetJson): number {
  const repository = get('');
  if (!isRecord(repository) || repository.full_name !== REPOSITORY || repository.default_branch !== 'main') {
    throw new IntegrityReleaseError('Trusted default branch is unavailable or changed');
  }
  const workflow = get('actions/workflows/private-test-integrity.yml');
  if (!isRecord(workflow) || !positive(workflow.id) || workflow.path !== PRIVATE_PATH
    || workflow.name !== 'Private test integrity' || workflow.state !== 'active') {
    throw new IntegrityReleaseError('Trusted private scanner workflow is unavailable');
  }
  return workflow.id;
}

function scannerArtifact(
  get: GetJson, source: ReleaseSource, workflowId: number, artifact: unknown,
): ScannerArtifact | null {
  if (!isRecord(artifact) || artifact.name !== artifactName(source) || !positive(artifact.id)
    || artifact.expired !== false || !positive(artifact.size_in_bytes) || artifact.size_in_bytes > MAX_RECEIPT_BYTES
    || !isRecord(artifact.workflow_run) || !positive(artifact.workflow_run.id)) return null;
  const run = get(`actions/runs/${artifact.workflow_run.id}`);
  // workflow_run executes the workflow from the default branch. A check name or
  // GitHub Actions app ID alone cannot establish that authority.
  if (!isRecord(run) || run.id !== artifact.workflow_run.id || run.workflow_id !== workflowId
    || run.path !== PRIVATE_PATH || run.event !== 'workflow_run' || !positive(run.run_attempt)
    || !sameRepository(run.repository) || !sameRepository(run.head_repository)) return null;
  if (run.status !== 'completed') return null;
  if (run.conclusion !== 'success' && run.conclusion !== 'failure') {
    throw new IntegrityReleaseError('Trusted private scanner execution is incomplete');
  }
  return {
    artifactId: artifact.id, scannerRunId: run.id as number,
    scannerAttempt: run.run_attempt as number, scannerConclusion: run.conclusion,
  };
}

export function findScannerArtifact(get: GetJson, source: ReleaseSource): ScannerArtifact | null {
  requireQuality(get, source);
  const workflowId = privateWorkflowId(get);
  return listScannerArtifact(get, source, workflowId);
}

function listScannerArtifact(get: GetJson, source: ReleaseSource, workflowId: number): ScannerArtifact | null {
  const response = get(`actions/artifacts?name=${artifactName(source)}&per_page=100`);
  if (!isRecord(response) || !Array.isArray(response.artifacts) || typeof response.total_count !== 'number'
    || !Number.isSafeInteger(response.total_count) || response.total_count < 0 || response.total_count > 10
    || response.artifacts.length !== response.total_count) {
    throw new IntegrityReleaseError('Scanner artifact listing is incomplete or ambiguous');
  }
  const selected = response.artifacts.flatMap((artifact) => {
    const candidate = scannerArtifact(get, source, workflowId, artifact);
    return candidate ? [candidate] : [];
  });
  if (selected.length > 1) throw new IntegrityReleaseError('Multiple trusted scanner receipts match this Quality attempt');
  return selected[0] ?? null;
}

export function verifyScannerReceipt(value: unknown, source: ReleaseSource, producer: ScannerArtifact): void {
  const keys = ['schema_version', 'source_run_id', 'source_run_attempt', 'head_sha', 'conclusion', 'scanner_run_id', 'scanner_run_attempt'];
  if (!isRecord(value) || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))
    || value.schema_version !== 1 || value.source_run_id !== source.runId
    || value.source_run_attempt !== source.attempt || value.head_sha !== source.head
    || value.scanner_run_id !== producer.scannerRunId || value.scanner_run_attempt !== producer.scannerAttempt) {
    throw new IntegrityReleaseError('Scanner receipt does not match the exact Quality attempt and source');
  }
  if (value.conclusion === 'fail') throw new IntegrityReleaseError('Private test integrity failed', 1);
  if (value.conclusion !== 'pass') throw new IntegrityReleaseError('Private test integrity is inconclusive');
  if (producer.scannerConclusion !== 'success') throw new IntegrityReleaseError('Private scanner workflow did not finish successfully');
}

export async function waitForScannerArtifact(
  get: GetJson, source: ReleaseSource,
  options: { deadline: number; now?: () => number; wait?: (ms: number) => Promise<void> },
): Promise<ScannerArtifact> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  requireQuality(get, source);
  const workflowId = privateWorkflowId(get);
  while (now() < options.deadline) {
    const selected = listScannerArtifact(get, source, workflowId);
    if (now() >= options.deadline) break;
    if (selected) {
      requireQuality(get, source);
      if (privateWorkflowId(get) !== workflowId) throw new IntegrityReleaseError('Trusted scanner workflow changed while waiting');
      if (now() >= options.deadline) break;
      return selected;
    }
    await wait(Math.min(10_000, options.deadline - now()));
  }
  throw new IntegrityReleaseError('Timed out waiting for the trusted scanner receipt');
}

function githubReader(deadline: number, environment: NodeJS.ProcessEnv): GetJson {
  return (suffix) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new IntegrityReleaseError('GitHub read deadline expired');
    try {
      const output = execFileSync('gh', ['api', '--hostname', 'github.com', '--method', 'GET', `repos/${REPOSITORY}/${suffix}`], {
        encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: Math.min(15_000, remaining),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...cleanGitEnv(), GH_TOKEN: environment.GH_TOKEN ?? environment.GITHUB_TOKEN, GH_PROMPT_DISABLED: '1', GH_DEBUG: '' },
      });
      return JSON.parse(output);
    } catch {
      throw new IntegrityReleaseError('Bounded GitHub read failed; no release verification established');
    }
  };
}

export async function main(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const source = releaseSource(environment);
  const deadline = Date.now() + 30 * 60_000;
  const get = githubReader(deadline, environment);
  if (args.length === 1 && args[0] === 'select') {
    if (!environment.GITHUB_OUTPUT) throw new IntegrityReleaseError('GITHUB_OUTPUT is required');
    const selected = await waitForScannerArtifact(get, source, { deadline });
    appendFileSync(environment.GITHUB_OUTPUT, `artifact-id=${selected.artifactId}\nscanner-run-id=${selected.scannerRunId}\n`);
    return;
  }
  if (args.length === 3 && args[0] === 'verify' && args[1] === '--receipt') {
    const expected = { artifactId: Number(environment.SCANNER_ARTIFACT_ID), scannerRunId: Number(environment.SCANNER_RUN_ID) };
    const selected = findScannerArtifact(get, source);
    if (!selected || selected.artifactId !== expected.artifactId || selected.scannerRunId !== expected.scannerRunId) {
      throw new IntegrityReleaseError('Downloaded artifact authority is missing or changed');
    }
    const stat = lstatSync(args[2]!);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_RECEIPT_BYTES) throw new IntegrityReleaseError('Receipt file is unavailable or oversized');
    verifyScannerReceipt(JSON.parse(readFileSync(args[2]!, 'utf8')), source, selected);
    console.log(`Private integrity verified for Quality ${source.runId} attempt ${source.attempt} at ${source.head}`);
    return;
  }
  throw new IntegrityReleaseError('Usage: private-integrity-release.ts select | verify --receipt PATH');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof IntegrityReleaseError ? error.message : 'Private integrity verification could not complete');
    process.exitCode = error instanceof IntegrityReleaseError ? error.exitCode : 125;
  });
}
