// src/core/memory-scope.ts
// Who may recall which long-term memories, and in what order.
//
// An instance's memory index belongs to one user (the instance owner). Inside it,
// every record carries the chat it came from (`chat_jid`) and, usually, the person
// it came from or is about (`sender_jid`). Recall is ranked, not locked, except in
// groups where other people can read the bot's replies:
//
//   dm_chat            a direct chat with a non-admin contact (the default,
//                      `contactRecallScopes` value 'chat'): this chat, then
//                      untagged. Other chats are excluded, so a shared instance
//                      never recalls one contact's memories to another.
//   dm                 a direct chat with a contact configured as 'instance', or a
//                      global session with no conversation: the whole instance,
//                      ranked this chat -> other chats -> untagged.
//   dm_lane            a group whose every member is the instance owner or a bot
//                      account: same as dm.
//   unrestricted       the operator instance, or a sender verified as one of the
//                      instance's admin identities: same ranking as dm.
//   configurable_group any other group, and any group whose membership cannot be
//                      proven: this group's shared records plus the records of the
//                      verified current sender in this group. Other chats, DM
//                      records and untagged records are excluded. A group listed in
//                      `sharedWorkflowGroups` gets all of this group's records.
//   no_context         a chat-scoped session with no pinned conversation: nothing
//                      from the memory index (fail closed).
//
// These kinds gate chat-attributed memory only. Document namespaces are not
// scoped; knowledge_search merges them by relevance (see knowledge.ts).
//
// The predicates here are pure over explicit inputs so the MCP knowledge_search
// tool and the chat runtime apply one rule.

import type { Database } from './database.ts';
import { canonicalConversationKey, resolvePhoneFromJid, resolvePhoneFromJidForGrant } from './access-list.ts';
import { conversationKeyToJid, isGroupConversationKey, toConversationKey } from './conversation-key.ts';
import {
  bareNumber, isAuthenticatedSenderJid, isGroupJid, isLidJid, isPnJid, normalizeLid, toLidJid, toPersonalJid,
} from './jid-constants.ts';
import { resolveLid, resolveLidsForPhone } from './lid-resolver.ts';
import { systemClock } from '../lib/clock.ts';
import { isAdminPhone, normalizePhoneE164 } from '../lib/phone.ts';
import { isNonEmptyString } from '../lib/type-guards.ts';

export type MemoryScopeKind = 'dm_chat' | 'dm' | 'dm_lane' | 'unrestricted' | 'configurable_group' | 'no_context';

/** Per-contact recall scope for a non-admin direct chat (`contactRecallScopes`). */
export type ContactRecallScope = 'chat' | 'instance';

/** 0 = this chat, 1 = another chat, 2 = untagged (no chat attribution). */
export type MemoryTier = 0 | 1 | 2;

export interface MemoryScope {
  kind: MemoryScopeKind;
  /** Why this kind was chosen; logged, never shown to the user. */
  reason: string;
  /** Folded key of the calling conversation, when one is pinned. */
  chatKey?: string;
  /**
   * Stored spellings of `chat_jid` that denote the calling conversation, used
   * only to narrow server-side queries. The client-side tier check is the gate.
   */
  chatSpellings: string[];
  /** Folded identity of the verified sender (configurable groups only). */
  verifiedSender?: string;
  /** The group is listed in `sharedWorkflowGroups`. */
  sharedWorkflow: boolean;
}

export interface MemoryIdentityFold {
  chat(value: string): string;
  sender(value: string): string;
}

/**
 * Fold a stored `chat_jid` to the conversation key ingest uses, so the two
 * spellings in the index compare equal: memory_write stores the conversation key
 * (`X_at_g.us`, bare phone digits), enrichment stores the raw JID (`X@g.us`,
 * `<phone>@s.whatsapp.net`, `<lid>@lid`). A mapped LID folds to its phone.
 */
export function foldChatAttribution(value: string, db?: Database | null): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.includes('@')) {
    try {
      return db ? canonicalConversationKey(trimmed, db) : toConversationKey(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (db && /^\d+(:\d+)?$/.test(trimmed)) return resolveLid(db, trimmed) ?? normalizeLid(trimmed);
  return trimmed;
}

/** Fold a stored `sender_jid` (or an actor JID) to a phone when it can be resolved. */
export function foldSenderIdentity(value: string, db?: Database | null): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.includes('@')) {
    if (db) {
      try {
        return resolvePhoneFromJid(trimmed, db);
      } catch {
        return normalizeLid(bareNumber(trimmed));
      }
    }
    return normalizeLid(bareNumber(trimmed));
  }
  if (db && /^\d+(:\d+)?$/.test(trimmed)) return resolveLid(db, trimmed) ?? normalizeLid(trimmed);
  return normalizeLid(trimmed);
}

