// src/transport/twilio/twilio-port.ts
// Real SDK-backed implementation of TwilioSmsPort.
// The Twilio SDK client is lazily initialised on first use; the auth token is
// resolved from the keyring at that point and is never logged or included in
// error messages.

import type { TwilioSmsConfig } from './types.ts';
import type { InboundSms, PlaceCallArgs, SendSmsArgs, TwilioPortError, TwilioSmsPort } from './port.ts';
import { lookupCredential } from '../../lib/keyring.ts';
import { twilioAuthTokenServiceForAccount } from '../../lib/twilio-config.ts';

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
    from?: string;
    dateSentAfter?: Date;
    limit?: number;
  }): Promise<MessageInstanceLike[]>;
}

interface CallInstanceLike {
  sid: string;
  status: string;
}

interface CallListLike {
  create(params: {
    to: string;
    from?: string;
    twiml?: string;
    statusCallback?: string;
  }): Promise<CallInstanceLike>;
}

export interface TwilioClientLike {
  api: {
    v2010: {
      accounts: AccountListLike;
    };
  };
  messages: MessageListLike;
  calls: CallListLike;
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
  private readonly authTokenService: string;
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
    const expectedAuthTokenService = twilioAuthTokenServiceForAccount(config.account);
    if (expectedAuthTokenService === null) {
      throw new Error(`Twilio account must be a valid account segment and immutable line identity: ${config.account}`);
    }
    if (config.authTokenService !== expectedAuthTokenService) {
      throw new Error(
        `Twilio authTokenService must be ${expectedAuthTokenService} for account ${config.account}`,
      );
    }
    this.config = { ...config };
    this.authTokenService = expectedAuthTokenService;
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
    const token = this.getCredential(this.authTokenService);
    if (!token) {
      throw Object.assign(
        new Error(
          `Twilio auth token not found in keyring for service "${this.authTokenService}"`,
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

    // Over-fetch when a cap is requested: client-side filters (direction,
    // inclusive boundary) can discard records, so a raw limit === pageSize
    // could under-fill the page. 2x is a best-effort buffer, not a guarantee —
    // the port contract makes pageSize an upper bound on the result count,
    // not a promise of a full page.
    const limitPerCall = pageSize !== undefined ? pageSize * 2 : undefined;

    let rawInbound: MessageInstanceLike[] = [];
    let rawOutbound: MessageInstanceLike[] = [];

    if (this.config.phoneNumber) {
      // When phoneNumber is configured we make TWO SDK calls:
      //   1. {to: phoneNumber}   — messages sent TO our number (inbound from peers)
      //   2. {from: phoneNumber} — messages sent FROM our number (our outbound)
      // Outbound messages cannot be fetched with a `to=ourNumber` filter because
      // for those records, `to` is the remote peer's number, not ours.
      // Both calls are issued in parallel for efficiency.
      const inboundParams: Parameters<MessageListLike['list']>[0] = {
        to: this.config.phoneNumber,
        dateSentAfter,
        ...(limitPerCall !== undefined ? { limit: limitPerCall } : {}),
      };
      const outboundParams: Parameters<MessageListLike['list']>[0] = {
        from: this.config.phoneNumber,
        dateSentAfter,
        ...(limitPerCall !== undefined ? { limit: limitPerCall } : {}),
      };

      try {
        [rawInbound, rawOutbound] = await Promise.all([
          c.messages.list(inboundParams),
          c.messages.list(outboundParams),
        ]);
      } catch (err) {
        scrubAndRethrow(err, this._token);
      }
    } else {
      // messagingServiceSid-only config: single unfiltered call (no phoneNumber
      // to filter on). This returns all messages on the account. The fromMe
      // field is still derived from direction, but the call is coarser.
      const listParams: Parameters<MessageListLike['list']>[0] = {
        dateSentAfter,
        ...(limitPerCall !== undefined ? { limit: limitPerCall } : {}),
      };
      try {
        rawInbound = await c.messages.list(listParams);
      } catch (err) {
        scrubAndRethrow(err, this._token);
      }
      rawOutbound = [];
    }

    // Map direction → fromMe.
    // Directions: 'inbound' | 'outbound-api' | 'outbound-call' | 'outbound-reply'
    // Any direction starting with 'outbound' is our own message; drop anything
    // that is neither (defensive — should not occur in practice).
    const directionToFromMe = (direction: string): boolean | null => {
      if (direction === 'inbound') return false;
      if (direction.startsWith('outbound')) return true;
      return null; // unknown direction — skip
    };

    // Use dateSent for the inclusive client-side filter. For inbound messages
    // dateSent is "when Twilio sent the webhook request" — the best receipt
    // proxy. For outbound messages dateSent is when the message was sent.
    // Fall back to dateCreated when dateSent is absent.
    const mapRecord = (m: MessageInstanceLike): InboundSms | null => {
      const fromMe = directionToFromMe(m.direction);
      if (fromMe === null) return null; // skip non-message directions
      const ts = m.dateSent ?? m.dateCreated;
      if (ts < since) return null; // client-side inclusive boundary enforcement
      return {
        sid: m.sid,
        from: m.from,
        to: m.to,
        body: m.body,
        sentAt: ts,
        fromMe,
        status: m.status,
      };
    };

    // Merge both arrays, map, drop nulls, dedupe by SID (the two API calls
    // can theoretically overlap under race conditions).
    const seen = new Set<string>();
    const results: InboundSms[] = [];
    for (const batch of [rawInbound, rawOutbound]) {
      for (const m of batch) {
        if (seen.has(m.sid)) continue;
        seen.add(m.sid);
        const mapped = mapRecord(m);
        if (mapped !== null) results.push(mapped);
      }
    }

    // Sort ascending by sentAt (Twilio returns newest-first by default).
    results.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());

    // Slice to pageSize AFTER sort to honour the contract.
    if (pageSize !== undefined) {
      return results.slice(0, pageSize);
    }
    return results;
  }

  async placeCall(args: PlaceCallArgs): Promise<{ sid: string; status: string }> {
    const c = await this.client();
    try {
      const call = await c.calls.create({
        to: args.to,
        from: args.from,
        twiml: args.twiml,
        statusCallback: args.statusCallback,
      });
      return { sid: call.sid, status: call.status };
    } catch (err) {
      scrubAndRethrow(err, this._token);
    }
  }
}
