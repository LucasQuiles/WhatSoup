import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const packageJson = JSON.parse(readFileSync(
  new URL('../../package.json', import.meta.url),
  'utf8',
)) as { scripts: Record<string, string> };

let homeDir: string;

function configDir(): string {
  return join(homeDir, '.config', 'whatsoup');
}

function silencesFile(): string {
  return join(configDir(), 'fleet-silences.json');
}

async function importCli(): Promise<typeof import('../../scripts/fleet-silence-reset.ts')> {
  return import('../../scripts/fleet-silence-reset.ts');
}

function captureRun(
  run: (argv: string[]) => number,
  argv: string[],
): { exitCode: number; output: Record<string, unknown>; text: string } {
  const write = vi.spyOn(process.stdout, 'write')
    .mockImplementation((() => true) as typeof process.stdout.write);
  try {
    const exitCode = run(argv);
    const text = write.mock.calls.map(([chunk]) => String(chunk)).join('');
    return { exitCode, output: JSON.parse(text) as Record<string, unknown>, text };
  } finally {
    write.mockRestore();
  }
}

describe('fleet-silence-reset CLI', () => {
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'whatsoup-silence-reset-'));
    vi.resetModules();
    vi.doMock('node:os', async (importOriginal: () => Promise<typeof import('node:os')>) => {
      const actual = await importOriginal();
      return { ...actual, homedir: () => homeDir };
    });
  });

  afterEach(() => {
    vi.doUnmock('../../src/fleet/silence-manager.ts');
    vi.doUnmock('node:os');
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('is exposed through the pinned operator script', () => {
    expect(packageJson.scripts['fleet-silence-reset']).toBe(
      'bash scripts/run-with-pinned-node.sh scripts/fleet-silence-reset.ts',
    );
  });

  it('is dry-run by default and requires the inspected exact revision to reset', async () => {
    mkdirSync(configDir(), { recursive: true });
    const marker = '{corrupt-registry-marker';
    writeFileSync(silencesFile(), marker, { mode: 0o600 });
    const { runFleetSilenceResetCli } = await importCli();

    const dryRun = captureRun(runFleetSilenceResetCli, []);

    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.output).toMatchObject({
      schema_version: 1,
      operation: 'fleet_silence_reset',
      outcome: 'dry_run',
      effects: {
        read_only: true,
        destructive: true,
        idempotent: false,
        open_world: false,
        supports_dry_run: true,
      },
      registry: {
        state: 'ready',
        reason_class: 'invalid_json',
        revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
    expect(dryRun.text).not.toContain(marker);
    expect(readFileSync(silencesFile(), 'utf8')).toBe(marker);
    expect(existsSync(join(configDir(), 'fleet-silence-quarantine'))).toBe(false);

    const revision = String((dryRun.output.registry as Record<string, unknown>).revision);
    const applied = captureRun(runFleetSilenceResetCli, ['--confirm-reset', revision]);

    expect(applied.exitCode).toBe(0);
    expect(applied.output).toMatchObject({
      schema_version: 1,
      operation: 'fleet_silence_reset',
      outcome: 'verified',
      effects: { read_only: false, destructive: true, supports_dry_run: true },
      receipt: {
        prior_revision: revision,
        next_revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
    expect(applied.text).not.toContain(marker);
    expect(readFileSync(silencesFile(), 'utf8')).toBe('[]\n');
    const quarantine = readdirSync(join(configDir(), 'fleet-silence-quarantine'));
    expect(quarantine).toHaveLength(1);
    expect(readFileSync(join(configDir(), 'fleet-silence-quarantine', quarantine[0]!), 'utf8')).toBe(marker);
  });

  it('keeps a blocked valid-registry inspection genuinely read-only', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(silencesFile(), JSON.stringify([{
      instance: 'maintenance-line',
      until: new Date(Date.now() + 60_000).toISOString(),
      reason: 'maintenance',
      silencedBy: 'operator',
      createdAt: new Date().toISOString(),
    }]), { mode: 0o600 });
    const { runFleetSilenceResetCli } = await importCli();

    const blocked = captureRun(runFleetSilenceResetCli, []);

    expect(blocked.exitCode).toBe(3);
    expect(blocked.output).toMatchObject({
      outcome: 'blocked',
      effects: { read_only: true },
      registry: { state: 'blocked', availability: 'observed', read_basis: 'current' },
    });
    expect(existsSync(join(configDir(), 'fleet-silence-registry-state.json'))).toBe(false);
    expect(existsSync(join(configDir(), 'fleet-silence-repair-receipts.jsonl'))).toBe(false);
    expect(existsSync(join(configDir(), 'fleet-silence-quarantine'))).toBe(false);
  });

  it('reports an attempted reset failure as non-read-only inconclusive rather than blocked', async () => {
    class ResetPreconditionError extends Error {}
    const revision = `sha256:${'a'.repeat(64)}`;
    vi.doMock('../../src/fleet/silence-manager.ts', () => ({
      SilenceRegistryResetPreconditionError: ResetPreconditionError,
      inspectSilenceRegistryReset: vi.fn(() => ({
        state: 'ready',
        revision,
        reasonClass: 'invalid_json',
      })),
      resetInvalidSilenceRegistry: vi.fn(() => {
        throw new Error('post-publication verification failed');
      }),
    }));
    const { runFleetSilenceResetCli } = await importCli();

    const result = captureRun(runFleetSilenceResetCli, ['--confirm-reset', revision]);

    expect(result.exitCode).toBe(4);
    expect(result.output).toMatchObject({
      outcome: 'inconclusive',
      effects: { read_only: false },
      error: { kind: 'reset_not_completed' },
    });
    expect(result.text).not.toContain('post-publication verification failed');
  });
});
