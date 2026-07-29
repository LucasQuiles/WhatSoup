import { CliArgError, takeValue } from "../cli-args.ts";
import type { ArtifactTransactionHookEvent } from "./artifact-transaction.ts";

export const SCHEMA_VERSION = 1;
export const REPOSITORY = "LucasQuiles/WhatSoup";
export const CANONICAL_LEDGER = "docs/triage/open-issue-review-ledger.jsonl";
export const CANONICAL_REGISTRY = "docs/triage/open-issue-registry.json";
export const GENERATED_VIEW = "docs/triage/open-issue-registry.md";
export const PUBLICATION_AUDIT = "docs/publication-audit.md";
export const EXPECTED_ORIGIN = "git@github.com:LucasQuiles/WhatSoup.git";
export const SHA40 = /^[0-9a-f]{40}$/;
export const SHA64 = /^[0-9a-f]{64}$/;
export const SLUG = /^[a-z0-9][a-z0-9-]{0,127}$/;
const OUTPUT_NAME = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.json";
export const PLAN_OUTPUT = new RegExp(`^docs/triage/plans/${OUTPUT_NAME}$`);
export const SNAPSHOT_OUTPUT = new RegExp(
  `^docs/triage/snapshots/${OUTPUT_NAME}$`,
);
export const REVIEW_OUTPUT = new RegExp(`^docs/triage/reviews/${OUTPUT_NAME}$`);
export const SNAPSHOT_FIELDS = [
  "counts",
  "labels",
  "main_oid",
  "open_issue_numbers",
  "open_pull_requests",
  "pagination",
  "repository",
] as const;

export type SnapshotField = (typeof SNAPSHOT_FIELDS)[number];
export type OutputFormat = "json" | "text";
export type CommandName =
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

export interface Effects {
  read_only: boolean;
  destructive: boolean;
  idempotent: boolean;
  open_world: boolean;
  supports_dry_run: boolean;
}

export type ParsedCommand =
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

export class CliFailure extends Error {
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

export const EFFECTS: Record<CommandName, Effects> = {
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
