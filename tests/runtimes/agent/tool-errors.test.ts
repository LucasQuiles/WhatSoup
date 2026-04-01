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

  it('humanizes exit code errors for known tools', () => {
    const result = classifyToolError('Bash', 'Exit code 1');
    expect(result.detail).toMatch(/^_.*_$/); // italicized
    expect(result.detail).toContain('exited');
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

  it('strips <error> XML tags and humanizes content', () => {
    const result = classifyToolError('Read', '<error>File not found</error>');
    expect(result.detail).toContain('file not found');
    expect(result.detail).not.toContain('<error>');
  });

  it('classifies cancelled tool calls as cancelled category', () => {
    const result = classifyToolError('Bash', '<tool_use_error>Cancelled: parallel tool call Bash(cd ~/agents/q/.worktrees/fleet-module && git diff) error</tool_use_error>');
    expect(result.category).toBe('cancelled');
    expect(result.detail).toBe('Bash — Cancelled');
  });

  it('classifies "was cancelled" as cancelled', () => {
    const result = classifyToolError('Read', 'Tool call was cancelled by the user');
    expect(result.category).toBe('cancelled');
  });

  it('humanizes all exit code patterns', () => {
    const result = classifyToolError('Bash', 'Exit code 127');
    expect(result.detail).toMatch(/^_.*_$/);
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

  // ── Human-friendly rewrites ──

  it('humanizes file-too-large errors without tool name prefix', () => {
    const result = classifyToolError('Read', 'File content (17906 tokens) exceeds maximum allowed tokens (10000). Use offset and limit parameters to read specific ranges.');
    expect(result.category).toBe('error');
    expect(result.detail).toMatch(/^_.*_$/); // wrapped in italics
    expect(result.detail).not.toContain('Read');
    expect(result.detail).toContain('long');
  });

  it('humanizes file-not-found errors', () => {
    const result = classifyToolError('Read', 'ENOENT: no such file or directory, open \'/tmp/missing.txt\'');
    expect(result.detail).toContain('file not found');
    expect(result.detail).not.toContain('Read');
  });

  it('humanizes timeout errors', () => {
    const result = classifyToolError('Bash', 'Command timed out after 120000ms');
    expect(result.detail).toContain('too long');
  });

  it('humanizes connection errors', () => {
    const result = classifyToolError('WebFetch', 'fetch failed: ECONNREFUSED 127.0.0.1:3000');
    expect(result.detail).toContain('connection failed');
  });

  it('humanizes rate limit errors', () => {
    const result = classifyToolError('Bash', 'Error: 429 rate limit exceeded');
    expect(result.detail).toContain('rate limited');
  });

  it('humanizes Edit old_string-not-found errors', () => {
    const result = classifyToolError('Edit', 'String "old_string" not found in file.');
    expect(result.detail).toContain('re-reading');
  });

  it('humanizes exit code errors', () => {
    const result = classifyToolError('Bash', 'Exit code 1');
    expect(result.detail).toMatch(/^_.*_$/);
    expect(result.detail).toContain('exited');
  });

  it('humanizes out-of-memory errors', () => {
    const result = classifyToolError('Bash', 'Out of memory: JavaScript heap');
    expect(result.detail).toContain('out of memory');
  });

  it('falls through to technical detail for unknown patterns', () => {
    const result = classifyToolError('Bash', 'segfault at 0x0');
    expect(result.detail).toBe('Bash — segfault at 0x0');
  });
});
