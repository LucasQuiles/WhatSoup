import { describe, expect, it } from 'vitest';
import {
  CONTEXT_LINE_MAX_CHARS_PER_MESSAGE,
  CONTEXT_LINE_MAX_TOTAL_CHARS,
  formatContextLines,
  type ContextLineMessage,
} from '../../../src/runtimes/agent/context-lines.ts';

function msg(content: string | null, minuteOffset = 0, sender = 'Ada'): ContextLineMessage {
  return {
    timestamp: 1_780_000_000 + minuteOffset * 60,
    senderName: sender,
    senderJid: '15550190077@s.whatsapp.net',
    content,
  };
}

describe('formatContextLines budget (context-overflow respawn loop guard)', () => {
  it('exports sane budget constants', () => {
    expect(CONTEXT_LINE_MAX_CHARS_PER_MESSAGE).toBeGreaterThan(0);
    expect(CONTEXT_LINE_MAX_TOTAL_CHARS).toBeGreaterThan(CONTEXT_LINE_MAX_CHARS_PER_MESSAGE);
  });

  it('leaves small messages byte-identical to the legacy format', () => {
    const out = formatContextLines([msg('hello'), msg('world', 1, 'Bo')], false);
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[\d{2}:\d{2}\] Ada: hello$/);
    expect(lines[1]).toMatch(/^\[\d{2}:\d{2}\] Bo: world$/);
  });

  it('keeps null content as [media]', () => {
    expect(formatContextLines([msg(null)], false)).toContain('[media]');
  });

  it('truncates a single oversized message and says how much was cut', () => {
    const giant = 'directive '.repeat(2000); // 20,000 chars — a BES-scale strategy doc
    const out = formatContextLines([msg(giant)], false);
    expect(out.length).toBeLessThan(giant.length);
    expect(out.length).toBeLessThanOrEqual(CONTEXT_LINE_MAX_CHARS_PER_MESSAGE + 120);
    expect(out).toContain(giant.slice(0, 40)); // prefix survives
    expect(out).toMatch(/truncated \d+ chars/);
  });

  it('caps the total output and keeps the NEWEST messages when dropping', () => {
    const big = 'x'.repeat(CONTEXT_LINE_MAX_CHARS_PER_MESSAGE * 2);
    const messages = Array.from({ length: 30 }, (_, i) => msg(`${i}:${big}`, i));
    const out = formatContextLines(messages, false);
    expect(out.length).toBeLessThanOrEqual(CONTEXT_LINE_MAX_TOTAL_CHARS + 200);
    // Newest message must survive; oldest must be gone.
    expect(out).toContain('29:');
    expect(out).not.toContain('[00:'.repeat(0) + ' Ada: 0:'); // guard against accidental pass
    expect(out.includes('Ada: 0:')).toBe(false);
    expect(out).toMatch(/\d+ older message/);
  });

  it('never drops anything when the conversation fits the budget', () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg(`short ${i}`, i));
    const out = formatContextLines(messages, false);
    expect(out.split('\n')).toHaveLength(30);
    expect(out).not.toMatch(/older message|truncated/);
  });
});
