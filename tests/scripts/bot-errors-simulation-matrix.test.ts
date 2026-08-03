import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BOT_ERRORS_SIMULATION_MATRIX,
  checkBotErrorsSimulationMatrix,
  run,
  type BotErrorsSimulationDomain,
} from '../../scripts/bot-errors-simulation-matrix.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { BRANCH_STEPS, RELEASE_STEPS } from '../../scripts/push-gate.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const tmp = trackTmpDirs('whatsoup-bot-errors-');

function makeFixture(): string {
  return tmp.make('matrix');
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('bot-errors simulation matrix guard', () => {
  it('passes for the tracked repository contract', () => {
    const result = run([], repoRoot);

    expect(process.exitCode).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.checked).toBe(BOT_ERRORS_SIMULATION_MATRIX.length);
  });

  it('covers every reliability domain required for unattended BOT ERRORS operation', () => {
    const domains = new Set(BOT_ERRORS_SIMULATION_MATRIX.map(row => row.domain));
    const required: BotErrorsSimulationDomain[] = [
      'provider-runtime',
      'whatsapp-auth-bond',
      'bot-errors-delivery',
      'supervision-orchestration',
      'fleet-recovery',
    ];

    for (const domain of required) expect(domains.has(domain)).toBe(true);
    expect(BOT_ERRORS_SIMULATION_MATRIX.filter(row => row.risk === 'critical').length).toBeGreaterThanOrEqual(9);
  });

  it('wires the simulation matrix guard into branch and release verification after source-runtime drift checks', () => {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    for (const scriptName of ['verify:push:branch', 'verify:release']) {
      const chain = scriptName === 'verify:push:branch'
        ? BRANCH_STEPS.map((step) => step.cmd).join(' && ')
        : RELEASE_STEPS.map((step) => step.cmd).join(' && ');
      expect(chain, `${scriptName} script must exist`).toBeDefined();
      expect(chain).toMatch(/\bnpm run guard:bot-errors-simulation-matrix\b/);
      expect(chain.indexOf('npm run guard:source-runtime-drift')).toBeLessThan(
        chain.indexOf('npm run guard:bot-errors-simulation-matrix'),
      );
      expect(chain).not.toMatch(/\bnpm run guard:bot-errors-critical-surfaces\b/);
    }
  });

  it('reports missing simulation anchors with actionable row and file names', () => {
    const fixture = makeFixture();
    mkdirSync(path.join(fixture, 'tests/runtimes/agent'), { recursive: true });
    writeFileSync(path.join(fixture, 'tests/runtimes/agent/provider-fallback.test.ts'), 'placeholder\n');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = run([], fixture);

    expect(process.exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining('provider-fallback-state-machine'),
      expect.stringContaining('tests/runtimes/agent/provider-fallback.test.ts'),
    ]));
    expect(error.mock.calls.flat().join('\n')).toContain('BOT ERRORS simulation matrix guard failed');
  });

  it('exposes a direct checker for automation without mutating process.exitCode', () => {
    const result = checkBotErrorsSimulationMatrix(repoRoot);

    expect(process.exitCode).toBeUndefined();
    expect(result.ok).toBe(true);
  });
});
