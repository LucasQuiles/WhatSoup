// src/transport/twilio/twilio-port.ts
// Real SDK-backed implementation of TwilioSmsPort.
// The Twilio SDK client is lazily initialised on first use; the auth token is
// resolved from the keyring at that point and is never logged or included in
// error messages.

import type { TwilioSmsConfig } from './types.ts';
import type { InboundSms, SendSmsArgs, TwilioPortError, TwilioSmsPort } from './port.ts';
import { lookupCredential } from '../../lib/keyring.ts';

// ---------------------------------------------------------------------------
// Narrow duck-type interfaces for the SDK client surface.
// We bind to these instead of the real Twilio types so that:
//   (a) ESM/CJS interop friction is contained here, and
//   (b) tests can inject a plain object without importing the SDK.
// ---------------------------------------------------------------------------

interface AccountContextLike {
  fetch(): Promise<unknown>;
}

interface AccountListLike {
  (sid: string): AccountContextLike;
}

interface MessageInstanceLike {
  sid: string;
  from: string;
  to: string;
  body: string;
  direction: string;
  dateSent: Date;
  dateCreated: Date;
  status: string;
}

interface MessageListLike {
  create(params: {
    to: string;
    body: string;
    from?: string;
    messagingServiceSid?: string;
  }): Promise<MessageInstanceLike>;
  list(params: {
    to?: string;
    dateSentAfter?: Date;
    limit?: number;
  }): Promise<MessageInstanceLike[]>;
}

export interface TwilioClientLike {
  api: {
    v2010: {
      accounts: AccountListLike;
    };
  };
  messages: MessageListLike;
}

// ---------------------------------------------------------------------------
// Dependency injection interfaces
// ---------------------------------------------------------------------------

export type ClientFactory = (accountSid: string, authToken: string) => TwilioClientLike | Promise<TwilioClientLike>;

export interface SdkTwilioSmsPortDeps {
  /** Override the real Twilio client constructor (for tests). */
  clientFactory?: ClientFactory;
  /** Override credential lookup (for tests; default: lookupCredential). */
  credentialLookup?: (service: string) => string | null;
}

// ---------------------------------------------------------------------------
// Default client factory — imports the real SDK lazily.
// ---------------------------------------------------------------------------

async function buildRealClient(accountSid: string, authToken: string): Promise<TwilioClientLike> {
  // Dynamic import avoids top-level CJS/ESM issues and keeps the token out of
  // any module-load logging.
  const mod = await import('twilio');
  // The twilio package is CommonJS; with esModuleInterop the default export is
  // the constructor function.
  const TwilioConstructor = (mod as unknown as { default: new (sid: string, token: string) => TwilioClientLike }).default;
  return new TwilioConstructor(accountSid, authToken) as TwilioClientLike;
}

// ---------------------------------------------------------------------------
// Error scrubbing helpers
// ---------------------------------------------------------------------------

/** Remove any token content from a string. */
function scrub(text: string, token: string): string {
  return token ? text.split(token).join('[REDACTED]') : text;
}

/**
 * Rethrow err with {message, code, status} preserved and any token content
 * removed from the message.  The error shape matches TwilioPortError.
 *
 * The ORIGINAL stack is preserved (scrubbed) on the rethrown error so SDK
 * frames remain visible for production debugging. The original error object
 * itself is deliberately NOT attached as `cause` — its unscrubbed message
 * could leak the token through deep logging.
 */
function scrubAndRethrow(err: unknown, token: string): never {
  const raw = err as Record<string, unknown>;
  const rawMsg = typeof raw['message'] === 'string' ? raw['message'] : String(err);
  const safeMsg = scrub(rawMsg, token);
  const code = typeof raw['code'] === 'number' ? raw['code'] : undefined;
  const status = typeof raw['status'] === 'number' ? raw['status'] : undefined;
  const out: TwilioPortError & { code?: number; status?: number } & Error =
    Object.assign(new Error(safeMsg), { code, status } as Partial<TwilioPortError>);
  if (typeof raw['stack'] === 'string') {
    out.stack = scrub(raw['stack'], token);
  }
  throw out;
}

// ---------------------------------------------------------------------------
// SdkTwilioSmsPort
// ---------------------------------------------------------------------------

export class SdkTwilioSmsPort implements TwilioSmsPort {
  private readonly config: TwilioSmsConfig;
  private readonly getCredential: (service: string) => string | null;
  private readonly makeClient: ClientFactory;

  /**
   * Single-flight lazy init: the in-flight (or resolved) init promise.
   * Concurrent first callers share one credential lookup + one client
   * construction. Reset to null on failure so the next call retries —
   * init failures (keyring miss, factory throw) are not cached as permanent.
   */
  private _clientPromise: Promise<TwilioClientLike> | null = null;
  /** Auth token cached alongside the client; used only for scrubbing. */
  private _token = '';

