import { createHash } from 'node:crypto';

const MAX_KEYS = 1_000;

interface Entry {
  lastSeenAt: number;
  suppressedCount: number;
}

interface DedupeLogger {
  info(fields: object, message: string): void;
}

export class TerminalTextDedupe {
  private readonly entries = new Map<string, Entry>();

  key(chatJid: string, text: string): string {
    return `text:${chatJid}:${this.payloadHash(text)}`;
  }

  payloadHash(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  markTerminal(key: string, now: number, windowMs: number): void {
    this.prune(now, windowMs);
    this.entries.set(key, { lastSeenAt: now, suppressedCount: 0 });
    while (this.entries.size > MAX_KEYS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  suppress(text: string, chatJid: string, now: number, windowMs: number, log: DedupeLogger): boolean {
    this.prune(now, windowMs);
    const entry = this.entries.get(this.key(chatJid, text));
    if (!entry) return false;
    entry.lastSeenAt = now;
    entry.suppressedCount += 1;
    log.info({ chatJid, opType: 'text', terminal: true, payloadHash: this.payloadHash(text), suppressedCount: entry.suppressedCount, windowMs }, 'suppressed duplicate outbound terminal text');
    return true;
  }

  private prune(now: number, windowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.lastSeenAt > windowMs) this.entries.delete(key);
    }
  }
}
