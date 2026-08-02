import { readFileSync } from 'node:fs';
import { globSync } from 'tinyglobby';
import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetInstanceContext,
  getBootstrapInstanceContext,
  getBootstrapInstanceContextOrNull,
  getLoadedInstanceConfigOrNull,
  setBootstrapInstanceContext,
  setLoadedInstanceConfig,
} from '../../src/lib/instance-context.ts';

const BOOTSTRAP = {
  name: 'main',
  healthPort: 4815,
  paths: { dbPath: '/data/bot.db', lockPath: '/data/bot.lock' },
};

afterEach(() => {
  _resetInstanceContext();
  delete process.env.INSTANCE_CONFIG;
});

describe('instance-context typed store (#2206)', () => {
  it('returns the directly-set bootstrap context', () => {
    setBootstrapInstanceContext(BOOTSTRAP);
    expect(getBootstrapInstanceContext()).toEqual(BOOTSTRAP);
  });

  it('fails closed with ConfigValidationError when nothing is set and no env exists', () => {
    expect(() => getBootstrapInstanceContext()).toThrow(/instance context is required/);
    expect(getBootstrapInstanceContextOrNull()).toBeNull();
  });

  it('falls back to a fresh env read each call (no cross-case staleness)', () => {
    process.env.INSTANCE_CONFIG = JSON.stringify({
      ...BOOTSTRAP,
      extra: 'kept',
    });
    expect(getBootstrapInstanceContext()).toEqual({
      name: 'main',
      healthPort: 4815,
      paths: { dbPath: '/data/bot.db', lockPath: '/data/bot.lock' },
    });
    // Fresh reads: a later env mutation IS visible (tests rely on this;
    // a stale cache is the init-order bug class this module exists to kill).
    process.env.INSTANCE_CONFIG = JSON.stringify({ name: 'other', healthPort: 1, paths: { dbPath: '/x', lockPath: '/y' } });
    expect(getBootstrapInstanceContext().name).toBe('other');
  });

  it('direct store beats the env fallback', () => {
    process.env.INSTANCE_CONFIG = JSON.stringify({ name: 'env-name', healthPort: 9, paths: { dbPath: '/e', lockPath: '/l' } });
    setBootstrapInstanceContext(BOOTSTRAP);
    expect(getBootstrapInstanceContext().name).toBe('main');
  });

  it('an idempotent rewrite is allowed; a CONTRADICTING second write throws (race = loud)', () => {
    setBootstrapInstanceContext(BOOTSTRAP);
    expect(() => setBootstrapInstanceContext(BOOTSTRAP)).not.toThrow();
    expect(() =>
      setBootstrapInstanceContext({ ...BOOTSTRAP, healthPort: 9999 }),
    ).toThrow(/conflicting bootstrap instance context write/);
  });

  it('the loaded config store is last-writer-wins (mirrors env overwrite semantics)', () => {
    setLoadedInstanceConfig({ type: 'chat' });
    expect(getLoadedInstanceConfigOrNull()).toEqual({ type: 'chat' });
    setLoadedInstanceConfig({ type: 'agent' });
    expect(getLoadedInstanceConfigOrNull()).toEqual({ type: 'agent' });
  });

  it('loaded-config getter falls back to env parse (main.ts absent-means-default path)', () => {
    expect(getLoadedInstanceConfigOrNull()).toBeNull();
    process.env.INSTANCE_CONFIG = JSON.stringify({ type: 'agent' });
    expect(getLoadedInstanceConfigOrNull()).toEqual({ type: 'agent' });
  });

  it('invalid env JSON fails loud at the shared parse point', () => {
    process.env.INSTANCE_CONFIG = '{nope';
    expect(() => getBootstrapInstanceContextOrNull()).toThrow(/invalid JSON/);
  });

  it('_resetInstanceContext clears store and cache', () => {
    setBootstrapInstanceContext(BOOTSTRAP);
    setLoadedInstanceConfig({ type: 'chat' });
    _resetInstanceContext();
    expect(getBootstrapInstanceContextOrNull()).toBeNull();
    expect(getLoadedInstanceConfigOrNull()).toBeNull();
  });
});

describe('instance-context reader-set ratchet (#2206)', () => {
  /**
   * After the migration, the only remaining in-process readers of
   * process.env.INSTANCE_CONFIG are the shared fallback inside the leaf
   * itself and src/config.ts's module-level multi-instance branch (a
   * documented follow-up with a 143-test surface). Growth of this set is a
   * new untyped consumer and must fail review.
   */
  it('pins in-process env readers to the leaf fallback + src/config.ts', () => {
    const allowedReaders = new Set([
      'src/lib/instance-context.ts',
      'src/config.ts',
    ]);
    const readers = globSync(['src/**/*.ts'], { ignore: ['**/node_modules/**'] })
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return /process\.env\.INSTANCE_CONFIG/.test(source)
          && !/process\.env\.INSTANCE_CONFIG\s*=/.test(source); // writers, not readers
      })
      .filter((file) => !allowedReaders.has(file));
    expect(
      readers,
      `new in-process INSTANCE_CONFIG reader(s) outside the pinned set — use the typed store (src/lib/instance-context.ts):\n${readers.join('\n')}`,
    ).toEqual([]);
  });

  it('pins env WRITERS to the two known compat writes', () => {
    const allowedWriters = new Set([
      'src/instance-loader.ts',
      'src/database-compatibility-config.ts',
    ]);
    const writers = globSync(['src/**/*.ts'], { ignore: ['**/node_modules/**'] })
      .filter((file) =>
        /process\.env\.INSTANCE_CONFIG\s*=/.test(readFileSync(file, 'utf8')),
      )
      .filter((file) => !allowedWriters.has(file));
    expect(
      writers,
      `new INSTANCE_CONFIG writer(s) outside the pinned set:\n${writers.join('\n')}`,
    ).toEqual([]);
  });
});
