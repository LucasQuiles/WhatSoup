import { describe, expect, it } from 'vitest';

import { errorMessage } from '../../src/lib/error-message.ts';

describe('errorMessage', () => {
  it('returns the message property of an Error instance', () => {
    const err = new Error('Test error message');
    expect(errorMessage(err)).toBe('Test error message');
  });

  it('returns the message property of a TypeError', () => {
    const err = new TypeError('Type error occurred');
    expect(errorMessage(err)).toBe('Type error occurred');
  });

  it('returns the message property of a custom Error subclass', () => {
    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CustomError';
      }
    }
    const err = new CustomError('Custom message');
    expect(errorMessage(err)).toBe('Custom message');
  });

  it('converts a string to itself', () => {
    expect(errorMessage('raw string error')).toBe('raw string error');
  });

  it('converts a number to its string representation', () => {
    expect(errorMessage(42)).toBe('42');
  });

  it('converts a boolean to its string representation', () => {
    expect(errorMessage(true)).toBe('true');
    expect(errorMessage(false)).toBe('false');
  });

  it('converts null to the string "null"', () => {
    expect(errorMessage(null)).toBe('null');
  });

  it('converts undefined to the string "undefined"', () => {
    expect(errorMessage(undefined)).toBe('undefined');
  });

  it('converts an object to its string representation', () => {
    const obj = { key: 'value' };
    expect(errorMessage(obj)).toBe(String(obj));
  });

  it('handles an Error with an empty message', () => {
    const err = new Error('');
    expect(errorMessage(err)).toBe('');
  });

  it('handles a symbol by converting it to its string representation', () => {
    const sym = Symbol('test');
    expect(errorMessage(sym)).toContain('Symbol');
  });
});
