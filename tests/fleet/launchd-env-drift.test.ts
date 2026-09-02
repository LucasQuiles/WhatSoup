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
  it('reports no drift, nothing dropped, and no tail difference when governed keys match', () => {
    const expected = plistWithEnv({ PATH: '/opt/bin:/usr/bin' });
    const observed = plistWithEnv({ PATH: '/opt/bin:/usr/bin' });
    expect(compareGovernedLaunchdEnv(expected, observed)).toEqual({
      comparable: true,
      drift: [],
      droppedNonGovernedKeys: [],
      pathPrefix: {
        configured: false,
        satisfied: true,
        ambientTailDiffers: false,
        expectedDigest: sha256('/opt/bin:/usr/bin'),
        observedDigest: sha256('/opt/bin:/usr/bin'),
      },
    });
  });

  it('reports a governed PATH mismatch by digest when the installed PATH lacks the configured prefix', () => {
    const expected = plistWithEnv({ PATH: '/opt/bin:/usr/bin' });
    const observed = plistWithEnv({ PATH: '/opt/hand-patched-bin:/usr/bin' });

    const comparison = compareGovernedLaunchdEnv(expected, observed, { pathPrepend: ['/opt/bin'] });

    expect(comparison.comparable).toBe(true);
    expect(comparison.drift).toEqual([{
      key: 'PATH',
      state: 'mismatch',
      expectedDigest: sha256('/opt/bin:/usr/bin'),
      observedDigest: sha256('/opt/hand-patched-bin:/usr/bin'),
    }]);
    expect(comparison.pathPrefix).toEqual({
      configured: true,
      satisfied: false,
      ambientTailDiffers: true,
      expectedDigest: sha256('/opt/bin:/usr/bin'),
      observedDigest: sha256('/opt/hand-patched-bin:/usr/bin'),
    });
    expect(JSON.stringify(comparison)).not.toContain('hand-patched');
  });

  it('treats a satisfied configured prefix with a different ambient tail as config-satisfied, not governed drift', () => {
    const expected = plistWithEnv({ PATH: '/opt/service-bin:/repo/node_modules/.bin:/usr/bin' });
    const observed = plistWithEnv({ PATH: '/opt/service-bin:/opt/homebrew/bin:/usr/bin' });

    const comparison = compareGovernedLaunchdEnv(expected, observed, { pathPrepend: ['/opt/service-bin'] });

    expect(comparison.drift).toEqual([]);
    expect(comparison.pathPrefix).toEqual({
      configured: true,
      satisfied: true,
      ambientTailDiffers: true,
      expectedDigest: sha256('/opt/service-bin:/repo/node_modules/.bin:/usr/bin'),
      observedDigest: sha256('/opt/service-bin:/opt/homebrew/bin:/usr/bin'),
    });
  });

  it('matches the configured prefix on whole entries only, never on a partial directory name', () => {
    const expected = plistWithEnv({ PATH: '/opt/bin:/usr/bin' });
    const observed = plistWithEnv({ PATH: '/opt/bin-other:/usr/bin' });

    const comparison = compareGovernedLaunchdEnv(expected, observed, { pathPrepend: ['/opt/bin'] });

    expect(comparison.pathPrefix?.satisfied).toBe(false);
    expect(comparison.drift.map((entry) => entry.state)).toEqual(['mismatch']);
  });

  it('reports an unconfigured prefix as trivially satisfied when only the ambient tail differs', () => {
    const expected = plistWithEnv({ PATH: '/repo/node_modules/.bin:/usr/bin' });
    const observed = plistWithEnv({ PATH: '/opt/hand-patched-bin:/usr/bin' });

    const comparison = compareGovernedLaunchdEnv(expected, observed);

    expect(comparison.drift).toEqual([]);
    expect(comparison.pathPrefix).toEqual({
      configured: false,
      satisfied: true,
      ambientTailDiffers: true,
      expectedDigest: sha256('/repo/node_modules/.bin:/usr/bin'),
      observedDigest: sha256('/opt/hand-patched-bin:/usr/bin'),
    });
    expect(JSON.stringify(comparison)).not.toContain('hand-patched');
  });

  it('reports an identical PATH as prefix satisfied with no tail difference', () => {
    const plist = plistWithEnv({ PATH: '/opt/service-bin:/usr/bin' });

    const comparison = compareGovernedLaunchdEnv(plist, plist, { pathPrepend: ['/opt/service-bin'] });

    expect(comparison.drift).toEqual([]);
    expect(comparison.pathPrefix).toMatchObject({ configured: true, satisfied: true, ambientTailDiffers: false });
  });

  it('lists installed non-governed key NAMES a re-render would drop, sorted, never their values', () => {
    const expected = plistWithEnv({ PATH: '/usr/bin', HOME: '/opt/home' });
    const observed = plistWithEnv({
      PATH: '/usr/bin',
      HOME: '/opt/home',
      WHATSOUP_HEALTH_TOKEN: 'sentinel-token-value-never-reported',
      MINIMAX_API_KEY: 'sentinel-key-value-never-reported',
    });

    const comparison = compareGovernedLaunchdEnv(expected, observed);

    expect(comparison.drift).toEqual([]);
    expect(comparison.droppedNonGovernedKeys).toEqual(['MINIMAX_API_KEY', 'WHATSOUP_HEALTH_TOKEN']);
    expect(JSON.stringify(comparison)).not.toContain('never-reported');
  });

  it('does not list keys the re-render keeps or governed keys as dropped', () => {
    const expected = plistWithEnv({ PATH: '/usr/bin', HOME: '/opt/home' });
    const observed = plistWithEnv({ PATH: '/usr/bin', HOME: '/opt/other-home', CLAUDE_CONFIG_DIR: '/opt/claude-roots/x' });

    const comparison = compareGovernedLaunchdEnv(expected, observed);

    expect(comparison.droppedNonGovernedKeys).toEqual([]);
    expect(comparison.drift.map((entry) => `${entry.key}:${entry.state}`)).toEqual(['CLAUDE_CONFIG_DIR:extra']);
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

  it('keeps non-governed keys out of governed drift and never leaks their values', () => {
    const sentinel = 'sentinel-value-that-must-never-appear-in-a-report';
    const expected = plistWithEnv({ PATH: '/usr/bin' });
    const observed = plistWithEnv({ PATH: '/usr/bin', WHATSOUP_HEALTH_TOKEN: sentinel });

    const comparison = compareGovernedLaunchdEnv(expected, observed);

    expect(comparison.drift).toEqual([]);
    expect(comparison.droppedNonGovernedKeys).toEqual(['WHATSOUP_HEALTH_TOKEN']);
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
    const expected = plistWithEnv({ CLAUDE_CONFIG_DIR: '/opt/a&amp;b/root' });
    const observed = plistWithEnv({ CLAUDE_CONFIG_DIR: '/opt/a&amp;b/root' });
    expect(compareGovernedLaunchdEnv(expected, observed).drift).toEqual([]);

    const drifted = compareGovernedLaunchdEnv(expected, plistWithEnv({ CLAUDE_CONFIG_DIR: '/opt/a&amp;c/root' }));
    expect(drifted.drift).toEqual([{
      key: 'CLAUDE_CONFIG_DIR',
      state: 'mismatch',
      expectedDigest: sha256('/opt/a&b/root'),
      observedDigest: sha256('/opt/a&c/root'),
    }]);
  });

  it('reports a configured PATH prepend that the installed plist never rendered as missing', () => {
    // A host configured with service.pathPrepend whose installed plist predates
    // the governed key: this must read as drift, not as "no drift".
    const expected = plistWithEnv({
      PATH: '/opt/bin:/usr/bin',
      WHATSOUP_PATH_PREPEND: '/opt/bin',
    });
    const observed = plistWithEnv({ PATH: '/opt/bin:/usr/bin' });

    const comparison = compareGovernedLaunchdEnv(expected, observed, { pathPrepend: ['/opt/bin'] });

    expect(comparison.comparable).toBe(true);
    expect(comparison.drift).toEqual([{
      key: 'WHATSOUP_PATH_PREPEND',
      state: 'missing',
      expectedDigest: sha256('/opt/bin'),
      observedDigest: null,
    }]);
    // The key is governed now, so it must never be reported as a dropped
    // non-governed key -- that is what would refuse --apply on affected hosts.
    expect(comparison.droppedNonGovernedKeys).toEqual([]);
  });

  it('reports no drift when the installed plist carries the same governed PATH prepend', () => {
    const expected = plistWithEnv({
      PATH: '/opt/bin:/usr/bin',
      WHATSOUP_PATH_PREPEND: '/opt/bin',
    });
    const observed = plistWithEnv({
      PATH: '/opt/bin:/usr/bin',
      WHATSOUP_PATH_PREPEND: '/opt/bin',
    });

    const comparison = compareGovernedLaunchdEnv(expected, observed, { pathPrepend: ['/opt/bin'] });

    expect(comparison.drift).toEqual([]);
    expect(comparison.droppedNonGovernedKeys).toEqual([]);
  });

  it('reports a hand-added PATH prepend with no config source as governed extra drift', () => {
    const expected = plistWithEnv({ PATH: '/usr/bin' });
    const observed = plistWithEnv({ PATH: '/usr/bin', WHATSOUP_PATH_PREPEND: '/opt/hand-added-bin' });

    const comparison = compareGovernedLaunchdEnv(expected, observed);

    expect(comparison.drift).toEqual([{
      key: 'WHATSOUP_PATH_PREPEND',
      state: 'extra',
      expectedDigest: null,
      observedDigest: sha256('/opt/hand-added-bin'),
    }]);
    // Behaviour change disclosed in the PR body: before this key was governed a
    // hand-added value refused --apply as a non-governed drop; now --apply
    // overwrites it.
    expect(comparison.droppedNonGovernedKeys).toEqual([]);
    expect(JSON.stringify(comparison)).not.toContain('hand-added-bin');
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
      droppedNonGovernedKeys: [],
    });
  });
});
