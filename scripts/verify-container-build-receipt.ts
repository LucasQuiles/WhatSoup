import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface ContainerInputPolicy {
  schemaVersion: number;
  baseImage: string;
  builder: {
    name: string;
    driver: string;
  };
}

interface BuildMetadata {
  'containerimage.digest'?: unknown;
  'buildx.build.provenance'?: unknown;
}

interface SbomDocument {
  spdxVersion?: unknown;
}

export interface ContainerBuildReceiptInput {
  repoRoot: string;
  metadataPath: string;
  sbomPath: string;
  imagePath: string;
  sourceRevision: string;
  builder: string;
}

export interface ContainerBuildReceipt {
  schemaVersion: 1;
  sourceRevision: string;
  builder: string;
  baseImage: string;
  imageDigest: string;
  imageArchiveSha256: string;
  metadataSha256: string;
  sbomSha256: string;
  sbomFormat: 'SPDX';
  provenance: 'buildx.build.provenance';
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const BUILDER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

interface OciIndexDescriptor {
  digest?: unknown;
  annotations?: Record<string, unknown>;
}

interface OciIndex {
  schemaVersion?: unknown;
  manifests?: unknown;
}

interface OciManifest {
  layers?: unknown;
}

interface OciLayerDescriptor {
  annotations?: Record<string, unknown>;
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function parseJson<T>(filePath: string, label: string): T {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    throw new Error(`${label} is missing or invalid JSON: ${filePath}`);
  }
}

function requireRegularFile(filePath: string, label: string): void {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    throw new Error(`${label} is missing: ${filePath}`);
  }
  if (!stat.isFile()) throw new Error(`${label} must be a regular file: ${filePath}`);
}

function loadPolicy(repoRoot: string): ContainerInputPolicy {
  const policyPath = path.join(repoRoot, 'docker/container-inputs.json');
  const policy = parseJson<ContainerInputPolicy>(policyPath, 'container input policy');
  if (
    policy.schemaVersion !== 1
    || typeof policy.baseImage !== 'string'
    || policy.baseImage.length === 0
    || !policy.builder
    || !BUILDER_NAME_PATTERN.test(policy.builder.name)
    || policy.builder.driver !== 'docker-container'
  ) {
    throw new Error(`container input policy has an invalid base image or builder: ${policyPath}`);
  }
  return policy;
}

function expectedBuilderIdentity(policy: ContainerInputPolicy): string {
  return `${policy.builder.name}|${policy.builder.driver}`;
}

function hasNonEmptyProvenance(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
}

function assertInput(input: ContainerBuildReceiptInput): {
  metadata: BuildMetadata;
  sbom: SbomDocument;
  policy: ContainerInputPolicy;
} {
  if (!COMMIT_PATTERN.test(input.sourceRevision)) {
    throw new Error(`source revision must be a full 40-hex commit: ${input.sourceRevision}`);
  }
  if (input.builder.trim().length === 0) throw new Error('builder identity is required');
  requireRegularFile(input.metadataPath, 'build metadata');
  requireRegularFile(input.sbomPath, 'SBOM');
  requireRegularFile(input.imagePath, 'image archive');

  const metadata = parseJson<BuildMetadata>(input.metadataPath, 'build metadata');
  if (typeof metadata['containerimage.digest'] !== 'string' || !SHA256_PATTERN.test(metadata['containerimage.digest'])) {
    throw new Error('build metadata is missing a valid containerimage.digest');
  }
  if (!hasNonEmptyProvenance(metadata['buildx.build.provenance'])) {
    throw new Error('build metadata is missing non-empty buildx.build.provenance');
  }

  const sbom = parseJson<SbomDocument>(input.sbomPath, 'SBOM');
  if (typeof sbom.spdxVersion !== 'string' || sbom.spdxVersion.length === 0) {
    throw new Error('SBOM must be SPDX JSON');
  }
  const policy = loadPolicy(input.repoRoot);
  if (input.builder !== expectedBuilderIdentity(policy)) {
    throw new Error('builder identity does not match docker/container-inputs.json');
  }
  return { metadata, sbom, policy };
}

