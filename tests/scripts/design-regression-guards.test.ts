import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(process.cwd(), 'console/scripts/design-regression.sh');

function runScript() {
  return spawnSync('bash', [SCRIPT], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

function checkBlock(output: string, checkNumber: number): string {
  const start = output.indexOf(`--- Check ${checkNumber}:`);
  const next = output.indexOf(`--- Check ${checkNumber + 1}:`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  return output.slice(start, next === -1 ? undefined : next);
}

describe('design-regression.sh guard contracts', () => {
  it('keeps the promoted blocking check list explicit', () => {
    const source = readFileSync(SCRIPT, 'utf8');

    expect(source).toContain('EXIT_ON_FAIL=(1 2 6 8 10 12 13 14 15 16 17)');
  });

  it('reports zero focus-suppression hits as a clean blocking PASS', () => {
    const result = runScript();
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).not.toContain('integer expected');
    expect(output).toContain('Blocking checks: 1 2 6 8 10 12 13 14 15 16 17 (all PASS)');

    const check12 = checkBlock(output, 12);
    expect(check12).toContain('outline-none without focus-visible: count: 0');
    expect(check12).toContain('PASS  count=0  (zero focus suppression sites)');
  });
});
