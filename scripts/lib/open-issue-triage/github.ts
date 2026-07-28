import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";

import { isRecord } from "../../../src/lib/type-guards.ts";

const DEFAULT_REPOSITORY = "LucasQuiles/WhatSoup";
const API_VERSION_HEADER = "X-GitHub-Api-Version: 2022-11-28";
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CAPTURE_PULL_REQUESTS = 1_000;
const DEFAULT_MAX_CAPTURE_REQUESTS = 10_000;
const DEFAULT_MAX_CAPTURE_OUTPUT_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_CAPTURE_DURATION_MS = 15 * 60_000;
const CLOSING_REFERENCES_QUERY = `query RegistryClosingReferences(
  $owner: String!
  $name: String!
  $number: Int!
  $pageSize: Int!
  $endCursor: String
) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: $pageSize, after: $endCursor) {
        nodes { number }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

export interface LiveIssue {
  number: number;
  nodeId: string;
  repository: string;
  url: string;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
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

export interface RegistryCaptureIssue {
  number: number;
  nodeId: string;
  title: string;
  url: string;
  body: string;
  updatedAt: string;
  labels: string[];
}

export interface RegistryCapturePullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  updatedAt: string;
  disposition: "open" | "merged" | "closed-unmerged";
  isDraft: boolean;
  headRefName: string | null;
  baseRefName: string | null;
  changedFiles: number;
  files: string[];
  closingIssueNumbers: number[];
}

export interface RegistryCapture {
  repository: string;
  issues: RegistryCaptureIssue[];
  pullRequests: RegistryCapturePullRequest[];
  labels: string[];
  pagination: {
    issuesComplete: true;
    pullRequestsComplete: true;
    labelsComplete: true;
    changedFilesComplete: true;
    closingReferencesComplete: true;
  };
}

export interface IssuePatch {
  title: string;
  body: string;
  labels: string[];
}

export type GitHubAmbiguousDiagnosticCode =
  | "transport-timeout"
  | "process-terminated"
  | "write-disposition-unknown"
  | "output-bound-exceeded"
  | "empty-response"
  | "malformed-response";

export type GitHubWriteResult =
  | {
      kind: "success";
      issue: LiveIssue;
      etag: string | null;
    }
  | {
      kind: "ambiguous";
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
  | "gh-not-found"
  | "gh-auth-failed"
  | "gh-api-failed"
  | "gh-empty-output"
  | "gh-output-too-large"
  | "gh-malformed-json"
  | "gh-malformed-response"
  | "gh-timeout"
  | "gh-terminated"
  | "capture-incomplete"
  | "capture-budget-exceeded"
  | "pagination-incomplete";

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
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "GitHubClientError";
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
  maxCapturePullRequests?: number;
  maxCaptureRequests?: number;
  maxCaptureOutputBytes?: number;
  maxCaptureDurationMs?: number;
  now?: () => number;
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

interface RegistryInventoryCapture {
  issues: RegistryCaptureIssue[];
  openPullRequests: LivePullRequestSummary[];
  labels: string[];
}

interface CaptureBudgetState {
  startedAt: number;
  requests: number;
  outputBytes: number;
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
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw malformedResponse(operation, `${field} must be a string`);
  }
  return value;
}

function positiveInteger(
  value: unknown,
  field: string,
  operation: string,
): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw malformedResponse(operation, `${field} must be a positive integer`);
  }
  return value as number;
}

function nonNegativeInteger(
  value: unknown,
  field: string,
  operation: string,
): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw malformedResponse(
      operation,
      `${field} must be a non-negative integer`,
    );
  }
  return value as number;
}

function requiredBoolean(
  value: unknown,
  field: string,
  operation: string,
): boolean {
  if (typeof value !== "boolean") {
    throw malformedResponse(operation, `${field} must be a boolean`);
  }
  return value;
}

function malformedResponse(
  operation: string,
  detail: string,
  cause?: unknown,
): GitHubClientError {
  return new GitHubClientError(
    "gh-malformed-response",
    `GitHub response was malformed for ${operation}: ${detail}`,
    { operation, retryable: false, cause },
  );
}

function incompleteCapture(
  operation: string,
  detail: string,
): GitHubClientError {
  return new GitHubClientError(
    "capture-incomplete",
    `GitHub capture could not be proven complete for ${operation}: ${detail}`,
    { operation, retryable: true },
  );
}

function captureBudgetExceeded(
  operation: string,
  detail: string,
): GitHubClientError {
  return new GitHubClientError(
    "capture-budget-exceeded",
    `GitHub capture exceeded its configured budget for ${operation}: ${detail}`,
    { operation, retryable: true },
  );
}

function parseJson(text: string, operation: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new GitHubClientError(
      "gh-malformed-json",
      `GitHub returned malformed JSON for ${operation}`,
      { operation, retryable: false, cause: error },
    );
  }
}

function parseIncluded(text: string, operation: string): IncludedResponse {
  const crlfBoundary = text.lastIndexOf("\r\n\r\n");
  const lfBoundary = text.lastIndexOf("\n\n");
  const boundary = Math.max(crlfBoundary, lfBoundary);
  if (boundary < 0) {
    throw malformedResponse(
      operation,
      "included response is missing a header boundary",
    );
  }
  const separatorLength = boundary === crlfBoundary ? 4 : 2;
  const headerText = text.slice(0, boundary);
  const bodyText = text.slice(boundary + separatorLength);
  if (!/^HTTP\/\S+\s+\d{3}\b/m.test(headerText)) {
    throw malformedResponse(
      operation,
      "included response is missing an HTTP status line",
    );
  }
  const etagMatch = /^etag:\s*(.+?)\s*$/im.exec(headerText);
  return {
    body: parseJson(bodyText, operation),
    etag: etagMatch?.[1] ?? null,
  };
}

function parseRepository(repositoryUrl: unknown, operation: string): string {
  const value = requiredString(repositoryUrl, "repository_url", operation);
  const match = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/.exec(
    value,
  );
  if (match?.[1] === undefined) {
    throw malformedResponse(
      operation,
      "repository_url is not a canonical API repository URL",
    );
  }
  return match[1];
}

function parseLabels(value: unknown, operation: string): string[] {
  if (!Array.isArray(value)) {
    throw malformedResponse(operation, "labels must be an array");
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
    throw malformedResponse(operation, "issue must be an object");
  }
  const state = value.state;
  if (state !== "open" && state !== "closed") {
    throw malformedResponse(operation, "state must be open or closed");
  }
  return {
    number: positiveInteger(value.number, "number", operation),
    nodeId: requiredString(value.node_id, "node_id", operation),
    repository: parseRepository(value.repository_url, operation),
    url: requiredString(value.html_url, "html_url", operation),
    title: requiredString(value.title, "title", operation),
    body:
      value.body === null
        ? ""
        : requiredString(value.body, "body", operation, true),
    labels: parseLabels(value.labels, operation),
    state,
    updatedAt: requiredString(value.updated_at, "updated_at", operation),
    isPullRequest: Object.hasOwn(value, "pull_request"),
  };
}

function parsePullRequestSummary(
  value: unknown,
  operation: string,
): LivePullRequestSummary {
  if (!isRecord(value)) {
    throw malformedResponse(operation, "pull request must be an object");
  }
  return {
    number: positiveInteger(value.number, "number", operation),
    isDraft: requiredBoolean(value.draft, "draft", operation),
  };
}

function parseLabelName(value: unknown, operation: string): string {
  if (!isRecord(value))
    throw malformedResponse(operation, "label must be an object");
  return requiredString(value.name, "name", operation);
}

function parseNullablePullRef(
  value: unknown,
  field: "head" | "base",
  operation: string,
  repository: string,
): string | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw malformedResponse(operation, `${field} must be an object or null`);
  }
  if (field === "base") {
    if (!isRecord(value.repo)) {
      throw malformedResponse(operation, "base.repo must be an object");
    }
    const fullName = requiredString(
      value.repo.full_name,
      "base.repo.full_name",
      operation,
    );
    if (fullName !== repository) {
      throw malformedResponse(
        operation,
        "base repository does not match the requested repository",
      );
    }
  }
  if (value.ref === null) return null;
  return requiredString(value.ref, `${field}.ref`, operation);
}

function parseRegistryPullRequest(
  value: unknown,
  expectedNumber: number,
  repository: string,
  operation: string,
): Omit<RegistryCapturePullRequest, "files" | "closingIssueNumbers"> {
  if (!isRecord(value)) {
    throw malformedResponse(operation, "pull request must be an object");
  }
  const number = positiveInteger(value.number, "number", operation);
  if (number !== expectedNumber) {
    throw malformedResponse(
      operation,
      `number must equal requested pull request ${expectedNumber}`,
    );
  }
  const state = value.state;
  if (state !== "open" && state !== "closed") {
    throw malformedResponse(operation, "state must be open or closed");
  }
  const mergedAt = value.merged_at;
  if (mergedAt !== null && typeof mergedAt !== "string") {
    throw malformedResponse(operation, "merged_at must be a string or null");
  }
  if (state === "open" && mergedAt !== null) {
    throw malformedResponse(
      operation,
      "an open pull request cannot have merged_at",
    );
  }
  const disposition =
    state === "open"
      ? "open"
      : mergedAt === null
        ? "closed-unmerged"
        : "merged";
  const url = requiredString(value.html_url, "html_url", operation);
  if (url !== `https://github.com/${repository}/pull/${number}`) {
    throw malformedResponse(
      operation,
      "html_url does not match the requested repository and number",
    );
  }
  return {
    number,
    title: requiredString(value.title, "title", operation),
    body:
      value.body === null
        ? ""
        : requiredString(value.body, "body", operation, true),
    url,
    updatedAt: requiredString(value.updated_at, "updated_at", operation),
    disposition,
    isDraft: requiredBoolean(value.draft, "draft", operation),
    headRefName: parseNullablePullRef(
      value.head,
      "head",
      operation,
      repository,
    ),
    baseRefName: parseNullablePullRef(
      value.base,
      "base",
      operation,
      repository,
    ),
    changedFiles: nonNegativeInteger(
      value.changed_files,
      "changed_files",
      operation,
    ),
  };
}

