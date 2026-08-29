import { describe, expect, it, vi } from 'vitest';
import {
  parseReconcileLaunchdRestartPolicyArgs,
  runReconcileLaunchdRestartPolicy,
} from '../../scripts/reconcile-launchd-restart-policy.ts';
import { LaunchdReconcileRefusedError } from '../../src/fleet/platform.ts';
import { LaunchdRenderConfigError } from '../../src/lib/launchd-service-config.ts';

function reconcileResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: 'com.whatsoup.agent-one',
    plistPath: '/safe/agent-one.plist',
    priorPlistExisted: true,
    dryRun: true,
    governedEnvDrift: { comparable: true, drift: [], droppedNonGovernedKeys: [] },
    ...overrides,
  };
}

async function runWith(
  argv: string[],
  reconcile: ReturnType<typeof vi.fn>,
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runReconcileLaunchdRestartPolicy(argv, {
    platform: 'darwin',
    reconcile,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

describe('reconcile-launchd-restart-policy CLI', () => {
  it('defaults to a non-mutating dry run for one valid instance', () => {
    expect(parseReconcileLaunchdRestartPolicyArgs(['--instance', 'agent-one'])).toEqual({
      instance: 'agent-one',
      apply: false,
      dropNonGovernedEnv: false,
      help: false,
    });
  });

  it('requires explicit apply and rejects duplicate or unsafe instance input', () => {
    expect(parseReconcileLaunchdRestartPolicyArgs(['--instance', 'agent-one', '--apply'])).toMatchObject({
      instance: 'agent-one',
      apply: true,
    });
    expect(() => parseReconcileLaunchdRestartPolicyArgs(['--instance', 'a', '--instance', 'b'])).toThrow('only once');
    expect(() => parseReconcileLaunchdRestartPolicyArgs(['--instance', '../agent'])).toThrow('invalid instance name');
  });

  it('accepts --drop-non-governed-env only together with --apply', () => {
    expect(parseReconcileLaunchdRestartPolicyArgs(['--instance', 'agent-one', '--apply', '--drop-non-governed-env'])).toMatchObject({
      apply: true,
      dropNonGovernedEnv: true,
    });
    expect(() => parseReconcileLaunchdRestartPolicyArgs(['--instance', 'agent-one', '--drop-non-governed-env']))
      .toThrow('--drop-non-governed-env requires --apply');
  });

  it('never prints an all-clear when the installed plist has non-governed keys an apply would drop', async () => {
    const reconcile = vi.fn().mockResolvedValue(reconcileResult({
      governedEnvDrift: {
        comparable: true,
        drift: [],
        droppedNonGovernedKeys: ['MINIMAX_API_KEY', 'WHATSOUP_HEALTH_TOKEN'],
      },
    }));

    const { code, stdout } = await runWith(['--instance', 'agent-one'], reconcile);

    expect(code).toBe(0);
    expect(stdout).toContain(
      'installed plist has 2 non-governed EnvironmentVariables keys (MINIMAX_API_KEY, WHATSOUP_HEALTH_TOKEN) that --apply will drop',
    );
    expect(stdout.some((line) => line.includes('no drift'))).toBe(false);
  });

  it('reports a satisfied configured prefix with a differing ambient tail as config-satisfied, not drift', async () => {
    const reconcile = vi.fn().mockResolvedValue(reconcileResult({
      governedEnvDrift: {
        comparable: true,
        drift: [],
        droppedNonGovernedKeys: [],
        pathPrefix: {
          configured: true,
          satisfied: true,
          ambientTailDiffers: true,
          expectedDigest: 'a'.repeat(64),
          observedDigest: 'b'.repeat(64),
        },
      },
    }));

    const { stdout } = await runWith(['--instance', 'agent-one'], reconcile);

    expect(stdout.some((line) => line.includes('PATH configured prefix satisfied') && line.includes("tail differs from this shell's PATH"))).toBe(true);
    expect(stdout.some((line) => line.includes('governed env drift'))).toBe(false);
    expect(stdout.some((line) => line === 'governed env: no drift')).toBe(false);
  });

  it('passes the acknowledgement through to the reconciler on apply', async () => {
    const reconcile = vi.fn().mockResolvedValue(reconcileResult({ dryRun: false }));

    await runWith(['--instance', 'agent-one', '--apply', '--drop-non-governed-env'], reconcile);

    expect(reconcile).toHaveBeenLastCalledWith('agent-one', { dryRun: false, dropNonGovernedEnv: true });
  });

  it('prints render-config and refusal messages verbatim but keeps other failures generic', async () => {
    const validation = vi.fn().mockRejectedValue(
      new LaunchdRenderConfigError("service.pathPrepend[0] must be an absolute directory path of at most 4096 characters without ':' or control characters"),
    );
    const refused = vi.fn().mockRejectedValue(
      new LaunchdReconcileRefusedError('installed plist has 1 non-governed EnvironmentVariables keys (WHATSOUP_HEALTH_TOKEN) that --apply will drop'),
    );
    const launchctl = vi.fn().mockRejectedValue(new Error('launchctl exploded at /private/detail'));

    const validationRun = await runWith(['--instance', 'agent-one'], validation);
    expect(validationRun.code).toBe(1);
    expect(validationRun.stderr.join('\n')).toContain('service.pathPrepend[0]');

    const refusedRun = await runWith(['--instance', 'agent-one', '--apply'], refused);
    expect(refusedRun.code).toBe(1);
    expect(refusedRun.stderr.join('\n')).toContain('WHATSOUP_HEALTH_TOKEN');

    const launchctlRun = await runWith(['--instance', 'agent-one', '--apply'], launchctl);
    expect(launchctlRun.code).toBe(1);
    expect(launchctlRun.stderr.join('\n')).toContain('reconciliation failed for agent-one');
    expect(launchctlRun.stderr.join('\n')).not.toContain('exploded');
  });

  it('does not invoke a reconciler on a non-macOS host', async () => {
    const reconcile = vi.fn();
    const stderr = vi.fn();

    await expect(runReconcileLaunchdRestartPolicy(['--instance', 'agent-one'], {
      platform: 'linux',
      reconcile,
      stdout: vi.fn(),
      stderr,
    })).resolves.toBe(2);

    expect(reconcile).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('macOS'));
  });

  it('delegates dry-run and apply modes to the existing-plist reconciler', async () => {
    const reconcile = vi.fn().mockResolvedValue({
      label: 'com.whatsoup.agent-one',
      plistPath: '/safe/agent-one.plist',
      priorPlistExisted: true,
      dryRun: true,
    });
    const stdout = vi.fn();
    const deps = { platform: 'darwin' as NodeJS.Platform, reconcile, stdout, stderr: vi.fn() };

    await expect(runReconcileLaunchdRestartPolicy(['--instance', 'agent-one'], deps)).resolves.toBe(0);
    expect(reconcile).toHaveBeenLastCalledWith('agent-one', { dryRun: true, dropNonGovernedEnv: false });

    await expect(runReconcileLaunchdRestartPolicy(['--instance', 'agent-one', '--apply'], deps)).resolves.toBe(0);
    expect(reconcile).toHaveBeenLastCalledWith('agent-one', { dryRun: false, dropNonGovernedEnv: false });
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('com.whatsoup.agent-one'));
  });

  it('prints governed-env drift by key and digest only', async () => {
    const reconcile = vi.fn().mockResolvedValue({
      label: 'com.whatsoup.agent-one',
      plistPath: '/safe/agent-one.plist',
      priorPlistExisted: true,
      dryRun: true,
      governedEnvDrift: {
        comparable: true,
        drift: [
          { key: 'PATH', state: 'mismatch', expectedDigest: 'a'.repeat(64), observedDigest: 'b'.repeat(64) },
          { key: 'CLAUDE_CONFIG_DIR', state: 'missing', expectedDigest: 'c'.repeat(64), observedDigest: null },
        ],
      },
    });
    const stdout = vi.fn();

    await expect(runReconcileLaunchdRestartPolicy(['--instance', 'agent-one'], {
      platform: 'darwin',
      reconcile,
      stdout,
      stderr: vi.fn(),
    })).resolves.toBe(0);

    const lines = stdout.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes('governed env drift: PATH mismatch'))).toBe(true);
    expect(lines.some((line) => line.includes('governed env drift: CLAUDE_CONFIG_DIR missing'))).toBe(true);
    expect(lines.some((line) => line.includes('a'.repeat(64).slice(0, 12)))).toBe(true);
  });

  it('reports an explicit all-clear when governed keys match', async () => {
    const reconcile = vi.fn().mockResolvedValue({
      label: 'com.whatsoup.agent-one',
      plistPath: '/safe/agent-one.plist',
      priorPlistExisted: true,
      dryRun: true,
      governedEnvDrift: { comparable: true, drift: [] },
    });
    const stdout = vi.fn();

    await runReconcileLaunchdRestartPolicy(['--instance', 'agent-one'], {
      platform: 'darwin',
      reconcile,
      stdout,
      stderr: vi.fn(),
    });

    const lines = stdout.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes('governed env: no drift'))).toBe(true);
  });

  it('surfaces an unparseable installed EnvironmentVariables dict as fail-closed drift', async () => {
    const reconcile = vi.fn().mockResolvedValue({
      label: 'com.whatsoup.agent-one',
      plistPath: '/safe/agent-one.plist',
      priorPlistExisted: true,
      dryRun: true,
      governedEnvDrift: {
        comparable: false,
        reason: 'environment-variables-unparseable',
        drift: [],
      },
    });
    const stdout = vi.fn();

    await runReconcileLaunchdRestartPolicy(['--instance', 'agent-one'], {
      platform: 'darwin',
      reconcile,
      stdout,
      stderr: vi.fn(),
    });

    const lines = stdout.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes('unparseable'))).toBe(true);
  });
});
