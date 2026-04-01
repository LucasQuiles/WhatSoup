// src/runtimes/agent/control-queue.ts
// IOutboundQueue implementation that buffers all output locally.
// Used for the repair control session where Claude Code output must NOT be
// forwarded as WhatsApp messages.

import type { Messenger } from '../../core/types.ts';
import { sendTracked } from '../../core/durability.ts';
import type { DurabilityEngine } from '../../core/durability.ts';
import type { IOutboundQueue, ToolUpdate } from './outbound-queue.ts';

export class ControlQueue implements IOutboundQueue {
  private chatJid: string;
  private readonly messenger: Messenger;
  private log: string[] = [];

  constructor(chatJid: string, messenger: Messenger) {
    this.chatJid = chatJid;
    this.messenger = messenger;
  }

  // ─── IOutboundQueue ──────────────────────────────────────────────────────

  enqueueText(text: string): void {
    this.log.push(text);
  }

  enqueueResultText(text: string): void {
    this.log.push(text);
  }

  enqueueToolUpdate(update: ToolUpdate): void {
    this.log.push(`[${update.category}] ${update.detail}`);
  }

  /** No-op — control sessions don't surface tool updates to users. */
  setToolUpdateMode(_mode: 'full' | 'minimal'): void {
    // intentional no-op
  }

  /** No-op — control sessions do not send typing indicators to WhatsApp. */
  indicateTyping(): void {
    // intentional no-op
  }

  /** No-op — nothing to flush; all output is kept in the local log buffer. */
  async flush(): Promise<void> {
    // intentional no-op
  }

  /** No-op — no timers or resources to release. */
  async shutdown(): Promise<void> {
    // intentional no-op
  }

  /** Clear the log buffer (mirrors OutboundQueue.abortTurn semantics). */
  abortTurn(): void {
    this.log = [];
  }

  get targetChatJid(): string {
    return this.chatJid;
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
