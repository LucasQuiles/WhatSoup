import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  FEATURE_VERSION,
  MAX_SHADOW_TEXT_UTF16,
  normalizeShadowText,
  type ShadowGateInput,
} from '../../src/core/shadow-gate-features.ts';
import {
  COMPILED_SHADOW_PATTERNS,
  RULES_SHA256,
  RULES_VERSION,
  SHADOW_GATE_RULES_PATH,
  compileShadowRules,
  evaluateShadowGate,
  shadowGate,
  type ShadowRuleId,
  type ShadowVerdict,
} from '../../src/core/shadow-gate.ts';

interface ConformanceCase {
  name: string;
  input: ShadowGateInput;
  expected: { verdict: ShadowVerdict; ruleId: ShadowRuleId };
}

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/shadow-gate-conformance.json', import.meta.url));
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
  fixtureVersion: number;
  rulesVersion: number;
  cases: ConformanceCase[];
};

const RULES_TEXT = readFileSync(SHADOW_GATE_RULES_PATH, 'utf8');

const groupAck: ShadowGateInput = {
  chatKind: 'group',
  isOwner: false,
  isBotSender: false,
  mentionedSelf: false,
  isControlChat: false,
  contentType: 'text',
  quoted: false,
  text: 'ok',
  truncated: false,
  contextStatus: 'known',
  pendingObligation: false,
  featureVersion: 1,
};

describe('shadowGate conformance fixture', () => {
  it('is versioned against the shipped rules and has at least 30 cases', () => {
    expect(fixture.fixtureVersion).toBe(1);
    expect(fixture.rulesVersion).toBe(RULES_VERSION);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(30);
    expect(new Set(fixture.cases.map((c) => c.name)).size).toBe(fixture.cases.length);
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(shadowGate(c.input)).toEqual(c.expected);
  });

  it('covers every rule reachable with the shipped rules', () => {
    const covered = new Set(fixture.cases.map((c) => c.expected.ruleId));
    const reachable: ShadowRuleId[] = [
      'S01_OWNER', 'S02_DM', 'S03_CONTROL', 'S04_MENTION', 'S05_QUOTED', 'S06_NONTEXT',
      'S07_UNKNOWN', 'S08_OBLIGATION', 'X02_STATUS_ONLY', 'D00_DEFAULT',
    ];
    for (const id of reachable) expect(covered, id).toContain(id);
  });
});

describe('shadowGate rule semantics', () => {
  it('reaches X03 only through a noReplyKnown pattern, after X02', () => {
    const rules = compileShadowRules({
      rulesVersion: 1,
      flags: 'i',
      statusOnly: [{ id: 'ack', pattern: '^ok$' }],
      obligation: [],
      noReplyKnown: [{ id: 'fyi', pattern: '^fyi\\b' }],
    });
    expect(evaluateShadowGate({ ...groupAck, text: 'FYI the build is green' }, rules)).toEqual({
      verdict: 'SUPPRESS',
      ruleId: 'X03_NO_REPLY_PATTERN',
    });
    expect(evaluateShadowGate(groupAck, rules)).toEqual({ verdict: 'SUPPRESS', ruleId: 'X02_STATUS_ONLY' });
    expect(evaluateShadowGate({ ...groupAck, text: 'fyi?' }, rules).ruleId).toBe('S08_OBLIGATION');
  });

  it('shipped noReplyKnown is empty, so X03 is unreachable in production', () => {
    expect((JSON.parse(RULES_TEXT) as { noReplyKnown: unknown[] }).noReplyKnown).toEqual([]);
  });

  it('X02 requires a whole-text match even for an unanchored statusOnly pattern', () => {
    const rules = compileShadowRules({
      rulesVersion: 1,
      flags: 'i',
      statusOnly: [{ id: 'loose', pattern: 'ok' }],
      obligation: [],
      noReplyKnown: [],
    });
    expect(evaluateShadowGate({ ...groupAck, text: 'ok' }, rules).ruleId).toBe('X02_STATUS_ONLY');
    expect(evaluateShadowGate({ ...groupAck, text: 'ok then' }, rules).ruleId).toBe('D00_DEFAULT');
  });

  it('a featureVersion other than 1 falls to S07', () => {
    const input = { ...groupAck, featureVersion: 2 } as unknown as ShadowGateInput;
    expect(shadowGate(input)).toEqual({ verdict: 'SPAWN', ruleId: 'S07_UNKNOWN' });
    expect(FEATURE_VERSION).toBe(1);
  });

  it('a pattern that fails to compile throws at compile time', () => {
    expect(() =>
      compileShadowRules({ rulesVersion: 1, flags: 'i', statusOnly: [{ id: 'bad', pattern: '(' }], obligation: [], noReplyKnown: [] }),
    ).toThrow();
  });

  it('a lookahead (unsupported by RE2) is rejected at compile time', () => {
    expect(() =>
      compileShadowRules({ rulesVersion: 1, flags: 'i', statusOnly: [{ id: 'la', pattern: '^ok(?=!)' }], obligation: [], noReplyKnown: [] }),
    ).toThrow();
  });

  it('rejects a rules document with missing or extra keys', () => {
    expect(() => compileShadowRules({ rulesVersion: 1, flags: 'i', statusOnly: [], obligation: [] })).toThrow(/keys must be exactly/);
    expect(() =>
      compileShadowRules({ rulesVersion: 1, flags: 'i', statusOnly: [], obligation: [], noReplyKnown: [], extra: [] }),
    ).toThrow(/keys must be exactly/);
  });
});

