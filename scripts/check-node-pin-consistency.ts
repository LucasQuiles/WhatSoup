import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildkitImageDigest, isBuildkitImageDependency } from './lib/buildkit-image-dependency.ts';

export type NodePinSource =
  | '.nvmrc'
  | 'package.json#volta.node'
  | 'package.json#engines.node'
  | 'docker/Dockerfile'
  | 'docker/container-inputs.json'
  | 'deploy/whatsoup'
  | 'deploy/whatsoup-auth'
  | 'deploy/whatsoup-fleet'
  | 'scripts/run-with-pinned-node.sh'
  | 'scripts/run-with-pinned-npm.sh'
  | 'deploy/templates/watchdog-script.sh';

export interface NodePinReading {
  source: NodePinSource;
  filePath: string;
  /** Concrete pinned version (e.g. "24.15.0"). null if the source intentionally has none. */
  version: string | null;
  /** Raw matched text used when reporting drift. */
  raw: string;
}

export interface NodePinDrift {
  /** Canonical version derived from .nvmrc. */
  canonical: string;
  /** Sources whose pinned version differs from canonical. */
  mismatches: NodePinReading[];
  /** Sources scanned but missing the expected pin marker. */
  missing: { source: NodePinSource; filePath: string; reason: string }[];
}

export interface NodePinOptions {
  cwd?: string;
}

interface DockerNodePinReading extends NodePinReading {
  digest: string | null;
}

interface ContainerInputPolicy {
  schemaVersion: number;
  platform: string;
  sourceRepository: string;
  baseImage: string;
  baseImageDependency: string;
  baseImageResolvedDigest: string;
  builder: {
    name: string;
    driver: string;
    provenanceIdPrefix: string;
  };
  buildx: {
    version: string;
    asset: string;
    sha256: string;
    buildkitImage: string;
  };
  sbom: {
    generator: string;
    dependency: string;
    resolvedDigest: string;
  };
  apt: {
    snapshot: string;
    sources: string[];
  };
}

