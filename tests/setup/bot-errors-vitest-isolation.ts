import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIVE_ROUTING_ENV_KEYS = [
  'BOT_ERRORS_ALLOW_LIVE_IN_TESTS',
  'BOT_ERRORS_OUTBOX_DIR',
  'BOT_ERRORS_WRITEFAIL_DIR',
  'BOT_ERRORS_JID',
  'BOT_ERRORS_EXPECTED_JID',
  'BOT_ERRORS_SOCKET',
  'BOT_ERRORS_SOCKET_PATH',
  'BOT_ERRORS_DB',
] as const;

function safeSegment(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'main';
}

for (const key of LIVE_ROUTING_ENV_KEYS) {
  delete process.env[key];
}

const workerId = safeSegment(process.env['VITEST_POOL_ID'] ?? process.env['VITEST_WORKER_ID'] ?? 'main');

process.env['BOT_ERRORS_TEST_ISOLATED'] = '1';
process.env['BOT_ERRORS_STATE_DIR'] = join(
  tmpdir(),
  'whatsoup-vitest-bot-errors',
  workerId,
  String(process.pid),
  'state',
);