  constructor(config: TwilioSmsConfig, deps: SdkTwilioSmsPortDeps = {}) {
    this.config = config;
    this.getCredential = deps.credentialLookup ?? lookupCredential;
    this.makeClient = deps.clientFactory ?? buildRealClient;
  }

  private client(): Promise<TwilioClientLike> {
    if (this._clientPromise === null) {
      this._clientPromise = this.initClient().catch((err: unknown) => {
        this._clientPromise = null; // allow retry on next call
        throw err;
      });
    }
    return this._clientPromise;
  }

  private async initClient(): Promise<TwilioClientLike> {
    const token = this.getCredential(this.config.authTokenService);
    if (!token) {
      throw Object.assign(
        new Error(
          `Twilio auth token not found in keyring for service "${this.config.authTokenService}"`,
        ),
        { status: 401 } as Partial<TwilioPortError>,
      );
    }
    this._token = token;
    try {
      return await this.makeClient(this.config.accountSid, token);
    } catch (err) {
      // Factory errors must not escape unscrubbed — they ran with the token.
      scrubAndRethrow(err, token);
    }
  }

  // -------------------------------------------------------------------------
  // TwilioSmsPort interface
  // -------------------------------------------------------------------------

  async verifyCredentials(): Promise<void> {
    const c = await this.client();
    try {
      await c.api.v2010.accounts(this.config.accountSid).fetch();
    } catch (err) {
      scrubAndRethrow(err, this._token);
    }
  }

  async sendSms(args: SendSmsArgs): Promise<{ sid: string }> {
    const c = await this.client();
    const params: {
      to: string;
      body: string;
      from?: string;
      messagingServiceSid?: string;
    } = { to: args.to, body: args.body };

    if (args.messagingServiceSid) {
      params.messagingServiceSid = args.messagingServiceSid;
    } else if (args.from) {
      params.from = args.from;
    }

    try {
      const msg = await c.messages.create(params);
      return { sid: msg.sid };
    } catch (err) {
      scrubAndRethrow(err, this._token);
    }
  }

  async listInboundSince(since: Date, pageSize?: number): Promise<readonly InboundSms[]> {
    // Validate pageSize first — never call the client if the arg is invalid.
    if (pageSize !== undefined) {
      if (!Number.isInteger(pageSize) || pageSize <= 0) {
        throw new RangeError(`pageSize must be a positive integer; got ${pageSize}`);
      }
    }

    const c = await this.client();

    // Twilio's DateSent> filter has second-level precision and its boundary
    // semantics are provider-defined. To honour the port's INCLUSIVE contract
    // we subtract 1000ms (one precision unit) from since, then filter
    // client-side with sentAt >= since.
    const dateSentAfter = new Date(since.getTime() - 1000);

    const listParams: {
      to?: string;
      dateSentAfter: Date;
      limit?: number;
    } = { dateSentAfter };

    if (this.config.phoneNumber) {
      listParams.to = this.config.phoneNumber;
    }

    // Over-fetch when a cap is requested: client-side filters (direction,
    // inclusive boundary) can discard records, so a raw limit === pageSize
    // could under-fill the page. 2x is a best-effort buffer, not a guarantee —
    // the port contract makes pageSize an upper bound on the result count,
    // not a promise of a full page.
    if (pageSize !== undefined) {
      listParams.limit = pageSize * 2;
    }

    let raw: MessageInstanceLike[] = [];
    try {
      raw = await c.messages.list(listParams);
    } catch (err) {
      scrubAndRethrow(err, this._token);
    }

    const results: InboundSms[] = raw
      .filter((m) => m.direction === 'inbound')
      .filter((m) => {
        // Use dateSent for inbound messages: per the SDK docs, dateSent for an
        // inbound message is "when Twilio sent the HTTP request to your incoming
        // message webhook URL" — i.e. when Twilio received the SMS.
        // dateCreated is when the Message resource was created in Twilio's
        // system; for inbound messages dateSent is the better receipt proxy.
        const ts = m.dateSent ?? m.dateCreated;
        return ts >= since;
      })
      .map(
        (m): InboundSms => ({
          sid: m.sid,
          from: m.from,
          to: m.to,
          body: m.body,
          sentAt: m.dateSent ?? m.dateCreated,
          status: m.status,
        }),
      );

    // Sort ascending by sentAt (Twilio returns newest-first by default).
    results.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());

    // Slice to pageSize AFTER sort to honour the contract.
    if (pageSize !== undefined) {
      return results.slice(0, pageSize);
    }
    return results;
  }
}
