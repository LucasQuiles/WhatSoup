import { describe, expect, it } from 'vitest';

import {
  formatAllowedValues,
  formatConfigIssueLine,
  formatConfigIssueLines,
  formatConfigIssueSummary,
  normalizeConfigIssuePath,
  sanitizeTerminalText,
} from '../../src/lib/config-issue-format.ts';

describe('sanitizeTerminalText', () => {
  it('strips ANSI color escapes', () => {
    expect(sanitizeTerminalText('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('strips ANSI cursor movement', () => {
    expect(sanitizeTerminalText('a\x1b[2Ab')).toBe('ab');
  });

  it('strips OSC sequences (title set)', () => {
    expect(sanitizeTerminalText('\x1b]0;title\x1b\x07ok')).toBe('ok');
  });

  it('strips non-printable control chars except tab/newline', () => {
    expect(sanitizeTerminalText('a\x00b\x07c\td\ne')).toBe('abc\td\ne');
  });

  it('passes through plain text unchanged', () => {
    expect(sanitizeTerminalText('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(sanitizeTerminalText('')).toBe('');
  });
});

describe('normalizeConfigIssuePath', () => {
  it('returns <root> for undefined', () => {
    expect(normalizeConfigIssuePath(undefined)).toBe('<root>');
  });

  it('returns <root> for null', () => {
    expect(normalizeConfigIssuePath(null)).toBe('<root>');
  });

  it('returns <root> for empty string', () => {
    expect(normalizeConfigIssuePath('')).toBe('<root>');
  });

  it('returns <root> for whitespace-only string', () => {
    expect(normalizeConfigIssuePath('   ')).toBe('<root>');
  });

  it('returns the trimmed path for non-empty', () => {
    expect(normalizeConfigIssuePath('  messages.timeout  ')).toBe('messages.timeout');
  });
});

describe('formatConfigIssueLine', () => {
  it('formats a basic issue with default marker', () => {
    const line = formatConfigIssueLine({ path: 'foo', message: 'must be number' });
    expect(line).toBe('- foo: must be number');
  });

  it('normalizes empty path to <root>', () => {
    const line = formatConfigIssueLine({ path: '', message: 'missing' });
    expect(line).toBe('- <root>: missing');
  });

  it('uses custom marker', () => {
    const line = formatConfigIssueLine({ path: 'x', message: 'y' }, { marker: '*' });
    expect(line).toBe('* x: y');
  });

  it('uses no marker when empty', () => {
    const line = formatConfigIssueLine({ path: 'x', message: 'y' }, { marker: '' });
    expect(line).toBe('x: y');
  });

  it('preserves empty path when normalizeRoot is false', () => {
    const line = formatConfigIssueLine(
      { path: '', message: 'm' },
      { normalizeRoot: false },
    );
    expect(line).toBe('- : m');
  });

  it('sanitizes ANSI sequences from user-edited config text', () => {
    const line = formatConfigIssueLine({
      path: '\x1b[31mevil\x1b[0m',
      message: '\x1b[32mbad\x1b[0m',
    });
    expect(line).toBe('- evil: bad');
  });

  it('handles null path with normalizeRoot false', () => {
    const line = formatConfigIssueLine(
      { path: null, message: 'm' },
      { normalizeRoot: false },
    );
    expect(line).toBe('- : m');
  });
});

describe('formatConfigIssueLines', () => {
  it('formats multiple issues', () => {
    const lines = formatConfigIssueLines([
      { path: 'a', message: 'one' },
      { path: 'b', message: 'two' },
    ]);
    expect(lines).toEqual(['- a: one', '- b: two']);
  });

  it('returns empty array for empty input', () => {
    expect(formatConfigIssueLines([])).toEqual([]);
  });
});

describe('formatConfigIssueSummary', () => {
  it('returns null for empty list', () => {
    expect(formatConfigIssueSummary([])).toBeNull();
  });

  it('returns single issue without truncation', () => {
    expect(formatConfigIssueSummary([{ path: 'a', message: 'x' }])).toBe('a: x');
  });

  it('joins multiple issues with semicolon separator', () => {
    expect(
      formatConfigIssueSummary([
        { path: 'a', message: 'x' },
        { path: 'b', message: 'y' },
      ]),
    ).toBe('a: x; b: y');
  });

  it('truncates at maxIssues and appends count', () => {
    const issues = Array.from({ length: 7 }, (_, i) => ({
      path: `p${i}`,
      message: `m${i}`,
    }));
    const summary = formatConfigIssueSummary(issues, { maxIssues: 3 });
    expect(summary).toBe('p0: m0; p1: m1; p2: m2; and 4 more');
  });

  it('does not append count when exactly at maxIssues', () => {
    const issues = Array.from({ length: 3 }, (_, i) => ({
      path: `p${i}`,
      message: `m${i}`,
    }));
    const summary = formatConfigIssueSummary(issues, { maxIssues: 3 });
    expect(summary).toBe('p0: m0; p1: m1; p2: m2');
  });

  it('respects custom separator', () => {
    const summary = formatConfigIssueSummary(
      [
        { path: 'a', message: 'x' },
        { path: 'b', message: 'y' },
      ],
      { separator: ' | ' },
    );
    expect(summary).toBe('a: x | b: y');
  });

  it('clamps maxIssues to minimum 1', () => {
    const summary = formatConfigIssueSummary(
      [
        { path: 'a', message: 'x' },
        { path: 'b', message: 'y' },
      ],
      { maxIssues: 0 },
    );
    expect(summary).toBe('a: x; and 1 more');
  });

  it('clamps negative maxIssues to 1', () => {
    const summary = formatConfigIssueSummary(
      [{ path: 'a', message: 'x' }],
      { maxIssues: -5 },
    );
    expect(summary).toBe('a: x');
  });

  it('normalizes paths in summary output', () => {
    const summary = formatConfigIssueSummary([{ path: '', message: 'root issue' }]);
    expect(summary).toBe('<root>: root issue');
  });

  it('sanitizes ANSI in summary output', () => {
    const summary = formatConfigIssueSummary([
      { path: '\x1b[31mx\x1b[0m', message: '\x1b[33mz\x1b[0m' },
    ]);
    expect(summary).toBe('x: z');
  });
});

describe('formatAllowedValues', () => {
  it('returns null for issue without allowedValues', () => {
    expect(formatAllowedValues({ path: 'a', message: 'm' })).toBeNull();
  });

  it('returns null for empty allowedValues array', () => {
    expect(formatAllowedValues({ path: 'a', message: 'm', allowedValues: [] })).toBeNull();
  });

  it('formats a single allowed value', () => {
    expect(
      formatAllowedValues({ path: 'a', message: 'm', allowedValues: ['on'] }),
    ).toBe('allowed: on');
  });

  it('formats multiple allowed values', () => {
    expect(
      formatAllowedValues({ path: 'a', message: 'm', allowedValues: ['on', 'off', 'auto'] }),
    ).toBe('allowed: on, off, auto');
  });

  it('appends hidden count when present', () => {
    expect(
      formatAllowedValues({
        path: 'a',
        message: 'm',
        allowedValues: ['on', 'off'],
        allowedValuesHiddenCount: 5,
      }),
    ).toBe('allowed: on, off (+5 hidden)');
  });

  it('does not append hidden count when zero', () => {
    expect(
      formatAllowedValues({
        path: 'a',
        message: 'm',
        allowedValues: ['on'],
        allowedValuesHiddenCount: 0,
      }),
    ).toBe('allowed: on');
  });

  it('sanitizes allowed values', () => {
    expect(
      formatAllowedValues({
        path: 'a',
        message: 'm',
        allowedValues: ['\x1b[31mevil\x1b[0m'],
      }),
    ).toBe('allowed: evil');
  });
});
