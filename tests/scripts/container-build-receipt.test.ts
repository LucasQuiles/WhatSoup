import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import {
  createContainerBuildReceipt,
  parseArgs,
  run,
  sha256File,
  verifyContainerBuildReceipt,
  verifyOciArchiveAttestations,
} from '../../scripts/verify-container-build-receipt.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const qualityWorkflow = readFileSync(path.join(repoRoot, '.github/workflows/quality.yml'), 'utf8');
it('allows bounded slow container, coverage and browser work to finish within the job deadline', () => {
  const workflow = parse(qualityWorkflow) as {
    jobs: { quality: { 'timeout-minutes': number; steps: { name: string; 'timeout-minutes'?: number; env?: Record<string, string> }[] } };
  };
  const job = workflow.jobs.quality;
  const step = (name: string) => {
    const found = job.steps.find((entry) => entry.name === name);
    expect(found, name).toBeDefined();
    return found!;
  };
  const build = step('Build Docker deployment image')['timeout-minutes']!;
  const runtime = step('Load verified deployment image and runtime providers')['timeout-minutes']!;
  const coverage = Number(step('Test suite + coverage thresholds').env?.WHATSOUP_FULL_SUITE_BATTERY_TIMEOUT_MS) / 60_000;
  const system = step('Install Playwright system deps')['timeout-minutes']!;
  const download = step('Install Playwright chromium')['timeout-minutes']!;
  const otherStepsAllowance = 15;
  const slowSuccessfulRun = build + runtime + coverage + system + download + otherStepsAllowance;
  expect([build, runtime, coverage, system, download].every((value) => Number.isFinite(value) && value > 0)).toBe(true);
  expect(job['timeout-minutes']).toBe(100);
  expect(slowSuccessfulRun).toBe(97);
  expect(job['timeout-minutes'] - slowSuccessfulRun).toBe(3);
  expect(slowSuccessfulRun).toBeGreaterThan(60);
});

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
const BASE_IMAGE_INPUT_DIGEST = '4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d';
const BASE_IMAGE_DIGEST = BASE_IMAGE_INPUT_DIGEST;
const SBOM_GENERATOR_INPUT_DIGEST = 'ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9';
const SBOM_GENERATOR_DIGEST = SBOM_GENERATOR_INPUT_DIGEST;
const BASE_IMAGE_DEPENDENCY = `pkg:docker/node@24.15.0-slim?digest=sha256:${BASE_IMAGE_INPUT_DIGEST}&platform=linux%2Famd64`;
const SBOM_GENERATOR_DEPENDENCY = `pkg:docker/docker/buildkit-syft-scanner@stable-1?digest=sha256:${SBOM_GENERATOR_INPUT_DIGEST}&platform=linux%2Famd64`;

