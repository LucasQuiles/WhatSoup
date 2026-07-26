import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';

import { isRecord } from '../../../src/lib/type-guards.ts';

const DEFAULT_REPOSITORY = 'LucasQuiles/WhatSoup';
const API_VERSION_HEADER = 'X-GitHub-Api-Version: 2022-11-28';
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface LiveIssue {
  number: number;
  nodeId: string;
  repository: string;
  url: string;
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed';
  updatedAt: string;
  isPullRequest: boolean;
}

export interface LivePullRequestSummary {
  number: number;
  isDraft: boolean;
}

export interface LiveInventory {
  repository: string;
  openIssueNumbers: number[];
  openPullRequests: LivePullRequestSummary[];
  labels: string[];
  counts: {
    openIssues: number;
    openPullRequests: number;
    draftPullRequests: number;
    labels: number;
  };
  pagination: {
    issuesComplete: boolean;
    pullRequestsComplete: boolean;
    labelsComplete: boolean;
  };
}

export interface IssuePatch {
  title: string;
  body: string;
  labels: string[];
}

export type GitHubAmbiguousDiagnosticCode =
  | 'transport-timeout'
  | 'process-terminated'
  | 'write-disposition-unknown'
  | 'output-bound-exceeded'
  | 'empty-response'
  | 'malformed-response';

export type GitHubWriteResult =
  | {
    kind: 'success';
    issue: LiveIssue;
    etag: string | null;
  }
  | {
    kind: 'ambiguous';
    diagnosticCode: GitHubAmbiguousDiagnosticCode;
  };

export interface GitHubIssueClient {
  readMainSha(): Promise<string>;
  readInventory(): Promise<LiveInventory>;
  readIssue(number: number): Promise<{ issue: LiveIssue; etag: string | null }>;
  updateIssue(number: number, patch: IssuePatch): Promise<GitHubWriteResult>;
}

export interface GhSpawnResult {
  pid: number;
  output: Array<string | null>;
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export type GhSpawn = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => GhSpawnResult;

type GitHubClientErrorCode =
  | 'gh-not-found'
  | 'gh-auth-failed'
  | 'gh-api-failed'
  | 'gh-empty-output'
  | 'gh-output-too-large'
  | 'gh-malformed-json'
  | 'gh-malformed-response'
  | 'gh-timeout'
  | 'gh-terminated'
  | 'pagination-incomplete';

interface GitHubClientErrorOptions {
  operation: string;
  retryable: boolean;
  cause?: unknown;
}

export class GitHubClientError extends Error {
  readonly code: GitHubClientErrorCode;
  readonly operation: string;
  readonly retryable: boolean;

  constructor(
    code: GitHubClientErrorCode,
    message: string,
    options: GitHubClientErrorOptions,
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GitHubClientError';
    this.code = code;
    this.operation = options.operation;
    this.retryable = options.retryable;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      operation: this.operation,
      retryable: this.retryable,
    };
  }
}

interface GhCliIssueClientOptions {
  repository?: string;
  spawn?: GhSpawn;
  maxOutputBytes?: number;
  pageSize?: number;
  maxPages?: number;
  timeoutMs?: number;
}

interface ApiCallOptions {
  operation: string;
  includeHeaders?: boolean;
  payload?: unknown;
}

interface IncludedResponse {
  body: unknown;
  etag: string | null;
}

function defaultSpawn(
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
): GhSpawnResult {
  return spawnSync(command, args, options) as GhSpawnResult;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function requiredString(
  value: unknown,
  field: string,
  operation: string,
  allowEmpty = false,
): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw malformedResponse(operation, `${field} must be a string`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string, operation: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw malformedResponse(operation, `${field} must be a positive integer`);
  }
  return value as number;
}

function requiredBoolean(value: unknown, field: string, operation: string): boolean {
  if (typeof value !== 'boolean') {
    throw malformedResponse(operation, `${field} must be a boolean`);
  }
  return value;
}

function malformedResponse(operation: string, detail: string, cause?: unknown): GitHubClientError {
  return new GitHubClientError(
    'gh-malformed-response',
    `GitHub response was malformed for ${operation}: ${detail}`,
    { operation, retryable: false, cause },
  );
}

