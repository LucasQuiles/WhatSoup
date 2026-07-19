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

  it('handles empty fenced block', () => {
    const raw = '```json\n```';
    expect(stripJsonFences(raw)).toBe('');
  });

  it('handles deeply nested JSON structures', () => {
    const raw = '```json\n{"a":{"b":{"c":1}}}\n```';
    expect(stripJsonFences(raw)).toBe('{"a":{"b":{"c":1}}}');
  });

  it('handles JSON arrays in fenced blocks', () => {
    const raw = '```json\n[1,2,3]\n```';
    expect(stripJsonFences(raw)).toBe('[1,2,3]');
  });

  it('preserves JSON content without fence when fence is incomplete', () => {
    const raw = 'text\n```json\n{"incomplete":1}';
    expect(stripJsonFences(raw)).toBe('text\n```json\n{"incomplete":1}');
  });

  it('handles text before and after fences', () => {
    const raw = 'Here is JSON:\n```json\n{"data":"value"}\n```\nEnd';
    expect(stripJsonFences(raw)).toBe('{"data":"value"}');
  });

  it('handles multiple newlines before and after content', () => {
    const raw = '```json\n\n\n{"a":1}\n\n\n```';
    expect(stripJsonFences(raw)).toBe('{"a":1}');
  });

  it('handles fence with only whitespace inside', () => {
    const raw = '```json\n   \n```';
    expect(stripJsonFences(raw)).toBe('');
  });

  it('handles special characters in JSON values', () => {
    const raw = '```json\n{"url":"https://example.com/path"}\n```';
    expect(stripJsonFences(raw)).toBe('{"url":"https://example.com/path"}');
  });
});
