import { describe, expect, it } from 'vitest';

import { jidPattern } from '../../src/lib/redaction-patterns.ts';

// The five historical per-module JID regexes this SSOT replaces, pinned as
// baselines so the gate proves the canonical NEVER under-redacts relative to any
// of them (output-diff gate for CQ-02/CQ-05).
const OLD_REGEXES: Record<string, () => RegExp> = {
  authCli: () => /\b\d{5,}(?:-\d+)?(?::\d+)?@(s\.whatsapp\.net|g\.us|lid)\b/gi,
  console: () => /\b\d{5,}(?::\d+)?@(s\.whatsapp\.net|lid|g\.us)\b/g,
  connection: () => /\b\d{5,}(?::\d+)?@(s\.whatsapp\.net|lid|g\.us)\b/g,
  botErrors: () => /\b\d{5,}(?:-\d+)?@(s\.whatsapp\.net|g\.us|lid)\b/gi,
  health: () => /\b\d{5,}(?:-\d+)?@(s\.whatsapp\.net|g\.us|lid)\b/gi,
};

const JID_INPUTS = [
  'contact 12345@s.whatsapp.net online',
  '12345-6@s.whatsapp.net', // device suffix -N (console/connection MISS)
  '12345:7@s.whatsapp.net', // port suffix :N (botErrors/health MISS)
  '12345-6:7@lid', // both suffixes (only authCli caught)
  '99999@S.WHATSAPP.NET', // uppercase domain (case-sensitive copies MISS)
  '12345@g.us',
  '12345@lid',
  '1234567890-1@g.us',
];

const NEGATIVES = [
  'order #12345 shipped today',
  'email user@s.whatsapp.net', // no 5+ digit run before @
  '1234@lid', // only 4 digits (below \d{5,})
  'visit https://example.com/path',
];

describe('jidPattern (redaction SSOT — CQ-02/05)', () => {
  it('returns a fresh regex each call (no shared /g lastIndex state)', () => {
    expect(jidPattern()).not.toBe(jidPattern());
    const r = jidPattern();
    r.lastIndex = 5;
    expect(jidPattern().lastIndex).toBe(0);
  });

  it('is a strict SUPERSET of every historical regex — never under-redacts', () => {
    for (const input of JID_INPUTS) {
      for (const [name, make] of Object.entries(OLD_REGEXES)) {
        if (make().test(input)) {
          expect(
            jidPattern().test(input),
            `${name} redacted "${input}" but the canonical did not`,
          ).toBe(true);
        }
      }
    }
  });

  it('catches the specific JIDs each old copy MISSED (the under-redaction fix)', () => {
    // device suffix -N: the :N-only copies (console/connection) leaked it
    expect(OLD_REGEXES.console().test('12345-6@s.whatsapp.net')).toBe(false);
    expect(jidPattern().test('12345-6@s.whatsapp.net')).toBe(true);
    // port suffix :N: the -N-only copies (botErrors/health) leaked it
    expect(OLD_REGEXES.botErrors().test('12345:7@s.whatsapp.net')).toBe(false);
    expect(jidPattern().test('12345:7@s.whatsapp.net')).toBe(true);
    // uppercase domain: the case-sensitive copies (console/connection) leaked it
    expect(OLD_REGEXES.connection().test('99999@S.WHATSAPP.NET')).toBe(false);
    expect(jidPattern().test('99999@S.WHATSAPP.NET')).toBe(true);
  });

  it('does not over-redact benign inputs (no new false positives)', () => {
    for (const input of NEGATIVES) {
      expect(jidPattern().test(input), `canonical false-positive on "${input}"`).toBe(false);
    }
  });

  it('strips every JID variant when used in .replace', () => {
    for (const input of JID_INPUTS) {
      expect(input.replace(jidPattern(), '[J]')).not.toMatch(/@(s\.whatsapp\.net|g\.us|lid)/i);
    }
  });
});
