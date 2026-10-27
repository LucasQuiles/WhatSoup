#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';

const [service, requestedAccount] = process.argv.slice(2);
const account = requestedAccount || (() => {
  try {
    return userInfo().username;
  } catch {
    return '';
  }
})();
if (!service || !account) process.exit(64);

try {
  const value = execFileSync(
    'security',
    ['find-generic-password', '-s', service, '-a', account, '-w'],
    {
      encoding: 'utf8',
      timeout: 3_000,
      killSignal: 'SIGKILL',
      maxBuffer: 4_096,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  process.stdout.write(value);
} catch {
  process.exitCode = 1;
}
