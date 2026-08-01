// src/transport/poll-vote-decryptor.ts
// PollVoteDecryptor — owns poll-vote tracking + decryption for ConnectionManager.
//
// Extracted from ConnectionManager as a slice of the transport god-class
// decomposition (BEAD-019). Owns the pendingPolls registry (message secrets +
// option-hash maps for polls we sent), the vote-grace-window buffer, and the
// manual Baileys decryptPollVote bridge. Baileys' process-message poll branch is
// commented out in this version, so pollUpdateMessage arrives in messages.upsert
// and is decrypted here using the stored messageSecret.
//
// botJid/botLid are late-bound on ConnectionManager (populated on connection
// open — see connection.ts connection.update handler), so they are read through
// getter thunks rather than captured at construction. Behavior is identical to
// the previous inline implementation — see the poll-vote characterization suites
// in tests/transport/poll-vote-bridge.test.ts and the connection-* branch/coverage
// suites (candidate ordering + exact decryptPollVote call args, the
// creationKey.fromMe creator-JID branches, the unknown-option-hash fallback, the
// vote-change grace replacement, TTL eviction, and clear/dispose teardown).

import { jidNormalizedUser, type WAMessage } from '@whiskeysockets/baileys';
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import { MS_PER_HOUR } from '../lib/time-units.ts';

// ---------------------------------------------------------------------------
// Poll vote decryption — loaded from Baileys at runtime via dynamic import.
// TS cannot resolve the deep import path at compile time, so we lazy-load
// the real decryptPollVote + proto decoder from Baileys' internal modules.
// ---------------------------------------------------------------------------

let _baileysPollDecrypt: ((vote: any, ctx: any) => any) | null = null;

async function loadBaileysPollDecrypt(): Promise<(vote: any, ctx: any) => any> {
  if (_baileysPollDecrypt) return _baileysPollDecrypt;
  const mod = await import('@whiskeysockets/baileys/lib/Utils/process-message.js' as string);
  _baileysPollDecrypt = mod.decryptPollVote;
  return _baileysPollDecrypt!;
}

/** A poll we sent, tracked so we can decrypt incoming votes for it. */
interface PendingPoll {
  messageSecret: Uint8Array;
  optionNames: string[];
  optionHashes: Map<string, string>;  // hex(sha256(name)) → name
  chatJid: string;
  createdAt: number;
}

/** A buffered, decoded vote awaiting the end of its grace window. */
interface PendingVoteEmit {
  pollMessageId: string;
  chatJid: string;
  voterJid: string;
  selectedOptions: string[];
  jidType: string;
}

/** Dependencies injected by ConnectionManager. */
export interface PollVoteDecryptorDeps {
  log: Logger;
  emit: {
    pollVoteReceived: (data: {
      pollMessageId: string;
      chatJid: string;
      voterJid: string;
      selectedOptions: string[];
    }) => void;
    pollVoteFailed: (data: {
      pollMessageId: string;
      chatJid: string;
      reason: string;
    }) => void;
  };
  /** Late-bound: the bot's own JID (phone@s.whatsapp.net), null until connected. */
  getBotJid: () => string | null;
  /** Late-bound: the bot's own LID (number@lid), null until connected. */
  getBotLid: () => string | null;
}

export class PollVoteDecryptor {
  // -------------------------------------------------------------------------
  // Poll vote tracking — stores data needed to decrypt votes for polls we sent.
  // -------------------------------------------------------------------------
  private pendingPolls = new Map<string, PendingPoll>();
  private static readonly PENDING_POLL_TTL_MS = MS_PER_HOUR;

  // Vote grace window: buffer decoded votes for 5s so vote changes
  // (user taps a different option) replace the previous selection.
  // After 5s the final selection is emitted via pollVoteReceived.
  private static readonly POLL_VOTE_GRACE_MS = 5_000;
  private voteGraceTimers = new Map<string, {
    timer: ReturnType<typeof setTimeout>;
    pendingEmit: PendingVoteEmit;
  }>();

  private readonly log: Logger;
  private readonly emit: PollVoteDecryptorDeps['emit'];
  private readonly getBotJid: () => string | null;
  private readonly getBotLid: () => string | null;

