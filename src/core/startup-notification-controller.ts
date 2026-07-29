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
  private timer: unknown | null = null;
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

    if (input.intentionalRestartReceipt) {
      this.schedulePrompt(async () => {
        this.settleGenericBoots();
        await this.submit(
          input.intentionalRestartReceipt!.chatJid,
          input.intentionalRestartReceipt!.text,
          { replayPolicy: 'unsafe', opType: 'status_ping' },
        );
      });
      return;
    }

    if (input.event) {
      switch (input.event.kind) {
        case 'resume':
          this.schedulePrompt(async () => {
            this.settleGenericBoots();
            await this.submit(input.event!.chatJid, input.event!.text, { replayPolicy: 'safe' });
          });
          return;
        case 'restart_loop_guard_alert':
          this.schedulePrompt(() => this.submit(
            input.event!.chatJid,
            input.event!.text,
            { replayPolicy: 'unsafe', opType: 'status_ping' },
          ));
          return;
        case 'expired_session_notice':
          this.schedulePrompt(() => this.submit(
            input.event!.chatJid,
            input.event!.text,
            { replayPolicy: 'safe' },
          ));
          return;
      }
    }

    if (!input.generic) return;
    this.scheduleWhenReady(
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
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
    this.state = 'stopped';
  }

  getHealthSnapshot(): StartupNotificationControllerHealth {
    return {
      state: this.state,
      timerArmed: this.timer !== null,
      journalStatus: this.journalStatus,
      settlement: this.settlement,
    };
  }

  private schedulePrompt(run: () => Promise<void>): void {
    this.scheduleWhenReady(MINIMUM_DELAY_MS, run);
  }

  private scheduleWhenReady(delayMs: number, run: () => Promise<void>): void {
    const delay = Math.max(delayMs, MINIMUM_DELAY_MS);
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.state = 'waiting';
    this.timer = this.scheduler.setTimeout(async () => {
      this.timer = null;
      if (this.stopped) return;
      if (!this.connection.isFullyConnected()) {
        this.scheduleWhenReady(delay, run);
        return;
      }
      await run();
    }, delay);
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
