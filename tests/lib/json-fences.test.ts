import { describe, it, expect } from 'vitest';
import { stripJsonFences } from '../../src/lib/json-fences.ts';

describe('stripJsonFences', () => {
  it('extracts a bare ``` fenced block', () => {
    const raw = '```\n{"a":1}\n```';
    expect(stripJsonFences(raw)).toBe('{"a":1}');
  });

  it('extracts a ```json language-tagged fenced block', () => {
    const raw = '```json\n{"a":1}\n```';
    expect(stripJsonFences(raw)).toBe('{"a":1}');
  });

  it('handles a fence with no leading newline after the tag', () => {
    const raw = '```json {"a":1}```';
    expect(stripJsonFences(raw)).toBe('{"a":1}');
  });

  it('returns the original string verbatim when no fence is present', () => {
    const raw = '{"a":1}';
    expect(stripJsonFences(raw)).toBe('{"a":1}');
  });

  it('preserves surrounding non-JSON text verbatim when no fence is present', () => {
    const raw = 'no fences here, just text';
    expect(stripJsonFences(raw)).toBe('no fences here, just text');
  });

  it('trims whitespace inside the fenced block', () => {
    const raw = '```json\n   {"a":1}   \n```';
    expect(stripJsonFences(raw)).toBe('{"a":1}');
  });

  it('extracts only the first of multiple fenced blocks', () => {
    const raw = '```json\n{"a":1}\n```\nfiller\n```json\n{"b":2}\n```';
    expect(stripJsonFences(raw)).toBe('{"a":1}');
  });
});
