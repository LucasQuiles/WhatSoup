/**
 * Shape rules for the instance config `service` block — the single source of
 * truth consumed by both the core instance-config validator (CREATE / PATCH /
 * load / discovery) and the fleet-side launchd render resolver.
 */
import { describe, expect, it } from 'vitest';
import {
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
