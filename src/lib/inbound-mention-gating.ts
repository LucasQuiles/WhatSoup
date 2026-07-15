/**
 * Inbound mention gating.
 *
 * Decides whether a bot should respond to an inbound group message based on
 * mention facts and policy. This is distinct from self-mention-strip
 * (`src/lib/self-mention-strip.ts`), which CLEANS the bot's mention from
 * message text; gating decides WHETHER to react at all.
 *
 * Mention is "effective" when any of:
 *  - the bot was explicitly @mentioned (`wasMentioned`),
 *  - an implicit mention kind matched the allowed set (e.g. replied-to-bot),
 *  - a text-command bypass applies (authorized control command in a group
 *    that requires mention but the user addressed the bot by command, not
 *    mention).
 *
 * `shouldSkip` is true only when mention is required, detectable, and no
 * effective mention occurred.
 */

/** How the bot was implicitly mentioned (not via @mention token). */
export type InboundImplicitMentionKind =
  | 'reply_to_bot' // user replied to the bot's message
  | 'quoted_bot' // user quoted the bot's message
  | 'bot_thread_participant' // user is in a thread the bot started
  | 'native'; // platform-native implicit mention

/** Observed mention facts about an inbound message. */
export interface InboundMentionFacts {
  /** Can the transport reliably detect @mentions for this message? */
  canDetectMention: boolean;
  /** Was the bot explicitly @mentioned? */
  wasMentioned: boolean;
  /** Were ANY mentions present (bot or others)? Disables command bypass. */
  hasAnyMention?: boolean;
  /** Implicit mention kinds observed for this message. */
  implicitMentionKinds?: readonly InboundImplicitMentionKind[];
}

/** Policy controlling how mentions gate the bot's response. */
export interface InboundMentionPolicy {
  /** Is this a group message (vs DM)? DMs are never mention-gated. */
  isGroup: boolean;
  /** Does this group require an @mention for the bot to respond? */
  requireMention: boolean;
  /** Implicit mention kinds this bot treats as a real mention. */
  allowedImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
  /** Are text commands (e.g. `/help`) allowed to bypass the mention requirement? */
  allowTextCommands: boolean;
  /** Does this message contain a control command? */
  hasControlCommand: boolean;
  /** Is the command sender authorized (e.g. admin or allowed sender)? */
  commandAuthorized: boolean;
}

/** The gating verdict. */
export interface InboundMentionDecision {
  /** Effective mention: explicit, implicit, or bypass. */
  effectiveWasMentioned: boolean;
  /** True when the bot should SKIP this message (no response). */
  shouldSkip: boolean;
  /** True when an implicit mention matched the allowed set. */
  implicitMention: boolean;
  /** Which implicit kinds matched (subset of observed ∩ allowed). */
  matchedImplicitMentionKinds: InboundImplicitMentionKind[];
  /** True when a text-command bypass applied. */
  shouldBypassMention: boolean;
}

/** Input shape: nested `{ facts, policy }`. */
export interface ResolveInboundMentionDecisionParams {
  facts: InboundMentionFacts;
  policy: InboundMentionPolicy;
}

function intersectKinds(
  observed: readonly InboundImplicitMentionKind[] | undefined,
  allowed: readonly InboundImplicitMentionKind[] | undefined,
): InboundImplicitMentionKind[] {
  if (!observed || observed.length === 0) return [];
  if (!allowed || allowed.length === 0) return [];
  const allowedSet = new Set(allowed);
  const matched: InboundImplicitMentionKind[] = [];
  for (const kind of observed) {
    if (allowedSet.has(kind)) {
      matched.push(kind);
    }
  }
  return matched;
}

/**
 * Resolve whether the bot should respond to an inbound message based on
 * mention facts and policy.
 *
 * Decision:
 *  1. Compute `shouldBypassMention` — a text command from an authorized user
 *     in a mention-required group, when NO mentions are present at all.
 *  2. Intersect observed implicit kinds with the allowed set.
 *  3. `effectiveWasMentioned` = explicit OR implicit OR bypass.
 *  4. `shouldSkip` = requires mention AND can detect AND not effective.
 */
export function resolveInboundMentionDecision(
  params: ResolveInboundMentionDecisionParams,
): InboundMentionDecision {
  const { facts, policy } = params;

  const shouldBypassMention =
    policy.isGroup &&
    policy.requireMention &&
    !facts.wasMentioned &&
    !(facts.hasAnyMention ?? false) &&
    policy.allowTextCommands &&
    policy.commandAuthorized &&
    policy.hasControlCommand;

  const matchedImplicitMentionKinds = intersectKinds(
    facts.implicitMentionKinds,
    policy.allowedImplicitMentionKinds,
  );
  const implicitMention = matchedImplicitMentionKinds.length > 0;
  const effectiveWasMentioned =
    facts.wasMentioned || implicitMention || shouldBypassMention;
  const shouldSkip =
    policy.requireMention && facts.canDetectMention && !effectiveWasMentioned;

  return {
    effectiveWasMentioned,
    shouldSkip,
    implicitMention,
    matchedImplicitMentionKinds,
    shouldBypassMention,
  };
}
