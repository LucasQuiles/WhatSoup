// src/mcp/caller-attribution.ts
//
// #3421 step 1: record who made each tool call, with no change to what any
// caller may do. The socket server learns about a connection (its id, the
// client's declared name, whether it presented the executing session's
// token); the registry combines that with the resolved turn context and writes
// it onto the tool_calls row. Nothing here is an authorization input.

import type { ToolCallCallerEvidence } from '../core/durability-evidence-contract.ts';
import { isNonEmptyString, isRecord } from '../lib/type-guards.ts';
import type { CallerAttribution, ResolvedSessionContext } from './types.ts';

/** Client-declared strings are bounded before they reach the database. */
export const CLIENT_INFO_MAX_LENGTH = 64;

/** Calls made through the in-process provider bridge: the turn's own by construction. */
export const IN_PROCESS_CALLER: Readonly<CallerAttribution> = Object.freeze({
  transport: 'in_process',
  connectionId: null,
  clientName: null,
  clientVersion: null,
  tokenResult: 'not_applicable',
});

/** A socket connection before it has declared anything. */
export function initialSocketAttribution(connectionId: string): Readonly<CallerAttribution> {
  return Object.freeze({
    transport: 'socket',
    connectionId,
    clientName: null,
    clientVersion: null,
    tokenResult: 'absent',
  });
}

/**
 * Keep printable ASCII only and cap the length. The value is whatever the
 * client chose to say, so it is stored as a label and never trusted.
 */
export function boundClientField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let printable = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) printable += char;
  }
  const bounded = printable.trim().slice(0, CLIENT_INFO_MAX_LENGTH);
  return bounded.length > 0 ? bounded : null;
}

/** Fold an `initialize` request's `params.clientInfo` into a connection's attribution. */
export function withDeclaredClient(
  current: Readonly<CallerAttribution>,
  initializeParams: unknown,
): Readonly<CallerAttribution> {
  const clientInfo = isRecord(initializeParams) ? initializeParams['clientInfo'] : undefined;
  if (!isRecord(clientInfo)) return current;
  return Object.freeze({
    ...current,
    clientName: boundClientField(clientInfo['name']),
    clientVersion: boundClientField(clientInfo['version']),
  });
}

export function isTurnOwned(attribution: Readonly<CallerAttribution>): boolean {
  return attribution.transport === 'in_process' || attribution.tokenResult === 'match';
}

/**
 * The per-call record for the tool_calls row, or null when the session carries
 * no attribution (a caller outside the socket server and the provider bridge),
 * in which case the columns stay NULL.
 */
export function getToolCallCallerEvidence(
  session: ResolvedSessionContext,
  toolSensitive: boolean,
): ToolCallCallerEvidence | null {
  const attribution = session.callerAttribution;
  if (!attribution) return null;
  return {
    transport: attribution.transport,
    connectionId: attribution.connectionId,
    clientName: attribution.clientName,
    clientVersion: attribution.clientVersion,
    tokenResult: attribution.tokenResult,
    turnOwned: isTurnOwned(attribution),
    actorSource: session.executingResolution === 'resolved' && isNonEmptyString(session.actorJid)
      ? 'executing_turn'
      : 'none',
    toolSensitive,
  };
}
