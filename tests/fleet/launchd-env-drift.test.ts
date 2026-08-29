/**
 * Governed-env drift comparator: detects missing/extra/mismatched governed
 * EnvironmentVariables keys (CLAUDE_CONFIG_DIR, PATH) between a freshly
 * rendered plist and the installed one, by key and SHA-256 value digest only.
 * Installed bot plists carry live credentials, so no report may ever contain
 * a raw environment value — several tests below assert exactly that.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compareGovernedLaunchdEnv } from '../../src/fleet/launchd-env-drift.ts';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

/**
 * Minimal plist with the same structural shape as the generated ones: a
 * KeepAlive dict BEFORE EnvironmentVariables, so a naive first-dict parser
 * would read the wrong dict.
 */
function plistWithEnv(env: Record<string, string> | null): string {
  const envBlock = env === null
    ? []
    : [
        '  <key>EnvironmentVariables</key>',
        '  <dict>',
        ...Object.entries(env).flatMap(([key, value]) => [
          `    <key>${key}</key>`,
          `    <string>${value}</string>`,
        ]),
        '  </dict>',
      ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>com.whatsoup.agent</string>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>Crashed</key>',
    '    <true/>',
    '  </dict>',
    ...envBlock,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

describe('compareGovernedLaunchdEnv', () => {
  it('reports no drift when governed keys match', () => {
    const expected = plistWithEnv({ PATH: '/opt/bin:/usr/bin' });
    const observed = plistWithEnv({ PATH: '/opt/bin:/usr/bin' });
    expect(compareGovernedLaunchdEnv(expected, observed)).toEqual({
      comparable: true,
      drift: [],
    });
  });

  it('reports a mismatched governed key by digest, never by value', () => {
    const expected = plistWithEnv({ PATH: '/opt/bin:/usr/bin' });
    const observed = plistWithEnv({ PATH: '/opt/hand-patched-bin:/usr/bin' });

    const comparison = compareGovernedLaunchdEnv(expected, observed);

    expect(comparison.comparable).toBe(true);
    expect(comparison.drift).toEqual([{
      key: 'PATH',
      state: 'mismatch',
      expectedDigest: sha256('/opt/bin:/usr/bin'),
      observedDigest: sha256('/opt/hand-patched-bin:/usr/bin'),
    }]);
    expect(JSON.stringify(comparison)).not.toContain('hand-patched');
  });

  it('reports an expected governed key absent from the installed plist as missing', () => {
    const expected = plistWithEnv({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/opt/claude-roots/agent' });
    const observed = plistWithEnv({ PATH: '/usr/bin' });

    expect(compareGovernedLaunchdEnv(expected, observed).drift).toEqual([{
      key: 'CLAUDE_CONFIG_DIR',
      state: 'missing',
      expectedDigest: sha256('/opt/claude-roots/agent'),
      observedDigest: null,
    }]);
  });

  it('reports an installed governed key with no expected source as extra', () => {
    const expected = plistWithEnv({ PATH: '/usr/bin' });
    const observed = plistWithEnv({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/opt/claude-roots/hand-added' });

    const comparison = compareGovernedLaunchdEnv(expected, observed);

    expect(comparison.drift).toEqual([{
      key: 'CLAUDE_CONFIG_DIR',
      state: 'extra',
      expectedDigest: null,
      observedDigest: sha256('/opt/claude-roots/hand-added'),
    }]);
    expect(JSON.stringify(comparison)).not.toContain('hand-added');
  });

  it('ignores non-governed keys entirely and never leaks their values', () => {
    const sentinel = 'sentinel-value-that-must-never-appear-in-a-report';
    const expected = plistWithEnv({ PATH: '/usr/bin' });
    const observed = plistWithEnv({ PATH: '/usr/bin', WHATSOUP_HEALTH_TOKEN: sentinel });

    const comparison = compareGovernedLaunchdEnv(expected, observed);

    expect(comparison).toEqual({ comparable: true, drift: [] });
    expect(JSON.stringify(comparison)).not.toContain(sentinel);
  });

  it('treats an installed plist without EnvironmentVariables as missing every expected governed key', () => {
    const expected = plistWithEnv({ PATH: '/usr/bin' });
    const observed = plistWithEnv(null);

    const comparison = compareGovernedLaunchdEnv(expected, observed);

    expect(comparison.comparable).toBe(true);
    expect(comparison.drift).toEqual([{
      key: 'PATH',
      state: 'missing',
      expectedDigest: sha256('/usr/bin'),
      observedDigest: null,
    }]);
  });

  it('digests the unescaped value so XML entities compare by content', () => {
    const expected = plistWithEnv({ PATH: '/opt/a&amp;b/bin' });
    const observed = plistWithEnv({ PATH: '/opt/a&amp;b/bin' });
    expect(compareGovernedLaunchdEnv(expected, observed).drift).toEqual([]);

    const drifted = compareGovernedLaunchdEnv(expected, plistWithEnv({ PATH: '/opt/a&amp;c/bin' }));
    expect(drifted.drift).toEqual([{
      key: 'PATH',
      state: 'mismatch',
      expectedDigest: sha256('/opt/a&b/bin'),
      observedDigest: sha256('/opt/a&c/bin'),
    }]);
  });

  it('fails closed when an EnvironmentVariables dict exists but cannot be parsed', () => {
    const expected = plistWithEnv({ PATH: '/usr/bin' });
    const observed = [
      '<plist version="1.0">',
      '<dict>',
      '  <key>EnvironmentVariables</key>',
      '  <dict>',
      '    <key>PATH</key>',
      // no closing </dict>/</plist>: truncated installed plist
    ].join('\n');

    expect(compareGovernedLaunchdEnv(expected, observed)).toEqual({
      comparable: false,
      reason: 'environment-variables-unparseable',
      drift: [],
    });
  });
});
