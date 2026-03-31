import { describe, it, expect } from 'vitest';
import { validateBase64Image } from '../../src/core/base64.ts';

describe('validateBase64Image', () => {
  it('accepts valid base64 and returns it unchanged', () => {
    // 3 bytes → "AAEC" — clean base64
    const valid = Buffer.from([0, 1, 2]).toString('base64');
    expect(validateBase64Image(valid)).toBe(valid);
  });

  it('accepts padded base64 with = padding', () => {
    const valid = Buffer.from('hello').toString('base64'); // aGVsbG8=
    expect(validateBase64Image(valid)).toBe(valid);
  });

  it('accepts padded base64 with == padding', () => {
    const valid = Buffer.from('hi').toString('base64'); // aGk=
    expect(validateBase64Image(valid)).toBe(valid);
  });

  it('throws on base64 with invalid characters', () => {
    expect(() => validateBase64Image('not!valid@base64#string')).toThrow(
      'Invalid base64 content: contains non-base64 characters',
    );
  });

  it('throws on empty string', () => {
    expect(() => validateBase64Image('')).toThrow('Invalid base64 content');
  });

  it('strips data URI prefix and returns clean base64', () => {
    const raw = Buffer.from([0, 1, 2, 3]).toString('base64');
    const dataUri = `data:image/png;base64,${raw}`;
    expect(validateBase64Image(dataUri)).toBe(raw);
  });

  it('strips data URI prefix for jpeg', () => {
    const raw = Buffer.from('fakeimage').toString('base64');
    const dataUri = `data:image/jpeg;base64,${raw}`;
    expect(validateBase64Image(dataUri)).toBe(raw);
  });

  it('returns a non-empty buffer-decodable string', () => {
    const valid = Buffer.from([1, 2, 3, 4, 5]).toString('base64');
    const result = validateBase64Image(valid);
    const buf = Buffer.from(result, 'base64');
    expect(buf.length).toBeGreaterThan(0);
  });
});
