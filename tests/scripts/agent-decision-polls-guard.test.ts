import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkAgentDecisionPolls, run } from '../../scripts/agent-decision-polls-guard.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixtureDirs: string[] = [];

function makeFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-agent-polls-guard-'));
  fixtureDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('agent decision polls guard', () => {
  it('passes for the tracked repository contract', () => {
    const result = run([], repoRoot);

    expect(process.exitCode).toBeUndefined();
    expect(result).toEqual({ ok: true, findings: [] });
  });

  it('reports missing protocol anchors with actionable file names', () => {
    const fixture = makeFixture();
    mkdirSync(path.join(fixture, 'src/runtimes/agent'), { recursive: true });
    writeFileSync(path.join(fixture, 'src/runtimes/agent/session.ts'), 'const placeholder = true;\n');
    writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ scripts: {} }, null, 2));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = run([], fixture);

    expect(process.exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining('src/runtimes/agent/session.ts'),
      expect.stringContaining('package.json: missing guard:agent-decision-polls script'),
    ]));
    expect(error.mock.calls.flat().join('\n')).toContain('agent decision polls guard failed');
  });

  it('verify chains invoke the protocol guard before expensive test phases', () => {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    for (const scriptName of ['verify:push:branch', 'verify:release', 'verify:publish']) {
      const chain = packageJson.scripts[scriptName];
      expect(chain, `${scriptName} script must exist`).toBeDefined();
      expect(chain).toMatch(/\bnpm run guard:agent-decision-polls\b/);
      const guardIndex = chain.indexOf('npm run guard:agent-decision-polls');
      const testIndex = chain.indexOf('npm test');
      if (testIndex >= 0) expect(guardIndex).toBeLessThan(testIndex);
    }
  });

  it('exposes a direct checker for automation without mutating process.exitCode', () => {
    const result = checkAgentDecisionPolls(repoRoot);

    expect(process.exitCode).toBeUndefined();
    expect(result.ok).toBe(true);
  });
});
