import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  createContainerBuildReceipt,
  parseArgs,
  verifyContainerBuildReceipt,
  verifyOciArchiveAttestations,
} from '../../scripts/verify-container-build-receipt.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const qualityWorkflow = readFileSync(path.join(repoRoot, '.github/workflows/quality.yml'), 'utf8');
const containerInputs = JSON.parse(
  readFileSync(path.join(repoRoot, 'docker/container-inputs.json'), 'utf8'),
) as {
  platform?: string;
  baseImageDependency?: string;
  baseImageResolvedDigest?: string;
  buildx?: { version?: string; asset?: string; sha256?: string; buildkitImage?: string };
  sbom?: { generator?: string; dependency?: string; resolvedDigest?: string };
};
const tmp = trackTmpDirs('container-build-receipt-');

const SOURCE_REVISION = 'b'.repeat(40);
const PROVENANCE_BUILDER_ID = 'https://github.com/LucasQuiles/WhatSoup/actions/runs/123';
const SOURCE_REPOSITORY = 'https://github.com/LucasQuiles/WhatSoup.git';
const BASE_IMAGE_DIGEST = '152aceace5c03e2597988763165ee33e3fd3633636db0fc983cd2e126b02cfde';
const SBOM_GENERATOR_DIGEST = '187e1892a7752c9384c59aba9517dd8e40610b748c72773e87b63720514463c2';