const CONTAINER_INPUT_POLICY_PATH = 'docker/container-inputs.json';
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const NODE_IMAGE_PATTERN = /^node:(\d+\.\d+\.\d+)-slim@(sha256:[a-f0-9]{64})$/;
const SNAPSHOT_TIMESTAMP_PATTERN = /^\d{8}T\d{6}Z$/;
const BUILDX_VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;
const BUILDKIT_IMAGE_PATTERN = /^moby\/buildkit:v\d+\.\d+\.\d+@sha256:[a-f0-9]{64}$/;
const SBOM_GENERATOR_IMAGE_PATTERN = /^docker\/buildkit-syft-scanner:stable-1@sha256:[a-f0-9]{64}$/;
const BASE_IMAGE_DEPENDENCY = 'pkg:docker/node@24.15.0-slim?digest=sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d&platform=linux%2Famd64';
const SBOM_GENERATOR_DEPENDENCY = 'pkg:docker/docker/buildkit-syft-scanner@stable-1?digest=sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9&platform=linux%2Famd64';
const SOURCE_REPOSITORY_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/;
const APT_SOURCE_DEFINITION_PATTERN = /(?:^|['"\s])((?:deb|deb-src)(?:\s+\[[^\]\r\n]+\])?\s+[^\s'"]+\s+[^\s'"]+(?:\s+[^\s'"]+)*)(?=['"\\,;]|\s*$)/g;

const HARDCODED_NODE_PATH_PATTERN =
  /\/\.nvm\/versions\/node\/v(\d+\.\d+\.\d+)\/bin\/node/;
// Match any shell-level read of "$REPO_ROOT/.nvmrc" — `cat "$REPO_ROOT/.nvmrc"`,
// `tr ... < "$REPO_ROOT/.nvmrc"`, `<"$REPO_ROOT/.nvmrc"`, etc. The lib variant
// uses a lowercase `$repo_root` argument, so accept either casing.
const NVMRC_REFERENCE_PATTERN = /\$\{?(?:REPO_ROOT|repo_root)\}?\/\.nvmrc/;
// A wrapper may delegate Node-pin resolution (and the .nvmrc read) to the shared
// resolver library. Sourcing it counts as reading .nvmrc, because the library is
// the single source of truth that performs the read (DRY).
const RESOLVE_NODE_LIB_REFERENCE_PATTERN = /lib\/resolve-node\.sh/;

const WRAPPER_SOURCES: { source: NodePinSource; relPath: string }[] = [
  { source: 'deploy/whatsoup', relPath: 'deploy/whatsoup' },
  { source: 'deploy/whatsoup-auth', relPath: 'deploy/whatsoup-auth' },
  { source: 'deploy/whatsoup-fleet', relPath: 'deploy/whatsoup-fleet' },
  { source: 'scripts/run-with-pinned-node.sh', relPath: 'scripts/run-with-pinned-node.sh' },
  { source: 'scripts/run-with-pinned-npm.sh', relPath: 'scripts/run-with-pinned-npm.sh' },
  // The watchdog template hardcodes the pinned node path (never reads .nvmrc — it
  // runs from a rendered install location). Scanning it forces a .nvmrc bump to
  // also update the template, instead of silently breaking the watchdog's node.
  { source: 'deploy/templates/watchdog-script.sh', relPath: 'deploy/templates/watchdog-script.sh' },
];

function readNvmrc(cwd: string): NodePinReading {
  const filePath = path.join(cwd, '.nvmrc');
  const raw = readFileSync(filePath, 'utf8').trim();
  return { source: '.nvmrc', filePath, version: raw, raw };
}

function readPackageJsonPins(cwd: string): NodePinReading[] {
  const filePath = path.join(cwd, 'package.json');
  const pkg = JSON.parse(readFileSync(filePath, 'utf8')) as {
    engines?: { node?: string };
    volta?: { node?: string };
  };
  const readings: NodePinReading[] = [];
  if (pkg.volta?.node) {
    readings.push({
      source: 'package.json#volta.node',
      filePath,
      version: pkg.volta.node.trim(),
      raw: pkg.volta.node,
    });
  } else {
    readings.push({
      source: 'package.json#volta.node',
      filePath,
      version: null,
      raw: '',
    });
  }
  if (pkg.engines?.node) {
    readings.push({
      source: 'package.json#engines.node',
      filePath,
      version: null,
      raw: pkg.engines.node,
    });
  }
  return readings;
}

function readDockerfilePins(cwd: string): DockerNodePinReading[] {
  const filePath = path.join(cwd, 'docker/Dockerfile');
  const text = readFileSync(filePath, 'utf8');
  const readings: DockerNodePinReading[] = [];
  const fromLine = /^FROM\s+node:(\d+\.\d+\.\d+)(?:-slim|-alpine|-bookworm)?(@sha256:([a-f0-9]{64}))?\s+AS\s+\S+/gim;
  let match: RegExpExecArray | null;
  while ((match = fromLine.exec(text)) !== null) {
    readings.push({
      source: 'docker/Dockerfile',
      filePath,
      version: match[1] ?? null,
      raw: match[0] ?? '',
      digest: match[3] ?? null,
    });
  }
  if (readings.length === 0) {
    readings.push({
      source: 'docker/Dockerfile',
      filePath,
      version: null,
      raw: '',
      digest: null,
    });
  }
  return readings;
}

function containerInputIssue(
  cwd: string,
  source: 'docker/Dockerfile' | 'docker/container-inputs.json',
  reason: string,
): NodePinDrift['missing'][number] {
  return {
    source,
    filePath: path.join(cwd, source),
    reason,
  };
}

function readContainerInputPolicy(cwd: string):
  | { policy: ContainerInputPolicy; issue: null }
  | { policy: null; issue: NodePinDrift['missing'][number] } {
  const filePath = path.join(cwd, CONTAINER_INPUT_POLICY_PATH);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return {
      policy: null,
      issue: containerInputIssue(cwd, 'docker/container-inputs.json', 'missing or invalid container input policy'),
    };
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || (parsed as { schemaVersion?: unknown }).schemaVersion !== 3
    || (parsed as { platform?: unknown }).platform !== 'linux/amd64'
    || typeof (parsed as { sourceRepository?: unknown }).sourceRepository !== 'string'
    || !SOURCE_REPOSITORY_PATTERN.test((parsed as { sourceRepository: string }).sourceRepository)
    || typeof (parsed as { baseImage?: unknown }).baseImage !== 'string'
    || (parsed as { baseImageDependency?: unknown }).baseImageDependency !== BASE_IMAGE_DEPENDENCY
    || !isBuildkitImageDependency(
      (parsed as { baseImageDependency?: unknown }).baseImageDependency,
      (parsed as { baseImage?: unknown }).baseImage,
      (parsed as { platform?: unknown }).platform,
    )
    || typeof (parsed as { baseImageResolvedDigest?: unknown }).baseImageResolvedDigest !== 'string'
    || !SHA256_DIGEST_PATTERN.test((parsed as { baseImageResolvedDigest: string }).baseImageResolvedDigest)
    || (parsed as { baseImageResolvedDigest: string }).baseImageResolvedDigest
      !== buildkitImageDigest((parsed as { baseImage: string }).baseImage)
    || !(parsed as { builder?: unknown }).builder
    || typeof (parsed as { builder: { name?: unknown } }).builder.name !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test((parsed as { builder: { name: string } }).builder.name)
    || (parsed as { builder: { driver?: unknown } }).builder.driver !== 'docker-container'
    || typeof (parsed as { builder: { provenanceIdPrefix?: unknown } }).builder.provenanceIdPrefix !== 'string'
    || (parsed as { builder: { provenanceIdPrefix: string } }).builder.provenanceIdPrefix
      !== `${(parsed as { sourceRepository: string }).sourceRepository.slice(0, -'.git'.length)}/actions/runs/`
    || !(parsed as { buildx?: unknown }).buildx
    || typeof (parsed as { buildx: { version?: unknown } }).buildx.version !== 'string'
    || !BUILDX_VERSION_PATTERN.test((parsed as { buildx: { version: string } }).buildx.version)
    || typeof (parsed as { buildx: { asset?: unknown } }).buildx.asset !== 'string'
    || (parsed as { buildx: { asset: string; version: string } }).buildx.asset
      !== `buildx-${(parsed as { buildx: { version: string } }).buildx.version}.linux-amd64`
    || typeof (parsed as { buildx: { sha256?: unknown } }).buildx.sha256 !== 'string'
    || !SHA256_DIGEST_PATTERN.test((parsed as { buildx: { sha256: string } }).buildx.sha256)
    || typeof (parsed as { buildx: { buildkitImage?: unknown } }).buildx.buildkitImage !== 'string'
    || !BUILDKIT_IMAGE_PATTERN.test((parsed as { buildx: { buildkitImage: string } }).buildx.buildkitImage)
    || !(parsed as { sbom?: unknown }).sbom
    || typeof (parsed as { sbom: { generator?: unknown } }).sbom.generator !== 'string'
    || !SBOM_GENERATOR_IMAGE_PATTERN.test((parsed as { sbom: { generator: string } }).sbom.generator)
    || (parsed as { sbom: { dependency?: unknown } }).sbom.dependency !== SBOM_GENERATOR_DEPENDENCY
    || !isBuildkitImageDependency(
      (parsed as { sbom: { dependency?: unknown } }).sbom.dependency,
      (parsed as { sbom: { generator?: unknown } }).sbom.generator,
      (parsed as { platform?: unknown }).platform,
    )
    || typeof (parsed as { sbom: { resolvedDigest?: unknown } }).sbom.resolvedDigest !== 'string'
    || !SHA256_DIGEST_PATTERN.test((parsed as { sbom: { resolvedDigest: string } }).sbom.resolvedDigest)
    || (parsed as { sbom: { generator: string; resolvedDigest: string } }).sbom.resolvedDigest
      !== buildkitImageDigest((parsed as { sbom: { generator: string } }).sbom.generator)
    || !(parsed as { apt?: unknown }).apt
    || typeof (parsed as { apt: { snapshot?: unknown } }).apt.snapshot !== 'string'
    || !Array.isArray((parsed as { apt: { sources?: unknown } }).apt.sources)
    || !(parsed as { apt: { sources: unknown[] } }).apt.sources.every((source) => typeof source === 'string')
  ) {
    return {
      policy: null,
      issue: containerInputIssue(cwd, 'docker/container-inputs.json', 'invalid container input policy shape'),
    };
  }
  return { policy: parsed as ContainerInputPolicy, issue: null };
}

function dockerExternalImageRefs(text: string): string[] {
  const instructions = [...text.matchAll(/^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/gim)];
  const stageAliases = new Set(
    instructions
      .map((match) => match[2]?.toLowerCase())
      .filter((alias): alias is string => Boolean(alias)),
  );
  return instructions
    .map((match) => match[1] ?? '')
    .filter((image) => image !== 'scratch' && !stageAliases.has(image.toLowerCase()));
}

function activeDockerfileLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('#'));
}

