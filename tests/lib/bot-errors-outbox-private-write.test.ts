import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

let tmpRoot = '';

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('node:crypto');
  vi.resetModules();
  delete process.env['BOT_ERRORS_OUTBOX_DIR'];
  delete process.env['BOT_ERRORS_STATE_DIR'];
  delete process.env['BOT_ERRORS_WRITEFAIL_DIR'];
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('bot-errors outbox private writes', () => {
  it('refuses to publish an event through a pre-existing temp symlink', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-outbox-private-'));
    const outbox = join(tmpRoot, 'outbox');
    const writefail = join(tmpRoot, 'writefail');
    const outside = join(tmpRoot, 'outside-target');
    const eventId = '11111111-1111-4111-8111-111111111111';
    const created = '20260611T123456Z';
    const tmpName = `.${created}.vitest-outbox.symlink-test.${eventId}.json.${process.pid}.tmp`;

    process.env['BOT_ERRORS_OUTBOX_DIR'] = outbox;
    process.env['BOT_ERRORS_WRITEFAIL_DIR'] = writefail;
    mkdirSync(outbox, { recursive: true, mode: 0o700 });
    writeFileSync(outside, 'outside-original', { mode: 0o600 });
    symlinkSync(outside, join(outbox, tmpName));

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T12:34:56.789Z'));
    vi.doMock('node:crypto', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:crypto')>();
      return { ...actual, randomUUID: () => eventId };
    });

    const { writeBotErrorsEvent } = await import('../../src/lib/bot-errors-outbox.ts');

    expect(() => writeBotErrorsEvent({
      eventType: 'alert',
      instance: 'vitest-outbox',
      source: 'symlink-test',
      summary: 'symlink guard proof',
    })).toThrow();

    expect(readFileSync(outside, 'utf8')).toBe('outside-original');
    expect(existsSync(join(outbox, `${created}.vitest-outbox.symlink-test.${eventId}.json`))).toBe(false);
  });

  it('refuses to publish events through a symlinked outbox directory', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-outbox-dir-private-'));
    const outsideOutbox = join(tmpRoot, 'outside-outbox');
    const outboxLink = join(tmpRoot, 'outbox-link');
    const writefail = join(tmpRoot, 'writefail');

    mkdirSync(outsideOutbox, { recursive: true, mode: 0o700 });
    symlinkSync(outsideOutbox, outboxLink, 'dir');
    process.env['BOT_ERRORS_OUTBOX_DIR'] = outboxLink;
    process.env['BOT_ERRORS_WRITEFAIL_DIR'] = writefail;

    const { writeBotErrorsEvent } = await import('../../src/lib/bot-errors-outbox.ts');

    expect(() => writeBotErrorsEvent({
      eventType: 'alert',
      instance: 'vitest-outbox',
      source: 'symlink-outbox-dir',
      summary: 'symlinked outbox dir should not be trusted',
    })).toThrow(/private directory.*symlink/);

    expect(readdirSync(outsideOutbox)).toEqual([]);
    expect(readdirSync(writefail).filter((entry) => entry.endsWith('.writefail'))).toHaveLength(1);
  });

  it('skips a symlinked writefail directory and records the breadcrumb in the next safe fallback', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-writefail-dir-private-'));
    const outsideWritefail = join(tmpRoot, 'outside-writefail');
    const writefailLink = join(tmpRoot, 'writefail-link');
    const fallbackState = join(tmpRoot, 'state');

    mkdirSync(outsideWritefail, { recursive: true, mode: 0o700 });
    symlinkSync(outsideWritefail, writefailLink, 'dir');
    process.env['BOT_ERRORS_WRITEFAIL_DIR'] = writefailLink;
    process.env['BOT_ERRORS_STATE_DIR'] = fallbackState;

    const { recordBotErrorsWritefail } = await import('../../src/lib/bot-errors-outbox.ts');
    const path = recordBotErrorsWritefail(
      { id: 'event-id', instance: 'vitest-outbox', evidence: 'token=super-secret' },
      new Error('primary outbox failed'),
      join(tmpRoot, 'outbox', 'event.json'),
    );

    expect(path).toEqual(expect.stringContaining(join(fallbackState, 'writefail')));
    expect(readdirSync(outsideWritefail)).toEqual([]);
    expect(readdirSync(join(fallbackState, 'writefail')).filter((entry) => entry.endsWith('.writefail'))).toHaveLength(1);
    expect(readFileSync(path!, 'utf8')).not.toContain('super-secret');
  });
});
