/**
 * Tests for provider field threading through FeedEvent (Task F1)
 */
import { describe, it, expect } from 'vitest';
import { parsePinoLine } from '../../src/fleet/routes/feed.ts';

function makeLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ level: 30, time: 1700000000000, ...fields });
}

describe('parsePinoLine — provider field', () => {
  it('includes provider in output when provided in context', () => {
    const line = makeLine({ msg: 'session started' });
    const result = parsePinoLine(line, {
      instanceName: 'primary-line',
      instanceType: 'passive',
      provider: 'baileys',
    });

    expect(result).not.toBeNull();
    expect(result?.provider).toBe('baileys');
  });

  it('omits provider when not in context', () => {
    const line = makeLine({ msg: 'session started' });
    const result = parsePinoLine(line, {
      instanceName: 'primary-line',
      instanceType: 'passive',
    });

    expect(result).toStrictEqual({
      time: '2023-11-14T22:13:20.000Z',
      mode: 'passive',
      text: 'primary-line: session started',
      instance: 'primary-line',
      level: 'info',
      detail: {
        type: 'session',
        action: 'session started',
        sessionId: undefined,
        chatJid: undefined,
      },
    });
  });

  it('passes provider through for warn-level events', () => {
    const line = makeLine({ level: 40, msg: 'connection error' });
    const result = parsePinoLine(line, {
      instanceName: 'operator-agent',
      instanceType: 'agent',
      provider: 'whapi',
    });

    expect(result).not.toBeNull();
    expect(result?.provider).toBe('whapi');
    expect(result?.isError).toBe(true);
  });
});