function activeDockerfileRunLines(lines: string[]): string[] {
  const runLines: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!/^\s*RUN\s+/i.test(line)) continue;
    runLines.push(line);
    const heredocDelimiter = /<<-?\s*['"]?([A-Za-z0-9_.-]+)['"]?/.exec(line)?.[1];
    if (heredocDelimiter) {
      while (index + 1 < lines.length) {
        index += 1;
        const heredocLine = lines[index] ?? '';
        runLines.push(heredocLine);
        if (heredocLine.trim() === heredocDelimiter) break;
      }
      continue;
    }
    while (lineEndsWithContinuation(lines[index] ?? '') && index + 1 < lines.length) {
      index += 1;
      runLines.push(lines[index] ?? '');
    }
  }
  return runLines;
}

function lineEndsWithContinuation(line: string): boolean {
  return /\\\s*$/.test(line);
}

function activeAptSourceDefinitions(runLines: string[]): string[] {
  const definitions: string[] = [];
  for (const line of runLines) {
    const shellLine = line.replace(/^\s*RUN\s+/i, '');
    if (shellLine.trimStart().startsWith('#')) continue;
    for (const match of line.matchAll(APT_SOURCE_DEFINITION_PATTERN)) {
      definitions.push(match[1] ?? '');
    }
  }
  return definitions;
}

