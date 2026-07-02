// Failure-class regression suite (continuation): server-error continuity +
// harness auto-switch transparency. Corpus from the agent provider CLI's
// binary string table; see docs/specs notes locally for the discovery passes.
import { describe, expect, it } from 'vitest';

import {
  classifyProviderFailure,
  detectAutoSwitchNotice,
  isProviderServerErrorMessage,
  providerFailureArmsFallback,
} from '../../../src/runtimes/agent/failure-taxonomy.ts';

describe('server-error / transient backend failure (continuity pipeline)', () => {
  it('detects the CLI friendly variants', () => {
    expect(isProviderServerErrorMessage('_Service temporarily unavailable - please try again in a moment._')).toBe(true);
    expect(isProviderServerErrorMessage('_Service error (503) - please try again._')).toBe(true);
    expect(isProviderServerErrorMessage('_Service error (500) - please try again._')).toBe(true);
  });

  it('detects structured backend tokens', () => {
    expect(isProviderServerErrorMessage('{"type":"overloaded_error"}')).toBe(true);
    expect(isProviderServerErrorMessage('api_error from provider')).toBe(true);
    expect(isProviderServerErrorMessage('server_error during compaction')).toBe(true);
    expect(isProviderServerErrorMessage('server_unavailable')).toBe(true);
  });

  it('detects backend high-demand capacity message (the 529 family)', () => {
    expect(isProviderServerErrorMessage('We are experiencing high demand for Opus 4.8.')).toBe(true);
  });

  it('detects bare HTTP 5xx / 529 status only when accompanied by status/error/http/overload context', () => {
    expect(isProviderServerErrorMessage('HTTP 502 from provider')).toBe(true);
    expect(isProviderServerErrorMessage('upstream returned status 503')).toBe(true);
    expect(isProviderServerErrorMessage('overload: 529')).toBe(true);
    // Negative guard: bare numerics in unrelated text must NOT match.
    expect(isProviderServerErrorMessage('processed 500 tokens')).toBe(false);
    expect(isProviderServerErrorMessage('took 529 ms')).toBe(false);
  });

  it('classifies server-error as a fallback-arming kind so the continuity pipeline runs', () => {
    expect(classifyProviderFailure('_Service temporarily unavailable - please try again in a moment._')).toBe('server-error');
    expect(providerFailureArmsFallback('server-error')).toBe(true);
  });

  it('preserves richer classifications over server-error (ordering)', () => {
    // A 529 response that ALSO conveys a usage-limit must classify as usage-limit
    // (it has the richer "you can't recover by retrying" meaning).
    expect(classifyProviderFailure("You've hit your session limit · resets 5pm. status 529.")).toBe('usage-limit');
  });

  it('does not classify ordinary mentions as server-error', () => {
    expect(isProviderServerErrorMessage('Please document handling for 500 / 503 server errors in the runbook.')).toBe(true);
    // The above SHOULD match — "server errors" + "500" + "503" carry server-context
    // tokens. The harder negative is purely conversational without those tokens:
    expect(isProviderServerErrorMessage('I think the 500 fund is the highest tier on this plan.')).toBe(false);
  });
});

describe('harness auto-switch transparency notice', () => {
  it('extracts {from, to} from "Switched to X due to high demand for Y"', () => {
    const n = detectAutoSwitchNotice('Switched to Opus 4.7 due to high demand for Opus 4.8');
    expect(n).not.toBeNull();
    expect(n!.to).toBe('Opus 4.7');
    expect(n!.from).toBe('Opus 4.8');
    expect(n!.reason).toBe('high-demand');
  });

  it('handles the "Now using <model>" variant (no source model)', () => {
    const n = detectAutoSwitchNotice("You're now using Sonnet 4.6 · resets 5pm (America/New_York)");
    expect(n).not.toBeNull();
    expect(n!.to).toBe('Sonnet 4.6');
    expect(n!.from).toBeNull();
    expect(n!.reason).toBe('auto-routed');
  });

  it('does not match ordinary discussion of model switching', () => {
    expect(detectAutoSwitchNotice('We considered switched-to-opus heuristics in the design doc.')).toBeNull();
    expect(detectAutoSwitchNotice('Now using opus is the default config across the fleet.')).toBeNull();
  });

  it('does not classify an auto-switch notice as a failure (transparency only)', () => {
    expect(classifyProviderFailure('Switched to Opus 4.7 due to high demand for Opus 4.8')).toBeNull();
  });

  // QR-130: the start anchor must not be `(?:^|\n|\s)` (O(n) start positions ×
  // O(n) lazy scan = catastrophic backtracking). detectAutoSwitchNotice runs
  // synchronously on the FULL agent reply text before splitMessage, so a
  // prompt-injected reply of repeated "Switched to " would freeze the event loop.
  it('is linear on a crafted "Switched to " flood (no catastrophic backtracking)', () => {
    const evil = 'Switched to '.repeat(40000); // ~480 KB
    const start = Date.now();
    const n = detectAutoSwitchNotice(evil);
    // Unfixed: ~4.7s at this size. Fixed: <5ms. 500ms cleanly separates them.
    expect(Date.now() - start).toBeLessThan(500);
    expect(n).toBeNull(); // no valid "due to high demand for" clause → no match
  });

  it('still matches real notices with a leading newline/indent (anchor parity)', () => {
    const withNewline = 'some prior line\nSwitched to Opus 4.7 due to high demand for Opus 4.8 · resets 5pm';
    const n = detectAutoSwitchNotice(withNewline);
    expect(n).not.toBeNull();
    expect(n!.to).toBe('Opus 4.7');
    expect(n!.from).toBe('Opus 4.8');
  });

  // QR-133: the "Now using" branch's capture must not overlap its trailing
  // whitespace matcher. `(?<to>[^·\n]+?)\s*·` backtracks O(n²) on a crafted
  // "Now using x" + long space run with no `·`. Same synchronous reply-path sink.
  it('is linear on a crafted "Now using" flood with no delimiter (no catastrophic backtracking)', () => {
    const evil = 'Now using x' + ' '.repeat(200000) + 'y'; // no `·` terminator
    const start = Date.now();
    const n = detectAutoSwitchNotice(evil);
    const elapsedMs = Date.now() - start;
    expect(n).toBeNull(); // no `·` delimiter → no auto-switch notice
    // Unfixed: ~19s at this size. Fixed: <1ms. 500ms cleanly separates them.
    expect(elapsedMs).toBeLessThan(500);
  });

  it('still parses the "Now using <model> ·" notice after the QR-133 rewrite', () => {
    const n = detectAutoSwitchNotice("You're now using Sonnet 4.6 · resets 5pm (America/New_York)");
    expect(n).not.toBeNull();
    expect(n!.to).toBe('Sonnet 4.6');
    expect(n!.reason).toBe('auto-routed');
  });
});
