// src/core/substrate/inline-extractor.ts
export type ImperativeVerb =
  | 'remind' | 'schedule' | 'watch' | 'follow-up' | 'task' | 'track' | 'bead';

export interface ImperativeMatch {
  verb: ImperativeVerb;
  offset: number;
  matchedText: string;
}

const PATTERNS: Array<{ verb: ImperativeVerb; re: RegExp }> = [
  { verb: 'remind',    re: /\bremind\s+me\b/i },
  { verb: 'schedule',  re: /\bschedule\b/i },
  { verb: 'watch',     re: /\bwatch\s+for\b/i },
  { verb: 'follow-up', re: /\bfollow\s+up\b/i },
  { verb: 'task',      re: /\bmake\s+a\s+task\b/i },
  { verb: 'track',     re: /\btrack\s+this\b/i },
  { verb: 'bead',      re: /\badd\s+a\s+bead\b/i },
];

export function matchImperative(text: string): ImperativeMatch | null {
  for (const { verb, re } of PATTERNS) {
    const m = re.exec(text);
    if (m) return { verb, offset: m.index, matchedText: m[0] };
  }
  return null;
}

export function extractImperativeTarget(text: string): string {
  const m = matchImperative(text);
  if (!m) return text.trim();
  const after = text.slice(m.offset + m.matchedText.length).trim();
  return after.replace(/^(to|for|that|about|:)\s+/i, '').trim();
}
