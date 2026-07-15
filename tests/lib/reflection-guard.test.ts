import { describe, expect, it } from 'vitest';

import {
  detectReflection,
  findFencedCodeRegions,
  findInlineCodeRegions,
  isInsideCode,
  maskCodeRegions,
  REFLECTION_PATTERNS,
  sanitizeOutbound,
} from '../../src/lib/reflection-guard.ts';

// ── findFencedCodeRegions ──────────────────────────────────────────────────

describe('findFencedCodeRegions', () => {
  it('returns [] for text without fences', () => {
    expect(findFencedCodeRegions('plain text\nno fences')).toEqual([]);
  });

  it('finds a single fenced block', () => {
    const text = 'before\n```\ncode\n```\nafter';
    const regions = findFencedCodeRegions(text);
    expect(regions.length).toBe(1);
    // Region should start at the ``` line and end after the closing ```
    expect(text.slice(regions[0]!.start, regions[0]!.end)).toContain('```');
    expect(text.slice(regions[0]!.start, regions[0]!.end)).toContain('code');
  });

  it('finds tilde fences', () => {
    const text = '~~~\ncode\n~~~';
    const regions = findFencedCodeRegions(text);
    expect(regions.length).toBe(1);
  });

  it('handles multiple separate fences', () => {
    const text = '```\na\n```\n\ntext\n\n```\nb\n```';
    const regions = findFencedCodeRegions(text);
    expect(regions.length).toBe(2);
  });

  it('extends unclosed fence to end of text', () => {
    const text = '```\ncode without close';
    const regions = findFencedCodeRegions(text);
    expect(regions.length).toBe(1);
    expect(regions[0]!.end).toBe(text.length);
  });

  it('does not match inline backticks as fences', () => {
    const text = 'this is `inline code` not a fence';
    const regions = findFencedCodeRegions(text);
    expect(regions).toEqual([]);
  });
});

// ── findInlineCodeRegions ──────────────────────────────────────────────────

describe('findInlineCodeRegions', () => {
  it('finds a single inline code span', () => {
    const text = 'hello `world` foo';
    const regions = findInlineCodeRegions(text, []);
    expect(regions.length).toBe(1);
    expect(text.slice(regions[0]!.start, regions[0]!.end)).toBe('`world`');
  });

  it('finds multiple inline spans', () => {
    const text = '`a` and `b`';
    const regions = findInlineCodeRegions(text, []);
    expect(regions.length).toBe(2);
  });

  it('does not find inline code inside fenced regions', () => {
    const text = '```\n`inside fence`\n```\n`outside`';
    const fenced = findFencedCodeRegions(text);
    const inline = findInlineCodeRegions(text, fenced);
    // Should only find the one outside the fence
    expect(inline.length).toBe(1);
    expect(text.slice(inline[0]!.start, inline[0]!.end)).toBe('`outside`');
  });

  it('handles unclosed backtick gracefully', () => {
    const text = 'hello `world without close';
    const regions = findInlineCodeRegions(text, []);
    expect(regions).toEqual([]);
  });
});

// ── isInsideCode ───────────────────────────────────────────────────────────

describe('isInsideCode', () => {
  it('returns true inside a region', () => {
    expect(isInsideCode(5, [{ start: 0, end: 10 }])).toBe(true);
  });
  it('returns false outside all regions', () => {
    expect(isInsideCode(15, [{ start: 0, end: 10 }])).toBe(false);
  });
  it('returns false at exact end (exclusive)', () => {
    expect(isInsideCode(10, [{ start: 0, end: 10 }])).toBe(false);
  });
  it('returns true at exact start (inclusive)', () => {
    expect(isInsideCode(0, [{ start: 0, end: 10 }])).toBe(true);
  });
});

// ── maskCodeRegions ────────────────────────────────────────────────────────

describe('maskCodeRegions', () => {
  it('replaces code content with spaces, preserving length', () => {
    const text = 'ab`CD`ef';
    const regions = findInlineCodeRegions(text, []);
    const masked = maskCodeRegions(text, regions);
    expect(masked.length).toBe(text.length);
    // Code content replaced
    expect(masked).not.toContain('CD');
    // Non-code preserved
    expect(masked).toContain('ab');
    expect(masked).toContain('ef');
  });

  it('handles empty regions', () => {
    expect(maskCodeRegions('hello', [])).toBe('hello');
  });
});

