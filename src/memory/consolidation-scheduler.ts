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

  constructor(
    private readonly pinecone: Pick<PineconeMemory, 'search' | 'upsert'>,
    private readonly provider: LLMProvider,
    private readonly config: MemoryConsolidationSchedulerConfig,
  ) {}

  start(): void {
    if (this.timer) return;
    this.runOnce().catch((err) => log.error({ err }, 'memory consolidation: immediate run failed'));
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => log.error({ err }, 'memory consolidation: periodic run failed'));
    }, this.config.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
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
}
