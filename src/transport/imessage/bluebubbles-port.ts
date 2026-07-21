// src/transport/imessage/bluebubbles-port.ts
// Concrete ImessagePort against a BlueBubbles Server's REST API.
//
// BlueBubbles Server (https://bluebubbles.app) fronts a Mac signed into
// iMessage with an HTTP API. Auth is a pre-shared password sent as the
// `password` query param on every call (the Server's documented scheme).
//
// Design notes:
// - The HTTP layer is an injectable seam (BlueBubblesHttpClient) so tests
//   run the full port logic against a scripted client with no network —
//   the same duck-type pattern as the Twilio SDK port and the signal-cli
//   RPC seam.
// - The production client uses undici (already a repo dependency).
// - The password is resolved by the FACTORY from the keyring
//   (bluebubblesPasswordService) and handed to the port as
//   bluebubblesPassword; the port never reads the keyring and never logs
//   the credential (mirrors twilio-port.ts).
// - Errors surface as ImessagePortError-shaped plain objects; the ADAPTER
//   maps them to typed TransportError subclasses.

import { request } from 'undici';
import type { ImessageConfig } from './types.ts';
import type {
  ImessagePort,
  ImessagePortError,
  InboundImessage,
  ReactImessageArgs,
  SendImessageArgs,
  SendReadReceiptArgs,
  SendTypingArgs,
} from './port.ts';

// ---------------------------------------------------------------------------
// Injectable HTTP seam
// ---------------------------------------------------------------------------

export interface BlueBubblesHttpRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
  /** Path WITHOUT the /api/v1 prefix (e.g. '/ping', '/message/text'). */
  readonly path: string;
  /** JSON body for POST requests. */
  readonly body?: Record<string, unknown>;
}

/** Minimal HTTP client: performs one request, resolves with the parsed JSON
 *  body, rejects with an ImessagePortError-shaped object on non-2xx,
 *  transport error, or malformed JSON. */
export type BlueBubblesHttpClient = (req: BlueBubblesHttpRequest) => Promise<unknown>;

const HTTP_TIMEOUT_MS = 30_000;

/** Production client over undici. Password travels as the `password` query
 *  param per BlueBubbles' documented auth scheme; it is never logged. */
export function createHttpClient(config: ImessageConfig): BlueBubblesHttpClient {
  const baseUrl = (config.bluebubblesUrl ?? '').replace(/\/+$/, '');
  const password = config.bluebubblesPassword ?? '';
  return async (req) => {
    const sep = req.path.includes('?') ? '&' : '?';
    const url = `${baseUrl}/api/v1${req.path}${sep}password=${encodeURIComponent(password)}`;
    let response;
    try {
      response = await request(url, {
        method: req.method,
        headers: req.body !== undefined ? { 'content-type': 'application/json' } : {},
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        headersTimeout: HTTP_TIMEOUT_MS,
        bodyTimeout: HTTP_TIMEOUT_MS,
      });
    } catch (err) {
      throw {
        message: `bluebubbles HTTP error: ${(err as Error).message}`,
        code: 'TransportError',
        status: 503,
      } satisfies ImessagePortError;
    }
    const text = await response.body.text();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw {
        message: `bluebubbles ${req.method} ${req.path} failed: HTTP ${response.statusCode}`,
        code: 'HttpError',
        status: response.statusCode,
      } satisfies ImessagePortError;
    }
    if (text === '') return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw {
        message: `bluebubbles ${req.method} ${req.path} returned malformed JSON`,
        code: 'MalformedResponse',
        status: 502,
      } satisfies ImessagePortError;
    }
  };
}

// ---------------------------------------------------------------------------
// BlueBubbles shape mapping
// ---------------------------------------------------------------------------

/** BlueBubbles message record (fields the port consumes). */
interface BbMessage {
  guid?: string;
  text?: string | null;
  isFromMe?: boolean;
  handle?: { address?: string } | null;
  chats?: Array<{ guid?: string }>;
  dateCreated?: number;
  itemType?: number;
}

/** iMessage tapback emoji → BlueBubbles reactionType. Removal prefixes '-'. */
const EMOJI_TO_REACTION_TYPE: Readonly<Record<string, string>> = Object.freeze({
  '👍': 'like',
  '❤️': 'love',
  '👎': 'dislike',
  '😂': 'laugh',
  '‼️': 'emphasize',
  '❓': 'question',
});

/** Chat GUID for a 1:1 conversation with an address (BlueBubbles format). */
function dmChatGuid(address: string): string {
  return `iMessage;-;${address}`;
}

