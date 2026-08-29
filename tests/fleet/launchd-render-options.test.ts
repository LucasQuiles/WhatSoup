/**
 * Instance-specific resolver for launchd plist render options, exercised
 * against a real on-disk instances config root (temp directory): the render
 * path must pick up a configured `service` block, resolve to empty options
 * when config.json is absent, and fail closed on unreadable or invalid config
 * rather than rendering a plist without its governed environment.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveLaunchdPlistRenderOptions } from '../../src/fleet/launchd-render-options.ts';

const tempRoots: string[] = [];

function makeInstancesRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-launchd-render-'));
  tempRoots.push(root);
  return root;
}

function writeConfig(root: string, name: string, config: unknown): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const body = typeof config === 'string' ? config : JSON.stringify(config, null, 2);
  fs.writeFileSync(path.join(dir, 'config.json'), body, 'utf-8');
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('resolveLaunchdPlistRenderOptions', () => {
  it('resolves the configured service block into typed render options', () => {
    const root = makeInstancesRoot();
    writeConfig(root, 'phbot', {
      name: 'phbot',
      service: {
        claudeConfigDir: '/opt/claude-roots/phbot',
        pathPrepend: ['/opt/service-bin'],
      },
    });

    expect(resolveLaunchdPlistRenderOptions('phbot', root)).toEqual({
      claudeConfigDir: '/opt/claude-roots/phbot',
      pathPrepend: ['/opt/service-bin'],
    });
  });

  it('resolves to empty options when config.json has no service block', () => {
    const root = makeInstancesRoot();
    writeConfig(root, 'phbot', { name: 'phbot' });

    expect(resolveLaunchdPlistRenderOptions('phbot', root)).toEqual({});
  });

  it('resolves to empty options when config.json does not exist (backward-compatible render)', () => {
    const root = makeInstancesRoot();

    expect(resolveLaunchdPlistRenderOptions('phbot', root)).toEqual({});
  });

  it('fails closed on invalid JSON instead of rendering without governed environment', () => {
    const root = makeInstancesRoot();
    writeConfig(root, 'phbot', '{ not json');

    expect(() => resolveLaunchdPlistRenderOptions('phbot', root)).toThrow(/phbot.*config\.json|config\.json.*phbot/);
  });

  it('fails closed when config.json is not a JSON object', () => {
    const root = makeInstancesRoot();
    writeConfig(root, 'phbot', '["not", "an", "object"]');

    expect(() => resolveLaunchdPlistRenderOptions('phbot', root)).toThrow();
  });

  it('fails closed on an invalid service block', () => {
    const root = makeInstancesRoot();
    writeConfig(root, 'phbot', {
      name: 'phbot',
      service: { claudeConfigDir: 'relative/root' },
    });

    expect(() => resolveLaunchdPlistRenderOptions('phbot', root)).toThrow('service.claudeConfigDir');
  });

  it('rejects an unsafe instance name before touching the filesystem', () => {
    const root = makeInstancesRoot();

    expect(() => resolveLaunchdPlistRenderOptions('../../outside', root)).toThrow('invalid instance name');
  });
});
