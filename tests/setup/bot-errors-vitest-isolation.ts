import { afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';

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

const tempRoot = realpathSync('/tmp');
const isolatedHome = mkdtempSync(join(tempRoot, 'ws-vh-'));
const ownershipToken = randomUUID();
const ownershipMarker = join(isolatedHome, '.whatsoup-vitest-home');
const isolatedTmpdir = join(isolatedHome, 'tmp');
chmodSync(isolatedHome, 0o700);
mkdirSync(isolatedTmpdir, { mode: 0o700 });
writeFileSync(ownershipMarker, ownershipToken, { mode: 0o600 });

afterAll(() => {
  const stat = lstatSync(isolatedHome);
  const resolved = realpathSync(isolatedHome);
  const fromTempRoot = relative(tempRoot, resolved);
  const escapedTempRoot = fromTempRoot === '..'
    || fromTempRoot.startsWith(`..${sep}`)
    || isAbsolute(fromTempRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory() || escapedTempRoot) {
    throw new Error('refusing to remove an unowned Vitest HOME');
  }
  if (readFileSync(ownershipMarker, 'utf8') !== ownershipToken) {
    throw new Error('refusing to remove Vitest HOME without its ownership marker');
  }
  rmSync(isolatedHome, { recursive: true });
});

process.env['WHATSOUP_VITEST_HOME'] = isolatedHome;
process.env['WHATSOUP_VITEST_TEMP_ROOT'] = tempRoot;
process.env['HOME'] = isolatedHome;
process.env['TMPDIR'] = isolatedTmpdir;
process.env['XDG_CONFIG_HOME'] = join(isolatedHome, '.config');
process.env['XDG_DATA_HOME'] = join(isolatedHome, '.local', 'share');
process.env['XDG_STATE_HOME'] = join(isolatedHome, '.local', 'state');
process.env['XDG_CACHE_HOME'] = join(isolatedHome, '.cache');
delete process.env['CLAUDE_CONFIG_DIR'];

process.env['BOT_ERRORS_TEST_ISOLATED'] = '1';
process.env['BOT_ERRORS_STATE_DIR'] = join(
  tmpdir(),
  'whatsoup-vitest-bot-errors',
  workerId,
  String(process.pid),
  'state',
);
