import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateInstanceConfig } from '../../src/core/agent-config-validator.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const repoRoot = resolve('.');
const node = process.execPath;
const projectionPath = join(repoRoot, 'deploy/m365-bridge-credential-projection.ts');
const wrapperPath = join(repoRoot, 'deploy/whatsoup');
const tmp = trackTmpDirs('m365-bridge-projection');

const tenantId = '11111111-2222-3333-4444-555555555555';
const accountEmail = 'user@example.test';
const origin = 'https://127.0.0.1:10000';

function qualifiedConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'bridge-agent',
    type: 'agent',
    accessMode: 'self_only',
    adminPhones: ['15551234567'],
    agentOptions: {
      sessionScope: 'single',
      provider: 'claude-cli',
      allowM365Mutations: true,
      enabledPlugins: { 'microsoft_365@microsoft-365-dev': true },
      m365Bridge: {
        tenantId,
        accountEmail,
        origin,
        profile: 'user-full-v1',
      },
      ...overrides,
    },
  };
}

function qualifiedBridgeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ALLOW_M365_MUTATIONS: '1',
    MS365_AGENT365_BRIDGE: 'true',
    MS365_AGENT365_BASE_URL: origin,
    MS365_AGENT365_ACCOUNT_EMAIL: accountEmail,
    MS365_TENANT_ID: tenantId,
    MS365_PROFILE: 'user-full-v1',
    MS365_HUB_URL: origin,
    ...overrides,
  };
}

function namedConfig(name: string): Record<string, unknown> {
  return { ...qualifiedConfig(), name };
}

function writeConfig(root: string, config: Record<string, unknown>): string {
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  return configPath;
}

function runProjection(
  instance: string,
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  args: string[] = [],
): SpawnSyncReturns<string> {
  const root = tmp.make('projection-probe');
  const configPath = writeConfig(root, config);
  return runProjectionFile(instance, configPath, env, args);
}

function runProjectionFile(
  instance: string,
  configPath: string,
  env: NodeJS.ProcessEnv,
  args: string[] = [],
  preload?: string,
): SpawnSyncReturns<string> {
  return spawnSync(node, [
    '--disable-warning=ExperimentalWarning',
    '--experimental-strip-types',
    ...(preload ? ['--import', preload] : []),
    projectionPath,
    instance,
    configPath,
    ...args,
  ], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, ...env },
  });
}

