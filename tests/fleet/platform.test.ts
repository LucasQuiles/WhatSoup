import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  escapeXml,
  buildPlist,
  systemdUnitName,
  detectPlatform,
  createServiceManager,
  DockerSupervisorServiceManager,
  _resetPlatformCache,
} from '../../src/fleet/platform.ts';

describe('platform', () => {
  describe('escapeXml', () => {
    it('escapes ampersands', () => {
      expect(escapeXml('a&b')).toBe('a&amp;b');
    });

    it('escapes angle brackets', () => {
      expect(escapeXml('a<b>c')).toBe('a&lt;b&gt;c');
    });

    it('escapes quotes', () => {
      expect(escapeXml('a"b\'c')).toBe('a&quot;b&apos;c');
    });

    it('handles empty string', () => {
      expect(escapeXml('')).toBe('');
    });

    it('handles string with no special chars', () => {
      expect(escapeXml('hello world')).toBe('hello world');
    });

    it('escapes mixed content', () => {
      expect(escapeXml('1 < 2 & 3 > 0 "yes"')).toBe('1 &lt; 2 &amp; 3 &gt; 0 &quot;yes&quot;');
    });

    it('escapes CDATA end marker', () => {
      expect(escapeXml(']]>')).toBe(']]&gt;');
    });

    it('handles multiple consecutive special chars', () => {
      expect(escapeXml('&&&<<<>>>')).toBe('&amp;&amp;&amp;&lt;&lt;&lt;&gt;&gt;&gt;');
    });
  });

  describe('buildPlist', () => {
    it('produces valid XML structure', () => {
      const plist = buildPlist('test-instance');
      expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(plist).toContain('<plist version="1.0">');
      expect(plist).toContain('</plist>');
      expect(plist).toContain('<string>com.whatsoup.test-instance</string>');
    });

    it('escapes PATH containing special XML characters', () => {
      const origPath = process.env.PATH;
      process.env.PATH = '/usr/bin:/opt/something&weird/bin:</dangerous>';
      try {
        const plist = buildPlist('test');
        // The raw dangerous chars must NOT appear unescaped
        expect(plist).not.toContain('&weird');
        expect(plist).toContain('&amp;weird');
        expect(plist).toContain('&lt;/dangerous&gt;');
        // Should not contain raw < or > in string values
        expect(plist).not.toMatch(/<string>[^<]*<\/dangerous[^<]*<\/string>/);
      } finally {
        process.env.PATH = origPath;
      }
    });

    it('escapes instance name in label', () => {
      // Instance names are validated to [a-z][a-z0-9-]* by ops.ts,
      // but buildPlist should still be safe for any input
      const plist = buildPlist('safe-name');
      expect(plist).toContain('com.whatsoup.safe-name');
    });

    it('includes KeepAlive Crashed semantics', () => {
      const plist = buildPlist('test');
      expect(plist).toContain('<key>Crashed</key>');
      expect(plist).toContain('<true/>');
    });

    it('includes log paths', () => {
      const plist = buildPlist('myapp');
      expect(plist).toContain('stdout.log');
      expect(plist).toContain('stderr.log');
    });

    it('pins TMPDIR to the instance media tmp directory', () => {
      const origDataHome = process.env.XDG_DATA_HOME;
      process.env.XDG_DATA_HOME = '/owned/data';
      try {
        const plist = buildPlist('media-bot');
        expect(plist).toContain('<key>TMPDIR</key>');
        expect(plist).toContain('<string>/owned/data/whatsoup/tmp/media-bot</string>');
      } finally {
        if (origDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = origDataHome;
      }
    });

    it('threads WHATSOUP_NODE into generated launchd plists when configured', () => {
      const origNode = process.env.WHATSOUP_NODE;
      process.env.WHATSOUP_NODE = '/opt/homebrew/bin/node';
      try {
        const plist = buildPlist('node-pinned');
        expect(plist).toContain('<key>WHATSOUP_NODE</key>');
        expect(plist).toContain('<string>/opt/homebrew/bin/node</string>');
      } finally {
        if (origNode === undefined) delete process.env.WHATSOUP_NODE;
        else process.env.WHATSOUP_NODE = origNode;
      }
    });
  });

  describe('buildPlist native-keychain credential default', () => {
    // The generated bot plist MUST NOT set CLAUDE_CONFIG_DIR. Its presence switches
    // claude-cli from native login-keychain reads to file-store reads
    // ($DIR/.credentials.json) — a mode that (a) needs a file fresh hosts lack and
    // (b) hit an unresolved ~/.claude token-rejection on ar-bot (2026-07-05) and a
    // strip clobber on rb-bot (2026-06-24). Native-keychain is the fleet standard
    // (mini1/3/4/8/27). This locks the generator default so a future edit cannot
    // silently reintroduce the file-store pin (reversing runbook A2's 07-02 direction).
    it('does NOT emit a CLAUDE_CONFIG_DIR launchd key (native-keychain default)', () => {
      const plist = buildPlist('any-instance');
      // Key-form assertion: the rendered plist interpolates $PATH/$WHATSOUP_NODE,
      // so a whole-plist substring scan is environment-dependent (a PATH entry
      // containing the literal string false-reds the suite — review finding 7).
      expect(plist).not.toContain('<key>CLAUDE_CONFIG_DIR</key>');
    });

    it('stays green when the runtime PATH itself contains the literal string (env-poison regression)', () => {
      const origPath = process.env.PATH;
      process.env.PATH = `/opt/backups/CLAUDE_CONFIG_DIR-migration/bin:${origPath}`;
      try {
        const plist = buildPlist('any-instance');
        expect(plist).not.toContain('<key>CLAUDE_CONFIG_DIR</key>');
      } finally {
        process.env.PATH = origPath;
      }
    });

    it('DOES emit the expected launchd env keys (keeps the assertion non-vacuous)', () => {
      const plist = buildPlist('any-instance');
      expect(plist).toContain('<key>PATH</key>');
      expect(plist).toContain('<key>HOME</key>');
      expect(plist).toContain('<key>TMPDIR</key>');
    });
  });
});

describe('systemdUnitName', () => {
  const templateUnit = (name: string) => ['whatsoup', name].join('@') + '.service';

  it('maps normal instances to the WhatSoup template unit', () => {
    expect(systemdUnitName('q')).toBe(templateUnit('q'));
    expect(systemdUnitName('shandroid')).toBe(templateUnit('shandroid'));
  });

  it('maps the fleet server to its standalone service, not the instance template', () => {
    expect(systemdUnitName('whatsoup-fleet')).toBe('whatsoup-fleet.service');
    expect(systemdUnitName('whatsoup-fleet')).not.toBe(templateUnit('whatsoup-fleet'));
  });
});

// ---------------------------------------------------------------------------
// Docker platform detection
// ---------------------------------------------------------------------------

describe('detectPlatform — Docker detection', () => {
  let savedDocker: string | undefined;

  beforeEach(() => {
    savedDocker = process.env.WHATSOUP_DOCKER;
    delete process.env.WHATSOUP_DOCKER;
    _resetPlatformCache();
  });

  afterEach(() => {
    if (savedDocker === undefined) delete process.env.WHATSOUP_DOCKER;
    else process.env.WHATSOUP_DOCKER = savedDocker;
    _resetPlatformCache();
    vi.restoreAllMocks();
  });

  it('returns docker when WHATSOUP_DOCKER=1', () => {
    process.env.WHATSOUP_DOCKER = '1';
    expect(detectPlatform()).toBe('docker');
  });

  it('does not detect docker when WHATSOUP_DOCKER is unset', () => {
    const platform = detectPlatform();
    expect(platform).not.toBe('docker');
  });

  it('caches the result after first detection', () => {
    process.env.WHATSOUP_DOCKER = '1';
    const first = detectPlatform();
    delete process.env.WHATSOUP_DOCKER;
    const second = detectPlatform();
    expect(first).toBe('docker');
    expect(second).toBe('docker'); // cached
  });

  it('_resetPlatformCache clears the cache', () => {
    process.env.WHATSOUP_DOCKER = '1';
    expect(detectPlatform()).toBe('docker');

    _resetPlatformCache();
    delete process.env.WHATSOUP_DOCKER;
    expect(detectPlatform()).not.toBe('docker');
  });
});

// ---------------------------------------------------------------------------
// DockerSupervisorServiceManager
// ---------------------------------------------------------------------------

describe('DockerSupervisorServiceManager', () => {
  it('enable and disable are no-ops that resolve', async () => {
    const mgr = new DockerSupervisorServiceManager();
    await expect(mgr.enable()).resolves.toBeUndefined();
    await expect(mgr.disable()).resolves.toBeUndefined();
  });

  it('stop on unknown instance is a no-op', async () => {
    const mgr = new DockerSupervisorServiceManager();
    await expect(mgr.stop('nonexistent')).resolves.toBeUndefined();
  });

  it('startFire delegates to start() and invokes onError with null on success', async () => {
    const mgr = new DockerSupervisorServiceManager();
    const startSpy = vi.spyOn(mgr, 'start').mockResolvedValue(undefined);
    const onError = vi.fn();

    mgr.startFire('test-instance', onError);
    // startFire schedules start() then routes its result to onError via a
    // .then/.catch chain. Wait until onError is invoked rather than draining a
    // fixed number of microtasks.
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(null));

    expect(startSpy).toHaveBeenCalledWith('test-instance');
  });

  it('startFire invokes onError with Error when start() rejects', async () => {
    const mgr = new DockerSupervisorServiceManager();
    const err = new Error('spawn failed');
    vi.spyOn(mgr, 'start').mockRejectedValue(err);
    const onError = vi.fn();

    mgr.startFire('test-instance', onError);
    // Wait until the rejection has propagated through the .catch chain into
    // onError; no fixed microtask drain.
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(err));
  });
});

// ---------------------------------------------------------------------------
// createServiceManager — Docker path
// ---------------------------------------------------------------------------

describe('createServiceManager — Docker path', () => {
  let savedDocker: string | undefined;

  beforeEach(() => {
    savedDocker = process.env.WHATSOUP_DOCKER;
    _resetPlatformCache();
  });

  afterEach(() => {
    if (savedDocker === undefined) delete process.env.WHATSOUP_DOCKER;
    else process.env.WHATSOUP_DOCKER = savedDocker;
    _resetPlatformCache();
  });

  it('returns DockerSupervisorServiceManager when WHATSOUP_DOCKER=1', () => {
    process.env.WHATSOUP_DOCKER = '1';
    const mgr = createServiceManager();
    expect(mgr).toBeInstanceOf(DockerSupervisorServiceManager);
  });
});
