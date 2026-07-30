#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildPriorityClusterInventory,
  canonicalPriorityClusterJson,
  parsePriorityClusterInventory,
  PRIORITY_CLUSTER_ARTIFACT,
  PRIORITY_CLUSTER_VIEW,
  renderPriorityClusterMarkdown,
  validatePriorityClusterInventory,
} from "./lib/open-issue-priority-clusters.ts";
import { writeConfinedGeneratedFile } from "./lib/open-issue-triage/cli-artifacts.ts";
import type { CliRuntime } from "./lib/open-issue-triage/cli-command.ts";

const REGISTRY = "docs/triage/open-issue-registry.json";

type ExitCode = 0 | 1 | 2;

export interface PriorityClusterCliOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

function writerRuntime(output: PriorityClusterCliOutput): CliRuntime {
  return {
    stdout: output.stdout,
    stderr: output.stderr,
    now: () => new Date().toISOString(),
    delay: async () => undefined,
    git: () => ({ status: 2, stdout: "", stderr: "" }),
  };
}

function readText(root: string, relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function emitPassed(
  output: PriorityClusterCliOutput,
  code: string,
): ExitCode {
  output.stdout(`PASS ${code}\n`);
  return 0;
}

function emitInvalid(
  output: PriorityClusterCliOutput,
  code: string,
): ExitCode {
  output.stderr(`INVALID ${code}\n`);
  return 1;
}

function emitInconclusive(
  output: PriorityClusterCliOutput,
  code: string,
): ExitCode {
  output.stderr(`INCONCLUSIVE ${code}\n`);
  return 2;
}

function validArgs(args: readonly string[]): boolean {
  return (
    (args.length === 1 && args[0] === "check") ||
    (args.length === 2 &&
      args[0] === "generate" &&
      args[1] === "--write") ||
    (args.length === 2 &&
      args[0] === "render" &&
      args[1] === "--check")
  );
}

export function runPriorityClusterCli(
  args: readonly string[],
  root = process.cwd(),
  output: PriorityClusterCliOutput = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): ExitCode {
  if (!validArgs(args)) {
    return emitInconclusive(output, "invalid-arguments");
  }

  let registryText: string;
  try {
    registryText = readText(root, REGISTRY);
  } catch {
    return emitInconclusive(output, "sealed-registry-unavailable");
  }

  let expectedJson: string;
  let expectedMarkdown: string;
  try {
    const expected = buildPriorityClusterInventory(registryText);
    expectedJson = canonicalPriorityClusterJson(expected);
    expectedMarkdown = renderPriorityClusterMarkdown(expected);
  } catch {
    return emitInconclusive(output, "sealed-registry-invalid");
  }

  const command = args[0]!;
  if (command === "generate") {
    try {
      const runtime = writerRuntime(output);
      writeConfinedGeneratedFile(
        root,
        PRIORITY_CLUSTER_ARTIFACT,
        expectedJson,
        runtime,
      );
      writeConfinedGeneratedFile(
        root,
        PRIORITY_CLUSTER_VIEW,
        expectedMarkdown,
        runtime,
      );
      return emitPassed(output, "priority-clusters-generated");
    } catch {
      return emitInconclusive(output, "artifact-write-failed");
    }
  }

  let artifactText: string;
  let markdownText: string;
  try {
    artifactText = readText(root, PRIORITY_CLUSTER_ARTIFACT);
    markdownText = readText(root, PRIORITY_CLUSTER_VIEW);
  } catch {
    return emitInvalid(output, "generated-artifact-drift");
  }

  let artifact;
  try {
    artifact = validatePriorityClusterInventory(
      parsePriorityClusterInventory(JSON.parse(artifactText)),
      registryText,
    );
  } catch {
    return emitInvalid(output, "generated-artifact-drift");
  }

  if (
    artifactText !== expectedJson ||
    markdownText !== renderPriorityClusterMarkdown(artifact) ||
    (command === "check" && markdownText !== expectedMarkdown)
  ) {
    return emitInvalid(output, "generated-artifact-drift");
  }
  return emitPassed(
    output,
    command === "check" ? "priority-clusters-valid" : "priority-clusters-rendered",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = runPriorityClusterCli(process.argv.slice(2));
}
