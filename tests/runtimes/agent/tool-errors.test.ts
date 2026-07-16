import { describe, it, expect } from 'vitest';
import {
  classifyToolError,
  isOperatorActionableToolError,
  shouldEmitToolFailureAlert,
  stripToolErrorTags,
  isParallelSiblingCancellation,
} from '../../../src/runtimes/agent/runtime.ts';

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

  it('uses the provider-error fallback when a known tool has empty error content', () => {
    const result = classifyToolError('edit', '');
    expect(result.category).toBe('error');
    expect(result.detail.trim()).not.toBe('');
    expect(result.detail).toContain('edit');
    expect(result.detail.length).toBeLessThanOrEqual(110);
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

describe('isOperatorActionableToolError', () => {
  // ── Operator-actionable infra/provider-health signatures (DO alert) ──

  it.each([
    ['disk full (ENOSPC)', 'Error: ENOSPC: no space left on device, write'],
    ['disk full (phrase)', 'write failed: No space left on device'],
    ['out of memory (ENOMEM)', 'spawn ENOMEM'],
    ['out of memory (phrase)', 'FATAL ERROR: Reached heap limit Out of memory'],
    ['connection refused', 'connect ECONNREFUSED 127.0.0.1:5432'],
    ['connection reset', 'read ECONNRESET'],
    ['fetch failed', 'TypeError: fetch failed'],
    ['socket timeout', 'connect ETIMEDOUT 10.0.0.1:443'],
    ['provider rate limit', 'Error: rate limit exceeded, retry later'],
    ['provider overloaded', 'API error: overloaded_error'],
    ['context window', 'prompt is too long for the context window'],
    ['context length', 'maximum context length exceeded'],
    ['max tokens', 'request exceeds max_tokens for this model'],
  ])('flags %s as operator-actionable', (_label, content) => {
    expect(isOperatorActionableToolError(content)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isOperatorActionableToolError('ENOSPC: NO SPACE LEFT ON DEVICE')).toBe(true);
  });

  // ── Benign agent-recoverable results (do NOT alert) ──

  it.each([
    ['glob no-match (zsh)', '(eval):1: no matches found: *statement*'],
    ['grep/glob no matches', 'No matches found'],
    ['ripgrep no files', 'No files found'],
    ['bare exit code', 'Exit code 1'],
    ['missing path', 'ls: /tmp/nope: No such file or directory'],
    ['failed conditional', 'Exit code 2'],
    ['edit string miss', 'String to replace not found in file'],
    ['merge conflict', 'CONFLICT (content): Merge conflict in src/app.ts'],
    ['opaque command output', 'segfault at 0x0'],
    ['empty content', ''],
  ])('treats %s as benign (not operator-actionable)', (_label, content) => {
    expect(isOperatorActionableToolError(content)).toBe(false);
  });
});

describe('shouldEmitToolFailureAlert', () => {
  it('always emits for blocked category (permission/hook denial)', () => {
    expect(shouldEmitToolFailureAlert('blocked', 'Exit code 1')).toBe(true);
    expect(shouldEmitToolFailureAlert('blocked', 'permission denied')).toBe(true);
  });

  it('never emits for cancelled category (collateral of a sibling error, no result)', () => {
    // A cancelled tool produced no result and is not a fault. The real signal, if
    // any, is carried by the erroring sibling's own `error` classification.
    expect(shouldEmitToolFailureAlert('cancelled', 'Cancelled')).toBe(false);
    expect(
      shouldEmitToolFailureAlert(
        'cancelled',
        'Cancelled: parallel tool call Bash(cd /tmp/x && echo hi) errored',
      ),
    ).toBe(false);
    // Even an operator-actionable-looking string does not page when cancelled —
    // the sibling that actually hit it pages through the error path instead.
    expect(shouldEmitToolFailureAlert('cancelled', 'ENOSPC: no space left')).toBe(false);
  });

  it('suppresses error category for benign agent-recoverable results', () => {
    expect(shouldEmitToolFailureAlert('error', '(eval):1: no matches found: *statement*')).toBe(false);
    expect(shouldEmitToolFailureAlert('error', 'Exit code 1')).toBe(false);
    expect(shouldEmitToolFailureAlert('error', 'No matches found')).toBe(false);
  });

  it.each([
    ['unanswered AskUserQuestion marker', '<error>Answer questions?</error>'],
    ['tool input schema rejection', '<tool_use_error>InputValidationError: TaskUpdate missing required parameter `taskId`</tool_use_error>'],
    ['unknown skill command typo', 'Unknown skill: typo-command'],
    ['unknown slash command typo', 'Unknown slash command: /typo-command'],
  ])('suppresses self-correctable %s', (_label, content) => {
    expect(shouldEmitToolFailureAlert('error', content)).toBe(false);
  });

  it('emits error category only when an operator-actionable signature is present', () => {
    expect(shouldEmitToolFailureAlert('error', 'ENOSPC: no space left on device')).toBe(true);
    expect(shouldEmitToolFailureAlert('error', 'connect ECONNREFUSED 127.0.0.1:5432')).toBe(true);
  });
});

describe('stripToolErrorTags', () => {
  it('strips both <tool_use_error> and <error> wrappers and trims', () => {
    expect(stripToolErrorTags('<tool_use_error>boom</tool_use_error>')).toBe('boom');
    expect(stripToolErrorTags('<error>nope</error>')).toBe('nope');
    expect(stripToolErrorTags('  <tool_use_error> spaced </tool_use_error>  ')).toBe('spaced');
  });

  it('is a no-op (modulo trim) for content without wrappers', () => {
    expect(stripToolErrorTags('plain message')).toBe('plain message');
    expect(stripToolErrorTags('')).toBe('');
  });
});

describe('isParallelSiblingCancellation', () => {
  it('matches the benign parallel-batch sibling cancellation, wrapped or bare', () => {
    expect(
      isParallelSiblingCancellation('Cancelled: parallel tool call Bash(python3 cli.py list) errored'),
    ).toBe(true);
    expect(
      isParallelSiblingCancellation(
        '<tool_use_error>Cancelled: parallel tool call Bash(cd /home/q) errored</tool_use_error>',
      ),
    ).toBe(true);
    // case-insensitive on the leading marker
    expect(isParallelSiblingCancellation('CANCELLED: parallel tool call Read(x) errored')).toBe(true);
  });

  it('does NOT match genuine user/abort cancellations', () => {
    expect(isParallelSiblingCancellation('Cancelled')).toBe(false);
    expect(isParallelSiblingCancellation('Tool call was cancelled by the user')).toBe(false);
    expect(isParallelSiblingCancellation('')).toBe(false);
  });
});
