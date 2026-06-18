import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const allowLive = process.env['BOT_ERRORS_ALLOW_LIVE_IN_TESTS'] === '1';

if (!allowLive) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('BOT_ERRORS_') && key !== 'BOT_ERRORS_ALLOW_LIVE_IN_TESTS') {
      delete process.env[key];
    }
  }

  const workerId = process.env['VITEST_POOL_ID'] ?? process.env['VITEST_WORKER_ID'] ?? String(process.pid);
  const root = join(tmpdir(), 'whatsoup-vitest-bot-errors', workerId, String(process.pid));

  process.env['BOT_ERRORS_STATE_DIR'] = join(root, 'state');
  process.env['BOT_ERRORS_REQUIRE_EXPECTED'] = '1';
  process.env['BOT_ERRORS_TEST_ISOLATED'] = '1';

  mkdirSync(process.env['BOT_ERRORS_STATE_DIR'], { recursive: true, mode: 0o700 });
}
