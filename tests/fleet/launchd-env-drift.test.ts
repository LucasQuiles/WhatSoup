/**
 * Governed-env drift comparator: detects missing/extra/mismatched governed
 * EnvironmentVariables keys (CLAUDE_CONFIG_DIR, PATH, WHATSOUP_PATH_PREPEND)
 * between a freshly rendered plist and the installed one, by key and SHA-256
 * value digest only.
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

  it('refuses an installed plist that declares no EnvironmentVariables element', () => {
    // DIRECTION CHANGE, deliberate and disclosed. This used to report every
    // expected governed key as `missing` with comparable: true, so --apply
    // proceeded against a plist whose environment the reader never found. An
    // absent element is not "there are genuinely no keys": that claim also
    // empties droppedNonGovernedKeys, so the apply gate sees nothing to drop
    // and the re-render erases whatever the installed job carried. The caller
    // must acknowledge the drop with --drop-non-governed-env instead.
    //
    // The RENDERED argument is unaffected: buildPlist emits the marker, its
    // dict and PATH as unconditional array literals, so a render always carries
    // the element and can never be refused by this rule.
    const expected = plistWithEnv({ PATH: '/usr/bin' });
    const observed = plistWithEnv(null);

    expect(compareGovernedLaunchdEnv(expected, observed)).toEqual({
      comparable: false,
      reason: 'environment-variables-unparseable',
      drift: [],
      droppedNonGovernedKeys: [],
    });

    // Positive control: the same helper WITH an environment still compares, so
    // the refusal is attributable to the absent element and not to the fixture.
    expect(compareGovernedLaunchdEnv(expected, plistWithEnv({ PATH: '/usr/bin' })).comparable).toBe(true);
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

  // MED-7: the reader must match the dict ELEMENT, not one spelling of it.
  //
  // `<dict>`, `<dict >`, `<dict\n>`, `<dict/>` and `<dict attr="x">` are the
  // same element. Matching the literal '<dict>' let every other spelling of a
  // NESTED dict past the fail-closed guard while the body still truncated at
  // that dict's close, so a governed key declared after it read as absent and
  // was reported as benign 'missing' drift instead of an unparseable plist.
  //
  // The nested dict goes BEFORE the governed key on purpose: with it last,
  // every key is already parsed before the truncation point and the defect
  // cannot show.
  // Nested-dict DETECTION is broad: any dict opening token at all truncates the
  // body and must fail closed. What the reader PARSES is narrower.
  const NESTED_DICT_SPELLINGS = [
    '<dict>',
    '<dict >',
    '<dict\n    >',
    '<dict/>',
    '<dict />',
    '<dict class="x">',
    '<dict foo="a>b">',
  ];
  const OUTER_DICT_SPELLINGS = ['<dict>', '<dict >', '<dict\n  >'];
  const OUTER_SELF_CLOSING_SPELLINGS = ['<dict/>', '<dict />'];
  // An attributed dict is REFUSED, not consumed. `<dict a="x>y">` is legal XML,
  // and consuming to the first '>' would end the token inside the attribute
  // value and read the rest of the opening tag as body pairs.
  const OUTER_DICT_REFUSED_SPELLINGS = ['<dict class="x">', '<dict foo="a>b">'];

  function plistWithSpelledEnv(options: {
    outerSpelling?: string;
    nestedSpelling?: string;
    env?: Record<string, string>;
    trailingEnv?: Record<string, string>;
  }): string {
    const outerSpelling = options.outerSpelling ?? '<dict>';
    const entries = Object.entries(options.env ?? {}).flatMap(([key, value]) => [
      `    <key>${key}</key>`,
      `    <string>${value}</string>`,
    ]);
    if (options.nestedSpelling !== undefined) {
      entries.push(
        options.nestedSpelling.endsWith('/>')
          ? `    <key>Nested</key>${options.nestedSpelling}`
          : `    <key>Nested</key>${options.nestedSpelling}<key>Inner</key><string>x</string></dict>`,
      );
    }
    entries.push(
      ...Object.entries(options.trailingEnv ?? {}).flatMap(([key, value]) => [
        `    <key>${key}</key>`,
        `    <string>${value}</string>`,
      ]),
    );
    const envBlock = outerSpelling.endsWith('/>')
      ? [`  ${outerSpelling}`]
      : [`  ${outerSpelling}`, ...entries, '  </dict>'];
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
      '  <key>EnvironmentVariables</key>',
      ...envBlock,
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
  }

  it.each(NESTED_DICT_SPELLINGS)(
    'fails closed when a nested dict spelled %j hides a governed key',
    (nestedSpelling) => {
      const expected = plistWithSpelledEnv({
        env: { PATH: '/opt/bin:/usr/bin' },
        trailingEnv: { WHATSOUP_PATH_PREPEND: '/opt/bin' },
      });
      const observed = plistWithSpelledEnv({
        nestedSpelling,
        env: { PATH: '/opt/bin:/usr/bin' },
        trailingEnv: { WHATSOUP_PATH_PREPEND: '/opt/bin' },
      });

      expect(compareGovernedLaunchdEnv(observed, observed)).toEqual({
        comparable: false,
        reason: 'environment-variables-unparseable',
        drift: [],
        droppedNonGovernedKeys: [],
      });
      // Against a well-formed render the same plist previously produced a
      // bogus 'missing' row for the key the truncation ate.
      expect(compareGovernedLaunchdEnv(expected, observed).comparable).toBe(false);
    },
  );

  it.each(OUTER_DICT_SPELLINGS)(
    'reads an EnvironmentVariables dict spelled %j',
    (outerSpelling) => {
      const observed = plistWithSpelledEnv({
        outerSpelling,
        env: { PATH: '/opt/bin:/usr/bin', WHATSOUP_PATH_PREPEND: '/opt/bin' },
      });
      const expected = plistWithSpelledEnv({
        env: { PATH: '/opt/bin:/usr/bin', WHATSOUP_PATH_PREPEND: '/opt/bin' },
      });

      const comparison = compareGovernedLaunchdEnv(expected, observed, {
        pathPrepend: ['/opt/bin'],
      });
      expect(comparison.comparable).toBe(true);
      expect(comparison.drift).toEqual([]);
      expect(comparison.droppedNonGovernedKeys).toEqual([]);
    },
  );

  it.each(OUTER_DICT_REFUSED_SPELLINGS)(
    'refuses an EnvironmentVariables dict spelled %j rather than consuming it',
    (outerSpelling) => {
      const expected = plistWithSpelledEnv({ env: { PATH: '/opt/bin:/usr/bin' } });
      const observed = plistWithSpelledEnv({
        outerSpelling,
        env: { PATH: '/opt/bin:/usr/bin', WHATSOUP_PATH_PREPEND: '/opt/bin' },
      });

      expect(compareGovernedLaunchdEnv(expected, observed)).toEqual({
        comparable: false,
        reason: 'environment-variables-unparseable',
        drift: [],
        droppedNonGovernedKeys: [],
      });
    },
  );

  it.each(OUTER_SELF_CLOSING_SPELLINGS)('reads %j as an empty environment', (outerSpelling) => {
    const expected = plistWithSpelledEnv({ env: { PATH: '/opt/bin:/usr/bin' } });
    const observed = plistWithSpelledEnv({ outerSpelling });

    const comparison = compareGovernedLaunchdEnv(expected, observed);
    expect(comparison.comparable).toBe(true);
    expect(comparison.drift).toEqual([{
      key: 'PATH',
      state: 'missing',
      expectedDigest: sha256('/opt/bin:/usr/bin'),
      observedDigest: null,
    }]);
  });

  // The silent-absence class. Each body below is a VALID plist the system
  // parser accepts, which pair-extraction turned into a MISSING governed key.
  // Here that also emptied droppedNonGovernedKeys, so an apply proceeded as
  // though there were no non-governed keys to drop.
  const SILENT_ABSENCE_BODIES: Record<string, string[]> = {
    cdata_value: [
      '    <key>PATH</key><string>/opt/bin:/usr/bin</string>',
      '    <key>WHATSOUP_PATH_PREPEND</key><string><![CDATA[/opt/bin]]></string>',
    ],
    cdata_key_name: [
      '    <key><![CDATA[PATH]]></key><string>/opt/bin:/usr/bin</string>',
    ],
    comment_between_key_and_string: [
      '    <key>PATH</key><string>/opt/bin:/usr/bin</string>',
      '    <key>WHATSOUP_PATH_PREPEND</key><!-- note --><string>/opt/bin</string>',
    ],
    processing_instruction_between_key_and_string: [
      '    <key>PATH</key><string>/opt/bin:/usr/bin</string>',
      '    <key>WHATSOUP_PATH_PREPEND</key><?ide fold?><string>/opt/bin</string>',
    ],
    whitespace_in_key_end_tag: [
      '    <key>PATH</key><string>/opt/bin:/usr/bin</string>',
      '    <key>WHATSOUP_PATH_PREPEND</key ><string>/opt/bin</string>',
    ],
    whitespace_in_string_start_tag: [
      '    <key>PATH</key><string>/opt/bin:/usr/bin</string>',
      '    <key>WHATSOUP_PATH_PREPEND</key><string >/opt/bin</string>',
    ],
    unpaired_key: [
      '    <key>PATH</key><string>/opt/bin:/usr/bin</string>',
      '    <key>WHATSOUP_PATH_PREPEND</key>',
    ],
    duplicate_key: [
      '    <key>PATH</key><string>/opt/bin:/usr/bin</string>',
      '    <key>PATH</key><string>/opt/other/bin</string>',
    ],
  };

  function plistWithRawEnvBody(entries: string[]): string {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      '<dict>',
      '  <key>EnvironmentVariables</key>',
      '  <dict>',
      ...entries,
      '  </dict>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
  }

  it.each(Object.keys(SILENT_ABSENCE_BODIES))('fails closed on %s', (cell) => {
    const expected = plistWithSpelledEnv({
      env: { PATH: '/opt/bin:/usr/bin', WHATSOUP_PATH_PREPEND: '/opt/bin' },
    });
    const observed = plistWithRawEnvBody(SILENT_ABSENCE_BODIES[cell] as string[]);

    expect(compareGovernedLaunchdEnv(expected, observed)).toEqual({
      comparable: false,
      reason: 'environment-variables-unparseable',
      drift: [],
      droppedNonGovernedKeys: [],
    });
  });

  it('reports a non-governed key it can see, so the refusal is not blanket', () => {
    // Positive control for the class above: a body the reader DOES fully consume
    // still enumerates its non-governed keys, which is what an apply relies on.
    const expected = plistWithSpelledEnv({ env: { PATH: '/opt/bin:/usr/bin' } });
    const observed = plistWithRawEnvBody([
      '    <key>PATH</key><string>/opt/bin:/usr/bin</string>',
      '    <key>OPERATOR_SECRET</key><string>keep-me</string>',
    ]);

    const comparison = compareGovernedLaunchdEnv(expected, observed);
    expect(comparison.comparable).toBe(true);
    expect(comparison.droppedNonGovernedKeys).toEqual(['OPERATOR_SECRET']);
    expect(JSON.stringify(comparison)).not.toContain('keep-me');
  });

  // --- HIGH-1: an XML comment is not markup this reader may read ---

  it('cannot be steered by a commented-out decoy dict placed before the live one', () => {
    // Stated as a DIFFERENTIAL, not as one expectation. The same installed
    // plist is compared twice, once with the decoy comment and once with that
    // comment removed, and the two results must be identical. An assertion
    // that only pinned the post-fix value would keep passing if the parser
    // started refusing BOTH, which is a different behaviour wearing the same
    // green.
    const expected = plistWithSpelledEnv({ env: { PATH: '/opt/bin:/usr/bin' } });
    const live = [
      '    <key>PATH</key><string>/opt/bin:/usr/bin</string>',
      '    <key>OPERATOR_SECRET</key><string>keep-me</string>',
    ];
    const decoyed = plistWithRawEnvBody(live).replace(
      '  <key>EnvironmentVariables</key>',
      [
        '  <!-- <key>EnvironmentVariables</key>',
        '  <dict>',
        '    <key>PATH</key><string>/opt/bin:/usr/bin</string>',
        '  </dict> -->',
        '  <key>EnvironmentVariables</key>',
      ].join('\n'),
    );
    const honest = plistWithRawEnvBody(live);

    const decoyedComparison = compareGovernedLaunchdEnv(expected, decoyed);
    expect(decoyedComparison).toEqual(compareGovernedLaunchdEnv(expected, honest));
    // And the shared value is the LIVE dict's, so neither side is the decoy's.
    expect(decoyedComparison.droppedNonGovernedKeys).toEqual(['OPERATOR_SECRET']);
    expect(JSON.stringify(decoyedComparison)).not.toContain('keep-me');
  });

  it('refuses a plist carrying an unterminated comment', () => {
    // Not well-formed XML at all. It used to be ignored outright, so every byte
    // after the opener was read as live markup.
    const expected = plistWithSpelledEnv({ env: { PATH: '/opt/bin:/usr/bin' } });
    const observed = `${plistWithSpelledEnv({ env: { PATH: '/opt/bin:/usr/bin' } })}<!-- never closed\n`;

    expect(compareGovernedLaunchdEnv(expected, observed)).toEqual({
      comparable: false,
      reason: 'environment-variables-unparseable',
      drift: [],
      droppedNonGovernedKeys: [],
    });
  });

  it('masks a comment without letting it act as whitespace', () => {
    // The mask is length-preserving and non-whitespace ON PURPOSE, so the
    // comment_between_key_and_string cell above keeps refusing. This names that
    // coupling, so a future switch from masking to deletion cannot silently
    // relax a pinned fail-closed and still show a green suite.
    const expected = plistWithSpelledEnv({ env: { PATH: '/opt/bin:/usr/bin' } });
    const observed = plistWithRawEnvBody([
      '    <key>PATH</key><!-- interposed --><string>/opt/bin:/usr/bin</string>',
    ]);

    expect(compareGovernedLaunchdEnv(expected, observed).comparable).toBe(false);
  });

  it.each([
    ['non-breaking space', '\u00a0'],
    ['form feed', '\f'],
    ['vertical tab', '\v'],
  ])('refuses %s in the gap between the marker and its dict', (_label, filler) => {
    // glm-3. Body consumption uses the four XML whitespace characters; this one
    // gap still used String.trim(), which also removes these three. The system
    // plist parser rejects them, so the comparator called a plist well-formed
    // that launchd refuses to load. Pre-existing on main.
    const expected = plistWithSpelledEnv({ env: { PATH: '/opt/bin:/usr/bin' } });
    const build = (gap: string) => [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      '<dict>',
      `  <key>EnvironmentVariables</key>${gap}<dict>`,
      '    <key>PATH</key><string>/opt/bin:/usr/bin</string>',
      '  </dict>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n');

    // Positive control: a legal XML-whitespace gap parses, so the refusal is
    // attributable to the filler.
    expect(compareGovernedLaunchdEnv(expected, build('\n  ')).comparable).toBe(true);
    expect(compareGovernedLaunchdEnv(expected, build(`\n ${filler} `)).comparable).toBe(false);
  });

  it('still parses the generator-escaped form, which is not CDATA', () => {
    // Positive control for the refusal: without it, refusing every plist that
    // mentions a '<' would satisfy the rows above and break the shipped form.
    const expected = plistWithSpelledEnv({ env: { PATH: '/opt/&lt;bin' } });
    const observed = plistWithSpelledEnv({ env: { PATH: '/opt/&lt;bin' } });

    const comparison = compareGovernedLaunchdEnv(expected, observed);
    expect(comparison.comparable).toBe(true);
    expect(comparison.drift).toEqual([]);
    expect(comparison.pathPrefix?.expectedDigest).toBe(sha256('/opt/<bin'));
  });

  it('does not carry regex state between the two plists of one comparison', () => {
    // The reader builds its patterns per call. A module-scope /g pattern would
    // keep lastIndex from the expected plist and start the observed plist's
    // search past its own EnvironmentVariables dict.
    const plist = plistWithSpelledEnv({
      env: { PATH: '/opt/bin:/usr/bin', WHATSOUP_PATH_PREPEND: '/opt/bin' },
    });

    for (let i = 0; i < 3; i += 1) {
      const comparison = compareGovernedLaunchdEnv(plist, plist, { pathPrepend: ['/opt/bin'] });
      expect(comparison.comparable).toBe(true);
      expect(comparison.drift).toEqual([]);
    }
  });

  // --- Every inert XML region, not only the comment (queue row 130) ---
  //
  // A comment, a CDATA section and a processing instruction are all inert text
  // to the system plist parser. Only the comment was masked, so a decoy
  // `<key>EnvironmentVariables</key><dict/>` written inside either of the other
  // two won the marker lookup and was read as the live environment. Every
  // fixture below lints clean and `plutil -extract EnvironmentVariables json`
  // returns the REAL environment for it: these are valid plists the
  // authoritative parser reads correctly and this reader read wrongly.
  //
  // The scenario is operator-caused, not attacker-caused. Someone who can write
  // the LaunchAgent can write an honest dict, so an inert-XML shape confers
  // nothing on an attacker. What it does is let a hand-edited or hand-migrated
  // plist pass `--apply` while its own non-governed keys are deleted with NO
  // key named in any message.

  const LIVE_BODY_WITH_NON_GOVERNED_KEY = [
    '    <key>PATH</key><string>/opt/bin:/usr/bin</string>',
    '    <key>OPERATOR_SECRET</key><string>keep-me</string>',
  ];
  const INERT_DECOY_LINES = [
    '  <key>EnvironmentVariables</key>',
    '  <dict/>',
  ];

  it('cannot be steered by a CDATA decoy dict placed before the live one', () => {
    // Stated as a DIFFERENTIAL, exactly like the comment cell above: the same
    // installed plist compared twice, once with the decoy and once without, and
    // the two results must be identical. Pinning only the post-fix value would
    // keep passing if the reader started refusing BOTH, which is different
    // behaviour wearing the same green.
    const expected = plistWithSpelledEnv({ env: { PATH: '/opt/bin:/usr/bin' } });
    const honest = plistWithRawEnvBody(LIVE_BODY_WITH_NON_GOVERNED_KEY);
    const decoyed = honest.replace(
      '  <key>EnvironmentVariables</key>',
      ['  <![CDATA[', ...INERT_DECOY_LINES, '  ]]>', '  <key>EnvironmentVariables</key>'].join('\n'),
    );
    expect(decoyed).toContain('<![CDATA['); // the fixture really carries the decoy

    const decoyedComparison = compareGovernedLaunchdEnv(expected, decoyed);
    expect(decoyedComparison).toEqual(compareGovernedLaunchdEnv(expected, honest));
    // And the shared value is the LIVE dict's, so neither side is the decoy's.
    expect(decoyedComparison.droppedNonGovernedKeys).toEqual(['OPERATOR_SECRET']);
    expect(JSON.stringify(decoyedComparison)).not.toContain('keep-me');
  });

  it('cannot be steered by a processing-instruction decoy dict placed before the live one', () => {
    const expected = plistWithSpelledEnv({ env: { PATH: '/opt/bin:/usr/bin' } });
    const honest = plistWithRawEnvBody(LIVE_BODY_WITH_NON_GOVERNED_KEY);
    const decoyed = honest.replace(
      '  <key>EnvironmentVariables</key>',
      ['  <?ide', ...INERT_DECOY_LINES, '  ?>', '  <key>EnvironmentVariables</key>'].join('\n'),
    );
    expect(decoyed).toContain('<?ide');

    const decoyedComparison = compareGovernedLaunchdEnv(expected, decoyed);
    expect(decoyedComparison).toEqual(compareGovernedLaunchdEnv(expected, honest));
    expect(decoyedComparison.droppedNonGovernedKeys).toEqual(['OPERATOR_SECRET']);
    expect(JSON.stringify(decoyedComparison)).not.toContain('keep-me');
  });

  it('refuses a marker spelled with whitespace in its tags rather than reading an empty environment', () => {
    // `<key >EnvironmentVariables</key >` is the same element to the system
    // parser and a spelling a hand-edit or a migration script can produce. This
    // reader deliberately holds ONE literal spelling, so it does not find the
    // marker -- and the answer to "I could not find the element you are about
    // to overwrite" is a refusal, not an empty map. Parsing the spelling
    // instead would make this reader newly ACCEPT a file it used to refuse,
    // which is a contract widening this change does not take.
    const expected = plistWithSpelledEnv({ env: { PATH: '/opt/bin:/usr/bin' } });
    const honest = plistWithRawEnvBody(LIVE_BODY_WITH_NON_GOVERNED_KEY);

    // Positive control: the canonical spelling of the SAME body enumerates the
    // non-governed key, so the refusal below is attributable to the spelling.
    expect(compareGovernedLaunchdEnv(expected, honest).droppedNonGovernedKeys)
      .toEqual(['OPERATOR_SECRET']);

    const spelled = honest.replace(
      '  <key>EnvironmentVariables</key>',
      '  <key >EnvironmentVariables</key >',
    );
    const comparison = compareGovernedLaunchdEnv(expected, spelled);
    expect(comparison).toEqual({
      comparable: false,
      reason: 'environment-variables-unparseable',
      drift: [],
      droppedNonGovernedKeys: [],
    });
    expect(JSON.stringify(comparison)).not.toContain('keep-me');
  });

  it('refuses a plist that declares EnvironmentVariables twice rather than picking a precedence', () => {
    // "Exactly one top-level EnvironmentVariables dictionary." The system parser
    // has its own precedence for a repeated key; this reader took the FIRST and
    // would otherwise report a decoy map the loaded job does not have.
    const expected = plistWithSpelledEnv({ env: { PATH: '/opt/bin:/usr/bin' } });
    const honest = plistWithRawEnvBody(LIVE_BODY_WITH_NON_GOVERNED_KEY);
    const twice = honest.replace(
      '  <key>EnvironmentVariables</key>',
      [
        '  <key>EnvironmentVariables</key>',
        '  <dict><key>PATH</key><string>/opt/decoy-bin</string></dict>',
        '  <key>EnvironmentVariables</key>',
      ].join('\n'),
    );

    expect(compareGovernedLaunchdEnv(expected, twice)).toEqual({
      comparable: false,
      reason: 'environment-variables-unparseable',
      drift: [],
      droppedNonGovernedKeys: [],
    });
    // Positive control: one declaration of the same body still compares.
    expect(compareGovernedLaunchdEnv(expected, honest).comparable).toBe(true);
  });

  it('keeps refusing a CDATA value inside the body, which masking alone would have let through', () => {
    // THE CELL THE MASK ALONE WOULD HAVE OPENED, measured rather than reasoned.
    // The mask blanks an inert region to '-', and '-' is legal CHARACTER DATA:
    // `<string><![CDATA[/opt/bin]]></string>` masks to `<string>` + twenty
    // dashes + `</string>`, which the pair pattern's [^<]* value group matches.
    // The body would then have counted as "fully consumed" and parsed to a
    // dash-valued key -- a cell that fails closed today turned fail-open by its
    // own fix. The whitespace rules cannot catch it, because the region is not
    // in a whitespace-only gap; the reader refuses on a masked span
    // INTERSECTING the body, and removing that intersection check is what makes
    // this test fail.
    const expected = plistWithSpelledEnv({
      env: { PATH: '/opt/bin:/usr/bin', WHATSOUP_PATH_PREPEND: '/opt/bin' },
    });
    const observed = plistWithRawEnvBody([
      '    <key>PATH</key><string>/opt/bin:/usr/bin</string>',
      '    <key>WHATSOUP_PATH_PREPEND</key><string><![CDATA[/opt/bin]]></string>',
    ]);

    const comparison = compareGovernedLaunchdEnv(expected, observed);
    expect(comparison.comparable).toBe(false);
    // No masked filler ever became a value: the report carries no dash run.
    expect(JSON.stringify(comparison)).not.toContain('--');
  });

  it('masks the earliest inert opener, so a processing instruction carrying a comment opener stays one region', () => {
    // A processing instruction may carry '<!--' as literal text, and a comment
    // may carry '<?'. Searching one kind before the others rather than taking
    // the EARLIEST opener splits one region into a mismatched pair: here the
    // '<!--' inside the instruction has no '-->', so a comment-first scan would
    // call the file unterminated and refuse a plist the system parser loads.
    const expected = plistWithSpelledEnv({ env: { PATH: '/opt/bin:/usr/bin' } });
    const honest = plistWithRawEnvBody(LIVE_BODY_WITH_NON_GOVERNED_KEY);
    const nested = honest.replace(
      '  <key>EnvironmentVariables</key>',
      ['  <?ide fold <!-- not a comment ?>', '  <key>EnvironmentVariables</key>'].join('\n'),
    );

    const comparison = compareGovernedLaunchdEnv(expected, nested);
    expect(comparison).toEqual(compareGovernedLaunchdEnv(expected, honest));
    expect(comparison.droppedNonGovernedKeys).toEqual(['OPERATOR_SECRET']);
  });
});