// ── detectReflection ───────────────────────────────────────────────────────

describe('detectReflection', () => {
  it('returns clean for plain user text', () => {
    const result = detectReflection('Hello, how are you?');
    expect(result.isReflection).toBe(false);
    expect(result.matches).toEqual([]);
  });

  it('returns clean for empty text', () => {
    expect(detectReflection('').isReflection).toBe(false);
  });

  it('detects internal separator (#+#)', () => {
    const result = detectReflection('Some text\n#+#\nMore text');
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain('internal-separator');
  });

  it('detects thinking tags', () => {
    const result = detectReflection('<thinking>let me reason about this</thinking>');
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain('thinking-tag');
  });

  it('detects namespaced thinking tags (antml:)', () => {
    const result = detectReflection('<antml:thinking>reasoning</antml:thinking>');
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain('thinking-tag');
  });

  it('detects namespaced thinking tags (mm:)', () => {
    const result = detectReflection('<mm:thought>inner</mm:thought>');
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain('thinking-tag');
  });

  it('detects role marker (assistant to=)', () => {
    const result = detectReflection('assistant to=user1\nHere is my reply.');
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain('role-marker');
  });

  it('detects memory tag', () => {
    const result = detectReflection('<relevant_memories>some context</relevant_memories>');
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain('memory-tag');
  });

  it('detects final tag', () => {
    const result = detectReflection('<final>The answer is 42.</final>');
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain('final-tag');
  });

  it('detects ACP error', () => {
    const result = detectReflection('ACP error (ACP_TIMEOUT)');
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain('acp-error');
  });

  it('detects missing API key error', () => {
    const result = detectReflection('Missing API key for openai on the gateway');
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain('missing-api-key');
  });

  it('detects bare turn-boundary (user:)', () => {
    const result = detectReflection('user:\nWhat is the weather?');
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain('turn-boundary');
  });

  it('detects bare turn-boundary (assistant:)', () => {
    const result = detectReflection('assistant: I will help you.');
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain('turn-boundary');
  });

  it('does NOT flag thinking tags inside fenced code blocks', () => {
    const text = '```\n<thinking>this is code</thinking>\n```';
    const result = detectReflection(text);
    expect(result.isReflection).toBe(false);
  });

  it('does NOT flag thinking tags inside inline code', () => {
    const text = 'Use the `<thinking>` tag in your code.';
    const result = detectReflection(text);
    expect(result.isReflection).toBe(false);
  });

  it('does NOT flag "assistant to=" inside fenced code', () => {
    const text = '```\nassistant to=user\n```';
    const result = detectReflection(text);
    expect(result.isReflection).toBe(false);
  });

  it('reports multiple labels when several patterns match', () => {
    const text = '<thinking>reason</thinking>\n#+#\nuser:\nhello';
    const result = detectReflection(text);
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels.length).toBeGreaterThanOrEqual(3);
  });

  it('each label appears only once even if pattern matches multiple times', () => {
    const text = '#+#\n#+#\n#+#';
    const result = detectReflection(text);
    expect(result.matches.filter((m) => m.label === 'internal-separator').length).toBe(1);
  });
});

// ── REFLECTION_PATTERNS ────────────────────────────────────────────────────

