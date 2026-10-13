import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  createContainerBuildReceipt,
  verifyContainerBuildReceipt,
  verifyOciArchiveAttestations,
} from '../../scripts/verify-container-build-receipt.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const qualityWorkflow = readFileSync(path.join(repoRoot, '.github/workflows/quality.yml'), 'utf8');
const containerInputs = JSON.parse(
  readFileSync(path.join(repoRoot, 'docker/container-inputs.json'), 'utf8'),
) as {
  buildx?: { version?: string; asset?: string; sha256?: string; buildkitImage?: string };
};
const tmp = trackTmpDirs('container-build-receipt-');

function makeReceiptInput(options: {
  provenance?: unknown;
  builder?: string;
  buildxVersion?: string;
  buildkitVersion?: string;
} = {}) {
  const dir = tmp.make('evidence');
  const metadataPath = path.join(dir, 'build-metadata.json');
  const sbomPath = path.join(dir, 'image.spdx.json');
  const imagePath = path.join(dir, 'image.tar');
  writeFileSync(metadataPath, JSON.stringify({
    'containerimage.digest': `sha256:${'a'.repeat(64)}`,
    'buildx.build.provenance': options.provenance ?? { buildType: 'https://mobyproject.org/buildkit@v1' },
  }));
  writeFileSync(sbomPath, JSON.stringify({ spdxVersion: 'SPDX-2.3' }));
  writeFileSync(imagePath, 'container-image');
  return {
    repoRoot,
    metadataPath,
    sbomPath,
    imagePath,
    sourceRevision: 'b'.repeat(40),
    builder: options.builder ?? 'whatsoup-ci-builder|docker-container',
    buildxVersion: options.buildxVersion ?? 'v0.38.0',
    buildkitVersion: options.buildkitVersion ?? 'v0.33.1',
  };
}

function writeOciArchive(
  archivePath: string,
  predicateTypes: string[],
  imageDigest: string = `sha256:${'a'.repeat(64)}`,
): void {
  const layout = tmp.make('oci-layout');
  const blobs = path.join(layout, 'blobs/sha256');
  mkdirSync(blobs, { recursive: true });
  const manifestDigest = 'b'.repeat(64);
  writeFileSync(path.join(blobs, manifestDigest), JSON.stringify({
    schemaVersion: 2,
    layers: predicateTypes.map((predicate, index) => ({
      digest: `sha256:${String.fromCharCode(99 + index).repeat(64)}`,
      annotations: { 'in-toto.io/predicate-type': predicate },
    })),
  }));
  writeFileSync(path.join(layout, 'index.json'), JSON.stringify({
    schemaVersion: 2,
    manifests: [{
      digest: `sha256:${manifestDigest}`,
      annotations: {
        'vnd.docker.reference.type': 'attestation-manifest',
        'vnd.docker.reference.digest': imageDigest,
      },
    }],
  }));
  execFileSync('tar', ['-cf', archivePath, '-C', layout, 'index.json', 'blobs']);
}

