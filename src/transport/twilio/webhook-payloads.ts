// src/transport/twilio/webhook-payloads.ts
// ⚠️ Field names (MessageSid, From, …) are Twilio's external webhook contract —
// NOT typed in the SDK. Verify against Twilio REST docs before live use (plan T12).
import type { InboundSms } from './port.ts';

export type ParseResult<T> = { ok: true } & T | { ok: false; reason: string };

export function parseInboundSmsWebhook(
  body: Record<string, string>,
  receivedAt: Date,
): ParseResult<{ record: InboundSms }> {
  for (const f of ['MessageSid', 'From', 'To'] as const) {
    if (!body[f]) return { ok: false, reason: `missing ${f}` };
  }
  return {
    ok: true,
    record: {
      sid: body.MessageSid, from: body.From, to: body.To,
      body: body.Body ?? '', sentAt: receivedAt, fromMe: false,
      status: body.SmsStatus,
    },
  };
}

export interface TranscriptDelivery {
  readonly text: string;
  readonly recordingSid: string;
  readonly recordingUrl?: string;
  readonly callSid: string;
  readonly from: string;
  readonly to: string;
}

export function parseTranscriptionCallback(
  body: Record<string, string>,
): ParseResult<{ transcript: TranscriptDelivery }> {
  if (body.TranscriptionStatus !== 'completed') {
    return { ok: false, reason: `transcription status ${body.TranscriptionStatus ?? 'missing'}` };
  }
  for (const f of ['RecordingSid', 'CallSid', 'From', 'To'] as const) {
    if (!body[f]) return { ok: false, reason: `missing ${f}` };
  }
  return {
    ok: true,
    transcript: {
      text: body.TranscriptionText ?? '',
      recordingSid: body.RecordingSid, recordingUrl: body.RecordingUrl,
      callSid: body.CallSid, from: body.From, to: body.To,
    },
  };
}