  constructor(deps: PollVoteDecryptorDeps) {
    this.log = deps.log;
    this.emit = deps.emit;
    this.getBotJid = deps.getBotJid;
    this.getBotLid = deps.getBotLid;
  }

  /**
   * Track a poll we just sent so its votes can be decrypted. Builds the
   * option-hash map (sha256(optionName) → optionName) and evicts stale entries
   * before adding.
   */
  track(
    waMessageId: string,
    { messageSecret, optionNames, chatJid }: { messageSecret: Uint8Array; optionNames: string[]; chatJid: string },
  ): void {
    // Evict stale entries before adding
    this.evictStale();

    // Build option hash map: sha256(optionName) → optionName
    const optionHashes = new Map<string, string>();
    for (const v of optionNames) {
      // Match Baileys' sha256().toString() — raw buffer toString (NOT hex)
      // See: @whiskeysockets/baileys/lib/Utils/messages.js:718
      const hash = createHash('sha256').update(Buffer.from(v)).digest().toString();
      optionHashes.set(hash, v);
    }

    this.pendingPolls.set(waMessageId, {
      messageSecret,
      optionNames,
      optionHashes,
      chatJid,
      createdAt: Date.now(),
    });
  }

  /** Evict pending polls older than TTL and their grace timers to prevent memory leaks. */
  private evictStale(): void {
    const cutoff = Date.now() - PollVoteDecryptor.PENDING_POLL_TTL_MS;
    for (const [id, poll] of this.pendingPolls) {
      if (poll.createdAt < cutoff) {
        this.clearTracking(id);
      }
    }
  }

  /**
   * Decrypt a poll vote message and emit `pollVoteReceived` if it matches a poll we sent.
   * Uses `decryptPollVote` from Baileys with the stored messageSecret.
   */
  handlePollVote(msg: WAMessage, pollUpdate: any): void {
    const creationKey = pollUpdate.pollCreationMessageKey;
    if (!creationKey?.id) return;

    const stored = this.pendingPolls.get(creationKey.id);
    if (!stored) {
      // Not a poll we're tracking — ignore silently
      return;
    }

    const vote = pollUpdate.vote;
    if (!vote?.encPayload || !vote?.encIv) {
      this.log.warn({ pollMessageId: creationKey.id }, 'poll vote missing encrypted payload');
      return;
    }

    // Fire-and-forget async: decryptPollVote is loaded via dynamic import
    void this.decryptAndEmit(msg, pollUpdate, creationKey, vote, stored).catch((err) => {
      this.log.error({ err, pollMessageId: creationKey.id }, 'failed to decrypt poll vote');
    });
  }

