/**
 * Streams one OCI layer blob out of an image archive and prints one JSON line: the blob's byte count,
 * its SHA-256, and the SHA-256 of its uncompressed form (the OCI `diff_id`). The receipt verifier runs
 * this as a child process, so the verifier stays synchronous and no layer is ever held in memory whole.
 *
 * Usage: oci-layer-digest.ts ARCHIVE ENTRY MEDIA_TYPE MAX_COMPRESSED_BYTES MAX_UNCOMPRESSED_BYTES
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createGunzip, createZstdDecompress } from 'node:zlib';

export type LayerDigestFailure = 'compressed-limit' | 'uncompressed-limit' | 'decode' | 'tar';

export interface LayerDigestResult {
  found: boolean;
  compressedSize: number;
  compressedDigest: string;
  uncompressedDigest: string | null;
  failure: LayerDigestFailure | null;
}

function decoderFor(mediaType: string): Transform | null {
  if (mediaType === 'application/vnd.oci.image.layer.v1.tar') return null;
  if (mediaType === 'application/vnd.oci.image.layer.v1.tar+gzip') return createGunzip();
  if (mediaType === 'application/vnd.oci.image.layer.v1.tar+zstd') return createZstdDecompress();
  throw new Error(`unsupported OCI layer media type: ${mediaType}`);
}

export async function digestLayer(
  archivePath: string,
  entry: string,
  mediaType: string,
  maxCompressedBytes: number,
  maxUncompressedBytes: number,
): Promise<LayerDigestResult> {
  const decoder = decoderFor(mediaType);
  const tar = spawn('tar', ['-xOf', archivePath, entry], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = once(tar, 'close');
  if (!tar.stdout) throw new Error('tar produced no output stream');
  const compressedHash = createHash('sha256');
  const uncompressedHash = createHash('sha256');
  let compressedSize = 0;
  let uncompressedSize = 0;
  let failure: LayerDigestFailure | null = null;
  let decoded: Promise<unknown> = Promise.resolve();
  if (decoder) {
    decoder.on('data', (chunk: Buffer) => {
      uncompressedSize += chunk.length;
      if (uncompressedSize > maxUncompressedBytes) {
        failure ??= 'uncompressed-limit';
        decoder.destroy();
        return;
      }
      uncompressedHash.update(chunk);
    });
    decoded = new Promise((resolve) => {
      decoder.once('end', resolve);
      decoder.once('close', resolve);
      decoder.once('error', () => {
        failure ??= 'decode';
        resolve(undefined);
      });
    });
  }
  // Every compressed byte is hashed even after the decoder fails, so a size or digest mismatch is still
  // reported as such instead of as a decoding error.
  for await (const chunk of tar.stdout as AsyncIterable<Buffer>) {
    compressedSize += chunk.length;
    if (compressedSize > maxCompressedBytes) {
      failure = 'compressed-limit';
      tar.kill();
      break;
    }
    compressedHash.update(chunk);
    if (decoder && !decoder.destroyed && !decoder.write(chunk)) {
      await Promise.race([once(decoder, 'drain').catch(() => undefined), decoded]);
    }
  }
  if (decoder && !decoder.destroyed) {
    if (failure === 'compressed-limit') decoder.destroy();
    else decoder.end();
  }
  await decoded;
  const [code, signal] = await exited as [number | null, NodeJS.Signals | null];
  const tarFailed = failure !== 'compressed-limit' && (code !== 0 || signal !== null);
  if (tarFailed && compressedSize === 0) {
    return { found: false, compressedSize: 0, compressedDigest: '', uncompressedDigest: null, failure: null };
  }
  if (tarFailed) failure = 'tar';
  const compressedDigest = `sha256:${compressedHash.digest('hex')}`;
  const uncompressedDigest = failure ? null : decoder ? `sha256:${uncompressedHash.digest('hex')}` : compressedDigest;
  return { found: true, compressedSize, compressedDigest, uncompressedDigest, failure };
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [archivePath, entry, mediaType, maxCompressed, maxUncompressed] = process.argv.slice(2);
  if (!archivePath || !entry || !mediaType) {
    process.stderr.write('usage: oci-layer-digest.ts ARCHIVE ENTRY MEDIA_TYPE MAX_COMPRESSED_BYTES MAX_UNCOMPRESSED_BYTES\n');
    process.exitCode = 1;
  } else {
    digestLayer(
      archivePath,
      entry,
      mediaType,
      positiveInteger(maxCompressed, 'MAX_COMPRESSED_BYTES'),
      positiveInteger(maxUncompressed, 'MAX_UNCOMPRESSED_BYTES'),
    ).then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }, (error: unknown) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 1;
    });
  }
}
