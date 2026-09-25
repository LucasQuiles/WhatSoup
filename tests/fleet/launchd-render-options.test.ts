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
import { LaunchdRenderConfigError } from '../../src/lib/launchd-service-config.ts';

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

  it('never embeds config.json content in a malformed-JSON error (parser source windows carry values)', () => {
    const root = makeInstancesRoot();
    const planted = 'PLANTED-VALUE-7c1d-must-not-leak';
    writeConfig(root, 'phbot', `{"name":"phbot","chatOptions":{"providerKey": ${planted}}}`);

    let thrown: unknown;
    try {
      resolveLaunchdPlistRenderOptions('phbot', root);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LaunchdRenderConfigError);
    const message = (thrown as Error).message;
    expect(message).toBe('malformed JSON in config.json for instance phbot');
    expect(message).not.toContain(planted);
  });

  it('keeps validation-rule text verbatim as a printable render-config error', () => {
    const root = makeInstancesRoot();
    writeConfig(root, 'phbot', { name: 'phbot', service: { pathPrepend: ['relative/bin'] } });

    expect(() => resolveLaunchdPlistRenderOptions('phbot', root)).toThrow(LaunchdRenderConfigError);
    expect(() => resolveLaunchdPlistRenderOptions('phbot', root)).toThrow('service.pathPrepend[0]');
  });

  it('aborts on a dangling config.json symlink instead of rendering byte-compat', () => {
    const root = makeInstancesRoot();
    fs.mkdirSync(path.join(root, 'phbot'), { recursive: true });
    fs.symlinkSync(path.join(root, 'nowhere.json'), path.join(root, 'phbot', 'config.json'));

    expect(() => resolveLaunchdPlistRenderOptions('phbot', root)).toThrow(LaunchdRenderConfigError);
    expect(() => resolveLaunchdPlistRenderOptions('phbot', root)).toThrow(/dangling symlink/);
  });

  it('aborts with a content-free, path-free message when config.json is unreadable (EACCES)', () => {
    const root = makeInstancesRoot();
    writeConfig(root, 'phbot', { name: 'phbot', service: { pathPrepend: ['/opt/service-bin'] } });
    const file = path.join(root, 'phbot', 'config.json');
    fs.chmodSync(file, 0o000);
    try {
      let thrown: unknown;
      try {
        resolveLaunchdPlistRenderOptions('phbot', root);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(LaunchdRenderConfigError);
      expect((thrown as Error).message).toMatch(/EACCES/);
      expect((thrown as Error).message).not.toContain(root);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });

  it('aborts when config.json is a directory (EISDIR)', () => {
    const root = makeInstancesRoot();
    fs.mkdirSync(path.join(root, 'phbot', 'config.json'), { recursive: true });

    expect(() => resolveLaunchdPlistRenderOptions('phbot', root)).toThrow(LaunchdRenderConfigError);
    expect(() => resolveLaunchdPlistRenderOptions('phbot', root)).toThrow(/EISDIR/);
  });
});
