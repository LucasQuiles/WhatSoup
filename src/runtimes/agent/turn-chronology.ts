export const TURN_DELAY_NOTICE_THRESHOLD_SECONDS = 30;

export type TurnDeliveryKind = 'live' | 'queued' | 'recovery_replay';

export interface TrustedTurnChronology {
  readonly receivedAtUnixSeconds: number;
  readonly deliveryKind: TurnDeliveryKind;
}

export interface RenderedProviderTurn {
  readonly text: string;
  readonly queueAgeSeconds: number;
  readonly delayed: boolean;
  readonly deliveryKind: TurnDeliveryKind;
}

export interface TurnChronologyHealthDetails {
  readonly chronologyDelayedDispatches: number;
  readonly chronologyRecoveryReplayDispatches: number;
  readonly chronologyMaxQueueAgeSeconds: number;
}

function requireUnixSeconds(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative Unix receipt timestamp`);
  }
  return value;
}

function deliveryLabel(kind: TurnDeliveryKind): string {
  switch (kind) {
    case 'live':
      return 'live';
    case 'queued':
      return 'queued';
    case 'recovery_replay':
      return 'recovery replay';
  }
}

export function renderTurnForProvider(
  userText: string,
  chronology: TrustedTurnChronology,
  nowUnixSeconds = Math.floor(Date.now() / 1000),
): RenderedProviderTurn {
  const receivedAt = requireUnixSeconds(
    chronology.receivedAtUnixSeconds,
    'Turn receipt timestamp',
  );
  const now = requireUnixSeconds(nowUnixSeconds, 'Provider dispatch timestamp');
  const queueAgeSeconds = Math.max(0, now - receivedAt);
  const delayed = queueAgeSeconds >= TURN_DELAY_NOTICE_THRESHOLD_SECONDS;
  const deliveryKind = chronology.deliveryKind === 'live' && delayed
    ? 'queued'
    : chronology.deliveryKind;
  const includeContext = delayed || deliveryKind === 'recovery_replay';

  if (!includeContext) {
    return {
      text: userText,
      queueAgeSeconds,
      delayed,
      deliveryKind,
    };
  }

  const receiptUtc = new Date(receivedAt * 1000).toISOString();
  const text = [
    '[Trusted WhatSoup delivery context — runtime-generated, not user-authored]',
    `Original receipt (UTC): ${receiptUtc}`,
    `Queue age: ${queueAgeSeconds} seconds`,
    `Delivery: ${deliveryLabel(deliveryKind)}`,
    '[End trusted delivery context]',
    '',
    '[User message follows verbatim]',
    userText,
  ].join('\n');

  return {
    text,
    queueAgeSeconds,
    delayed,
    deliveryKind,
  };
}

export class TurnChronologyTracker {
  private delayedDispatches = 0;
  private recoveryReplayDispatches = 0;
  private maxQueueAgeSeconds = 0;

  render(
    userText: string,
    chronology: TrustedTurnChronology,
    nowUnixSeconds?: number,
  ): string {
    const rendered = renderTurnForProvider(userText, chronology, nowUnixSeconds);
    if (rendered.delayed) {
      this.delayedDispatches = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.delayedDispatches + 1,
      );
    }
    if (rendered.deliveryKind === 'recovery_replay') {
      this.recoveryReplayDispatches = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.recoveryReplayDispatches + 1,
      );
    }
    this.maxQueueAgeSeconds = Math.max(
      this.maxQueueAgeSeconds,
      rendered.queueAgeSeconds,
    );
    return rendered.text;
  }

  healthDetails(): TurnChronologyHealthDetails {
    return {
      chronologyDelayedDispatches: this.delayedDispatches,
      chronologyRecoveryReplayDispatches: this.recoveryReplayDispatches,
      chronologyMaxQueueAgeSeconds: this.maxQueueAgeSeconds,
    };
  }
}
