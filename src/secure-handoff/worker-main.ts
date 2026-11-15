import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printErr } from '../lib/cli-print.ts';
import { readPrivateFileSync } from '../lib/private-fs.ts';
import { SIGNAL } from '../lib/signals.ts';

export function consumerConfigPath(args: string[]): string {
  if (args.length !== 2 || args[0] !== '--config' || !isAbsolute(args[1]) || args[1].includes('\0')) {
    throw new Error('consumer service requires --config with one absolute path');
  }
  return args[1];
}

export function readConsumerConfig(path: string): unknown {
  try {
    const contents = readPrivateFileSync(path, { maxBytes: 16_384, label: 'consumer service configuration' });
    if (contents === null) throw new Error('missing configuration');
    return JSON.parse(contents);
  } catch {
    throw new Error('consumer service configuration is unavailable');
  }
}

async function main(): Promise<void> {
  const path = consumerConfigPath(process.argv.slice(2));
  const raw = readConsumerConfig(path);
  const { parseSecureHandoffWorkerConfig } = await import('./worker-config.ts');
  const { createSecureHandoffWorker } = await import('./worker.ts');
  const worker = createSecureHandoffWorker({
    config: parseSecureHandoffWorkerConfig(raw),
    // env-allowed: Standalone consumer resolves its reserved credentials once at startup.
    environment: process.env,
  });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void worker.stop().then(() => {
      printErr('{"event":"consumer_stopped"}');
    }, () => {
      printErr('{"event":"consumer_stop_failed"}');
      process.exitCode = 1;
    });
  };
  process.once(SIGNAL.TERM, stop);
  process.once(SIGNAL.INT, stop);
  await worker.start();
  printErr('{"event":"consumer_started"}');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => {
    printErr('{"event":"consumer_start_failed"}');
    process.exitCode = 1;
  });
}
