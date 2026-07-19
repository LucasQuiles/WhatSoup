import { describe, expect, it } from 'vitest';

import { escapeRegExp } from '../../src/lib/regex-utils.ts';

describe('escapeRegExp', () => {
  it('escapes all regex metacharacters', () => {
    // Test: . * + ? ^ $ { } ( ) | [ ] \
    const input = '.*+?^${}()|[]\\';
    const escaped = escapeRegExp(input);
    expect(escaped).toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
  });

  it('escapes dot metacharacter', () => {
    expect(escapeRegExp('example.com')).toBe('example\\.com');
  });

  it('escapes asterisk metacharacter', () => {
    expect(escapeRegExp('glob*pattern')).toBe('glob\\*pattern');
  });

  it('escapes plus metacharacter', () => {
    expect(escapeRegExp('a+b')).toBe('a\\+b');
  });

  it('escapes question mark metacharacter', () => {
    expect(escapeRegExp('a?b')).toBe('a\\?b');
  });

  it('escapes caret metacharacter', () => {
    expect(escapeRegExp('^start')).toBe('\\^start');
  });

  it('escapes dollar sign metacharacter', () => {
    expect(escapeRegExp('end$')).toBe('end\\$');
  });

  it('escapes curly braces metacharacters', () => {
    expect(escapeRegExp('{3,5}')).toBe('\\{3,5\\}');
  });

  it('escapes parentheses metacharacters', () => {
    expect(escapeRegExp('(group)')).toBe('\\(group\\)');
  });

  it('escapes pipe metacharacter', () => {
    expect(escapeRegExp('a|b')).toBe('a\\|b');
  });

  it('escapes square brackets metacharacters', () => {
    expect(escapeRegExp('[a-z]')).toBe('\\[a-z\\]');
  });

  it('escapes backslash metacharacter', () => {
    expect(escapeRegExp('path\\to\\file')).toBe('path\\\\to\\\\file');
  });

  it('returns input unchanged when no metacharacters are present', () => {
    expect(escapeRegExp('plain text')).toBe('plain text');
  });

  it('handles empty string', () => {
    expect(escapeRegExp('')).toBe('');
  });

  it('escapes URL patterns correctly', () => {
    const url = 'https://example.com/path?query=value&other=123';
    const escaped = escapeRegExp(url);
    expect(() => new RegExp(escaped)).not.toThrow();
    expect(new RegExp(escaped).test(url)).toBe(true);
  });

  it('can be used to create a safe regex pattern for string matching', () => {
    const searchTerm = 'a.b*c?';
    const escaped = escapeRegExp(searchTerm);
    const pattern = new RegExp(escaped);
    expect(pattern.test('a.b*c?')).toBe(true);
    expect(pattern.test('axbzc')).toBe(false);
  });
});
