// src/transport/twilio/webhook-server.ts
// TwilioWebhookServer — signature-validated HTTP listener translating Twilio POSTs
// into typed records for the adapter's shared inbound pipeline.
//
// Design constraints:
//   - node:http only; no Express or other framework.
//   - Binds to listenAddress (default 127.0.0.1); operator fronts with a
//     proxy/tunnel matching publicBaseUrl.
//   - Signature validation uses the SDK's validateRequest with the FULL
//     public URL (not the local listen address).
//   - Body capped at 64 KiB; over-cap requests get 413.
//   - All rejections are fail-closed (no body contents, no token in logs).
import * as http from 'node:http';
import twilio from 'twilio';
import { createChildLogger } from '../../logger.ts';
import type { TwilioVoiceConfig } from './types.ts';
import type { InboundSms } from './port.ts';
import type { TranscriptDelivery } from './webhook-payloads.ts';
import { parseInboundSmsWebhook, parseTranscriptionCallback } from './webhook-payloads.ts';

const { validateRequest } = twilio;

const log = createChildLogger('twilio-webhook');

const BODY_SIZE_CAP = 64 * 1024; // 64 KiB

const DEFAULT_VOICEMAIL_GREETING = 'Please leave a message after the beep.';

// Known POST routes
const KNOWN_ROUTES = new Set(['/twilio/sms', '/twilio/voice', '/twilio/voice/transcription']);

export interface TwilioWebhookServerOptions {
  getAuthToken: () => string | null;
  publicBaseUrl: string;
  listenPort: number;
  listenAddress?: string;
  voice: TwilioVoiceConfig;
  onSms: (r: InboundSms) => void;
  onTranscript: (t: TranscriptDelivery) => void;
}

export class TwilioWebhookServer {
  private readonly opts: TwilioWebhookServerOptions;
  private server: http.Server | null = null;

  constructor(opts: TwilioWebhookServerOptions) {
    this.opts = opts;
  }

  /** Start listening. Returns the bound port number (useful when listenPort: 0). */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      server.on('error', reject);
      const address = this.opts.listenAddress ?? '127.0.0.1';
      server.listen(this.opts.listenPort, address, () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('unexpected server address'));
          return;
        }
        this.server = server;
        resolve(addr.port);
      });
    });
  }

  /** Stop the server and wait for all connections to close. */
  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server === null) { resolve(); return; }
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
      this.server = null;
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? '/';

    // Method guard: GET on a known route → 405; unknown route → 404
    if (req.method !== 'POST') {
      if (KNOWN_ROUTES.has(url)) {
        res.writeHead(405, { Allow: 'POST' }).end();
      } else {
        res.writeHead(404).end();
      }
      return;
    }

    // Route guard: unknown POST path
    if (!KNOWN_ROUTES.has(url)) {
      res.writeHead(404).end();
      return;
    }

    // Read body with size cap
    let rawBody: string;
    try {
      rawBody = await this.readBody(req);
    } catch (err) {
      const code = (err as { code?: string }).code === 'BODY_TOO_LARGE' ? 413 : 400;
      res.writeHead(code).end();
      return;
    }

    const params = Object.fromEntries(new URLSearchParams(rawBody));

    // Signature gate
    const token = this.opts.getAuthToken();
    if (token === null) {
      log.warn({ path: url }, 'twilio-webhook: auth token unavailable, rejecting 503');
      res.writeHead(503).end();
      return;
    }

    const sig = (req.headers['x-twilio-signature'] as string | undefined) ?? '';
    const fullUrl = this.opts.publicBaseUrl + url;

    if (!sig || !validateRequest(token, sig, fullUrl, params)) {
      log.warn({ path: url }, 'twilio-webhook: signature validation failed, rejecting 403');
      res.writeHead(403).end();
      return;
    }

    // Route dispatch
    if (url === '/twilio/sms') {
      this.handleSms(params, res);
    } else if (url === '/twilio/voice') {
      this.handleVoice(params, res);
    } else if (url === '/twilio/voice/transcription') {
      this.handleTranscription(params, res);
    } else {
      res.writeHead(404).end();
    }
  }

  private handleSms(params: Record<string, string>, res: http.ServerResponse): void {
    const result = parseInboundSmsWebhook(params, new Date());
    if (!result.ok) {
      log.warn({ reason: result.reason }, 'twilio-webhook: sms parse failed');
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end(result.reason);
      return;
    }
    this.opts.onSms(result.record);
    res.writeHead(204).end();
  }

  private handleVoice(_params: Record<string, string>, res: http.ServerResponse): void {
    // Import VoiceResponse from twilio default export
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const vr = new VoiceResponse();
    const voice = this.opts.voice;

    if (!voice.enabled) {
      vr.reject();
    } else {
      vr.say(voice.voicemailGreeting ?? DEFAULT_VOICEMAIL_GREETING);
      vr.record({
        transcribe: true,
        transcribeCallback: `${this.opts.publicBaseUrl}/twilio/voice/transcription`,
        maxLength: voice.voicemailMaxLengthSec,
        playBeep: true,
      });
    }

    const xml = vr.toString();
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' }).end(xml);
  }

  private handleTranscription(params: Record<string, string>, res: http.ServerResponse): void {
    const result = parseTranscriptionCallback(params);
    if (result.ok) {
      this.opts.onTranscript(result.transcript);
    } else {
      // Log the reason but always ack 204 — Twilio retries non-2xx
      log.info({ reason: result.reason }, 'twilio-webhook: transcription not forwarded');
    }
    res.writeHead(204).end();
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;

      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > BODY_SIZE_CAP) {
          req.destroy();
          const err = Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' });
          reject(err);
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'));
      });

      req.on('error', reject);
    });
  }
}