function parseJson(text: string, operation: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new GitHubClientError(
      'gh-malformed-json',
      `GitHub returned malformed JSON for ${operation}`,
      { operation, retryable: false, cause: error },
    );
  }
}

function parseIncluded(text: string, operation: string): IncludedResponse {
  const crlfBoundary = text.lastIndexOf('\r\n\r\n');
  const lfBoundary = text.lastIndexOf('\n\n');
  const boundary = Math.max(crlfBoundary, lfBoundary);
  if (boundary < 0) {
    throw malformedResponse(operation, 'included response is missing a header boundary');
  }
  const separatorLength = boundary === crlfBoundary ? 4 : 2;
  const headerText = text.slice(0, boundary);
  const bodyText = text.slice(boundary + separatorLength);
  if (!/^HTTP\/\S+\s+\d{3}\b/m.test(headerText)) {
    throw malformedResponse(operation, 'included response is missing an HTTP status line');
  }
  const etagMatch = /^etag:\s*(.+?)\s*$/im.exec(headerText);
  return {
    body: parseJson(bodyText, operation),
    etag: etagMatch?.[1] ?? null,
  };
}

function parseRepository(repositoryUrl: unknown, operation: string): string {
  const value = requiredString(repositoryUrl, 'repository_url', operation);
  const match = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/.exec(value);
  if (match?.[1] === undefined) {
    throw malformedResponse(operation, 'repository_url is not a canonical API repository URL');
  }
  return match[1];
}

function parseLabels(value: unknown, operation: string): string[] {
  if (!Array.isArray(value)) {
    throw malformedResponse(operation, 'labels must be an array');
  }
  const labels = value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw malformedResponse(operation, `labels[${index}] must be an object`);
    }
    return requiredString(entry.name, `labels[${index}].name`, operation);
  });
  return labels.sort(compareUtf8);
}

function parseIssue(value: unknown, operation: string): LiveIssue {
  if (!isRecord(value)) {
    throw malformedResponse(operation, 'issue must be an object');
  }
  const state = value.state;
  if (state !== 'open' && state !== 'closed') {
    throw malformedResponse(operation, 'state must be open or closed');
  }
  return {
    number: positiveInteger(value.number, 'number', operation),
    nodeId: requiredString(value.node_id, 'node_id', operation),
    repository: parseRepository(value.repository_url, operation),
    url: requiredString(value.html_url, 'html_url', operation),
    title: requiredString(value.title, 'title', operation),
    body: value.body === null
      ? ''
      : requiredString(value.body, 'body', operation, true),
    labels: parseLabels(value.labels, operation),
    state,
    updatedAt: requiredString(value.updated_at, 'updated_at', operation),
    isPullRequest: Object.hasOwn(value, 'pull_request'),
  };
}

function parsePullRequestSummary(value: unknown, operation: string): LivePullRequestSummary {
  if (!isRecord(value)) {
    throw malformedResponse(operation, 'pull request must be an object');
  }
  return {
    number: positiveInteger(value.number, 'number', operation),
    isDraft: requiredBoolean(value.draft, 'draft', operation),
  };
}

function parseLabelName(value: unknown, operation: string): string {
  if (!isRecord(value)) throw malformedResponse(operation, 'label must be an object');
  return requiredString(value.name, 'name', operation);
}

