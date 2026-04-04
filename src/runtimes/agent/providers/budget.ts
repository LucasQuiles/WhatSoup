/**
 * Per-provider budget controls.
 * Tracks token usage and request counts, enforces limits.
 */

export interface BudgetConfig {
  /** Maximum requests per minute per provider-instance */
  requestsPerMinute?: number;
  /** Maximum tokens per minute per provider-instance */
  tokensPerMinute?: number;
  /** Maximum daily spend in USD (estimated from token counts) */
  dailySpendCapUsd?: number;
  /** Per-chat burst cap (max requests per chat per minute) */
  chatBurstLimit?: number;
  /** Estimated cost per 1M tokens (blended input/output). Defaults to $3.
   *  Set per-provider: Claude Opus ~$75/M, GPT-4o ~$5/M, local LLMs $0. */
  costPerMillionTokens?: number;
}

export interface BudgetSnapshot {
  requestsLastMinute: number;
  tokensLastMinute: number;
  estimatedDailySpendUsd: number;
  isThrottled: boolean;
  throttleReason: string | null;
}

interface TokenWindow {
  timestamps: number[];
  tokenCounts: number[];
}

export class ProviderBudget {
  private config: BudgetConfig;
  private providerId: string;

  // Sliding window for rate limiting
  private requestWindow: number[] = [];
  private tokenWindow: TokenWindow = { timestamps: [], tokenCounts: [] };
  private dailyTokens = 0;
  private dailyResetTime: number;

  // Per-chat tracking
  private chatRequestWindows: Map<string, number[]> = new Map();

  // Pessimistic counting: track in-flight requests that haven't received a response yet
  private pendingRequests = 0;

  constructor(providerId: string, config: BudgetConfig = {}) {
    this.providerId = providerId;
    this.config = config;
    this.dailyResetTime = this.getNextMidnight();
  }

  /**
   * Check if a request is allowed under current budget.
   * Call before making API requests.
   */
  checkBudget(chatId?: string): { allowed: boolean; reason?: string } {
    const result = this.evaluateBudget(chatId);

    // Pessimistic: reserve a slot for this in-flight request when allowed
    if (result.allowed && this.config.requestsPerMinute) {
      this.pendingRequests++;
    }

    return result;
  }

  /**
   * Record a completed request with token usage.
   * Call after receiving API response.
   */
  recordUsage(tokens: { input?: number; output?: number }, chatId?: string): void {
    const now = Date.now();
    const totalTokens = (tokens.input ?? 0) + (tokens.output ?? 0);

    // Response arrived — no longer pending
    if (this.pendingRequests > 0) {
      this.pendingRequests--;
    }

    this.requestWindow.push(now);
    this.tokenWindow.timestamps.push(now);
    this.tokenWindow.tokenCounts.push(totalTokens);
    this.dailyTokens += totalTokens;

    if (chatId) {
      const chatWindow = this.chatRequestWindows.get(chatId) ?? [];
      chatWindow.push(now);
      this.chatRequestWindows.set(chatId, chatWindow);
    }
  }

  /**
   * Get current budget snapshot for monitoring/alerting.
   */
  getSnapshot(): BudgetSnapshot {
    this.pruneWindows();
    const recentTokens = this.tokenWindow.tokenCounts.reduce((a, b) => a + b, 0);
    // Use peek mode to avoid side-effects (checkBudget increments pendingRequests)
    const check = this.peekBudget();

    return {
      requestsLastMinute: this.requestWindow.length,
      tokensLastMinute: recentTokens,
      estimatedDailySpendUsd: this.estimateSpendUsd(this.dailyTokens),
      isThrottled: !check.allowed,
      throttleReason: check.reason ?? null,
    };
  }

  /**
   * Reset daily counters (called automatically at midnight).
   */
  resetDaily(): void {
    this.dailyTokens = 0;
    this.dailyResetTime = this.getNextMidnight();
  }

  /**
   * Cancel a pending request reservation (for error/timeout paths
   * where the response never arrives).
   */
  cancelPending(): void {
    if (this.pendingRequests > 0) {
      this.pendingRequests--;
    }
  }

  // --- Internal ---

  /** Read-only budget check — no side effects (does not increment pendingRequests). */
  private peekBudget(chatId?: string): { allowed: boolean; reason?: string } {
    return this.evaluateBudget(chatId);
  }

  /** Core budget evaluation logic (pure check, no side effects). */
  private evaluateBudget(chatId?: string): { allowed: boolean; reason?: string } {
    this.pruneWindows();
    this.checkDailyReset();

    // Check requests per minute (include in-flight pending requests)
    if (this.config.requestsPerMinute && this.requestWindow.length + this.pendingRequests >= this.config.requestsPerMinute) {
      return { allowed: false, reason: `Rate limit: ${this.config.requestsPerMinute} req/min for ${this.providerId}` };
    }

    // Check tokens per minute
    if (this.config.tokensPerMinute) {
      const recentTokens = this.tokenWindow.tokenCounts.reduce((a, b) => a + b, 0);
      if (recentTokens >= this.config.tokensPerMinute) {
        return { allowed: false, reason: `Token limit: ${this.config.tokensPerMinute} tokens/min for ${this.providerId}` };
      }
    }

    // Check daily spend cap
    if (this.config.dailySpendCapUsd) {
      const estimatedSpend = this.estimateSpendUsd(this.dailyTokens);
      if (estimatedSpend >= this.config.dailySpendCapUsd) {
        return { allowed: false, reason: `Daily spend cap: $${this.config.dailySpendCapUsd} for ${this.providerId}` };
      }
    }

    // Check per-chat burst
    if (chatId && this.config.chatBurstLimit) {
      const chatWindow = this.chatRequestWindows.get(chatId) ?? [];
      if (chatWindow.length >= this.config.chatBurstLimit) {
        return { allowed: false, reason: `Chat burst limit: ${this.config.chatBurstLimit} req/min for chat` };
      }
    }

    return { allowed: true };
  }

  private pruneWindows(): void {
    // Safety: pendingRequests should never go negative
    if (this.pendingRequests < 0) {
      this.pendingRequests = 0;
    }
    const oneMinuteAgo = Date.now() - 60_000;

    this.requestWindow = this.requestWindow.filter(t => t > oneMinuteAgo);

    const validIndices: number[] = [];
    this.tokenWindow.timestamps.forEach((t, i) => {
      if (t > oneMinuteAgo) validIndices.push(i);
    });
    this.tokenWindow.timestamps = validIndices.map(i => this.tokenWindow.timestamps[i]);
    this.tokenWindow.tokenCounts = validIndices.map(i => this.tokenWindow.tokenCounts[i]);

    for (const [chatId, window] of this.chatRequestWindows) {
      const pruned = window.filter(t => t > oneMinuteAgo);
      if (pruned.length === 0) this.chatRequestWindows.delete(chatId);
      else this.chatRequestWindows.set(chatId, pruned);
    }
  }

  private checkDailyReset(): void {
    if (Date.now() >= this.dailyResetTime) {
      this.resetDaily();
    }
  }

  private getNextMidnight(): number {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
    return midnight.getTime();
  }

  // Callers should set appropriate rates via BudgetConfig.costPerMillionTokens:
  // Claude Opus ~$75/M, GPT-4o ~$5/M, local LLMs $0. Defaults to $3 (conservative blended).
  private estimateSpendUsd(tokens: number): number {
    const rate = this.config.costPerMillionTokens ?? 3;
    return (tokens / 1_000_000) * rate;
  }
}
