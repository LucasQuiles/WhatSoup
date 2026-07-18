#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const [service, account] = process.argv.slice(2);
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
