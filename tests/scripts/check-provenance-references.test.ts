import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('check-provenance-references', () => {
  const scriptPath = new URL('../../scripts/check-provenance-references.ts', import.meta.url).pathname;

  function runScript(content: string): { stdout: string; exitCode?: number } {
    const tmp = mkdtempSync(join(tmpdir(), 'provenance-'));
    const f = join(tmp, 'input.txt');
    writeFileSync(f, content);
    const nodeBin = process.execPath;
    try {
      const stdout = execFileSync(nodeBin, ['--experimental-strip-types', scriptPath, f], {
        encoding: 'utf8',
        maxBuffer: 2048,
        timeout: 30_000,
      });
      return { stdout };
    } catch (e: unknown) {
      const err = e as { stdout?: string; status?: number; stderr?: string };
      return { stdout: err.stdout ?? '', exitCode: err.status };
    }
  }

  it('passes on valid PR reference (discriminating, #2950)', () => {
    const r = runScript('Refs #2200 — clock migration');
    expect(r.stdout).toContain('OK');
  });

  it('fails on phantom PR reference (discriminating, #2950)', () => {
    const r = runScript('Refs #9999999 — phantom reference');
    expect(r.exitCode).toBe(1);
  });

  it('fails on oc-re/ reference outside triage-narrative', () => {
    const r = runScript('See also: oc-re/phantom-ref');
    expect(r.exitCode).toBe(1);
  });

  it('passes on oc-re/ inside triage-narrative context', () => {
    const r = runScript('(triage-narrative: oc-re/resolved)');
    expect(r.stdout).toContain('OK');
  });
});