/** Memoized folds for one search; a LID lookup can fall back to disk. */
export function memoryIdentityFold(db?: Database | null): MemoryIdentityFold {
  const chats = new Map<string, string>();
  const senders = new Map<string, string>();
  const memo = (cache: Map<string, string>, value: string, fold: (v: string) => string): string => {
    let folded = cache.get(value);
    if (folded === undefined) {
      folded = fold(value);
      cache.set(value, folded);
    }
    return folded;
  };
  return {
    chat: (value) => memo(chats, value, (v) => foldChatAttribution(v, db)),
    sender: (value) => memo(senders, value, (v) => foldSenderIdentity(v, db)),
  };
}

/** Every stored spelling of `chat_jid` known to denote the conversation `key`. */
export function chatAttributionSpellings(
  key: string,
  deliveryJid: string | undefined,
  db?: Database | null,
): string[] {
  const spellings = new Set<string>([key]);
  if (deliveryJid) spellings.add(deliveryJid);
  if (isGroupConversationKey(key)) {
    spellings.add(conversationKeyToJid(key));
    spellings.add(key.replace('@g.us', '_at_g.us'));
  } else if (/^\d+$/.test(key)) {
    spellings.add(toPersonalJid(key));
    if (db) {
      for (const lid of resolveLidsForPhone(db, key)) {
        spellings.add(lid);
        spellings.add(toLidJid(lid));
      }
    }
  }
  return [...spellings];
}

// ── group membership ────────────────────────────────────────────────────────

/** One participant as Baileys `groupMetadata` reports it. */
export interface GroupParticipantInfo {
  id: string;
  lid?: string;
  phoneNumber?: string;
}

export interface GroupMembershipReader {
  /** Current participants, or null when membership cannot be read. */
  participants(groupJid: string): Promise<GroupParticipantInfo[] | null>;
}

/**
 * Membership cache for DM-lane detection. Entries expire after `ttlMs` and are
 * dropped on any `group-participants.update` for the group, so a join is seen on
 * the next search.
 */
export class GroupMembershipCache implements GroupMembershipReader {
  private readonly entries = new Map<string, { participants: GroupParticipantInfo[]; fetchedAt: number }>();
  private readonly fetchParticipants: (groupJid: string) => Promise<GroupParticipantInfo[] | null>;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(
    fetchParticipants: (groupJid: string) => Promise<GroupParticipantInfo[] | null>,
    options: { ttlMs?: number; now?: () => number; maxEntries?: number } = {},
  ) {
    this.fetchParticipants = fetchParticipants;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.now = options.now ?? (() => systemClock.now());
    this.maxEntries = options.maxEntries ?? 500;
  }

  async participants(groupJid: string): Promise<GroupParticipantInfo[] | null> {
    const cached = this.entries.get(groupJid);
    if (cached && this.now() - cached.fetchedAt < this.ttlMs) return cached.participants;
    let fetched: GroupParticipantInfo[] | null;
    try {
      fetched = await this.fetchParticipants(groupJid);
    } catch {
      fetched = null;
    }
    if (!fetched) {
      this.entries.delete(groupJid);
      return null;
    }
    this.entries.set(groupJid, { participants: fetched, fetchedAt: this.now() });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return fetched;
  }

  invalidate(groupJid: string): void {
    this.entries.delete(groupJid);
  }
}

export interface InstanceIdentities {
  /** The instance owner's identities (`config.adminPhones`). */
  adminPhones: Set<string>;
  /** Other bot instances' phones (`config.siblingPhones`, E.164 digits). */
  siblingPhones: Set<string>;
  /** This bot's own JID and LID, when connected. */
  botJid: string | null;
  botLid: string | null;
}

function localIdentity(jid: string): string {
  return normalizeLid(bareNumber(jid));
}

function participantPhone(p: GroupParticipantInfo, db?: Database | null): string | null {
  if (isPnJid(p.id)) return localIdentity(p.id);
  if (p.phoneNumber && isPnJid(p.phoneNumber)) return localIdentity(p.phoneNumber);
  if (isLidJid(p.id) && db) return resolveLid(db, localIdentity(p.id));
  return null;
}

/**
 * True only when every participant is proven to be the instance owner or a bot
 * account. A participant whose phone cannot be resolved (an unmapped LID) is not
 * proven, so the group is not a DM lane.
 */
export function isDmLaneMembership(
  participants: GroupParticipantInfo[],
  identities: InstanceIdentities,
  db?: Database | null,
): boolean {
  if (participants.length === 0) return false;
  const botIds = new Set<string>();
  for (const jid of [identities.botJid, identities.botLid]) {
    if (jid) botIds.add(localIdentity(jid));
  }
  return participants.every((p) => {
    const ids = [p.id, p.lid, p.phoneNumber].filter(isNonEmptyString);
    if (ids.some((jid) => botIds.has(localIdentity(jid)))) return true;
    const phone = participantPhone(p, db);
    if (!phone) return false;
    return isAdminPhone(phone, identities.adminPhones) || identities.siblingPhones.has(normalizePhoneE164(phone));
  });
}