function sortedUniqueNumbers(
  values: readonly number[],
  operation: string,
  field: string,
): number[] {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.some((value, index) => index > 0 && sorted[index - 1] === value)) {
    throw malformedResponse(operation, `${field} contains duplicate numbers`);
  }
  return sorted;
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
  readonly #maxCapturePullRequests: number;
  readonly #maxCaptureRequests: number;
  readonly #maxCaptureOutputBytes: number;
  readonly #maxCaptureDurationMs: number;
  readonly #now: () => number;
  #captureBudget: CaptureBudgetState | null = null;

  constructor(options: GhCliIssueClientOptions = {}) {
    this.#repository = options.repository ?? DEFAULT_REPOSITORY;
    this.#spawn = options.spawn ?? defaultSpawn;
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.#pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.#maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxCapturePullRequests =
      options.maxCapturePullRequests ?? DEFAULT_MAX_CAPTURE_PULL_REQUESTS;
    this.#maxCaptureRequests =
      options.maxCaptureRequests ?? DEFAULT_MAX_CAPTURE_REQUESTS;
    this.#maxCaptureOutputBytes =
      options.maxCaptureOutputBytes ?? DEFAULT_MAX_CAPTURE_OUTPUT_BYTES;
    this.#maxCaptureDurationMs =
      options.maxCaptureDurationMs ?? DEFAULT_MAX_CAPTURE_DURATION_MS;
    this.#now = options.now ?? (() => performance.now());
    assertPositiveBound(this.#maxOutputBytes, "maxOutputBytes");
    assertPositiveBound(this.#pageSize, "pageSize");
    assertPositiveBound(this.#maxPages, "maxPages");
    assertPositiveBound(this.#timeoutMs, "timeoutMs");
    assertPositiveBound(this.#maxCapturePullRequests, "maxCapturePullRequests");
    assertPositiveBound(this.#maxCaptureRequests, "maxCaptureRequests");
    assertPositiveBound(this.#maxCaptureOutputBytes, "maxCaptureOutputBytes");
    assertPositiveBound(this.#maxCaptureDurationMs, "maxCaptureDurationMs");
    if (this.#pageSize > 100) throw new TypeError("pageSize cannot exceed 100");
  }

  async readMainSha(): Promise<string> {
    const operation = "read-main";
    const value = this.#apiJson(
      `repos/${this.#repository}/git/ref/heads/main`,
      "GET",
      { operation },
    );
    if (!isRecord(value) || !isRecord(value.object)) {
      throw malformedResponse(operation, "ref object is missing");
    }
    const sha = requiredString(value.object.sha, "object.sha", operation);
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw malformedResponse(
        operation,
        "object.sha is not a 40-character object ID",
      );
    }
    return sha;
  }

  async readInventory(): Promise<LiveInventory> {
    const issueValues = this.#readPages(
      "issues",
      "state=open",
      "read-inventory-issues",
    );
    const pullRequestValues = this.#readPages(
      "pulls",
      "state=open",
      "read-inventory-pull-requests",
    );
    const labelValues = this.#readPages("labels", "", "read-inventory-labels");

    const issues = issueValues.map((value) =>
      parseIssue(value, "read-inventory-issues"),
    );
    const pullRequests = pullRequestValues.map((value) =>
      parsePullRequestSummary(value, "read-inventory-pull-requests"),
    );
    const labels = labelValues
      .map((value) => parseLabelName(value, "read-inventory-labels"))
      .sort(compareUtf8);
    const openIssueNumbers = issues
      .filter((issue) => !issue.isPullRequest)
      .map((issue) => issue.number)
      .sort((left, right) => left - right);
    const sortedPullRequests = pullRequests.sort(
      (left, right) => left.number - right.number,
    );

    return {
      repository: this.#repository,
      openIssueNumbers,
      openPullRequests: sortedPullRequests,
      labels,
      counts: {
        openIssues: openIssueNumbers.length,
        openPullRequests: sortedPullRequests.length,
        draftPullRequests: sortedPullRequests.filter(
          (pullRequest) => pullRequest.isDraft,
        ).length,
        labels: labels.length,
      },
      pagination: {
        issuesComplete: true,
        pullRequestsComplete: true,
        labelsComplete: true,
      },
    };
  }

  async readRegistryCapture(
    previouslyOpenPrNumbers: readonly number[],
  ): Promise<RegistryCapture> {
    if (this.#captureBudget !== null) {
      throw new TypeError("registry capture cannot be nested");
    }
    const startedAt = this.#now();
    if (!Number.isFinite(startedAt)) {
      throw new TypeError("now must return a finite monotonic timestamp");
    }
    this.#captureBudget = { startedAt, requests: 0, outputBytes: 0 };
    try {
      const captureOperation = "read-registry-capture";
      if (previouslyOpenPrNumbers.length > this.#maxCapturePullRequests) {
        throw captureBudgetExceeded(
          captureOperation,
          `previously-open pull request count exceeds ${this.#maxCapturePullRequests}`,
        );
      }
      for (const number of previouslyOpenPrNumbers) {
        assertPositiveBound(number, "previously-open pull request number");
      }
      const initialInventory = this.#readRegistryInventory();
      const openPullRequestNumbers = initialInventory.openPullRequests.map(
        (pullRequest) => pullRequest.number,
      );
      const openPullRequestSet = new Set(openPullRequestNumbers);
      const targetPullRequestNumbers = [
        ...new Set([...openPullRequestNumbers, ...previouslyOpenPrNumbers]),
      ].sort((left, right) => left - right);
      if (targetPullRequestNumbers.length > this.#maxCapturePullRequests) {
        throw captureBudgetExceeded(
          captureOperation,
          `pull request target count exceeds ${this.#maxCapturePullRequests}`,
        );
      }
      const pullRequests: RegistryCapturePullRequest[] = [];
      for (const number of targetPullRequestNumbers) {
        const pullRequest = this.#readRegistryPullRequest(number);
        if (
          openPullRequestSet.has(number) &&
          pullRequest.disposition !== "open"
        ) {
          throw incompleteCapture(
            "read-registry-open-pull-requests",
            `listed pull request #${number} changed disposition during capture`,
          );
        }
        if (
          !openPullRequestSet.has(number) &&
          pullRequest.disposition === "open"
        ) {
          throw incompleteCapture(
            "read-registry-open-pull-requests",
            `previously-open pull request #${number} is absent from the open inventory`,
          );
        }
        pullRequests.push(pullRequest);
      }

      const finalInventory = this.#readRegistryInventory();
      if (!isDeepStrictEqual(initialInventory, finalInventory)) {
        throw incompleteCapture(
          "read-registry-stabilization",
          "normalized top-level inventory changed during capture",
        );
      }

      return {
        repository: this.#repository,
        issues: initialInventory.issues,
        pullRequests,
        labels: initialInventory.labels,
        pagination: {
          issuesComplete: true,
          pullRequestsComplete: true,
          labelsComplete: true,
          changedFilesComplete: true,
          closingReferencesComplete: true,
        },
      };
    } finally {
      this.#captureBudget = null;
    }
  }

  async readIssue(
    number: number,
  ): Promise<{ issue: LiveIssue; etag: string | null }> {
    assertPositiveBound(number, "issue number");
    const operation = `read-issue-${number}`;
    const response = this.#apiIncluded(
      `repos/${this.#repository}/issues/${number}`,
      "GET",
      { operation, includeHeaders: true },
    );
    return {
      issue: parseIssue(response.body, operation),
      etag: response.etag,
    };
  }

  async updateIssue(
    number: number,
    patch: IssuePatch,
  ): Promise<GitHubWriteResult> {
    assertPositiveBound(number, "issue number");
    const operation = `update-issue-${number}`;
    try {
      const response = this.#apiIncluded(
        `repos/${this.#repository}/issues/${number}`,
        "PATCH",
        { operation, includeHeaders: true, payload: patch },
      );
      return {
        kind: "success",
        issue: parseIssue(response.body, operation),
        etag: response.etag,
      };
    } catch (error) {
      if (!(error instanceof GitHubClientError)) throw error;
      if (error.code === "gh-not-found" || error.code === "gh-auth-failed") {
        throw error;
      }
      const diagnosticCode = (() => {
        switch (error.code) {
          case "gh-timeout":
            return "transport-timeout";
          case "gh-terminated":
            return "process-terminated";
          case "gh-output-too-large":
            return "output-bound-exceeded";
          case "gh-empty-output":
            return "empty-response";
          case "gh-malformed-json":
          case "gh-malformed-response":
            return "malformed-response";
          default:
            return "write-disposition-unknown";
        }
      })();
      return { kind: "ambiguous", diagnosticCode };
    }
  }

  #readRegistryPullRequest(number: number): RegistryCapturePullRequest {
    const operation = `read-registry-pull-request-${number}`;
    const metadata = parseRegistryPullRequest(
      this.#apiJson(`repos/${this.#repository}/pulls/${number}`, "GET", {
        operation,
      }),
      number,
      this.#repository,
      operation,
    );
    const fileOperation = `read-registry-pull-request-files-${number}`;
    const fileValues = this.#readPages(
      `pulls/${number}/files`,
      "",
      fileOperation,
    );
    const files = fileValues
      .map((value, index) => {
        if (!isRecord(value)) {
          throw malformedResponse(
            fileOperation,
            `files[${index}] must be an object`,
          );
        }
        return requiredString(
          value.filename,
          `files[${index}].filename`,
          fileOperation,
        );
      })
      .sort(compareUtf8);
    if (new Set(files).size !== files.length) {
      throw malformedResponse(
        fileOperation,
        "changed file paths contain duplicates",
      );
    }
    if (files.length !== metadata.changedFiles) {
      throw incompleteCapture(
        fileOperation,
        `expected ${metadata.changedFiles} paths but observed ${files.length}`,
      );
    }
    const closingIssueNumbers = this.#readClosingIssueNumbers(number);
    const finalMetadata = parseRegistryPullRequest(
      this.#apiJson(`repos/${this.#repository}/pulls/${number}`, "GET", {
        operation,
      }),
      number,
      this.#repository,
      operation,
    );
    if (!isDeepStrictEqual(metadata, finalMetadata)) {
      throw incompleteCapture(
        operation,
        `pull request #${number} changed during nested capture`,
      );
    }
    return {
      ...metadata,
      files,
      closingIssueNumbers,
    };
  }

  #readRegistryInventory(): RegistryInventoryCapture {
    const issueOperation = "read-registry-issues";
    const pullRequestOperation = "read-registry-open-pull-requests";
    const labelOperation = "read-registry-labels";
    const issueValues = this.#readPages("issues", "state=open", issueOperation);
    const pullRequestValues = this.#readPages(
      "pulls",
      "state=open",
      pullRequestOperation,
    );
    const labelValues = this.#readPages("labels", "", labelOperation);

    const parsedIssues = issueValues.map((value) =>
      parseIssue(value, issueOperation),
    );
    for (const issue of parsedIssues) {
      if (
        issue.repository !== this.#repository ||
        (!issue.isPullRequest &&
          issue.url !==
            `https://github.com/${this.#repository}/issues/${issue.number}`) ||
        issue.state !== "open"
      ) {
        throw malformedResponse(
          issueOperation,
          `issue #${issue.number} does not match the requested open repository inventory`,
        );
      }
    }
    sortedUniqueNumbers(
      parsedIssues.map((issue) => issue.number),
      issueOperation,
      "issues",
    );
    const issues = parsedIssues
      .filter((issue) => !issue.isPullRequest)
      .map((issue): RegistryCaptureIssue => ({
        number: issue.number,
        nodeId: issue.nodeId,
        title: issue.title,
        url: issue.url,
        body: issue.body,
        updatedAt: issue.updatedAt,
        labels: issue.labels,
      }))
      .sort((left, right) => left.number - right.number);

    const openPullRequests = pullRequestValues
      .map((value) => parsePullRequestSummary(value, pullRequestOperation))
      .sort((left, right) => left.number - right.number);
    sortedUniqueNumbers(
      openPullRequests.map((pullRequest) => pullRequest.number),
      pullRequestOperation,
      "pull requests",
    );
    const issuePullRequestNumbers = parsedIssues
      .filter((issue) => issue.isPullRequest)
      .map((issue) => issue.number)
      .sort((left, right) => left - right);
    if (
      !isDeepStrictEqual(
        issuePullRequestNumbers,
        openPullRequests.map((pullRequest) => pullRequest.number),
      )
    ) {
      throw incompleteCapture(
        pullRequestOperation,
        "the issue and pull-request inventories disagree about open pull requests",
      );
    }

    const labels = labelValues
      .map((value) => parseLabelName(value, labelOperation))
      .sort(compareUtf8);
    if (new Set(labels).size !== labels.length) {
      throw malformedResponse(labelOperation, "labels contain duplicates");
    }
    return { issues, openPullRequests, labels };
  }

  #readClosingIssueNumbers(number: number): number[] {
    const operation = `read-registry-closing-references-${number}`;
    const [owner, name, ...extra] = this.#repository.split("/");
    if (owner === undefined || name === undefined || extra.length > 0) {
      throw new TypeError("repository must be owner/name");
    }
    const numbers: number[] = [];
    let endCursor: string | null = null;
    const seenCursors = new Set<string>();
    for (let page = 1; page <= this.#maxPages; page += 1) {
      const response = this.#apiJson("graphql", "POST", {
        operation,
        payload: {
          query: CLOSING_REFERENCES_QUERY,
          variables: {
            owner,
            name,
            number,
            pageSize: this.#pageSize,
            endCursor,
          },
        },
      });
      if (
        isRecord(response) &&
        Object.hasOwn(response, "errors") &&
        (!Array.isArray(response.errors) || response.errors.length > 0)
      ) {
        throw malformedResponse(
          operation,
          `page ${page} contains GraphQL errors`,
        );
      }
      if (
        !isRecord(response) ||
        !isRecord(response.data) ||
        !isRecord(response.data.repository) ||
        !isRecord(response.data.repository.pullRequest) ||
        !isRecord(response.data.repository.pullRequest.closingIssuesReferences)
      ) {
        throw malformedResponse(
          operation,
          `page ${page} is missing the closing-reference connection`,
        );
      }
      const connection =
        response.data.repository.pullRequest.closingIssuesReferences;
      if (!Array.isArray(connection.nodes) || !isRecord(connection.pageInfo)) {
        throw malformedResponse(
          operation,
          `page ${page} has malformed nodes or pageInfo`,
        );
      }
      for (const [index, node] of connection.nodes.entries()) {
        if (!isRecord(node)) {
          throw malformedResponse(
            operation,
            `page ${page} node ${index} must be an object`,
          );
        }
        numbers.push(
          positiveInteger(
            node.number,
            `page ${page} node ${index}.number`,
            operation,
          ),
        );
      }
      const hasNextPage = requiredBoolean(
        connection.pageInfo.hasNextPage,
        `page ${page}.pageInfo.hasNextPage`,
        operation,
      );
      const nextCursor = connection.pageInfo.endCursor;
      if (nextCursor !== null && typeof nextCursor !== "string") {
        throw malformedResponse(
          operation,
          `page ${page}.pageInfo.endCursor must be a string or null`,
        );
      }
      if (!hasNextPage) {
        return sortedUniqueNumbers(numbers, operation, "closing references");
      }
      if (
        typeof nextCursor !== "string" ||
        nextCursor.length === 0 ||
        seenCursors.has(nextCursor)
      ) {
        throw malformedResponse(
          operation,
          `page ${page} has no advancing end cursor`,
        );
      }
      seenCursors.add(nextCursor);
      endCursor = nextCursor;
    }
    throw new GitHubClientError(
      "pagination-incomplete",
      `GitHub pagination could not be proven complete for ${operation}`,
      { operation, retryable: true },
    );
  }

  #readPages(resource: string, query: string, operation: string): unknown[] {
    const values: unknown[] = [];
    for (let page = 1; page <= this.#maxPages; page += 1) {
      const queryPrefix = query === "" ? "" : `${query}&`;
      const endpoint =
        `repos/${this.#repository}/${resource}` +
        `?${queryPrefix}per_page=${this.#pageSize}&page=${page}`;
      const response = this.#apiJson(endpoint, "GET", { operation });
      if (!Array.isArray(response)) {
        throw malformedResponse(operation, `page ${page} is not an array`);
      }
      values.push(...response);
      if (response.length < this.#pageSize) return values;
    }
    throw new GitHubClientError(
      "pagination-incomplete",
      `GitHub pagination could not be proven complete for ${operation}`,
      { operation, retryable: true },
    );
  }

  #apiJson(
    endpoint: string,
    method: "GET" | "POST" | "PATCH",
    options: ApiCallOptions,
  ): unknown {
    return parseJson(this.#call(endpoint, method, options), options.operation);
  }

  #apiIncluded(
    endpoint: string,
    method: "GET" | "PATCH",
    options: ApiCallOptions,
  ): IncludedResponse {
    return parseIncluded(
      this.#call(endpoint, method, options),
      options.operation,
    );
  }

  #call(
    endpoint: string,
    method: "GET" | "POST" | "PATCH",
    options: ApiCallOptions,
  ): string {
    const args = [
      "api",
      endpoint,
      "--method",
      method,
      "--header",
      API_VERSION_HEADER,
    ];
    if (options.includeHeaders === true) args.push("--include");
    const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
      encoding: "utf8",
      maxBuffer: this.#maxOutputBytes,
      shell: false,
      timeout: this.#reserveCaptureRequest(options.operation),
      windowsHide: true,
    };
    if (options.payload !== undefined) {
      args.push("--input", "-");
      spawnOptions.input = JSON.stringify(options.payload);
    }

    let result: GhSpawnResult;
    try {
      result = this.#spawn("gh", args, spawnOptions);
    } catch (error) {
      const errorCode =
        error !== null && typeof error === "object"
          ? (error as { code?: unknown }).code
          : undefined;
      if (errorCode === "ENOENT") {
        throw new GitHubClientError(
          "gh-not-found",
          `GitHub CLI is unavailable for ${options.operation}`,
          { operation: options.operation, retryable: false, cause: error },
        );
      }
      if (errorCode === "ETIMEDOUT") {
        throw new GitHubClientError(
          "gh-timeout",
          `GitHub CLI timed out for ${options.operation}`,
          { operation: options.operation, retryable: true, cause: error },
        );
      }
      throw new GitHubClientError(
        "gh-api-failed",
        `GitHub CLI could not start for ${options.operation}`,
        { operation: options.operation, retryable: true, cause: error },
      );
    }

    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    this.#recordCaptureResult(
      options.operation,
      Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8"),
    );
    if (
      Buffer.byteLength(stdout, "utf8") > this.#maxOutputBytes ||
      Buffer.byteLength(stderr, "utf8") > this.#maxOutputBytes
    ) {
      throw new GitHubClientError(
        "gh-output-too-large",
        `GitHub CLI output exceeded the configured bound for ${options.operation}`,
        { operation: options.operation, retryable: true },
      );
    }
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (errorCode === "ENOENT") {
      throw new GitHubClientError(
        "gh-not-found",
        `GitHub CLI is unavailable for ${options.operation}`,
        { operation: options.operation, retryable: false, cause: result.error },
      );
    }
    if (errorCode === "ETIMEDOUT") {
      throw new GitHubClientError(
        "gh-timeout",
        `GitHub CLI timed out for ${options.operation}`,
        { operation: options.operation, retryable: true, cause: result.error },
      );
    }
    if (result.signal !== null) {
      throw new GitHubClientError(
        "gh-terminated",
        `GitHub CLI was terminated for ${options.operation}`,
        { operation: options.operation, retryable: true, cause: result.error },
      );
    }
    if (result.error !== undefined || result.status !== 0) {
      const authFailure =
        result.status === 4 ||
        /(?:auth(?:entication)?|login|credential|token)/i.test(stderr);
      throw new GitHubClientError(
        authFailure ? "gh-auth-failed" : "gh-api-failed",
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
    if (stdout.trim() === "") {
      throw new GitHubClientError(
        "gh-empty-output",
        `GitHub CLI returned empty output for ${options.operation}`,
        { operation: options.operation, retryable: true },
      );
    }
    return stdout;
  }

  #captureElapsed(operation: string): number {
    if (this.#captureBudget === null) return 0;
    const elapsed = this.#now() - this.#captureBudget.startedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0) {
      throw new TypeError(
        `now must remain finite and monotonic during ${operation}`,
      );
    }
    return elapsed;
  }

  #reserveCaptureRequest(operation: string): number {
    if (this.#captureBudget === null) return this.#timeoutMs;
    const elapsed = this.#captureElapsed(operation);
    if (elapsed >= this.#maxCaptureDurationMs) {
      throw captureBudgetExceeded(
        operation,
        `duration exceeds ${this.#maxCaptureDurationMs}ms`,
      );
    }
    if (this.#captureBudget.requests >= this.#maxCaptureRequests) {
      throw captureBudgetExceeded(
        operation,
        `request count exceeds ${this.#maxCaptureRequests}`,
      );
    }
    this.#captureBudget.requests += 1;
    return Math.min(
      this.#timeoutMs,
      Math.max(1, Math.ceil(this.#maxCaptureDurationMs - elapsed)),
    );
  }

  #recordCaptureResult(operation: string, outputBytes: number): void {
    if (this.#captureBudget === null) return;
    this.#captureBudget.outputBytes += outputBytes;
    if (this.#captureBudget.outputBytes > this.#maxCaptureOutputBytes) {
      throw captureBudgetExceeded(
        operation,
        `output exceeds ${this.#maxCaptureOutputBytes} bytes`,
      );
    }
    if (this.#captureElapsed(operation) >= this.#maxCaptureDurationMs) {
      throw captureBudgetExceeded(
        operation,
        `duration exceeds ${this.#maxCaptureDurationMs}ms`,
      );
    }
  }
}
