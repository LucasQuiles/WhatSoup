import { describe, it, expect } from 'vitest';
import { classifyToolError } from '../../../src/runtimes/agent/runtime.ts';

describe('classifyToolError', () => {
  // ── Error vs blocked classification ──

  it('classifies generic errors as error category', () => {
    const result = classifyToolError('Bash', 'Exit code 1');
    expect(result.category).toBe('error');
  });

  it('classifies permission denials as blocked', () => {
    const result = classifyToolError('Write', 'Permission denied: /etc/passwd');
    expect(result.category).toBe('blocked');
  });

  it('classifies hook blocks as blocked', () => {
    const result = classifyToolError('Bash', 'blocked by hookify rule: no-rm-rf');
    expect(result.category).toBe('blocked');
  });

  it('classifies "not allowed" as blocked', () => {
    const result = classifyToolError('Edit', 'Tool Edit is not allowed in this context');
    expect(result.category).toBe('blocked');
  });

  it('classifies "disallowed" as blocked', () => {
    const result = classifyToolError('Bash', 'Command disallowed by sandbox policy');
    expect(result.category).toBe('blocked');
  });

  // ── Detail formatting ──

  it('formats known tool with reason', () => {
    const result = classifyToolError('Bash', 'Exit code 1');
    expect(result.detail).toBe('Bash — exit code 1');
  });

  it('formats unknown tool with just reason', () => {
    const result = classifyToolError('unknown', 'Something broke');
    expect(result.detail).toBe('Something broke');
  });

  // ── Content cleaning ──

  it('strips <tool_use_error> XML tags', () => {
    const result = classifyToolError('Bash', '<tool_use_error>Cancelled: parallel tool call Bash(cd /home/q) error</tool_use_error>');
    expect(result.detail).not.toContain('<tool_use_error>');
    expect(result.detail).not.toContain('</tool_use_error>');
  });

  it('strips <error> XML tags', () => {
    const result = classifyToolError('Read', '<error>File not found</error>');
    expect(result.detail).toBe('Read — File not found');
  });

  it('simplifies "Cancelled: parallel tool call" to "Cancelled"', () => {
    const result = classifyToolError('Bash', '<tool_use_error>Cancelled: parallel tool call Bash(cd /home/q/agents/q/.worktrees/fleet-module && git diff) error</tool_use_error>');
    expect(result.detail).toBe('Bash — Cancelled');
  });

  it('lowercases "Exit code N"', () => {
    const result = classifyToolError('Bash', 'Exit code 127');
    expect(result.detail).toBe('Bash — exit code 127');
  });

  it('truncates long error content to 100 chars', () => {
    const longError = 'A'.repeat(200);
    const result = classifyToolError('Bash', longError);
    expect(result.detail.length).toBeLessThanOrEqual(110); // tool name + " — " + 99 + "…"
  });

  it('uses first line only for multiline errors', () => {
    const result = classifyToolError('Bash', 'first line\nsecond line\nthird line');
    expect(result.detail).toBe('Bash — first line');
  });
});
