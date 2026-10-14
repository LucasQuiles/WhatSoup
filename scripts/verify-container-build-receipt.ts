import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface ContainerInputPolicy {
  schemaVersion: number;
  platform: string;
  sourceRepository: string;
  baseImage: string;
  baseImageDependency: string;
  baseImageResolvedDigest: string;
  builder: { name: string; driver: string; provenanceIdPrefix: string };
  buildx: { version: string; asset: string; sha256: string; buildkitImage: string };
  sbom: { generator: string; dependency: string; resolvedDigest: string };
}

interface BuildMetadata {
  'containerimage.digest'?: unknown;
  'buildx.build.provenance'?: unknown;
}

interface SbomDocument { spdxVersion?: unknown }

export interface ContainerBuildReceiptInput {
  repoRoot: string;
  metadataPath: string;
  sbomPath: string;
  imagePath: string;
  sourceRevision: string;
  sourceRepository?: string;
  builder: string;
  buildxVersion: string;
  buildkitVersion: string;
  provenanceBuilderId: string;
}

export interface ContainerBuildReceipt {
  schemaVersion: 3;
  sourceRevision: string;
  sourceRepository: string;
  platform: 'linux/amd64';
  builder: string;
  provenanceBuilderId: string;
  buildxVersion: string;
  buildkitImage: string;
  buildkitVersion: string;
  baseImage: string;
  baseImageDependency: string;
  baseImageResolvedDigest: string;
  sbomGenerator: string;
  sbomGeneratorDependency: string;
  sbomGeneratorResolvedDigest: string;
  outputDigest: string;
  imageIndexDigest: string;
  imageDigest: string;
  imageManifestSize: number;
  imageArchiveSha256: string;
  metadataSha256: string;
  sbomSha256: string;
  slsaStatementSha256: string;
  spdxStatementSha256: string;
  sbomFormat: 'SPDX';
  provenance: 'in-toto/slsa-v1';
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const BUILDER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const BUILDX_VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;
const BUILDKIT_IMAGE_PATTERN = /^moby\/buildkit:v\d+\.\d+\.\d+@sha256:[a-f0-9]{64}$/;
const SBOM_GENERATOR_IMAGE_PATTERN = /^docker\/buildkit-syft-scanner:stable-1@sha256:[a-f0-9]{64}$/;
const SOURCE_REPOSITORY_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/;
const PLATFORM = 'linux/amd64';
const BASE_IMAGE_DEPENDENCY = 'pkg:docker/node@24.15.0-slim?platform=linux%2Famd64';
const SBOM_GENERATOR_DEPENDENCY = 'pkg:docker/docker/buildkit-syft-scanner@stable-1?platform=linux%2Famd64';
const OCI_IMAGE_INDEX_MEDIA_TYPE = 'application/vnd.oci.image.index.v1+json';
const OCI_IMAGE_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const OCI_ATTESTATION_ARTIFACT_TYPE = 'application/vnd.docker.attestation.manifest.v1+json';
const IN_TOTO_MEDIA_TYPE = 'application/vnd.in-toto+json';
const IN_TOTO_STATEMENT_V1 = 'https://in-toto.io/Statement/v1';
const SLSA_V1_PREDICATE = 'https://slsa.dev/provenance/v1';
const SPDX_PREDICATE = 'https://spdx.dev/Document';
const BUILDKIT_SLSA_V1_BUILD_TYPE = 'https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md';

interface OciDescriptor {
  mediaType?: unknown;
  digest?: unknown;
  size?: unknown;
  annotations?: unknown;
  platform?: unknown;
}

interface OciIndex { schemaVersion?: unknown; mediaType?: unknown; manifests?: unknown }
interface OciManifest { schemaVersion?: unknown; mediaType?: unknown; artifactType?: unknown; subject?: unknown; layers?: unknown }
interface InTotoStatement { _type?: unknown; subject?: unknown; predicateType?: unknown; predicate?: unknown }

interface OciVerificationExpectation {
  sourceRevision: string;
  sourceRepository: string;
  provenanceBuilderId: string;
  baseImageDependency: string;
  baseImageResolvedDigest: string;
  sbomGeneratorDependency: string;
  sbomGeneratorResolvedDigest: string;
  buildxProvenance: unknown;
}

interface OciVerificationResult {
  outputDigest: string;
  imageIndexDigest: string;
  imageDigest: string;
  imageManifestSize: number;
  slsaStatementSha256: string;
  spdxStatementSha256: string;
}

function sha256(contents: Buffer): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

function sha256File(filePath: string): string {
  return sha256(readFileSync(filePath));
}

function parseJsonBytes<T>(bytes: Buffer, label: string): T {
  try {
    return JSON.parse(bytes.toString('utf8')) as T;
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
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
  try { stat = statSync(filePath); } catch { throw new Error(`${label} is missing: ${filePath}`); }
  if (!stat.isFile()) throw new Error(`${label} must be a regular file: ${filePath}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function loadPolicy(repoRoot: string): ContainerInputPolicy {
  const policyPath = path.join(repoRoot, 'docker/container-inputs.json');
  const policy = parseJson<ContainerInputPolicy>(policyPath, 'container input policy');
  if (
    policy.schemaVersion !== 3
    || policy.platform !== PLATFORM
    || typeof policy.sourceRepository !== 'string'
    || !SOURCE_REPOSITORY_PATTERN.test(policy.sourceRepository)
    || typeof policy.baseImage !== 'string'
    || !SHA256_PATTERN.test(policy.baseImage.slice(policy.baseImage.indexOf('@') + 1))
    || policy.baseImageDependency !== BASE_IMAGE_DEPENDENCY
    || !SHA256_PATTERN.test(policy.baseImageResolvedDigest)
    || !policy.builder
    || !BUILDER_NAME_PATTERN.test(policy.builder.name)
    || policy.builder.driver !== 'docker-container'
    || policy.builder.provenanceIdPrefix !== `${policy.sourceRepository.slice(0, -'.git'.length)}/actions/runs/`
    || !policy.buildx
    || !BUILDX_VERSION_PATTERN.test(policy.buildx.version)
    || policy.buildx.asset !== `buildx-${policy.buildx.version}.linux-amd64`
    || !SHA256_PATTERN.test(policy.buildx.sha256)
    || !BUILDKIT_IMAGE_PATTERN.test(policy.buildx.buildkitImage)
    || !policy.sbom
    || !SBOM_GENERATOR_IMAGE_PATTERN.test(policy.sbom.generator)
    || policy.sbom.dependency !== SBOM_GENERATOR_DEPENDENCY
    || !SHA256_PATTERN.test(policy.sbom.resolvedDigest)
  ) throw new Error(`container input policy has an invalid source, base image, or builder: ${policyPath}`);
  return policy;
}

function expectedBuilderIdentity(policy: ContainerInputPolicy): string {
  return `${policy.builder.name}|${policy.builder.driver}`;
}

function expectedBuildkitVersion(policy: ContainerInputPolicy): string {
  const match = /^moby\/buildkit:(v\d+\.\d+\.\d+)@sha256:[a-f0-9]{64}$/.exec(policy.buildx.buildkitImage);
  if (!match?.[1]) throw new Error('container input policy has an invalid BuildKit image version');
  return match[1];
}

function selectedSourceRepository(policy: ContainerInputPolicy, sourceRepository?: string): string {
  const selected = sourceRepository ?? policy.sourceRepository;
  if (!SOURCE_REPOSITORY_PATTERN.test(selected)) {
    throw new Error('selected source repository must be a canonical GitHub HTTPS clone URL');
  }
  return selected;
}

function readOciArchiveEntry(archivePath: string, entry: string): Buffer {
  for (const candidate of [entry, `./${entry}`]) {
    try {
      return execFileSync('tar', ['-xOf', archivePath, candidate], {
        stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000, maxBuffer: 96 * 1024 * 1024,
      });
    } catch { /* OCI exporters differ on a leading ./ prefix. */ }
  }
  throw new Error(`OCI image archive is missing ${entry}: ${archivePath}`);
}

function annotations(descriptor: OciDescriptor): Record<string, unknown> {
  return isRecord(descriptor.annotations) ? descriptor.annotations : {};
}

function descriptorPlatform(descriptor: OciDescriptor): Record<string, unknown> {
  return isRecord(descriptor.platform) ? descriptor.platform : {};
}

function requireDescriptorArray(value: unknown, label: string): OciDescriptor[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isRecord)) {
    throw new Error(`${label} must contain at least one complete OCI descriptor`);
  }
  return value as OciDescriptor[];
}

function descriptorDigest(descriptor: OciDescriptor, label: string): string {
  if (typeof descriptor.digest !== 'string' || !SHA256_PATTERN.test(descriptor.digest)) throw new Error(`${label} has an invalid OCI descriptor digest`);
  return descriptor.digest;
}

function descriptorSize(descriptor: OciDescriptor, label: string): number {
  if (!Number.isSafeInteger(descriptor.size) || (descriptor.size as number) < 0) throw new Error(`${label} has an invalid OCI descriptor size`);
  return descriptor.size as number;
}

function readVerifiedDescriptorBlob(archivePath: string, descriptor: OciDescriptor, label: string): Buffer {
  const digest = descriptorDigest(descriptor, label);
  const bytes = readOciArchiveEntry(archivePath, `blobs/sha256/${digest.slice('sha256:'.length)}`);
  if (bytes.length !== descriptorSize(descriptor, label)) throw new Error(`OCI descriptor size does not match blob: ${label}`);
  if (sha256(bytes) !== digest) throw new Error(`OCI descriptor SHA-256 does not match blob: ${label}`);
  return bytes;
}

function assertStatementSubject(statement: InTotoStatement, imageDigest: string): void {
  if (statement._type !== IN_TOTO_STATEMENT_V1 || !Array.isArray(statement.subject) || statement.subject.length === 0) {
    throw new Error('OCI image archive attestation layer is not a complete in-toto Statement v1');
  }
  const expected = imageDigest.slice('sha256:'.length);
  for (const subject of statement.subject) {
    if (!isRecord(subject) || !isRecord(subject.digest) || subject.digest.sha256 !== expected) {
      throw new Error('in-toto statement subject is not bound to runnable image manifest');
    }
  }
}

function assertSpdxPredicate(predicate: unknown): void {
  if (!isRecord(predicate) || typeof predicate.spdxVersion !== 'string' || predicate.spdxVersion.length === 0) {
    throw new Error('SPDX in-toto predicate is missing a valid SPDX document');
  }
}

function hasResolvedDependency(
  dependencies: unknown[],
  expectedUri: string,
  expectedDigest: string,
): boolean {
  const expected = expectedDigest.slice('sha256:'.length);
  return dependencies.some((dependency) => (
    isRecord(dependency)
    && dependency.uri === expectedUri
    && isRecord(dependency.digest)
    && dependency.digest.sha256 === expected
  ));
}

function assertSlsaPredicate(predicate: unknown, expected: OciVerificationExpectation): void {
  if (!isRecord(predicate) || !isRecord(predicate.buildDefinition) || !isRecord(predicate.runDetails)) {
    throw new Error('SLSA provenance predicate is missing build definition or run details');
  }
  const buildDefinition = predicate.buildDefinition;
  const runDetails = predicate.runDetails;
  if (buildDefinition.buildType !== BUILDKIT_SLSA_V1_BUILD_TYPE) throw new Error('SLSA provenance build type is not the reviewed BuildKit v1 definition');
  if (!isRecord(buildDefinition.externalParameters) || !isRecord(buildDefinition.externalParameters.configSource)) throw new Error('SLSA provenance predicate is missing config source');
  const configSource = buildDefinition.externalParameters.configSource;
  if (!isRecord(configSource.digest) || configSource.digest.sha1 !== expected.sourceRevision) throw new Error('SLSA config source revision does not match requested source revision');
  if (configSource.uri !== `${expected.sourceRepository}#${expected.sourceRevision}`) throw new Error('SLSA config source repository does not match the reviewed remote context');
  if (configSource.path !== 'docker/Dockerfile') throw new Error('SLSA config source path is not docker/Dockerfile');
  if (!Array.isArray(buildDefinition.resolvedDependencies) || !hasResolvedDependency(
    buildDefinition.resolvedDependencies,
    expected.baseImageDependency,
    expected.baseImageResolvedDigest,
  )) throw new Error('SLSA provenance does not bind the reviewed selected-platform base image dependency');
  if (!hasResolvedDependency(
    buildDefinition.resolvedDependencies,
    expected.sbomGeneratorDependency,
    expected.sbomGeneratorResolvedDigest,
  )) throw new Error('SLSA provenance does not bind the reviewed SBOM generator digest');
  if (!isRecord(runDetails.builder) || runDetails.builder.id !== expected.provenanceBuilderId) {
    throw new Error('SLSA provenance builder id does not match the reviewed workflow invocation');
  }
}

/**
 * Verifies OCI descriptor bytes before using the selected in-toto statements.
 * BuildKit considers VCS hints from local contexts advisory, so receipt callers
 * supply source facts from an exact full-SHA remote Git context.
 */
export function verifyOciArchiveAttestations(
  imagePath: string,
  expectedOutputDigest: string,
  expected?: OciVerificationExpectation,
): OciVerificationResult {
  if (!SHA256_PATTERN.test(expectedOutputDigest)) throw new Error('expected OCI output digest must be a SHA-256 digest');
  const indexBytes = readOciArchiveEntry(imagePath, 'index.json');
  const index = parseJsonBytes<OciIndex>(indexBytes, `OCI image archive index.json: ${imagePath}`);
  if (index.schemaVersion !== 2 || (index.mediaType !== undefined && index.mediaType !== OCI_IMAGE_INDEX_MEDIA_TYPE)) {
    throw new Error(`OCI image archive has invalid index.json: ${imagePath}`);
  }
  const rootDescriptors = requireDescriptorArray(index.manifests, 'OCI image archive index.json');
  const nestedOutputDescriptors = rootDescriptors.filter((descriptor) => descriptor.mediaType === OCI_IMAGE_INDEX_MEDIA_TYPE);
  let descriptors = rootDescriptors;
  let imageIndexDigest = sha256(indexBytes);
  if (nestedOutputDescriptors.length > 0) {
    if (rootDescriptors.length !== 1 || nestedOutputDescriptors.length !== 1) {
      throw new Error(`OCI image archive must contain exactly one output descriptor: ${imagePath}`);
    }
    const outputDescriptor = nestedOutputDescriptors[0];
    imageIndexDigest = descriptorDigest(outputDescriptor, 'OCI output index descriptor');
    const outputIndexBytes = readVerifiedDescriptorBlob(imagePath, outputDescriptor, 'OCI output index descriptor');
    const outputIndex = parseJsonBytes<OciIndex>(outputIndexBytes, 'OCI output image index');
    if (outputIndex.schemaVersion !== 2 || outputIndex.mediaType !== OCI_IMAGE_INDEX_MEDIA_TYPE) {
      throw new Error('OCI output descriptor does not reference an OCI image index');
    }
    descriptors = requireDescriptorArray(outputIndex.manifests, 'OCI output image index');
  }
  const attestationDescriptors = descriptors.filter((descriptor) => annotations(descriptor)['vnd.docker.reference.type'] === 'attestation-manifest');
  const runnableDescriptors = descriptors.filter((descriptor) => !attestationDescriptors.includes(descriptor));
  if (runnableDescriptors.length !== 1) throw new Error(`OCI image archive must contain exactly one runnable image descriptor: ${imagePath}`);
  const runnable = runnableDescriptors[0];
  if (runnable.mediaType !== OCI_IMAGE_MANIFEST_MEDIA_TYPE) throw new Error('runnable image descriptor has an unexpected media type');
  const platform = descriptorPlatform(runnable);
  if (platform.os !== 'linux' || platform.architecture !== 'amd64') {
    throw new Error('runnable image descriptor platform does not match linux/amd64');
  }
  const imageDigest = descriptorDigest(runnable, 'runnable image descriptor');
  const imageManifestBytes = readVerifiedDescriptorBlob(imagePath, runnable, 'runnable image descriptor');
  const manifest = parseJsonBytes<Record<string, unknown>>(imageManifestBytes, 'runnable image manifest');
  if (manifest.schemaVersion !== 2 || manifest.mediaType !== OCI_IMAGE_MANIFEST_MEDIA_TYPE) throw new Error('runnable image descriptor does not reference an OCI image manifest');
  if (expectedOutputDigest !== imageDigest && expectedOutputDigest !== imageIndexDigest) throw new Error('build metadata output digest does not match the verified OCI output');
  if (attestationDescriptors.length === 0) throw new Error(`OCI image archive has no BuildKit attestation manifest: ${imagePath}`);

  let slsaStatementSha256: string | undefined;
  let spdxStatementSha256: string | undefined;
  for (const descriptor of attestationDescriptors) {
    if (annotations(descriptor)['vnd.docker.reference.digest'] !== imageDigest) continue;
    if (descriptor.mediaType !== OCI_IMAGE_MANIFEST_MEDIA_TYPE) throw new Error('OCI image archive attestation descriptor has an unexpected media type');
    const attestationPlatform = descriptorPlatform(descriptor);
    if (attestationPlatform.os !== 'unknown' || attestationPlatform.architecture !== 'unknown') {
      throw new Error('OCI image archive attestation descriptor platform is not unknown/unknown');
    }
    const attestationBytes = readVerifiedDescriptorBlob(imagePath, descriptor, 'attestation manifest descriptor');
    const attestation = parseJsonBytes<OciManifest>(attestationBytes, 'OCI image archive attestation manifest');
    if (attestation.schemaVersion !== 2 || attestation.mediaType !== OCI_IMAGE_MANIFEST_MEDIA_TYPE || attestation.artifactType !== OCI_ATTESTATION_ARTIFACT_TYPE || !isRecord(attestation.subject)) {
      throw new Error('OCI image archive has an invalid attestation manifest');
    }
    if (descriptorDigest(attestation.subject as OciDescriptor, 'attestation manifest subject') !== imageDigest || descriptorSize(attestation.subject as OciDescriptor, 'attestation manifest subject') !== descriptorSize(runnable, 'runnable image descriptor')) {
      throw new Error('OCI image archive attestation manifest is not bound to runnable image descriptor');
    }
    if (!Array.isArray(attestation.layers)) throw new Error('OCI image archive attestation manifest has no layers');
    for (const layer of attestation.layers) {
      if (!isRecord(layer) || layer.mediaType !== IN_TOTO_MEDIA_TYPE) continue;
      const layerDescriptor = layer as OciDescriptor;
      const layerBytes = readVerifiedDescriptorBlob(imagePath, layerDescriptor, 'attestation layer descriptor');
      const statement = parseJsonBytes<InTotoStatement>(layerBytes, 'OCI image archive in-toto statement');
      assertStatementSubject(statement, imageDigest);
      if (typeof statement.predicateType !== 'string' || annotations(layerDescriptor)['in-toto.io/predicate-type'] !== statement.predicateType) {
        throw new Error('OCI image archive attestation layer predicate annotation does not match statement payload');
      }
      if (statement.predicateType === SLSA_V1_PREDICATE) {
        if (expected) {
          assertSlsaPredicate(statement.predicate, expected);
          if (stableJson(expected.buildxProvenance) !== stableJson(statement.predicate)) throw new Error('Buildx metadata provenance does not match verified SLSA statement');
        }
        slsaStatementSha256 = sha256(layerBytes);
      }
      if (statement.predicateType === SPDX_PREDICATE) {
        assertSpdxPredicate(statement.predicate);
        spdxStatementSha256 = sha256(layerBytes);
      }
    }
  }
  if (!slsaStatementSha256) throw new Error(`OCI image archive has no SLSA provenance predicate for ${imageDigest}`);
  if (!spdxStatementSha256) throw new Error(`OCI image archive has no SPDX SBOM predicate for ${imageDigest}`);
  return {
    outputDigest: expectedOutputDigest,
    imageIndexDigest,
    imageDigest,
    imageManifestSize: descriptorSize(runnable, 'runnable image descriptor'),
    slsaStatementSha256,
    spdxStatementSha256,
  };
}

function assertInput(input: ContainerBuildReceiptInput): {
  metadata: BuildMetadata;
  sbom: SbomDocument;
  policy: ContainerInputPolicy;
  sourceRepository: string;
  oci: OciVerificationResult;
} {
  if (!COMMIT_PATTERN.test(input.sourceRevision)) throw new Error(`source revision must be a full 40-hex commit: ${input.sourceRevision}`);
  requireRegularFile(input.metadataPath, 'build metadata');
  requireRegularFile(input.sbomPath, 'SBOM');
  requireRegularFile(input.imagePath, 'image archive');
  const metadata = parseJson<BuildMetadata>(input.metadataPath, 'build metadata');
  if (typeof metadata['containerimage.digest'] !== 'string' || !SHA256_PATTERN.test(metadata['containerimage.digest'])) throw new Error('build metadata is missing a valid containerimage.digest');
  if (!isRecord(metadata['buildx.build.provenance']) || Object.keys(metadata['buildx.build.provenance']).length === 0) {
    throw new Error('build metadata is missing non-empty buildx.build.provenance');
  }
  const sbom = parseJson<SbomDocument>(input.sbomPath, 'SBOM');
  if (typeof sbom.spdxVersion !== 'string' || sbom.spdxVersion.length === 0) throw new Error('SBOM must be SPDX JSON');
  const policy = loadPolicy(input.repoRoot);
  const sourceRepository = selectedSourceRepository(policy, input.sourceRepository);
  if (input.builder !== expectedBuilderIdentity(policy)) throw new Error('builder identity does not match docker/container-inputs.json');
  if (input.buildxVersion !== policy.buildx.version) throw new Error('Buildx version does not match docker/container-inputs.json');
  if (input.buildkitVersion !== expectedBuildkitVersion(policy)) throw new Error('BuildKit version does not match docker/container-inputs.json');
  if (!input.provenanceBuilderId.startsWith(policy.builder.provenanceIdPrefix)) throw new Error('provenance builder id does not match docker/container-inputs.json');
  if (!/^\d+$/.test(input.provenanceBuilderId.slice(policy.builder.provenanceIdPrefix.length))) {
    throw new Error('provenance builder id does not identify a GitHub Actions run');
  }
  const oci = verifyOciArchiveAttestations(input.imagePath, metadata['containerimage.digest'], {
    sourceRevision: input.sourceRevision,
    sourceRepository,
    provenanceBuilderId: input.provenanceBuilderId,
    baseImageDependency: policy.baseImageDependency,
    baseImageResolvedDigest: policy.baseImageResolvedDigest,
    sbomGeneratorDependency: policy.sbom.dependency,
    sbomGeneratorResolvedDigest: policy.sbom.resolvedDigest,
    buildxProvenance: metadata['buildx.build.provenance'],
  });
  return { metadata, sbom, policy, sourceRepository, oci };
}

export function createContainerBuildReceipt(input: ContainerBuildReceiptInput): ContainerBuildReceipt {
  const { metadata, policy, sourceRepository, oci } = assertInput(input);
  return {
    schemaVersion: 3,
    sourceRevision: input.sourceRevision,
    sourceRepository,
    platform: PLATFORM,
    builder: input.builder,
    provenanceBuilderId: input.provenanceBuilderId,
    buildxVersion: input.buildxVersion,
    buildkitImage: policy.buildx.buildkitImage,
    buildkitVersion: input.buildkitVersion,
    baseImage: policy.baseImage,
    baseImageDependency: policy.baseImageDependency,
    baseImageResolvedDigest: policy.baseImageResolvedDigest,
    sbomGenerator: policy.sbom.generator,
    sbomGeneratorDependency: policy.sbom.dependency,
    sbomGeneratorResolvedDigest: policy.sbom.resolvedDigest,
    outputDigest: metadata['containerimage.digest'] as string,
    imageIndexDigest: oci.imageIndexDigest,
    imageDigest: oci.imageDigest,
    imageManifestSize: oci.imageManifestSize,
    imageArchiveSha256: sha256File(input.imagePath),
    metadataSha256: sha256File(input.metadataPath),
    sbomSha256: sha256File(input.sbomPath),
    slsaStatementSha256: oci.slsaStatementSha256,
    spdxStatementSha256: oci.spdxStatementSha256,
    sbomFormat: 'SPDX',
    provenance: 'in-toto/slsa-v1',
  };
}

export function verifyContainerBuildReceipt(receipt: ContainerBuildReceipt, input: ContainerBuildReceiptInput): void {
  if (stableJson(receipt) !== stableJson(createContainerBuildReceipt(input))) throw new Error('container build receipt does not match the verified build inputs');
}

interface ParsedArgs {
  metadataPath: string;
  sbomPath: string;
  imagePath: string;
  sourceRevision: string;
  sourceRepository?: string;
  builder: string;
  buildxVersion: string;
  buildkitVersion: string;
  provenanceBuilderId: string;
  repoRoot: string;
  outputPath?: string;
  receiptPath?: string;
  githubOutputPath?: string;
}

function parseArgs(argv: string[], cwd: string): ParsedArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error('usage: verify-container-build-receipt.ts --metadata PATH --sbom PATH --image PATH --source COMMIT --builder ID --buildx-version VERSION --buildkit-version VERSION --provenance-builder-id ID [--source-repository HTTPS_GITHUB_CLONE_URL] [--repo-root PATH] [--github-output PATH] (--output PATH | --receipt PATH)');
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
  if (Boolean(outputPath) === Boolean(receiptPath)) throw new Error('provide exactly one of --output or --receipt');
  return {
    metadataPath: required('--metadata'), sbomPath: required('--sbom'), imagePath: required('--image'),
    sourceRevision: required('--source'), sourceRepository: values.get('--source-repository'), builder: required('--builder'), buildxVersion: required('--buildx-version'),
    buildkitVersion: required('--buildkit-version'), provenanceBuilderId: required('--provenance-builder-id'),
    repoRoot: values.get('--repo-root') ?? cwd, outputPath, receiptPath, githubOutputPath: values.get('--github-output'),
  };
}

export function run(argv: string[] = process.argv.slice(2), cwd: string = process.cwd()): ContainerBuildReceipt {
  const args = parseArgs(argv, cwd);
  const input: ContainerBuildReceiptInput = {
    repoRoot: args.repoRoot, metadataPath: args.metadataPath, sbomPath: args.sbomPath, imagePath: args.imagePath,
    sourceRevision: args.sourceRevision, sourceRepository: args.sourceRepository, builder: args.builder, buildxVersion: args.buildxVersion,
    buildkitVersion: args.buildkitVersion, provenanceBuilderId: args.provenanceBuilderId,
  };
  const receipt = createContainerBuildReceipt(input);
  if (args.outputPath) {
    writeFileSync(args.outputPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    verifyContainerBuildReceipt(parseJson<ContainerBuildReceipt>(args.outputPath, 'container build receipt'), input);
  } else if (args.receiptPath) {
    verifyContainerBuildReceipt(parseJson<ContainerBuildReceipt>(args.receiptPath, 'container build receipt'), input);
  }
  if (args.githubOutputPath) appendFileSync(args.githubOutputPath, `image_digest=${receipt.imageDigest}\nexternal_sbom_sha256=${receipt.sbomSha256}\n`, 'utf8');
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(`container build receipt verified: ${run().imageDigest}`); } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
