export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_LOGGED_OUT'
  | 'CONNECTION_UNAVAILABLE'
  | 'RECONNECTING'
  | 'DATABASE_ERROR'
  | 'RATE_LIMITED'
  | 'LLM_UNAVAILABLE'
  | 'LLM_TIMEOUT'
  | 'PINECONE_UNAVAILABLE'
  | 'SEND_FAILED'
  | 'SEND_UNCERTAIN'
  | 'ENRICHMENT_ERROR'
  | 'INTERNAL_ERROR'
  | 'LOCK_CONTENTION';

const RETRYABLE: Set<ErrorCode> = new Set([
  'CONNECTION_UNAVAILABLE',
  'RECONNECTING',
  'LLM_UNAVAILABLE',
  'LLM_TIMEOUT',
  'PINECONE_UNAVAILABLE',
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