function assertPositiveBound(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

export class GhCliIssueClient implements GitHubIssueClient {
  readonly #repository: string;
  readonly #spawn: GhSpawn;
  readonly #maxOutputBytes: number;
  readonly #pageSize: number;
  readonly #maxPages: number;
  readonly #timeoutMs: number;

  constructor(options: GhCliIssueClientOptions = {}) {
    this.#repository = options.repository ?? DEFAULT_REPOSITORY;
    this.#spawn = options.spawn ?? defaultSpawn;
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.#pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.#maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    assertPositiveBound(this.#maxOutputBytes, 'maxOutputBytes');
    assertPositiveBound(this.#pageSize, 'pageSize');
    assertPositiveBound(this.#maxPages, 'maxPages');
    assertPositiveBound(this.#timeoutMs, 'timeoutMs');
    if (this.#pageSize > 100) throw new TypeError('pageSize cannot exceed 100');
  }

  async readMainSha(): Promise<string> {
    const operation = 'read-main';
    const value = this.#apiJson(
      `repos/${this.#repository}/git/ref/heads/main`,
      'GET',
      { operation },
    );
    if (!isRecord(value) || !isRecord(value.object)) {
      throw malformedResponse(operation, 'ref object is missing');
    }
    const sha = requiredString(value.object.sha, 'object.sha', operation);
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw malformedResponse(operation, 'object.sha is not a 40-character object ID');
    }
    return sha;
  }

  async readInventory(): Promise<LiveInventory> {
    const issueValues = this.#readPages(
      'issues',
      'state=open',
      'read-inventory-issues',
    );
    const pullRequestValues = this.#readPages(
      'pulls',
      'state=open',
      'read-inventory-pull-requests',
    );
    const labelValues = this.#readPages('labels', '', 'read-inventory-labels');

    const issues = issueValues.map((value) => parseIssue(value, 'read-inventory-issues'));
    const pullRequests = pullRequestValues.map((value) =>
      parsePullRequestSummary(value, 'read-inventory-pull-requests'));
    const labels = labelValues.map((value) =>
      parseLabelName(value, 'read-inventory-labels')).sort(compareUtf8);
    const openIssueNumbers = issues
      .filter((issue) => !issue.isPullRequest)
      .map((issue) => issue.number)
      .sort((left, right) => left - right);
    const sortedPullRequests = pullRequests
      .sort((left, right) => left.number - right.number);

    return {
      repository: this.#repository,
      openIssueNumbers,
      openPullRequests: sortedPullRequests,
      labels,
      counts: {
        openIssues: openIssueNumbers.length,
        openPullRequests: sortedPullRequests.length,
        draftPullRequests: sortedPullRequests.filter((pullRequest) =>
          pullRequest.isDraft).length,
        labels: labels.length,
      },
      pagination: {
        issuesComplete: true,
        pullRequestsComplete: true,
        labelsComplete: true,
      },
    };
  }

  async readIssue(number: number): Promise<{ issue: LiveIssue; etag: string | null }> {
    assertPositiveBound(number, 'issue number');
    const operation = `read-issue-${number}`;
    const response = this.#apiIncluded(
      `repos/${this.#repository}/issues/${number}`,
      'GET',
      { operation, includeHeaders: true },
    );
    return {
      issue: parseIssue(response.body, operation),
      etag: response.etag,
    };
  }

  async updateIssue(number: number, patch: IssuePatch): Promise<GitHubWriteResult> {
    assertPositiveBound(number, 'issue number');
    const operation = `update-issue-${number}`;
    try {
      const response = this.#apiIncluded(
        `repos/${this.#repository}/issues/${number}`,
        'PATCH',
        { operation, includeHeaders: true, payload: patch },
      );
      return {
        kind: 'success',
        issue: parseIssue(response.body, operation),
        etag: response.etag,
      };
    } catch (error) {
      if (!(error instanceof GitHubClientError)) throw error;
      if (error.code === 'gh-not-found' || error.code === 'gh-auth-failed') {
        throw error;
      }
      const diagnosticCode = (() => {
        switch (error.code) {
          case 'gh-timeout':
            return 'transport-timeout';
          case 'gh-terminated':
            return 'process-terminated';
          case 'gh-output-too-large':
            return 'output-bound-exceeded';
          case 'gh-empty-output':
            return 'empty-response';
          case 'gh-malformed-json':
          case 'gh-malformed-response':
            return 'malformed-response';
          default:
            return 'write-disposition-unknown';
        }
      })();
      return { kind: 'ambiguous', diagnosticCode };
    }
  }

  #readPages(resource: string, query: string, operation: string): unknown[] {
    const values: unknown[] = [];
    for (let page = 1; page <= this.#maxPages; page += 1) {
      const queryPrefix = query === '' ? '' : `${query}&`;
      const endpoint = `repos/${this.#repository}/${resource}`
        + `?${queryPrefix}per_page=${this.#pageSize}&page=${page}`;
      const response = this.#apiJson(endpoint, 'GET', { operation });
      if (!Array.isArray(response)) {
        throw malformedResponse(operation, `page ${page} is not an array`);
      }
      values.push(...response);
      if (response.length < this.#pageSize) return values;
    }
    throw new GitHubClientError(
      'pagination-incomplete',
      `GitHub pagination could not be proven complete for ${operation}`,
      { operation, retryable: true },
    );
  }

  #apiJson(endpoint: string, method: 'GET' | 'PATCH', options: ApiCallOptions): unknown {
    return parseJson(this.#call(endpoint, method, options), options.operation);
  }

  #apiIncluded(
    endpoint: string,
    method: 'GET' | 'PATCH',
    options: ApiCallOptions,
  ): IncludedResponse {
    return parseIncluded(this.#call(endpoint, method, options), options.operation);
  }

  #call(endpoint: string, method: 'GET' | 'PATCH', options: ApiCallOptions): string {
    const args = [
      'api',
      endpoint,
      '--method',
      method,
      '--header',
      API_VERSION_HEADER,
    ];
    if (options.includeHeaders === true) args.push('--include');
    const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
      encoding: 'utf8',
      maxBuffer: this.#maxOutputBytes,
      shell: false,
      timeout: this.#timeoutMs,
      windowsHide: true,
    };
    if (options.payload !== undefined) {
      args.push('--input', '-');
      spawnOptions.input = JSON.stringify(options.payload);
    }

    let result: GhSpawnResult;
    try {
      result = this.#spawn('gh', args, spawnOptions);
    } catch (error) {
      const errorCode = error !== null && typeof error === 'object'
        ? (error as { code?: unknown }).code
        : undefined;
      if (errorCode === 'ENOENT') {
        throw new GitHubClientError(
          'gh-not-found',
          `GitHub CLI is unavailable for ${options.operation}`,
          { operation: options.operation, retryable: false, cause: error },
        );
      }
      if (errorCode === 'ETIMEDOUT') {
        throw new GitHubClientError(
          'gh-timeout',
          `GitHub CLI timed out for ${options.operation}`,
          { operation: options.operation, retryable: true, cause: error },
        );
      }
      throw new GitHubClientError(
        'gh-api-failed',
        `GitHub CLI could not start for ${options.operation}`,
        { operation: options.operation, retryable: true, cause: error },
      );
    }

    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    if (
      Buffer.byteLength(stdout, 'utf8') > this.#maxOutputBytes
      || Buffer.byteLength(stderr, 'utf8') > this.#maxOutputBytes
    ) {
      throw new GitHubClientError(
        'gh-output-too-large',
        `GitHub CLI output exceeded the configured bound for ${options.operation}`,
        { operation: options.operation, retryable: true },
      );
    }
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (errorCode === 'ENOENT') {
      throw new GitHubClientError(
        'gh-not-found',
        `GitHub CLI is unavailable for ${options.operation}`,
        { operation: options.operation, retryable: false, cause: result.error },
      );
    }
    if (errorCode === 'ETIMEDOUT') {
      throw new GitHubClientError(
        'gh-timeout',
        `GitHub CLI timed out for ${options.operation}`,
        { operation: options.operation, retryable: true, cause: result.error },
      );
    }
    if (result.signal !== null) {
      throw new GitHubClientError(
        'gh-terminated',
        `GitHub CLI was terminated for ${options.operation}`,
        { operation: options.operation, retryable: true, cause: result.error },
      );
    }
    if (result.error !== undefined || result.status !== 0) {
      const authFailure = result.status === 4
        || /(?:auth(?:entication)?|login|credential|token)/i.test(stderr);
      throw new GitHubClientError(
        authFailure ? 'gh-auth-failed' : 'gh-api-failed',
        authFailure
          ? `GitHub authentication failed for ${options.operation}`
          : `GitHub CLI request failed for ${options.operation}`,
        {
          operation: options.operation,
          retryable: !authFailure,
          cause: result.error,
        },
      );
    }
    if (stdout.trim() === '') {
      throw new GitHubClientError(
        'gh-empty-output',
        `GitHub CLI returned empty output for ${options.operation}`,
        { operation: options.operation, retryable: true },
      );
    }
    return stdout;
  }
}
