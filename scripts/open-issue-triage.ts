import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { CliArgError, takeValue } from "./lib/cli-args.ts";
import { assertNoSecretLike } from "./artifact-redaction.ts";
import { scanTextForPrivateLiterals } from "./publication-guard.ts";
import {
  applyIssueBatch,
  ApplyIssueBatchError,
  issueIdentityMatches,
  validateIssuePlanBatch,
} from "./lib/open-issue-triage/apply.ts";
import { TriagePublicSafetyError } from "./lib/open-issue-triage/body.ts";
import {
  GhCliIssueClient,
  GitHubClientError,
  type GitHubIssueClient,
  type LiveInventory,
  type LiveIssue,
  type RegistryCapture,
} from "./lib/open-issue-triage/github.ts";
import {
  canonicalRegistryJson,
  parseLedger,
  parseRegistry,
  registrySha256,
  sha256,
  validateRegistry,
  type OpenIssueRegistry,
} from "./lib/open-issue-triage/model.ts";
import {
  canonicalPlanJson,
  IssuePlanningError,
  planIssueBatch,
} from "./lib/open-issue-triage/planner.ts";
import {
  applyArtifactTransaction,
  ArtifactTransactionError,
  recoverArtifactTransaction,
  type ArtifactTransactionHookEvent,
} from "./lib/open-issue-triage/artifact-transaction.ts";
import { addPublicTriageRow } from "./lib/open-issue-triage/publication-audit.ts";
import {
  bodyFreeRegistrySnapshot,
  materializeRegistryReviewBatch,
  parseRegistryReviewManifest,
  type RegistryReviewManifest,
} from "./lib/open-issue-triage/refresh-manifest.ts";
import {
  parseRegistryReviewBatch,
  reconcileRegistry,
  type RefreshClosedIssue,
  type RefreshIssue,
  type RefreshPullRequest,
} from "./lib/open-issue-triage/reconcile.ts";
import {
  acquireProcessLock,
  isProcessLockError,
  readProcessLockPayload,
  releaseProcessLock,
  type ProcessLockHandle,
} from "../src/lib/process-lock.ts";
import { isRecord } from "../src/lib/type-guards.ts";

const SCHEMA_VERSION = 1;
const REPOSITORY = "LucasQuiles/WhatSoup";
const CANONICAL_LEDGER = "docs/triage/open-issue-review-ledger.jsonl";
const CANONICAL_REGISTRY = "docs/triage/open-issue-registry.json";
const GENERATED_VIEW = "docs/triage/open-issue-registry.md";
const PUBLICATION_AUDIT = "docs/publication-audit.md";
const EXPECTED_ORIGIN = "git@github.com:LucasQuiles/WhatSoup.git";
const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,127}$/;
const OUTPUT_NAME = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.json";
const PLAN_OUTPUT = new RegExp(`^docs/triage/plans/${OUTPUT_NAME}$`);
const SNAPSHOT_OUTPUT = new RegExp(`^docs/triage/snapshots/${OUTPUT_NAME}$`);
const REVIEW_OUTPUT = new RegExp(`^docs/triage/reviews/${OUTPUT_NAME}$`);
const SNAPSHOT_FIELDS = [
  "counts",
  "labels",
  "main_oid",
  "open_issue_numbers",
  "open_pull_requests",
  "pagination",
  "repository",
] as const;

type SnapshotField = (typeof SNAPSHOT_FIELDS)[number];
type OutputFormat = "json" | "text";
type CommandName =
  | "schema"
  | "check"
  | "render --check"
  | "render --write"
  | "snapshot"
  | "issue dry-run"
  | "issue apply"
  | "issue re-read"
  | "registry reconcile --check"
  | "registry reconcile --write";

interface Effects {
  read_only: boolean;
  destructive: boolean;
  idempotent: boolean;
  open_world: boolean;
  supports_dry_run: boolean;
}

type ParsedCommand =
  | { name: "schema"; schemaCommand: CommandName | null; format: OutputFormat }
  | { name: "check"; registry: string; format: OutputFormat }
  | {
      name: "render --check" | "render --write";
      registry: string;
      format: OutputFormat;
    }
  | {
      name: "snapshot";
      registry: string;
      output: string;
      fields: SnapshotField[];
      limit: number;
      format: OutputFormat;
    }
  | {
      name: "issue dry-run";
      registry: string;
      issueNumbers: number[];
      expectedMainOid: string;
      output: string;
      format: OutputFormat;
    }
  | {
      name: "issue apply";
      registry: string;
      plan: string;
      confirmPlanSha256: string;
      confirmIssues: number[];
      idempotencyKey: string;
      format: OutputFormat;
    }
  | {
      name: "issue re-read";
      registry: string;
      plan: string;
      format: OutputFormat;
    }
  | {
      name: "registry reconcile --check" | "registry reconcile --write";
      registry: string;
      reviews: string;
      snapshot: string;
      expectedMainOid: string;
      confirmReviewSha256: string | null;
      idempotencyKey: string | null;
      format: OutputFormat;
    };

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface CliRuntime {
  stdout(text: string): void;
  stderr(text: string): void;
  isTTY?: boolean;
  now(): string;
  delay(milliseconds: number): Promise<void>;
  git(args: string[], cwd: string): GitResult;
  artifactHooks?: {
    beforeOpen?(context: ArtifactHookContext): void;
    afterOpenBeforeMutation?(context: ArtifactHookContext): void;
  };
  registryTransactionHook?: (event: ArtifactTransactionHookEvent) => void;
}

export interface ArtifactHookContext {
  root: string;
  output: string;
  absolute: string;
}

class CliFailure extends Error {
  readonly exitCode: 1 | 2 | 3 | 4 | 5 | 6;
  readonly kind: string;
  readonly hint: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(
    exitCode: 1 | 2 | 3 | 4 | 5 | 6,
    kind: string,
    message: string,
    hint: string,
    retryable = false,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CliFailure";
    this.exitCode = exitCode;
    this.kind = kind;
    this.hint = hint;
    this.retryable = retryable;
    this.details = details;
  }
}

const EFFECTS: Record<CommandName, Effects> = {
  schema: {
    read_only: true,
    destructive: false,
    idempotent: true,
    open_world: false,
    supports_dry_run: false,
  },
  check: {
    read_only: true,
    destructive: false,
    idempotent: true,
    open_world: false,
    supports_dry_run: false,
  },
  "render --check": {
    read_only: true,
    destructive: false,
    idempotent: true,
    open_world: false,
    supports_dry_run: false,
  },
  "render --write": {
    read_only: false,
    destructive: false,
    idempotent: true,
    open_world: false,
    supports_dry_run: false,
  },
  snapshot: {
    read_only: false,
    destructive: false,
    idempotent: false,
    open_world: true,
    supports_dry_run: false,
  },
  "issue dry-run": {
    read_only: false,
    destructive: false,
    idempotent: false,
    open_world: true,
    supports_dry_run: true,
  },
  "issue apply": {
    read_only: false,
    destructive: true,
    idempotent: true,
    open_world: true,
    supports_dry_run: false,
  },
  "issue re-read": {
    read_only: true,
    destructive: false,
    idempotent: true,
    open_world: true,
    supports_dry_run: false,
  },
  "registry reconcile --check": {
    read_only: true,
    destructive: false,
    idempotent: true,
    open_world: true,
    supports_dry_run: true,
  },
  "registry reconcile --write": {
    read_only: false,
    destructive: false,
    idempotent: true,
    open_world: true,
    supports_dry_run: true,
  },
};

const COMMAND_NAMES = (Object.keys(EFFECTS) as CommandName[]).sort();

function optionSchema(required: string[], properties: Record<string, unknown>) {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}

function schemaEntry(name: CommandName): Record<string, unknown> {
  const shared = {
    format: { type: "string", enum: ["json", "text"], default: "json" },
  };
  const registry = {
    type: "string",
    description: "Repository-confined complete registry path",
  };
  const plan = { type: "string", pattern: PLAN_OUTPUT.source };
  const definitions: Record<
    CommandName,
    {
      input: Record<string, unknown>;
      confirmation: Record<string, unknown>;
      retry: Record<string, unknown>;
    }
  > = {
    schema: {
      input: optionSchema([], {
        command: { type: ["string", "null"] },
        ...shared,
      }),
      confirmation: { required: false },
      retry: { automatic: false, safe_after_failure: true },
    },
    check: {
      input: optionSchema(["registry"], { registry, ...shared }),
      confirmation: { required: false },
      retry: { automatic: false, safe_after_failure: true },
    },
    "render --check": {
      input: optionSchema(["registry"], { registry, ...shared }),
      confirmation: { required: false },
      retry: { automatic: false, safe_after_failure: true },
    },
    "render --write": {
      input: optionSchema(["registry"], { registry, ...shared }),
      confirmation: { required: false },
      retry: { automatic: false, safe_after_failure: true },
    },
    snapshot: {
      input: optionSchema(["registry", "output"], {
        registry,
        output: { type: "string", pattern: SNAPSHOT_OUTPUT.source },
        fields: { type: "array", items: { enum: SNAPSHOT_FIELDS } },
        limit: { type: "integer", minimum: 1, maximum: 1_000, default: 200 },
        ...shared,
      }),
      confirmation: { required: false },
      retry: {
        automatic: false,
        safe_after_failure: false,
        reason: "exclusive artifact create",
      },
    },
    "issue dry-run": {
      input: optionSchema(
        ["registry", "issue_numbers", "expected_main_oid", "output"],
        {
          registry,
          issue_numbers: {
            type: "array",
            items: { type: "integer", minimum: 1 },
          },
          expected_main_oid: { type: "string", pattern: SHA40.source },
          output: { type: "string", pattern: PLAN_OUTPUT.source },
          ...shared,
        },
      ),
      confirmation: { required: false },
      retry: {
        automatic: false,
        safe_after_failure: false,
        reason: "exclusive artifact create",
      },
    },
    "issue apply": {
      input: optionSchema(
        [
          "registry",
          "plan",
          "confirm_plan_sha256",
          "confirm_issues",
          "idempotency_key",
        ],
        {
          registry,
          plan,
          confirm_plan_sha256: { type: "string", pattern: SHA64.source },
          confirm_issues: {
            type: "array",
            items: { type: "integer", minimum: 1 },
          },
          idempotency_key: { type: "string", pattern: SLUG.source },
          ...shared,
        },
      ),
      confirmation: {
        required: true,
        fields: ["confirm_plan_sha256", "confirm_issues", "idempotency_key"],
      },
      retry: {
        automatic: false,
        safe_after_failure: false,
        reason: "PATCH disposition and ledger state require re-read",
      },
    },
    "issue re-read": {
      input: optionSchema(["registry", "plan"], { registry, plan, ...shared }),
      confirmation: { required: false },
      retry: { automatic: false, safe_after_failure: true },
    },
    "registry reconcile --check": {
      input: optionSchema(
        ["registry", "reviews", "snapshot", "expected_main_oid"],
        {
          registry,
          reviews: { type: "string", pattern: REVIEW_OUTPUT.source },
          snapshot: { type: "string", pattern: SNAPSHOT_OUTPUT.source },
          expected_main_oid: { type: "string", pattern: SHA40.source },
          ...shared,
        },
      ),
      confirmation: { required: false },
      retry: { automatic: false, safe_after_failure: true },
    },
    "registry reconcile --write": {
      input: optionSchema(
        [
          "registry",
          "reviews",
          "snapshot",
          "expected_main_oid",
          "confirm_review_sha256",
          "idempotency_key",
        ],
        {
          registry,
          reviews: { type: "string", pattern: REVIEW_OUTPUT.source },
          snapshot: { type: "string", pattern: SNAPSHOT_OUTPUT.source },
          expected_main_oid: { type: "string", pattern: SHA40.source },
          confirm_review_sha256: { type: "string", pattern: SHA64.source },
          idempotency_key: { type: "string", pattern: SLUG.source },
          ...shared,
        },
      ),
      confirmation: {
        required: true,
        fields: ["confirm_review_sha256", "idempotency_key"],
      },
      retry: {
        automatic: false,
        safe_after_failure: true,
        reason:
          "immutable transaction journal provides exact-input roll-forward recovery",
      },
    },
  };
  const definition = definitions[name];
  const outputRequired = [
    "schema_version",
    "ok",
    "command",
    "effects",
    "summary",
    "warnings",
    ...(name === "schema" ? ["commands"] : []),
  ];
  const outputProperties: Record<string, unknown> = {
    schema_version: { const: 1 },
    ok: { const: true },
    command: { const: name },
    effects: { type: "object" },
    summary: { type: "object" },
    warnings: { type: "array", items: { type: "string" } },
  };
  if (name === "schema") {
    outputProperties.commands = { type: "array", items: { type: "object" } };
  }
  return {
    name,
    effects: EFFECTS[name],
    input_schema: definition.input,
    output_schema: optionSchema(outputRequired, outputProperties),
    confirmation: definition.confirmation,
    retry: definition.retry,
  };
}