// ── classification ─────────────────────────────────────────────────────────

export interface MemoryScopeRequest {
  operatorInstance: boolean;
  tier: string;
  conversationKey?: string;
  deliveryJid?: string;
  actorJid?: string;
}

export interface MemoryScopeDeps {
  db?: Database | null;
  identities: InstanceIdentities;
  membership?: GroupMembershipReader | null;
  /** Group JIDs or conversation keys configured as shared workflows. */
  sharedWorkflowGroups: Iterable<string>;
  /** Phone -> recall scope for non-admin direct chats; unset means 'chat'. */
  contactRecallScopes?: Readonly<Record<string, string>>;
}

/**
 * The recall scope configured for a direct-chat contact. Only a sender on an
 * authenticated transport is looked up (a spoofable SMS number never widens
 * recall); phones compare after E.164 normalisation, LIDs after folding to a
 * phone. Anything unset, unverified or not 'instance' is 'chat'.
 */
export function contactRecallScope(
  actorJid: string | undefined,
  scopes: Readonly<Record<string, string>> | undefined,
  db?: Database | null,
): ContactRecallScope {
  if (!actorJid || !scopes || !isAuthenticatedSenderJid(actorJid)) return 'chat';
  // WhatsApp senders compare as phones; other transports (Signal UUIDs,
  // iMessage addresses) must match their configured identifier exactly.
  const whatsapp = isPnJid(actorJid) || isLidJid(actorJid);
  const identity = whatsapp ? normalizePhoneE164(foldSenderIdentity(actorJid, db)) : bareNumber(actorJid);
  if (!identity) return 'chat';
  for (const [contact, scope] of Object.entries(scopes)) {
    if (scope !== 'instance') continue;
    if ((whatsapp ? normalizePhoneE164(contact) : contact.trim()) === identity) return 'instance';
  }
  return 'chat';
}

/**
 * The sender is one of the instance's admin identities, proven over an
 * authenticated transport (the same grant primitive admin commands use).
 */
export function isVerifiedAdminSender(
  actorJid: string | undefined,
  adminPhones: Set<string>,
  db?: Database | null,
): boolean {
  if (!actorJid || !db) return false;
  const phone = resolvePhoneFromJidForGrant(actorJid, db);
  return phone !== null && isAdminPhone(phone, adminPhones);
}

function isGroupContext(key: string, deliveryJid: string | undefined): boolean {
  return isGroupConversationKey(key) || (deliveryJid !== undefined && isGroupJid(deliveryJid));
}

function groupJidFor(key: string, deliveryJid: string | undefined): string {
  if (deliveryJid && isGroupJid(deliveryJid)) return deliveryJid;
  return conversationKeyToJid(key);
}

export async function resolveMemoryScope(
  request: MemoryScopeRequest,
  deps: MemoryScopeDeps,
): Promise<MemoryScope> {
  const { db } = deps;
  const rawKey = request.conversationKey;
  const chatKey = rawKey ? foldChatAttribution(rawKey, db) : undefined;
  const chatSpellings = rawKey ? chatAttributionSpellings(rawKey, request.deliveryJid, db) : [];
  const base = { chatKey, chatSpellings, sharedWorkflow: false };

  if (request.operatorInstance) return { ...base, kind: 'unrestricted', reason: 'operator_instance' };
  if (!rawKey || !chatKey) {
    return request.tier === 'global'
      ? { ...base, kind: 'dm', reason: 'global_session_without_conversation' }
      : { ...base, kind: 'no_context', reason: 'chat_session_without_conversation' };
  }
  if (isVerifiedAdminSender(request.actorJid, deps.identities.adminPhones, db)) {
    return { ...base, kind: 'unrestricted', reason: 'admin_sender' };
  }
  if (!isGroupContext(rawKey, request.deliveryJid)) {
    return contactRecallScope(request.actorJid, deps.contactRecallScopes, db) === 'instance'
      ? { ...base, kind: 'dm', reason: 'contact_scope_instance' }
      : { ...base, kind: 'dm_chat', reason: 'contact_scope_chat' };
  }

  const groupJid = groupJidFor(rawKey, request.deliveryJid);
  const participants = deps.membership ? await deps.membership.participants(groupJid) : null;
  if (participants && isDmLaneMembership(participants, deps.identities, db)) {
    return { ...base, kind: 'dm_lane', reason: 'owner_and_bot_members' };
  }

  const shared = new Set([...deps.sharedWorkflowGroups].map((g) => foldChatAttribution(g, db)));
  // Only an authenticated transport identifies the sender; anything else
  // leaves the group's shared records only.
  const verifiedSender = verifiedSenderIdentity(request.actorJid, db);
  return {
    ...base,
    kind: 'configurable_group',
    reason: participants ? 'group_has_other_members' : 'group_membership_unproven',
    sharedWorkflow: shared.has(chatKey),
    ...(verifiedSender ? { verifiedSender } : {}),
  };
}

