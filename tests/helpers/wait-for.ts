import { existsSync } from 'node:fs';

interface MessageSource {
  once(event: 'message', listener: (data: Buffer | string | { toString(): string }) => void): unknown;
}

export function waitForSocket(socketPath: string, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (existsSync(socketPath)) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error(`Socket ${socketPath} never appeared`));
      } else {
        setTimeout(check, intervalMs);
      }
    };
    check();
  });
}

export function waitForMessage<T = unknown>(ws: MessageSource, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.toString()) as T);
      } catch (err) {
        reject(err);
      }
    });
  });
}
