#!/usr/bin/env node

import { readSync } from 'node:fs';

const MAX_PATH_BYTES = 4096;

function readNulTerminatedPath() {
  const buffer = Buffer.alloc(MAX_PATH_BYTES + 2);
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(0, buffer, offset, buffer.length - offset, null);
    if (count === 0) break;
    offset += count;
  }

  const terminator = buffer.indexOf(0, 0);
  if (offset < 2 || offset > MAX_PATH_BYTES + 1 || terminator !== offset - 1) {
    throw new Error('invalid token file location input');
  }
  return buffer.subarray(0, terminator).toString('utf8');
}

try {
  const tokenFile = readNulTerminatedPath();
  const {
    HealthTokenFileRejectedError,
    readPrivateHealthTokenFileSync,
  } = await import('../../src/fleet/health-token-file.ts');
  const token = readPrivateHealthTokenFileSync(tokenFile);
  if (token === null) {
    throw new HealthTokenFileRejectedError('health token file is missing', 'ENOENT');
  }
  process.stdout.write(token);
} catch (error) {
  const detail = error?.name === 'HealthTokenFileRejectedError'
    ? error.message
    : 'health token file could not be read safely';
  process.stderr.write(`FATAL: ${detail}\n`);
  process.exitCode = 1;
}
