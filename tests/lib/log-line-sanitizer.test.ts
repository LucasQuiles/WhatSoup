/**
 * The final-line protected-link guarantee for log output. Real Pino, built
 * with the production logger options, writes each line to a capturing stream;
 * the line must carry no protected link however the link reached it (format
 * arguments, objects, errors, JSON-escaped boundaries) and must stay valid JSON.
 */
import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';

vi.mock('../../src/lib/protected-delivery-pins.ts', async (importOriginal) =>
  (await import('../helpers/protected-delivery-pins.ts')).mockProtectedDeliveryPins(importOriginal as never));

import { loggerOptions } from '../../src/logger.ts';
import { sanitizingStreamWrite } from '../../src/lib/log-line-sanitizer.ts';
import { sanitizingLogHook } from '../../src/lib/log-sanitizer.ts';
import { PROTECTED_MESSAGE_MARKER, PROTECTED_TEXT_WITHHELD_MARKER } from '../../src/lib/protected-link-text.ts';
import { TEST_LINK_HOST } from '../helpers/protected-delivery-pins.ts';

const FRAGMENT = `v3.${'Q'.repeat(22)}.${'Z'.repeat(43)}`;
const LINK = `https://${TEST_LINK_HOST}/s/#${FRAGMENT}`;
const BARE = `${TEST_LINK_HOST}/s/#${FRAGMENT}`;

function writtenLine(log: (logger: pino.Logger) => void): { line: string; parsed: Record<string, unknown> } {
  const lines: string[] = [];
  const logger = pino(loggerOptions, { write: (line: string) => { lines.push(line); } });
  log(logger);
  expect(lines).toHaveLength(1);
  const line = lines[0]!;
  expect(line.endsWith('\n')).toBe(true);
  return { line, parsed: JSON.parse(line) as Record<string, unknown> };
}

function expectNoLink(line: string): void {
  expect(line).not.toMatch(/\.example\.test\/s/i);
  expect(line).not.toContain('Q'.repeat(22));
}

const REDACTED_LINES: Array<[string, (logger: pino.Logger) => void]> = [
  ['%j of an object', (logger) => logger.info('payload %j', { url: LINK })],
  ['%o of an object', (logger) => logger.info('payload %o', { url: LINK })],
  ['a merge object followed by %o', (logger) => logger.info({ attempt: 1 }, 'payload %o', { url: LINK })],
  ['a link split across %s arguments', (logger) => logger.info('open https://%s/s/#%s', TEST_LINK_HOST, FRAGMENT)],
  ['an Error interpolated with %s', (logger) => logger.info('failed: %s', new Error(`delivery failed for ${LINK}`))],
  ['an Error as the merge object', (logger) => logger.error(new Error(`delivery failed for ${LINK}`))],
  ['a link containing a quote', (logger) => logger.info('payload %j', { url: `${LINK}"tail` })],
  ['a long-s host spelling', (logger) => logger.info('payload %j', { url: 'https://linkſ.example.test/s/#frag' })],
  ['a Kelvin-sign host spelling', (logger) => logger.info('payload %j', { url: 'https://linKs.example.test/s/#frag' })],
  ['a bare host after an escaped newline', (logger) => logger.info('payload %j', { text: `line\n${BARE}` })],
  ['a bare host after an escaped control character', (logger) => logger.info('payload %j', { text: `\u0001${BARE}` })],
  ['a bare host after a double-encoded newline',
    (logger) => logger.info('payload %s', JSON.stringify(JSON.stringify(`line\n${BARE}`)))],
  ['a child logger', (logger) => logger.child({ component: 'probe' }).info('payload %j', { url: LINK })],
];

describe('final log line sanitizer (real Pino, production options)', () => {
  it.each(REDACTED_LINES)('redacts %s and keeps the line valid JSON', (_name, log) => {
    const { line } = writtenLine(log);

    expectNoLink(line);
    expect(line).toContain(PROTECTED_MESSAGE_MARKER);
  });

  it('replaces the whole message with the withheld marker past the 128-link bound', () => {
    const { line, parsed } = writtenLine((logger) => logger.warn('payload %j', { urls: Array(129).fill(LINK) }));

    expectNoLink(line);
    expect(parsed.msg).toBe(PROTECTED_TEXT_WITHHELD_MARKER);
    expect(parsed.level).toBe(40);
    expect(typeof parsed.time).toBe('number');
  });

  it('replaces the whole message with the withheld marker when a fragment runs past its bound', () => {
    const { line, parsed } = writtenLine((logger) =>
      logger.info('payload %j', { url: `https://${TEST_LINK_HOST}/s/#${'F'.repeat(16_384)}` }));

    expect(line).not.toContain('F'.repeat(64));
    expect(parsed.msg).toBe(PROTECTED_TEXT_WITHHELD_MARKER);
  });

  it('withholds a log string argument with more than 128 links before formatting', () => {
    const forwarded: unknown[][] = [];
    sanitizingLogHook.call(null, [`failed ${`${LINK} `.repeat(129)}`], (...args: unknown[]) => { forwarded.push(args); }, 30);

    expect(forwarded).toEqual([[PROTECTED_TEXT_WITHHELD_MARKER]]);
  });

  it('returns a line without a fragment marker unchanged', () => {
    const line = '{"level":30,"time":1,"msg":"plain text"}\n';

    expect(sanitizingStreamWrite(line)).toBe(line);
  });

  it('writes only the fixed message for a withheld line without a Pino prefix', () => {
    const line = `{"msg":${JSON.stringify(Array(129).fill(LINK).join(' '))}}\n`;

    expect(JSON.parse(sanitizingStreamWrite(line))).toEqual({ msg: PROTECTED_TEXT_WITHHELD_MARKER });
  });
});
