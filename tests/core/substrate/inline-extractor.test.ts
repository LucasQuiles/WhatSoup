import { describe, it, expect } from 'vitest';
import { matchImperative, extractImperativeTarget } from '../../../src/core/substrate/inline-extractor.ts';

describe('inline extractor — imperative whitelist', () => {
  it.each([
    ['remind me to call Alex Friday', 'remind'],
    ['schedule a daily digest at 8am', 'schedule'],
    ['watch for email from alex-email-token', 'watch'],
    ['follow up with deploy team next week', 'follow-up'],
    ['make a task: audit the bridge logs', 'task'],
    ['track this conversation for a week', 'track'],
    ['add a bead for the worker SIGTERM thing', 'bead'],
  ])('matches: %s', (msg, expectedVerb) => {
    const m = matchImperative(msg);
    expect(m).not.toBeNull();
    expect(m!.verb).toBe(expectedVerb);
  });

  it.each([
    'we should probably redo the deploy pipeline next quarter',
    'thinking about watching emails later',
    'reminded me that we need to update docs',
    'nothing to track here',
  ])('does not match soft phrasing: %s', (msg) => {
    expect(matchImperative(msg)).toBeNull();
  });

  it('extractImperativeTarget strips the imperative prefix', () => {
    expect(extractImperativeTarget('remind me to call Alex Friday')).toBe('call Alex Friday');
  });
});
