import { describe, expect, it } from 'vitest';
import { shortHash } from '../../src/lib/short-hash.ts';

describe('shortHash', () => {
  it('known vector: shortHash("hello") === first 12 hex chars of sha256("hello")', () => {
    // sha256('hello') = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(shortHash('hello')).toBe('2cf24dba5fb0');
  });

  it('length param honored at 16', () => {
    expect(shortHash('hello', 16)).toBe('2cf24dba5fb0a30e');
  });

  it('length param honored at 20', () => {
    expect(shortHash('hello', 20)).toBe('2cf24dba5fb0a30e26e8');
  });
});
