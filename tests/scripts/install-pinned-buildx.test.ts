import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  BUILDX_DOWNLOAD_MAX_BYTES,
  installPinnedBuildx,
} from '../../scripts/install-pinned-buildx.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('install-pinned-buildx-');

function makeRepo(asset: Buffer): string {
  const repoRoot = tmp.make('repo');
  mkdirSync(path.join(repoRoot, 'docker'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'docker/container-inputs.json'), `${JSON.stringify({
    buildx: {
      version: 'v0.38.0',
      asset: 'buildx-v0.38.0.linux-amd64',
      sha256: `sha256:${createHash('sha256').update(asset).digest('hex')}`,
    },
  })}\n`, 'utf8');
  return repoRoot;
}

function successfulFetch(asset: Buffer): typeof fetch {
  return vi.fn(async () => new Response(new Uint8Array(asset), { status: 200 })) as unknown as typeof fetch;
}

describe('pinned Buildx installer', () => {
  it('downloads the exact reviewed release asset and atomically publishes a checked executable', async () => {
    const asset = Buffer.from('reviewed-buildx-asset');
    const repoRoot = makeRepo(asset);
    const dockerConfig = tmp.make('docker-config');
    const fetchImpl = successfulFetch(asset);

    const destination = await installPinnedBuildx({ repoRoot, dockerConfig, fetchImpl });

    expect(destination).toBe(path.join(dockerConfig, 'cli-plugins/docker-buildx'));
    expect(readFileSync(destination)).toEqual(asset);
    expect(statSync(destination).mode & 0o777).toBe(0o755);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://github.com/docker/buildx/releases/download/v0.38.0/buildx-v0.38.0.linux-amd64',
      expect.objectContaining({ redirect: 'follow' }),
    );
  });

  it('does not publish an executable when bytes fail the reviewed checksum', async () => {
    const repoRoot = makeRepo(Buffer.from('expected'));
    const dockerConfig = tmp.make('docker-config');

    await expect(installPinnedBuildx({
      repoRoot,
      dockerConfig,
      fetchImpl: successfulFetch(Buffer.from('tampered')),
    })).rejects.toThrow('Buildx asset checksum mismatch');

    expect(existsSync(path.join(dockerConfig, 'cli-plugins/docker-buildx'))).toBe(false);
  });

  it('fails closed for unavailable releases without publishing an executable', async () => {
    const repoRoot = makeRepo(Buffer.from('expected'));
    const dockerConfig = tmp.make('docker-config');
    const fetchImpl = vi.fn(async () => new Response('unavailable', { status: 503 })) as unknown as typeof fetch;

    await expect(installPinnedBuildx({ repoRoot, dockerConfig, fetchImpl })).rejects.toThrow(
      'Buildx asset download failed: HTTP 503',
    );
    expect(existsSync(path.join(dockerConfig, 'cli-plugins/docker-buildx'))).toBe(false);
  });

  it('fails closed for interrupted downloads without publishing an executable', async () => {
    const repoRoot = makeRepo(Buffer.from('expected'));
    const dockerConfig = tmp.make('docker-config');
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network connection lost');
    }) as unknown as typeof fetch;

    await expect(installPinnedBuildx({ repoRoot, dockerConfig, fetchImpl })).rejects.toThrow(
      'Buildx asset download failed: network connection lost',
    );
    expect(existsSync(path.join(dockerConfig, 'cli-plugins/docker-buildx'))).toBe(false);
  });

  it('bounds a stalled response body with the request abort signal', async () => {
    const repoRoot = makeRepo(Buffer.from('expected'));
    const dockerConfig = tmp.make('docker-config');
    const stalledBody = new ReadableStream<Uint8Array>({
      start() {},
    });
    const fetchImpl = vi.fn(async () => new Response(stalledBody, { status: 200 })) as unknown as typeof fetch;

    await expect(installPinnedBuildx({
      repoRoot,
      dockerConfig,
      fetchImpl,
      timeoutMs: 10,
    })).rejects.toThrow('Buildx asset download timed out after 10ms');

    expect(existsSync(path.join(dockerConfig, 'cli-plugins/docker-buildx'))).toBe(false);
  });

  it('bounds oversized responses even without a content-length header', async () => {
    const asset = Buffer.from('expected');
    const repoRoot = makeRepo(asset);
    const dockerConfig = tmp.make('docker-config');

    await expect(installPinnedBuildx({
      repoRoot,
      dockerConfig,
      fetchImpl: successfulFetch(Buffer.from('oversized')),
      maxBytes: 3,
    })).rejects.toThrow('Buildx asset download exceeds 3 byte limit');

    expect(existsSync(path.join(dockerConfig, 'cli-plugins/docker-buildx'))).toBe(false);
  });

  it('sets a production response-size limit instead of trusting release metadata', () => {
    expect(BUILDX_DOWNLOAD_MAX_BYTES).toBeGreaterThan(0);
    expect(BUILDX_DOWNLOAD_MAX_BYTES).toBeLessThanOrEqual(128 * 1024 * 1024);
  });
});