function readOciArchiveEntry(archivePath: string, entry: string): string {
  for (const candidate of [entry, `./${entry}`]) {
    try {
      return execFileSync('tar', ['-xOf', archivePath, candidate], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      // OCI exporters differ on whether archive members have a leading "./".
    }
  }
  throw new Error(`OCI image archive is missing ${entry}: ${archivePath}`);
}

function blobEntryFromDigest(digest: unknown): string | null {
  if (typeof digest !== 'string' || !SHA256_PATTERN.test(digest)) return null;
  return `blobs/sha256/${digest.slice('sha256:'.length)}`;
}

function predicateTypesForAttestation(archivePath: string, descriptor: OciIndexDescriptor): string[] {
  const blobEntry = blobEntryFromDigest(descriptor.digest);
  if (!blobEntry) return [];
  let manifest: OciManifest;
  try {
    manifest = JSON.parse(readOciArchiveEntry(archivePath, blobEntry)) as OciManifest;
  } catch {
    return [];
  }
  if (!Array.isArray(manifest.layers)) return [];
  return (manifest.layers as OciLayerDescriptor[])
    .map((layer) => layer?.annotations?.['in-toto.io/predicate-type'])
    .filter((predicate): predicate is string => typeof predicate === 'string');
}

/**
 * Checks the preserved OCI layout rather than trusting a `--load` image, whose
 * Docker exporter can discard BuildKit attestations. The signed GitHub
 * attestations later bind this archive to the trusted workflow; this check makes
 * the unsigned PR evidence fail closed if BuildKit did not retain both its SLSA
 * provenance and SPDX SBOM predicates for the image digest.
 */
export function verifyOciArchiveAttestations(imagePath: string, imageDigest: string): void {
  let index: OciIndex;
  try {
    index = JSON.parse(readOciArchiveEntry(imagePath, 'index.json')) as OciIndex;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('OCI image archive')) throw error;
    throw new Error(`OCI image archive has invalid index.json: ${imagePath}`);
  }
  if (index.schemaVersion !== 2 || !Array.isArray(index.manifests)) {
    throw new Error(`OCI image archive has invalid index.json: ${imagePath}`);
  }
  const attestations = (index.manifests as OciIndexDescriptor[]).filter((descriptor) => (
    descriptor
    && typeof descriptor === 'object'
    && descriptor.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest'
  ));
  if (attestations.length === 0) {
    throw new Error(`OCI image archive has no BuildKit attestation manifest: ${imagePath}`);
  }
  const boundAttestations = attestations.filter(
    (descriptor) => descriptor.annotations?.['vnd.docker.reference.digest'] === imageDigest,
  );
  if (boundAttestations.length === 0) {
    throw new Error(`OCI image archive attestation is not bound to ${imageDigest}`);
  }
  const predicateTypes = boundAttestations.flatMap((descriptor) => (
    predicateTypesForAttestation(imagePath, descriptor)
  ));
  if (!predicateTypes.some((predicate) => predicate.startsWith('https://slsa.dev/provenance/'))) {
    throw new Error(`OCI image archive has no SLSA provenance predicate for ${imageDigest}`);
  }
  if (!predicateTypes.includes('https://spdx.dev/Document')) {
    throw new Error(`OCI image archive has no SPDX SBOM predicate for ${imageDigest}`);
  }
}

export function createContainerBuildReceipt(input: ContainerBuildReceiptInput): ContainerBuildReceipt {
  const { metadata, policy } = assertInput(input);
  return {
    schemaVersion: 1,
    sourceRevision: input.sourceRevision,
    builder: input.builder,
    baseImage: policy.baseImage,
    imageDigest: metadata['containerimage.digest'] as string,
    imageArchiveSha256: sha256File(input.imagePath),
    metadataSha256: sha256File(input.metadataPath),
    sbomSha256: sha256File(input.sbomPath),
    sbomFormat: 'SPDX',
    provenance: 'buildx.build.provenance',
  };
}

export function verifyContainerBuildReceipt(
  receipt: ContainerBuildReceipt,
  input: ContainerBuildReceiptInput,
): void {
  const expected = createContainerBuildReceipt(input);
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) {
    throw new Error('container build receipt does not match the verified build inputs');
  }
}

interface ParsedArgs {
  metadataPath: string;
  sbomPath: string;
  imagePath: string;
  sourceRevision: string;
  builder: string;
  repoRoot: string;
  outputPath?: string;
  receiptPath?: string;
  verifyOciAttestations: boolean;
}

function parseArgs(argv: string[], cwd: string): ParsedArgs {
  const values = new Map<string, string>();
  let verifyOciAttestations = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--verify-oci-attestations') {
      verifyOciAttestations = true;
      continue;
    }
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('usage: verify-container-build-receipt.ts --metadata PATH --sbom PATH --image PATH --source COMMIT --builder ID [--repo-root PATH] (--output PATH | --receipt PATH)');
    }
    values.set(flag, value);
    index += 1;
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (!value) throw new Error(`${flag} is required`);
    return value;
  };
  const outputPath = values.get('--output');
  const receiptPath = values.get('--receipt');
  if (Boolean(outputPath) === Boolean(receiptPath)) {
    throw new Error('provide exactly one of --output or --receipt');
  }
  return {
    metadataPath: required('--metadata'),
    sbomPath: required('--sbom'),
    imagePath: required('--image'),
    sourceRevision: required('--source'),
    builder: required('--builder'),
    repoRoot: values.get('--repo-root') ?? cwd,
    outputPath,
    receiptPath,
    verifyOciAttestations,
  };
}

export function run(argv: string[] = process.argv.slice(2), cwd: string = process.cwd()): ContainerBuildReceipt {
  const args = parseArgs(argv, cwd);
  const input: ContainerBuildReceiptInput = {
    repoRoot: args.repoRoot,
    metadataPath: args.metadataPath,
    sbomPath: args.sbomPath,
    imagePath: args.imagePath,
    sourceRevision: args.sourceRevision,
    builder: args.builder,
  };
  const receipt = createContainerBuildReceipt(input);
  if (args.verifyOciAttestations) verifyOciArchiveAttestations(input.imagePath, receipt.imageDigest);
  if (args.outputPath) {
    writeFileSync(args.outputPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    verifyContainerBuildReceipt(parseJson<ContainerBuildReceipt>(args.outputPath, 'container build receipt'), input);
  } else if (args.receiptPath) {
    verifyContainerBuildReceipt(parseJson<ContainerBuildReceipt>(args.receiptPath, 'container build receipt'), input);
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const receipt = run();
    console.log(`container build receipt verified: ${receipt.imageDigest}`);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
