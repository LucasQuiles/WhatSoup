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
import { isImessageGroupAddress } from '../../core/transport-refs.ts';
import type { ImessageConfig } from './types.ts';
import type {
  ImessagePort,
  ImessagePortError,
  InboundImessage,
  InboundImessagePage,
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
  originalROWID?: number;
  guid?: string;
  text?: string | null;
  isFromMe?: boolean;
  handle?: { address?: string } | null;
  chats?: Array<{ guid?: string }>;
  dateCreated?: number;
  itemType?: number;
}

interface BbCursorState {
  readonly version: 1;
  readonly afterRowId: number;
  readonly upperRowId: number | null;
  readonly bootstrapAfterMs: number | null;
}

interface BbQueryMetadata {
  readonly offset?: unknown;
  readonly limit?: unknown;
  readonly count?: unknown;
  readonly total?: unknown;
}

const BB_CURSOR_PREFIX = 'bb1:';
const BLUEBUBBLES_MAX_PAGE_SIZE = 1000;
const APPLE_EPOCH_UNIX_MS = 978_307_200_000;

function malformedResponse(message: string): ImessagePortError {
  return { message, code: 'MalformedResponse', status: 502 };
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function encodeCursor(state: BbCursorState): string {
  return BB_CURSOR_PREFIX + Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): BbCursorState {
  if (!cursor.startsWith(BB_CURSOR_PREFIX)) {
    throw { message: 'invalid bluebubbles inbound cursor', code: 'BadCursor', status: 400 } satisfies ImessagePortError;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor.slice(BB_CURSOR_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw { message: 'invalid bluebubbles inbound cursor', code: 'BadCursor', status: 400 } satisfies ImessagePortError;
  }
  const state = parsed as Partial<BbCursorState> | null;
  if (state === null
    || state.version !== 1
    || !isSafeNonNegativeInteger(state.afterRowId)
    || (state.upperRowId !== null && !isSafeNonNegativeInteger(state.upperRowId))
    || (state.bootstrapAfterMs !== null && !isSafeNonNegativeInteger(state.bootstrapAfterMs))) {
    throw { message: 'invalid bluebubbles inbound cursor', code: 'BadCursor', status: 400 } satisfies ImessagePortError;
  }
  return {
    version: 1,
    afterRowId: state.afterRowId,
    upperRowId: state.upperRowId,
    bootstrapAfterMs: state.bootstrapAfterMs,
  };
}

function parseQueryPage(
  result: unknown,
  requestedLimit: number,
): readonly BbMessage[] {
  if (typeof result !== 'object' || result === null) {
    throw malformedResponse('bluebubbles query returned a non-object response');
  }
  const data = (result as { data?: unknown }).data;
  const metadata = (result as { metadata?: BbQueryMetadata }).metadata;
  if (!Array.isArray(data) || typeof metadata !== 'object' || metadata === null) {
    throw malformedResponse('bluebubbles query omitted data or metadata');
  }
  if (metadata.offset !== 0
    || metadata.limit !== requestedLimit
    || metadata.count !== data.length
    || !isSafeNonNegativeInteger(metadata.total)) {
    throw malformedResponse('bluebubbles query metadata did not match the requested page');
  }
  return data as BbMessage[];
}

function validateRawMessage(
  message: BbMessage,
  afterRowId: number,
  upperRowId: number,
): number {
  const rowId = message.originalROWID;
  if (!Number.isSafeInteger(rowId)
    || (rowId as number) <= afterRowId
    || (rowId as number) > upperRowId
    || typeof message.guid !== 'string'
    || message.guid === ''
    || typeof message.dateCreated !== 'number'
    || !Number.isFinite(message.dateCreated)) {
    throw malformedResponse('bluebubbles query returned an invalid or out-of-window message row');
  }
  return rowId as number;
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
  const isGroup = typeof groupGuid === 'string' && isImessageGroupAddress(groupGuid);
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

  async listInboundSince(
    since: Date,
    pageSize?: number,
    cursor: string | null = null,
  ): Promise<InboundImessagePage> {
    if (pageSize !== undefined
      && (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > BLUEBUBBLES_MAX_PAGE_SIZE)) {
      throw new RangeError(`pageSize must be a positive integer, got ${pageSize}`);
    }
    const sinceMs = since.getTime();
    if (!Number.isFinite(sinceMs) || sinceMs < 0) {
      throw new RangeError('since must be a valid non-negative date');
    }
    const limit = pageSize ?? 100;
    let state: BbCursorState = cursor === null
      ? { version: 1, afterRowId: 0, upperRowId: null, bootstrapAfterMs: sinceMs }
      : decodeCursor(cursor);

    if (state.upperRowId === null) {
      const upperResult = await this.http({
        method: 'POST',
        path: '/message/query',
        body: {
          limit: 1,
          offset: 0,
          sort: 'ASC',
          with: ['chats', 'handle'],
          where: [{
            statement: 'message.ROWID = (SELECT MAX(bb_hi.ROWID) FROM message AS bb_hi)',
            args: {},
          }],
        },
      });
      const upperRows = parseQueryPage(upperResult, 1);
      if (upperRows.length === 0) {
        return {
          records: [],
          cursor: encodeCursor({ ...state, bootstrapAfterMs: null }),
          hasMore: false,
        };
      }
      const upperRowId = validateRawMessage(upperRows[0]!, -1, Number.MAX_SAFE_INTEGER);
      if (upperRowId <= state.afterRowId) {
        return {
          records: [],
          cursor: encodeCursor({ version: 1, afterRowId: state.afterRowId, upperRowId: null, bootstrapAfterMs: null }),
          hasMore: false,
        };
      }
      state = { ...state, upperRowId };
    }

    const upperRowId = state.upperRowId;
    if (upperRowId === null) {
      throw malformedResponse('bluebubbles cursor did not establish an upper ROWID');
    }
    const bootstrapPredicate = state.bootstrapAfterMs === null
      ? ''
      : ' AND bb_page.date >= (:afterUnixMs - :appleEpochUnixMs) * 1000000';
    const args: Record<string, number> = {
      afterRowId: state.afterRowId,
      upperRowId,
      pageLimit: limit,
    };
    if (state.bootstrapAfterMs !== null) {
      args.afterUnixMs = state.bootstrapAfterMs;
      args.appleEpochUnixMs = APPLE_EPOCH_UNIX_MS;
    }
    const result = await this.http({
      method: 'POST',
      path: '/message/query',
      body: {
        limit,
        offset: 0,
        sort: 'ASC',
        with: ['chats', 'handle'],
        where: [{
          statement: `message.ROWID IN (SELECT bb_page.ROWID FROM message AS bb_page WHERE bb_page.ROWID > :afterRowId AND bb_page.ROWID <= :upperRowId${bootstrapPredicate} ORDER BY bb_page.ROWID ASC LIMIT :pageLimit)`,
          args,
        }],
      },
    });
    const rawRows = parseQueryPage(result, limit);
    const seenRowIds = new Set<number>();
    const normalizedRows: Array<{ rowId: number; message: InboundImessage }> = [];
    for (const raw of rawRows) {
      const rowId = validateRawMessage(raw, state.afterRowId, upperRowId);
      if (seenRowIds.has(rowId)) {
        throw malformedResponse('bluebubbles query returned a duplicate message ROWID');
      }
      seenRowIds.add(rowId);
      const normalized = normalizeMessage(raw);
      if (normalized === null) {
        throw malformedResponse('bluebubbles query returned a message that could not be normalized');
      }
      normalizedRows.push({ rowId, message: normalized });
    }
    normalizedRows.sort((left, right) => left.rowId - right.rowId);

    if (normalizedRows.length === 0) {
      return {
        records: [],
        cursor: encodeCursor({ version: 1, afterRowId: upperRowId, upperRowId: null, bootstrapAfterMs: null }),
        hasMore: false,
      };
    }
    const lastRowId = normalizedRows[normalizedRows.length - 1]!.rowId;
    const hasMore = rawRows.length === limit && lastRowId < upperRowId;
    return {
      records: normalizedRows.map(({ message }) => message),
      cursor: encodeCursor(hasMore
        ? { ...state, afterRowId: lastRowId }
        : { version: 1, afterRowId: upperRowId, upperRowId: null, bootstrapAfterMs: null }),
      hasMore,
    };
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
