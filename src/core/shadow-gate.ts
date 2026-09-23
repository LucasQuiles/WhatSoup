// src/core/shadow-gate.ts
// Logged-only shadow gate: predicts whether an admitted inbound message needs
// a reply (SPAWN) or is a suppression candidate (SUPPRESS). It never changes
// behaviour. shadowGate() is pure; the rules JSON is read and compiled once at
// module load.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import RE2 from 're2';
import type { ShadowGateInput } from './shadow-gate-features.ts';

export const SHADOW_GATE_VERSION = 1;

export type ShadowVerdict = 'SPAWN' | 'SUPPRESS';
export type ShadowRuleId =
  | 'S01_OWNER'
  | 'S02_DM'
  | 'S03_CONTROL'
  | 'S04_MENTION'
  | 'S05_QUOTED'
  | 'S06_NONTEXT'
  | 'S07_UNKNOWN'
  | 'S08_OBLIGATION'
  | 'X02_STATUS_ONLY'
  | 'X03_NO_REPLY_PATTERN'
  | 'D00_DEFAULT';

export const SHADOW_GATE_RULES_PATH = fileURLToPath(new URL('./shadow-gate-rules.json', import.meta.url));

interface RuleEntry {
  id: string;
  pattern: string;
}

interface RulesFile {
  rulesVersion: number;
  flags: string;
  statusOnly: RuleEntry[];
  obligation: RuleEntry[];
  noReplyKnown: RuleEntry[];
}

const RULES_KEYS = ['rulesVersion', 'flags', 'statusOnly', 'obligation', 'noReplyKnown'] as const;

function parseRules(raw: unknown): RulesFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('shadow-gate rules: top level must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (keys.join(',') !== [...RULES_KEYS].sort().join(',')) {
    throw new Error(`shadow-gate rules: keys must be exactly ${RULES_KEYS.join(', ')}; got ${keys.join(', ')}`);
  }
  if (typeof obj.rulesVersion !== 'number') throw new Error('shadow-gate rules: rulesVersion must be a number');
  if (typeof obj.flags !== 'string') throw new Error('shadow-gate rules: flags must be a string');
  const list = (name: 'statusOnly' | 'obligation' | 'noReplyKnown'): RuleEntry[] => {
    const value = obj[name];
    if (!Array.isArray(value)) throw new Error(`shadow-gate rules: ${name} must be an array`);
    return value.map((entry, i) => {
      const e = entry as Partial<RuleEntry> | null;
      if (typeof e?.id !== 'string' || typeof e.pattern !== 'string') {
        throw new Error(`shadow-gate rules: ${name}[${i}] must have string id and pattern`);
      }
      return { id: e.id, pattern: e.pattern };
    });
  };
  return {
    rulesVersion: obj.rulesVersion,
    flags: obj.flags,
    statusOnly: list('statusOnly'),
    obligation: list('obligation'),
    noReplyKnown: list('noReplyKnown'),
  };
}

export interface CompiledShadowRules {
  statusOnly: readonly RegExp[];
  obligation: readonly RegExp[];
  noReplyKnown: readonly RegExp[];
}

/**
 * Validate a rules document and compile its patterns with RE2 (linear-time,
 * because patterns run against member-supplied content). A pattern that fails
 * to compile throws: the shipped rules file is a checked-in constant, not
 * operator input, so there is no skip-and-warn path.
 */
export function compileShadowRules(raw: unknown): CompiledShadowRules & { rulesVersion: number } {
  const rules = parseRules(raw);
  const compile = (entries: RuleEntry[]): RegExp[] => entries.map((e) => new RE2(e.pattern, rules.flags));
  return {
    rulesVersion: rules.rulesVersion,
    statusOnly: compile(rules.statusOnly),
    obligation: compile(rules.obligation),
    noReplyKnown: compile(rules.noReplyKnown),
  };
}

const rulesBytes = readFileSync(SHADOW_GATE_RULES_PATH);

/** sha256 hex of the rules JSON file bytes, computed at load. */
export const RULES_SHA256: string = createHash('sha256').update(rulesBytes).digest('hex');

const loadedRules = compileShadowRules(JSON.parse(rulesBytes.toString('utf8')));

export const RULES_VERSION: number = loadedRules.rulesVersion;

/** Every compiled pattern of the shipped rules, for tests. */
export const COMPILED_SHADOW_PATTERNS: readonly RegExp[] = [
  ...loadedRules.statusOnly,
  ...loadedRules.obligation,
  ...loadedRules.noReplyKnown,
];

function matchesWhole(re: RegExp, text: string): boolean {
  const m = re.exec(text);
  return m !== null && m.index === 0 && m[0].length === text.length;
}

/** Ordered rules, first match wins. Pure given `rules`. */
export function evaluateShadowGate(
  input: ShadowGateInput,
  rules: CompiledShadowRules,
): { verdict: ShadowVerdict; ruleId: ShadowRuleId } {
  if (input.isOwner === true) return { verdict: 'SPAWN', ruleId: 'S01_OWNER' };
  if (input.chatKind === 'dm') return { verdict: 'SPAWN', ruleId: 'S02_DM' };
  if (input.isControlChat === true) return { verdict: 'SPAWN', ruleId: 'S03_CONTROL' };
  if (input.mentionedSelf === true) return { verdict: 'SPAWN', ruleId: 'S04_MENTION' };
  if (input.quoted === true || input.quoted === 'unknown') return { verdict: 'SPAWN', ruleId: 'S05_QUOTED' };
  if (input.contentType !== 'text' || input.text === null) return { verdict: 'SPAWN', ruleId: 'S06_NONTEXT' };

  const text = input.text;
  if (
    input.isOwner === 'unknown' ||
    input.mentionedSelf === 'unknown' ||
    input.isControlChat === 'unknown' ||
    input.pendingObligation === 'unknown' ||
    input.contextStatus === 'unknown' ||
    text === '' ||
    input.truncated === true ||
    input.featureVersion !== 1
  ) {
    return { verdict: 'SPAWN', ruleId: 'S07_UNKNOWN' };
  }

  if (
    input.pendingObligation === true ||
    text.includes('?') ||
    text.includes('？') ||
    rules.obligation.some((re) => re.test(text))
  ) {
    return { verdict: 'SPAWN', ruleId: 'S08_OBLIGATION' };
  }

  if (rules.statusOnly.some((re) => matchesWhole(re, text))) return { verdict: 'SUPPRESS', ruleId: 'X02_STATUS_ONLY' };
  if (rules.noReplyKnown.some((re) => re.test(text))) return { verdict: 'SUPPRESS', ruleId: 'X03_NO_REPLY_PATTERN' };
  return { verdict: 'SPAWN', ruleId: 'D00_DEFAULT' };
}

export function shadowGate(input: ShadowGateInput): { verdict: ShadowVerdict; ruleId: ShadowRuleId } {
  return evaluateShadowGate(input, loadedRules);
}