function sha256(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

// The default fixture layer is a real gzip blob whose uncompressed bytes the config names as its diff_id.
const LAYER_CONTENT = 'uncompressed-layer-bytes';
const LAYER_DIFF_ID = `sha256:${sha256(LAYER_CONTENT)}`;

function makeReceiptInput(options: {
  provenance?: unknown;
  builder?: string;
  buildxVersion?: string;
  buildkitVersion?: string;
  sourceRepository?: string;
  sourceRef?: string;
  ociSourceRevision?: string;
  ociSourceRepository?: string;
  ociProvenanceBuilderId?: string;
  ociBaseImageDependency?: string;
  ociBaseImageDigest?: string;
  ociSbomGeneratorDependency?: string;
  ociSbomGeneratorDigest?: string;
} = {}) {
  const dir = tmp.make('evidence');
  const metadataPath = path.join(dir, 'build-metadata.json');
  const runtimeEvidencePath = path.join(dir, 'buildkit-runtime.json');
  writeFileSync(runtimeEvidencePath, JSON.stringify({
    schemaVersion: 1, builderName: 'whatsoup-ci-builder', builderDriver: 'docker-container',
    buildxVersion: options.buildxVersion ?? 'v0.38.0', buildkitVersion: options.buildkitVersion ?? 'v0.33.1',
    buildkitImage: containerInputs.buildx!.buildkitImage, imageId: `sha256:${'e'.repeat(64)}`,
    nodeName: 'whatsoup-ci-builder0', endpoint: 'unix:///var/run/docker.sock', containerId: 'f'.repeat(64),
    sourceRevision: SOURCE_REVISION, provenanceBuilderId: PROVENANCE_BUILDER_ID,
  }));
  const sbomPath = path.join(dir, 'image.spdx.json');
  const imagePath = path.join(dir, 'image.tar');
  const oci = writeOciArchive(imagePath, {
    sourceRevision: options.ociSourceRevision ?? SOURCE_REVISION,
    sourceRepository: options.ociSourceRepository ?? options.sourceRepository,
    sourceRef: options.sourceRef,
    provenanceBuilderId: options.ociProvenanceBuilderId,
    baseImageDependency: options.ociBaseImageDependency,
    baseImageDigest: options.ociBaseImageDigest,
    sbomGeneratorDependency: options.ociSbomGeneratorDependency,
    sbomGeneratorDigest: options.ociSbomGeneratorDigest,
  });
  writeFileSync(metadataPath, JSON.stringify({
    'containerimage.digest': oci.outputDigest,
    'buildx.build.provenance': options.provenance ?? oci.buildxProvenance,
  }));
  writeFileSync(sbomPath, JSON.stringify({
    SPDXID: 'SPDXRef-DOCUMENT',
    spdxVersion: 'SPDX-2.3',
    name: 'whatsoup-image',
    documentNamespace: 'https://example.invalid/spdx/whatsoup-image',
    creationInfo: { creators: ['Tool: buildkit-syft-scanner'] },
    packages: [],
  }));
  return {
    repoRoot,
    metadataPath,
    runtimeEvidencePath,
    sbomPath,
    imagePath,
    sourceRevision: SOURCE_REVISION,
    sourceRepository: options.sourceRepository,
    sourceRef: options.sourceRef,
    builder: options.builder ?? 'whatsoup-ci-builder|docker-container',
    buildxVersion: options.buildxVersion ?? 'v0.38.0',
    buildkitVersion: options.buildkitVersion ?? 'v0.33.1',
    provenanceBuilderId: PROVENANCE_BUILDER_ID,
  };
}

interface OciArchiveOptions {
  jsonBytes?: { kind: 'root index' | 'output index' | 'image manifest' | 'config' | 'attestation manifest' | 'provenance' | 'SBOM'; size: number };
  imageLayerBytes?: number;
  layerContents?: string[];
  undecodableLayer?: boolean;
  configRootfs?: 'mismatch' | 'reordered' | 'extra' | 'no diff_ids' | 'no rootfs' | 'wrong type';
  sourceRevision?: string;
  sourceRepository?: string;
  sourceRef?: string;
  provenanceBuilderId?: string;
  baseImageDependency?: string;
  baseImageDigest?: string;
  sbomGeneratorDependency?: string;
  sbomGeneratorDigest?: string;
  statementSubjectDigest?: string;
  predicateAnnotation?: string;
  predicateType?: string;
  includeSlsa?: boolean;
  includeSpdx?: boolean;
  duplicateSlsa?: boolean;
  duplicateSpdx?: boolean;
  corruptAttestationSize?: boolean;
  corruptLayerDigest?: boolean;
  directLayout?: boolean;
  extraOutputDescriptor?: boolean;
  extraRunnableDescriptor?: boolean;
  imageLayerCount?: number;
  runnablePlatform?: { os: string; architecture: string };
  attestationPlatform?: { os: string; architecture: string };
  configPlatform?: { os: string; architecture: string };
  invalidBlob?: {
    kind: 'config' | 'image layer';
    defect: 'missing' | 'bytes' | 'size' | 'media type';
  };
}

function writeOciArchive(
  archivePath: string,
  options: OciArchiveOptions = {},
): { imageDigest: string; outputDigest: string; buildxProvenance: Record<string, unknown> } {
  const layout = tmp.make('oci-layout');
  const blobs = path.join(layout, 'blobs/sha256');
  mkdirSync(blobs, { recursive: true });
  const jsonBytes = (kind: NonNullable<OciArchiveOptions['jsonBytes']>['kind'], contents: string): string => (
    options.jsonBytes?.kind === kind
      ? contents.padEnd(options.jsonBytes.size, ' ')
      : contents
  );
  const writeBlob = (contents: string | Buffer): { digest: string; size: number } => {
    const bytes = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
    const digest = sha256(bytes);
    writeFileSync(path.join(blobs, digest), bytes);
    return { digest: `sha256:${digest}`, size: bytes.length };
  };

  // A sized layer is an uncompressed tar blob, so its byte count is exact; its diff_id is its own digest.
  const layerBlobs = options.imageLayerBytes !== undefined
    ? [{ mediaType: 'application/vnd.oci.image.layer.v1.tar', bytes: Buffer.alloc(options.imageLayerBytes, 0x20), diffId: '' }]
    : options.undecodableLayer
      ? [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', bytes: Buffer.from('not gzip bytes'), diffId: `sha256:${sha256('not gzip bytes')}` }]
      : (options.layerContents ?? [LAYER_CONTENT]).map((content) => ({
        mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
        bytes: gzipSync(Buffer.from(content, 'utf8')),
        diffId: `sha256:${sha256(content)}`,
      }));
  const layerDescriptors = layerBlobs.map((blob) => ({ mediaType: blob.mediaType, ...writeBlob(blob.bytes) }));
  const layerDiffIds = layerBlobs.map((blob, index) => blob.diffId || layerDescriptors[index]!.digest);
  const layerCount = options.imageLayerCount ?? layerDescriptors.length;
  const manifestLayers = Array.from({ length: layerCount }, (_, index) => layerDescriptors[index % layerDescriptors.length]!);
  const diffIds = Array.from({ length: layerCount }, (_, index) => layerDiffIds[index % layerDiffIds.length]!);
  const rootfs = options.configRootfs === 'mismatch' ? { type: 'layers', diff_ids: [`sha256:${sha256('different-layer-bytes')}`, ...diffIds.slice(1)] }
    : options.configRootfs === 'reordered' ? { type: 'layers', diff_ids: [...diffIds].reverse() }
      : options.configRootfs === 'extra' ? { type: 'layers', diff_ids: [...diffIds, diffIds[0]] }
        : options.configRootfs === 'no diff_ids' ? { type: 'layers' }
          : options.configRootfs === 'wrong type' ? { type: 'files', diff_ids: diffIds }
            : options.configRootfs === 'no rootfs' ? undefined
              : { type: 'layers', diff_ids: diffIds };
  const config = writeBlob(jsonBytes('config', JSON.stringify({
    ...(options.configPlatform ?? { architecture: 'amd64', os: 'linux' }),
    ...(rootfs === undefined ? {} : { rootfs }),
  })));
  const configDescriptor = { mediaType: 'application/vnd.oci.image.config.v1+json', ...config };
  const layerDescriptor = layerDescriptors[0]!;
  if (options.invalidBlob) {
    const descriptor = options.invalidBlob.kind === 'config' ? configDescriptor : layerDescriptor;
    const file = path.join(blobs, descriptor.digest.slice('sha256:'.length));
    if (options.invalidBlob.defect === 'missing') unlinkSync(file);
    if (options.invalidBlob.defect === 'bytes') writeFileSync(file, Buffer.alloc(descriptor.size, 0));
    if (options.invalidBlob.defect === 'size') descriptor.size += 1;
    if (options.invalidBlob.defect === 'media type') descriptor.mediaType = 'application/octet-stream';
  }
  const runnable = writeBlob(jsonBytes('image manifest', JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: configDescriptor,
    layers: manifestLayers,
  })));
  const imageDigest = runnable.digest;
  const sourceRevision = options.sourceRevision ?? SOURCE_REVISION;
  const sourceRepository = options.sourceRepository ?? SOURCE_REPOSITORY;
  const sourceUri = `${sourceRepository}#${options.sourceRef ?? sourceRevision}`;
  const provenanceBuilderId = options.provenanceBuilderId ?? PROVENANCE_BUILDER_ID;
  const resolvedDependencies = [{
    uri: options.baseImageDependency ?? BASE_IMAGE_DEPENDENCY,
    digest: { sha256: options.baseImageDigest ?? BASE_IMAGE_DIGEST },
  }, {
    uri: options.sbomGeneratorDependency ?? SBOM_GENERATOR_DEPENDENCY,
    digest: { sha256: options.sbomGeneratorDigest ?? SBOM_GENERATOR_DIGEST },
  }, {
    uri: sourceUri,
    digest: { sha1: sourceRevision },
  }];
  const provenance = {
    buildDefinition: {
      buildType: 'https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md',
      externalParameters: {
        configSource: {
          uri: sourceUri,
          digest: { sha1: sourceRevision },
          path: 'docker/Dockerfile',
        },
      },
      resolvedDependencies,
    },
    runDetails: { builder: { id: provenanceBuilderId } },
  };
  const buildxProvenance = {
    builder: { id: provenanceBuilderId },
    buildType: 'https://mobyproject.org/buildkit@v1',
    invocation: {
      configSource: {
        uri: sourceUri,
        digest: { sha1: sourceRevision },
        entryPoint: 'docker/Dockerfile',
      },
    },
    materials: resolvedDependencies,
    metadata: {},
    buildConfig: {},
  };
  const statementSubjectDigest = options.statementSubjectDigest ?? imageDigest.slice('sha256:'.length);
  const statementPredicateType = options.predicateType ?? 'https://slsa.dev/provenance/v1';
  const statement = writeBlob(jsonBytes('provenance', JSON.stringify({
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: '_', digest: { sha256: statementSubjectDigest } }],
    predicateType: statementPredicateType,
    predicate: provenance,
  })));
  const sbomStatement = writeBlob(jsonBytes('SBOM', JSON.stringify({
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: '_', digest: { sha256: statementSubjectDigest } }],
    predicateType: 'https://spdx.dev/Document',
    predicate: {
      SPDXID: 'SPDXRef-DOCUMENT',
      spdxVersion: 'SPDX-2.3',
      name: 'whatsoup-image',
      documentNamespace: 'https://example.invalid/spdx/whatsoup-image',
      creationInfo: { creators: ['Tool: buildkit-syft-scanner'] },
      packages: [],
    },
  })));
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
      }, ...(options.duplicateSlsa ? [{
        mediaType: 'application/vnd.in-toto+json',
        ...statement,
        annotations: { 'in-toto.io/predicate-type': options.predicateAnnotation ?? 'https://slsa.dev/provenance/v1' },
      }] : [])]),
      ...(options.includeSpdx === false ? [] : [{
        mediaType: 'application/vnd.in-toto+json',
        digest: options.corruptLayerDigest ? `sha256:${'f'.repeat(64)}` : sbomStatement.digest,
        size: sbomStatement.size,
        annotations: { 'in-toto.io/predicate-type': 'https://spdx.dev/Document' },
      }, ...(options.duplicateSpdx ? [{
        mediaType: 'application/vnd.in-toto+json',
        ...sbomStatement,
        annotations: { 'in-toto.io/predicate-type': 'https://spdx.dev/Document' },
      }] : [])]),
    ],
  });
  const attestation = writeBlob(jsonBytes('attestation manifest', manifest));
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
  const outputIndex = writeBlob(jsonBytes('output index', JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [
      runnableDescriptor,
      ...(options.extraRunnableDescriptor ? [runnableDescriptor] : []),
      attestationDescriptor,
    ],
  })));
  const outputDescriptor = {
    mediaType: 'application/vnd.oci.image.index.v1+json',
    ...outputIndex,
  };
  writeFileSync(path.join(layout, 'index.json'), jsonBytes('root index', JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: options.directLayout
      ? [runnableDescriptor, attestationDescriptor]
      : [outputDescriptor, ...(options.extraOutputDescriptor ? [outputDescriptor] : [])],
  })));
  execFileSync('tar', ['-cf', archivePath, '-C', layout, 'index.json', 'blobs']);
  return {
    imageDigest,
    outputDigest: options.directLayout ? imageDigest : outputIndex.digest,
    buildxProvenance,
  };
}

