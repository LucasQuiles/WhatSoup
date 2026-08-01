// src/core/mark-read-types.ts
// Leaf types module for the mark-read remote receipt (#2550).
//
// Deliberately zero-import: the console workspace (console/src/types.ts)
// re-exports these types directly so a new backend `remote` state can't
// silently vanish at the console boundary — it must fail the console's
// exhaustiveness check at compile time instead. Because console's tsconfig
// type-checks the whole transitive import graph of anything it imports
// (and enables noUnusedLocals/noUnusedParameters, which the root tsconfig
// does not), this file must stay a leaf: pulling in `./mark-read.ts`
// directly drags `database.ts` / `runtime-connection.ts` / `connection.ts`
// / `mentions.ts` into the console build and couples an unrelated console
// quickfix to backend type-hygiene it doesn't own.

/**
 * Whether the REMOTE read-receipt was accepted, reported alongside the local
 * result (#2292 L16).
 *
 * The local `unread_count` is zeroed in every case — that is deliberate and
 * pinned by two named tests ("swallows chatModify errors: still returns ok and
 * zeroes unread", "skips chatModify when no socket is available, still zeroes
 * unread"): clearing the badge is what the caller asked for, and WhatsApp
 * re-syncs read state on reconnect. What was missing is that the caller could
 * not TELL whether the remote side agreed, so a local zero and a remote
 * still-unread were indistinguishable.
 */
export type MarkReadRemoteStatus =
  | 'acked'           // chatModify was called and succeeded
  | 'failed'          // chatModify was called and threw — remote may still be unread
  | 'offline'         // no socket; nothing was sent
  | 'nothing_to_ack'; // the chat has no messages, so there is no receipt to send

export interface MarkConversationReadResult {
  ok: true;
  jid: string;
  conversation_key: string;
  /** Remote-side outcome. `ok: true` refers to the LOCAL update only. */
  remote: MarkReadRemoteStatus;
}
