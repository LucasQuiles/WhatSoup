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
import { shortHash } from '../lib/short-hash.ts';
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
  /**
   * The caller may receive `owner_only` records: a verified instance admin or
   * a configured trusted operator, over an authenticated transport, in a
   * direct chat (see ownerOnlyRecallAllowed). Independent of `kind`.
   */
  ownerOnlyAccess: boolean;
  /**
   * The source instances whose `owner_only` records the caller may receive
   * (ownerOnlySourceSet: this instance plus `memory.pinecone.ownerOnlySources`).
   * Independent of instanceScopedIds. Unset serves no owner_only record.
   */
  ownerOnlySources?: ReadonlySet<string>;
  /**
   * This instance's name when `memory.pinecone.instanceScopedIds` is on. A
   * record must then pass source eligibility before conversation ranking.
   */
  sourceInstance?: string;
  /** The reader's own account (memorySourceAccount); '' or unset matches no stamped record. */
  sourceAccount?: string;
  /**
   * Restrictive recall (memoryRecallRestrictive): without owner_only access the
   * caller receives only records stamped chat_scoped.
   */
  restrictive?: boolean;
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
  /** The transport's direct-chat classification (OwnerOnlyRecallInput.directChat). */
  directChat: boolean | undefined;
}

export interface MemoryScopeDeps {
  db?: Database | null;
  identities: InstanceIdentities;
  membership?: GroupMembershipReader | null;
  /** Group JIDs or conversation keys configured as shared workflows. */
  sharedWorkflowGroups: Iterable<string>;
  /** Phone -> recall scope for non-admin direct chats; unset means 'chat'. */
  contactRecallScopes?: Readonly<Record<string, string>>;
  /** `memory.pinecone.trustedOperatorPhones`: may read owner_only records. */
  trustedOperatorPhones?: Iterable<string>;
  /** recordIdScope(instance, instanceScopedIds): set only when the option is on. */
  instanceScope?: string | null;
  /** The reader's account, derived as the writer derives it (memorySourceAccount). */
  sourceAccount?: string;
  /** memoryRecallRestrictive(instanceType, recordVisibility, instanceScopedIds). */
  restrictive?: boolean;
  /** ownerOnlySourceSet(botName, memory.pinecone.ownerOnlySources). */
  ownerOnlySources?: ReadonlySet<string>;
  /**
   * The owner_only grant; ownerOnlyRecallAllowed when unset. knowledge_search
   * passes knowledgeSearchOwnerOnlyAllowed with its session isolation.
   */
  ownerOnlyGrant?: (input: OwnerOnlyRecallInput) => boolean;
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

/**
 * The sender is a configured trusted operator (`memory.pinecone.
 * trustedOperatorPhones`), proven with the same grant primitive as an admin.
 */
export function isTrustedOperatorSender(
  actorJid: string | undefined,
  trustedOperatorPhones: Iterable<string> | undefined,
  db?: Database | null,
): boolean {
  if (!actorJid || !db || !trustedOperatorPhones) return false;
  const phones = new Set(trustedOperatorPhones);
  if (phones.size === 0) return false;
  const phone = resolvePhoneFromJidForGrant(actorJid, db);
  return phone !== null && isAdminPhone(phone, phones);
}

export interface OwnerOnlyRecallInput {
  actorJid?: string;
  conversationKey?: string;
  deliveryJid?: string;
  /**
   * The transport classified this conversation as a direct chat (the inbound
   * message's `isGroup === false`). Required so every caller states it:
   * undefined (unknown) is refused. An iMessage group id carries no group
   * marker, so the absence of one never proves a direct chat.
   */
  directChat: boolean | undefined;
  adminPhones: Set<string>;
  trustedOperatorPhones?: Iterable<string>;
  db?: Database | null;
}

/**
 * Whether the caller may receive `owner_only` records. Only a verified admin of
 * the instance or a configured trusted operator, over an authenticated
 * transport, in a conversation the transport classified as a direct chat. The
 * operator instance, contacts (whatever their recall scope), every group (even
 * one the admin is in, since other members read the reply; a recognized group
 * key or JID is refused whatever directChat says), unverified transports,
 * unknown conversation kinds and callers with no pinned conversation are all
 * refused.
 */
export function ownerOnlyRecallAllowed(input: OwnerOnlyRecallInput): boolean {
  const { actorJid, conversationKey, db } = input;
  if (input.directChat !== true) return false;
  if (!actorJid || !db || !conversationKey) return false;
  if (isGroupContext(conversationKey, input.deliveryJid) || isGroupJid(conversationKey)) return false;
  return isVerifiedAdminSender(actorJid, input.adminPhones, db)
    || isTrustedOperatorSender(actorJid, input.trustedOperatorPhones, db);
}

/**
 * The agent session serving this call is isolated per chat: `sessionScope`
 * `per_chat`, or `sandboxPerChat`. A shared, single or global session (or an
 * unset or unknown scope) carries what one chat recalled into replies to
 * other chats.
 */
export function agentSessionIsolatedPerChat(sessionScope: unknown, sandboxPerChat: unknown): boolean {
  return sessionScope === 'per_chat' || sandboxPerChat === true;
}

/**
 * knowledge_search's owner_only grant: ownerOnlyRecallAllowed, and the agent
 * session must be isolated per chat (agentSessionIsolatedPerChat).
 */
export function knowledgeSearchOwnerOnlyAllowed(
  input: OwnerOnlyRecallInput & { sessionIsolatedPerChat: boolean },
): boolean {
  return input.sessionIsolatedPerChat === true && ownerOnlyRecallAllowed(input);
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
  const ownerOnlyAccess = (deps.ownerOnlyGrant ?? ownerOnlyRecallAllowed)({
    actorJid: request.actorJid,
    conversationKey: rawKey,
    deliveryJid: request.deliveryJid,
    directChat: request.directChat,
    adminPhones: deps.identities.adminPhones,
    trustedOperatorPhones: deps.trustedOperatorPhones,
    db,
  });
  const base = {
    chatKey,
    chatSpellings,
    sharedWorkflow: false,
    ownerOnlyAccess,
    ...(deps.ownerOnlySources ? { ownerOnlySources: deps.ownerOnlySources } : {}),
    ...(deps.instanceScope ? { sourceInstance: deps.instanceScope } : {}),
    ...(deps.sourceAccount !== undefined ? { sourceAccount: deps.sourceAccount } : {}),
    ...(deps.restrictive === true ? { restrictive: true } : {}),
  };

  if (request.operatorInstance) return { ...base, kind: 'unrestricted', reason: 'operator_instance' };
  if (!rawKey || !chatKey) {
    return request.tier === 'global'
      ? { ...base, kind: 'dm', reason: 'global_session_without_conversation' }
      : { ...base, kind: 'no_context', reason: 'chat_session_without_conversation' };
  }
  if (isVerifiedAdminSender(request.actorJid, deps.identities.adminPhones, db)) {
    return { ...base, kind: 'unrestricted', reason: 'admin_sender' };
  }
  // A trusted operator keeps the ordinary contact boundary for chat_scoped
  // records; only owner_only records widen across chats (memoryHitTier).
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

// ── owner_only visibility ──────────────────────────────────────────────────

export interface SourceBoundary {
  /** Set only with instanceScopedIds on; unset means no instance or account boundary. */
  sourceInstance?: string;
  /** The reader's own account; '' or unset matches no stamped record. */
  sourceAccount?: string;
  ownerOnlyAccess: boolean;
  ownerOnlySources?: ReadonlySet<string>;
}

/**
 * The record belongs to the reader's instance and account, or no boundary
 * applies (instanceScopedIds off). With the option on, a record of another
 * instance or account is another conversation. A record missing
 * source_instance or source_account is tied to nothing, so it counts as this
 * instance's only for a caller with owner_only access: ownership is never
 * inferred from absent metadata.
 */
export function isSameSourceInstance(fields: Record<string, unknown>, boundary: SourceBoundary): boolean {
  if (!boundary.sourceInstance) return true;
  const instance = fields['source_instance'];
  const account = fields['source_account'];
  if (isNonEmptyString(account) && (!isNonEmptyString(boundary.sourceAccount) || account !== boundary.sourceAccount)) return false;
  if (isNonEmptyString(instance) && instance !== boundary.sourceInstance) return false;
  if (!isNonEmptyString(instance) || !isNonEmptyString(account)) return boundary.ownerOnlyAccess;
  return isNonEmptyString(boundary.sourceAccount) && account === boundary.sourceAccount;
}

/** Source eligibility is independent of conversation scope and ranking. */
export function memorySourceEligible(
  fields: Record<string, unknown>,
  boundary: SourceBoundary,
  allowUnstamped = false,
): boolean {
  if (!boundary.sourceInstance) return true;
  if (isOwnerOnlyRecord(fields)) return ownerOnlyRecordServable(fields, boundary.ownerOnlyAccess, boundary.ownerOnlySources);
  // Business entities and documents predate chat-memory provenance.
  if (allowUnstamped && !isChatMemoryRecord(fields)
    && fields['source_instance'] === undefined && fields['source_account'] === undefined) return true;
  return isSameSourceInstance(fields, boundary);
}

/** Explicit entity metadata distinguishes business records in shared namespaces. */
export function isChatMemoryRecord(fields: Record<string, unknown>): boolean {
  return !isNonEmptyString(fields['entity_type'])
    && (fields['chat_jid'] !== undefined || fields['memory_type'] !== undefined
      || fields['visibility'] !== undefined || fields['provenance'] !== undefined);
}

/** Narrow retrieval before top-K; memorySourceEligible checks returned metadata. */
export function withSourceFilter(
  filter: Record<string, unknown> | undefined,
  boundary: SourceBoundary,
  allowUnstamped = false,
): Record<string, unknown> | undefined {
  if (!boundary.sourceInstance) return filter;
  const sameOrAbsent = (field: string, value: string): Record<string, unknown> => ({
    $or: [{ [field]: { $eq: value } }, { [field]: { $exists: false } }],
  });
  const own = boundary.ownerOnlyAccess
    ? { $and: [
      sameOrAbsent('source_instance', boundary.sourceInstance),
      isNonEmptyString(boundary.sourceAccount)
        ? sameOrAbsent('source_account', boundary.sourceAccount)
        : { source_account: { $exists: false } },
    ] }
    : isNonEmptyString(boundary.sourceAccount)
      ? { source_instance: { $eq: boundary.sourceInstance }, source_account: { $eq: boundary.sourceAccount } }
      : { $and: [{ source_account: { $exists: true } }, { source_account: { $exists: false } }] };
  const ordinary = (source: Record<string, unknown>): Record<string, unknown> =>
    boundary.ownerOnlyAccess ? { $and: [ownerOnlyExclusion(), source] } : source;
  const choices: Record<string, unknown>[] = [ordinary(own)];
  if (allowUnstamped) choices.push(ordinary({
    source_instance: { $exists: false }, source_account: { $exists: false },
    $or: [{ entity_type: { $exists: true } }, {
      chat_jid: { $exists: false }, memory_type: { $exists: false },
      visibility: { $exists: false }, provenance: { $exists: false },
    }],
  }));
  if (boundary.ownerOnlyAccess && boundary.ownerOnlySources?.size) choices.push({
    visibility: { $eq: 'owner_only' }, source_instance: { $in: [...boundary.ownerOnlySources] },
  });
  const source = choices.length === 1 ? choices[0]! : { $or: choices };
  return filter && Object.keys(filter).length ? { $and: [filter, source] } : source;
}

/**
 * Recall is restrictive on an instance that writes owner_only records (a
 * passive line, or recordVisibility owner_only) or shares its index
 * (instanceScopedIds): a caller without owner_only access then receives only
 * records stamped chat_scoped from the chat-memory namespaces. An unstamped
 * record may predate an owner_only stamp, so it reaches only a caller with
 * access. Default instances keep legacy recall unchanged.
 */
export function memoryRecallRestrictive(
  instanceType: unknown,
  recordVisibility: unknown,
  instanceScopedIds: unknown,
): boolean {
  return instanceRecordVisibility(instanceType, recordVisibility) === 'owner_only' || instanceScopedIds === true;
}

/** A record stamped `owner_only`. A record with no visibility field is not. */
export function isOwnerOnlyRecord(fields: Record<string, unknown>): boolean {
  return fields['visibility'] === 'owner_only';
}

/**
 * The source instances whose `owner_only` records this instance's owner may
 * read: this instance (`botName`) plus `memory.pinecone.ownerOnlySources`.
 * Built apart from instanceScopedIds, so the binding holds with that option off.
 */
export function ownerOnlySourceSet(instanceName: unknown, configured: unknown): ReadonlySet<string> {
  const listed = Array.isArray(configured) ? configured : [];
  return new Set([instanceName, ...listed].filter(isNonEmptyString));
}

/**
 * Whether one `owner_only` record may be served: the caller has owner_only
 * access AND the record's source_instance is in `sources`. A record whose
 * source_instance is missing, empty or not a string is never served, because
 * nothing ties it to an owner.
 */
export function ownerOnlyRecordServable(
  fields: Record<string, unknown>,
  ownerOnlyAccess: boolean,
  sources: ReadonlySet<string> | undefined,
): boolean {
  if (!ownerOnlyAccess || !sources) return false;
  const source = fields['source_instance'];
  return isNonEmptyString(source) && sources.has(source);
}

/**
 * Pre-query clause keeping every record except `owner_only` ones. The
 * `$exists: false` arm is load-bearing: records written before visibility
 * existed have no such field, and a bare `$ne` is documented to match only
 * records that carry a differing value (same reasoning as consolidation's
 * qualifier filter). classifyMemoryFilter recognizes this exact shape.
 */
function ownerOnlyExclusion(): { $or: Array<Record<string, unknown>> } {
  return { $or: [{ visibility: { $exists: false } }, { visibility: { $ne: 'owner_only' } }] };
}

/**
 * Add the owner_only exclusion to a search filter unless the caller may read
 * owner_only records. With `chatScopedOnly` (restrictive recall on a
 * chat-memory leg) a caller without access asks for chat_scoped records only,
 * which also leaves out unstamped ones. The pre-query filter only narrows the
 * fetch; the per-record gate (memoryHitTier, the chat runtime's post-filter)
 * decides. classifyMemoryFilter recognizes both shapes.
 */
export function withVisibilityFilter(
  filter: Record<string, unknown> | undefined,
  ownerOnlyAccess: boolean,
  chatScopedOnly = false,
): Record<string, unknown> | undefined {
  if (ownerOnlyAccess) return filter;
  if (chatScopedOnly) return { ...(filter ?? {}), visibility: { $eq: 'chat_scoped' } };
  const exclusion = ownerOnlyExclusion();
  if (!filter || Object.keys(filter).length === 0) return exclusion;
  // A filter that already has a top-level $or cannot take a second one.
  if ('$or' in filter) return { $and: [filter, exclusion] };
  return { ...filter, ...exclusion };
}

/**
 * Pre-query filter for the extra leg a caller with owner_only access gets: the
 * owner_only records of every chat, which the caller's chat_scoped boundary
 * would otherwise never fetch.
 */
export function ownerOnlyLegFilter(): Record<string, unknown> {
  return { visibility: { $eq: 'owner_only' } };
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
  if (!memorySourceEligible(fields, scope)) return null;
  const rawChat = typeof fields['chat_jid'] === 'string' ? fields['chat_jid'] : '';
  // Same conversation = same chat AND (with instance-scoped ids on) the same
  // source instance and account (isSameSourceInstance).
  const sameConversation = (): boolean => scope.chatKey !== undefined
    && fold.chat(rawChat) === scope.chatKey
    && isSameSourceInstance(fields, scope);
  if (isOwnerOnlyRecord(fields)) {
    // owner_only: refused without access or from an unlisted source; with access
    // (only ever granted in a direct chat) admitted from any chat, ranked this
    // chat -> other -> untagged. chat_scoped records keep the scope's own
    // boundary below.
    if (!ownerOnlyRecordServable(fields, scope.ownerOnlyAccess, scope.ownerOnlySources)) return null;
    if (!rawChat.trim()) return 2;
    return sameConversation() ? 0 : 1;
  }
  // Restrictive recall: without access, only records stamped chat_scoped.
  if (scope.restrictive === true && !scope.ownerOnlyAccess && fields['visibility'] !== 'chat_scoped') return null;
  if (!rawChat.trim()) return includesUntagged(scope) ? 2 : null;
  const thisChat = sameConversation();

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

// ── record provenance ──────────────────────────────────────────────────────
//
// Every record the instance writes carries four server-derived fields:
//   source_instance  the writing instance (`config.botName`)
//   source_account   an opaque id of the writing WhatsApp account
//   visibility       who may recall it (`owner_only` or `chat_scoped`)
//   provenance       which pipeline wrote it
// The provider stamps them in `toPineconeRecord` from instance config and
// runtime state; no tool argument reaches them. Records written before these
// fields existed carry none of them; restrictive chat recall excludes them.

export const MEMORY_VISIBILITIES = ['owner_only', 'chat_scoped'] as const;
export type MemoryVisibility = (typeof MEMORY_VISIBILITIES)[number];

export const MEMORY_PROVENANCES = ['memory_write', 'fact_export', 'summary', 'consolidation'] as const;
export type MemoryProvenance = (typeof MEMORY_PROVENANCES)[number];

/**
 * The visibility an instance stamps on what it writes. A passive (personal)
 * line always writes `owner_only`; configuration can make any other instance
 * `owner_only` but can never relax a passive line to `chat_scoped`.
 */
export function instanceRecordVisibility(instanceType: unknown, configured: unknown): MemoryVisibility {
  if (instanceType === 'passive') return 'owner_only';
  return configured === 'owner_only' ? 'owner_only' : 'chat_scoped';
}

/**
 * The most restrictive visibility among the inputs. A write that derives from
 * existing records (a consolidation, a correction) never widens them: one
 * `owner_only` input makes the result `owner_only`. Unknown values count as
 * `chat_scoped`, the pre-visibility behavior.
 */
export function narrowestVisibility(...values: unknown[]): MemoryVisibility {
  return values.some((value) => value === 'owner_only') ? 'owner_only' : 'chat_scoped';
}

/**
 * The instance part of record ids, or null. With `memory.pinecone.
 * instanceScopedIds` on, every id scheme (memory_write, the fact-export
 * factId, consolidation's durable id) folds the instance name into its hash,
 * so identical local content from two instances sharing an index cannot
 * collide. Off (the default) keeps every existing id and its dedup unchanged.
 */
export function recordIdScope(instanceName: unknown, enabled: unknown): string | null {
  return enabled === true && isNonEmptyString(instanceName) ? instanceName : null;
}

const SOURCE_ACCOUNT_DIGEST_VERSION = 'whatsoup-memory-source-account/v1';

/**
 * Opaque id of the writing account. A configured `accountScopeId` (already an
 * opaque, configured account identity) wins. Otherwise the connected account
 * JID is reduced to its bare user part and hashed under a versioned prefix, so
 * the raw JID never reaches the record. Unknown (no scope id, not connected)
 * is ''.
 */
export function memorySourceAccount(accountScopeId: unknown, accountJid: string | null | undefined): string {
  if (isNonEmptyString(accountScopeId)) return accountScopeId;
  const user = accountJid ? normalizeLid(bareNumber(accountJid.trim())) : '';
  if (!user) return '';
  return `acct:${shortHash(`${SOURCE_ACCOUNT_DIGEST_VERSION}\n${user}`, 24)}`;
}
