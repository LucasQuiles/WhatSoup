import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');
const readSource = (path: string): string => readFileSync(resolve(repoRoot, path), 'utf8');

describe('outbound failure source guards', () => {
  it('does not clamp producer retry floors in the queue runtimes', () => {
    for (const path of [
      'src/runtimes/agent/outbound-queue.ts',
      'src/runtimes/chat/runtime.ts',
    ]) {
      const source = readSource(path);
      expect(source).not.toMatch(/Math\.min\([^)]*retry(?:After|_not_before)/s);
    }
  });

  it('does not pass raw thrown prose to outbound durability transitions', () => {
    for (const path of [
      'src/core/durability.ts',
      'src/runtimes/agent/outbound-queue.ts',
      'src/runtimes/chat/runtime.ts',
    ]) {
      const source = readSource(path);
      expect(source).not.toMatch(
        /\.(?:markMaybeSent|markFailedPermanent|markDeferred|markQuarantined)\([^;]{0,300}(?:\.message|errorMessage\()/s,
      );
    }
  });

  it('does not add literal prose to outbound failure-state SQL', () => {
    const durability = readSource('src/core/durability.ts');
    expect(durability).not.toMatch(
      /SET status = '(?:maybe_sent|failed_permanent|pending|quarantined)',\s*error = '[^?]/,
    );
  });
});
