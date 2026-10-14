import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseClosedOptions } from './lib/cli-args.ts';

interface BuildxPolicy {
  version: string;
  asset: string;
  sha256: string;
}

interface ContainerInputPolicy {
  buildx?: BuildxPolicy;
}

export interface InstallPinnedBuildxOptions {
  repoRoot: string;
  dockerConfig: string;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

export const BUILDX_DOWNLOAD_MAX_BYTES = 128 * 1024 * 1024;
export const BUILDX_DOWNLOAD_TIMEOUT_MS = 120_000;
const VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

function loadBuildxPolicy(repoRoot: string): BuildxPolicy {
  const policyPath = path.join(repoRoot, 'docker/container-inputs.json');
  let policy: ContainerInputPolicy;
  try {
    policy = JSON.parse(readFileSync(policyPath, 'utf8')) as ContainerInputPolicy;
  } catch {
    throw new Error(`container input policy is missing or invalid JSON: ${policyPath}`);
  }
  const buildx = policy.buildx;
  if (
    !buildx
    || !VERSION_PATTERN.test(buildx.version)
    || buildx.asset !== `buildx-${buildx.version}.linux-amd64`
    || !SHA256_PATTERN.test(buildx.sha256)
  ) {
    throw new Error(`container input policy has an invalid Buildx release identity: ${policyPath}`);
  }
  return buildx;
}

function releaseAssetUrl(policy: BuildxPolicy): string {
  return `https://github.com/docker/buildx/releases/download/${policy.version}/${policy.asset}`;
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBytes) {
      throw new Error(`Buildx asset download exceeds ${maxBytes} byte limit`);
    }
  }
  if (!response.body) throw new Error('Buildx asset download has no response body');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  const abort = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new Error('Buildx asset download timed out'));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error('Buildx asset download timed out')), { once: true });
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), abort]);
      if (next.done) break;
      received += next.value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new Error(`Buildx asset download exceeds ${maxBytes} byte limit`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, received);
}

/** Downloads the reviewed Buildx asset and publishes it only after its pinned hash matches. */
export async function installPinnedBuildx(options: InstallPinnedBuildxOptions): Promise<string> {
  const policy = loadBuildxPolicy(options.repoRoot);
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? BUILDX_DOWNLOAD_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? BUILDX_DOWNLOAD_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Buildx download byte limit must be positive');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Buildx download timeout must be positive');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let bytes: Buffer;
  try {
    const response = await fetchImpl(releaseAssetUrl(policy), {
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Buildx asset download failed: HTTP ${response.status}`);
    bytes = await readBoundedResponse(response, maxBytes, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Buildx asset download timed out after ${timeoutMs}ms`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.startsWith('Buildx asset download')) throw error;
    throw new Error(`Buildx asset download failed: ${detail}`);
  } finally {
    clearTimeout(timeout);
  }
  const observedDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (observedDigest !== policy.sha256) {
    throw new Error(`Buildx asset checksum mismatch: expected ${policy.sha256}, got ${observedDigest}`);
  }

  const pluginsDir = path.join(path.resolve(options.dockerConfig), 'cli-plugins');
  const destination = path.join(pluginsDir, 'docker-buildx');
  mkdirSync(pluginsDir, { recursive: true, mode: 0o700 });
  if (existsSync(destination)) {
    const mode = lstatSync(destination).mode;
    throw new Error(`refusing to replace existing Buildx plugin (${mode.toString(8)}): ${destination}`);
  }
  const tempDir = mkdtempSync(path.join(pluginsDir, '.docker-buildx-'));
  const tempPath = path.join(tempDir, 'docker-buildx');
  try {
    writeFileSync(tempPath, bytes, { mode: 0o700, flag: 'wx' });
    chmodSync(tempPath, 0o755);
    if (existsSync(destination)) throw new Error(`refusing to replace existing Buildx plugin: ${destination}`);
    renameSync(tempPath, destination);
    rmSync(tempDir, { recursive: true, force: true });
    return destination;
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export function parseArgs(argv: string[]): Pick<InstallPinnedBuildxOptions, 'repoRoot' | 'dockerConfig'> {
  const parsed = parseClosedOptions(argv, {
    booleanOptions: [],
    valueOptions: ['--repo-root', '--docker-config'],
  });
  const repoRoot = parsed.values.get('--repo-root');
  const dockerConfig = parsed.values.get('--docker-config');
  if (parsed.error || !repoRoot || !dockerConfig || parsed.values.size !== 2) {
    throw new Error('usage: install-pinned-buildx.ts --repo-root PATH --docker-config PATH');
  }
  return { repoRoot, dockerConfig };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installPinnedBuildx(parseArgs(process.argv.slice(2)))
    .then((destination) => console.log(`pinned Buildx installed: ${destination}`))
    .catch((error: unknown) => {
      console.error((error as Error).message);
      process.exitCode = 1;
    });
}
