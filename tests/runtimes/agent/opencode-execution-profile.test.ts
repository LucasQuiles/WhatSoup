import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildOpenCodeRunArgs,
  openCodeAgentArgs,
  resolveOpenCodeExecutionProfile,
} from '../../../src/runtimes/agent/providers/opencode-execution-profile.ts';

interface PolicyRule {
  pattern: string;
  action: 'allow' | 'deny';
}

interface HeadlessPolicy {
  profile: string;
  artifactKind: string;
  deployable: boolean;
  selector: string;
  runtime: {
    supportedVersions: string[];
    workspaceBinding: {
      status: string;
      placeholder: string;
      permissionPattern: string;
      exactRuntimePathRequired: boolean;
      interpolationOrCompositionVerified: boolean;
    };
    homeBinding: {
      status: string;
      placeholder: string;
      exactRuntimePathRequired: boolean;
      interpolationOrCompositionVerified: boolean;
    };
  };
  permissions: {
    read: PolicyRule[];
    edit: PolicyRule[];
    bash: PolicyRule[];
    tools: Record<string, string>;
  };
  claims: {
    dispatcherPolicyOnly: boolean;
    operatingSystemSandbox: boolean;
    installedRuntimeCapability: boolean;
  };
}

const PROFILE_CONFIG = { executionProfile: 'whatsoup-headless' };

function occurrences(args: string[], value: string): number {
  return args.filter((arg) => arg === value).length;
}

function loadPolicy(): HeadlessPolicy {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), 'docs/reliability-runner/opencode-headless-policy.json'), 'utf8'),
  ) as HeadlessPolicy;
}

describe('OpenCode execution profile', () => {
  it('resolves a safe configured profile and emits one explicit selector', () => {
    expect(resolveOpenCodeExecutionProfile(PROFILE_CONFIG)).toBe('whatsoup-headless');
    expect(openCodeAgentArgs(PROFILE_CONFIG)).toEqual(['--agent', 'whatsoup-headless']);
  });

  it.each([undefined, null, '', '   ', '--auto', 'nested/profile', 'name with spaces'])(
    'rejects unsafe executionProfile %j',
    (executionProfile) => {
      expect(() => resolveOpenCodeExecutionProfile({ executionProfile })).toThrow(/executionProfile/);
    },
  );

  it('keeps an absent profile report-only during the first source rollout', () => {
    expect(openCodeAgentArgs(undefined)).toEqual([]);
    expect(openCodeAgentArgs({})).toEqual([]);
  });

  it('selects the configured profile exactly once on fresh and resumed turns', () => {
    const fresh = buildOpenCodeRunArgs({
      providerConfig: PROFILE_CONFIG,
      model: 'glm/glm-5.2',
      prompt: 'fresh turn',
    });
    const resumed = buildOpenCodeRunArgs({
      providerConfig: PROFILE_CONFIG,
      sessionId: 'session-123',
      model: 'glm/glm-5.2',
      prompt: 'resumed turn',
    });

    expect(fresh).toEqual([
      'run', '--format', 'json', '--pure',
      '--agent', 'whatsoup-headless',
      '-m', 'glm/glm-5.2',
      'fresh turn',
    ]);
    expect(resumed).toEqual([
      'run', '--format', 'json', '--pure',
      '--agent', 'whatsoup-headless',
      '--session', 'session-123',
      '-m', 'glm/glm-5.2',
      'resumed turn',
    ]);
    for (const args of [fresh, resumed]) {
      expect(occurrences(args, '--agent')).toBe(1);
      expect(args).not.toContain('--auto');
    }
  });

  it('keeps the explicit profile while custom-endpoint routing omits -m', () => {
    const args = buildOpenCodeRunArgs({
      providerConfig: {
        ...PROFILE_CONFIG,
        baseUrl: 'https://endpoint.example/v1',
      },
      model: 'endpoint-model',
      prompt: 'probe',
    });

    expect(occurrences(args, '--agent')).toBe(1);
    expect(args).toContain('whatsoup-headless');
    expect(args).not.toContain('-m');
  });
});

