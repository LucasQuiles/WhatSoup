import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { botErrorsOutboxDir, writeBotErrorsEvent } from '../../src/lib/bot-errors-outbox.ts';

const ENV_KEYS = [
  'BOT_ERRORS_STATE_DIR',
  'BOT_ERRORS_OUTBOX_DIR',
  'BOT_ERRORS_WRITEFAIL_DIR',
  'BOT_ERRORS_JID',
  'BOT_ERRORS_EXPECTED_JID',
  'BOT_ERRORS_SOCKET',
  'BOT_ERRORS_SOCKET_PATH',
  'BOT_ERRORS_DB',
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

function restoreEnv(): void {
  for (const [key, value] of originalEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  restoreEnv();
});

describe('BOT ERRORS Vitest isolation', () => {
  it('scrubs live routing values and installs a temp sandbox by default', () => {
    expect(process.env['BOT_ERRORS_TEST_ISOLATED']).toBe('1');
    expect(process.env['BOT_ERRORS_STATE_DIR']).toContain('whatsoup-vitest-bot-errors');
    expect(process.env['BOT_ERRORS_OUTBOX_DIR']).toBeUndefined();
    expect(process.env['BOT_ERRORS_WRITEFAIL_DIR']).toBeUndefined();
    expect(botErrorsOutboxDir()).toContain('whatsoup-vitest-bot-errors');
    expect(process.env['BOT_ERRORS_SOCKET']).toBeUndefined();
    expect(process.env['BOT_ERRORS_SOCKET_PATH']).toBeUndefined();
    expect(process.env['BOT_ERRORS_DB']).toBeUndefined();
    expect(process.env['BOT_ERRORS_JID']).toBeUndefined();
    expect(process.env['BOT_ERRORS_EXPECTED_JID']).toBeUndefined();
    expect(botErrorsOutboxDir()).toEqual(expect.stringMatching(/whatsoup-vitest-bot-errors.*state.*outbox/));
  });

  it('falls back to the Vitest sandbox instead of the live home outbox when env dirs are deleted', () => {
    for (const key of ENV_KEYS) delete process.env[key];

    const outbox = botErrorsOutboxDir();

    expect(outbox).toContain('whatsoup-vitest-bot-errors');
    expect(outbox).not.toContain(join(homedir(), '.local', 'state', 'bot-errors'));
  });

  it('writes test events only under the Vitest sandbox without explicit env dirs', () => {
    for (const key of ENV_KEYS) delete process.env[key];

    const written = writeBotErrorsEvent({
      eventType: 'alert',
      instance: 'vitest-isolation',
      source: 'sandbox-proof',
      summary: 'test isolation proof',
    });

    expect(written.path).toContain('whatsoup-vitest-bot-errors');
    expect(written.path).not.toContain(join(homedir(), '.local', 'state', 'bot-errors'));

    const event = JSON.parse(readFileSync(written.path, 'utf8')) as Record<string, unknown>;
    expect(event).toMatchObject({
      eventType: 'alert',
      instance: 'vitest-isolation',
      source: 'sandbox-proof',
      summary: {
        failureClass: 'unknown',
      },
    });

    rmSync(dirname(dirname(written.path)), { recursive: true, force: true });
  });
});