export function commandSchema(
  command: CommandName | null = null,
): Record<string, unknown> {
  if (command !== null && !COMMAND_NAMES.includes(command)) {
    throw new CliFailure(
      2,
      "unknown-command",
      `Unknown schema command: ${command}`,
      "Run schema with no command to list valid names.",
    );
  }
  return {
    schema_version: SCHEMA_VERSION,
    command: "schema",
    commands: (command === null ? COMMAND_NAMES : [command]).map(schemaEntry),
  };
}

function parseFlags(
  argv: string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[] = [],
): Map<string, string | true> {
  const allowedValues = new Set(valueFlags);
  const allowedBooleans = new Set(booleanFlags);
  const values = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!flag.startsWith("--") || flag.includes("=")) {
      throw new CliFailure(
        2,
        "invalid-invocation",
        `Unknown positional or flag: ${flag}`,
        "Use schema to inspect valid flags.",
      );
    }
    if (!allowedValues.has(flag) && !allowedBooleans.has(flag)) {
      throw new CliFailure(
        2,
        "unknown-flag",
        `Unknown flag: ${flag}`,
        "Use schema to inspect valid flags.",
      );
    }
    if (values.has(flag)) {
      throw new CliFailure(
        2,
        "duplicate-flag",
        `Duplicate flag: ${flag}`,
        "Pass each flag exactly once.",
      );
    }
    if (allowedBooleans.has(flag)) {
      values.set(flag, true);
      continue;
    }
    let taken;
    try {
      taken = takeValue(argv, index, flag);
    } catch (error) {
      if (!(error instanceof CliArgError)) throw error;
      const compatibilityValue = argv[index + 1];
      if (
        compatibilityValue !== undefined &&
        compatibilityValue.startsWith("-") &&
        !compatibilityValue.startsWith("--")
      ) {
        values.set(flag, compatibilityValue);
        index += 1;
        continue;
      }
      throw new CliFailure(
        2,
        "missing-flag-value",
        `Missing value for ${flag}`,
        "Pass one explicit value after the flag.",
      );
    }
    values.set(flag, taken.value);
    index = taken.index;
  }
  return values;
}

function requiredFlag(
  values: Map<string, string | true>,
  flag: string,
): string {
  const value = values.get(flag);
  if (typeof value !== "string") {
    throw new CliFailure(
      2,
      "missing-required-flag",
      `Missing required ${flag}`,
      `Pass ${flag} with its explicit value.`,
    );
  }
  return value;
}

function formatFlag(values: Map<string, string | true>): OutputFormat {
  const value = values.get("--format") ?? "json";
  if (value !== "json" && value !== "text") {
    throw new CliFailure(
      2,
      "invalid-format",
      "--format must be json or text",
      "Use --format json or --format text.",
    );
  }
  return value;
}

function integerList(value: string, label: string): number[] {
  if (!/^[1-9]\d*(?:,[1-9]\d*)*$/.test(value)) {
    throw new CliFailure(
      2,
      "invalid-integer-list",
      `${label} must be a comma-separated positive-integer list`,
      "Use sorted unique decimal issue numbers.",
    );
  }
  const numbers = value.split(",").map(Number);
  if (
    numbers.some(
      (number, index) =>
        !Number.isSafeInteger(number) ||
        (index > 0 && numbers[index - 1]! >= number),
    )
  ) {
    throw new CliFailure(
      2,
      "invalid-integer-list",
      `${label} must be sorted and unique`,
      "Use sorted unique decimal issue numbers.",
    );
  }
  return numbers;
}

function shaFlag(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) {
    throw new CliFailure(
      2,
      "invalid-hash",
      `${label} has an invalid hash`,
      `Pass the exact lowercase ${pattern === SHA40 ? "40" : "64"}-hex value.`,
    );
  }
  return value;
}

export function parseArgs(argv: string[]): ParsedCommand {
  const [first, second, ...rest] = argv;
  if (first === "schema") {
    let schemaCommand: CommandName | null = null;
    let flagArgs = argv.slice(1);
    if (second !== undefined && !second.startsWith("--")) {
      if (second === "issue") {
        const operation = argv[2];
        if (operation === undefined || operation.startsWith("--")) {
          throw new CliFailure(
            2,
            "unknown-command",
            "schema issue requires an operation",
            "Use schema issue dry-run, apply, or re-read.",
          );
        }
        schemaCommand = `issue ${operation}` as CommandName;
        flagArgs = argv.slice(3);
      } else if (second === "registry") {
        const operation = argv[2];
        if (operation === "reconcile") {
          const mode = argv[3];
          if (mode !== "--check" && mode !== "--write") {
            throw new CliFailure(
              2,
              "unknown-command",
              "schema registry reconcile requires --check or --write",
              "Use schema with an exact registry command.",
            );
          }
          schemaCommand = `registry reconcile ${mode}` as CommandName;
          flagArgs = argv.slice(4);
        } else {
          throw new CliFailure(
            2,
            "unknown-command",
            "schema registry requires reconcile",
            "Use schema with an exact registry command.",
          );
        }
      } else if (second === "render") {
        const mode = argv[2];
        if (mode !== "--check" && mode !== "--write") {
          throw new CliFailure(
            2,
            "unknown-command",
            "schema render requires --check or --write",
            "Use schema with a command name.",
          );
        }
        schemaCommand = `render ${mode}` as CommandName;
        flagArgs = argv.slice(3);
      } else {
        schemaCommand = second as CommandName;
        flagArgs = argv.slice(2);
      }
    }
    const flags = parseFlags(flagArgs, ["--format"]);
    if (schemaCommand !== null && !COMMAND_NAMES.includes(schemaCommand)) {
      throw new CliFailure(
        2,
        "unknown-command",
        `Unknown schema command: ${schemaCommand}`,
        "Run schema without a command to list valid names.",
      );
    }
    return { name: "schema", schemaCommand, format: formatFlag(flags) };
  }
  if (first === "check") {
    const flags = parseFlags(argv.slice(1), ["--registry", "--format"]);
    return {
      name: "check",
      registry: requiredFlag(flags, "--registry"),
      format: formatFlag(flags),
    };
  }
  if (first === "render") {
    const flags = parseFlags(
      argv.slice(1),
      ["--registry", "--format"],
      ["--check", "--write"],
    );
    const check = flags.get("--check") === true;
    const write = flags.get("--write") === true;
    if (check === write) {
      throw new CliFailure(
        2,
        "invalid-render-mode",
        "render requires exactly one of --check or --write",
        "Choose one render mode.",
      );
    }
    return {
      name: check ? "render --check" : "render --write",
      registry: requiredFlag(flags, "--registry"),
      format: formatFlag(flags),
    };
  }
  if (first === "snapshot") {
    const flags = parseFlags(argv.slice(1), [
      "--registry",
      "--output",
      "--fields",
      "--limit",
      "--format",
    ]);
    const rawFields =
      typeof flags.get("--fields") === "string"
        ? String(flags.get("--fields")).split(",")
        : [...SNAPSHOT_FIELDS];
    if (
      rawFields.length === 0 ||
      rawFields.some(
        (field) => !SNAPSHOT_FIELDS.includes(field as SnapshotField),
      ) ||
      new Set(rawFields).size !== rawFields.length ||
      rawFields.join(",") !== [...rawFields].sort().join(",")
    ) {
      throw new CliFailure(
        2,
        "invalid-fields",
        "--fields must be sorted, unique snapshot fields",
        `Choose from: ${SNAPSHOT_FIELDS.join(",")}.`,
      );
    }
    const rawLimit = flags.get("--limit") ?? "200";
    if (typeof rawLimit !== "string" || !/^[1-9]\d*$/.test(rawLimit)) {
      throw new CliFailure(
        2,
        "invalid-limit",
        "--limit must be a positive integer",
        "Use an integer from 1 through 1000.",
      );
    }
    const limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit > 1_000) {
      throw new CliFailure(
        2,
        "invalid-limit",
        "--limit must be at most 1000",
        "Use an integer from 1 through 1000.",
      );
    }
    return {
      name: "snapshot",
      registry: requiredFlag(flags, "--registry"),
      output: requiredFlag(flags, "--output"),
      fields: rawFields as SnapshotField[],
      limit,
      format: formatFlag(flags),
    };
  }
  if (first === "issue" && second === "dry-run") {
    const flags = parseFlags(rest, [
      "--registry",
      "--issue-number",
      "--expected-main-oid",
      "--output",
      "--format",
    ]);
    return {
      name: "issue dry-run",
      registry: requiredFlag(flags, "--registry"),
      issueNumbers: integerList(
        requiredFlag(flags, "--issue-number"),
        "--issue-number",
      ),
      expectedMainOid: shaFlag(
        requiredFlag(flags, "--expected-main-oid"),
        SHA40,
        "--expected-main-oid",
      ),
      output: requiredFlag(flags, "--output"),
      format: formatFlag(flags),
    };
  }
  if (first === "issue" && second === "apply") {
    const flags = parseFlags(rest, [
      "--registry",
      "--plan",
      "--confirm-plan-sha256",
      "--confirm-issues",
      "--idempotency-key",
      "--format",
    ]);
    const registry = requiredFlag(flags, "--registry");
    const plan = requiredFlag(flags, "--plan");
    const confirmPlanSha256 = shaFlag(
      requiredFlag(flags, "--confirm-plan-sha256"),
      SHA64,
      "--confirm-plan-sha256",
    );
    const confirmIssues = integerList(
      requiredFlag(flags, "--confirm-issues"),
      "--confirm-issues",
    );
    const idempotencyKey = requiredFlag(flags, "--idempotency-key");
    if (!SLUG.test(idempotencyKey)) {
      throw new CliFailure(
        2,
        "invalid-idempotency-key",
        "The idempotency key is not a bounded slug",
        "Use lowercase letters, digits, and hyphens.",
      );
    }
    return {
      name: "issue apply",
      registry,
      plan,
      confirmPlanSha256,
      confirmIssues,
      idempotencyKey,
      format: formatFlag(flags),
    };
  }
  if (first === "issue" && second === "re-read") {
    const flags = parseFlags(rest, ["--registry", "--plan", "--format"]);
    return {
      name: "issue re-read",
      registry: requiredFlag(flags, "--registry"),
      plan: requiredFlag(flags, "--plan"),
      format: formatFlag(flags),
    };
  }
  if (first === "registry" && second === "reconcile") {
    const flags = parseFlags(
      rest,
      [
        "--registry",
        "--reviews",
        "--snapshot",
        "--expected-main-oid",
        "--confirm-review-sha256",
        "--idempotency-key",
        "--format",
      ],
      ["--check", "--write"],
    );
    const check = flags.get("--check") === true;
    const write = flags.get("--write") === true;
    if (check === write) {
      throw new CliFailure(
        2,
        "invalid-reconcile-mode",
        "registry reconcile requires exactly one of --check or --write",
        "Choose one reconcile mode.",
      );
    }
    const reviews = requiredFlag(flags, "--reviews");
    const snapshot = requiredFlag(flags, "--snapshot");
    if (!REVIEW_OUTPUT.test(reviews) || !SNAPSHOT_OUTPUT.test(snapshot)) {
      throw new CliFailure(
        4,
        "unsafe-artifact-path",
        "Registry reconcile artifacts are outside their fixed subtrees",
        "Use docs/triage/reviews or docs/triage/snapshots with a bounded JSON name.",
      );
    }
    let confirmReviewSha256: string | null = null;
    let idempotencyKey: string | null = null;
    if (write) {
      confirmReviewSha256 = shaFlag(
        requiredFlag(flags, "--confirm-review-sha256"),
        SHA64,
        "--confirm-review-sha256",
      );
      idempotencyKey = requiredFlag(flags, "--idempotency-key");
      if (!SLUG.test(idempotencyKey)) {
        throw new CliFailure(
          2,
          "invalid-idempotency-key",
          "The idempotency key is not a bounded slug",
          "Use lowercase letters, digits, and hyphens.",
        );
      }
    } else if (
      flags.has("--confirm-review-sha256") ||
      flags.has("--idempotency-key")
    ) {
      throw new CliFailure(
        2,
        "unexpected-confirmation",
        "Registry reconcile --check does not accept write confirmations",
        "Remove write-only confirmation flags.",
      );
    }
    return {
      name: check ? "registry reconcile --check" : "registry reconcile --write",
      registry: requiredFlag(flags, "--registry"),
      reviews,
      snapshot,
      expectedMainOid: shaFlag(
        requiredFlag(flags, "--expected-main-oid"),
        SHA40,
        "--expected-main-oid",
      ),
      confirmReviewSha256,
      idempotencyKey,
      format: formatFlag(flags),
    };
  }
  throw new CliFailure(
    2,
    "unknown-command",
    `Unknown command: ${argv.join(" ") || "(empty)"}`,
    "Run schema to list valid commands.",
  );
}

