// Branch-coverage draft for src/runtimes/agent/runtime.ts (source lines < 4000).
//
// Campaign: RR-013 coverage ratchet, branch% long pole. This file targets
// UNCOVERED branches in pure, side-effect-free exported functions that the
// existing suites (tool-errors.test.ts, poll-format.test.ts,
// provider-fallback.test.ts, prepare-content.test.ts, group-poll-resolution.test.ts,
// poll-persistence.test.ts) leave open. It intentionally does NOT re-exercise
// branches those suites already cover, and does NOT touch buildToolUpdate
// (owned by the sibling build-tool-update.test.ts draft) nor any source region
// at/above line 4000 (owned by a sibling agent).
//
// All assertions are on real return values of real functions — no mocks, no DB,
// no subprocess. The classifyToolError path drives the internal humanizeError
// matcher, so its uncovered string-classification branches are reached through
// the public API.

import { describe, it, expect } from 'vitest';
import {
  classifyToolError,
  extractUsageLimitResetTime,
  formatPollQuestion,
} from '../../../src/runtimes/agent/runtime.ts';

const OPTION_MAX = 95;
const ELLIPSIS = '…';

// ───────────────────────────────────────────────────────────────────────────
// classifyToolError → humanizeError: the error-classification branches the
// existing tool-errors.test.ts does NOT cover. Each maps to a distinct `if`
// branch inside humanizeError (runtime.ts ~1076–1116). classifyToolError only
// invokes humanizeError on the `category === 'error' && toolName !== 'unknown'`
// path, so each input below is a benign technical error string for a known tool.
// ───────────────────────────────────────────────────────────────────────────