describe('deploy/m365-bridge-credential-projection.ts', () => {
  it.each(['file-mode', 'parent-mode', 'oversize', 'ancestor-symlink', 'hard-link'])(
    'refuses unsafe config %s before authorizing credential lookup', (kind) => {
      const root = tmp.make('projection-boundary');
      const ancestor = join(root, 'inputs');
      const dir = join(ancestor, 'instance');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = writeConfig(dir, qualifiedConfig());
      if (kind === 'file-mode') chmodSync(path, 0o644);
      else if (kind === 'parent-mode') chmodSync(dir, 0o755);
      else if (kind === 'oversize') writeFileSync(path, JSON.stringify({ ...qualifiedConfig(), padding: 'x'.repeat(1024 * 1024) }));
      else if (kind === 'hard-link') linkSync(path, join(root, 'linked-config.json'));
      else {
        renameSync(ancestor, join(root, 'original-inputs'));
        symlinkSync(join(root, 'original-inputs'), ancestor);
      }
      const result = runProjectionFile('bridge-agent', path, qualifiedBridgeEnv());
      expect(result.status, result.stderr).toBe(3);
      expect(result.stdout).toBe('');
    },
  );

  it('refuses admission if config is replaced after the descriptor opens', () => {
    const root = tmp.make('projection-race');
    const path = writeConfig(root, qualifiedConfig());
    const marker = join(root, 'replaced');
    const preload = join(root, 'replace-config.mjs');
    writeFileSync(preload, [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'const originalOpen = fs.openSync;',
      'let changed = false;',
      'fs.openSync = (path, ...args) => {',
      '  const fd = originalOpen(path, ...args);',
      `  if (path === ${JSON.stringify(path)} && !changed) {`,
      '    changed = true;',
      `    fs.renameSync(path, ${JSON.stringify(join(root, 'original.json'))});`,
      `    fs.writeFileSync(path, fs.readFileSync(${JSON.stringify(join(root, 'original.json'))}), { mode: 0o600 });`,
      `    fs.writeFileSync(${JSON.stringify(marker)}, 'replaced');`,
      '  }',
      '  return fd;',
      '};',
      'syncBuiltinESMExports();',
    ].join('\n'));
    const result = runProjectionFile('bridge-agent', path, qualifiedBridgeEnv({
      MS365_AGENT365_API_KEY: 'synthetic-bridge-key',
    }), ['--credential-admission', String(process.pid)], preload);
    expect(readFileSync(marker, 'utf8')).toBe('replaced');
    expect(result.status, result.stderr).toBe(3);
    expect(result.stdout).toBe('');
  });

  it('emits only a digest after credential lookup for the supplied exec process', () => {
    const result = runProjection('bridge-agent', qualifiedConfig(), qualifiedBridgeEnv({
      MS365_AGENT365_API_KEY: 'synthetic-bridge-key',
    }), ['--credential-admission', String(process.pid)]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^[0-9a-f]{64}$/);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('synthetic-bridge-key');
  });

  it.each(['0', '-1', '1.5', '01', '9007199254740992'])('refuses an invalid exec process %s', (pid) => {
    const result = runProjection('bridge-agent', qualifiedConfig(), qualifiedBridgeEnv({
      MS365_AGENT365_API_KEY: 'synthetic-bridge-key',
    }), ['--credential-admission', pid]);
    expect(result.status, result.stderr).toBe(3);
    expect(result.stdout).toBe('');
  });

  it('does not issue an admission when the credential is unavailable', () => {
    const result = runProjection('bridge-agent', qualifiedConfig(), qualifiedBridgeEnv({
      MS365_AGENT365_API_KEY: undefined,
    }), ['--credential-admission', String(process.pid)]);
    expect(result.status, result.stderr).toBe(3);
    expect(result.stdout).toBe('');
  });

  it.each(['../other', 'nested/agent', 'white space', 'Uppercase', 'a'.repeat(31)])('rejects unsafe instance name %s', (instance) => {
    const result = runProjection(instance, namedConfig(instance), qualifiedBridgeEnv());
    expect(result.status, result.stderr).toBe(3);
  });

  it.each(['bridge-agent', 'second-agent'])('admits %s only with its complete binding before lookup', (instance) => {
    const result = runProjection(instance, namedConfig(instance), qualifiedBridgeEnv());

    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ['a mismatched config name', 'other-bot', namedConfig('bridge-agent'), qualifiedBridgeEnv()],
    ['a non-agent config', 'bridge-agent', { ...qualifiedConfig(), type: 'passive' }, qualifiedBridgeEnv()],
    ['a config without an agent binding envelope', 'bridge-agent', { name: 'bridge-agent', type: 'agent' }, qualifiedBridgeEnv()],
    ['wrong selector', 'bridge-agent', qualifiedConfig(), qualifiedBridgeEnv({ MS365_AGENT365_ACCOUNT_EMAIL: 'other@custom-domain.example' })],
    ['wrong tenant', 'bridge-agent', qualifiedConfig(), qualifiedBridgeEnv({ MS365_TENANT_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })],
    ['wrong origin', 'bridge-agent', qualifiedConfig(), qualifiedBridgeEnv({ MS365_HUB_URL: 'https://127.0.0.1:10001' })],
    ['wrong profile', 'bridge-agent', qualifiedConfig(), qualifiedBridgeEnv({ MS365_PROFILE: 'diagnostic-read' })],
  ])('rejects %s before credential lookup', (_case, instance, config, env) => {
    const result = runProjection(instance, config, env);

    expect(result.status, result.stderr).toBe(3);
  });
});

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

interface LauncherResult {
  status: number;
  stderr: string;
  lookupLog: string;
  parent?: string | null;
  policy?: string | null;
  primary?: string | null;
  fallback?: string | null;
  m365Denied?: boolean;
  admissionParent?: string | null;
  admissionForwarded?: string | null;
}

