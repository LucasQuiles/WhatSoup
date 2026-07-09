export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_LOGGED_OUT'
  | 'CONNECTION_UNAVAILABLE'
  | 'RECONNECTING'
  | 'DATABASE_ERROR'
  | 'RATE_LIMITED'
  | 'LLM_UNAVAILABLE'
  | 'LLM_AUTH_ERROR'
  | 'LLM_RATE_LIMITED'
  | 'LLM_BAD_REQUEST'
  | 'LLM_TIMEOUT'
  | 'PINECONE_UNAVAILABLE'
  | 'MEDIA_NOT_FOUND'
  | 'SEND_FAILED'
  | 'SEND_TIMEOUT'
  | 'SEND_UNCERTAIN'
  // PR-F: the socket-seam outbound governor shed a text send (past the
  // per-conversation ceiling or the bounded pacing wait). A deliberate
  // rate/safety cap — NOT retryable (mirrors RATE_LIMITED), so it is not added
  // to the RETRYABLE set below.
  | 'OUTBOUND_GOVERNOR_SHED'
  | 'ENRICHMENT_ERROR'
  | 'INTERNAL_ERROR'
  | 'LOCK_CONTENTION';

const RETRYABLE: Set<ErrorCode> = new Set([
  'CONNECTION_UNAVAILABLE',
  'RECONNECTING',
  'LLM_UNAVAILABLE',
  'LLM_TIMEOUT',
  'PINECONE_UNAVAILABLE',
  'SEND_FAILED',
  'SEND_TIMEOUT',
]);

export class WhatSoupError extends Error {
  code: ErrorCode;

  constructor(message: string, code: ErrorCode, cause?: unknown) {
    super(message, { cause });
    this.name = 'WhatSoupError';
    this.code = code;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}
