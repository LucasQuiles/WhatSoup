import type { Severity } from '../types.ts';

export interface AlertPayload {
  body: string;
  severity?: Severity;
}

export interface DeliveryResult {
  ok: boolean;
  channel: string;
  error?: string;
}

export interface Sink {
  readonly name: string;
  readonly isDurableLog: boolean;
  deliver(payload: AlertPayload): Promise<DeliveryResult>;
}