describe('container build evidence CI contract', () => {
  it('builds pinned inputs and produces an independently checked evidence bundle', () => {
    expect(qualityWorkflow).toContain('docker buildx build');
    expect(qualityWorkflow).toContain('--provenance=mode=max');
    expect(qualityWorkflow).toContain('--sbom=true');
    expect(qualityWorkflow).toContain('BUILDX_METADATA_PROVENANCE: max');
    expect(qualityWorkflow).toContain('--output type=oci');
    expect(containerInputs.buildx).toEqual({
      version: 'v0.38.0',
      asset: 'buildx-v0.38.0.linux-amd64',
      sha256: 'sha256:4fe4cc38adf48169132749b6ca22a990928db0118e3407584ee553723115d287',
      buildkitImage: 'moby/buildkit:v0.33.1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea',
    });
    expect(qualityWorkflow).toContain('scripts/install-pinned-buildx.ts');
    expect(qualityWorkflow).toContain('DOCKER_CONFIG=$docker_config');
    expect(qualityWorkflow).toContain('docker buildx create');
    expect(qualityWorkflow).toContain('--name "$builder_name"');
    expect(qualityWorkflow).toContain('--driver "$builder_driver"');
    expect(qualityWorkflow).toContain('--driver-opt "image=$buildkit_image"');
    expect(qualityWorkflow).toContain('docker buildx version | awk \'{print $2}\'');
    expect(qualityWorkflow).toContain('docker buildx inspect whatsoup-ci-builder --bootstrap');
    expect(qualityWorkflow).toContain('Build[Kk]it(:| version:)');
    expect(qualityWorkflow).not.toContain('docker/setup-buildx-action@');
    expect(qualityWorkflow).not.toContain('--load');
    expect(qualityWorkflow).not.toContain('docker image save whatsoup-ci');
    expect(qualityWorkflow).toContain('--metadata-file');
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
  });

  it('binds the source, image digest, SPDX SBOM and non-empty Buildx provenance in the receipt', () => {
    const input = makeReceiptInput();
    const receipt = createContainerBuildReceipt(input);

    expect(receipt.sourceRevision).toBe(input.sourceRevision);
    expect(receipt.buildxVersion).toBe('v0.38.0');
    expect(receipt.buildkitImage).toBe(
      'moby/buildkit:v0.33.1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea',
    );
    expect(receipt.buildkitVersion).toBe('v0.33.1');
    expect(receipt.imageDigest).toBe(`sha256:${'a'.repeat(64)}`);
    expect(receipt.sbomFormat).toBe('SPDX');
    expect(receipt.provenance).toBe('buildx.build.provenance');
    expect(() => verifyContainerBuildReceipt(receipt, input)).not.toThrow();
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

  it('requires OCI evidence to retain both BuildKit predicates for the image digest', () => {
    const input = makeReceiptInput();
    const imageDigest = `sha256:${'a'.repeat(64)}`;
    writeOciArchive(input.imagePath, [
      'https://slsa.dev/provenance/v1',
      'https://spdx.dev/Document',
    ], imageDigest);
    expect(() => verifyOciArchiveAttestations(input.imagePath, imageDigest)).not.toThrow();

    const missingSbom = makeReceiptInput();
    writeOciArchive(missingSbom.imagePath, ['https://slsa.dev/provenance/v1'], imageDigest);
    expect(() => verifyOciArchiveAttestations(missingSbom.imagePath, imageDigest)).toThrow(
      `OCI image archive has no SPDX SBOM predicate for ${imageDigest}`,
    );

    const missingProvenance = makeReceiptInput();
    writeOciArchive(missingProvenance.imagePath, ['https://spdx.dev/Document'], imageDigest);
    expect(() => verifyOciArchiveAttestations(missingProvenance.imagePath, imageDigest)).toThrow(
      `OCI image archive has no SLSA provenance predicate for ${imageDigest}`,
    );
  });

  it('rejects metadata, image, and SBOM byte changes after receipt creation', () => {
    const metadataInput = makeReceiptInput();
    const metadataReceipt = createContainerBuildReceipt(metadataInput);
    writeFileSync(metadataInput.metadataPath, JSON.stringify({
      'containerimage.digest': `sha256:${'c'.repeat(64)}`,
      'buildx.build.provenance': { buildType: 'changed' },
    }));
    expect(() => verifyContainerBuildReceipt(metadataReceipt, metadataInput)).toThrow(
      'container build receipt does not match the verified build inputs',
    );

    const imageInput = makeReceiptInput();
    const imageReceipt = createContainerBuildReceipt(imageInput);
    writeFileSync(imageInput.imagePath, 'changed-container-image');
    expect(() => verifyContainerBuildReceipt(imageReceipt, imageInput)).toThrow(
      'container build receipt does not match the verified build inputs',
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
    })).toThrow('container build receipt does not match the verified build inputs');
    expect(() => verifyContainerBuildReceipt(receipt, {
      ...input,
      builder: 'unreviewed|docker',
    })).toThrow('builder identity does not match docker/container-inputs.json');
  });
});