function markdownList(values: readonly string[]): string {
  return values.length === 0
    ? "None"
    : values.map((value) => `\`${value}\``).join(", ");
}

export function renderRegistryMarkdown(input: OpenIssueRegistry): string {
  const lines = [
    "# Open issue review registry",
    "",
    "> Generated from `docs/triage/open-issue-registry.json`. Do not edit this view by hand.",
    "",
    `- Pinned main revision: \`${input.pinned_main_revision}\``,
    `- Captured at: ${input.inventory.captured_at}`,
    `- Open issues: ${input.inventory.open_issue_count}`,
    `- Registry SHA-256: \`${registrySha256(input)}\``,
    "",
  ];
  for (const issue of [...input.issues].sort(
    (left, right) => left.issue_number - right.issue_number,
  )) {
    lines.push(
      `## #${issue.issue_number}: ${issue.recommended_title ?? issue.title}`,
      "",
      `- Classification: \`${issue.classification}\``,
      `- Evidence state: \`${issue.evidence_state}\``,
      `- Confidence: \`${issue.review_confidence}\``,
      `- Current labels: ${markdownList(issue.current_labels)}`,
      `- Recommended labels: ${markdownList(issue.recommended_labels)}`,
      `- Dependencies: ${issue.dependency_issue_numbers.length === 0 ? "None" : issue.dependency_issue_numbers.map((number) => `#${number}`).join(", ")}`,
      "",
      "### Evidence",
      "",
      issue.evidence_summary,
      "",
      "### Suggested remediation",
      "",
      issue.suggested_remediation,
      "",
      "### Impact and blast radius",
      "",
      `${issue.impact} ${issue.blast_radius}`,
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

function safeRelativePath(value: string, label: string): string[] {
  if (
    value === "" ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new CliFailure(
      4,
      "unsafe-path",
      `${label} is not a safe repository-relative path`,
      "Use a documented repository-relative path.",
    );
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new CliFailure(
      4,
      "unsafe-path",
      `${label} contains an unsafe path segment`,
      "Use a documented repository-relative path.",
    );
  }
  return parts;
}

function identity(stat: Stats): string {
  return `${stat.dev}:${stat.ino}`;
}

interface AncestorIdentity {
  path: string;
  devIno: string;
  realpath: string;
}

interface ArtifactPath {
  absolute: string;
  parent: string;
  ancestors: AncestorIdentity[];
}

interface ArtifactLock {
  path: string;
  devIno: string;
  realpath: string;
  handle: ProcessLockHandle;
}

function artifactIdentityChanged(message: string): CliFailure {
  return new CliFailure(
    4,
    "artifact-identity-changed",
    message,
    "Inspect concurrent repository activity and retry only after the canonical path is restored.",
  );
}

function captureAncestorIdentities(
  root: string,
  parts: readonly string[],
  createLeaf = false,
): {
  parent: string;
  ancestors: AncestorIdentity[];
} {
  const ancestors: AncestorIdentity[] = [];
  let cursor = root;
  const captureDirectory = (path: string): void => {
    let stat: Stats;
    let resolved: string;
    try {
      stat = lstatSync(path);
      resolved = realpathSync(path);
    } catch {
      throw new CliFailure(
        4,
        "unsafe-path",
        "A required artifact ancestor is missing",
        "Create only the documented docs/triage artifact directory.",
      );
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new CliFailure(
        4,
        "unsafe-path",
        "An artifact ancestor is not a real directory",
        "Replace symlinked or non-directory ancestors before retrying.",
      );
    }
    if (!isInside(root, resolved)) {
      throw new CliFailure(
        4,
        "unsafe-path",
        "An artifact ancestor escapes the repository",
        "Use the documented docs/triage subtree.",
      );
    }
    ancestors.push({ path, devIno: identity(stat), realpath: resolved });
  };

  captureDirectory(root);
  for (const [index, part] of parts.entries()) {
    const next = join(cursor, part);
    let missing = false;
    try {
      lstatSync(next);
    } catch (error) {
      missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!missing) {
        throw error;
      }
    }
    if (missing) {
      if (!createLeaf || index !== parts.length - 1) {
        throw new CliFailure(
          4,
          "unsafe-path",
          "A required artifact ancestor is missing",
          "Create only the documented docs/triage artifact directory.",
        );
      }
      revalidateAncestorIdentities(root, ancestors);
      mkdirSync(next, { mode: 0o755 });
    }
    captureDirectory(next);
    cursor = next;
  }
  return { parent: cursor, ancestors };
}

function revalidateAncestorIdentities(
  root: string,
  ancestors: readonly AncestorIdentity[],
): void {
  for (const expected of ancestors) {
    let stat: Stats;
    let resolved: string;
    try {
      stat = lstatSync(expected.path);
      resolved = realpathSync(expected.path);
    } catch {
      throw artifactIdentityChanged(
        "An artifact ancestor disappeared during creation",
      );
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      identity(stat) !== expected.devIno ||
      resolved !== expected.realpath ||
      !isInside(root, resolved)
    ) {
      throw artifactIdentityChanged(
        "An artifact ancestor changed during creation",
      );
    }
  }
}

function assertRealAncestors(
  root: string,
  parts: readonly string[],
  createLeaf = false,
): string {
  let cursor = root;
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    if (!existsSync(cursor) && createLeaf && index === parts.length - 1) {
      mkdirSync(cursor, { mode: 0o755 });
    }
    let stat: Stats;
    try {
      stat = lstatSync(cursor);
    } catch {
      throw new CliFailure(
        4,
        "unsafe-path",
        "A required artifact ancestor is missing",
        "Create only the documented docs/triage artifact directory.",
      );
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new CliFailure(
        4,
        "unsafe-path",
        "An artifact ancestor is not a real directory",
        "Replace symlinked or non-directory ancestors before retrying.",
      );
    }
    if (!isInside(root, realpathSync(cursor))) {
      throw new CliFailure(
        4,
        "unsafe-path",
        "An artifact ancestor escapes the repository",
        "Use the documented docs/triage subtree.",
      );
    }
  }
  return cursor;
}

function resolveExistingFile(
  rootInput: string,
  relativePath: string,
  label: string,
): string {
  const root = realpathSync(rootInput);
  const parts = safeRelativePath(relativePath, label);
  const parent = assertRealAncestors(root, parts.slice(0, -1));
  const absolute = join(parent, parts.at(-1)!);
  let stat: Stats;
  try {
    stat = lstatSync(absolute);
  } catch {
    throw new CliFailure(
      2,
      "file-not-found",
      `${label} does not exist`,
      "Pass an existing repository-confined file.",
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new CliFailure(
      4,
      "unsafe-path",
      `${label} is not a real single-link regular file`,
      "Use a regular tracked file with no aliases.",
    );
  }
  if (!isInside(root, realpathSync(absolute))) {
    throw new CliFailure(
      4,
      "unsafe-path",
      `${label} escapes the repository`,
      "Use a repository-confined file.",
    );
  }
  return absolute;
}

function writeAll(descriptor: number, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("short artifact write");
    offset += written;
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function acquireArtifactLock(root: string): ArtifactLock {
  const path = join(root, ".open-issue-triage-artifact-write.lock");
  let previousIdentity: string | null = null;
  try {
    const previous = lstatSync(path);
    const previousRealpath = realpathSync(path);
    if (
      !previous.isFile() ||
      previous.isSymbolicLink() ||
      previous.nlink !== 1 ||
      !isInside(root, previousRealpath)
    ) {
      throw artifactIdentityChanged(
        "The existing artifact lock is not a repository-confined single-link file",
      );
    }
    previousIdentity = identity(previous);
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let handle: ProcessLockHandle;
  try {
    handle = acquireProcessLock(path, {
      reclaimDeadSameBoot: true,
      beforeReclaimUnlink:
        previousIdentity === null
          ? undefined
          : () => {
              const current = lstatSync(path);
              if (
                !current.isFile() ||
                current.isSymbolicLink() ||
                current.nlink !== 1 ||
                identity(current) !== previousIdentity
              ) {
                throw artifactIdentityChanged(
                  "The stale artifact lock changed during recovery",
                );
              }
            },
    });
  } catch (error) {
    if (isProcessLockError(error)) {
      const recoveryRequired = error.reason !== "active";
      throw new CliFailure(
        4,
        recoveryRequired
          ? "artifact-lock-recovery-required"
          : "artifact-write-locked",
        recoveryRequired
          ? "The artifact writer lock cannot be recovered automatically"
          : "Another cooperating artifact writer owns the repository lock",
        recoveryRequired
          ? "Inspect the owner payload and recover the corrupt, unknown-boot, or concurrently changed lock."
          : "Wait for the active writer to finish before retrying.",
        !recoveryRequired,
      );
    }
    throw error;
  }

  try {
    const opened = lstatSync(path);
    const resolved = realpathSync(path);
    const payload = readProcessLockPayload(path);
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.nlink !== 1 ||
      !isInside(root, resolved) ||
      payload?.pid !== handle.pid ||
      payload.token !== handle.token
    ) {
      throw artifactIdentityChanged(
        "The artifact lock is not a real single-link file",
      );
    }
    return { path, devIno: identity(opened), realpath: resolved, handle };
  } catch (error) {
    releaseProcessLock(handle);
    throw error;
  }
}

function revalidateArtifactLock(root: string, lock: ArtifactLock): void {
  let stat: Stats;
  let resolved: string;
  try {
    stat = lstatSync(lock.path);
    resolved = realpathSync(lock.path);
  } catch {
    throw artifactIdentityChanged(
      "The artifact lock disappeared before release",
    );
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    identity(stat) !== lock.devIno ||
    resolved !== lock.realpath ||
    !isInside(root, resolved)
  ) {
    throw artifactIdentityChanged(
      "The artifact lock identity changed while held",
    );
  }
  const payload = readProcessLockPayload(lock.path);
  if (payload?.pid !== lock.handle.pid || payload.token !== lock.handle.token) {
    throw artifactIdentityChanged(
      "The artifact lock ownership changed while held",
    );
  }
}

function releaseArtifactLock(root: string, lock: ArtifactLock): void {
  revalidateArtifactLock(root, lock);
  if (
    !releaseProcessLock(lock.handle, {
      beforeReleaseUnlink: () => revalidateArtifactLock(root, lock),
    })
  ) {
    throw artifactIdentityChanged(
      "The artifact lock ownership changed before release",
    );
  }
  fsyncDirectory(root);
}

function withArtifactLock<T>(
  root: string,
  operation: (assertLock: () => void) => T,
): T {
  const lock = acquireArtifactLock(root);
  const assertLock = (): void => revalidateArtifactLock(root, lock);
  try {
    assertLock();
    const result = operation(assertLock);
    assertLock();
    releaseArtifactLock(root, lock);
    return result;
  } catch (error) {
    try {
      releaseArtifactLock(root, lock);
    } catch {
      // Preserve the decisive operation failure and leave an unverifiable lock untouched.
    }
    throw error;
  }
}

function artifactParent(
  root: string,
  output: string,
  pattern: RegExp,
): ArtifactPath {
  if (!pattern.test(output)) {
    throw new CliFailure(
      4,
      "unsafe-output-path",
      "Output is outside the fixed artifact subtree",
      "Use the exact docs/triage/plans or docs/triage/snapshots path.",
    );
  }
  const parts = safeRelativePath(output, "output");
  const { parent, ancestors } = captureAncestorIdentities(
    root,
    parts.slice(0, -1),
    true,
  );
  return { absolute: join(parent, parts.at(-1)!), parent, ancestors };
}

function verifyOpenedArtifact(
  root: string,
  path: ArtifactPath,
  descriptor: number,
  expectedDescriptorIdentity?: string,
): string {
  revalidateAncestorIdentities(root, path.ancestors);
  let opened: Stats;
  let final: Stats;
  let resolved: string;
  try {
    opened = fstatSync(descriptor);
    final = lstatSync(path.absolute);
    resolved = realpathSync(path.absolute);
  } catch {
    throw artifactIdentityChanged(
      "The artifact path disappeared while its descriptor was open",
    );
  }
  const openedIdentity = identity(opened);
  if (
    !opened.isFile() ||
    opened.nlink !== 1 ||
    !final.isFile() ||
    final.isSymbolicLink() ||
    final.nlink !== 1 ||
    identity(final) !== openedIdentity ||
    (expectedDescriptorIdentity !== undefined &&
      openedIdentity !== expectedDescriptorIdentity) ||
    !isInside(root, resolved)
  ) {
    throw artifactIdentityChanged(
      "The artifact path no longer matches its open descriptor",
    );
  }
  return openedIdentity;
}

function verifyFinalArtifact(
  root: string,
  path: ArtifactPath,
  descriptorIdentity: string,
): void {
  revalidateAncestorIdentities(root, path.ancestors);
  let final: Stats;
  let resolved: string;
  try {
    final = lstatSync(path.absolute);
    resolved = realpathSync(path.absolute);
  } catch {
    throw artifactIdentityChanged(
      "The final artifact path disappeared after synchronization",
    );
  }
  if (
    !final.isFile() ||
    final.isSymbolicLink() ||
    final.nlink !== 1 ||
    identity(final) !== descriptorIdentity ||
    !isInside(root, resolved)
  ) {
    throw artifactIdentityChanged(
      "The final artifact path no longer matches the synchronized descriptor",
    );
  }
}

function writeExclusive(
  rootInput: string,
  output: string,
  pattern: RegExp,
  text: string,
  runtime: CliRuntime,
): void {
  const root = realpathSync(rootInput);
  withArtifactLock(root, (assertLock) => {
    const path = artifactParent(root, output, pattern);
    try {
      lstatSync(path.absolute);
      throw new CliFailure(
        4,
        "artifact-exists",
        "The output artifact already exists",
        "Choose a new stable artifact identifier; never overwrite reviewed evidence.",
      );
    } catch (error) {
      if (error instanceof CliFailure) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const hookContext = { root, output, absolute: path.absolute };
    runtime.artifactHooks?.beforeOpen?.(hookContext);
    assertLock();
    revalidateAncestorIdentities(root, path.ancestors);
    let descriptor: number;
    try {
      descriptor = openSync(
        path.absolute,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o644,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ELOOP") {
        throw new CliFailure(
          4,
          "artifact-exists",
          "The output artifact already exists",
          "Choose a new stable artifact identifier; never overwrite reviewed evidence.",
        );
      }
      throw error;
    }
    let descriptorIdentity: string;
    try {
      runtime.artifactHooks?.afterOpenBeforeMutation?.(hookContext);
      assertLock();
      descriptorIdentity = verifyOpenedArtifact(root, path, descriptor);
      writeAll(descriptor, text);
      fsyncSync(descriptor);
      assertLock();
      verifyOpenedArtifact(root, path, descriptor, descriptorIdentity);
    } finally {
      closeSync(descriptor);
    }
    revalidateAncestorIdentities(root, path.ancestors);
    fsyncDirectory(path.parent);
    verifyFinalArtifact(root, path, descriptorIdentity!);
  });
}

function writeGeneratedView(
  rootInput: string,
  text: string,
  runtime: CliRuntime,
): void {
  const root = realpathSync(rootInput);
  withArtifactLock(root, (assertLock) => {
    const parts = safeRelativePath(GENERATED_VIEW, "generated view");
    const { parent, ancestors } = captureAncestorIdentities(
      root,
      parts.slice(0, -1),
    );
    const path = { absolute: join(parent, parts.at(-1)!), parent, ancestors };
    const hookContext = {
      root,
      output: GENERATED_VIEW,
      absolute: path.absolute,
    };
    let exists = false;
    try {
      const before = lstatSync(path.absolute);
      exists = true;
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        throw new CliFailure(
          4,
          "unsafe-generated-view",
          "Generated view is not a real single-link file",
          "Repair the generated view path before writing.",
        );
      }
    } catch (error) {
      if (error instanceof CliFailure) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    runtime.artifactHooks?.beforeOpen?.(hookContext);
    assertLock();
    revalidateAncestorIdentities(root, ancestors);
    let descriptor: number;
    try {
      descriptor = openSync(
        path.absolute,
        exists
          ? constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)
          : constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              (constants.O_NOFOLLOW ?? 0),
        0o644,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ELOOP") {
        throw new CliFailure(
          4,
          "unsafe-generated-view",
          "Generated view identity changed before open",
          "Inspect concurrent repository activity and repair the generated view path.",
        );
      }
      throw error;
    }
    let descriptorIdentity: string;
    try {
      runtime.artifactHooks?.afterOpenBeforeMutation?.(hookContext);
      assertLock();
      descriptorIdentity = verifyOpenedArtifact(root, path, descriptor);
      if (exists) ftruncateSync(descriptor, 0);
      writeAll(descriptor, text);
      fsyncSync(descriptor);
      assertLock();
      verifyOpenedArtifact(root, path, descriptor, descriptorIdentity);
    } finally {
      closeSync(descriptor);
    }
    revalidateAncestorIdentities(root, ancestors);
    fsyncDirectory(parent);
    verifyFinalArtifact(root, path, descriptorIdentity!);
  });
}

function readUnknownJson(path: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new CliFailure(
      2,
      "file-read-failed",
      `${label} could not be read`,
      "Check the repository file permissions.",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CliFailure(
      2,
      "invalid-json",
      `${label} is not valid JSON`,
      "Regenerate or repair the artifact before retrying.",
    );
  }
}

function loadRegistry(
  root: string,
  relativePath: string,
): {
  registry: OpenIssueRegistry;
  value: unknown;
} {
  const path = resolveExistingFile(root, relativePath, "registry");
  const value = readUnknownJson(path, "registry");
  let registry: OpenIssueRegistry;
  try {
    registry = parseRegistry(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (
      message.startsWith("PUBLIC registry rejected:") ||
      message.startsWith("redaction_violation:")
    ) {
      throw new CliFailure(
        4,
        "public-safety-rejection",
        "Registry content violates the PUBLIC artifact policy",
        "Remove private runtime identifiers and complete issue bodies before retrying.",
      );
    }
    throw new CliFailure(
      2,
      "registry-schema-invalid",
      "Registry JSON violates the PUBLIC schema",
      "Regenerate a complete registry using the reviewed population workflow.",
    );
  }
  const findings = validateRegistry(registry);
  if (findings.length > 0) {
    throw new CliFailure(
      2,
      "registry-invalid",
      "Registry semantic validation failed",
      "Resolve every deterministic registry finding before retrying.",
      false,
      {
        finding_codes: findings.slice(0, 20).map((finding) => finding.code),
        truncated: findings.length > 20,
      },
    );
  }
  return { registry, value };
}

interface PlanSummary {
  issueNumber: number;
  issueNodeId: string;
  repository: string;
  expectedMainSha: string;
  planSha256: string;
  desired: { titleSha256: string; bodySha256: string; labels: string[] };
  before: { titleSha256: string; bodySha256: string; labels: string[] };
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new CliFailure(
      2,
      "plan-schema-invalid",
      `${label} has unknown or missing fields`,
      "Regenerate the plan using issue dry-run.",
    );
  }
}

function stringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new CliFailure(
      2,
      "plan-schema-invalid",
      `${label} must be a string array`,
      "Regenerate the plan using issue dry-run.",
    );
  }
  return [...value];
}

function parsePlanSummaries(value: unknown): PlanSummary[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CliFailure(
      2,
      "plan-schema-invalid",
      "Plan must be a nonempty array",
      "Regenerate the plan using issue dry-run.",
    );
  }
  const summaries = value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new CliFailure(
        2,
        "plan-schema-invalid",
        `plan[${index}] must be an object`,
        "Regenerate the plan using issue dry-run.",
      );
    }
    const plan = entry;
    exactKeys(
      plan,
      [
        "schema_version",
        "repository",
        "issue_number",
        "issue_node_id",
        "expected_main_sha",
        "etag",
        "expected_before",
        "managed_block",
        "desired",
        "title_delta",
        "label_delta",
        "body_delta",
        "intent_sha256",
        "registry_sha256",
        "plan_sha256",
        "changed",
      ],
      `plan[${index}]`,
    );
    if (!isRecord(plan.expected_before)) {
      throw new CliFailure(
        2,
        "plan-schema-invalid",
        `plan[${index}].expected_before must be an object`,
        "Regenerate the plan using issue dry-run.",
      );
    }
    const before = plan.expected_before;
    if (!isRecord(plan.desired)) {
      throw new CliFailure(
        2,
        "plan-schema-invalid",
        `plan[${index}].desired must be an object`,
        "Regenerate the plan using issue dry-run.",
      );
    }
    const desired = plan.desired;
    exactKeys(
      before,
      ["updated_at", "body_sha256", "title_sha256", "labels"],
      `plan[${index}].expected_before`,
    );
    exactKeys(
      desired,
      ["title", "labels", "title_sha256", "body_sha256"],
      `plan[${index}].desired`,
    );
    if (
      plan.schema_version !== 1 ||
      plan.repository !== REPOSITORY ||
      !Number.isSafeInteger(plan.issue_number) ||
      typeof plan.expected_main_sha !== "string" ||
      !SHA40.test(plan.expected_main_sha) ||
      typeof plan.plan_sha256 !== "string" ||
      !SHA64.test(plan.plan_sha256) ||
      typeof before.title_sha256 !== "string" ||
      !SHA64.test(before.title_sha256) ||
      typeof before.body_sha256 !== "string" ||
      !SHA64.test(before.body_sha256) ||
      typeof desired.title_sha256 !== "string" ||
      !SHA64.test(desired.title_sha256) ||
      typeof desired.body_sha256 !== "string" ||
      !SHA64.test(desired.body_sha256)
    ) {
      throw new CliFailure(
        2,
        "plan-schema-invalid",
        `plan[${index}] has invalid scalar fields`,
        "Regenerate the plan using issue dry-run.",
      );
    }
    return {
      issueNumber: plan.issue_number as number,
      issueNodeId: plan.issue_node_id as string,
      repository: plan.repository as string,
      expectedMainSha: plan.expected_main_sha,
      planSha256: plan.plan_sha256,
      desired: {
        titleSha256: desired.title_sha256,
        bodySha256: desired.body_sha256,
        labels: stringArray(desired.labels, `plan[${index}].desired.labels`),
      },
      before: {
        titleSha256: before.title_sha256,
        bodySha256: before.body_sha256,
        labels: stringArray(
          before.labels,
          `plan[${index}].expected_before.labels`,
        ),
      },
    };
  });
  if (
    summaries.some(
      (summary, index) =>
        index > 0 && summaries[index - 1]!.issueNumber >= summary.issueNumber,
    )
  ) {
    throw new CliFailure(
      2,
      "plan-schema-invalid",
      "Plan issue numbers must be sorted and unique",
      "Regenerate the plan using issue dry-run.",
    );
  }
  if (
    new Set(summaries.map((summary) => summary.expectedMainSha)).size !== 1 ||
    new Set(summaries.map((summary) => summary.planSha256)).size !== 1
  ) {
    throw new CliFailure(
      2,
      "plan-schema-invalid",
      "Plan batch hashes or main revisions disagree",
      "Regenerate the complete plan batch.",
    );
  }
  return summaries;
}

