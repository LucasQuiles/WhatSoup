import { asNonEmptyString } from '../lib/type-guards.ts';

export const TERMINAL_AUTH_FAILURE_CLASSES = [
  'pairing_required',
  'serverside_logout_irreversible',
] as const;

const TERMINAL_AUTH_FAILURE_CLASS_SET = new Set<string>(TERMINAL_AUTH_FAILURE_CLASSES);
const LOGGED_OUT_STATUS_CODE = 401;
const LOGGED_OUT_REASON_KEY = 'loggedout';

export interface ExplicitAuthLossSignalInput {
  lastStatusCode: unknown;
  lastDisconnectReason: unknown;
  authFailureClass: unknown;
}

function normalizedText(value: unknown): string | null {
  return asNonEmptyString(value) ?? null;
}

function normalizedSignalKey(value: unknown): string | null {
  const text = normalizedText(value);
  return text === null ? null : text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isLoggedOutStatusCode(value: unknown): boolean {
  if (typeof value === 'number') return value === LOGGED_OUT_STATUS_CODE;
  const text = normalizedText(value);
  if (text === null || !/^\d+$/.test(text)) return false;
  return Number(text) === LOGGED_OUT_STATUS_CODE;
}

export function isLoggedOutDisconnectReason(value: unknown): boolean {
  return normalizedSignalKey(value) === LOGGED_OUT_REASON_KEY;
}

export function isTerminalAuthFailureClass(value: unknown): boolean {
  const text = normalizedText(value);
  return text !== null && TERMINAL_AUTH_FAILURE_CLASS_SET.has(text.toLowerCase());
}

export function hasExplicitAuthLossSignal(input: ExplicitAuthLossSignalInput): boolean {
  return (
    isLoggedOutStatusCode(input.lastStatusCode) ||
    isLoggedOutDisconnectReason(input.lastDisconnectReason) ||
    isTerminalAuthFailureClass(input.authFailureClass)
  );
}
