import { pathToFileURL } from 'node:url';
import { startImsgRpcRelay } from '../src/transport/imessage/imsg-rpc-relay.ts';

const SUPPORTED_IMSG_VERSIONS = ['0.13.2'] as const;

export interface ImsgRpcRelayInvocation {
  readonly socketPath: string;
  readonly imsgBinary: string;
}

export function parseImsgRpcRelayArgs(args: readonly string[]): ImsgRpcRelayInvocation {
  let socketPath: string | undefined;
  let imsgBinary: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag === '--socket' || flag === '--imsg-bin') && value === undefined) {
      throw new Error(`missing value for ${flag}`);
    }
    if (flag === '--socket') {
      socketPath = value;
      index += 1;
    } else if (flag === '--imsg-bin') {
      imsgBinary = value;
      index += 1;
    } else {
      throw new Error(`unknown imsg relay argument: ${flag ?? ''}`);
    }
  }
  if (socketPath === undefined || imsgBinary === undefined) {
    throw new Error('usage: imsg-rpc-relay --socket <absolute-path> --imsg-bin <absolute-path>');
  }
  return { socketPath, imsgBinary };
}

export async function runImsgRpcRelay(args: readonly string[]): Promise<void> {
  const invocation = parseImsgRpcRelayArgs(args);
  const relay = startImsgRpcRelay({
    socketPath: invocation.socketPath,
    imsgBinary: invocation.imsgBinary,
    supportedVersions: SUPPORTED_IMSG_VERSIONS,
  });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void relay.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await relay.ready;
  await relay.stopped;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runImsgRpcRelay(process.argv.slice(2)).catch(() => {
    process.stderr.write('FATAL: imsg RPC relay failed to start or stopped unexpectedly\n');
    process.exitCode = 1;
  });
}