function sha256(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

function makeReceiptInput(options: {
  provenance?: unknown;
  builder?: string;
  buildxVersion?: string;
  buildkitVersion?: string;
  sourceRepository?: string;
  ociSourceRevision?: string;
  ociSourceRepository?: string;
  ociProvenanceBuilderId?: string;
  ociBaseImageDigest?: string;
  ociSbomGeneratorDigest?: string;
} = {}) {
  const dir = tmp.make('evidence');
  const metadataPath = path.join(dir, 'build-metadata.json');
  const sbomPath = path.join(dir, 'image.spdx.json');
  const imagePath = path.join(dir, 'image.tar');
  const oci = writeOciArchive(imagePath, {
    sourceRevision: options.ociSourceRevision ?? SOURCE_REVISION,
    sourceRepository: options.ociSourceRepository ?? options.sourceRepository,
    provenanceBuilderId: options.ociProvenanceBuilderId,
    baseImageDigest: options.ociBaseImageDigest,
    sbomGeneratorDigest: options.ociSbomGeneratorDigest,
  });
  writeFileSync(metadataPath, JSON.stringify({
    'containerimage.digest': oci.outputDigest,
    'buildx.build.provenance': options.provenance ?? oci.provenance,
  }));
  writeFileSync(sbomPath, JSON.stringify({ spdxVersion: 'SPDX-2.3' }));
  return {
    repoRoot,
    metadataPath,
    sbomPath,
    imagePath,
    sourceRevision: SOURCE_REVISION,
    sourceRepository: options.sourceRepository,
    builder: options.builder ?? 'whatsoup-ci-builder|docker-container',
    buildxVersion: options.buildxVersion ?? 'v0.38.0',
    buildkitVersion: options.buildkitVersion ?? 'v0.33.1',
    provenanceBuilderId: PROVENANCE_BUILDER_ID,
  };
}

interface OciArchiveOptions {
  sourceRevision?: string;
  sourceRepository?: string;
  provenanceBuilderId?: string;
  baseImageDigest?: string;
  sbomGeneratorDigest?: string;
  statementSubjectDigest?: string;
  predicateAnnotation?: string;
  predicateType?: string;
  includeSlsa?: boolean;
  includeSpdx?: boolean;
  corruptAttestationSize?: boolean;
  corruptLayerDigest?: boolean;
  directLayout?: boolean;
  extraOutputDescriptor?: boolean;
  extraRunnableDescriptor?: boolean;
  runnablePlatform?: { os: string; architecture: string };
  attestationPlatform?: { os: string; architecture: string };
}

function writeOciArchive(
  archivePath: string,
  options: OciArchiveOptions = {},
): { imageDigest: string; outputDigest: string; provenance: Record<string, unknown> } {
  const layout = tmp.make('oci-layout');
  const blobs = path.join(layout, 'blobs/sha256');
  mkdirSync(blobs, { recursive: true });
  const writeBlob = (contents: string): { digest: string; size: number } => {
    const bytes = Buffer.from(contents, 'utf8');
    const digest = sha256(bytes);
    writeFileSync(path.join(blobs, digest), bytes);
    return { digest: `sha256:${digest}`, size: bytes.length };
  };

  const runnable = writeBlob(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: `sha256:${'0'.repeat(64)}`, size: 0 },
    layers: [],
  }));
  const imageDigest = runnable.digest;
  const sourceRevision = options.sourceRevision ?? SOURCE_REVISION;
  const provenance = {
    buildDefinition: {
      buildType: 'https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md',
      externalParameters: {
        configSource: {
          uri: `${options.sourceRepository ?? SOURCE_REPOSITORY}#${sourceRevision}`,
          digest: { sha1: sourceRevision },
          path: 'docker/Dockerfile',
        },
      },
      resolvedDependencies: [{
        uri: 'pkg:docker/node@24.15.0-slim?platform=linux%2Famd64',
        digest: { sha256: options.baseImageDigest ?? BASE_IMAGE_DIGEST },
      }, {
        uri: 'pkg:docker/docker/buildkit-syft-scanner@stable-1?platform=linux%2Famd64',
        digest: { sha256: options.sbomGeneratorDigest ?? SBOM_GENERATOR_DIGEST },
      }],
    },
    runDetails: { builder: { id: options.provenanceBuilderId ?? PROVENANCE_BUILDER_ID } },
  };
  const statementSubjectDigest = options.statementSubjectDigest ?? imageDigest.slice('sha256:'.length);
  const statementPredicateType = options.predicateType ?? 'https://slsa.dev/provenance/v1';
  const statement = writeBlob(JSON.stringify({
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: '_', digest: { sha256: statementSubjectDigest } }],
    predicateType: statementPredicateType,
    predicate: provenance,
  }));
  const sbomStatement = writeBlob(JSON.stringify({
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: '_', digest: { sha256: statementSubjectDigest } }],
    predicateType: 'https://spdx.dev/Document',
    predicate: { SPDXID: 'SPDXRef-DOCUMENT', spdxVersion: 'SPDX-2.3', packages: [] },
  }));
  const emptyConfig = writeBlob('{}');
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    artifactType: 'application/vnd.docker.attestation.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.empty.v1+json', ...emptyConfig },
    subject: { mediaType: 'application/vnd.oci.image.manifest.v1+json', ...runnable },
    layers: [
      ...(options.includeSlsa === false ? [] : [{
        mediaType: 'application/vnd.in-toto+json',
        ...statement,
        annotations: { 'in-toto.io/predicate-type': options.predicateAnnotation ?? 'https://slsa.dev/provenance/v1' },
      }]),
      ...(options.includeSpdx === false ? [] : [{
        mediaType: 'application/vnd.in-toto+json',
        digest: options.corruptLayerDigest ? `sha256:${'f'.repeat(64)}` : sbomStatement.digest,
        size: sbomStatement.size,
        annotations: { 'in-toto.io/predicate-type': 'https://spdx.dev/Document' },
      }]),
    ],
  });
  const attestation = writeBlob(manifest);
  const runnableDescriptor = {
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    ...runnable,
    platform: options.runnablePlatform ?? { os: 'linux', architecture: 'amd64' },
  };
  const attestationDescriptor = {
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    digest: attestation.digest,
    size: attestation.size + (options.corruptAttestationSize ? 1 : 0),
    platform: options.attestationPlatform ?? { os: 'unknown', architecture: 'unknown' },
    annotations: {
      'vnd.docker.reference.type': 'attestation-manifest',
      'vnd.docker.reference.digest': imageDigest,
    },
  };
  const outputIndex = writeBlob(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [
      runnableDescriptor,
      ...(options.extraRunnableDescriptor ? [runnableDescriptor] : []),
      attestationDescriptor,
    ],
  }));
  const outputDescriptor = {
    mediaType: 'application/vnd.oci.image.index.v1+json',
    ...outputIndex,
  };
  writeFileSync(path.join(layout, 'index.json'), JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: options.directLayout
      ? [runnableDescriptor, attestationDescriptor]
      : [outputDescriptor, ...(options.extraOutputDescriptor ? [outputDescriptor] : [])],
  }));
  execFileSync('tar', ['-cf', archivePath, '-C', layout, 'index.json', 'blobs']);
  return {
    imageDigest,
    outputDigest: options.directLayout ? imageDigest : outputIndex.digest,
    provenance,
  };
}

