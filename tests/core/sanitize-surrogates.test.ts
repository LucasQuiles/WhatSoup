import { describe, it, expect } from 'vitest';
import {
  stripLoneSurrogates,
  hasLoneSurrogates,
  sanitizeForJson,
  isSurrogateError,
  sanitizeMessageHistory,
} from '../../src/core/sanitize-surrogates.ts';

describe('stripLoneSurrogates', () => {
  it('returns the original string when no surrogates present', () => {
    const str = 'Hello, world! 🌍 emoji test';
    const result = stripLoneSurrogates(str);
    expect(result).toBe(str);
    // Should return same reference (fast path)
    expect(result).toBe(str);
  });

  it('preserves valid surrogate pairs (emoji)', () => {
    const str = '🎉 party 🎊';
    expect(stripLoneSurrogates(str)).toBe(str);
  });

  it('replaces lone high surrogate with U+FFFD', () => {
    const str = 'before\uD800after';
    expect(stripLoneSurrogates(str)).toBe('before\uFFFDafter');
  });

  it('replaces lone low surrogate with U+FFFD', () => {
    const str = 'before\uDC00after';
    expect(stripLoneSurrogates(str)).toBe('before\uFFFDafter');
  });

  it('replaces multiple lone surrogates', () => {
    const str = '\uD800hello\uDC00world\uDBFF';
    expect(stripLoneSurrogates(str)).toBe('\uFFFDhello\uFFFDworld\uFFFD');
  });

  it('handles high surrogate at end of string', () => {
    const str = 'trailing\uD800';
    expect(stripLoneSurrogates(str)).toBe('trailing\uFFFD');
  });

  it('handles low surrogate at start of string', () => {
    const str = '\uDC00leading';
    expect(stripLoneSurrogates(str)).toBe('\uFFFDleading');
  });

  it('preserves valid pair but replaces adjacent lone surrogates', () => {
    // Valid pair (U+1F600 = 😀) + lone high
    const validPair = '\uD83D\uDE00';
    const str = `${validPair}\uD800`;
    const result = stripLoneSurrogates(str);
    expect(result).toBe(`${validPair}\uFFFD`);
  });

  it('handles empty string', () => {
    expect(stripLoneSurrogates('')).toBe('');
  });

  it('handles string with only a lone surrogate', () => {
    expect(stripLoneSurrogates('\uD800')).toBe('\uFFFD');
  });
});

describe('hasLoneSurrogates', () => {
  it('returns false for clean strings', () => {
    expect(hasLoneSurrogates('hello')).toBe(false);
    expect(hasLoneSurrogates('🎉 emoji')).toBe(false);
    expect(hasLoneSurrogates('')).toBe(false);
  });

  it('returns true for lone high surrogate', () => {
    expect(hasLoneSurrogates('test\uD800')).toBe(true);
  });

  it('returns true for lone low surrogate', () => {
    expect(hasLoneSurrogates('test\uDC00')).toBe(true);
  });

  it('returns false for valid surrogate pair', () => {
    expect(hasLoneSurrogates('\uD83D\uDE00')).toBe(false);
  });
});

describe('sanitizeForJson', () => {
  it('sanitizes string values', () => {
    expect(sanitizeForJson('hello\uD800world')).toBe('hello\uFFFDworld');
  });

  it('sanitizes nested objects', () => {
    const input = { text: 'ok\uD800', nested: { value: '\uDC00bad' } };
    const result = sanitizeForJson(input);
    expect(result).toEqual({ text: 'ok\uFFFD', nested: { value: '\uFFFDbad' } });
  });

  it('sanitizes arrays', () => {
    const input = ['clean', 'has\uD800surrogate'];
    const result = sanitizeForJson(input);
    expect(result).toEqual(['clean', 'has\uFFFDsurrogate']);
  });

  it('preserves non-string values', () => {
    expect(sanitizeForJson(42)).toBe(42);
    expect(sanitizeForJson(null)).toBe(null);
    expect(sanitizeForJson(true)).toBe(true);
  });

  it('produces valid JSON after sanitization', () => {
    const input = { content: 'text\uD800\uD801mixed\uDC00' };
    const sanitized = sanitizeForJson(input);
    // Should not throw
    const json = JSON.stringify(sanitized);
    expect(json).toBeDefined();
    // The sanitized string should parse back correctly
    const parsed = JSON.parse(json);
    expect(parsed.content).toBe('text\uFFFD\uFFFDmixed\uFFFD');
  });
});

describe('isSurrogateError', () => {
  it('detects Anthropic surrogate error', () => {
    expect(isSurrogateError(
      '{"type":"error","error":{"type":"invalid_request_error","message":"The request body is not valid JSON: no low surrogate in string: line 1 column 835913"}}'
    )).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isSurrogateError('rate limit exceeded')).toBe(false);
    expect(isSurrogateError('internal server error')).toBe(false);
    // Should not false-positive on hex substrings in unrelated contexts
    expect(isSurrogateError('column 83491 error')).toBe(false);
    expect(isSurrogateError('color #ffd800 is invalid')).toBe(false);
  });

  it('detects surrogate hex patterns in error text', () => {
    expect(isSurrogateError('invalid character \\uD800 at position 5')).toBe(true);
  });
});

describe('sanitizeMessageHistory', () => {
  it('sanitizes string content in messages', () => {
    const messages = [
      { role: 'user', content: 'hello\uD800world' },
      { role: 'assistant', content: 'clean' },
    ];
    const repaired = sanitizeMessageHistory(messages);
    expect(repaired).toBe(1);
    expect(messages[0].content).toBe('hello\uFFFDworld');
    expect(messages[1].content).toBe('clean');
  });

  it('sanitizes content block arrays (Anthropic format)', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'output\uD800bad' },
          { type: 'text', text: 'ok\uDC00text' },
        ],
      },
    ];
    const repaired = sanitizeMessageHistory(messages as any);
    expect(repaired).toBe(2);
    expect((messages[0].content as any[])[0].content).toBe('output\uFFFDbad');
    expect((messages[0].content as any[])[1].text).toBe('ok\uFFFDtext');
  });

  it('sanitizes OpenAI tool_calls function arguments', () => {
    const messages = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{"path": "file\uD800.txt"}' } },
          { id: 'tc2', type: 'function', function: { name: 'clean_tool', arguments: '{"ok": true}' } },
        ],
      },
    ];
    const repaired = sanitizeMessageHistory(messages as any);
    expect(repaired).toBe(1);
    expect((messages[0] as any).tool_calls[0].function.arguments).toBe('{"path": "file\uFFFD.txt"}');
    expect((messages[0] as any).tool_calls[1].function.arguments).toBe('{"ok": true}');
  });

  it('does not spuriously increment repaired for clean tool_use input blocks', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'clean output' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'read_file', input: { path: '/clean/path' } },
        ],
      },
    ];
    const repaired = sanitizeMessageHistory(messages as any);
    expect(repaired).toBe(0);
  });

  it('returns 0 when no repair needed', () => {
    const messages = [
      { role: 'user', content: 'clean text' },
      { role: 'assistant', content: '🎉 also clean' },
    ];
    expect(sanitizeMessageHistory(messages)).toBe(0);
  });
});
