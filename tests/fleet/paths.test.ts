import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

const HOME = '/tmp/fleet-paths-home';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => HOME,
  };
});

import {
  xdgDir,
  configRoot,
  dataRoot,
  stateRoot,
  instancePaths,
} from '../../src/fleet/paths.ts';

beforeEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_STATE_HOME;
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_STATE_HOME;
});

describe('xdgDir', () => {
  it('returns the env value when the env var is set', () => {
    process.env.XDG_CONFIG_HOME = '/custom/config';
    expect(xdgDir('XDG_CONFIG_HOME', '.config')).toBe('/custom/config');
  });

  it('falls back to $HOME/<suffix> when the env var is unset', () => {
    expect(xdgDir('XDG_CONFIG_HOME', '.config')).toBe(path.join(HOME, '.config'));
  });

  it('treats an empty-string env value the same as unset', () => {
    process.env.XDG_CONFIG_HOME = '';
    expect(xdgDir('XDG_CONFIG_HOME', '.config')).toBe(path.join(HOME, '.config'));
  });

  it('uses the literal fallback suffix without normalization', () => {
    expect(xdgDir('XDG_DATA_HOME', '.local/share')).toBe(path.join(HOME, '.local/share'));
  });
});

describe('configRoot', () => {
  it('joins xdg config dir with whatsoup/instances', () => {
    expect(configRoot()).toBe(path.join(HOME, '.config', 'whatsoup', 'instances'));
  });

  it('honors XDG_CONFIG_HOME when set', () => {
    process.env.XDG_CONFIG_HOME = '/x/config';
    expect(configRoot()).toBe(path.join('/x/config', 'whatsoup', 'instances'));
  });
});

describe('dataRoot', () => {
  it('joins xdg data dir with whatsoup/instances/<name>', () => {
    expect(dataRoot('primary')).toBe(
      path.join(HOME, '.local/share', 'whatsoup', 'instances', 'primary'),
    );
  });

  it('honors XDG_DATA_HOME when set', () => {
    process.env.XDG_DATA_HOME = '/x/data';
    expect(dataRoot('agent')).toBe(path.join('/x/data', 'whatsoup', 'instances', 'agent'));
  });
});

describe('stateRoot', () => {
  it('joins xdg state dir with whatsoup/instances/<name>', () => {
    expect(stateRoot('primary')).toBe(
      path.join(HOME, '.local/state', 'whatsoup', 'instances', 'primary'),
    );
  });

  it('honors XDG_STATE_HOME when set', () => {
    process.env.XDG_STATE_HOME = '/x/state';
    expect(stateRoot('agent')).toBe(path.join('/x/state', 'whatsoup', 'instances', 'agent'));
  });
});

describe('instancePaths', () => {
  it('bundles all eight derived paths for an instance', () => {
    const p = instancePaths('primary');
    const cfg = path.join(HOME, '.config', 'whatsoup', 'instances', 'primary');
    const data = path.join(HOME, '.local/share', 'whatsoup', 'instances', 'primary');
    const state = path.join(HOME, '.local/state', 'whatsoup', 'instances', 'primary');

    expect(p).toEqual({
      configRoot: cfg,
      dataRoot: data,
      stateRoot: state,
      authDir: path.join(cfg, 'auth'),
      dbPath: path.join(data, 'bot.db'),
      logDir: path.join(data, 'logs'),
      lockPath: path.join(state, 'whatsoup.lock'),
      mediaDir: path.join(data, 'media', 'tmp'),
    });
  });

  it('produces distinct path bundles per instance name', () => {
    const a = instancePaths('agent-a');
    const b = instancePaths('agent-b');
    expect(a.configRoot).not.toBe(b.configRoot);
    expect(a.dataRoot).not.toBe(b.dataRoot);
    expect(a.stateRoot).not.toBe(b.stateRoot);
    expect(a.authDir).not.toBe(b.authDir);
    expect(a.dbPath).not.toBe(b.dbPath);
    expect(a.lockPath).not.toBe(b.lockPath);
  });

  it('respects all three XDG env overrides simultaneously', () => {
    process.env.XDG_CONFIG_HOME = '/x/config';
    process.env.XDG_DATA_HOME = '/x/data';
    process.env.XDG_STATE_HOME = '/x/state';

    const p = instancePaths('agent');
    expect(p.configRoot).toBe(path.join('/x/config', 'whatsoup', 'instances', 'agent'));
    expect(p.dataRoot).toBe(path.join('/x/data', 'whatsoup', 'instances', 'agent'));
    expect(p.stateRoot).toBe(path.join('/x/state', 'whatsoup', 'instances', 'agent'));
    expect(p.authDir).toBe(path.join('/x/config', 'whatsoup', 'instances', 'agent', 'auth'));
    expect(p.dbPath).toBe(path.join('/x/data', 'whatsoup', 'instances', 'agent', 'bot.db'));
    expect(p.lockPath).toBe(path.join('/x/state', 'whatsoup', 'instances', 'agent', 'whatsoup.lock'));
  });

  it('does not throw on instance names containing dashes, underscores, or numerics', () => {
    expect(() => instancePaths('agent-1_test')).not.toThrow();
    const p = instancePaths('agent-1_test');
    expect(p.configRoot).toContain('agent-1_test');
  });
});