function assertPlanTrackedClean(
  root: string,
  relativePath: string,
  runtime: CliRuntime,
): string {
  if (!PLAN_OUTPUT.test(relativePath)) {
    throw new CliFailure(
      4,
      "unsafe-plan-path",
      "Apply plan is outside docs/triage/plans",
      "Use a reviewed plan in the canonical tracked subtree.",
    );
  }
  const tracked = runtime.git(
    ["ls-files", "--error-unmatch", "--", relativePath],
    root,
  );
  if (tracked.status !== 0 || tracked.stdout.trim() !== relativePath) {
    throw new CliFailure(
      4,
      "plan-untracked",
      "Apply plan is not proven tracked",
      "Commit the reviewed plan before apply.",
    );
  }
  const worktree = runtime.git(["diff", "--quiet", "--", relativePath], root);
  const index = runtime.git(
    ["diff", "--cached", "--quiet", "--", relativePath],
    root,
  );
  if (worktree.status !== 0 || index.status !== 0) {
    throw new CliFailure(
      4,
      "plan-dirty",
      "Apply plan differs in the index or worktree",
      "Commit the exact reviewed plan before apply.",
    );
  }
  return resolveExistingFile(root, relativePath, "plan");
}

function assertTrackedCleanFile(
  root: string,
  relativePath: string,
  label: string,
  runtime: CliRuntime,
): string {
  const tracked = runtime.git(
    ["ls-files", "--error-unmatch", "--", relativePath],
    root,
  );
  if (tracked.status !== 0 || tracked.stdout.trim() !== relativePath) {
    throw new CliFailure(
      4,
      `${label}-untracked`,
      `${label} is not proven tracked`,
      `Commit the exact ${label} before registry reconciliation.`,
    );
  }
  const worktree = runtime.git(["diff", "--quiet", "--", relativePath], root);
  const index = runtime.git(
    ["diff", "--cached", "--quiet", "--", relativePath],
    root,
  );
  if (worktree.status !== 0 || index.status !== 0) {
    throw new CliFailure(
      4,
      `${label}-dirty`,
      `${label} differs in the index or worktree`,
      `Commit the exact ${label} before registry reconciliation.`,
    );
  }
  return resolveExistingFile(root, relativePath, label);
}