describe('container build evidence CI contract', () => {
  it.each([
    ['config', 'missing', 'missing blobs/sha256/'],
    ['config', 'bytes', 'SHA-256 does not match blob'],
    ['config', 'size', 'size does not match blob'],
    ['config', 'media type', 'invalid OCI config descriptor'],
    ['image layer', 'missing', 'missing blobs/sha256/'],
    ['image layer', 'bytes', 'SHA-256 does not match blob'],
    ['image layer', 'size', 'size does not match blob'],
    ['image layer', 'media type', 'unexpected media type'],
  ] as const)('rejects a %s descriptor with %s', (kind, defect, error) => {
    const imagePath = path.join(tmp.make('invalid-image'), 'image.tar');
    const oci = writeOciArchive(imagePath, { invalidBlob: { kind, defect } });
    expect(() => verifyOciArchiveAttestations(imagePath, oci.outputDigest)).toThrow(error);
  });

  it('rejects image config architecture inconsistent with its runnable descriptor', () => {
    const imagePath = path.join(tmp.make('wrong-config'), 'image.tar');
    const oci = writeOciArchive(imagePath, { configPlatform: { os: 'linux', architecture: 'arm64' } });
    expect(() => verifyOciArchiveAttestations(imagePath, oci.outputDigest)).toThrow(
      'runnable image config does not match linux/amd64',
    );
  });

  it('accepts an image whose config diff_ids name its archived layers in order', () => {
    const imagePath = path.join(tmp.make('diff-ids'), 'image.tar');
    const oci = writeOciArchive(imagePath, { layerContents: ['layer-one', 'layer-two'] });
    expect(verifyOciArchiveAttestations(imagePath, oci.outputDigest).imageDigest).toBe(oci.imageDigest);
  });

  it.each([
    ['mismatch', 'runnable image config diff_ids do not match the archived layers'],
    ['reordered', 'runnable image config diff_ids do not match the archived layers'],
    ['extra', 'runnable image config diff_ids do not match the archived layers'],
    ['no diff_ids', 'runnable image config must declare a layers rootfs with diff_ids'],
    ['no rootfs', 'runnable image config must declare a layers rootfs with diff_ids'],
    ['wrong type', 'runnable image config must declare a layers rootfs with diff_ids'],
  ] as const)('rejects a config rootfs with %s against the archived layers', (configRootfs, error) => {
    const imagePath = path.join(tmp.make('bad-diff-ids'), 'image.tar');
    const oci = writeOciArchive(imagePath, { layerContents: ['layer-one', 'layer-two'], configRootfs });
    expect(() => verifyOciArchiveAttestations(imagePath, oci.outputDigest)).toThrow(error);
  });

  it('rejects a layer whose bytes do not decompress as its declared media type', () => {
    const imagePath = path.join(tmp.make('undecodable-layer'), 'image.tar');
    const oci = writeOciArchive(imagePath, { undecodableLayer: true });
    expect(() => verifyOciArchiveAttestations(imagePath, oci.outputDigest)).toThrow('cannot be decompressed');
  });

  it('hashes multiple chunks exactly and refuses evidence larger than its bound', () => {
    const file = path.join(tmp.make('hash'), 'evidence');
    const bytes = Buffer.alloc(3 * 64 * 1024 + 7, 0x83);
    writeFileSync(file, bytes);
    expect(sha256File(file, bytes.length)).toBe(`sha256:${sha256(bytes)}`);
    expect(() => sha256File(file, bytes.length - 1)).toThrow('byte limit');
  });

  it('exports only the verified embedded SPDX and verifies the exported evidence', () => {
    const input = makeReceiptInput();
    const output = path.join(path.dirname(input.sbomPath), 'verified.spdx.json');
    const receipt = createContainerBuildReceipt({ ...input, sbomPath: undefined, verifiedSbomOutputPath: output });
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(JSON.parse(readFileSync(input.sbomPath, 'utf8')));
    expect(() => verifyContainerBuildReceipt(receipt, { ...input, sbomPath: output })).not.toThrow();
  });

  it('refuses a different valid SPDX document instead of attesting unrelated evidence', () => {
    const input = makeReceiptInput();
    const document = JSON.parse(readFileSync(input.sbomPath, 'utf8'));
    document.name = 'different-image';
    writeFileSync(input.sbomPath, JSON.stringify(document));
    expect(() => createContainerBuildReceipt(input)).toThrow('does not match the verified embedded SPDX predicate');
  });

  it('does not create an exported SPDX file when receipt verification is requested', () => {
    const input = makeReceiptInput();
    const output = path.join(path.dirname(input.sbomPath), 'unexpected.spdx.json');
    const receipt = createContainerBuildReceipt(input);
    expect(() => verifyContainerBuildReceipt(receipt, {
      ...input, sbomPath: undefined, verifiedSbomOutputPath: output,
    })).toThrow('receipt verification requires an existing SBOM');
    expect(existsSync(output)).toBe(false);
  });

  it('uses the shared closed-option parser and rejects ambiguous receipt inputs', () => {
    const argv = [
      '--metadata', '/tmp/metadata.json', '--runtime-evidence', '/tmp/runtime.json', '--sbom', '/tmp/sbom.json',
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
    expect(parseArgs([...argv, '--source-ref', 'refs/pull/7/merge'], '/repo')).toMatchObject({
      sourceRef: 'refs/pull/7/merge',
    });
  });

  it('builds pinned inputs and produces an independently checked evidence bundle', () => {
    expect(qualityWorkflow).toContain('docker buildx build');
    expect(qualityWorkflow).toContain('type=provenance,mode=max,builder-id=$provenance_builder_id');
    expect(qualityWorkflow).toContain('--sbom "generator=$sbom_generator"');
    expect(qualityWorkflow).toContain('BUILDX_METADATA_PROVENANCE: max');
    expect(qualityWorkflow).toContain('--output type=oci');
    expect(containerInputs.platform).toBe('linux/amd64');
    expect(containerInputs.baseImageDependency).toBe(BASE_IMAGE_DEPENDENCY);
    expect(containerInputs.baseImageResolvedDigest).toBe(`sha256:${BASE_IMAGE_DIGEST}`);
    expect(containerInputs.buildx).toEqual({
      version: 'v0.38.0',
      asset: 'buildx-v0.38.0.linux-amd64',
      sha256: 'sha256:4fe4cc38adf48169132749b6ca22a990928db0118e3407584ee553723115d287',
      buildkitImage: 'moby/buildkit:v0.33.1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea',
    });
    expect(containerInputs.sbom).toEqual({
      generator: 'docker/buildkit-syft-scanner:stable-1@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9',
      dependency: SBOM_GENERATOR_DEPENDENCY,
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
    const workflow = parse(qualityWorkflow) as { jobs: { quality: { steps: { name: string; run?: string }[] } } };
    const attestedBuild = workflow.jobs.quality.steps.find((step) => step.name === 'Build Docker deployment image');
    expect(attestedBuild?.run).toContain('--output type=oci');
    expect(attestedBuild?.run).not.toContain('--load');
    expect(attestedBuild?.run).not.toContain('--provenance=false');
    expect(qualityWorkflow).not.toContain('docker image save whatsoup-ci');
    expect(qualityWorkflow).toContain('--metadata-file');
    expect(qualityWorkflow).toContain('"${source_repository}#${SOURCE_REF}"');
    expect(qualityWorkflow).toContain('policy.sbom.generator');
    expect(qualityWorkflow).toContain('policy.platform');
    expect(qualityWorkflow).toContain('--platform "$platform"');
    expect(qualityWorkflow).toContain('--provenance-builder-id "$provenance_builder_id"');
    expect(qualityWorkflow).toContain('--verified-sbom-output "$container_dir/whatsoup-image.spdx.json"');
    expect(qualityWorkflow).toContain('scripts/verify-container-build-receipt.ts');
    expect(qualityWorkflow).toContain('container-build-evidence-${{ github.sha }}');
    expect(qualityWorkflow).toContain('id: build-container');
    expect(qualityWorkflow).toContain("if: ${{ always() && steps.build-container.outcome == 'success' }}");
  });

  it('attests only the trusted main branch with a pinned action and isolated permissions', () => {
    const workflow = parse(qualityWorkflow) as {
      permissions?: Record<string, string>;
      jobs: Record<string, { if?: string; needs?: unknown; permissions?: Record<string, string>; steps?: { run?: string; uses?: string }[] }>;
    };
    const attest = workflow.jobs['attest-container-build'];
    expect(attest).toBeDefined();
    expect(attest!.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(attest!.needs).toBe('quality');
    expect(attest!.permissions).toEqual({
      contents: 'read', 'id-token': 'write', attestations: 'write', 'artifact-metadata': 'write',
    });
    // Write permissions belong to the attestation job alone; the workflow default stays read-only.
    expect(workflow.permissions).toEqual({ contents: 'read' });
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (id === 'attest-container-build') continue;
      expect(Object.values(job.permissions ?? {}), id).not.toContain('write');
    }
    // The signing job only re-verifies downloaded evidence; it never builds or runs an image.
    expect(attest!.steps?.some((step) => /(^|\s)docker\s+(build|buildx|run|load|pull)\b/m.test(step.run ?? ''))).toBe(false);
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
    expect(receipt.schemaVersion).toBe(4);
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

  it('binds the runtime image identity to the verified OCI configuration bytes', () => {
    const input = makeReceiptInput();
    const receipt = createContainerBuildReceipt(input);
    const config = JSON.stringify({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [LAYER_DIFF_ID] } });

    expect(receipt.imageConfigDigest).toBe(`sha256:${sha256(config)}`);
    expect(() => verifyContainerBuildReceipt({
      ...receipt, imageConfigDigest: `sha256:${'f'.repeat(64)}`,
    }, input)).toThrow('container build receipt does not match the verified build inputs');
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

  it('binds a pull-request merge ref to the merge commit the job checked out', () => {
    const input = makeReceiptInput({ sourceRef: 'refs/pull/7/merge' });
    const receipt = createContainerBuildReceipt(input);

    expect(receipt.sourceRevision).toBe(SOURCE_REVISION);
    expect(receipt.sourceRepository).toBe(SOURCE_REPOSITORY);
    expect(() => verifyContainerBuildReceipt(receipt, input)).not.toThrow();
  });

  it('rejects a merge ref that resolved to a commit other than the checked-out merge result', () => {
    expect(() => createContainerBuildReceipt(makeReceiptInput({
      sourceRef: 'refs/pull/7/merge',
      ociSourceRevision: 'c'.repeat(40),
    }))).toThrow('SLSA config source revision does not match requested source revision');
  });

  it.each(['refs/pull/7/head', 'refs/heads/main', 'refs/pull/0/merge', 'main'])(
    'refuses source ref %s, which is neither the revision nor a pull-request merge ref', (sourceRef) => {
      expect(() => createContainerBuildReceipt(makeReceiptInput({ sourceRef }))).toThrow(
        'source ref must be the source revision or a pull request merge ref',
      );
    },
  );

  it('builds the pull-request merge result that the job checked out, not the pull-request head', () => {
    const workflow = parse(qualityWorkflow) as {
      jobs: { quality: { steps: { name: string; run?: string; env?: Record<string, string> }[] } };
    };
    const step = (name: string) => {
      const found = workflow.jobs.quality.steps.find((entry) => entry.name === name);
      expect(found, name).toBeDefined();
      return found!;
    };
    const mergeRef = "${{ github.event_name == 'pull_request' && format('refs/pull/{0}/merge', github.event.pull_request.number) || github.sha }}";
    for (const name of [
      'Build Docker deployment image',
      'Verify container build receipt',
      'Load verified deployment image and runtime providers',
    ]) {
      expect(step(name).env?.SOURCE_REVISION, name).toBe('${{ github.sha }}');
      expect(step(name).env?.SOURCE_REF, name).toBe(mergeRef);
    }
    // Scoped to the quality job: the gitleaks job legitimately scans the pull-request head range.
    const qualityJob = JSON.stringify(workflow.jobs.quality);
    expect(qualityJob).not.toContain('pull_request.head.sha');
    expect(qualityJob).not.toContain('pull_request.head.repo.clone_url');
    const build = step('Build Docker deployment image').run ?? '';
    expect(build).toContain('"$(git rev-parse HEAD)" != "$SOURCE_REVISION"');
    expect(build).toContain('"${source_repository}#${SOURCE_REF}"');
    expect(step('Load verified deployment image and runtime providers').run).toContain('"${source_repository}#${SOURCE_REF}"');
    expect(step('Verify container build receipt').run?.match(/--source-ref "\$SOURCE_REF"/g)).toHaveLength(2);
    // Both fetches of the merge ref run the same ls-remote pin check first; the runtime export test
    // executes the load step's copy against a stub.
    const load = step('Load verified deployment image and runtime providers').run ?? '';
    const pinCheck = (run: string) => {
      const start = run.indexOf('if [ "$SOURCE_REF" != "$SOURCE_REVISION" ]; then\n');
      return start < 0 ? '' : run.slice(start, run.indexOf('\nfi\n', start) + 4);
    };
    expect(pinCheck(build)).toContain('merge_ref_listing="$(git ls-remote "$source_repository" "$SOURCE_REF")"');
    expect(pinCheck(build)).toBe(pinCheck(load));
    for (const run of [build, load]) {
      expect(run.indexOf(pinCheck(run))).toBeGreaterThan(run.indexOf('source_repository="$('));
      expect(run.indexOf(pinCheck(run))).toBeLessThan(run.indexOf('docker buildx build'));
    }
  });

  it('refuses an empty Buildx provenance placeholder', () => {
    expect(() => createContainerBuildReceipt(makeReceiptInput({ provenance: {} }))).toThrow(
      'build metadata is missing non-empty buildx.build.provenance',
    );
  });

  it('refuses Buildx SLSA v0.2 metadata with a substituted source path', () => {
    const input = makeReceiptInput();
    const metadata = JSON.parse(readFileSync(input.metadataPath, 'utf8')) as {
      'buildx.build.provenance': { invocation: { configSource: { entryPoint: string } } };
    };
    metadata['buildx.build.provenance'].invocation.configSource.entryPoint = 'Dockerfile';
    writeFileSync(input.metadataPath, JSON.stringify(metadata));

    expect(() => createContainerBuildReceipt(input)).toThrow(
      'Buildx metadata config source path is not docker/Dockerfile',
    );
  });

  it('refuses Buildx SLSA v0.2 materials that diverge from the SLSA v1 dependencies', () => {
    const input = makeReceiptInput();
    const metadata = JSON.parse(readFileSync(input.metadataPath, 'utf8')) as {
      'buildx.build.provenance': { materials: unknown[] };
    };
    metadata['buildx.build.provenance'].materials = metadata['buildx.build.provenance'].materials.slice(1);
    writeFileSync(input.metadataPath, JSON.stringify(metadata));

    expect(() => createContainerBuildReceipt(input)).toThrow(
      'Buildx metadata materials do not match verified SLSA dependencies',
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

  it('rejects ambiguous duplicate SLSA and SPDX predicate layers', () => {
    const duplicateSlsa = makeReceiptInput();
    const duplicateSlsaArchive = writeOciArchive(duplicateSlsa.imagePath, { duplicateSlsa: true });
    expect(() => verifyOciArchiveAttestations(
      duplicateSlsa.imagePath,
      duplicateSlsaArchive.outputDigest,
    )).toThrow('OCI image archive has multiple SLSA provenance predicates');

    const duplicateSpdx = makeReceiptInput();
    const duplicateSpdxArchive = writeOciArchive(duplicateSpdx.imagePath, { duplicateSpdx: true });
    expect(() => verifyOciArchiveAttestations(
      duplicateSpdx.imagePath,
      duplicateSpdxArchive.outputDigest,
    )).toThrow('OCI image archive has multiple SPDX SBOM predicates');
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
    expect(() => createContainerBuildReceipt(makeReceiptInput({
      ociBaseImageDependency: 'pkg:docker/node@24.15.0-slim?platform=linux%2Famd64',
    }))).toThrow('SLSA provenance does not bind the reviewed selected-platform base image dependency');
    expect(() => createContainerBuildReceipt(makeReceiptInput({
      ociBaseImageDependency: `pkg:docker/node@24.15.0-slim?digest=sha256:${'f'.repeat(64)}&platform=linux%2Famd64`,
    }))).toThrow('SLSA provenance does not bind the reviewed selected-platform base image dependency');
  });

  it('requires the reviewed selected-platform SBOM generator dependency', () => {
    expect(() => createContainerBuildReceipt(makeReceiptInput({
      ociSbomGeneratorDigest: 'f'.repeat(64),
    }))).toThrow('SLSA provenance does not bind the reviewed SBOM generator digest');
    expect(() => createContainerBuildReceipt(makeReceiptInput({
      ociSbomGeneratorDependency: 'pkg:docker/docker/buildkit-syft-scanner@stable-1?platform=linux%2Famd64',
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
    writeFileSync(sbomInput.sbomPath, JSON.stringify({
      SPDXID: 'SPDXRef-DOCUMENT', spdxVersion: 'SPDX-2.3', name: 'changed',
      documentNamespace: 'https://example.invalid/spdx/changed',
      creationInfo: { creators: ['Tool: changed'] }, packages: [],
    }));
    expect(() => verifyContainerBuildReceipt(sbomReceipt, sbomInput)).toThrow(
      'SBOM does not match the verified embedded SPDX predicate',
    );
  });

  it('verifies a stored receipt in one pass and publishes the receipt that passed comparison', () => {
    const input = makeReceiptInput();
    const stored = createContainerBuildReceipt(input);
    expect(verifyContainerBuildReceipt(stored, input)).toEqual(stored);
    const dir = path.dirname(input.metadataPath);
    const receiptPath = path.join(dir, 'receipt.json');
    const githubOutput = path.join(dir, 'github-output');
    writeFileSync(receiptPath, `${JSON.stringify(stored, null, 2)}\n`);
    // A tar shim on PATH counts archive reads, so the number of verification passes is observable.
    const bin = tmp.make('tar-shim');
    const callLog = path.join(bin, 'calls');
    writeFileSync(path.join(bin, 'tar'), `#!/bin/sh\necho call >> '${callLog}'\nexec /usr/bin/tar "$@"\n`, { mode: 0o755 });
    const reads = () => (existsSync(callLog) ? readFileSync(callLog, 'utf8').split('\n').filter(Boolean).length : 0);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    try {
      createContainerBuildReceipt(input);
      const onePass = reads();
      expect(onePass).toBeGreaterThan(0);
      const published = run([
        '--metadata', input.metadataPath, '--runtime-evidence', input.runtimeEvidencePath, '--sbom', input.sbomPath,
        '--image', input.imagePath, '--source', input.sourceRevision, '--builder', input.builder,
        '--buildx-version', input.buildxVersion, '--buildkit-version', input.buildkitVersion,
        '--provenance-builder-id', input.provenanceBuilderId, '--repo-root', input.repoRoot,
        '--receipt', receiptPath, '--github-output', githubOutput,
      ], dir);
      expect(reads()).toBe(2 * onePass);
      expect(published).toEqual(stored);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(readFileSync(githubOutput, 'utf8')).toBe(
      `image_digest=${stored.imageDigest}\nexternal_sbom_sha256=${stored.sbomSha256}\n`,
    );
  });

  it('rejects source and builder substitution after receipt creation', () => {
    const input = makeReceiptInput();
    const receipt = createContainerBuildReceipt(input);

    expect(() => verifyContainerBuildReceipt(receipt, {
      ...input,
      sourceRevision: 'c'.repeat(40),
    })).toThrow('BuildKit runtime evidence does not bind reviewed image and workflow invocation');
    expect(() => verifyContainerBuildReceipt(receipt, {
      ...input,
      builder: 'unreviewed|docker',
    })).toThrow('builder identity does not match docker/container-inputs.json');
  });
});

describe('primary review evidence boundaries', () => {
  it.each(['root index', 'output index', 'image manifest', 'config', 'attestation manifest', 'provenance', 'SBOM'] as const)(
    'rejects OCI %s JSON one byte above the 32 MiB limit', (kind) => {
      const archive = path.join(tmp.make('oversized-oci-json'), 'image.tar');
      const output = writeOciArchive(archive, { jsonBytes: { kind, size: 32 * 1024 * 1024 + 1 } });
      expect(() => verifyOciArchiveAttestations(archive, output.outputDigest)).toThrow('byte limit');
    },
  );
  it.each(['root index', 'provenance'] as const)('accepts OCI %s JSON exactly at the 32 MiB limit', (kind) => {
    const archive = path.join(tmp.make('boundary-oci-json'), 'image.tar');
    const output = writeOciArchive(archive, { jsonBytes: { kind, size: 32 * 1024 * 1024 } });
    expect(verifyOciArchiveAttestations(archive, output.outputDigest).imageDigest).toBe(output.imageDigest);
  });
  it('retains the separate binary layer byte limit', () => {
    const archive = path.join(tmp.make('binary-oci-layer'), 'image.tar');
    const output = writeOciArchive(archive, { imageLayerBytes: 32 * 1024 * 1024 + 1 });
    expect(verifyOciArchiveAttestations(archive, output.outputDigest).imageDigest).toBe(output.imageDigest);
  });
  it('rejects a binary layer one byte above the 96 MiB entry limit', () => {
    const archive = path.join(tmp.make('oversized-oci-layer'), 'image.tar');
    const output = writeOciArchive(archive, { imageLayerBytes: 96 * 1024 * 1024 + 1 });
    expect(() => verifyOciArchiveAttestations(archive, output.outputDigest)).toThrow(
      `runnable image layer descriptor exceeds ${96 * 1024 * 1024} byte limit`,
    );
  });
  it.each(['metadataPath', 'sbomPath'] as const)('rejects oversized %s before parsing', (field) => {
    const input = makeReceiptInput();
    const bytes = readFileSync(input[field]);
    writeFileSync(input[field], Buffer.concat([Buffer.alloc(33 * 1024 * 1024, 32), bytes]));
    expect(() => createContainerBuildReceipt(input)).toThrow('byte limit');
  });
  it('rejects a redirected policy fallback even when its builder prefix agrees', () => {
    const input = makeReceiptInput({ sourceRepository: 'https://github.com/contributor/WhatSoup.git',
      ociProvenanceBuilderId: 'https://github.com/contributor/WhatSoup/actions/runs/123' });
    const root = tmp.make('redirected-policy');
    mkdirSync(path.join(root, 'docker'));
    const policy = JSON.parse(readFileSync(path.join(repoRoot, 'docker/container-inputs.json'), 'utf8'));
    policy.sourceRepository = 'https://github.com/contributor/WhatSoup.git';
    policy.builder.provenanceIdPrefix = 'https://github.com/contributor/WhatSoup/actions/runs/';
    writeFileSync(path.join(root, 'docker/container-inputs.json'), JSON.stringify(policy));
    expect(() => createContainerBuildReceipt({ ...input, repoRoot: root,
      provenanceBuilderId: `${policy.builder.provenanceIdPrefix}123` })).toThrow('invalid source');
  });
  it('rejects an excessive image layer list before repeated extraction', () => {
    const archive = path.join(tmp.make('too-many-layers'), 'image.tar');
    const output = writeOciArchive(archive, { imageLayerCount: 129 });
    expect(() => verifyOciArchiveAttestations(archive, output.outputDigest)).toThrow('descriptor count limit');
  });
});

it.each(['buildkitImage', 'sourceRevision', 'provenanceBuilderId'])('rejects substituted runtime %s', (field) => {
  const input = makeReceiptInput();
  const evidence = JSON.parse(readFileSync(input.runtimeEvidencePath, 'utf8'));
  evidence[field] = field === 'buildkitImage' ? `moby/buildkit:v0.33.1@sha256:${'d'.repeat(64)}` : 'substituted';
  writeFileSync(input.runtimeEvidencePath, JSON.stringify(evidence));
  expect(() => createContainerBuildReceipt(input)).toThrow('BuildKit runtime evidence does not bind');
});
it('binds runtime evidence bytes and image identity into the receipt', () => {
  const input = makeReceiptInput();
  const receipt = createContainerBuildReceipt(input);
  expect(receipt.runtimeEvidenceSha256).toBe(`sha256:${sha256(readFileSync(input.runtimeEvidencePath))}`);
  expect(receipt.buildkitImageId).toBe(`sha256:${'e'.repeat(64)}`);
  const evidence = JSON.parse(readFileSync(input.runtimeEvidencePath, 'utf8'));
  evidence.imageId = `sha256:${'d'.repeat(64)}`;
  writeFileSync(input.runtimeEvidencePath, JSON.stringify(evidence));
  expect(() => verifyContainerBuildReceipt(receipt, input)).toThrow('does not match the verified build inputs');
});
it('enforces an aggregate extraction budget across valid OCI entries', () => {
  const archive = path.join(tmp.make('budget'), 'image.tar');
  const output = writeOciArchive(archive);
  expect(() => verifyOciArchiveAttestations(archive, output.outputDigest, undefined, { maxEntries: 1 }))
    .toThrow('extraction count limit');
  expect(() => verifyOciArchiveAttestations(archive, output.outputDigest, undefined, { maxBytes: 2048 }))
    .toThrow('aggregate byte limit');
  expect(() => verifyOciArchiveAttestations(archive, output.outputDigest, undefined, { timeoutMs: 1 }))
    .toThrow(/wall-time limit|ETIMEDOUT/);
  expect(verifyOciArchiveAttestations(archive, output.outputDigest).imageDigest).toBe(output.imageDigest);
});

it('rejects a runtime evidence FIFO without waiting for a writer', () => {
  const input = makeReceiptInput();
  unlinkSync(input.runtimeEvidencePath);
  execFileSync('mkfifo', [input.runtimeEvidencePath]);
  const moduleUrl = new URL('../../scripts/verify-container-build-receipt.ts', import.meta.url).href;
  const program = `import { createContainerBuildReceipt } from ${JSON.stringify(moduleUrl)};
    try { createContainerBuildReceipt(${JSON.stringify(input)}); process.exit(3); }
    catch (error) { console.error(error.message); process.exit(42); }`;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', program],
    { encoding: 'utf8', timeout: 2000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(42);
  expect(result.stderr).toContain('BuildKit runtime evidence exceeds');
});