describe('REFLECTION_PATTERNS', () => {
  it('is a non-empty readonly array', () => {
    expect(REFLECTION_PATTERNS.length).toBeGreaterThan(0);
  });

  it('every pattern has a label, regex, and description', () => {
    for (const p of REFLECTION_PATTERNS) {
      expect(typeof p.label).toBe('string');
      expect(p.pattern).toBeInstanceOf(RegExp);
      expect(typeof p.description).toBe('string');
      expect(p.description.length).toBeGreaterThan(0);
    }
  });

  it('labels are unique', () => {
    const labels = REFLECTION_PATTERNS.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

// ── sanitizeOutbound ───────────────────────────────────────────────────────

describe('sanitizeOutbound', () => {
  it('returns input unchanged when no scaffolding present', () => {
    const text = 'Hello! How can I help you today?';
    expect(sanitizeOutbound(text)).toBe(text);
  });

  it('returns empty/whitespace input trimmed', () => {
    expect(sanitizeOutbound('')).toBe('');
    expect(sanitizeOutbound('   ')).toBe('');
  });

  it('removes internal separators (#+#)', () => {
    const result = sanitizeOutbound('Part one\n#+#\nPart two');
    expect(result).not.toContain('#+#');
    expect(result).toContain('Part one');
    expect(result).toContain('Part two');
  });

  it('removes thinking tags AND their content', () => {
    const result = sanitizeOutbound('<thinking>secret reasoning</thinking>The answer is 42.');
    expect(result).not.toContain('thinking');
    expect(result).not.toContain('secret reasoning');
    expect(result).toContain('The answer is 42.');
  });

  it('removes namespaced thinking tags and content', () => {
    const result = sanitizeOutbound('<antml:thinking>reasoning</antml:thinking>visible');
    expect(result).not.toContain('reasoning');
    expect(result).toContain('visible');
  });

  it('removes orphaned opening thinking tag', () => {
    const result = sanitizeOutbound('<thinking>The answer');
    expect(result).not.toContain('<thinking>');
    expect(result).toContain('The answer');
  });

  it('removes memory tags and content', () => {
    const result = sanitizeOutbound('<relevant_memories>context</relevant_memories>Reply');
    expect(result).not.toContain('relevant_memories');
    expect(result).not.toContain('context');
    expect(result).toContain('Reply');
  });

  it('removes final tags but KEEPS their content (it is the answer)', () => {
    const result = sanitizeOutbound('<final>The answer is 42.</final>');
    expect(result).not.toContain('<final>');
    expect(result).toContain('The answer is 42.');
  });

  it('removes bare turn-boundary prefixes', () => {
    const result = sanitizeOutbound('user:\nWhat is the weather?\nassistant:\nIt is sunny.');
    expect(result).not.toContain('user:');
    expect(result).not.toContain('assistant:');
    expect(result).toContain('What is the weather?');
    expect(result).toContain('It is sunny.');
  });

  it('removes ACP error lines', () => {
    const result = sanitizeOutbound('Some text\nACP error (ACP_TIMEOUT)\nMore text');
    expect(result).not.toContain('ACP error');
    expect(result).toContain('Some text');
    expect(result).toContain('More text');
  });

  it('removes missing-API-key error lines', () => {
    const result = sanitizeOutbound('Missing API key for openai on the gateway\nHello.');
    expect(result).not.toContain('Missing API key');
    expect(result).toContain('Hello.');
  });

  it('removes assistant role marker lines', () => {
    const result = sanitizeOutbound('assistant to=user1\nThe reply.');
    expect(result).not.toContain('assistant to=');
    expect(result).toContain('The reply.');
  });

  it('collapses 3+ consecutive newlines to 2', () => {
    const result = sanitizeOutbound('Paragraph one.\n\n\n\n\nParagraph two.');
    expect(result).not.toMatch(/\n{3,}/);
    expect(result).toContain('Paragraph one.\n\nParagraph two.');
  });

  it('preserves intentional double newlines', () => {
    const text = 'Paragraph one.\n\nParagraph two.';
    expect(sanitizeOutbound(text)).toBe(text);
  });

  it('can disable newline collapsing', () => {
    const text = 'a\n\n\n\nb';
    const result = sanitizeOutbound(text, { collapseNewlines: false });
    expect(result).toMatch(/\n{3,}/);
  });

  it('trims leading and trailing whitespace', () => {
    const result = sanitizeOutbound('\n\n  Hello.  \n\n');
    expect(result).toBe('Hello.');
  });

  it('handles complex multi-scaffolding message', () => {
    const text = [
      '<thinking>Let me think...</thinking>',
      'user: what is 2+2?',
      '#+#',
      'assistant to=user',
      '<final>4</final>',
    ].join('\n');
    const result = sanitizeOutbound(text);
    expect(result).not.toContain('thinking');
    expect(result).not.toContain('user:');
    expect(result).not.toContain('#+#');
    expect(result).not.toContain('assistant to=');
    expect(result).not.toContain('<final>');
    expect(result).toContain('4');
    expect(result).toContain('what is 2+2?');
  });
});
