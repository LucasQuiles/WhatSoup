// src/lib/short-hash.ts
// Shared SHA-256 short-hash helper.

import { createHash } from 'node:crypto';

export function shortHash(value: string, length = 12): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}
