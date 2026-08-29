/**
 * Shape rules for the instance config `service` block — the single source of
 * truth consumed by both the core instance-config validator (CREATE / PATCH /
 * load / discovery) and the fleet-side launchd render resolver.
 */
import { describe, expect, it } from 'vitest';
import {
  LaunchdRenderConfigError,
  assertValidLaunchdPlistRenderOptions,
  extractLaunchdPlistRenderOptions,
  validateLaunchdServiceConfig,
} from '../../src/lib/launchd-service-config.ts';

describe('validateLaunchdServiceConfig', () => {
  it('accepts an absent or null service block', () => {
    expect(validateLaunchdServiceConfig({})).toBeNull();
    expect(validateLaunchdServiceConfig({ service: null })).toBeNull();
  });

  it('accepts a valid block with absolute claudeConfigDir and pathPrepend', () => {
    expect(validateLaunchdServiceConfig({
      service: {
        claudeConfigDir: '/opt/claude-roots/phbot',
        pathPrepend: ['/opt/service-bin', '/opt/tools/bin'],
      },
    })).toBeNull();
  });

  it('rejects a non-object service block', () => {
    for (const service of ['x', 42, ['/opt/service-bin']]) {
      const error = validateLaunchdServiceConfig({ service });
      expect(error).toMatchObject({ field: 'service' });
    }
  });

  it('rejects a relative, empty, untrimmed, or non-string claudeConfigDir', () => {
    for (const claudeConfigDir of ['relative/root', '', ' /opt/claude-roots/phbot', 42]) {
      const error = validateLaunchdServiceConfig({ service: { claudeConfigDir } });
      expect(error).toMatchObject({ field: 'service.claudeConfigDir' });
    }
  });

  it('rejects control characters in claudeConfigDir', () => {
    const error = validateLaunchdServiceConfig({
      service: { claudeConfigDir: '/opt/claude\nroots' },
    });
    expect(error).toMatchObject({ field: 'service.claudeConfigDir' });
  });

  it('rejects a non-array pathPrepend', () => {
    const error = validateLaunchdServiceConfig({
      service: { pathPrepend: '/opt/service-bin' },
    });
    expect(error).toMatchObject({ field: 'service.pathPrepend' });
  });

  it('rejects relative, empty, non-string, and PATH-separator entries in pathPrepend', () => {
    for (const entry of ['relative/bin', '', 42, '/opt/a:/opt/b']) {
      const error = validateLaunchdServiceConfig({ service: { pathPrepend: [entry] } });
      expect(error).toMatchObject({ field: 'service.pathPrepend[0]' });
    }
  });

  it('rejects more than 16 pathPrepend entries', () => {
    const pathPrepend = Array.from({ length: 17 }, (_, i) => `/opt/bin-${i}`);
    const error = validateLaunchdServiceConfig({ service: { pathPrepend } });
    expect(error).toMatchObject({ field: 'service.pathPrepend' });
  });

  it('caps each pathPrepend entry at 4096 characters (PATH_MAX class)', () => {
    const atCap = '/' + 'a'.repeat(4095);
    const overCap = '/' + 'a'.repeat(4096);
    expect(validateLaunchdServiceConfig({ service: { pathPrepend: [atCap] } })).toBeNull();
    expect(validateLaunchdServiceConfig({ service: { pathPrepend: [overCap] } })).toMatchObject({
      field: 'service.pathPrepend[0]',
    });
  });

  it('caps claudeConfigDir at 4096 characters (PATH_MAX class)', () => {
    const atCap = '/' + 'a'.repeat(4095);
    const overCap = '/' + 'a'.repeat(4096);
    expect(validateLaunchdServiceConfig({ service: { claudeConfigDir: atCap } })).toBeNull();
    expect(validateLaunchdServiceConfig({ service: { claudeConfigDir: overCap } })).toMatchObject({
      field: 'service.claudeConfigDir',
    });
  });

  it('keeps a per-key null rejected (unset the whole block with service: null instead)', () => {
    expect(validateLaunchdServiceConfig({ service: null })).toBeNull();
    expect(validateLaunchdServiceConfig({
      service: { claudeConfigDir: null, pathPrepend: ['/opt/service-bin'] },
    })).toMatchObject({ field: 'service.claudeConfigDir' });
  });
});

describe('LaunchdRenderConfigError marker', () => {
  it('is thrown by extract and assert so callers can print the message verbatim', () => {
    expect(() => extractLaunchdPlistRenderOptions({
      service: { claudeConfigDir: 'relative/root' },
    })).toThrow(LaunchdRenderConfigError);
    expect(() => assertValidLaunchdPlistRenderOptions({
      claudeConfigDir: 'relative/root',
    })).toThrow(LaunchdRenderConfigError);
  });
});

describe('extractLaunchdPlistRenderOptions', () => {
  it('returns empty options when the service block is absent', () => {
    expect(extractLaunchdPlistRenderOptions({})).toEqual({});
  });

  it('returns the typed options for a valid block', () => {
    expect(extractLaunchdPlistRenderOptions({
      service: {
        claudeConfigDir: '/opt/claude-roots/phbot',
        pathPrepend: ['/opt/service-bin'],
      },
    })).toEqual({
      claudeConfigDir: '/opt/claude-roots/phbot',
      pathPrepend: ['/opt/service-bin'],
    });
  });

  it('omits fields that are not configured', () => {
    expect(extractLaunchdPlistRenderOptions({
      service: { pathPrepend: ['/opt/service-bin'] },
    })).toEqual({ pathPrepend: ['/opt/service-bin'] });
  });

  it('throws on an invalid service block instead of silently dropping it', () => {
    expect(() => extractLaunchdPlistRenderOptions({
      service: { claudeConfigDir: 'relative/root' },
    })).toThrow('service.claudeConfigDir');
  });
});
