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

  it('produces consistent results for the same input', () => {
    const input = 'test-value';
    const hash1 = shortHash(input);
    const hash2 = shortHash(input);
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different inputs', () => {
    const hash1 = shortHash('input1');
    const hash2 = shortHash('input2');
    expect(hash1).not.toBe(hash2);
  });

  it('returns exactly the requested length', () => {
    expect(shortHash('test', 8).length).toBe(8);
    expect(shortHash('test', 16).length).toBe(16);
    expect(shortHash('test', 32).length).toBe(32);
  });

  it('returns hex characters only', () => {
    const hash = shortHash('any-input', 24);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it('handles empty string input', () => {
    const hash = shortHash('', 12);
    expect(hash).toHaveLength(12);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it('handles very long string input', () => {
    const longInput = 'x'.repeat(10000);
    const hash = shortHash(longInput, 12);
    expect(hash).toHaveLength(12);
  });

  it('handles special characters in input', () => {
    const input = '!@#$%^&*()_+-=[]{}|;:,.<>?';
    const hash = shortHash(input, 12);
    expect(hash).toHaveLength(12);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it('handles unicode input', () => {
    const input = '日本語テスト🔐';
    const hash = shortHash(input, 12);
    expect(hash).toHaveLength(12);
  });

  it('sha256 full hash is 64 characters', () => {
    const hash = shortHash('test', 64);
    expect(hash.length).toBe(64);
  });

  it('length defaults to 12 when not specified', () => {
    const hashDefault = shortHash('test');
    const hashExplicit = shortHash('test', 12);
    expect(hashDefault).toBe(hashExplicit);
  });

  it('handles length of 1', () => {
    const hash = shortHash('test', 1);
    expect(hash).toHaveLength(1);
    expect(/^[0-9a-f]$/.test(hash)).toBe(true);
  });
});
