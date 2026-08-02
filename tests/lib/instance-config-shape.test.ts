/**
 * Unit tests for src/lib/instance-config-shape.ts — Site 1 (config.ts) only.
 *
 * Trimmed from qf/instanceconfig-consolidation's tests/lib/instance-config-shape.test.ts
 * (which originally covered Sites 1-4, see instanceconfig-lane-spec-r15.md). Sites 2/3
 * (parseDatabaseGateConfig, the early-gate pair) and Site 4 (parseInstanceConfigPassthrough,
 * main.ts) are dropped here — see the module's own docblock in
 * src/lib/instance-config-shape.ts for why they are superseded by #2206's
 * src/lib/instance-context.ts store rather than ported.
 *
 * Every failure mode asserts BOTH the thrown class (ConfigValidationError, not a
 * bare Error) and startupExitCode(err) === 78 — the permanent-config-fault
 * classification that stops systemd's restart-flap (RestartPreventExitStatus=78).
 */
import { describe, expect, it } from 'vitest';
import { startupExitCode } from '../../src/core/database-compatibility-early.ts';
import { ConfigValidationError } from '../../src/lib/startup-error.ts';
import { parseRuntimeBootstrapConfig } from '../../src/lib/instance-config-shape.ts';

function expectPermanentConfigFault(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ConfigValidationError);
  expect(startupExitCode(caught)).toBe(78);
}

describe('parseRuntimeBootstrapConfig — Site 1 (config.ts)', () => {
  const fullPaths = {
    configRoot: '/inst/config',
    dataRoot: '/inst/data',
    stateRoot: '/inst/state',
    dbPath: '/inst/data/bot.db',
    lockPath: '/inst/state/bot.lock',
    logDir: '/inst/data/logs',
    mediaDir: '/inst/data/media/tmp',
  };

  it('accepts the full payload and preserves every optional field plus the raw record', () => {
    const raw = {
      name: 'q',
      type: 'agent',
      healthPort: 9090,
      agentOptions: { sessionScope: 'shared' },
      systemPrompt: 'be helpful',
      socketPath: '/tmp/q.sock',
      introSent: false,
      paths: { ...fullPaths, tmpDir: '/inst/data/tmp', authDir: '/inst/config/auth_info' },
      models: { conversation: 'sonnet' },
    };
    const parsed = parseRuntimeBootstrapConfig(JSON.stringify(raw));
    expect(parsed.name).toBe('q');
    expect(parsed.type).toBe('agent');
    expect(parsed.healthPort).toBe(9090);
    expect(parsed.agentOptions).toEqual({ sessionScope: 'shared' });
    expect(parsed.systemPrompt).toBe('be helpful');
    expect(parsed.socketPath).toBe('/tmp/q.sock');
    expect(parsed.introSent).toBe(false);
    expect(parsed.paths).toEqual({ ...fullPaths, tmpDir: '/inst/data/tmp', authDir: '/inst/config/auth_info' });
    // The raw parsed object is preserved verbatim for config.ts's ~30 other
    // instance.* fields (models, adminPhones, transport, ...) — out of scope for
    // this shared validator, but config.ts must not have to re-parse the string.
    expect(parsed.raw).toEqual(raw);
  });

  it('accepts the minimal required-paths-only payload — every optional field absent', () => {
    const parsed = parseRuntimeBootstrapConfig(JSON.stringify({ paths: fullPaths }));
    expect(parsed.name).toBeUndefined();
    expect(parsed.type).toBeUndefined();
    expect(parsed.healthPort).toBeUndefined();
    expect(parsed.agentOptions).toBeUndefined();
    expect(parsed.systemPrompt).toBeUndefined();
    expect(parsed.socketPath).toBeUndefined();
    expect(parsed.introSent).toBeUndefined();
    expect(parsed.paths.tmpDir).toBeUndefined();
    expect(parsed.paths.authDir).toBeUndefined();
    expect(parsed.paths).toEqual(fullPaths);
  });

  it('drops a non-object agentOptions silently (opaque passthrough, shape-only check)', () => {
    const parsed = parseRuntimeBootstrapConfig(JSON.stringify({ paths: fullPaths, agentOptions: 'not an object' }));
    expect(parsed.agentOptions).toBeUndefined();
    expect(parsed.paths).toEqual(fullPaths);
  });

  it('rejects invalid JSON with the paths-object-agnostic parse-context message', () => {
    expect(() => parseRuntimeBootstrapConfig('{ not valid json')).toThrow(
      /INSTANCE_CONFIG contains invalid JSON:/,
    );
  });

  it.each([
    ['missing paths object entirely', {}],
    ['missing configRoot', { paths: { ...fullPaths, configRoot: undefined } }],
    ['missing dataRoot', { paths: { ...fullPaths, dataRoot: undefined } }],
    ['missing stateRoot', { paths: { ...fullPaths, stateRoot: undefined } }],
    ['missing dbPath', { paths: { ...fullPaths, dbPath: undefined } }],
    ['missing lockPath', { paths: { ...fullPaths, lockPath: undefined } }],
    ['missing logDir', { paths: { ...fullPaths, logDir: undefined } }],
    ['missing mediaDir', { paths: { ...fullPaths, mediaDir: undefined } }],
    ['dbPath wrong type', { paths: { ...fullPaths, dbPath: 42 } }],
  ])('rejects (%s) with the paths-object message regex-pinned by tests/config.test.ts', (_label, body) => {
    // JSON.stringify drops `undefined`-valued keys, which is exactly "field absent".
    expectPermanentConfigFault(() => parseRuntimeBootstrapConfig(JSON.stringify(body)));
    expect(() => parseRuntimeBootstrapConfig(JSON.stringify(body))).toThrow(
      /INSTANCE_CONFIG.*paths object/,
    );
  });

  it('rejects a non-object top level the same as a missing paths object', () => {
    expectPermanentConfigFault(() => parseRuntimeBootstrapConfig('null'));
    expectPermanentConfigFault(() => parseRuntimeBootstrapConfig('42'));
  });
});
