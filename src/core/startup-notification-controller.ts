import type {
  StartupNotification,
  StartupNotificationSettlement,
  StartupNotifyJournalResult,
} from './startup-notify.ts';

const MINIMUM_DELAY_MS = 3_000;

export type StartupNotificationEvent =
  | {
      kind: 'resume';
      chatJid: string;
      text: string;
    }
  | {
      kind: 'restart_loop_guard_alert';
      chatJid: string;
      text: string;
    }
  | {
      kind: 'expired_session_notice';
      chatJid: string;
      text: string;
    };

export interface StartupNotificationIntentionalRestartReceipt {
  chatJid: string;
  text: string;
}

export interface StartupNotificationClock {
  now(): number;
}

export interface StartupNotificationScheduler {
  setTimeout(callback: () => void | Promise<void>, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Strict readiness is injected from the shared transport connection boundary. */
export interface StartupNotificationConnectionPort {
  isFullyConnected(): boolean;
}

export interface StartupNotificationJournalPort {
  recordStartupBoot(now: number): StartupNotifyJournalResult;
  settleStartupNotification(now: number): StartupNotificationSettlement;
}

export type StartupNotificationSendOptions =
  | { replayPolicy: 'safe' }
  | { replayPolicy: 'unsafe'; opType: 'status_ping' };

/** Submission only: provider delivery remains the transport/durability concern. */
export interface StartupNotificationTrackedSendPort {
  send(chatJid: string, text: string, options: StartupNotificationSendOptions): Promise<unknown>;
}

export interface StartupNotificationControllerOptions {
  clock: StartupNotificationClock;
  scheduler: StartupNotificationScheduler;
  connection: StartupNotificationConnectionPort;
  journal: StartupNotificationJournalPort;
  send: StartupNotificationTrackedSendPort;
}

export interface StartupNotificationGenericPolicy {
  recipient: string;
  stabilityWindowMs: number;
}

export interface StartupNotificationConnectedInput {
  generic: StartupNotificationGenericPolicy | null;
  event: StartupNotificationEvent | null;
  intentionalRestartReceipt: StartupNotificationIntentionalRestartReceipt | null;
}

export interface StartupNotificationControllerHealth {
  state: 'idle' | 'waiting' | 'settled' | 'sent' | 'send_failed' | 'stopped';
  timerArmed: boolean;
  journalStatus: 'available' | 'journal_unreadable';
  settlement: 'not_attempted' | 'not_needed' | 'durably_settled' | 'not_durable';
}

/**
 * Owns the process-local startup-notification lifecycle. It intentionally has
 * no knowledge of service managers, databases, provider bridges, or JID
 * formatting; composition provides the narrow ports it needs instead.
 */
export class StartupNotificationController {
  private readonly clock: StartupNotificationClock;
  private readonly scheduler: StartupNotificationScheduler;
  private readonly connection: StartupNotificationConnectionPort;
  private readonly journal: StartupNotificationJournalPort;
  private readonly send: StartupNotificationTrackedSendPort;
  private genericTimer: unknown | null = null;
  private readonly promptTimers = new Set<unknown>();
  private stopped = false;
  private state: StartupNotificationControllerHealth['state'] = 'idle';
  private journalStatus: StartupNotificationControllerHealth['journalStatus'] = 'available';
  private settlement: StartupNotificationControllerHealth['settlement'] = 'not_attempted';

  constructor(options: StartupNotificationControllerOptions) {
    this.clock = options.clock;
    this.scheduler = options.scheduler;
    this.connection = options.connection;
    this.journal = options.journal;
    this.send = options.send;
  }

  /** Records the process boot once at the earliest composition-owned point. */
  recordStartupBoot(): void {
    if (this.stopped) return;
    const result = this.journal.recordStartupBoot(this.clock.now());
    this.journalStatus = result.status;
  }

  /** Called once the application has completed its normal connection startup. */
  onConnected(input: StartupNotificationConnectedInput): void {
    if (this.stopped) return;

    const { event, intentionalRestartReceipt } = input;
    const promptSettlesBatch = intentionalRestartReceipt !== null || event?.kind === 'resume';
    if (event || intentionalRestartReceipt) {
      // A typed event is never discarded because a receipt also exists. Prompt
      // delivery keeps the event first (the former main.ts insertion order).
      // Resume and receipt each settle the boot batch; guard/expiry do not, so
      // they retain a separate configured generic stability timer when alone.
      this.schedulePrompt(async () => {
        if (promptSettlesBatch) this.settleGenericBoots();
        if (event) await this.submitEvent(event);
        if (intentionalRestartReceipt) {
          await this.submit(
            intentionalRestartReceipt.chatJid,
            intentionalRestartReceipt.text,
            { replayPolicy: 'unsafe', opType: 'status_ping' },
          );
        }
      });
      if (!promptSettlesBatch && input.generic) {
        this.scheduleGeneric(input.generic.stabilityWindowMs, async () => {
          const notification = this.settleGenericBoots();
          if (notification) {
            await this.submit(
              input.generic!.recipient,
              notification.text,
              { replayPolicy: 'unsafe', opType: 'status_ping' },
            );
          }
        });
      }
      return;
    }

    if (!input.generic) return;
    this.scheduleGeneric(
      input.generic.stabilityWindowMs,
      async () => {
        const notification = this.settleGenericBoots();
        if (notification) {
          await this.submit(
            input.generic!.recipient,
            notification.text,
            { replayPolicy: 'unsafe', opType: 'status_ping' },
          );
        }
      },
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.genericTimer !== null) {
      this.scheduler.clearTimeout(this.genericTimer);
      this.genericTimer = null;
    }
    for (const timer of this.promptTimers) {
      this.scheduler.clearTimeout(timer);
    }
    this.promptTimers.clear();
    this.state = 'stopped';
  }

  getHealthSnapshot(): StartupNotificationControllerHealth {
    return {
      state: this.state,
      timerArmed: this.genericTimer !== null || this.promptTimers.size > 0,
      journalStatus: this.journalStatus,
      settlement: this.settlement,
    };
  }

  private schedulePrompt(run: () => Promise<void>): void {
    this.state = 'waiting';
    let timer: unknown;
    timer = this.scheduler.setTimeout(async () => {
      this.promptTimers.delete(timer);
      if (this.stopped) return;
      if (!this.connection.isFullyConnected()) {
        this.schedulePrompt(run);
        return;
      }
      await run();
    }, MINIMUM_DELAY_MS);
    this.promptTimers.add(timer);
  }

  private scheduleGeneric(delayMs: number, run: () => Promise<void>): void {
    const delay = Math.max(delayMs, MINIMUM_DELAY_MS);
    if (this.genericTimer !== null) this.scheduler.clearTimeout(this.genericTimer);
    this.state = 'waiting';
    this.genericTimer = this.scheduler.setTimeout(async () => {
      this.genericTimer = null;
      if (this.stopped) return;
      if (!this.connection.isFullyConnected()) {
        this.scheduleGeneric(delay, run);
        return;
      }
      await run();
    }, delay);
  }

  private submitEvent(event: StartupNotificationEvent): Promise<void> {
    switch (event.kind) {
      case 'resume':
      case 'expired_session_notice':
        return this.submit(event.chatJid, event.text, { replayPolicy: 'safe' });
      case 'restart_loop_guard_alert':
        return this.submit(event.chatJid, event.text, { replayPolicy: 'unsafe', opType: 'status_ping' });
    }
  }

  private settleGenericBoots(): StartupNotification | null {
    const result = this.journal.settleStartupNotification(this.clock.now());
    this.journalStatus = result.status;
    if (!result.notification) {
      this.settlement = 'not_needed';
      this.state = 'settled';
      return null;
    }
    this.settlement = result.watermarkPersisted ? 'durably_settled' : 'not_durable';
    this.state = 'settled';
    return result.notification;
  }

  private async submit(
    chatJid: string,
    text: string,
    options: StartupNotificationSendOptions,
  ): Promise<void> {
    try {
      await this.send.send(chatJid, text, options);
      if (!this.stopped) this.state = 'sent';
    } catch {
      if (!this.stopped) this.state = 'send_failed';
    }
  }
}
