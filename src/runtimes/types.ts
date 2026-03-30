// src/runtimes/types.ts
import type { IncomingMessage, RuntimeHealth } from '../core/types.ts';

export interface Runtime {
  start(): Promise<void>;
  handleMessage(msg: IncomingMessage): Promise<void>;
  getHealthSnapshot(): RuntimeHealth;
  shutdown(): Promise<void>;
}