interface TrackedFileEvidence {
  path: string;
  text: string;
  sha256: string;
  devIno: string;
}

function readTrackedCleanFile(
  root: string,
  relativePath: string,
  label: string,
  runtime: CliRuntime,
): TrackedFileEvidence {
  const path = assertTrackedCleanFile(root, relativePath, label, runtime);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1) {
      throw new CliFailure(
        4,
        `${label}-identity-changed`,
        `${label} is no longer a single-link regular file`,
        `Stop sibling writers and re-prove the exact ${label}.`,
      );
    }
    const text = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    const pathname = lstatSync(path);
    if (
      identity(before) !== identity(after) ||
      identity(after) !== identity(pathname) ||
      after.size !== Buffer.byteLength(text, "utf8")
    ) {
      throw new CliFailure(
        4,
        `${label}-identity-changed`,
        `${label} changed while it was being read`,
        `Stop sibling writers and re-prove the exact ${label}.`,
      );
    }
    const reprovedPath = assertTrackedCleanFile(
      root,
      relativePath,
      label,
      runtime,
    );
    if (reprovedPath !== path) {
      throw new CliFailure(
        4,
        `${label}-identity-changed`,
        `${label} resolved to a different path after its cleanliness proof`,
        `Stop sibling writers and re-prove the exact ${label}.`,
      );
    }
    return {
      path,
      text,
      sha256: sha256(text),
      devIno: identity(after),
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readReviewManifest(
  root: string,
  relativePath: string,
  runtime: CliRuntime,
): {
  manifest: RegistryReviewManifest;
  batch: ReturnType<typeof materializeRegistryReviewBatch>;
  text: string;
} {
  if (!REVIEW_OUTPUT.test(relativePath)) {
    throw new CliFailure(
      4,
      "unsafe-review-path",
      "Review manifest is outside docs/triage/reviews",
      "Use a committed JSON manifest in the canonical review subtree.",
    );
  }
  const manifestEvidence = readTrackedCleanFile(
    root,
    relativePath,
    "review-manifest",
    runtime,
  );
  const text = manifestEvidence.text;
  if (Buffer.byteLength(text, "utf8") > 16 * 1024 * 1024) {
    throw new CliFailure(
      2,
      "review-manifest-too-large",
      "Review manifest exceeds the fixed byte budget",
      "Split the review into a bounded committed batch.",
    );
  }
  let manifest: RegistryReviewManifest;
  try {
    const value = JSON.parse(text) as unknown;
    manifest = parseRegistryReviewManifest(value);
  } catch {
    throw new CliFailure(
      2,
      "review-manifest-invalid",
      "Review manifest violates the strict schema",
      "Regenerate the body-free manifest and commit its exact record set.",
    );
  }
  const recordTexts = new Map<string, string>();
  for (const record of manifest.record_files) {
    const recordText = readTrackedCleanFile(
      root,
      record.path,
      "review-record",
      runtime,
    ).text;
    if (Buffer.byteLength(recordText, "utf8") > 4 * 1024 * 1024) {
      throw new CliFailure(
        2,
        "review-record-too-large",
        `Review record #${record.issue_number} exceeds the fixed byte budget`,
        "Regenerate the body-free evidence record without unbounded content.",
      );
    }
    recordTexts.set(record.path, recordText);
  }
  try {
    return {
      manifest,
      batch: materializeRegistryReviewBatch(manifest, recordTexts),
      text,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const drift =
      message.includes("digest mismatch") ||
      message.includes("file is missing") ||
      message.includes("file set does not match");
    throw new CliFailure(
      drift ? 3 : 2,
      drift ? "review-record-drift" : "review-record-invalid",
      drift
        ? "A review record no longer matches the manifest"
        : "A review record is not valid JSON with the declared issue identity",
      drift
        ? "Restore or regenerate the exact committed review record set."
        : "Regenerate the strict body-free review record and manifest.",
    );
  }
}

function gitOutput(
  runtime: CliRuntime,
  root: string,
  args: string[],
  kind: string,
): string {
  const result = runtime.git(args, root);
  if (result.status !== 0 || result.stdout.trim().length === 0) {
    throw new CliFailure(
      4,
      kind,
      "A required local Git estate fact could not be proven",
      "Inspect the origin, tracking refs, common directory, and repository state before retrying.",
    );
  }
  return result.stdout.trim();
}

async function assertMainAgreement(
  root: string,
  runtime: CliRuntime,
  client: GitHubIssueClient,
  expectedMainOid: string,
): Promise<void> {
  const origin = gitOutput(
    runtime,
    root,
    ["remote", "get-url", "origin"],
    "origin-unavailable",
  );
  if (origin !== EXPECTED_ORIGIN) {
    throw new CliFailure(
      4,
      "origin-mismatch",
      "Origin is not the required WhatSoup SSH remote",
      `Set origin to ${EXPECTED_ORIGIN} before any remote reconciliation read.`,
    );
  }
  const tracking = gitOutput(
    runtime,
    root,
    ["rev-parse", "refs/remotes/origin/main"],
    "tracking-main-unavailable",
  );
  if (tracking !== expectedMainOid) {
    throw new CliFailure(
      3,
      "main-revision-disagreement",
      "Tracking origin/main differs from the requested main revision",
      "Fetch origin/main and regenerate evidence on the exact tracking revision.",
      false,
      { tracking_matches: false },
    );
  }
  const remoteResult = runtime.git(
    ["ls-remote", "--exit-code", "origin", "refs/heads/main"],
    root,
  );
  if (remoteResult.status !== 0 || remoteResult.stdout.trim().length === 0) {
    throw new CliFailure(
      6,
      "remote-main-unavailable",
      "The SSH remote main revision could not be read",
      "Verify SSH authentication and GitHub availability before retrying.",
      true,
    );
  }
  const remoteLine = remoteResult.stdout.trim();
  const remoteMatch = /^([0-9a-f]{40})\trefs\/heads\/main$/.exec(remoteLine);
  const apiMain = await client.readMainSha();
  if (remoteMatch?.[1] !== expectedMainOid || apiMain !== expectedMainOid) {
    throw new CliFailure(
      3,
      "main-revision-disagreement",
      "SSH origin, tracking main, remote main, API main, and requested main do not agree",
      "Fetch origin/main, inspect the complete estate, and regenerate evidence on one exact revision.",
      false,
      {
        origin_matches: true,
        tracking_matches: true,
        remote_matches: remoteMatch?.[1] === expectedMainOid,
        api_matches: apiMain === expectedMainOid,
      },
    );
  }
}

interface RegistryCaptureClient extends GitHubIssueClient {
  readRegistryCapture(
    previouslyOpenPrNumbers: number[],
  ): Promise<RegistryCapture>;
}

function registryCaptureClient(
  client: GitHubIssueClient,
): RegistryCaptureClient {
  if (
    !("readRegistryCapture" in client) ||
    typeof client.readRegistryCapture !== "function"
  ) {
    throw new CliFailure(
      1,
      "capture-adapter-unavailable",
      "The selected GitHub client cannot produce a complete registry capture",
      "Use the bounded GitHub CLI registry-capture adapter.",
    );
  }
  return client as RegistryCaptureClient;
}

function previousPullRequestNumbers(registry: OpenIssueRegistry): number[] {
  const numbers = new Set<number>();
  for (const issue of registry.issues) {
    if (issue.pull_request_owner_pr_number !== null) {
      numbers.add(issue.pull_request_owner_pr_number);
    }
    for (const overlap of issue.pull_request_overlaps) {
      if (overlap.disposition === "open") numbers.add(overlap.number);
    }
  }
  return [...numbers].sort((left, right) => left - right);
}

function exactCapture(left: RegistryCapture, right: RegistryCapture): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function publicGitRef(value: string | null): string | null {
  if (value === null) return null;
  if (
    scanTextForPrivateLiterals("docs/triage/open-issue-registry.json", value)
      .length > 0
  ) {
    return null;
  }
  try {
    assertNoSecretLike(value, "pull request ref");
  } catch {
    return null;
  }
  return value;
}

function refreshIssues(capture: RegistryCapture): RefreshIssue[] {
  return capture.issues.map((issue) => ({
    issueNumber: issue.number,
    issueNodeId: issue.nodeId,
    title: issue.title,
    url: issue.url,
    updatedAt: issue.updatedAt,
    body: issue.body,
    labels: [...issue.labels],
  }));
}

function refreshPullRequests(capture: RegistryCapture): RefreshPullRequest[] {
  return capture.pullRequests.map((pullRequest) => ({
    number: pullRequest.number,
    title: pullRequest.title,
    body: pullRequest.body,
    url: pullRequest.url,
    updatedAt: pullRequest.updatedAt,
    disposition: pullRequest.disposition,
    isDraft: pullRequest.isDraft,
    headRef: publicGitRef(pullRequest.headRefName),
    baseRef: publicGitRef(pullRequest.baseRefName),
    changedPaths: [...pullRequest.files],
    closingIssueNumbers: [...pullRequest.closingIssueNumbers],
  }));
}

function exactLiveIssue(left: LiveIssue, right: LiveIssue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readClosedIssues(
  client: GitHubIssueClient,
  oldRegistry: OpenIssueRegistry,
  capture: RegistryCapture,
): Promise<{ first: LiveIssue[]; closed: RefreshClosedIssue[] }> {
  const openNumbers = new Set(capture.issues.map((issue) => issue.number));
  const removedNumbers = oldRegistry.issues
    .map((issue) => issue.issue_number)
    .filter((number) => !openNumbers.has(number));
  const first: LiveIssue[] = [];
  const closed: RefreshClosedIssue[] = [];
  for (const number of removedNumbers) {
    const issue = (await client.readIssue(number)).issue;
    if (issue.state !== "closed" || issue.isPullRequest) {
      throw new CliFailure(
        3,
        "removed-issue-state-drift",
        `Issue #${number} is absent from the open inventory without exact closed-issue evidence`,
        "Refresh the complete inventory and review the issue transition.",
      );
    }
    first.push(issue);
    closed.push({
      issueNumber: issue.number,
      issueNodeId: issue.nodeId,
      url: issue.url,
      updatedAt: issue.updatedAt,
      body: issue.body,
      state: "closed",
    });
  }
  return { first, closed };
}

async function stableRegistryCapture(
  client: GitHubIssueClient,
  registry: OpenIssueRegistry,
): Promise<{ capture: RegistryCapture; closedIssues: RefreshClosedIssue[] }> {
  const captureClient = registryCaptureClient(client);
  const priorPullRequests = previousPullRequestNumbers(registry);
  const first = await captureClient.readRegistryCapture(priorPullRequests);
  const second = await captureClient.readRegistryCapture(priorPullRequests);
  if (!exactCapture(first, second)) {
    throw new CliFailure(
      3,
      "registry-capture-drift",
      "Repeated complete registry captures disagree",
      "Wait for the issue and pull-request estate to stabilize, then re-review changed evidence.",
    );
  }
  const closed = await readClosedIssues(client, registry, second);
  for (const issue of closed.first) {
    const reread = (await client.readIssue(issue.number)).issue;
    if (!exactLiveIssue(issue, reread)) {
      throw new CliFailure(
        3,
        "closed-issue-capture-drift",
        `Closed issue #${issue.number} changed during capture`,
        "Re-review the exact closed-issue state before retrying.",
      );
    }
  }
  const final = await captureClient.readRegistryCapture(priorPullRequests);
  if (!exactCapture(second, final)) {
    throw new CliFailure(
      3,
      "registry-capture-drift",
      "Final complete registry capture differs from the reviewed capture",
      "Wait for the estate to stabilize and refresh changed evidence.",
    );
  }
  for (const issue of closed.first) {
    const reread = (await client.readIssue(issue.number)).issue;
    if (!exactLiveIssue(issue, reread)) {
      throw new CliFailure(
        3,
        "closed-issue-capture-drift",
        `Closed issue #${issue.number} changed after final capture`,
        "Re-review the exact closed-issue state before retrying.",
      );
    }
  }
  return { capture: final, closedIssues: closed.closed };
}

function gitCommonDirectory(root: string, runtime: CliRuntime): string {
  const common = gitOutput(
    runtime,
    root,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    "git-common-dir-unavailable",
  );
  if (!isAbsolute(common)) {
    throw new CliFailure(
      4,
      "git-common-dir-invalid",
      "Git common directory is not absolute",
      "Repair the worktree metadata before retrying.",
    );
  }
  let stat: Stats;
  try {
    stat = lstatSync(common);
  } catch {
    throw new CliFailure(
      4,
      "git-common-dir-invalid",
      "Git common directory does not exist",
      "Repair the worktree metadata before retrying.",
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CliFailure(
      4,
      "git-common-dir-invalid",
      "Git common directory is not a real directory",
      "Repair the worktree metadata before retrying.",
    );
  }
  return realpathSync(common);
}

function reconcileOperationPaths(snapshotPath: string): string[] {
  return [
    CANONICAL_REGISTRY,
    GENERATED_VIEW,
    PUBLICATION_AUDIT,
    snapshotPath,
  ].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function reconcileAuthorizationDigest(input: {
  expectedMainOid: string;
  idempotencyKey: string;
  reviewManifestSha256: string;
  snapshotPath: string;
}): string {
  return sha256(
    canonicalJson({
      schema_version: 1,
      repository: REPOSITORY,
      expected_main_oid: input.expectedMainOid,
      idempotency_key: input.idempotencyKey,
      review_manifest_sha256: input.reviewManifestSha256,
      operation_paths: reconcileOperationPaths(input.snapshotPath),
    }),
  );
}

function assertNoPendingReconcileJournal(commonDirectory: string): void {
  const journalPath = join(
    commonDirectory,
    "open-issue-triage-registry-reconcile.journal.json",
  );
  for (const path of [journalPath, `${journalPath}.candidate`]) {
    try {
      lstatSync(path);
      throw new CliFailure(
        5,
        "pending-registry-transaction",
        "A registry reconciliation journal requires exact write recovery",
        "Preserve all transaction artifacts and rerun the exact confirmed --write command.",
      );
    } catch (error) {
      if (error instanceof CliFailure) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new CliFailure(
          5,
          "pending-registry-transaction-unknown",
          "Registry reconciliation journal state cannot be proven absent",
          "Inspect the Git common-directory transaction artifacts before proceeding.",
        );
      }
    }
  }
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function snapshotDocument(
  mainOid: string,
  inventory: LiveInventory,
  fields: readonly SnapshotField[],
  limit: number,
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    schema_version: 1,
    fields,
  };
  const truncated: Record<string, boolean> = {};
  const arrays: Partial<Record<SnapshotField, unknown[]>> = {
    labels: inventory.labels,
    open_issue_numbers: inventory.openIssueNumbers,
    open_pull_requests: inventory.openPullRequests,
  };
  for (const field of fields) {
    if (field in arrays) {
      const values = arrays[field]!;
      output[field] = values.slice(0, limit);
      truncated[field] = values.length > limit;
      continue;
    }
    if (field === "main_oid") output[field] = mainOid;
    if (field === "repository") output[field] = inventory.repository;
    if (field === "counts") output[field] = inventory.counts;
    if (field === "pagination") output[field] = inventory.pagination;
  }
  output.truncated = truncated;
  return output;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

function issueState(
  issue: LiveIssue,
  summary: PlanSummary,
): "desired" | "before" | "third-state" {
  if (
    !issueIdentityMatches(issue, {
      issue_number: summary.issueNumber,
      issue_node_id: summary.issueNodeId,
      repository: summary.repository,
    })
  ) {
    return "third-state";
  }
  const titleHash = sha256(issue.title);
  const bodyHash = sha256(issue.body);
  const labels = [...issue.labels].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
  if (
    titleHash === summary.desired.titleSha256 &&
    bodyHash === summary.desired.bodySha256 &&
    sameStrings(labels, summary.desired.labels)
  )
    return "desired";
  if (
    titleHash === summary.before.titleSha256 &&
    bodyHash === summary.before.bodySha256 &&
    sameStrings(labels, summary.before.labels)
  )
    return "before";
  return "third-state";
}

function defaultRuntime(): CliRuntime {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    isTTY: process.stdout.isTTY,
    now: () => new Date().toISOString(),
    delay: async (milliseconds) =>
      new Promise((resolveDelay) => {
        setTimeout(resolveDelay, milliseconds);
      }),
    git: (args, cwd) => {
      const result = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        shell: false,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      return {
        status: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
  };
}

function successDocument(
  command: CommandName,
  summary: Record<string, unknown>,
  warnings: string[] = [],
): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    ok: true,
    command,
    effects: EFFECTS[command],
    summary,
    warnings,
  };
}

function emitSuccess(
  runtime: CliRuntime,
  format: OutputFormat,
  document: Record<string, unknown>,
): void {
  if (format === "json") {
    runtime.stdout(`${JSON.stringify(document)}\n`);
    return;
  }
  const command = String(document.command);
  const summary = document.summary as Record<string, unknown>;
  runtime.stdout(`${command}: ${String(summary.status ?? "ok")}\n`);
}

function normalizeFailure(error: unknown): CliFailure {
  if (error instanceof CliFailure) return error;
  if (error instanceof ApplyIssueBatchError) {
    return new CliFailure(
      error.exitClass,
      error.code,
      "Issue apply did not reach a fully verified durable result",
      error.retryable
        ? "Re-read the plan before an explicit retry."
        : "Follow the receipt recovery runbook before any retry.",
      error.retryable,
      { issue_number: error.issueNumber },
    );
  }
  if (error instanceof GitHubClientError) {
    return new CliFailure(
      6,
      error.code,
      "GitHub access failed before a verified mutation result",
      "Verify CLI authentication, API availability, and rate limits, then re-read before retrying.",
      error.retryable,
      { operation: error.operation },
    );
  }
  if (error instanceof IssuePlanningError) {
    if (
      error.code === "render-failed" &&
      error.cause instanceof TriagePublicSafetyError
    ) {
      return new CliFailure(
        4,
        "public-safety-rejection",
        "The live issue content cannot be rendered into a PUBLIC review safely",
        "Remove or sanitize private runtime identifiers before regenerating the plan.",
        false,
        { issue_number: error.issueNumber },
      );
    }
    return new CliFailure(
      3,
      error.code,
      "Live state no longer matches the pinned registry preconditions",
      "Refresh evidence and regenerate the registry or plan.",
      false,
      { issue_number: error.issueNumber },
    );
  }
  if (error instanceof ArtifactTransactionError) {
    const ambiguous =
      new Set([
        "durability-failed",
        "mutation-outcome-unknown",
        "post-write-verification-failed",
        "journal-removal-failed",
      ]).has(error.code) || error.recoveryPacket !== undefined;
    const policy = new Set([
      "invalid-input",
      "unsafe-path",
      "lock-unavailable",
      "lock-identity-changed",
      "journal-malformed",
      "candidate-invalid",
    ]).has(error.code);
    const packet = error.recoveryPacket;
    return new CliFailure(
      ambiguous ? 5 : policy ? 4 : 3,
      `artifact-transaction-${error.code}`,
      ambiguous
        ? "Registry artifact transaction outcome requires recovery"
        : "Registry artifact transaction did not satisfy its preconditions",
      "Preserve the common-directory journal and candidates; rerun only with the exact confirmed manifest and idempotency key.",
      error.code === "lock-unavailable",
      packet === undefined
        ? {}
        : {
            recovery_transaction_id: packet.transactionId,
            recovery_journal_path: packet.journalPath,
            recovery_paths: packet.paths.slice(0, 20),
            recovery_paths_truncated: packet.paths.length > 20,
          },
    );
  }
  return new CliFailure(
    1,
    "internal-invariant",
    "The triage command failed an internal invariant",
    "Inspect local logs and rerun the deterministic offline checks before proceeding.",
  );
}

function emitFailure(runtime: CliRuntime, failure: CliFailure): void {
  const details = Object.fromEntries(
    Object.entries(failure.details).slice(0, 20),
  );
  runtime.stderr(
    `${JSON.stringify({
      schema_version: SCHEMA_VERSION,
      ok: false,
      kind: failure.kind.slice(0, 128),
      message: failure.message.slice(0, 512),
      hint: failure.hint.slice(0, 512),
      retryable: failure.retryable,
      details,
    })}\n`,
  );
}

export async function run(
  argv: string[],
  root = process.cwd(),
  injectedClient?: GitHubIssueClient,
  injectedRuntime?: CliRuntime,
): Promise<number> {
  const runtime = injectedRuntime ?? defaultRuntime();
  try {
    const command = parseArgs(argv);
    if (command.name === "schema") {
      const schema = commandSchema(command.schemaCommand);
      emitSuccess(runtime, command.format, {
        ...successDocument("schema", {
          status: "schema",
          command_count: (schema.commands as unknown[]).length,
        }),
        ...schema,
      });
      return 0;
    }

    if (command.name === "registry reconcile --write") {
      if (command.registry !== CANONICAL_REGISTRY) {
        throw new CliFailure(
          4,
          "noncanonical-registry-path",
          "Registry reconciliation only updates the canonical registry",
          `Use --registry ${CANONICAL_REGISTRY}.`,
        );
      }
      const manifestEvidence = readTrackedCleanFile(
        root,
        command.reviews,
        "review-manifest",
        runtime,
      );
      const reviewSha256 = sha256(manifestEvidence.text);
      if (command.confirmReviewSha256 !== reviewSha256) {
        throw new CliFailure(
          3,
          "confirmed-review-digest-mismatch",
          "Confirmed review digest differs from the committed manifest bytes",
          "Re-read the committed manifest and pass its exact byte SHA-256.",
        );
      }
      const commonDirectory = gitCommonDirectory(root, runtime);
      const lockPath = join(
        commonDirectory,
        "open-issue-triage-registry-reconcile.lock",
      );
      const journalPath = join(
        commonDirectory,
        "open-issue-triage-registry-reconcile.journal.json",
      );
      const authorizationDigest = reconcileAuthorizationDigest({
        expectedMainOid: command.expectedMainOid,
        idempotencyKey: command.idempotencyKey!,
        reviewManifestSha256: reviewSha256,
        snapshotPath: command.snapshot,
      });
      try {
        const recovered = recoverArtifactTransaction({
          root: realpathSync(root),
          lockPath,
          journalPath,
          authorizationDigest,
          expectedOperationPaths: reconcileOperationPaths(command.snapshot),
          interruptionHook: runtime.registryTransactionHook,
        });
        emitSuccess(
          runtime,
          command.format,
          successDocument(command.name, {
            status: "recovered",
            review_manifest_sha256: reviewSha256,
            snapshot_path: command.snapshot,
            operation_id: command.idempotencyKey,
            transaction: {
              transaction_id: recovered.transactionId,
              recovered: recovered.recovered,
              operation_count: recovered.operationCount,
            },
          }),
        );
        return 0;
      } catch (error) {
        if (
          !(error instanceof ArtifactTransactionError) ||
          error.code !== "journal-state-conflict" ||
          error.recoveryPacket !== undefined
        ) {
          throw error;
        }
      }
    }

    const { registry, value: registryValue } = loadRegistry(
      root,
      command.registry,
    );
    const rendered = renderRegistryMarkdown(registry);
    if (command.name === "check" || command.name === "render --check") {
      const ledger = resolveExistingFile(root, CANONICAL_LEDGER, "ledger");
      try {
        parseLedger(readFileSync(ledger, "utf8"));
      } catch {
        throw new CliFailure(
          2,
          "ledger-invalid",
          "Receipt ledger validation failed",
          "Follow the ledger recovery runbook before continuing.",
        );
      }
      const view = resolveExistingFile(root, GENERATED_VIEW, "generated view");
      if (readFileSync(view, "utf8") !== rendered) {
        throw new CliFailure(
          1,
          "generated-view-drift",
          "Generated registry Markdown differs byte-for-byte",
          "Run render --write, inspect the diff, and commit it with the registry.",
        );
      }
      emitSuccess(
        runtime,
        command.format,
        successDocument(command.name, {
          status: "verified",
          issue_count: registry.issues.length,
          registry_sha256: registrySha256(registry),
        }),
      );
      return 0;
    }
    if (command.name === "render --write") {
      resolveExistingFile(root, CANONICAL_LEDGER, "ledger");
      writeGeneratedView(root, rendered, runtime);
      emitSuccess(
        runtime,
        command.format,
        successDocument(command.name, {
          status: "written",
          artifact_path: GENERATED_VIEW,
          issue_count: registry.issues.length,
        }),
      );
      return 0;
    }

    const client = injectedClient ?? new GhCliIssueClient();
    if (
      command.name === "registry reconcile --check" ||
      command.name === "registry reconcile --write"
    ) {
      if (command.registry !== CANONICAL_REGISTRY) {
        throw new CliFailure(
          4,
          "noncanonical-registry-path",
          "Registry reconciliation only updates the canonical registry",
          `Use --registry ${CANONICAL_REGISTRY}.`,
        );
      }
      const reconcileCommonDirectory = gitCommonDirectory(root, runtime);
      assertNoPendingReconcileJournal(reconcileCommonDirectory);
      const registryEvidence = readTrackedCleanFile(
        root,
        command.registry,
        "registry",
        runtime,
      );
      if (registryEvidence.text !== canonicalRegistryJson(registry)) {
        throw new CliFailure(
          3,
          "registry-read-drift",
          "Canonical registry bytes changed after initial validation",
          "Stop sibling writers and restart reconciliation from one committed registry.",
        );
      }
      const viewEvidence = readTrackedCleanFile(
        root,
        GENERATED_VIEW,
        "generated-view",
        runtime,
      );
      if (viewEvidence.text !== renderRegistryMarkdown(registry)) {
        throw new CliFailure(
          3,
          "generated-view-before-state-drift",
          "Committed generated view does not match the source registry",
          "Repair and commit the source registry view before reconciliation.",
        );
      }
      const auditEvidence = readTrackedCleanFile(
        root,
        PUBLICATION_AUDIT,
        "publication-audit",
        runtime,
      );
      const review = readReviewManifest(root, command.reviews, runtime);
      try {
        review.batch = parseRegistryReviewBatch(
          review.batch,
          registry,
          command.expectedMainOid,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const publicSafety =
          message.startsWith("PUBLIC review batch rejected:") ||
          message.startsWith("redaction_violation:");
        throw new CliFailure(
          publicSafety ? 4 : 2,
          publicSafety
            ? "review-public-safety-rejection"
            : "review-record-schema-invalid",
          publicSafety
            ? "The committed review batch violates the PUBLIC artifact policy"
            : "A committed review record violates the strict registry schema",
          publicSafety
            ? "Remove private runtime identifiers, secrets, and complete bodies before retrying."
            : "Regenerate and recommit the exact body-free review record.",
        );
      }
      const reviewSha256 = sha256(review.text);
      if (
        command.name === "registry reconcile --write" &&
        command.confirmReviewSha256 !== reviewSha256
      ) {
        throw new CliFailure(
          3,
          "confirmed-review-digest-mismatch",
          "Confirmed review digest differs from the committed manifest bytes",
          "Re-read the committed manifest and pass its exact byte SHA-256.",
        );
      }
      await assertMainAgreement(root, runtime, client, command.expectedMainOid);
      const stable = await stableRegistryCapture(client, registry);
      await assertMainAgreement(root, runtime, client, command.expectedMainOid);
      const capturedAt = runtime.now();
      let reconciled: ReturnType<typeof reconcileRegistry>;
      try {
        reconciled = reconcileRegistry({
          oldRegistry: registry,
          reviewBatch: review.batch,
          liveIssues: refreshIssues(stable.capture),
          closedIssues: stable.closedIssues,
          openPullRequests: refreshPullRequests(stable.capture),
          labels: [...stable.capture.labels],
          capturedAt,
          expectedMainOid: command.expectedMainOid,
        });
      } catch (error) {
        throw new CliFailure(
          3,
          "registry-review-precondition-failed",
          "The committed review set does not exactly reconcile with the stable live capture",
          "Review the changed issue, pull-request, label, or ownership evidence and commit a new manifest.",
          false,
          {
            reason:
              error instanceof Error
                ? error.message.slice(0, 256)
                : "unknown reconciliation failure",
          },
        );
      }
      const registryText = canonicalRegistryJson(reconciled.registry);
      const viewText = renderRegistryMarkdown(reconciled.registry);
      const auditText = auditEvidence.text;
      let auditCandidate: string;
      try {
        auditCandidate = addPublicTriageRow(
          auditText,
          command.snapshot,
          "Body-free complete registry reconciliation seal bound to the committed review manifest and exact main revision.",
        );
      } catch {
        throw new CliFailure(
          4,
          "snapshot-publication-audit-invalid",
          "The reconciliation snapshot cannot be added to the PUBLIC audit deterministically",
          "Use a new canonical snapshot path and repair the publication audit before retrying.",
        );
      }
      const snapshotParts = safeRelativePath(command.snapshot, "snapshot");
      const snapshotRoot = realpathSync(root);
      const snapshotParent = assertRealAncestors(
        snapshotRoot,
        snapshotParts.slice(0, -1),
      );
      const snapshotAbsolute = join(snapshotParent, snapshotParts.at(-1)!);
      if (existsSync(snapshotAbsolute)) {
        throw new CliFailure(
          3,
          "snapshot-already-exists",
          "The requested immutable reconciliation snapshot already exists",
          "Use a new snapshot path, or preserve pending transaction state for exact recovery.",
        );
      }
      if (command.name === "registry reconcile --check") {
        emitSuccess(
          runtime,
          command.format,
          successDocument(command.name, {
            status: "ready",
            issue_count: reconciled.registry.issues.length,
            added_issue_numbers: reconciled.addedIssueNumbers,
            removed_issue_numbers: reconciled.removedIssueNumbers,
            registry_sha256: registrySha256(reconciled.registry),
            review_manifest_sha256: reviewSha256,
            snapshot_path: command.snapshot,
          }),
        );
        return 0;
      }
      const snapshotText = canonicalJson(
        bodyFreeRegistrySnapshot({
          capture: stable.capture,
          capturedAt,
          mainOid: command.expectedMainOid,
          reviewManifestSha256: reviewSha256,
          idempotencyKey: command.idempotencyKey!,
        }),
      );
      for (const evidence of [
        {
          relativePath: command.registry,
          label: "registry",
          value: registryEvidence,
        },
        {
          relativePath: GENERATED_VIEW,
          label: "generated-view",
          value: viewEvidence,
        },
        {
          relativePath: PUBLICATION_AUDIT,
          label: "publication-audit",
          value: auditEvidence,
        },
      ]) {
        const current = readTrackedCleanFile(
          root,
          evidence.relativePath,
          evidence.label,
          runtime,
        );
        if (
          current.sha256 !== evidence.value.sha256 ||
          current.devIno !== evidence.value.devIno
        ) {
          throw new CliFailure(
            3,
            "artifact-before-state-drift",
            `${evidence.label} changed after candidate construction`,
            "Stop sibling writers, inspect the complete estate, and restart the check.",
          );
        }
      }
      await assertMainAgreement(root, runtime, client, command.expectedMainOid);
      const authorizationDigest = reconcileAuthorizationDigest({
        expectedMainOid: command.expectedMainOid,
        idempotencyKey: command.idempotencyKey!,
        reviewManifestSha256: reviewSha256,
        snapshotPath: command.snapshot,
      });
      const transaction = applyArtifactTransaction({
        root: snapshotRoot,
        lockPath: join(
          reconcileCommonDirectory,
          "open-issue-triage-registry-reconcile.lock",
        ),
        journalPath: join(
          reconcileCommonDirectory,
          "open-issue-triage-registry-reconcile.journal.json",
        ),
        authorizationDigest,
        interruptionHook: runtime.registryTransactionHook,
        operations: [
          {
            path: command.registry,
            expectedBeforeSha256: registryEvidence.sha256,
            desiredText: registryText,
          },
          {
            path: GENERATED_VIEW,
            expectedBeforeSha256: viewEvidence.sha256,
            desiredText: viewText,
          },
          {
            path: PUBLICATION_AUDIT,
            expectedBeforeSha256: auditEvidence.sha256,
            desiredText: auditCandidate,
          },
          {
            path: command.snapshot,
            expectedBeforeSha256: null,
            desiredText: snapshotText,
          },
        ],
      });
      emitSuccess(
        runtime,
        command.format,
        successDocument(command.name, {
          status: "written",
          issue_count: reconciled.registry.issues.length,
          added_issue_numbers: reconciled.addedIssueNumbers,
          removed_issue_numbers: reconciled.removedIssueNumbers,
          registry_sha256: registrySha256(reconciled.registry),
          review_manifest_sha256: reviewSha256,
          snapshot_path: command.snapshot,
          snapshot_sha256: sha256(snapshotText),
          operation_id: command.idempotencyKey,
          transaction: {
            transaction_id: transaction.transactionId,
            recovered: transaction.recovered,
            operation_count: transaction.operationCount,
          },
        }),
      );
      return 0;
    }
    if (command.name === "snapshot") {
      const [mainOid, liveInventory] = await Promise.all([
        client.readMainSha(),
        client.readInventory(),
      ]);
      const snapshot = snapshotDocument(
        mainOid,
        liveInventory,
        command.fields,
        command.limit,
      );
      const text = canonicalJson(snapshot);
      writeExclusive(root, command.output, SNAPSHOT_OUTPUT, text, runtime);
      emitSuccess(
        runtime,
        command.format,
        successDocument(command.name, {
          status: "created",
          artifact_path: command.output,
          artifact_sha256: sha256(text),
          fields: command.fields,
        }),
      );
      return 0;
    }
    if (command.name === "issue dry-run") {
      const plans = await planIssueBatch({
        expectedMainSha: command.expectedMainOid,
        registry,
        targetIssueNumbers: command.issueNumbers,
        client,
      });
      const text = canonicalPlanJson(plans);
      writeExclusive(root, command.output, PLAN_OUTPUT, text, runtime);
      emitSuccess(
        runtime,
        command.format,
        successDocument(command.name, {
          status: "planned",
          artifact_path: command.output,
          plan_sha256: plans[0]!.plan_sha256,
          issue_numbers: plans.map((plan) => plan.issue_number),
          changed_count: plans.filter((plan) => plan.changed).length,
        }),
      );
      return 0;
    }
    if (command.name === "issue apply") {
      const planPath = assertPlanTrackedClean(root, command.plan, runtime);
      const planValue = readUnknownJson(planPath, "plan");
      const summaries = parsePlanSummaries(planValue);
      const issueNumbers = summaries.map((summary) => summary.issueNumber);
      if (
        !sameStrings(
          issueNumbers.map(String),
          command.confirmIssues.map(String),
        )
      ) {
        throw new CliFailure(
          3,
          "confirmed-issues-mismatch",
          "Confirmed issue list differs from the tracked plan",
          "Re-read the tracked plan and pass its exact sorted issue list.",
        );
      }
      if (summaries[0]!.planSha256 !== command.confirmPlanSha256) {
        throw new CliFailure(
          3,
          "confirmed-plan-digest-mismatch",
          "Confirmed plan digest differs from the tracked plan",
          "Re-read the tracked plan and pass its exact canonical digest.",
        );
      }
      const ledgerPath = resolveExistingFile(root, CANONICAL_LEDGER, "ledger");
      const receipts = await applyIssueBatch({
        expectedMainSha: summaries[0]!.expectedMainSha,
        plans: planValue,
        registry: registryValue,
        client,
        ledgerPath,
        now: runtime.now,
        delay: runtime.delay,
        confirmedPlanSha256: command.confirmPlanSha256,
        idempotencyKey: command.idempotencyKey,
      });
      const targetReceipts = receipts.filter(
        (receipt) =>
          receipt.receipt_type === "target_verified" ||
          receipt.receipt_type === "target_unknown",
      );
      emitSuccess(
        runtime,
        command.format,
        successDocument(command.name, {
          status: "verified",
          operation_id: command.idempotencyKey,
          receipt_count: receipts.length,
          issue_results: targetReceipts.map((receipt) => ({
            issue_number: receipt.issue_number,
            result: receipt.operation_result,
            receipt_sha256: receipt.receipt_sha256,
          })),
        }),
      );
      return 0;
    }

    if (command.name !== "issue re-read") {
      throw new CliFailure(
        1,
        "internal-invariant",
        "Parsed command did not reach a command handler",
        "Inspect the command dispatch table before retrying.",
      );
    }
    const planPath = assertPlanTrackedClean(root, command.plan, runtime);
    const validated = validateIssuePlanBatch(
      readUnknownJson(planPath, "plan"),
      registryValue,
    );
    const summaries = validated.plans.map((plan) => ({
      issueNumber: plan.issue_number,
      issueNodeId: plan.issue_node_id,
      repository: plan.repository,
      expectedMainSha: plan.expected_main_sha,
      planSha256: plan.plan_sha256,
      desired: {
        titleSha256: plan.desired.title_sha256,
        bodySha256: plan.desired.body_sha256,
        labels: [...plan.desired.labels],
      },
      before: {
        titleSha256: plan.expected_before.title_sha256,
        bodySha256: plan.expected_before.body_sha256,
        labels: [...plan.expected_before.labels],
      },
    }));
    const mainOid = await client.readMainSha();
    if (mainOid !== summaries[0]!.expectedMainSha) {
      throw new CliFailure(
        3,
        "main-sha-drift",
        "Live main differs from the plan",
        "Refresh evidence and regenerate the plan.",
      );
    }
    const states = [];
    for (const summary of summaries) {
      const issue = (await client.readIssue(summary.issueNumber)).issue;
      states.push({
        issue_number: summary.issueNumber,
        state: issueState(issue, summary),
      });
    }
    emitSuccess(
      runtime,
      command.format,
      successDocument(command.name, {
        status: states.every((state) => state.state === "desired")
          ? "desired"
          : "review-required",
        issues: states,
      }),
    );
    return 0;
  } catch (error) {
    const failure = normalizeFailure(error);
    emitFailure(runtime, failure);
    return failure.exitCode;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const exitCode = await run(process.argv.slice(2));
  process.exitCode = exitCode;
}
