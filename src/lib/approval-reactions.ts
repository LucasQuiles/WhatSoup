/**
 * Approval-reaction target store.
 *
 * Lightweight reaction-based approval/deny for agent-proposed actions, as an
 * alternative to heavyweight poll widgets. The agent proposes an action and
 * references a target message; an authorized approver reacts with a 👍 (or
 * configurable approval emoji) to approve, or 👎 (or configurable deny emoji)
 * to deny.
 *
 * Persistent target store:
 *  - Keyed by `${accountId}:${conversationKey}:${messageId}` — uniquely
 *    identifies which message the reaction applies to.
 *  - Bounded (default 1000 entries) with TTL eviction (default 24h).
 *  - Survives reconnection so an approver can react minutes or hours later.
 *
 * Multi-JID support: an approval can be registered against multiple target
 * messages (e.g., admin approves from a different chat than where the action
 * was proposed). Each target is independent.
 *
 * Authorization: only caller-supplied approver IDs may resolve an approval.
 * Reactions from unauthorized users are ignored.
 *
 * Platform-agnostic: the caller owns emoji configuration and the reaction-
 * event source. This module is the pure state layer.
 */

/** Decision an approval reaction resolves to. */
export type ApprovalDecision = 'approved' | 'denied';

/** Configuration for {@link createApprovalReactionStore}. */
export interface ApprovalReactionOptions {
  /** Emoji that maps to approval. Default '👍'. */
  approveEmoji?: string;
  /** Emoji that maps to denial. Default '👎'. */
  denyEmoji?: string;
  /** Maximum stored targets. Default 1000. */
  maxEntries?: number;
  /** TTL per target in ms. Default 86_400_000 (24h). */
  ttlMs?: number;
  /** Injected clock for testing. Default Date.now. */
  now?: () => number;
}

/** A registered approval target awaiting a reaction. */
export interface ApprovalTarget {
  /** Account the proposed action belongs to. */
  accountId: string;
  /** Conversation the proposal message lives in. */
  conversationKey: string;
  /** Message ID the approver should react to. */
  messageId: string;
  /** IDs (platform-native) authorized to approve. */
  authorizedApprovers: readonly string[];
  /** Opaque payload the caller uses to identify the pending action. */
  actionId: string;
}

interface StoredTarget extends ApprovalTarget {
  registeredAt: number;
  expiresAt: number;
}

/** Result of resolving a reaction event against the store. */
export interface ApprovalResolution {
  decision: ApprovalDecision;
  target: ApprovalTarget;
  approverId: string;
}

export interface ApprovalReactionStore {
  /** Register a target. Overwrites an existing target with the same key. */
  register(target: ApprovalTarget): void;
  /** Remove a specific target. */
  unregister(accountId: string, conversationKey: string, messageId: string): boolean;
  /** Look up a target by key (returns undefined if missing or expired). */
  lookup(accountId: string, conversationKey: string, messageId: string): ApprovalTarget | undefined;
  /**
   * Resolve a reaction event. Returns the decision if the reactor is
   * authorized and the emoji matches; otherwise returns null (and the
   * reaction should be ignored).
   */
  resolve(params: {
    accountId: string;
    conversationKey: string;
    messageId: string;
    reactorId: string;
    emoji: string;
  }): ApprovalResolution | null;
  /** Current live (non-expired) target count. Lazily purges stale entries. */
  size(): number;
  /** Remove all targets. */
  clear(): void;
}

function makeKey(accountId: string, conversationKey: string, messageId: string): string {
  return `${accountId}:${conversationKey}:${messageId}`;
}

export function createApprovalReactionStore(
  options: ApprovalReactionOptions = {},
): ApprovalReactionStore {
  const approveEmoji = options.approveEmoji ?? '👍';
  const denyEmoji = options.denyEmoji ?? '👎';
  const maxEntries = options.maxEntries ?? 1_000;
  const ttlMs = options.ttlMs ?? 86_400_000;
  const now = options.now ?? Date.now;
  const store = new Map<string, StoredTarget>();

  function purgeExpired(): void {
    const t = now();
    for (const [key, target] of store) {
      if (target.expiresAt <= t) {
        store.delete(key);
      }
    }
  }

  function evictIfFull(excludeKey?: string): void {
    if (store.size < maxEntries) return;
    // Evict the oldest-inserted entry that isn't the one we're about to write.
    let oldestKey: string | undefined;
    let oldestTs = Infinity;
    for (const [key, target] of store) {
      if (key === excludeKey) continue;
      if (target.registeredAt < oldestTs) {
        oldestTs = target.registeredAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      store.delete(oldestKey);
    }
  }

  function toPublic(t: StoredTarget): ApprovalTarget {
    return {
      accountId: t.accountId,
      conversationKey: t.conversationKey,
      messageId: t.messageId,
      authorizedApprovers: t.authorizedApprovers,
      actionId: t.actionId,
    };
  }

  return {
    register(target) {
      if (!target.accountId || !target.conversationKey || !target.messageId) {
        return;
      }
      const key = makeKey(target.accountId, target.conversationKey, target.messageId);
      const t = now();
      if (!store.has(key)) {
        evictIfFull(key);
      }
      store.set(key, {
        ...target,
        registeredAt: t,
        expiresAt: t + ttlMs,
      });
    },

    unregister(accountId, conversationKey, messageId) {
      const key = makeKey(accountId, conversationKey, messageId);
      return store.delete(key);
    },

    lookup(accountId, conversationKey, messageId) {
      const key = makeKey(accountId, conversationKey, messageId);
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        store.delete(key);
        return undefined;
      }
      return toPublic(entry);
    },

    resolve({ accountId, conversationKey, messageId, reactorId, emoji }) {
      const target = this.lookup(accountId, conversationKey, messageId);
      if (!target) return null;
      const isAuthorized = target.authorizedApprovers.includes(reactorId);
      if (!isAuthorized) return null;
      let decision: ApprovalDecision | null = null;
      if (emoji === approveEmoji) decision = 'approved';
      else if (emoji === denyEmoji) decision = 'denied';
      if (decision === null) return null;
      return { decision, target, approverId: reactorId };
    },

    size() {
      purgeExpired();
      return store.size;
    },

    clear() {
      store.clear();
    },
  };
}
