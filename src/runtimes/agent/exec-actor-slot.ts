// src/runtimes/agent/exec-actor-slot.ts
// Atomic per-turn identity slot for the executing-turn FIFO register
// (perChatExecActorQueue). #3426 threaded the executing turn's `actorJid`
// through this register so the provider boundary can resolve the caller at read
// time. #3427 adds `purpose` to the SAME slot so the scheduled-agent-job
// forbidden-tools gate (registry.ts) receives a correct purpose in the scopes
// where the `::scheduled-agent-job` mapKey suffix never runs (single, shared).
//
// The two fields are stored together — one push, one shift — so they can never
// drift: whenever the register exposes an executing actor for a turn, it
// exposes that turn's purpose too.

import type { SessionContext } from '../../mcp/types.ts';

export interface ExecActorSlot {
  /** Executing turn's caller JID (admin gate). Undefined ⇒ fail-closed deny. */
  actorJid: string | undefined;
  /** Executing turn's runtime purpose. `'scheduled-agent-job'` engages the
   *  registry's forbidden-tools gate; undefined leaves it inert (normal turns). */
  purpose?: SessionContext['purpose'];
}