describe('classifyToolError → humanizeError uncovered matchers', () => {
  it('rewrites "command not found" (line ~1076)', () => {
    const result = classifyToolError('Bash', 'zsh: command not found: frobnicate');
    expect(result.category).toBe('error');
    expect(result.detail).toBe('_command not found, trying another approach_');
  });

  it('rewrites "no matches found" from search tools (line ~1085)', () => {
    const result = classifyToolError('Grep', 'No matches found for pattern');
    expect(result.category).toBe('error');
    expect(result.detail).toBe('_no results, refining search_');
  });

  it('rewrites "no files found" from glob tools (line ~1085, second operand)', () => {
    const result = classifyToolError('Glob', 'No files found matching **/*.xyz');
    expect(result.detail).toBe('_no results, refining search_');
  });

  it('rewrites git "merge conflict" (line ~1088)', () => {
    const result = classifyToolError('Bash', 'CONFLICT (content): Merge conflict in app.ts');
    expect(result.detail).toBe('_merge conflict detected, resolving_');
  });

  it('rewrites "syntax error" (line ~1094)', () => {
    // The matcher keys on the literal phrase "syntax error" (with a space) via
    // lower.includes('syntax error'); a compact "SyntaxError" token would NOT
    // match. Use the real phrase so this exercises the intended branch.
    const result = classifyToolError('Bash', 'bash: line 3: syntax error near unexpected token');
    expect(result.detail).toBe('_syntax error, fixing_');
  });

  it('rewrites disk-full ENOSPC (line ~1097)', () => {
    const result = classifyToolError('Write', 'ENOSPC: no space left on device, write');
    expect(result.detail).toBe('_disk full, freeing space_');
  });

  it('rewrites invalid-JSON "unexpected token" (line ~1103)', () => {
    const result = classifyToolError('Read', 'Unexpected token } in JSON at position 42');
    expect(result.detail).toBe('_got malformed data, retrying_');
  });

  it('rewrites a rejected git push (line ~1109 — both operands true)', () => {
    // Requires BOTH "rejected" AND "push" so the && short-circuit takes the
    // truthy path through its right operand.
    const result = classifyToolError(
      'Bash',
      'error: failed to push some refs; updates were rejected',
    );
    expect(result.detail).toBe('_push rejected, pulling latest changes first_');
  });

  it('does NOT treat a bare "rejected" (no push) as the push branch (line ~1109 left-true/right-false)', () => {
    // "rejected" present, "push" absent → the merged condition is false, so the
    // push rewrite is skipped and the message falls through to technical detail.
    const result = classifyToolError('Bash', 'connection rejected by remote host');
    expect(result.detail).toBe('Bash — connection rejected by remote host');
  });

  it('rewrites context-window limits (line ~1112)', () => {
    const result = classifyToolError('Read', 'Error: exceeded context window for this model');
    expect(result.detail).toBe('_hitting context limits, compacting_');
  });

  it('rewrites max_tokens limits (line ~1112, alternate operand)', () => {
    const result = classifyToolError('Bash', 'request exceeds max_tokens budget');
    expect(result.detail).toBe('_hitting context limits, compacting_');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// formatPollQuestion: branches that require a >95-char label combined with a
// detail-bearing or non-fitting description — combinations the existing
// poll-format.test.ts does not produce.
// ───────────────────────────────────────────────────────────────────────────

describe('formatPollQuestion oversized-label branches', () => {
  it('truncates an oversized label when another option carries paragraph detail (line ~708)', () => {
    // One paragraph-scale description flips the whole question into concise-label
    // mode (hasDetailDescription === true). The oversized label on the second
    // option must then be ellipsis-truncated inside that branch.
    const hugeLabel = 'L'.repeat(130);
    const result = formatPollQuestion({
      question: 'Choose a rollout plan',
      options: [
        { label: 'Plan A', description: 'P'.repeat(120) }, // paragraph → detail mode
        { label: hugeLabel, description: 'short note' },
      ],
    });
    expect(result.pollValues[0]).toBe('Plan A');
    expect(result.pollValues[1].length).toBe(OPTION_MAX);
    expect(result.pollValues[1].endsWith(ELLIPSIS)).toBe(true);
    expect(result.pollValues[1].startsWith('LLLL')).toBe(true);
    expect(result.needsFollowUp).toBe(true);
  });

  it('truncates an oversized label in the bare-label fallback when its short description cannot fit (line ~733)', () => {
    // Short description (below the 72-char detail threshold) keeps the question
    // OUT of detail mode, so the rich-text path runs. The label alone exceeds the
    // budget, forcing descBudget < 10 and reaching the bare-label fallback where
    // the label itself must still be ellipsis-truncated.
    const hugeLabel = 'X'.repeat(110);
    const result = formatPollQuestion({
      question: 'Pick one',
      options: [{ label: hugeLabel, description: 'ok' }],
    });
    expect(result.pollValues[0].length).toBe(OPTION_MAX);
    expect(result.pollValues[0].endsWith(ELLIPSIS)).toBe(true);
    expect(result.pollValues[0].startsWith('XXXX')).toBe(true);
    expect(result.needsFollowUp).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// extractUsageLimitResetTime: validation-failure and edge-meridiem/epoch
// branches the existing provider-fallback.test.ts does not reach.
// ───────────────────────────────────────────────────────────────────────────

describe('extractUsageLimitResetTime uncovered branches', () => {
  const now = new Date('2026-06-10T10:00:00');

  it('rejects an out-of-range clock hour and falls through to null (line ~1223 validation-false)', () => {
    // "resets at 25" → hour 25 with no meridiem violates hour <= 23, so the
    // validated-clock branch is skipped. With no epoch present the result is null.
    const out = extractUsageLimitResetTime('Usage limit reached, resets at 25.', now);
    // Exact-value assertion: an invalid clock hour with no epoch yields null,
    // never a coerced/stale Date.
    expect(out).toBe(null);
  });

  it('maps "12am" to midnight (line ~1232 am/hour===12 branch)', () => {
    // 12am must normalize to hour 0. Midnight today is already past 10:00 "now",
    // so it rolls forward to tomorrow.
    const out = extractUsageLimitResetTime('Resets at 12am.', now);
    expect(out).not.toBeNull();
    expect(out!.getHours()).toBe(0);
    expect(out!.getMinutes()).toBe(0);
    expect(out!.getDate()).toBe(now.getDate() + 1);
  });

  it('parses a cue-anchored 13-digit millisecond epoch (line ~1253 millis-true branch)', () => {
    // A 13-digit value directly after the cue is treated as epoch-milliseconds
    // (no *1000). Use a future instant so the > now guard passes.
    const futureMs = now.getTime() + 3_600_000; // +1h, 13 digits in 2026
    expect(String(futureMs).length).toBe(13);
    const out = extractUsageLimitResetTime(`Resets at ${futureMs}.`, now);
    expect(out).not.toBeNull();
    expect(out!.getTime()).toBe(futureMs);
  });

  it('returns null for a cue-anchored epoch already in the past (line ~1256 guard-false)', () => {
    // The cue makes the epoch regex match, but a past epoch fails the
    // `epochMs > now` guard, so the function returns null rather than a stale time.
    const pastSeconds = Math.floor(now.getTime() / 1000) - 7200; // -2h, 10 digits
    const out = extractUsageLimitResetTime(`Resets at ${pastSeconds}.`, now);
    // Exact-value assertion: a past epoch fails the `> now` guard and returns
    // null rather than a stale past Date.
    expect(out).toBe(null);
  });
});
