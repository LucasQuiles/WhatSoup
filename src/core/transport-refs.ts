// src/core/transport-refs.ts

import { isE164Wire } from '../lib/phone.ts';

/** Transport library / protocol family. */
export type ChannelKind =
  | 'whatsapp'
  | 'telegram'
  | 'sms'
  | 'signal'
  | 'imessage';
  // future: 'discord'

declare const __channelIdBrand: unique symbol;

/**
 * Per-account channel identity. Branded string of the form `${ChannelKind}:${accountName}`.
 * Examples: 'whatsapp:mw-bot', 'telegram:studio-bot'.
 *
 * Constructed via makeChannelId(); raw string assignment is a type error.
 */
export type ChannelId = string & { readonly [__channelIdBrand]: true };

/** Channel account segment pattern — shared with config validation. */
export const ACCOUNT_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * AppleID email shape — iMessage accepts iCloud / me.com / mac.com addresses
 * plus any email registered against an AppleID. We accept any RFC-5322-ish
 * shape here; the daemon/Server is the final arbiter.
 *
 * Lives in core (not src/transport/imessage/) because config validation needs
 * it: core may only import [core, lib], so defining it under transport/ would
 * force a core → transport edge that the import-boundary ratchet rejects.
 * `src/transport/imessage/types.ts` re-exports it for the adapter.
 */
export const APPLEID_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Signal service UUID and V2 group-id shapes shared by core JID policy. */
export const SIGNAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SIGNAL_GROUP_ID_RE = /^[A-Za-z0-9+/]{16,}={0,2}$/;

/**
 * Signal group IDs are standard base64 and share the @signal namespace with
 * direct recipients. Prefer a valid E.164 interpretation for the one
 * syntactically ambiguous edge case so a phone number is never routed as a
 * group.
 */
export function isSignalGroupAddress(address: string): boolean {
  return !isE164Wire(address)
    && !SIGNAL_UUID_RE.test(address)
    && SIGNAL_GROUP_ID_RE.test(address);
}

export function makeChannelId(kind: ChannelKind, account: string): ChannelId {
  if (!ACCOUNT_RE.test(account)) {
    throw new Error(`invalid account segment: ${JSON.stringify(account)} (must match ${ACCOUNT_RE.source})`);
  }
  return `${kind}:${account}` as ChannelId;
}

export function kindOf(id: ChannelId): ChannelKind {
  return id.split(':', 1)[0] as ChannelKind;
}

export function accountOf(id: ChannelId): string {
  const i = id.indexOf(':');
  return id.slice(i + 1);
}

export interface ConversationRef {
  readonly channel: ChannelId;
  readonly id: string;
}

export interface ParticipantRef {
  readonly channel: ChannelId;
  readonly id: string;
}

export interface MessageRef {
  readonly channel: ChannelId;
  readonly conversation: string;
  readonly id: string;
}

export function refToKey(r: ConversationRef): string {
  return `${r.channel}:${r.id}`;
}

export function msgToKey(m: MessageRef): string {
  return `${m.channel}:${m.conversation}:${m.id}`;
}
