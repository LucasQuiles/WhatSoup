// src/runtimes/agent/control-queue.ts
// IOutboundQueue implementation that buffers all output locally.
// Used for the repair control session where Claude Code output must NOT be
// forwarded as WhatsApp messages.

import type { Messenger } from '../../core/types.ts';
import { sendTracked } from '../../core/durability.ts';
import type { DurabilityEngine } from '../../core/durability.ts';
import type {
  IOutboundQueue,
  OutboundMessageRole,
  ToolUpdate,
  TurnDeliveryEvidence,
} from './outbound-queue.ts';
import type { ProgressEvent } from './operation-tracker.ts';

export class ControlQueue implements IOutboundQueue {
  private chatJid: string;
  private readonly messenger: Messenger;
  private log: string[] = [];
  private activeTurnId: string | undefined;
  private completedTurnEvidence: TurnDeliveryEvidence | undefined;

  constructor(chatJid: string, messenger: Messenger) {
    this.chatJid = chatJid;
    this.messenger = messenger;
  }

  // ─── IOutboundQueue ──────────────────────────────────────────────────────

  enqueueText(text: string, _role: OutboundMessageRole = 'answer'): void {
    this.log.push(text);
  }

  /** No-op aggregation — control sessions buffer all text via enqueueText. */
  enqueueStreamingText(text: string, _role: OutboundMessageRole = 'answer'): void {
    this.log.push(text);
  }

  enqueueResultText(text: string, _role: OutboundMessageRole = 'answer'): void {
    this.log.push(text);
  }

  enqueueToolUpdate(update: ToolUpdate): void {
    this.log.push(`[${update.category}] ${update.detail}`);
  }

  /** No-op — control sessions don't surface progress events to users. */
  enqueueProgressUpdate(_event: ProgressEvent, _instanceName: string): void {
    // intentional no-op
  }

  /** No-op — control sessions don't surface tool updates to users. */
  setToolUpdateMode(_mode: 'full' | 'minimal' | 'friendly'): void {
    // intentional no-op
  }

  /** No-op — control sessions don't surface tool updates to users. */
  setToolUpdateRedirectJid(_jid: string | null): void {
    // intentional no-op
  }

  /** No-op — control sessions buffer all output locally. */
  setTextAggregateDelayMs(_ms: number): void {
    // intentional no-op
  }

  /** No-op — control sessions do not send typing indicators to WhatsApp. */
  indicateTyping(): void {
    // intentional no-op
  }

  /** No-op — control sessions have no typing indicator to clear at turn end. */
  endTurn(): void {
    // intentional no-op
  }

  /** Pass-through — control sessions execute polls immediately without ordering constraints. */
  async enqueuePoll(sendFn: () => Promise<void>): Promise<void> {
    await sendFn();
  }

  /** No-op — control sessions have no poll-pending state. */
  setPollPending(_pending: boolean): void {
    // intentional no-op
  }

  /** No-op — nothing to flush; all output is kept in the local log buffer. */
  async flush(): Promise<void> {
    // intentional no-op
  }

  /** Clear evidence ownership; control queues have no timers or send resources. */
  async shutdown(): Promise<void> {
    this.activeTurnId = undefined;
    this.completedTurnEvidence = undefined;
  }

  /** Clear the log buffer (mirrors OutboundQueue.abortTurn semantics). */
  abortTurn(): void {
    this.log = [];
    this.activeTurnId = undefined;
    this.completedTurnEvidence = undefined;
  }

  get targetChatJid(): string {
    return this.chatJid;
  }

  /** Control queues are not group-flood-relevant; a fixed token is sufficient
   *  for the IOutboundQueue contract (QR-069). */
  getSenderToken(): string {
    return 'control-queue';
  }

  updateDeliveryJid(jid: string): void {
    this.chatJid = jid;
  }

  /** No-op — control sessions have no durability tracking. */
  setInboundSeq(_seq: number | undefined): void {
    // intentional no-op
  }

  /** Always returns undefined — control sessions create no outbound ops. */
  getLastOpId(): number | undefined {
    return undefined;
  }

  /** No-op — control sessions never retain outbound op ids. */
  clearLastOpId(): void {
    // intentional no-op
  }

  beginTurnEvidence(turnId: string): void {
    if (turnId.trim() === '') {
      throw new Error('Turn evidence requires a non-empty turn id');
    }
    if (this.activeTurnId !== undefined) {
      if (this.activeTurnId === turnId) return;
      throw new Error(`Turn evidence already belongs to ${this.activeTurnId}; cannot begin ${turnId}`);
    }
    if (this.completedTurnEvidence?.turnId === turnId) {
      throw new Error(`Turn evidence for ${turnId} was already completed`);
    }
    this.completedTurnEvidence = undefined;
    this.activeTurnId = turnId;
  }

  hasCommittedAnswer(): boolean {
    return false;
  }

  resumeTurnAnswerArbitration(turnId: string): void {
    if (this.activeTurnId !== turnId) {
      throw new Error(`No active turn evidence belongs to ${turnId}`);
    }
  }

  async flushTurnEvidence(turnId: string): Promise<TurnDeliveryEvidence> {
    if (this.activeTurnId === undefined) {
      if (this.completedTurnEvidence?.turnId === turnId) {
        return ControlQueue.emptyEvidence(turnId);
      }
      throw new Error(`No active turn evidence belongs to ${turnId}`);
    }
    if (this.activeTurnId !== turnId) {
      throw new Error(`Turn evidence belongs to ${this.activeTurnId}; cannot flush ${turnId}`);
    }
    this.activeTurnId = undefined;
    this.completedTurnEvidence = ControlQueue.emptyEvidence(turnId);
    return ControlQueue.emptyEvidence(turnId);
  }

  private static emptyEvidence(turnId: string): TurnDeliveryEvidence {
    return Object.freeze({
      turnId,
      answerOpIds: Object.freeze([]),
      lifecycleOpIds: Object.freeze([]),
      statusOpIds: Object.freeze([]),
    });
  }

  /** No-op — no outbound ops to mark terminal. */
  markLastTerminal(): void {
    // intentional no-op
  }

  /** No-op — control sessions have no durability engine to propagate. */
  setDurability(_engine: DurabilityEngine): void {
    // intentional no-op
  }

  // ─── Control-only methods ────────────────────────────────────────────────

  /**
   * Format a control protocol message and send it via sendTracked.
   * This is the only path that actually delivers a WhatsApp message from a
   * control session — used for structured protocol signalling, not user output.
   */
  async sendControlMessage(
    targetJid: string,
    protocol: string,
    payload: unknown,
    durability?: DurabilityEngine,
  ): Promise<void> {
    const text = `[${protocol}] ${JSON.stringify(payload)}`;
    await sendTracked(this.messenger, targetJid, text, durability, { replayPolicy: 'safe' });
  }

  /**
   * Return a copy of the log buffer accumulated since construction (or the
   * last abortTurn call). Callers receive a snapshot — mutations to the
   * returned array do not affect the internal buffer.
   */
  getLog(): string[] {
    return [...this.log];
  }
}