function normalizeMessage(msg: BbMessage): InboundImessage | null {
  if (typeof msg.guid !== 'string' || msg.guid === '') return null;
  const groupGuid = msg.chats?.[0]?.guid;
  const isGroup = typeof groupGuid === 'string' && groupGuid.startsWith('iMessage;+;');
  const from = msg.isFromMe === true ? '' : (msg.handle?.address ?? 'unknown');
  return {
    guid: msg.guid,
    from,
    to: isGroup ? groupGuid! : (msg.handle?.address ?? ''),
    chatGuid: isGroup ? groupGuid : undefined,
    body: typeof msg.text === 'string' ? msg.text : null,
    fromMe: msg.isFromMe === true,
    kind: msg.text !== null && msg.text !== undefined ? 'text' : 'other',
    timestamp: typeof msg.dateCreated === 'number' ? msg.dateCreated : 0,
  };
}

// ---------------------------------------------------------------------------
// Port implementation
// ---------------------------------------------------------------------------

export class BlueBubblesPort implements ImessagePort {
  private readonly config: ImessageConfig;
  private readonly http: BlueBubblesHttpClient;

  // Explicit fields + assignment rather than constructor parameter properties:
  // this repo runs Node's --experimental-strip-types (no build step), which
  // rejects parameter properties (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  constructor(
    config: ImessageConfig,
    http: BlueBubblesHttpClient = createHttpClient(config),
  ) {
    this.config = config;
    this.http = http;
  }

  async verifyCredentials(): Promise<void> {
    await this.http({ method: 'GET', path: '/ping' });
  }

  async send(args: SendImessageArgs): Promise<{ guid: string }> {
    const isGroup = args.recipient.startsWith('iMessage;');
    const chatGuid = isGroup ? args.recipient : dmChatGuid(args.recipient);
    const body: Record<string, unknown> = { chatGuid, message: args.body };
    if (args.subject !== undefined) body.subject = args.subject;
    const result = await this.http({ method: 'POST', path: '/message/text', body }) as
      | { data?: { guid?: string } }
      | undefined;
    const guid = result?.data?.guid;
    if (typeof guid !== 'string' || guid === '') {
      throw {
        message: 'bluebubbles send returned no message guid',
        code: 'MalformedResponse',
        status: 502,
      } satisfies ImessagePortError;
    }
    return { guid };
  }

  async listInboundSince(since: Date, pageSize?: number): Promise<readonly InboundImessage[]> {
    if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize <= 0)) {
      throw new RangeError(`pageSize must be a positive integer, got ${pageSize}`);
    }
    const result = await this.http({
      method: 'POST',
      path: '/message/query',
      body: {
        limit: pageSize ?? 100,
        offset: 0,
        sort: 'ASC',
        after: since.getTime(),
        with: ['chats', 'handle'],
      },
    }) as { data?: BbMessage[] } | undefined;

    const sinceMs = since.getTime();
    const out: InboundImessage[] = [];
    for (const raw of result?.data ?? []) {
      const normalized = normalizeMessage(raw);
      if (!normalized) continue;
      // Inclusive boundary: at-least-once delivery; callers dedupe by guid.
      if (normalized.timestamp < sinceMs) continue;
      out.push(normalized);
    }
    // Sort BEFORE capping: the contract is ascending-by-timestamp, so the
    // pageSize cap must keep the OLDEST messages, not the first-arriving.
    out.sort((a, b) => a.timestamp - b.timestamp);
    return pageSize !== undefined ? out.slice(0, pageSize) : out;
  }

  async sendReaction(args: ReactImessageArgs): Promise<void> {
    const reactionType = EMOJI_TO_REACTION_TYPE[args.emoji];
    if (reactionType === undefined) {
      throw {
        message: `unsupported tapback emoji ${JSON.stringify(args.emoji)} (imessage supports 👍👎❤️‼️❓😂)`,
        code: 'BadArgs',
        status: 400,
      } satisfies ImessagePortError;
    }
    await this.http({
      method: 'POST',
      path: '/message/react',
      body: {
        chatGuid: args.conversation.startsWith('iMessage;') ? args.conversation : dmChatGuid(args.conversation),
        selectedMessageGuid: args.targetGuid,
        reactionType: args.remove ? `-${reactionType}` : reactionType,
      },
    });
  }

  async sendReadReceipts(args: SendReadReceiptArgs): Promise<void> {
    const chatGuid = args.conversation.startsWith('iMessage;') ? args.conversation : dmChatGuid(args.conversation);
    await this.http({
      method: 'POST',
      path: `/chat/${encodeURIComponent(chatGuid)}/read`,
      body: { messageGuids: [...args.guids] },
    });
  }

  async sendTypingIndicator(args: SendTypingArgs): Promise<void> {
    const chatGuid = args.conversation.startsWith('iMessage;') ? args.conversation : dmChatGuid(args.conversation);
    await this.http({
      method: args.composing ? 'POST' : 'DELETE',
      path: `/chat/${encodeURIComponent(chatGuid)}/typing`,
    });
  }
}