/**
 * Chat runtime recall boundary, the same rule as knowledge_search applied to its
 * three legs (chat, sender, self):
 *   open       nothing held: the operator instance, a verified admin, or a
 *              direct-chat contact configured as 'instance'.
 *   this_chat  the sender leg keeps only this chat's records: a direct chat with
 *              a default ('chat') contact, or a shared-workflow group.
 *   group      as this_chat, and the chat leg keeps only the group's shared
 *              records and the sender's own: any other group.
 * The chat runtime has no membership reader, so it cannot prove a DM lane and
 * treats every group as configurable.
 */
export type ChatRecallBoundary = 'open' | 'this_chat' | 'group';

export function chatRecallBoundary(input: {
  chatJid: string;
  senderJid: string;
  operatorInstance: boolean;
  adminPhones: Set<string>;
  db?: Database | null;
  sharedWorkflowGroups?: Iterable<string>;
  contactRecallScopes?: Readonly<Record<string, string>>;
}): ChatRecallBoundary {
  if (input.operatorInstance) return 'open';
  if (isVerifiedAdminSender(input.senderJid, input.adminPhones, input.db)) return 'open';
  if (!isGroupJid(input.chatJid)) {
    return contactRecallScope(input.senderJid, input.contactRecallScopes, input.db) === 'instance' ? 'open' : 'this_chat';
  }
  const chat = foldChatAttribution(input.chatJid, input.db);
  const shared = [...(input.sharedWorkflowGroups ?? [])].some((g) => foldChatAttribution(g, input.db) === chat);
  return shared ? 'this_chat' : 'group';
}

// ── per-record gate and ranking ────────────────────────────────────────────

/**
 * Untagged records (no `chat_jid`) predate per-chat attribution and may hold DM
 * memories, so a configurable group never sees them (owner decisions 39 and 41:
 * groups are the exception to "never lock out"). Every other scope ranks them last.
 */
export function includesUntagged(scope: MemoryScope): boolean {
  return scope.kind !== 'configurable_group' && scope.kind !== 'no_context';
}

/**
 * A group record every member may see: a fact about the group itself
 * (`memory_type: group_context`), or one attributed to no member (`sender_jid`
 * empty, which is how enrichment stores a fact whose attribution it rejected).
 */
export function isGroupSharedRecord(fields: Record<string, unknown>): boolean {
  const senderJid = typeof fields['sender_jid'] === 'string' ? fields['sender_jid'].trim() : '';
  return fields['memory_type'] === 'group_context' || senderJid === '';
}

/**
 * The tier of one hit, or null when the scope must not see it. This is the gate;
 * server-side filters only narrow what is fetched.
 */
export function memoryHitTier(
  fields: Record<string, unknown>,
  scope: MemoryScope,
  fold: MemoryIdentityFold,
): MemoryTier | null {
  if (scope.kind === 'no_context') return null;
  const rawChat = typeof fields['chat_jid'] === 'string' ? fields['chat_jid'] : '';
  if (!rawChat.trim()) return includesUntagged(scope) ? 2 : null;
  const thisChat = scope.chatKey !== undefined && fold.chat(rawChat) === scope.chatKey;

  if (scope.kind === 'dm_chat') return thisChat ? 0 : null;
  if (scope.kind !== 'configurable_group') return thisChat ? 0 : 1;

  if (!thisChat) return null;
  return scope.sharedWorkflow || isOwnOrSharedGroupRecord(fields, scope.verifiedSender, fold) ? 0 : null;
}

/** A record of this group that the verified sender may see: shared, or their own. */
export function isOwnOrSharedGroupRecord(
  fields: Record<string, unknown>,
  verifiedSender: string | undefined,
  fold: MemoryIdentityFold,
): boolean {
  if (isGroupSharedRecord(fields)) return true;
  const sender = typeof fields['sender_jid'] === 'string' ? fold.sender(fields['sender_jid']) : '';
  return verifiedSender !== undefined && sender === verifiedSender;
}

/** The folded sender identity when the transport authenticates it, else undefined. */
export function verifiedSenderIdentity(actorJid: string | undefined, db?: Database | null): string | undefined {
  return actorJid && isAuthenticatedSenderJid(actorJid) ? foldSenderIdentity(actorJid, db) : undefined;
}
