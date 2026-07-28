import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, jsonResponse, readBody } from '../../lib/http.ts';
import { parseSignalEnvelopeValue } from '../incidents/envelope.ts';
import { IncidentStoreCorruptError } from '../incidents/db.ts';
import type { IncidentStore } from '../incidents/store.ts';
import type { ProducerStore } from '../incidents/producers.ts';

export const SIGNALS_BODY_LIMIT_BYTES = 32 * 1024;

export interface SignalsDeps {
  getIncidentStore: () => IncidentStore | null;
  getProducerStore: () => ProducerStore | null;
  now?: () => Date;
  rateLimit?: { windowMs: number; maxPerWindow: number };
  /** Root fleet-token check for the producer admin routes (wired by index.ts). */
  verifyRootToken?: (req: IncomingMessage) => boolean;
}

interface RateWindow {
  windowStart: number;
  count: number;
}

function errorBody(code: string, retryable: boolean, message: string): {
  error: { code: string; retryable: boolean; message: string };
} {
  return { error: { code, retryable, message } };
}

function isSqliteFull(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const errcode = (err as { errcode?: unknown }).errcode;
  return errcode === 13 || /SQLITE_FULL|disk is full/i.test(err.message);
}

export function createSignalsHandlers(deps: SignalsDeps): {
  postSignal(req: IncomingMessage, res: ServerResponse): Promise<void>;
  postProducer(req: IncomingMessage, res: ServerResponse): Promise<void>;
  postProducerCredential(req: IncomingMessage, res: ServerResponse, params: { id: string }): Promise<void>;
  deleteProducerCredential(req: IncomingMessage, res: ServerResponse, params: { id: string }): Promise<void>;
} {
  const now = deps.now ?? ((): Date => new Date());
  const rateLimit = deps.rateLimit ?? { windowMs: 60_000, maxPerWindow: 60 };
  const rateWindows = new Map<string, RateWindow>();

  function overRateLimit(producerId: string, at: number): number | null {
    const current = rateWindows.get(producerId);
    if (!current || at - current.windowStart >= rateLimit.windowMs) {
      rateWindows.set(producerId, { windowStart: at, count: 1 });
      return null;
    }
    current.count += 1;
    if (current.count > rateLimit.maxPerWindow) {
      return Math.ceil((current.windowStart + rateLimit.windowMs - at) / 1000);
    }
    return null;
  }

  async function postSignal(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const incidentStore = deps.getIncidentStore();
    const producerStore = deps.getProducerStore();
    if (!incidentStore || !producerStore) {
      jsonResponse(res, 503, errorBody('incident_store_unavailable', true, 'incident store is unavailable'));
      return;
    }

    if (req.headers['content-encoding'] !== undefined) {
      jsonResponse(res, 415, errorBody('unsupported_content_encoding', false, 'compressed bodies are not accepted'));
      return;
    }
    const contentType = req.headers['content-type'];
    if (typeof contentType !== 'string' || !contentType.split(';')[0]?.trim().toLowerCase().startsWith('application/json')) {
      jsonResponse(res, 415, errorBody('unsupported_media_type', false, 'body must be application/json'));
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readBody(req, SIGNALS_BODY_LIMIT_BYTES);
    } catch (err) {
      if (err instanceof Error && (err as { statusCode?: unknown }).statusCode === 413) {
        jsonResponse(res, 413, errorBody('body_too_large', false, 'body exceeds the 32 KiB limit'));
        return;
      }
      jsonResponse(res, 503, errorBody('body_read_failed', true, 'request body could not be read'));
      return;
    }

    const bearer = extractBearer(req);
    if (bearer === null) {
      jsonResponse(res, 401, errorBody('credential_required', false, 'producer credential required'));
      return;
    }
    const at = now();
    const producer = producerStore.authenticate(bearer, at);
    if (!producer) {
      jsonResponse(res, 401, errorBody('credential_invalid', false, 'producer credential rejected'));
      return;
    }

    const retryAfter = overRateLimit(producer.producerId, at.getTime());
    if (retryAfter !== null) {
      res.setHeader('Retry-After', String(retryAfter));
      jsonResponse(res, 429, errorBody('rate_limited', true, 'signal rate limit exceeded'));
      return;
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      jsonResponse(res, 400, errorBody('malformed_request', false, 'body is not valid JSON'));
      return;
    }
    const parsed = parseSignalEnvelopeValue(parsedBody);
    if (!parsed.ok) {
      jsonResponse(res, 422, errorBody('invalid_signal', false, 'signal failed schema validation'));
      return;
    }
    const envelope = parsed.envelope;
    const denial = producerStore.authorize(producer, {
      kind: envelope.kind,
      conditionClass: 'conditionClass' in envelope ? envelope.conditionClass : undefined,
      subject: envelope.subject,
    });
    if (denial !== null) {
      jsonResponse(res, 403, errorBody(denial, false, 'signal is outside the producer scope'));
      return;
    }

    try {
      const result = incidentStore.acceptSignal(rawBody, {
        producerId: producer.producerId,
        producerDomainId: producer.producerDomainId,
      }, at);

      switch (result.outcome) {
        case 'accepted':
          jsonResponse(res, 201, { ...result.receipt, receiptId: `rcpt-${result.receipt.eventId}` });
          return;
        case 'idempotent_replay':
          res.setHeader('Idempotent-Replay', 'true');
          jsonResponse(res, 200, { ...result.receipt, receiptId: `rcpt-${result.receipt.eventId}` });
          return;
        case 'identity_conflict':
          jsonResponse(res, 409, errorBody('signal_identity_conflict', false, 'signal identity was previously accepted with different bytes'));
          return;
        case 'invalid':
          if (result.malformedJson) {
            jsonResponse(res, 400, errorBody('malformed_request', false, 'body is not valid JSON'));
          } else {
            jsonResponse(res, 422, errorBody('invalid_signal', false, 'signal failed schema validation'));
          }
          return;
      }
    } catch (err) {
      if (isSqliteFull(err)) {
        jsonResponse(res, 507, errorBody('durable_storage_unavailable', true, 'durable storage is unavailable'));
        return;
      }
      if (err instanceof IncidentStoreCorruptError) {
        jsonResponse(res, 503, errorBody('incident_store_unavailable', true, 'incident store is unavailable'));
        return;
      }
      jsonResponse(res, 503, errorBody('internal_error', true, 'signal acceptance failed'));
      return;
    }
  }

  function requireStores(res: ServerResponse): ProducerStore | null {
    const producerStore = deps.getProducerStore();
    if (!producerStore) {
      jsonResponse(res, 503, errorBody('incident_store_unavailable', true, 'incident store is unavailable'));
      return null;
    }
    return producerStore;
  }

  function requireRoot(req: IncomingMessage, res: ServerResponse): boolean {
    if (!deps.verifyRootToken || !deps.verifyRootToken(req)) {
      jsonResponse(res, 401, errorBody('root_token_required', false, 'fleet root token required'));
      return false;
    }
    return true;
  }

  async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
    let raw: string;
    try {
      raw = await readBody(req, SIGNALS_BODY_LIMIT_BYTES);
    } catch {
      jsonResponse(res, 413, errorBody('body_too_large', false, 'body exceeds the 32 KiB limit'));
      return undefined;
    }
    if (raw.trim() === '') return {};
    try {
      return JSON.parse(raw);
    } catch {
      jsonResponse(res, 400, errorBody('malformed_request', false, 'body is not valid JSON'));
      return undefined;
    }
  }

  async function postProducer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const producerStore = requireStores(res);
    if (!producerStore) return;
    if (!requireRoot(req, res)) return;
    const body = await readJsonBody(req, res);
    if (body === undefined) return;

    const input = body as {
      producerId?: unknown;
      producerDomainId?: unknown;
      allowedKinds?: unknown;
      allowedConditionClasses?: unknown;
      allowedSubjects?: unknown;
      enrollmentTtlMs?: unknown;
      credentialTtlMs?: unknown;
    };
    const result = producerStore.register(
      input as Parameters<ProducerStore['register']>[0],
      now(),
    );
    if (!result.ok) {
      if (result.reason === 'producer_exists') {
        jsonResponse(res, 409, errorBody('producer_exists', false, 'producer is already registered'));
      } else {
        jsonResponse(res, 422, errorBody('invalid_registration', false, 'registration failed validation'));
      }
      return;
    }
    jsonResponse(res, 201, {
      producerId: String((body as { producerId: string }).producerId),
      enrollmentSecret: result.enrollmentSecret,
      enrollmentSecretExpiresAt: result.enrollmentSecretExpiresAt,
    });
  }

  async function postProducerCredential(
    req: IncomingMessage,
    res: ServerResponse,
    params: { id: string },
  ): Promise<void> {
    const producerStore = requireStores(res);
    if (!producerStore) return;
    const body = await readJsonBody(req, res);
    if (body === undefined) return;

    const at = now();
    const secret = (body as { enrollmentSecret?: unknown }).enrollmentSecret;
    if (typeof secret === 'string' && secret.length > 0) {
      const exchanged = producerStore.exchangeEnrollmentSecret(params.id, secret, at);
      if (!exchanged.ok) {
        jsonResponse(res, 401, errorBody('enrollment_rejected', false, 'enrollment was not accepted'));
        return;
      }
      jsonResponse(res, 201, {
        producerId: params.id,
        credential: exchanged.credential,
        credentialExpiresAt: exchanged.credentialExpiresAt,
      });
      return;
    }

    const bearer = extractBearer(req);
    if (bearer === null) {
      jsonResponse(res, 401, errorBody('credential_required', false, 'enrollment secret or current credential required'));
      return;
    }
    const rotated = producerStore.rotateCredential(params.id, bearer, at);
    if (!rotated.ok) {
      jsonResponse(res, 401, errorBody('credential_invalid', false, 'producer credential rejected'));
      return;
    }
    jsonResponse(res, 201, {
      producerId: params.id,
      credential: rotated.credential,
      credentialExpiresAt: rotated.credentialExpiresAt,
    });
  }

  async function deleteProducerCredential(
    req: IncomingMessage,
    res: ServerResponse,
    params: { id: string },
  ): Promise<void> {
    const producerStore = requireStores(res);
    if (!producerStore) return;
    if (!requireRoot(req, res)) return;
    producerStore.revoke(params.id);
    res.writeHead(204);
    res.end();
  }

  return { postSignal, postProducer, postProducerCredential, deleteProducerCredential };
}