describe('container build evidence CI contract', () => {
  it('uses the shared closed-option parser and rejects ambiguous receipt inputs', () => {
    const argv = [
      '--metadata', '/tmp/metadata.json', '--sbom', '/tmp/sbom.json',
      '--image', '/tmp/image.tar', '--source', SOURCE_REVISION,
      '--builder', 'whatsoup-ci-builder|docker-container',
      '--buildx-version', 'v0.38.0', '--buildkit-version', 'v0.33.1',
      '--provenance-builder-id', PROVENANCE_BUILDER_ID, '--output', '/tmp/receipt.json',
    ];

    expect(parseArgs(argv, '/repo')).toMatchObject({
      repoRoot: '/repo',
      metadataPath: '/tmp/metadata.json',
      outputPath: '/tmp/receipt.json',
    });
    expect(() => parseArgs([...argv, '--unknown', 'value'], '/repo')).toThrow(
      'usage: verify-container-build-receipt.ts',
    );
    expect(() => parseArgs([...argv, '--metadata', '/tmp/replacement.json'], '/repo')).toThrow(
      'usage: verify-container-build-receipt.ts',
    );
    expect(() => parseArgs([...argv.slice(0, -1), '--receipt', '/tmp/existing.json'], '/repo')).toThrow(
      'usage: verify-container-build-receipt.ts',
    );
    expect(() => parseArgs([...argv, '--receipt', '/tmp/existing.json'], '/repo')).toThrow(
      'provide exactly one of --output or --receipt',
    );
  });

  it('builds pinned inputs and produces an independently checked evidence bundle', () => {
    expect(qualityWorkflow).toContain('docker buildx build');
    expect(qualityWorkflow).toContain('type=provenance,mode=max,builder-id=$provenance_builder_id');
    expect(qualityWorkflow).toContain('--sbom "generator=$sbom_generator"');
    expect(qualityWorkflow).toContain('BUILDX_METADATA_PROVENANCE: max');
    expect(qualityWorkflow).toContain('--output type=oci');
    expect(containerInputs.platform).toBe('linux/amd64');
    expect(containerInputs.baseImageDependency).toBe('pkg:docker/node@24.15.0-slim?platform=linux%2Famd64');
    expect(containerInputs.baseImageResolvedDigest).toBe(`sha256:${BASE_IMAGE_DIGEST}`);
    expect(containerInputs.buildx).toEqual({
      version: 'v0.38.0',
      asset: 'buildx-v0.38.0.linux-amd64',
      sha256: 'sha256:4fe4cc38adf48169132749b6ca22a990928db0118e3407584ee553723115d287',
      buildkitImage: 'moby/buildkit:v0.33.1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea',
    });
    expect(containerInputs.sbom).toEqual({
      generator: 'docker/buildkit-syft-scanner:stable-1@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9',
      dependency: 'pkg:docker/docker/buildkit-syft-scanner@stable-1?platform=linux%2Famd64',
      resolvedDigest: `sha256:${SBOM_GENERATOR_DIGEST}`,
    });
    expect(qualityWorkflow).toContain('scripts/install-pinned-buildx.ts');
    expect(qualityWorkflow).toContain('DOCKER_CONFIG=$docker_config');
    expect(qualityWorkflow).toContain('docker buildx create');
    expect(qualityWorkflow).toContain('--name "$builder_name"');
    expect(qualityWorkflow).toContain('--driver "$builder_driver"');
    expect(qualityWorkflow).toContain('--driver-opt "image=$buildkit_image"');
    expect(qualityWorkflow).toContain('scripts/verify-buildx-runtime.ts');
    expect(qualityWorkflow).not.toContain("buildx inspect whatsoup-ci-builder --format");
    expect(qualityWorkflow).not.toContain('docker/setup-buildx-action@');
    expect(qualityWorkflow).not.toContain('--load');
    expect(qualityWorkflow).not.toContain('docker image save whatsoup-ci');
    expect(qualityWorkflow).toContain('--metadata-file');
    expect(qualityWorkflow).toContain('"${source_repository}#${SOURCE_REVISION}"');
    expect(qualityWorkflow).toContain('policy.sbom.generator');
    expect(qualityWorkflow).toContain('policy.platform');
    expect(qualityWorkflow).toContain('--platform "$platform"');
    expect(qualityWorkflow).toContain('--provenance-builder-id "$provenance_builder_id"');
    expect(qualityWorkflow).toContain('anchore/sbom-action@66cbf4bc1f1c0d2edc94016e65bc221b6bb0ad6c');
    expect(qualityWorkflow).toContain('scripts/verify-container-build-receipt.ts');
    expect(qualityWorkflow).toContain('container-build-evidence-${{ github.sha }}');
  });

  it('attests only the trusted main branch with a pinned action and isolated permissions', () => {
    expect(qualityWorkflow).toContain('attest-container-build:');
    expect(qualityWorkflow).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(qualityWorkflow).toContain('id-token: write');
    expect(qualityWorkflow).toContain('attestations: write');
    expect(qualityWorkflow).toContain('artifact-metadata: write');
    expect(qualityWorkflow).toContain('actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6');
    expect(qualityWorkflow).toContain('id: reverify-container-evidence');
    expect(qualityWorkflow).toContain('--github-output "$GITHUB_OUTPUT"');
    expect(qualityWorkflow).toContain('subject-name: ghcr.io/lucasquiles/whatsoup');
    expect(qualityWorkflow).toContain('subject-digest: ${{ steps.reverify-container-evidence.outputs.image_digest }}');
  });

  it('binds the source, image digest, SPDX SBOM and non-empty Buildx provenance in the receipt', () => {
    const input = makeReceiptInput();
    const receipt = createContainerBuildReceipt(input);

    expect(receipt.sourceRevision).toBe(input.sourceRevision);
    expect(receipt.sourceRepository).toBe(SOURCE_REPOSITORY);
    expect(receipt.buildxVersion).toBe('v0.38.0');
    expect(receipt.buildkitImage).toBe(
      'moby/buildkit:v0.33.1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea',
    );
    expect(receipt.buildkitVersion).toBe('v0.33.1');
    expect(receipt.schemaVersion).toBe(3);
    expect(receipt.platform).toBe('linux/amd64');
    expect(receipt.baseImageResolvedDigest).toBe(`sha256:${BASE_IMAGE_DIGEST}`);
    expect(receipt.sbomGeneratorResolvedDigest).toBe(`sha256:${SBOM_GENERATOR_DIGEST}`);
    expect(receipt.imageDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.outputDigest).toBe(receipt.imageIndexDigest);
    expect(receipt.outputDigest).not.toBe(receipt.imageDigest);
    expect(receipt.imageIndexDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.slsaStatementSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.spdxStatementSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.sbomFormat).toBe('SPDX');
    expect(receipt.provenance).toBe('in-toto/slsa-v1');
    expect(() => verifyContainerBuildReceipt(receipt, input)).not.toThrow();
  });

  it('binds a reviewed fork pull-request repository to its matching SLSA config source', () => {
    const forkRepository = 'https://github.com/contributor/WhatSoup.git';
    const input = makeReceiptInput({ sourceRepository: forkRepository });
    const receipt = createContainerBuildReceipt(input);

    expect(receipt.sourceRepository).toBe(forkRepository);
    expect(() => verifyContainerBuildReceipt(receipt, input)).not.toThrow();
  });

  it('retains the policy repository when push or merge receipt input omits a source repository', () => {
    const receipt = createContainerBuildReceipt(makeReceiptInput());

    expect(receipt.sourceRepository).toBe(SOURCE_REPOSITORY);
  });

  it('rejects SLSA config source from a different repository than the selected fork', () => {
    expect(() => createContainerBuildReceipt(makeReceiptInput({
      sourceRepository: 'https://github.com/contributor/WhatSoup.git',
      ociSourceRepository: SOURCE_REPOSITORY,
    }))).toThrow('SLSA config source repository does not match the reviewed remote context');
  });

  it('rejects a selected source repository outside canonical GitHub HTTPS clone URLs', () => {
    expect(() => createContainerBuildReceipt(makeReceiptInput({
      sourceRepository: 'https://github.example/contributor/WhatSoup.git',
      ociSourceRepository: 'https://github.example/contributor/WhatSoup.git',
    }))).toThrow('selected source repository must be a canonical GitHub HTTPS clone URL');
  });

  it('selects the pull-request head clone URL while retaining policy input for other GitHub events', () => {
    expect(qualityWorkflow).toContain(
      "SOURCE_REPOSITORY: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.clone_url || '' }}",
    );
    expect(qualityWorkflow).toContain('source_repository="$SOURCE_REPOSITORY"');
    expect(qualityWorkflow).toContain('source_repository="$(node -e \'const policy = require("./docker/container-inputs.json"); process.stdout.write(policy.sourceRepository)\')"');
    expect(qualityWorkflow).toContain('--source-repository "$source_repository"');
  });

  it('refuses an empty Buildx provenance placeholder', () => {
    expect(() => createContainerBuildReceipt(makeReceiptInput({ provenance: {} }))).toThrow(
      'build metadata is missing non-empty buildx.build.provenance',
    );
  });

  it('refuses a builder identity outside the reviewed policy', () => {
    expect(() => createContainerBuildReceipt(makeReceiptInput({ builder: 'unreviewed|docker' }))).toThrow(
      'builder identity does not match docker/container-inputs.json',
    );
  });

  it('refuses a provenance builder identity that is not a workflow run', () => {
    const input = makeReceiptInput();
    expect(() => createContainerBuildReceipt({
      ...input,
      provenanceBuilderId: 'https://github.com/LucasQuiles/WhatSoup/actions/runs/not-a-run',
    })).toThrow('provenance builder id does not identify a GitHub Actions run');
  });

  it('refuses a Buildx client version outside the reviewed policy', () => {
    expect(() => createContainerBuildReceipt(makeReceiptInput({ buildxVersion: 'v0.0.0' }))).toThrow(
      'Buildx version does not match docker/container-inputs.json',
    );
  });

  it('refuses an effective BuildKit server version outside the reviewed policy', () => {
    expect(() => createContainerBuildReceipt(makeReceiptInput({ buildkitVersion: 'v0.0.0' }))).toThrow(
      'BuildKit version does not match docker/container-inputs.json',
    );
  });

  it('requires OCI evidence to retain both BuildKit predicates for the runnable image digest', () => {
    const input = makeReceiptInput();
    const { imageDigest } = writeOciArchive(input.imagePath);
    expect(() => verifyOciArchiveAttestations(input.imagePath, imageDigest)).not.toThrow();

    const missingSbom = makeReceiptInput();
    const missingSbomArchive = writeOciArchive(missingSbom.imagePath, {
      includeSpdx: false,
    });
    expect(() => verifyOciArchiveAttestations(missingSbom.imagePath, imageDigest)).toThrow(
      `OCI image archive has no SPDX SBOM predicate for ${imageDigest}`,
    );

    expect(missingSbomArchive.imageDigest).toBe(imageDigest);

    const missingProvenance = makeReceiptInput();
    const missingProvenanceArchive = writeOciArchive(missingProvenance.imagePath, {
      includeSlsa: false,
    });
    expect(() => verifyOciArchiveAttestations(missingProvenance.imagePath, imageDigest)).toThrow(
      `OCI image archive has no SLSA provenance predicate for ${imageDigest}`,
    );
    expect(missingProvenanceArchive.imageDigest).toBe(imageDigest);
  });

  it('accepts the direct OCI layout form while rejecting ambiguous output and runnable descriptors', () => {
    const direct = makeReceiptInput();
    const directArchive = writeOciArchive(direct.imagePath, { directLayout: true });
    expect(() => verifyOciArchiveAttestations(direct.imagePath, directArchive.outputDigest)).not.toThrow();

    const ambiguousOutput = makeReceiptInput();
    const ambiguousOutputArchive = writeOciArchive(ambiguousOutput.imagePath, { extraOutputDescriptor: true });
    expect(() => verifyOciArchiveAttestations(
      ambiguousOutput.imagePath,
      ambiguousOutputArchive.outputDigest,
    )).toThrow('OCI image archive must contain exactly one output descriptor');

    const ambiguousRunnable = makeReceiptInput();
    const ambiguousRunnableArchive = writeOciArchive(ambiguousRunnable.imagePath, {
      extraRunnableDescriptor: true,
    });
    expect(() => verifyOciArchiveAttestations(
      ambiguousRunnable.imagePath,
      ambiguousRunnableArchive.outputDigest,
    )).toThrow('OCI image archive must contain exactly one runnable image descriptor');
  });

  it('rejects a runnable manifest outside the pinned linux/amd64 platform', () => {
    const input = makeReceiptInput();
    const archive = writeOciArchive(input.imagePath, {
      runnablePlatform: { os: 'linux', architecture: 'arm64' },
    });

    expect(() => verifyOciArchiveAttestations(input.imagePath, archive.outputDigest)).toThrow(
      'runnable image descriptor platform does not match linux/amd64',
    );
  });

  it('rejects an attestation descriptor presented as a runnable platform', () => {
    const input = makeReceiptInput();
    const archive = writeOciArchive(input.imagePath, {
      attestationPlatform: { os: 'linux', architecture: 'amd64' },
    });

    expect(() => verifyOciArchiveAttestations(input.imagePath, archive.outputDigest)).toThrow(
      'OCI image archive attestation descriptor platform is not unknown/unknown',
    );
  });

  it('rejects a forged predicate annotation that disagrees with its in-toto statement', () => {
    const input = makeReceiptInput();
    const { imageDigest } = writeOciArchive(input.imagePath, {
      predicateAnnotation: 'https://spdx.dev/Document',
      predicateType: 'https://slsa.dev/provenance/v1',
    });

    expect(() => verifyOciArchiveAttestations(input.imagePath, imageDigest)).toThrow(
      'OCI image archive attestation layer predicate annotation does not match statement payload',
    );
  });

  it('rejects a mismatched attestation descriptor size and layer digest', () => {
    const sizeMismatch = makeReceiptInput();
    const { imageDigest } = writeOciArchive(sizeMismatch.imagePath, { corruptAttestationSize: true });
    expect(() => verifyOciArchiveAttestations(sizeMismatch.imagePath, imageDigest)).toThrow(
      'OCI descriptor size does not match blob',
    );

    const digestMismatch = makeReceiptInput();
    const digestArchive = writeOciArchive(digestMismatch.imagePath, { corruptLayerDigest: true });
    expect(() => verifyOciArchiveAttestations(digestMismatch.imagePath, digestArchive.imageDigest)).toThrow(
      'OCI image archive is missing blobs/sha256/',
    );
  });

  it('rejects an in-toto statement whose subject is not the runnable image manifest', () => {
    const input = makeReceiptInput();
    const { imageDigest } = writeOciArchive(input.imagePath, {
      statementSubjectDigest: 'c'.repeat(64),
    });

    expect(() => verifyOciArchiveAttestations(input.imagePath, imageDigest)).toThrow(
      'in-toto statement subject is not bound to runnable image manifest',
    );
  });

  it('requires the SLSA config source revision to match the verified remote context', () => {
    const input = makeReceiptInput({ ociSourceRevision: 'c'.repeat(40) });

    expect(() => createContainerBuildReceipt(input)).toThrow(
      'SLSA config source revision does not match requested source revision',
    );
  });

  it('requires the reviewed source repository, builder invocation, and base-image dependency', () => {
    expect(() => createContainerBuildReceipt(makeReceiptInput({
      ociSourceRepository: 'https://github.com/example/other.git',
    }))).toThrow('SLSA config source repository does not match the reviewed remote context');
    expect(() => createContainerBuildReceipt(makeReceiptInput({
      ociProvenanceBuilderId: 'https://github.com/LucasQuiles/WhatSoup/actions/runs/999',
    }))).toThrow('SLSA provenance builder id does not match the reviewed workflow invocation');
    expect(() => createContainerBuildReceipt(makeReceiptInput({
      ociBaseImageDigest: 'f'.repeat(64),
    }))).toThrow('SLSA provenance does not bind the reviewed selected-platform base image dependency');
  });

  it('requires the reviewed selected-platform SBOM generator dependency', () => {
    expect(() => createContainerBuildReceipt(makeReceiptInput({
      ociSbomGeneratorDigest: 'f'.repeat(64),
    }))).toThrow('SLSA provenance does not bind the reviewed SBOM generator digest');
  });

  it('rejects metadata, image, and SBOM byte changes after receipt creation', () => {
    const metadataInput = makeReceiptInput();
    const metadataReceipt = createContainerBuildReceipt(metadataInput);
    writeFileSync(metadataInput.metadataPath, JSON.stringify({
      'containerimage.digest': `sha256:${'c'.repeat(64)}`,
      'buildx.build.provenance': { buildType: 'changed' },
    }));
    expect(() => verifyContainerBuildReceipt(metadataReceipt, metadataInput)).toThrow(
      'build metadata output digest does not match the verified OCI output',
    );

    const imageInput = makeReceiptInput();
    const imageReceipt = createContainerBuildReceipt(imageInput);
    writeFileSync(imageInput.imagePath, 'changed-container-image');
    expect(() => verifyContainerBuildReceipt(imageReceipt, imageInput)).toThrow(
      'OCI image archive is missing index.json',
    );

    const sbomInput = makeReceiptInput();
    const sbomReceipt = createContainerBuildReceipt(sbomInput);
    writeFileSync(sbomInput.sbomPath, JSON.stringify({ spdxVersion: 'SPDX-2.3', packages: [] }));
    expect(() => verifyContainerBuildReceipt(sbomReceipt, sbomInput)).toThrow(
      'container build receipt does not match the verified build inputs',
    );
  });

  it('rejects source and builder substitution after receipt creation', () => {
    const input = makeReceiptInput();
    const receipt = createContainerBuildReceipt(input);

    expect(() => verifyContainerBuildReceipt(receipt, {
      ...input,
      sourceRevision: 'c'.repeat(40),
    })).toThrow('SLSA config source revision does not match requested source revision');
    expect(() => verifyContainerBuildReceipt(receipt, {
      ...input,
      builder: 'unreviewed|docker',
    })).toThrow('builder identity does not match docker/container-inputs.json');
  });
});