describe('RULES_SHA256', () => {
  it('equals sha256 of the rules JSON file bytes', () => {
    const expected = createHash('sha256').update(readFileSync(SHADOW_GATE_RULES_PATH)).digest('hex');
    expect(RULES_SHA256).toBe(expected);
    expect(RULES_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('normalizeShadowText', () => {
  it('maps null and undefined to null text', () => {
    expect(normalizeShadowText(null)).toEqual({ text: null, truncated: false, replaced: false });
    expect(normalizeShadowText(undefined)).toEqual({ text: null, truncated: false, replaced: false });
  });

  it('replaces a lone surrogate and sets replaced', () => {
    const r = normalizeShadowText('ok\uD800');
    expect(r).toEqual({ text: 'ok�', truncated: false, replaced: true });
  });

  it('leaves well-formed text unreplaced', () => {
    expect(normalizeShadowText('ok 👍').replaced).toBe(false);
  });

  it('does not truncate exactly MAX_SHADOW_TEXT_UTF16 units', () => {
    expect(MAX_SHADOW_TEXT_UTF16).toBe(4096);
    const r = normalizeShadowText('a'.repeat(4096));
    expect(r.truncated).toBe(false);
    expect(r.text).toHaveLength(4096);
  });

  it('truncates 4097 units to 4096', () => {
    const r = normalizeShadowText('a'.repeat(4097));
    expect(r.truncated).toBe(true);
    expect(r.text).toHaveLength(4096);
  });

  it('drops the high surrogate when the cut lands inside a surrogate pair', () => {
    // 4095 ASCII units then a 2-unit emoji: units 4095 (high) and 4096 (low).
    const r = normalizeShadowText('a'.repeat(4095) + '😀');
    expect(r.truncated).toBe(true);
    expect(r.text).toHaveLength(4095);
    expect(r.text!.isWellFormed()).toBe(true);
    expect(r.text).toBe('a'.repeat(4095));
  });

  it('keeps a whole surrogate pair that ends exactly at the cap', () => {
    const r = normalizeShadowText('a'.repeat(4094) + '😀' + 'b');
    expect(r.truncated).toBe(true);
    expect(r.text).toBe('a'.repeat(4094) + '😀');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeShadowText('  okay   \n').text).toBe('okay');
  });

  it('trims after truncation', () => {
    const r = normalizeShadowText('ok' + ' '.repeat(5000));
    expect(r).toEqual({ text: 'ok', truncated: true, replaced: false });
  });

  it('NFC-composes decomposed text', () => {
    const r = normalizeShadowText('café');
    expect(r.text).toBe('café');
    expect(r.replaced).toBe(false);
  });

  it('does not lowercase', () => {
    expect(normalizeShadowText('OK').text).toBe('OK');
  });
});

describe('ReDoS sanity', () => {
  const adversarial = ['ok'.repeat(2048), 'a'.repeat(4096), `${'ok '.repeat(1365)}!`, '👍'.repeat(2048)];

  it('every compiled pattern returns on 4096-unit adversarial input', () => {
    expect(COMPILED_SHADOW_PATTERNS.length).toBeGreaterThan(0);
    for (const re of COMPILED_SHADOW_PATTERNS) {
      for (const s of adversarial) {
        expect(typeof re.test(s)).toBe('boolean');
      }
    }
  });
});

describe('rules JSON private-literal guard', () => {
  it('contains no digit run of length >= 7 and no @', () => {
    expect(RULES_TEXT).not.toMatch(/\d{7,}/);
    expect(RULES_TEXT).not.toContain('@');
  });
});
