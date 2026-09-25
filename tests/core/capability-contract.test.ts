/**
 * D1 — capability requirement is an instance-declared, versioned contract
 * (capability-obligation replay design).
 *
 * Rules are limited to exact leading command token, exact WHATWG-hostname URL
 * allowlist membership, and declared prepared-media class. Unknown, absent, or
 * conflicting rules create no dispatchable requirement. The persisted decision
 * records contract version, matched rule id/kind, normalized match value,
 * required capability, and input digest.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  evaluateCapabilityContract,
  parseCapabilityContract,
  parseCapabilityObligationsOptions,
} from '../../src/core/capability-contract.ts';

const CONTRACT_RAW = {
  version: 'test-contract/2026-08-12.1',
  rules: [
    { id: 'watch-token', kind: 'leading_token', token: '/watch', capability: 'child_process_tools' },
    {
      id: 'watch-url',
      kind: 'url_host',
      hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'app.clickup.com'],
      capability: 'child_process_tools',
    },
    { id: 'watch-media', kind: 'media_class', mediaClass: 'document', capability: 'child_process_tools' },
    { id: 'watch-video', kind: 'media_class', mediaClass: 'video', capability: 'child_process_tools' },
  ],
} as const;

const contract = () => parseCapabilityContract(CONTRACT_RAW);

const digestOf = (text: string, media?: string) =>
  createHash('sha256').update(`${text}\n${media ?? ''}`).digest('hex');

describe('parseCapabilityContract', () => {
  it('accepts the incident contract shape', () => {
    const c = contract();
    expect(c.version).toBe('test-contract/2026-08-12.1');
    expect(c.rules).toHaveLength(4);
  });

  it('rejects an audio media-class rule by construction (transcription is in-process)', () => {
    expect(() =>
      parseCapabilityContract({
        version: 'x/1',
        rules: [{ id: 'bad', kind: 'media_class', mediaClass: 'audio', capability: 'child_process_tools' }],
      }),
    ).toThrow();
  });

  it('rejects duplicate rule ids', () => {
    expect(() =>
      parseCapabilityContract({
        version: 'x/1',
        rules: [
          { id: 'dup', kind: 'leading_token', token: '/a', capability: 'cap_a' },
          { id: 'dup', kind: 'leading_token', token: '/b', capability: 'cap_b' },
        ],
      }),
    ).toThrow();
  });

  it('rejects non-lowercase, schemed, ported, or pathed host allowlist entries', () => {
    for (const host of ['YouTube.com', 'https://youtube.com', 'youtube.com:443', 'youtube.com/v', ' youtube.com']) {
      expect(() =>
        parseCapabilityContract({
          version: 'x/1',
          rules: [{ id: 'h', kind: 'url_host', hosts: [host], capability: 'c' }],
        }),
      ).toThrow();
    }
  });
});

describe('evaluateCapabilityContract — URL-host rule (seq-7761 recurrence class)', () => {
  // Positive incident fixtures required verbatim by D1.
  for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']) {
    it(`matches a bare https URL on ${host}`, () => {
      const text = `check this out https://${host}/watch?v=abc123`;
      const d = evaluateCapabilityContract(contract(), { text });
      expect(d.outcome).toBe('match');
      if (d.outcome !== 'match') return;
      expect(d.ruleId).toBe('watch-url');
      expect(d.ruleKind).toBe('url_host');
      expect(d.capability).toBe('child_process_tools');
      expect(d.normalizedMatchValue).toBe(host);
      expect(d.contractVersion).toBe('test-contract/2026-08-12.1');
      expect(d.inputDigest).toBe(digestOf(text));
    });
  }

  it('matches an uppercase-host URL via lowercased WHATWG hostname', () => {
    const d = evaluateCapabilityContract(contract(), { text: 'https://YouTube.com/watch?v=x' });
    expect(d.outcome).toBe('match');
    if (d.outcome === 'match') expect(d.normalizedMatchValue).toBe('youtube.com');
  });

  it('matches plain http as well as https', () => {
    const d = evaluateCapabilityContract(contract(), { text: 'http://youtu.be/abc' });
    expect(d.outcome).toBe('match');
  });

  // Negative fixtures required verbatim by D1.
  it('rejects suffix spoofs — no suffix matching', () => {
    for (const url of [
      'https://notyoutube.com/watch?v=x',
      'https://youtube.com.evil.example/watch?v=x',
      'https://evil-youtube.com/x',
      'https://youtu.be.attacker.io/x',
    ]) {
      const d = evaluateCapabilityContract(contract(), { text: url });
      expect(d.outcome).toBe('no_match');
    }
  });

  it('rejects URLs carrying userinfo/credentials', () => {
    // Assembled at runtime so the repo text carries no email-shaped literal.
    const withUserinfo = (host: string) => ['https://spoof:creds', `${host}/watch?v=x`].join('@');
    const d = evaluateCapabilityContract(contract(), { text: withUserinfo('youtube.com') });
    expect(d.outcome).toBe('no_match');
    const d2 = evaluateCapabilityContract(contract(), { text: withUserinfo('youtu.be') });
    expect(d2.outcome).toBe('no_match');
  });

  it('rejects non-HTTP schemes', () => {
    for (const url of ['ftp://youtube.com/x', 'file://youtube.com/x', 'javascript:alert(1)']) {
      const d = evaluateCapabilityContract(contract(), { text: url });
      expect(d.outcome).toBe('no_match');
    }
  });

  it('rejects invalid URLs without throwing', () => {
    const d = evaluateCapabilityContract(contract(), { text: 'https://%%%invalid%%%' });
    expect(d.outcome).toBe('no_match');
  });

  it('does not match hosts absent from the allowlist', () => {
    const d = evaluateCapabilityContract(contract(), { text: 'https://vimeo.com/12345' });
    expect(d.outcome).toBe('no_match');
  });
});

describe('evaluateCapabilityContract — leading-token rule', () => {
  it('matches the exact leading token', () => {
    const d = evaluateCapabilityContract(contract(), { text: '/watch please summarize this' });
    expect(d.outcome).toBe('match');
    if (d.outcome !== 'match') return;
    expect(d.ruleId).toBe('watch-token');
    expect(d.normalizedMatchValue).toBe('/watch');
  });

  it('does not match a mid-text token', () => {
    const d = evaluateCapabilityContract(contract(), { text: 'please /watch this' });
    expect(d.outcome).toBe('no_match');
  });

  it('does not match a token prefix', () => {
    const d = evaluateCapabilityContract(contract(), { text: '/watchful eyes' });
    expect(d.outcome).toBe('no_match');
  });

  it('a BARE leading token with no argument is no_match (undrainable empty source)', () => {
    // '/watch' alone has no source to execute against; an empty sourceToken would
    // mint an obligation whose execute_capability source can never be supplied.
    expect(evaluateCapabilityContract(contract(), { text: '/watch' }).outcome).toBe('no_match');
    expect(evaluateCapabilityContract(contract(), { text: '   /watch   ' }).outcome).toBe('no_match');
  });
});

describe('evaluateCapabilityContract — media-class rule', () => {
  it('matches a declared document class', () => {
    const text = 'Weekly Tracker Updates.webm';
    const d = evaluateCapabilityContract(contract(), { text, preparedMediaClass: 'document' });
    expect(d.outcome).toBe('match');
    if (d.outcome !== 'match') return;
    expect(d.ruleId).toBe('watch-media');
    expect(d.normalizedMatchValue).toBe('document');
    expect(d.inputDigest).toBe(digestOf(text, 'document'));
  });

  it('never matches audio even when text would not match (in-process transcription)', () => {
    const d = evaluateCapabilityContract(contract(), { text: 'can you review', preparedMediaClass: 'audio' });
    expect(d.outcome).toBe('no_match');
  });

  it('does not match undeclared classes', () => {
    const d = evaluateCapabilityContract(contract(), { text: 'x', preparedMediaClass: 'image' });
    expect(d.outcome).toBe('no_match');
  });
});

describe('evaluateCapabilityContract — conflict and absence are fail-closed', () => {
  it('reports conflict when multiple rules match (token + URL)', () => {
    const d = evaluateCapabilityContract(contract(), { text: '/watch https://youtube.com/watch?v=x' });
    expect(d.outcome).toBe('conflict');
    if (d.outcome !== 'conflict') return;
    expect(d.ruleIds.sort()).toEqual(['watch-token', 'watch-url']);
  });

  it('reports conflict when URL and media class match together', () => {
    const d = evaluateCapabilityContract(contract(), {
      text: 'https://youtu.be/x',
      preparedMediaClass: 'video',
    });
    expect(d.outcome).toBe('conflict');
  });

  it('plain text with no media matches nothing', () => {
    const d = evaluateCapabilityContract(contract(), { text: 'good morning, how are you?' });
    expect(d.outcome).toBe('no_match');
    if (d.outcome !== 'no_match') return;
    expect(d.inputDigest).toBe(digestOf('good morning, how are you?'));
  });

  it('an empty contract matches nothing', () => {
    const empty = parseCapabilityContract({ version: 'x/1', rules: [] });
    const d = evaluateCapabilityContract(empty, { text: 'https://youtube.com/x' });
    expect(d.outcome).toBe('no_match');
  });
});

describe('parseCapabilityObligationsOptions — all-or-inert activation', () => {
  const VALID = {
    enabled: true,
    contract: CONTRACT_RAW,
    mediaRoot: '/var/obligation-media',
    retentionPolicyVersion: 'policy/1',
    retentionHorizonDays: 30,
    // #3221 Debt 4 typed execution contract: the artifact and mode are declared
    // structurally ({ interpreter, resolverArtifactPath, args }); `command` and
    // `interpreted` are DERIVED by the schema. Validation here is syntactic
    // (Zod only) — the paths need not exist on disk for a parse test.
    execution: { interpreter: '/usr/bin/node', resolverArtifactPath: '/opt/watch/resolver.cjs', args: ['{source}'], timeoutMs: 30_000, minOutputBytes: 8 },
    attestation: {
      skillName: 'watch',
      skillVersion: '1.0.0',
      skillDigest: 'digest-1',
      resolverDigest: 'resolver-1',
      dependencyVersions: { 'yt-dlp': '2026.03.17' },
      probeVersion: 'probe/1',
      canaryId: 'canary-1',
    },
  };

  it('absent, null, or not-explicitly-enabled config is inert (null)', () => {
    expect(parseCapabilityObligationsOptions(undefined)).toBeNull();
    expect(parseCapabilityObligationsOptions(null)).toBeNull();
    expect(parseCapabilityObligationsOptions({ ...VALID, enabled: false })).toBeNull();
    expect(parseCapabilityObligationsOptions({ ...VALID, enabled: 'yes' })).toBeNull();
  });

  it('a fully valid enabled body parses', () => {
    const options = parseCapabilityObligationsOptions(VALID);
    expect(options?.contract.version).toBe('test-contract/2026-08-12.1');
    expect(options?.attestation.canaryId).toBe('canary-1');
  });

  it('enabled with a malformed body FAILS CLOSED (throws; never a partial activation)', () => {
    expect(() => parseCapabilityObligationsOptions({ enabled: true })).toThrow();
    expect(() => parseCapabilityObligationsOptions({ ...VALID, mediaRoot: '' })).toThrow();
    // A-08: an infinite or absent retention horizon is unrepresentable.
    expect(() => parseCapabilityObligationsOptions({ ...VALID, retentionHorizonDays: undefined })).toThrow();
    expect(() => parseCapabilityObligationsOptions({ ...VALID, retentionHorizonDays: 0 })).toThrow();
    expect(() => parseCapabilityObligationsOptions({ ...VALID, retentionHorizonDays: 10_000 })).toThrow();
    expect(() => parseCapabilityObligationsOptions({ ...VALID, execution: undefined })).toThrow();
    // The resolver args must reference the source placeholder.
    expect(() =>
      parseCapabilityObligationsOptions({
        ...VALID,
        execution: { ...VALID.execution, args: ['--json'] },
      }),
    ).toThrow();
    expect(() =>
      parseCapabilityObligationsOptions({
        ...VALID,
        contract: { version: 'x/1', rules: [{ id: 'bad', kind: 'media_class', mediaClass: 'audio', capability: 'c' }] },
      }),
    ).toThrow();
    expect(() =>
      parseCapabilityObligationsOptions({ ...VALID, attestation: { ...VALID.attestation, canaryId: '' } }),
    ).toThrow();
  });

  it('typed struct (#3221 Debt 4): a missing artifact or mode declaration FAILS CLOSED at LOAD (never deferred to the drain seam)', () => {
    // resolverArtifactPath is a REQUIRED key of the typed struct.
    expect(() =>
      parseCapabilityObligationsOptions({
        ...VALID,
        execution: { interpreter: '/usr/bin/node', args: ['{source}'], timeoutMs: 30_000, minOutputBytes: 8 },
      }),
    ).toThrow();
    // The interpreter KEY is required (pass null for direct mode) — mode is declared, never guessed.
    expect(() =>
      parseCapabilityObligationsOptions({
        ...VALID,
        execution: { resolverArtifactPath: '/opt/watch/resolver.cjs', args: ['{source}'], timeoutMs: 30_000, minOutputBytes: 8 },
      }),
    ).toThrow();
    // The legacy free-form command/interpreted body is unrepresentable (strict shape).
    expect(() =>
      parseCapabilityObligationsOptions({
        ...VALID,
        execution: { command: ['/usr/bin/node', '/opt/watch/resolver.cjs', '{source}'], timeoutMs: 30_000, minOutputBytes: 8, resolverArtifactPath: '/opt/watch/resolver.cjs', interpreted: true },
      }),
    ).toThrow();
  });

  it('round-20 refine carried into the typed struct: a BARE interpreter name (no path separator) is refused at LOAD — a $PATH-resolved interpreter is unpinnable', () => {
    expect(() =>
      parseCapabilityObligationsOptions({
        ...VALID,
        execution: { interpreter: 'node', resolverArtifactPath: '/opt/watch/resolver.cjs', args: ['{source}'], timeoutMs: 30_000, minOutputBytes: 8 },
      }),
    ).toThrow(/explicit interpreter PATH|unpinnable/);
    // Direct mode (interpreter: null) does NOT require a path separator in the artifact (it may be
    // declared relative and is realpath-resolved at verify time, not here); the schema derives
    // command/interpreted from the typed declaration.
    const direct = parseCapabilityObligationsOptions({
      ...VALID,
      execution: { interpreter: null, resolverArtifactPath: '/opt/watch/resolver', args: ['{source}'], timeoutMs: 30_000, minOutputBytes: 8 },
    });
    expect(direct).not.toBeNull();
    expect(direct?.execution.command).toEqual(['/opt/watch/resolver', '{source}']);
    expect(direct?.execution.interpreted).toBe(false);
  });
});
