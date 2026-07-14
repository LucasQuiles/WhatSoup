import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Unique temp Unix-socket path for a socket-server test. */
export function makeSocketPath(): string {
  return join(tmpdir(), `whatsoup-test-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}.sock`);
}

/**
 * Connect to the socket, send one JSON-RPC message, and return the first
 * complete response line. Rejects after 3 seconds.
 */
export function sendJsonRpc(socketPath: string, msg: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify(msg) + '\n');
    });
    let buf = '';
    client.on('data', (chunk) => {
      buf += chunk.toString();
      for (const line of buf.split('\n')) {
        if (line.trim()) {
          try {
            resolve(JSON.parse(line));
            client.end();
          } catch {
            // partial line, keep buffering
          }
        }
      }
    });
    client.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 3000);
  });
}
