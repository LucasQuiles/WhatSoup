import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptPath = path.join(repoRoot, 'deploy', 'scripts', 'heal-notify.sh');

describe('deploy/scripts/heal-notify.sh', () => {
  const scriptSrc = readFileSync(scriptPath, 'utf8');

  it('does not use GNU grep PCRE flags', () => {
    const pcreUsage = scriptSrc.match(/grep\s+-[a-zA-Z]*P[a-zA-Z]*\b/g) ?? [];

    expect(pcreUsage).toEqual([]);
  });

  it('extracts msg fields with BSD-compatible extended grep', () => {
    expect(scriptSrc).toMatch(/grep\s+-oE\s+'"msg":"\[\^"\]\*"'/);
  });
});
