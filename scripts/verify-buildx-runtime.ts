import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseClosedOptions } from './lib/cli-args.ts';

interface RuntimePolicy {
  builder?: {
    name?: unknown;
    driver?: unknown;
  };
  buildx?: {
    version?: unknown;
    buildkitImage?: unknown;
  };
}

interface ExpectedRuntime {
  builderName: string;
  builderDriver: string;
  buildxVersion: string;
  buildkitVersion: string;
}

export interface BuildxRuntimeIdentity extends ExpectedRuntime {}

export interface VerifyBuildxRuntimeOptions {
  repoRoot: string;
  runCommand?: (file: string, args: readonly string[]) => string;
}

const VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;
const BUILDER_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const BUILDKIT_IMAGE_PATTERN = /^moby\/buildkit:(v\d+\.\d+\.\d+)@sha256:[a-f0-9]{64}$/;
const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_MAX_BYTES = 1024 * 1024;

function loadExpectedRuntime(repoRoot: string): ExpectedRuntime {
  const policyPath = path.join(path.resolve(repoRoot), 'docker/container-inputs.json');
  let policy: RuntimePolicy;
  try {
    policy = JSON.parse(readFileSync(policyPath, 'utf8')) as RuntimePolicy;
  } catch {
    throw new Error(`container input policy is missing or invalid JSON: ${policyPath}`);
  }
  const builderName = policy.builder?.name;
  const builderDriver = policy.builder?.driver;
  const buildxVersion = policy.buildx?.version;
  const buildkitImage = policy.buildx?.buildkitImage;
  const buildkitMatch = typeof buildkitImage === 'string'
    ? BUILDKIT_IMAGE_PATTERN.exec(buildkitImage)
    : null;
  if (
    typeof builderName !== 'string'
    || !BUILDER_VALUE_PATTERN.test(builderName)
    || typeof builderDriver !== 'string'
    || !BUILDER_VALUE_PATTERN.test(builderDriver)
    || typeof buildxVersion !== 'string'
    || !VERSION_PATTERN.test(buildxVersion)
    || !buildkitMatch
  ) {
    throw new Error(`container input policy has an invalid Buildx runtime identity: ${policyPath}`);
  }
  return {
    builderName,
    builderDriver,
    buildxVersion,
    buildkitVersion: buildkitMatch[1]!,
  };
}

function defaultRunCommand(file: string, args: readonly string[]): string {
  return execFileSync(file, [...args], {
    encoding: 'utf8',
    maxBuffer: COMMAND_MAX_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: COMMAND_TIMEOUT_MS,
  });
}

function singleField(lines: string[], field: string, context: string): string {
  const prefix = `${field}:`;
  const values = lines
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim())
    .filter(Boolean);
  if (values.length !== 1) {
    throw new Error(`${context} has no unambiguous ${field}`);
  }
  return values[0]!;
}

function parseBuildxVersion(output: string): string {
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error('Buildx version output is not unambiguous');
  const match = /^github\.com\/docker\/buildx\s+(v\d+\.\d+\.\d+)(?:\s+\S+)?$/u.exec(lines[0]!);
  if (!match) throw new Error('Buildx version output is not recognized');
  return match[1]!;
}

function parseBuildxInspect(output: string): {
  builderName: string;
  builderDriver: string;
  buildkitVersion: string;
} {
  const lines = output.split(/\r?\n/u);
  const nodesIndex = lines.findIndex((line) => line.trim() === 'Nodes:');
  if (nodesIndex < 0) throw new Error('Buildx inspect output has no Nodes section');
  const header = lines.slice(0, nodesIndex);
  const builderName = singleField(header, 'Name', 'Buildx inspect output');
  const builderDriver = singleField(header, 'Driver', 'Buildx inspect output');
  const buildkitVersion = singleField(lines.slice(nodesIndex + 1), 'BuildKit version', 'Buildx inspect output');
  if (!VERSION_PATTERN.test(buildkitVersion)) {
    throw new Error('Buildx inspect output has an invalid BuildKit version');
  }
  return { builderName, builderDriver, buildkitVersion };
}

/** Verifies the installed Buildx plugin and booted builder against reviewed policy. */
export function verifyBuildxRuntime(options: VerifyBuildxRuntimeOptions): BuildxRuntimeIdentity {
  const expected = loadExpectedRuntime(options.repoRoot);
  const runCommand = options.runCommand ?? defaultRunCommand;
  const buildxVersion = parseBuildxVersion(runCommand('docker', ['buildx', 'version']));
  const inspected = parseBuildxInspect(runCommand('docker', [
    'buildx',
    'inspect',
    expected.builderName,
    '--bootstrap',
  ]));

  if (inspected.builderName !== expected.builderName) {
    throw new Error(`Buildx builder name differs from reviewed policy: expected ${expected.builderName}, got ${inspected.builderName}`);
  }
  if (inspected.builderDriver !== expected.builderDriver) {
    throw new Error(`Buildx builder driver differs from reviewed policy: expected ${expected.builderDriver}, got ${inspected.builderDriver}`);
  }
  if (buildxVersion !== expected.buildxVersion) {
    throw new Error(`Buildx version differs from reviewed policy: expected ${expected.buildxVersion}, got ${buildxVersion}`);
  }
  if (inspected.buildkitVersion !== expected.buildkitVersion) {
    throw new Error(`BuildKit version differs from reviewed policy: expected ${expected.buildkitVersion}, got ${inspected.buildkitVersion}`);
  }
  return {
    builderName: inspected.builderName,
    builderDriver: inspected.builderDriver,
    buildxVersion,
    buildkitVersion: inspected.buildkitVersion,
  };
}

export function parseArgs(argv: string[]): Pick<VerifyBuildxRuntimeOptions, 'repoRoot'> {
  const parsed = parseClosedOptions(argv, {
    booleanOptions: [],
    valueOptions: ['--repo-root'],
  });
  const repoRoot = parsed.values.get('--repo-root');
  if (parsed.error || parsed.values.size !== 1 || !repoRoot) {
    throw new Error('usage: verify-buildx-runtime.ts --repo-root PATH');
  }
  return { repoRoot };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const identity = verifyBuildxRuntime(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${identity.builderName}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
