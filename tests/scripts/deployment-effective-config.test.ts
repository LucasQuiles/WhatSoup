import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateInstanceConfig } from '../../src/core/agent-config-validator.ts';
import { resolveDeploymentEffectiveConfig } from '../../scripts/lib/deployment-qualification/effective-config.ts';
import { resolveEffectiveConfigCommand } from '../../scripts/resolve-deployment-effective-config.ts';

const roots: string[] = [];
afterEach(() => {
  vi.doUnmock('../../src/lib/private-fs.ts');
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(suffix = 'a') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'effective-config-')));
  roots.push(root);
  const instanceRoot = join(root, 'instances');
  const name = `agent-${suffix}`;
  mkdirSync(join(instanceRoot, name), { recursive: true, mode: 0o700 });
  const configPath = join(instanceRoot, name, 'config.json');
  const bindingPath = join(root, 'binding.json');
  const inventoryPath = join(root, 'inventory.json');
  const config = {
    name, type: 'agent', accessMode: 'self_only', healthPort: 8123,
    adminPhones: ['15550000001'],
    service: { claudeConfigDir: join(root, 'provider'), pathPrepend: [] },
  };
  expect(validateInstanceConfig(config, { name, mode: 'load' })).toBeNull();
  const host = { tier: 'alert', probe: 'local', role: 'collector', principal: `user-${suffix}`, services: [],
    required_processes: [], expected_listening_ports: [8123] };
  const inventory = { version: 1, collector_origin: `host-${suffix}`, interval_minutes: 5,
    timeouts: { ssh_connect_seconds: 5, remote_command_seconds: 10 },
    debounce: { failures_before_alert: 2, oks_before_recovery: 2 }, thresholds: {},
    hosts: { [`host-${suffix}`]: host } };
  const binding = {
    schema_version: 'whatsoup.deployment-binding.v1',
    target: { host_ref: `host_${suffix.repeat(8)}`, user_ref: `usr_${suffix.repeat(8)}`,
      instance_ref: `inst_${suffix.repeat(8)}`, inventory_host: `host-${suffix}`, instance_name: name },
    settings: { uid: 701, home_root: root, platform: 'macos', service_manager: 'launchd',
      service_domain: 'gui', token_file_relative: 'tokens.env' },
    requested: { healthPort: 8124 },
    overrides: [{ field: 'limits.timeout_seconds', value: 2, reason: 'Shorter observation window' }],
  };
  const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  save(configPath, config); save(bindingPath, binding); save(inventoryPath, inventory);
  const options = {
    binding: { path: bindingPath, root }, inventory: { path: inventoryPath, root }, instanceRoot,
    context: { arc_commit: '1'.repeat(40), qfleet_commit: '2'.repeat(40),
      whatsoup_commit: '3'.repeat(40), run_context_digest: '4'.repeat(64) },
  };
  return { root, configPath, bindingPath, inventoryPath, config, binding, inventory, host, save, options };
}