interface DockerfileInstruction {
  keyword: string;
  text: string;
}

function activeDockerfileInstructions(lines: string[]): DockerfileInstruction[] {
  const instructions: DockerfileInstruction[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = /^\s*([A-Za-z]+)\s+/.exec(line);
    if (!match?.[1]) continue;
    const instructionLines = [line];
    const heredocDelimiter = /<<-?\s*['"]?([A-Za-z0-9_.-]+)['"]?/.exec(line)?.[1];
    if (heredocDelimiter) {
      while (index + 1 < lines.length) {
        index += 1;
        const heredocLine = lines[index] ?? '';
        instructionLines.push(heredocLine);
        if (heredocLine.trim() === heredocDelimiter) break;
      }
    } else {
      while (lineEndsWithContinuation(lines[index] ?? '') && index + 1 < lines.length) {
        index += 1;
        instructionLines.push(lines[index] ?? '');
      }
    }
    instructions.push({ keyword: match[1].toUpperCase(), text: instructionLines.join('\n') });
  }
  return instructions;
}

const APT_SOURCE_DESCRIPTOR_PATH_PATTERN = /\/etc\/apt(?:\/sources\.list(?:\.d(?:\/[^\s'"]*)?)?|\/sources\.list\.d(?:\/[^\s'"]*)?)?/g;
const APT_DIRECTORY_CHANGE_PATTERN = /(?:^|[;&|()]\s*)\s*(?:cd|pushd)\s+(?:--\s*)?['"]?\/etc(?:[/'"\s;)&|]|$)/im;
const RELATIVE_APT_DESCRIPTOR_PATTERN = /(?:^|[\s;'"=])(?:\.\/)?(?:etc\/)?apt\/sources\.list(?:\.d(?:\/[A-Za-z0-9_.-]+)?|(?:[\s'";)&|]|$))/im;
const APT_ROOT_ASSIGNMENT_PATTERN = /\b[A-Za-z_][A-Za-z0-9_]*\s*=\s*['"]?\/etc(?:[/'"\s;)&|]|$)/im;
const APT_ROOT_DECLARATION_PATTERN = /^\s*(?:ENV|ARG)\s+[A-Za-z_][A-Za-z0-9_]*\s+['"]?\/etc(?:[/'"\s;)&|]|$)/im;
const UNSUPPORTED_DOCKERFILE_EXPANSION_PATTERN = /[$`]/;
const UNSAFE_APT_AUTHENTICATION_PATTERN = /(?:--allow-(?:unauthenticated|insecure-repositories|weak-repositories)\b|(?:Acquire::Allow(?:Insecure|Weak|DowngradeToInsecure)Repositories|APT::Get::AllowUnauthenticated)\s*(?:=\s*|\s+)["']?(?:true|yes|1)["']?(?![A-Za-z0-9_])|\b(?:trusted|allow-insecure|allow-weak|allow-downgrade-to-insecure)\s*=\s*["']?(?:true|yes|1)["']?(?![A-Za-z0-9_]))/i;
const APT_GET_UPDATE_PATTERN = /\bapt-get\b(?:(?![;&|]).)*?\s+update(?=\s|\\|$)/gis;
const FAIL_CLOSED_APT_UPDATE_OPTION = 'APT::Update::Error-Mode=any';

function descriptorPaths(instruction: string): string[] {
  return [...instruction.matchAll(APT_SOURCE_DESCRIPTOR_PATH_PATTERN)].map((match) => match[0] ?? '');
}

function isApprovedAptBootstrap(instruction: DockerfileInstruction): boolean {
  if (instruction.keyword !== 'RUN') return false;
  const paths = descriptorPaths(instruction.text);
  if (
    paths.length !== 2
    || paths[0] !== '/etc/apt/sources.list'
    || paths[1] !== '/etc/apt/sources.list.d/*'
  ) return false;
  return /(?:^|\s)>\s*\/etc\/apt\/sources\.list(?:\s|\\|$)/m.test(instruction.text)
    && /rm\s+-rf\s+\/etc\/apt\/sources\.list\.d\/\*(?:\s|$)/m.test(instruction.text);
}

function declaresAptRoot(instruction: DockerfileInstruction): boolean {
  if (instruction.keyword !== 'ENV' && instruction.keyword !== 'ARG') return false;
  return APT_ROOT_ASSIGNMENT_PATTERN.test(instruction.text)
    || APT_ROOT_DECLARATION_PATTERN.test(instruction.text);
}

function hasUnsafeAptSourceMutation(instructions: DockerfileInstruction[]): boolean {
  return instructions.some((instruction) => {
    if (instruction.keyword === 'WORKDIR' && /\bWORKDIR\s+\/etc(?:\/|\s|$)/i.test(instruction.text)) {
      return true;
    }
    if (descriptorPaths(instruction.text).length > 0) return !isApprovedAptBootstrap(instruction);
    if (RELATIVE_APT_DESCRIPTOR_PATTERN.test(instruction.text)) return true;
    if (declaresAptRoot(instruction)) return true;
    if (instruction.keyword !== 'RUN') return false;
    const shell = instruction.text.replace(/^\s*RUN\s+/i, '');
    // The bootstrap is the sole authorized writer of effective APT source
    // descriptors. Reject changing into /etc (or declaring an /etc root
    // indirection) so later relative paths cannot replace that state outside the
    // descriptor-path matcher. Any relative `apt/sources.list` operand is
    // likewise ambiguous: a Docker stage begins from `/` unless a prior
    // WORKDIR changes it.
    return APT_DIRECTORY_CHANGE_PATTERN.test(shell)
      || APT_ROOT_ASSIGNMENT_PATTERN.test(shell);
  });
}

function hasUnsupportedDockerfileExpansion(instructions: DockerfileInstruction[]): boolean {
  return instructions.some((instruction) => UNSUPPORTED_DOCKERFILE_EXPANSION_PATTERN.test(instruction.text));
}

function hasUnsafeAptAuthentication(instructions: DockerfileInstruction[]): boolean {
  return instructions.some((instruction) => UNSAFE_APT_AUTHENTICATION_PATTERN.test(instruction.text));
}

function hasFailOpenAptUpdate(instructions: DockerfileInstruction[]): boolean {
  return instructions.some((instruction) => {
    if (instruction.keyword !== 'RUN') return false;
    const updates = [...instruction.text.matchAll(APT_GET_UPDATE_PATTERN)]
      .map((match) => match[0] ?? '');
    return updates.some((update) => !update.includes(FAIL_CLOSED_APT_UPDATE_OPTION));
  });
}

function findContainerInputDrift(cwd: string): NodePinDrift['missing'] {
  const policyResult = readContainerInputPolicy(cwd);
  if (!policyResult.policy) return [policyResult.issue];

  const { policy } = policyResult;
  const policyIssues: NodePinDrift['missing'] = [];
  const expectedImage = NODE_IMAGE_PATTERN.exec(policy.baseImage);
  if (!expectedImage || !SHA256_DIGEST_PATTERN.test(expectedImage[2] ?? '')) {
    policyIssues.push(containerInputIssue(
      cwd,
      'docker/container-inputs.json',
      'base image must use node:<version>-slim@sha256:<digest>',
    ));
  }
  if (!SNAPSHOT_TIMESTAMP_PATTERN.test(policy.apt.snapshot)) {
    policyIssues.push(containerInputIssue(
      cwd,
      'docker/container-inputs.json',
      'APT snapshot must be a UTC timestamp in YYYYMMDDTHHMMSSZ form',
    ));
  }

  const expectedSources = [
    `http://snapshot.debian.org/archive/debian/${policy.apt.snapshot}/ bookworm main`,
    `http://snapshot.debian.org/archive/debian-security/${policy.apt.snapshot}/ bookworm-security main`,
  ];
  if (
    policy.apt.sources.length !== expectedSources.length
    || policy.apt.sources.some((source, index) => source !== expectedSources[index])
  ) {
    policyIssues.push(containerInputIssue(
      cwd,
      'docker/container-inputs.json',
      'APT sources must use the CA-independent approved Debian snapshot transport',
    ));
  }

  const dockerfilePath = path.join(cwd, 'docker/Dockerfile');
  const dockerfile = readFileSync(dockerfilePath, 'utf8');
  const activeLines = activeDockerfileLines(dockerfile);
  const activeRunLines = activeDockerfileRunLines(activeLines);
  const activeInstructions = activeDockerfileInstructions(activeLines);
  for (const image of dockerExternalImageRefs(dockerfile)) {
    if (!image.includes('@sha256:')) {
      policyIssues.push(containerInputIssue(cwd, 'docker/Dockerfile', 'base image is not pinned by digest'));
      continue;
    }
    if (image !== policy.baseImage) {
      policyIssues.push(containerInputIssue(cwd, 'docker/Dockerfile', 'base image does not match docker/container-inputs.json'));
    }
  }
  const sourceListDReferences = activeLines.flatMap((line) => (
    [...line.matchAll(/\/etc\/apt\/sources\.list\.d(?:\/[^\s'"]*)?/g)].map((match) => match[0] ?? '')
  ));
  const clearsSourcesListD = activeLines.some((line) => (
    /rm\s+-rf\s+\/etc\/apt\/sources\.list\.d\/\*(?:\s|$)/.test(line)
  ));
  if (
    !clearsSourcesListD
    || sourceListDReferences.length !== 1
    || sourceListDReferences[0] !== '/etc/apt/sources.list.d/*'
  ) {
    policyIssues.push(containerInputIssue(
      cwd,
      'docker/Dockerfile',
      'Dockerfile does not fully clear inherited APT source descriptors',
    ));
  }
  if (hasUnsafeAptSourceMutation(activeInstructions)) {
    policyIssues.push(containerInputIssue(
      cwd,
      'docker/Dockerfile',
      'Dockerfile may not modify APT source descriptors outside the approved bootstrap',
    ));
  }
  if (hasUnsupportedDockerfileExpansion(activeInstructions)) {
    policyIssues.push(containerInputIssue(
      cwd,
      'docker/Dockerfile',
      'Dockerfile may not use variable or command expansion until the static invariant is extended',
    ));
  }
  if (hasUnsafeAptAuthentication(activeInstructions)) {
    policyIssues.push(containerInputIssue(
      cwd,
      'docker/Dockerfile',
      'Dockerfile may not disable APT repository authentication',
    ));
  }
  if (hasFailOpenAptUpdate(activeInstructions)) {
    policyIssues.push(containerInputIssue(
      cwd,
      'docker/Dockerfile',
      'every apt-get update must fail on any unavailable snapshot source',
    ));
  }
  const expectedDefinitions = expectedSources.map((source) => `deb [check-valid-until=no] ${source}`);
  const actualDefinitions = activeAptSourceDefinitions(activeRunLines);
  if (
    actualDefinitions.length !== expectedDefinitions.length
    || actualDefinitions.some((definition, index) => definition !== expectedDefinitions[index])
  ) {
    policyIssues.push(containerInputIssue(
      cwd,
      'docker/Dockerfile',
      'APT source definitions must exactly match docker/container-inputs.json',
    ));
  }
  return policyIssues;
}

function verifyContainerSnapshotAvailability(
  cwd: string,
  env: NodeJS.ProcessEnv,
): NodePinDrift['missing'] {
  const policyResult = readContainerInputPolicy(cwd);
  if (!policyResult.policy || !SNAPSHOT_TIMESTAMP_PATTERN.test(policyResult.policy.apt.snapshot)) {
    return [];
  }

  const snapshot = policyResult.policy.apt.snapshot;
  const releases = [
    `https://snapshot.debian.org/archive/debian/${snapshot}/dists/bookworm/Release`,
    `https://snapshot.debian.org/archive/debian-security/${snapshot}/dists/bookworm-security/Release`,
  ];
  const issues: NodePinDrift['missing'] = [];
  for (const release of releases) {
    try {
      execFileSync('curl', [
        '--fail',
        '--silent',
        '--show-error',
        '--location',
        '--max-time',
        '30',
        release,
      ], {
        env,
        stdio: 'ignore',
        timeout: 35_000,
      });
    } catch {
      issues.push(containerInputIssue(
        cwd,
        'docker/container-inputs.json',
        `APT snapshot release metadata is unavailable: ${release}`,
      ));
    }
  }
  return issues;
}

function readWrapperPin(
  cwd: string,
  source: NodePinSource,
  relPath: string,
): NodePinReading {
  const filePath = path.join(cwd, relPath);
  const text = readFileSync(filePath, 'utf8');
  if (NVMRC_REFERENCE_PATTERN.test(text)) {
    return { source, filePath, version: null, raw: 'reads .nvmrc' };
  }
  // Delegation to the shared resolver lib is a valid .nvmrc read, provided the
  // lib itself reads .nvmrc (verified to keep the delegation honest).
  if (RESOLVE_NODE_LIB_REFERENCE_PATTERN.test(text)) {
    const libPath = path.join(cwd, 'deploy/lib/resolve-node.sh');
    let libText = '';
    try {
      libText = readFileSync(libPath, 'utf8');
    } catch {
      libText = '';
    }
    if (NVMRC_REFERENCE_PATTERN.test(libText)) {
      return { source, filePath, version: null, raw: 'reads .nvmrc' };
    }
  }
  const m = text.match(HARDCODED_NODE_PATH_PATTERN);
  if (m) {
    return { source, filePath, version: m[1] ?? null, raw: m[0] ?? '' };
  }
  return { source, filePath, version: null, raw: '' };
}

export function collectNodePinReadings(
  options: NodePinOptions = {},
): NodePinReading[] {
  const cwd = options.cwd ?? process.cwd();
  const readings: NodePinReading[] = [];
  readings.push(readNvmrc(cwd));
  readings.push(...readPackageJsonPins(cwd));
  readings.push(...readDockerfilePins(cwd));
  for (const w of WRAPPER_SOURCES) {
    readings.push(readWrapperPin(cwd, w.source, w.relPath));
  }
  return readings;
}

export function findNodePinDrift(options: NodePinOptions = {}): NodePinDrift {
  const cwd = options.cwd ?? process.cwd();
  const readings = collectNodePinReadings(options);
  const nvmrc = readings.find((r) => r.source === '.nvmrc');
  if (!nvmrc || !nvmrc.version) {
    throw new Error(
      '.nvmrc missing or empty — cannot determine canonical Node version',
    );
  }
  const canonical = nvmrc.version;
  const dockerReadings = readDockerfilePins(cwd);

  const mismatches: NodePinReading[] = [];
  const missing: NodePinDrift['missing'] = [];

  for (const r of readings) {
    if (r.source === '.nvmrc') continue;
    if (r.source === 'package.json#engines.node') {
      const majorMatch = canonical.match(/^(\d+)/);
      const major = majorMatch ? majorMatch[1] : null;
      if (!major || !r.raw.includes(major)) {
        mismatches.push(r);
      }
      continue;
    }
    if (r.source === 'package.json#volta.node') {
      if (!r.version) {
        missing.push({
          source: r.source,
          filePath: r.filePath,
          reason: 'volta.node not set',
        });
        continue;
      }
      if (r.version !== canonical) mismatches.push(r);
      continue;
    }
    if (r.source === 'docker/Dockerfile') {
      if (!r.version) {
        missing.push({
          source: r.source,
          filePath: r.filePath,
          reason: 'no FROM node:<version> stage detected',
        });
        continue;
      }
      if (r.version !== canonical) mismatches.push(r);
      continue;
    }
    if (r.version === null && r.raw === 'reads .nvmrc') continue;
    if (r.version === null) {
      missing.push({
        source: r.source,
        filePath: r.filePath,
        reason: 'wrapper neither reads .nvmrc nor pins a Node path',
      });
      continue;
    }
    if (r.version !== canonical) mismatches.push(r);
  }

  for (const reading of dockerReadings) {
    if (reading.version !== null && reading.digest === null) {
      missing.push({
        source: reading.source,
        filePath: reading.filePath,
        reason: 'base image is not pinned by digest',
      });
    }
  }

  missing.push(...findContainerInputDrift(cwd));

  return { canonical, mismatches, missing };
}

function printDrift(drift: NodePinDrift): void {
  console.error(`Canonical Node version (.nvmrc): ${drift.canonical}`);
  for (const m of drift.mismatches) {
    console.error(
      `  MISMATCH ${m.source} (${m.filePath}): pinned=${m.version ?? '<none>'} canonical=${drift.canonical} raw="${m.raw}"`,
    );
  }
  for (const m of drift.missing) {
    console.error(`  MISSING ${m.source} (${m.filePath}): ${m.reason}`);
  }
}

export function run(
  _argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): NodePinDrift {
  if (env.WHATSOUP_SKIP_NODE_PIN_CHECK === '1') {
    const inCi = env.CI === 'true' || Boolean(env.GITHUB_ACTIONS);
    if (inCi) {
      console.warn(
        'WHATSOUP_SKIP_NODE_PIN_CHECK=1 ignored: CI/GITHUB_ACTIONS detected; node-pin consistency check will run (this skip is for local dev only)',
      );
    } else {
      console.warn(
        'node-pin consistency check skipped via WHATSOUP_SKIP_NODE_PIN_CHECK=1',
      );
      return { canonical: '', mismatches: [], missing: [] };
    }
  }
  const drift = findNodePinDrift({ cwd });
  const result: NodePinDrift = {
    ...drift,
    missing: _argv.includes('--verify-container-snapshot')
      ? [...drift.missing, ...verifyContainerSnapshotAvailability(cwd, env)]
      : drift.missing,
  };
  if (result.mismatches.length > 0 || result.missing.length > 0) {
    printDrift(result);
    process.exitCode = 1;
  } else {
    console.log(
      `node-pin consistency check passed (canonical=${drift.canonical})`,
    );
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
