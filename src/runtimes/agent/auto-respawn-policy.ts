// Limits for the per-chat auto-respawn backoff, and the record of one scheduled attempt.
import { MS_PER_SECOND } from '../../lib/time-units.ts';
import type { SessionManager } from './session.ts';

/** Max consecutive crashes before auto-respawn gives up and waits for user action. */
export const AUTO_RESPAWN_MAX_CRASHES = 3;
/** Base delay (ms) before attempting auto-respawn after a crash. Actual delay uses exponential backoff. */
export const AUTO_RESPAWN_BASE_MS = 2 * MS_PER_SECOND;
/** Maximum respawn delay (ms) — caps the exponential backoff. */
export const AUTO_RESPAWN_MAX_DELAY_MS = 15 * MS_PER_SECOND;
/**
 * Max times a scheduled respawn may re-arm itself because provider termination
 * is not yet proven. Bounds the one case that is genuinely transient — a tool
 * loop still inside an already-entered call, which settles in its own `finally`
 * — without letting a session that can never prove termination re-arm forever.
 * At the respawn backoff this spans roughly 45 seconds before the respawn is
 * abandoned and the conversation waits for the user's next message.
 */
export const AUTO_RESPAWN_MAX_TERMINATION_DEFERRALS = 5;

/** One scheduled auto-respawn attempt for an owned per-chat session. */
export interface OwnedPerChatRespawnArgs {
  initialMapKey: string;
  chatJid?: string;
  session: SessionManager;
  managerId: string;
  recoveryGeneration: number;
  sessionId: string;
  dbRowId: number | null;
  crashedAtSec: number;
  timer: ReturnType<typeof setTimeout>;
  /** How many times this attempt already re-armed for unproven termination. */
  terminationDeferrals?: number;
}
