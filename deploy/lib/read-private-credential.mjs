#!/usr/bin/env node

import { readSync } from 'node:fs';

const MAX_PATH_BYTES = 4096;
const MAX_CREDENTIAL_BYTES = 4096;

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
    throw new Error('invalid credential file location input');
  }
  return buffer.subarray(0, terminator).toString('utf8');
}

try {
  const credentialFile = readNulTerminatedPath();
  const { readPrivateFileSync } = await import('../../src/lib/private-fs.ts');
  const credential = readPrivateFileSync(credentialFile, {
    label: 'credential',
    maxBytes: MAX_CREDENTIAL_BYTES,
  });
  if (credential !== null) process.stdout.write(credential.trim());
} catch {
  process.stderr.write('FATAL: private credential file could not be read safely\n');
  process.exitCode = 1;
}