describe('versioned whatsoup-headless policy contract', () => {
  it('is an explicitly non-deployable exact-workspace template with no installed-version claim', () => {
    const policy = loadPolicy();

    expect(policy.profile).toBe('whatsoup-headless');
    expect(policy.selector).toBe('--agent');
    expect(policy.artifactKind).toBe('non_deployable_template');
    expect(policy.deployable).toBe(false);
    expect(policy.runtime.supportedVersions).toEqual([]);
    expect(policy.runtime.workspaceBinding).toEqual({
      status: 'unresolved',
      placeholder: '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__',
      permissionPattern: '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/*',
      exactRuntimePathRequired: true,
      interpolationOrCompositionVerified: false,
    });
    expect(policy.runtime.homeBinding).toEqual({
      status: 'unresolved',
      placeholder: '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__',
      exactRuntimePathRequired: true,
      interpolationOrCompositionVerified: false,
    });
    expect(policy).not.toHaveProperty('model');
    expect(JSON.stringify(policy)).not.toContain('"pattern":"~/');
  });

  it('allows workspace read/edit and bash non-interactively while retaining exact hard denies', () => {
    const policy = loadPolicy();
    const workspacePattern = policy.runtime.workspaceBinding.permissionPattern;
    const allowedRead = policy.permissions.read.filter((rule) => rule.action === 'allow');
    const allowedEdit = policy.permissions.edit.filter((rule) => rule.action === 'allow');
    const readDenies = policy.permissions.read
      .filter((rule) => rule.action === 'deny')
      .map((rule) => rule.pattern);
    const editDenies = policy.permissions.edit
      .filter((rule) => rule.action === 'deny')
      .map((rule) => rule.pattern);
    const bashDenies = policy.permissions.bash
      .filter((rule) => rule.action === 'deny')
      .map((rule) => rule.pattern);

    expect(allowedRead).toEqual([{ pattern: workspacePattern, action: 'allow' }]);
    expect(allowedEdit).toEqual([{ pattern: workspacePattern, action: 'allow' }]);
    expect(readDenies).toEqual(expect.arrayContaining([
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.git',
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.git/*',
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.aws',
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.aws/*',
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.ssh',
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.ssh/*',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.config/opencode',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.config/opencode/*',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.config/opencode/agents',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.config/opencode/agents/*',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.config/secrets',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.config/secrets/*',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.ssh',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.ssh/*',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/Library/Keychains',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/Library/Keychains/*',
    ]));
    expect(editDenies).toEqual(expect.arrayContaining([
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.config/opencode',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.config/opencode/*',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.config/opencode/agents',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.config/opencode/agents/*',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.config/gh',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.config/gh/*',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.config/secrets',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.config/secrets/*',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.ssh',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.ssh/*',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/Library/Keychains',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/Library/Keychains/*',
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.git',
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.git/*',
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.github',
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.github/*',
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.aws',
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.aws/*',
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.env*',
    ]));
    for (const directory of [
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.git',
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.github',
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.aws',
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.azure',
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.config/gcloud',
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.docker',
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.gnupg',
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.kube',
      '__WHATSOUP_RUNTIME_WORKSPACE_UNRESOLVED__/.ssh',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.config/opencode',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.config/opencode/agents',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.config/gh',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.config/secrets',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/.ssh',
      '__WHATSOUP_RUNTIME_HOME_UNRESOLVED__/Library/Keychains',
    ]) {
      expect(readDenies, `read must deny ${directory}`).toContain(directory);
      expect(readDenies, `read must deny ${directory} descendants`).toContain(`${directory}/*`);
      expect(editDenies, `edit must deny ${directory}`).toContain(directory);
      expect(editDenies, `edit must deny ${directory} descendants`).toContain(`${directory}/*`);
    }
    expect(policy.permissions.bash[0]).toEqual({ pattern: '*', action: 'allow' });
    expect(bashDenies).toEqual([
      'sudo *',
      'git push*',
      'gh *',
      'ssh *',
      'scp *',
      'tailscale *',
      'ufw *',
    ]);
    expect(policy.permissions.tools).toEqual({
      question: 'deny',
      task: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      external_directory: 'deny',
    });
    expect([...policy.permissions.read, ...policy.permissions.edit, ...policy.permissions.bash])
      .not.toContainEqual(expect.objectContaining({ action: 'ask' }));
  });

  it('states the Layer-2 and installed-capability limitations', () => {
    expect(loadPolicy().claims).toEqual({
      dispatcherPolicyOnly: true,
      operatingSystemSandbox: false,
      installedRuntimeCapability: false,
    });
  });
});
