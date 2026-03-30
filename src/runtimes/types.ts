// src/runtimes/types.ts
import type { IncomingMessage, RuntimeHealth } from '../core/types.ts';
import type { DurabilityEngine } from '../core/durability.ts';

export interface Runtime {
  start(): Promise<void>;
  handleMessage(msg: IncomingMessage): Promise<void>;
  getHealthSnapshot(): RuntimeHealth;
  shutdown(): Promise<void>;
  setDurability(engine: DurabilityEngine): void;
}
