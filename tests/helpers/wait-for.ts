import { existsSync } from 'node:fs';

interface MessageSource {
  once(event: 'message', listener: (data: Buffer | string | { toString(): string }) => void): unknown;
  off?(event: 'message', listener: (data: Buffer | string | { toString(): string }) => void): unknown;
  removeListener?(event: 'message', listener: (data: Buffer | string | { toString(): string }) => void): unknown;
}

interface ExitSource {
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  off?(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  removeListener?(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
}

export interface ExitResult {
  code: number | null;
  signal: string | null;
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
    const onMessage = (data: Buffer | string | { toString(): string }) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.toString()) as T);
      } catch (err) {
        reject(err);
      }
    };
    const timer = setTimeout(() => {
      ws.off?.('message', onMessage) ?? ws.removeListener?.('message', onMessage);
      reject(new Error('message timeout'));
    }, timeoutMs);
    ws.once('message', onMessage);
  });
}

export function waitForExit(child: ExitSource, timeoutMs = 3000): Promise<ExitResult> {
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      child.off?.('exit', onExit) ?? child.removeListener?.('exit', onExit);
      reject(new Error('exit timeout'));
    }, timeoutMs);
    child.once('exit', onExit);
  });
}
