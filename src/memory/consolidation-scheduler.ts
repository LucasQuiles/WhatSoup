import { createChildLogger } from '../logger.ts';
import type { PineconeMemory } from '../runtimes/chat/providers/pinecone.ts';
import type { LLMProvider } from '../runtimes/chat/providers/types.ts';
import { runConsolidation } from './consolidation-cron.ts';

const log = createChildLogger('memory:consolidation-scheduler');

export interface MemoryConsolidationSchedulerConfig {
  intervalMs: number;
  lookbackDays: number;
  dryRun: boolean;
}

export class MemoryConsolidationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = true;
  private activeRun: Promise<void> | null = null;
  private pinecone: Pick<PineconeMemory, 'search' | 'upsert'>;
  private provider: LLMProvider;
  private config: MemoryConsolidationSchedulerConfig;

  constructor(
    pinecone: Pick<PineconeMemory, 'search' | 'upsert'>,
    provider: LLMProvider,
    config: MemoryConsolidationSchedulerConfig,
  ) {
    this.pinecone = pinecone;
    this.provider = provider;
    this.config = config;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.runScheduled('immediate');
    this.timer = setInterval(() => {
      this.runScheduled('periodic');
    }, this.config.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const activeRun = this.activeRun;
    if (!activeRun) return;

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const drained = Symbol('drained');
    const timedOut = Symbol('timedOut');
    const result = await Promise.race([
      activeRun.then(() => drained),
      new Promise<typeof timedOut>((resolve) => {
        timeout = setTimeout(() => resolve(timedOut), timeoutMs);
        timeout.unref?.();
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });

    if (result === timedOut) {
      log.warn({ timeoutMs }, 'memory consolidation: active run still draining after stop timeout');
    }
  }

  async runOnce(): Promise<void> {
    if (this.running) {
      log.warn('memory consolidation: previous run still active; skipping');
      return;
    }
    this.running = true;
    try {
      const report = await runConsolidation(this.pinecone, this.provider, {
        lookbackDays: this.config.lookbackDays,
        dryRun: this.config.dryRun,
      });
      log.info(report, 'memory consolidation: run complete');
    } finally {
      this.running = false;
    }
  }

  private runScheduled(kind: 'immediate' | 'periodic'): void {
    if (this.stopped) return;
    if (this.running) {
      log.warn('memory consolidation: previous run still active; skipping');
      return;
    }

    const activeRun = this.runOnce().catch((err) => {
      log.error({ err }, `memory consolidation: ${kind} run failed`);
    });
    this.activeRun = activeRun;
    activeRun.finally(() => {
      if (this.activeRun === activeRun) this.activeRun = null;
    });
  }
}