  private async decryptAndEmit(
    msg: WAMessage,
    _pollUpdate: any,
    creationKey: any,
    vote: any,
    stored: { messageSecret: Uint8Array; optionHashes: Map<string, string>; chatJid: string },
  ): Promise<void> {
    const baileysDecrypt = await loadBaileysPollDecrypt();
    const msgKey = msg.key as any;

    // Build candidate JID pairs for decryption. In LID-addressed messages
    // the HMAC context uses LID JIDs; in phone-addressed messages it uses
    // phone JIDs. We try LID first (current WhatsApp default), then phone.
    const ownJid = this.getBotJid();
    const ownLid = this.getBotLid();
    const botLid = ownLid ? jidNormalizedUser(ownLid) : null;
    const botPhone = ownJid ? jidNormalizedUser(ownJid) : null;

    // Voter JID: LID is at participant/remoteJid, phone is at participantAlt/remoteJidAlt
    const voterLid = jidNormalizedUser(msgKey.participant || msgKey.remoteJid || '');
    const voterPhone = msgKey.participantAlt || msgKey.remoteJidAlt || '';

    // Poll creator JID: fromMe → our JID, else from creationKey
    const creatorLid = creationKey.fromMe
      ? botLid
      : jidNormalizedUser(creationKey.participant || creationKey.remoteJid || '');
    const creatorPhone = creationKey.fromMe
      ? botPhone
      : (creationKey.participantAlt || creationKey.remoteJidAlt || '');

    // Bounded candidate list: LID pair first (LID-addressed default), phone pair second
    const candidates: Array<{ voterJid: string; pollCreatorJid: string; label: string }> = [];
    if (voterLid && creatorLid) {
      candidates.push({ voterJid: voterLid, pollCreatorJid: creatorLid, label: 'LID' });
    }
    if (voterPhone && creatorPhone) {
      candidates.push({ voterJid: voterPhone, pollCreatorJid: creatorPhone, label: 'phone' });
    }

    for (const candidate of candidates) {
      try {
        const decrypted = baileysDecrypt(
          vote,
          {
            pollCreatorJid: candidate.pollCreatorJid,
            pollMsgId: creationKey.id,
            pollEncKey: stored.messageSecret,
            voterJid: candidate.voterJid,
          },
        );

        // Decryption succeeded — map hashes to option names
        const selectedOptions: string[] = [];
        for (const optHash of decrypted.selectedOptions ?? []) {
          const hashStr = Buffer.from(optHash).toString();
          const optName = stored.optionHashes.get(hashStr);
          selectedOptions.push(optName ?? 'Unknown');
        }

        if (selectedOptions.length > 0) {
          this.bufferVoteWithGrace(creationKey.id, {
            pollMessageId: creationKey.id,
            chatJid: stored.chatJid,
            voterJid: candidate.voterJid,
            selectedOptions,
            jidType: candidate.label,
          });
        }
        return; // success — stop trying candidates
      } catch {
        // This candidate pair failed — try next
        this.log.debug({ pollMessageId: creationKey.id, jidType: candidate.label }, 'poll vote decrypt failed with candidate — trying next');
      }
    }

    // All candidates exhausted
    this.log.error({ pollMessageId: creationKey.id, candidateCount: candidates.length }, 'poll vote decryption failed with all JID candidates');
    this.emit.pollVoteFailed({
      pollMessageId: creationKey.id,
      chatJid: stored.chatJid,
      reason: 'decrypt_failed',
    });
  }

  /**
   * Buffer a decoded vote for POLL_VOTE_GRACE_MS. If a new vote arrives
   * for the same poll within the window (user changed their answer), the
   * previous selection is replaced. After the grace period, the final
   * selection is emitted and the poll is cleaned up.
   */
  private bufferVoteWithGrace(
    pollMessageId: string,
    data: { pollMessageId: string; chatJid: string; voterJid: string; selectedOptions: string[]; jidType: string },
  ): void {
    const graceKey = `${pollMessageId}:${data.voterJid}`;
    const existing = this.voteGraceTimers.get(graceKey);
    if (existing) {
      // Vote changed within grace window — replace buffered result, reset timer
      clearTimeout(existing.timer);
      this.log.info({
        pollMessageId,
        newOptionCount: data.selectedOptions.length,
        prevOptionCount: existing.pendingEmit.selectedOptions.length,
      }, 'poll vote changed within grace window');
    }

    const timer = setTimeout(() => {
      this.voteGraceTimers.delete(graceKey);
      this.emit.pollVoteReceived({
        pollMessageId: data.pollMessageId,
        chatJid: data.chatJid,
        voterJid: data.voterJid,
        selectedOptions: data.selectedOptions,
      });
      this.log.info({
        pollMessageId: data.pollMessageId,
        chatJid: data.chatJid,
        selectedOptionCount: data.selectedOptions.length,
        jidType: data.jidType,
      }, 'poll vote decrypted and emitted');
    }, PollVoteDecryptor.POLL_VOTE_GRACE_MS);

    this.voteGraceTimers.set(graceKey, { timer, pendingEmit: data });
  }

  /** Atomically clears all grace timers and pendingPolls state for a given poll. */
  clearTracking(pollMessageId: string): void {
    this.pendingPolls.delete(pollMessageId);
    const prefix = `${pollMessageId}:`;
    for (const [key, entry] of this.voteGraceTimers) {
      if (key.startsWith(prefix)) {
        clearTimeout(entry.timer);
        this.voteGraceTimers.delete(key);
      }
    }
    this.log.info({ pollMessageId }, 'poll tracking cleared');
  }

  /** Cancel all pending grace timers to prevent post-shutdown emissions. */
  dispose(): void {
    for (const [id, grace] of this.voteGraceTimers) {
      clearTimeout(grace.timer);
      this.voteGraceTimers.delete(id);
    }
  }
}