function runLauncher(
  instance: string,
  config: Record<string, unknown>,
  bridgeEnv: NodeJS.ProcessEnv,
  credential: 'file' | 'missing' | 'unsafe' = 'file',
  credentialOwner: string = instance,
  configShape: 'regular' | 'symlink' | 'parent-symlink' | 'directory' = 'regular',
  launcherMode: 'current' | 'legacy' | 'direct' | 'forked' | 'replaced-key' = 'current',
): LauncherResult {
  const root = tmp.make('launcher-probe');
  const bin = join(root, 'bin');
  const configHome = join(root, 'config');
  const instanceDir = join(configHome, 'whatsoup', 'instances', instance);
  const credentials = join(configHome, 'whatsoup', 'credentials');
  const resultPath = join(root, 'result.json');
  const lookupLog = join(root, 'keyring.log');
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(instanceDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(instanceDir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  if (configShape === 'symlink') {
    const target = join(root, 'redirected-config.json');
    renameSync(join(instanceDir, 'config.json'), target);
    symlinkSync(target, join(instanceDir, 'config.json'));
  } else if (configShape === 'parent-symlink') {
    const target = join(root, 'redirected-instance');
    renameSync(instanceDir, target);
    symlinkSync(target, instanceDir);
  } else if (configShape === 'directory') {
    renameSync(join(instanceDir, 'config.json'), join(root, 'saved-config.json'));
    mkdirSync(join(instanceDir, 'config.json'));
  }
  if (credential !== 'missing') {
    mkdirSync(credentials, { recursive: true, mode: 0o700 });
    const credentialPath = join(credentials, `agent365-${credentialOwner}.key`);
    if (credential === 'unsafe') {
      const target = join(root, 'agent365-target.key');
      writeFileSync(target, 'synthetic-bridge-key\n', { mode: 0o600 });
      symlinkSync(target, credentialPath);
    } else {
      writeFileSync(credentialPath, 'synthetic-bridge-key\n', { mode: 0o600 });
    }
  }
  const security = join(bin, 'security');
  writeFileSync(security, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$LOOKUP_LOG"
exit 44
`, { mode: 0o700 });
  chmodSync(security, 0o700);

  const probe = join(root, 'probe.ts');
  writeFileSync(probe, [
    "import { writeFileSync } from 'node:fs';",
    `import { resolveM365MutationPolicy } from ${JSON.stringify(resolve('src/core/m365-bridge-policy.ts'))};`,
    `import { buildChildEnv } from ${JSON.stringify(resolve('src/runtimes/agent/session.ts'))};`,
    `import { applyRequiredDeny, M365_MUTATION_DENY } from ${JSON.stringify(resolve('src/core/settings-template.ts'))};`,
    `const config = JSON.parse(process.env.FIXTURE_CONFIG ?? '{}');`,
    'const options = config.agentOptions ?? {};',
    'const policy = resolveM365MutationPolicy({',
    '  instanceName: config.name,',
    '  provider: options.provider,',
    '  allowM365Mutations: options.allowM365Mutations,',
    '  enabledPlugins: options.enabledPlugins,',
    '  binding: options.m365Bridge,',
    '});',
    "const primary = buildChildEnv('claude-cli', { m365MutationPolicy: policy });",
    "const fallback = buildChildEnv('opencode-cli', { m365MutationPolicy: policy }, 'opencode/synthetic');",
    `writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({`,
    '  parent: process.env.MS365_AGENT365_API_KEY ?? null,',
    '  admissionParent: process.env.WHATSOUP_M365_LAUNCH_ADMISSION ?? null,',
    '  policy: policy?.status ?? null,',
    '  primary: primary.MS365_AGENT365_API_KEY ?? null,',
    '  fallback: fallback.MS365_AGENT365_API_KEY ?? null,',
    '  admissionForwarded: primary.WHATSOUP_M365_LAUNCH_ADMISSION ?? fallback.WHATSOUP_M365_LAUNCH_ADMISSION ?? null,',
    '  m365Denied: M365_MUTATION_DENY.every((entry) => applyRequiredDeny([], policy).includes(entry)),',
    '}), { mode: 0o600 });',
    '',
  ].join('\n'), { mode: 0o600 });

  const source = readFileSync(wrapperPath, 'utf8');
  const script = join(root, 'launcher-probe.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    ...(!['legacy', 'direct'].includes(launcherMode) ? [
      `INSTANCE=${JSON.stringify(instance)}`,
      sliceBetween(source, '_DISTILL_CAPTURE_DEEPSEEK=', '\n# Pinned Node path'),
      `NODE=${JSON.stringify(node)}`,
      `SCRIPT_DIR=${JSON.stringify(resolve('deploy'))}`,
      `REPO_ROOT=${JSON.stringify(repoRoot)}`,
      `. ${JSON.stringify(resolve('deploy/lib/bounded-exec.sh'))}`,
      sliceBetween(source, '# Detect instance type', '\n# Health server auth token'),
    ] : [`NODE=${JSON.stringify(node)}`]),
    ...(launcherMode === 'replaced-key' ? ['export MS365_AGENT365_API_KEY=replaced-after-admission'] : []),
    `${launcherMode === 'forked' ? '' : 'exec '}"$NODE" --disable-warning=ExperimentalWarning --experimental-strip-types ${JSON.stringify(probe)}`,
    '',
  ].join('\n'), { mode: 0o700 });
  chmodSync(script, 0o700);

  const result = spawnSync(launcherMode === 'direct' ? node : '/bin/bash',
    launcherMode === 'direct'
      ? ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', probe]
      : [script], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: root,
      USER: 'fixture-user',
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: join(root, 'data'),
      TMPDIR: root,
      LOOKUP_LOG: lookupLog,
      FIXTURE_CONFIG: JSON.stringify(config),
      MS365_AGENT365_API_KEY: 'ambient-key-must-be-scrubbed',
      WHATSOUP_M365_LAUNCH_ADMISSION: 'ambient-admission-must-be-scrubbed',
      ...bridgeEnv,
    },
  });
  const parsed = existsSync(resultPath)
    ? JSON.parse(readFileSync(resultPath, 'utf8')) as Omit<LauncherResult, 'status' | 'stderr' | 'lookupLog'>
    : {};
  return {
    status: result.status ?? -1,
    stderr: result.stderr ?? '',
    lookupLog: existsSync(lookupLog) ? readFileSync(lookupLog, 'utf8') : '',
    ...parsed,
  };
}

describe('deploy/whatsoup instance bridge credential projection', () => {
  it.each(['http://127.0.0.1:10000', 'http://[::1]:10000'])(
    'rejects an HTTP binding before looking up a credential: %s', (insecureOrigin) => {
      const config = qualifiedConfig({
        m365Bridge: { tenantId, accountEmail, origin: insecureOrigin, profile: 'user-full-v1' },
      });
      const result = runLauncher('bridge-agent', config, qualifiedBridgeEnv({
        MS365_AGENT365_BASE_URL: insecureOrigin, MS365_HUB_URL: insecureOrigin,
      }));
      expect(result.status, result.stderr).toBe(0);
      expect(result.lookupLog).not.toContain('agent365-bridge-agent');
      expect(result).toMatchObject({
        parent: null, policy: 'rejected', primary: null, fallback: null,
        admissionParent: null, admissionForwarded: null, m365Denied: true,
      });
      expect(validateInstanceConfig(config, { name: 'bridge-agent', mode: 'load' })).toMatchObject({
        field: 'agentOptions.m365Bridge.origin', status: 400,
      });
    },
  );

  it.each(['legacy', 'direct'] as const)('keeps the deny floor when a %s start inherits a bridge key without launcher admission', (mode) => {
    const result = runLauncher('bridge-agent', qualifiedConfig(), qualifiedBridgeEnv(), 'missing', 'bridge-agent', 'regular', mode);

    expect(result.status, result.stderr).toBe(0);
    expect(result.parent).toBe('ambient-key-must-be-scrubbed');
    expect(result.policy).toBe('rejected');
    expect(result.primary).toBeNull();
    expect(result.fallback).toBeNull();
    expect(result.m365Denied).toBe(true);
    expect(result.lookupLog).not.toContain('agent365-');
  });

  it.each(['forked', 'replaced-key'] as const)('rejects a %s launch after credential admission', (mode) => {
    const result = runLauncher('bridge-agent', qualifiedConfig(), qualifiedBridgeEnv(), 'file', 'bridge-agent', 'regular', mode);

    expect(result.status, result.stderr).toBe(0);
    expect(result.policy).toBe('rejected');
    expect(result.primary).toBeNull();
    expect(result.fallback).toBeNull();
    expect(result.m365Denied).toBe(true);
  });

  it('does not admit a non-regular configuration', () => {
    const result = runLauncher('bridge-agent', qualifiedConfig(), qualifiedBridgeEnv(), 'missing', 'bridge-agent', 'directory');
    expect(result.lookupLog).not.toContain('agent365-bridge-agent');
    expect(result.parent).toBeUndefined();
    expect(result.status).toBe(1);
  });

  it.each(['symlink', 'parent-symlink'] as const)('rejects %s configuration before any bridge credential lookup', (shape) => {
    const result = runLauncher('bridge-agent', qualifiedConfig(), qualifiedBridgeEnv(), 'missing', 'bridge-agent', shape);
    expect(result.lookupLog).not.toContain('agent365-bridge-agent');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FATAL: instance config admission refused');
    expect(result.parent).toBeUndefined();
    expect(result.primary).toBeUndefined();
  });

  it('cannot resolve another configured instance credential', () => {
    const result = runLauncher('bridge-agent', qualifiedConfig(), qualifiedBridgeEnv(), 'file', 'second-agent');
    expect(result.status).toBe(1);
    expect(result.lookupLog).not.toContain('agent365-second-agent');
    expect(result.parent).toBeUndefined();
    expect(result.stderr).toContain('FATAL: Agent365 bridge credential is empty or unavailable');
  });

  it.each(['../other', 'nested/agent', 'white space', 'Uppercase', 'a'.repeat(31)])('rejects %s before startup or credential access', (instance) => {
    const result = spawnSync('/bin/bash', [wrapperPath, instance], {
      encoding: 'utf8', timeout: 5_000,
      env: { ...process.env, HOME: tmp.make('invalid-name'), PATH: '/usr/bin:/bin' },
    });
    expect(result.status, result.stderr).toBe(64);
    expect(result.stderr).toContain('FATAL: invalid instance name');
  });

  it.each(['bridge-agent', 'second-agent'])('resolves only %s private credential and forwards it only to the primary child', (instance) => {
    const result = runLauncher(instance, namedConfig(instance), qualifiedBridgeEnv());

    expect(result.status, result.stderr).toBe(0);
    expect(result.lookupLog).not.toContain('agent365-bridge-agent');
    expect(result).toMatchObject({
      parent: 'synthetic-bridge-key',
      policy: 'approved',
      primary: 'synthetic-bridge-key',
      fallback: null,
      m365Denied: false,
      admissionForwarded: null,
    });
  });

  it.each([
    ['a mismatched config name', 'other-bot', namedConfig('bridge-agent'), qualifiedBridgeEnv()],
    ['a non-agent config', 'bridge-agent', { ...qualifiedConfig(), type: 'passive' }, qualifiedBridgeEnv()],
    ['selector mismatch', 'bridge-agent', qualifiedConfig(), qualifiedBridgeEnv({ MS365_AGENT365_ACCOUNT_EMAIL: 'other@custom-domain.example' })],
    ['tenant mismatch', 'bridge-agent', qualifiedConfig(), qualifiedBridgeEnv({ MS365_TENANT_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })],
    ['origin mismatch', 'bridge-agent', qualifiedConfig(), qualifiedBridgeEnv({ MS365_HUB_URL: 'https://127.0.0.1:10001' })],
    ['profile mismatch', 'bridge-agent', qualifiedConfig(), qualifiedBridgeEnv({ MS365_PROFILE: 'diagnostic-read' })],
  ])('does not read the instance credential for %s', (_case, instance, config, env) => {
    const result = runLauncher(instance, config, env);

    expect(result.lookupLog).not.toContain('agent365-bridge-agent');
    if (instance !== config.name) {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('FATAL: instance config admission refused');
      expect(result.parent).toBeUndefined();
    } else {
      expect(result.status, result.stderr).toBe(0);
      expect(result).toMatchObject({ parent: null, policy: 'rejected', primary: null, fallback: null });
    }
  });

  it.each(['missing', 'unsafe'] as const)('fails closed for a qualified instance bridge with a %s credential', (credential) => {
    const result = runLauncher('bridge-agent', qualifiedConfig(), qualifiedBridgeEnv(), credential);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FATAL: Agent365 bridge credential is empty or unavailable');
  });

  it('leaves an unconfigured instance agent launchable without resolving a bridge credential', () => {
    const result = runLauncher('bridge-agent', {
      name: 'bridge-agent',
      type: 'agent',
      agentOptions: { sessionScope: 'single', provider: 'claude-cli' },
    }, {});

    expect(result.status, result.stderr).toBe(0);
    expect(result.lookupLog).not.toContain('agent365-bridge-agent');
    expect(result).toMatchObject({ parent: null, policy: null, primary: null, fallback: null, admissionParent: null, admissionForwarded: null });
  });
});
