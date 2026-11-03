/**
 * A seeded stand-in for a real binary file, for the disclosure-scan tests: xorshift32,
 * seed 0x3839, 524,288 bytes after a format signature and four header bytes that start
 * with a NUL, as a PNG's IHDR length does. Each run is written on its own line at
 * 100,000-byte steps, so a test can embed the shapes real images produced when read
 * as text. Deterministic: a rule that starts matching these bytes fails by name.
 */
export const SEEDED_BINARY_SEED = 0x3839;
export const SEEDED_BINARY_BODY_BYTES = 524_288;
export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
export const WOFF2_SIGNATURE = [0x77, 0x4f, 0x46, 0x32] as const;
export const OGG_SIGNATURE = [0x4f, 0x67, 0x67, 0x53] as const;

export function seededBinary(signature: readonly number[], runs: readonly string[] = []): Buffer {
  const body = Buffer.alloc(SEEDED_BINARY_BODY_BYTES);
  let x = SEEDED_BINARY_SEED;
  for (let i = 0; i < body.length; i += 1) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    body[i] = x & 0xff;
  }
  runs.forEach((run, index) => body.write(`\n${run}\n`, 100_000 * (index + 1), 'latin1'));
  return Buffer.concat([Buffer.from(signature), Buffer.from([0, 0, 0, 0x0d]), body]);
}