describe('deployment effective configuration', () => {
  it('preserves inventory extension keys with unambiguous field addresses', () => {
    const f = fixture();
    const host = { ...f.host, 'site-name': 'synthetic', 'a.b': 'flat', a: { b: 'nested' } };
    f.save(f.inventoryPath, { ...f.inventory, hosts: { 'host-a': host } });
    const result = resolveDeploymentEffectiveConfig(f.options);
    expect(result.configured.host).toEqual(host);
    for (const [field, value] of [
      ['configured.host["site-name"]', 'synthetic'],
      ['configured.host["a.b"]', 'flat'], ['configured.host.a.b', 'nested'],
    ]) {
      expect(result.fields.find((entry) => entry.field === field))
        .toMatchObject({ owner: 'qfleet_inventory', presence: 'value', value });
    }
  });

  it('refuses an overflowing number in an otherwise unused source field', () => {
    const f = fixture();
    const bytes = JSON.stringify({ ...f.config, unused: 'overflow' }).replace('"overflow"', '1e999');
    writeFileSync(f.configPath, bytes);
    expect(() => resolveDeploymentEffectiveConfig(f.options)).toThrow('INPUT_INVALID');
  });

  it('resolves two host/user bindings from their canonical inventory and preserves all inputs', () => {
    for (const suffix of ['a', 'b']) {
      const f = fixture(suffix);
      const before = [f.configPath, f.bindingPath, f.inventoryPath].map((path) => ({
        path, bytes: readFileSync(path), metadata: statSync(path, { bigint: true }),
      }));
      const result = resolveDeploymentEffectiveConfig(f.options);
      expect(result.schema_version).toBe('whatsoup.effective-config.v1');
      expect(result.target).toEqual(f.binding.target);
      expect(result.configured.host).toEqual(f.host);
      expect(result.configured.deployment.principal).toBe(`user-${suffix}`);
      expect(result.configured.instance.healthPort).toBe(8123);
      expect(result.requested.healthPort).toBe(8124);
      expect(result.limits.timeout_seconds).toBe(2);
      expect(result.transport_identity).toBe('unresolved');
      expect(result.fields.find((field) => field.field === 'limits.timeout_seconds'))
        .toMatchObject({ owner: 'qualification_binding', override_reason: 'Shorter observation window' });
      expect(result.fields.find((field) => field.field === 'configured.service.pathPrepend'))
        .toMatchObject({ owner: 'whatsoup_instance', presence: 'value', value: [] });
      expect(result.sources.instance_config.raw_sha256)
        .toBe(createHash('sha256').update(before[0]!.bytes).digest('hex'));
      expect(result.sources.instance_config.root).toBe(f.options.instanceRoot);
      for (const input of before) {
        expect(readFileSync(input.path)).toEqual(input.bytes);
        const after = statSync(input.path, { bigint: true });
        expect([after.ino, after.mtimeNs, after.ctimeNs, after.mode])
          .toEqual([input.metadata.ino, input.metadata.mtimeNs, input.metadata.ctimeNs, input.metadata.mode]);
      }
    }
  });

  it('distinguishes missing, null and empty configured values without substituting requested values', () => {
    const f = fixture();
    f.save(f.configPath, { ...f.config, service: { ...f.config.service, expectedAccountDigest: null } });
    const result = resolveDeploymentEffectiveConfig(f.options);
    expect(result.fields.find((field) => field.field === 'configured.service.expectedAccountDigest'))
      .toMatchObject({ presence: 'null', value: null });
    expect(result.fields.find((field) => field.field === 'configured.agentOptions.provider'))
      .toMatchObject({ presence: 'absent' });
    expect(result.fields.find((field) => field.field === 'configured.service.pathPrepend'))
      .toMatchObject({ presence: 'value', value: [] });
  });

  it.each([
    { service: { expectedAccountDigest: 'private-identity-sentinel' } },
    { service: { pathPrepend: ['relative-path'] } },
    { name: 'different-instance' },
    { type: 'unknown-kind' },
    { type: { toString: 0 } },
    { accessMode: 'unknown-mode' },
    { healthPort: 80 },
  ])('uses the complete existing instance, service and identity validators', (invalid) => {
    const f = fixture();
    f.save(f.configPath, { ...f.config, ...invalid });
    expect(() => resolveDeploymentEffectiveConfig(f.options)).toThrow('INPUT_INVALID');
  });

  it.each([
    { principal: 'replacement' },
    { ssh_alias: 'replacement' },
    { service: { pathPrepend: [] } },
  ])('rejects a binding that tries to take ownership of another source field', (extra) => {
    const f = fixture();
    f.save(f.bindingPath, { ...f.binding, settings: { ...f.binding.settings, ...extra } });
    expect(() => resolveDeploymentEffectiveConfig(f.options)).toThrow('OWNER_CONFLICT');
  });

  it('allows a missing principal setting but never replaces an inventory-owned principal', () => {
    const f = fixture();
    const { principal: _principal, ...host } = f.host;
    f.save(f.inventoryPath, { ...f.inventory, hosts: { 'host-a': host } });
    f.save(f.bindingPath, { ...f.binding, settings: { ...f.binding.settings, principal: 'bound-user' } });
    expect(resolveDeploymentEffectiveConfig(f.options).configured.deployment.principal).toBe('bound-user');
  });

  it.each([
    { field: 'limits.timeout_seconds', value: 61, reason: 'too high' },
    { field: 'limits.timeout_seconds', value: 0.001, reason: 'too low' },
    { field: 'limits.timeout_seconds', value: 1, reason: '' },
    { field: 'service.expectedAccountDigest', value: 1, reason: 'forbidden' },
  ])('refuses unreasoned, unbounded or forbidden overrides', (override) => {
    const f = fixture();
    f.save(f.bindingPath, { ...f.binding, overrides: [override] });
    expect(() => resolveDeploymentEffectiveConfig(f.options)).toThrow(/INPUT_INVALID|OWNER_CONFLICT/);
  });

  it('rejects duplicate and escaped duplicate keys without disclosing content', () => {
    const f = fixture();
    writeFileSync(f.bindingPath, '{"private-sentinel":1,"private-\\u0073entinel":2}');
    expect(() => resolveDeploymentEffectiveConfig(f.options)).toThrow(/^INPUT_INVALID$/);
  });

  it('accepts non-boundary JSON whitespace and retains its raw digest', () => {
    const f = fixture();
    const bytes = Buffer.from(JSON.stringify({ ...f.config, unused: -0 }).replaceAll(',', ',\r\n'));
    writeFileSync(f.configPath, bytes);
    expect(resolveDeploymentEffectiveConfig(f.options).sources.instance_config.raw_sha256)
      .toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('rejects unsafe inputs with a content-free error and does not repair permissions', () => {
    const f = fixture();
    chmodSync(f.configPath, 0o644);
    expect(() => resolveDeploymentEffectiveConfig(f.options)).toThrow(/^INPUT_INVALID$/);
    expect(statSync(f.configPath).mode & 0o777).toBe(0o644);
  });

  it('fails on a changed source even when replacement bytes are identical', async () => {
    const f = fixture();
    const actual = await vi.importActual<typeof import('../../src/lib/private-fs.ts')>('../../src/lib/private-fs.ts');
    let reads = 0;
    vi.resetModules();
    vi.doMock('../../src/lib/private-fs.ts', () => ({
      ...actual,
      readPrivateFileSync: (path: string, options: never) => {
        const observed = actual.readPrivateFileSync(path, options);
        if (path === f.bindingPath && ++reads === 2 && observed && typeof observed !== 'string') {
          return { ...observed, identity: { ...observed.identity, inode: 'different' } };
        }
        return observed;
      },
    }));
    const resolver = await import('../../scripts/lib/deployment-qualification/effective-config.ts');
    expect(() => resolver.resolveDeploymentEffectiveConfig(f.options)).toThrow(/^EVIDENCE_STALE$/);
  });

  it.each(['uid', 'platform', 'home_root', 'service_manager', 'token_file_relative'])
    ('rejects every binding setting already present on the selected inventory row: %s', (key) => {
      const f = fixture();
      f.save(f.inventoryPath, { ...f.inventory, hosts: { 'host-a': { ...f.host, [key]: null } } });
      expect(() => resolveDeploymentEffectiveConfig(f.options)).toThrow(/^OWNER_CONFLICT$/);
    });

  it('takes deployment settings from inventory when the binding does not supply them', () => {
    const f = fixture();
    const { uid, home_root, ...settings } = f.binding.settings;
    f.save(f.inventoryPath, { ...f.inventory, hosts: { 'host-a': { ...f.host, uid, home_root } } });
    f.save(f.bindingPath, { ...f.binding, settings });
    const result = resolveDeploymentEffectiveConfig(f.options);
    expect(result.configured.deployment.uid).toBe(uid);
    expect(result.fields.find((field) => field.field === 'configured.deployment.home_root'))
      .toMatchObject({ owner: 'qfleet_inventory', value: home_root,
        source_raw_sha256: result.sources.inventory.raw_sha256 });
  });

  it.each([
    { tier: 'invented' }, { services: 'invented' }, { required_processes: null },
    { expected_listening_ports: [false] }, { probe: 'invented' },
  ])('rejects a malformed selected canonical inventory row', (invalid) => {
    const f = fixture();
    f.save(f.inventoryPath, { ...f.inventory, hosts: { 'host-a': { ...f.host, ...invalid } } });
    expect(() => resolveDeploymentEffectiveConfig(f.options)).toThrow(/^INPUT_INVALID$/);
  });

  it('rejects an unsupported inventory version or missing selected host', () => {
    const f = fixture();
    f.save(f.inventoryPath, { ...f.inventory, version: 2 });
    expect(() => resolveDeploymentEffectiveConfig(f.options)).toThrow(/^INPUT_INVALID$/);
    f.save(f.inventoryPath, { ...f.inventory, hosts: {} });
    expect(() => resolveDeploymentEffectiveConfig(f.options)).toThrow(/^INPUT_INVALID$/);
  });

  it('records accurate ownership for a missing instance port, requested values and derived paths', () => {
    const f = fixture();
    const { healthPort, ...config } = f.config;
    f.save(f.configPath, config);
    f.save(f.bindingPath, { ...f.binding, settings: { ...f.binding.settings, healthPort } });
    const result = resolveDeploymentEffectiveConfig(f.options);
    expect(result.configured.instance.healthPort).toBe(healthPort);
    expect(result.fields.find((field) => field.field === 'configured.instance.healthPort'))
      .toMatchObject({ owner: 'qualification_binding', presence: 'value', value: healthPort,
        source_raw_sha256: result.sources.binding.raw_sha256 });
    expect(result.fields.find((field) => field.field === 'requested.healthPort'))
      .toMatchObject({ owner: 'qualification_binding', value: 8124 });
    expect(result.fields.find((field) => field.field === 'configured.deployment.token_file'))
      .toMatchObject({ value: join(f.root, 'tokens.env'),
        derived_from: ['configured.deployment.home_root', 'configured.deployment.token_file_relative'] });
    const walk = (value: unknown, path: string): void => {
      if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0) {
        for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
      } else {
        const rows = result.fields.filter((field) => field.field === path);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.value).toEqual(value);
      }
    };
    walk(result.configured, 'configured');
    walk(result.requested, 'requested');
  });

  it.each(['a', 'b'])('runs the real pinned CLI for target %s without a transpiler', (suffix) => {
    const f = fixture(suffix);
    const output = join(f.root, 'effective.json');
    const repository = fileURLToPath(new URL('../../', import.meta.url));
    const args = Object.entries({ binding: f.bindingPath, 'binding-root': f.root,
      inventory: f.inventoryPath, 'inventory-root': f.root, 'instance-root': f.options.instanceRoot,
      'arc-commit': f.options.context.arc_commit, 'qfleet-commit': f.options.context.qfleet_commit,
      'whatsoup-commit': f.options.context.whatsoup_commit, 'run-context-digest': f.options.context.run_context_digest,
      output, 'output-root': f.root }).flatMap(([key, value]) => [`--${key}`, value]);
    const result = spawnSync(join(repository, 'scripts/run-with-pinned-node.sh'),
      [join(repository, 'scripts/resolve-deployment-effective-config.ts'), ...args],
      { cwd: repository, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const bytes = readFileSync(output);
    expect(JSON.parse(result.stdout)).toEqual({ schema_version: 'whatsoup.effective-config-write.v1',
      record_sha256: createHash('sha256').update(bytes).digest('hex') });
    expect(JSON.parse(bytes.toString())).toMatchObject({ target: f.binding.target,
      configured: { instance: { healthPort: 8123 } }, requested: { healthPort: 8124 } });
    expect(statSync(output).mode & 0o777).toBe(0o600);
  }, 35_000);

  it('writes a new private record, returns only a digest and refuses overwriting any existing record', () => {
    const f = fixture();
    const output = join(f.root, 'effective.json');
    const args = Object.entries({ binding: f.bindingPath, 'binding-root': f.root,
      inventory: f.inventoryPath, 'inventory-root': f.root, 'instance-root': f.options.instanceRoot,
      'arc-commit': f.options.context.arc_commit, 'qfleet-commit': f.options.context.qfleet_commit,
      'whatsoup-commit': f.options.context.whatsoup_commit, 'run-context-digest': f.options.context.run_context_digest,
      output, 'output-root': f.root }).flatMap(([key, value]) => [`--${key}`, value]);
    const receipt = resolveEffectiveConfigCommand(args);
    const bytes = readFileSync(output);
    expect(receipt).toEqual({ schema_version: 'whatsoup.effective-config-write.v1',
      record_sha256: createHash('sha256').update(bytes).digest('hex') });
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(JSON.parse(bytes.toString()).target).toEqual(f.binding.target);
    expect(() => resolveEffectiveConfigCommand(args)).toThrow(/^OWNER_CONFLICT$/);
    expect(readFileSync(output)).toEqual(bytes);
    expect(() => resolveEffectiveConfigCommand([...args, '--binding', 'private-error-sentinel']))
      .toThrow(/^INPUT_INVALID$/);
    expect(JSON.stringify(receipt)).not.toContain(f.root);
    expect(JSON.stringify(receipt)).not.toContain(f.binding.target.instance_name);
  });
});
