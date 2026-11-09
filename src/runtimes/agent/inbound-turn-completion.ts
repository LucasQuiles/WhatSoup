interface InboundTurnCompletion {
  adopted: boolean;
  admissionPending: boolean;
  completion: Promise<void>;
  settle: () => void;
}

/** Tracks the terminal outcome of an authority-bound inbound turn. */
export class InboundTurnCompletionTracker {
  private readonly completions = new Map<string, InboundTurnCompletion>();

  begin(messageId: string): void {
    if (this.completions.has(messageId)) return;
    let resolved = false;
    let resolve!: () => void;
    const completion = new Promise<void>((done) => {
      resolve = done;
    });
    this.completions.set(messageId, {
      adopted: false,
      admissionPending: false,
      completion,
      settle: () => {
        if (resolved) return;
        resolved = true;
        resolve();
      },
    });
  }

  async await(messageId: string): Promise<void> {
    const pending = this.completions.get(messageId);
    if (!pending) return;
    try {
      await pending.completion;
    } finally {
      if (this.completions.get(messageId) === pending) {
        this.completions.delete(messageId);
      }
    }
  }

  bind(messageId: string): (() => void) | undefined {
    const pending = this.completions.get(messageId);
    if (!pending) return undefined;
    pending.adopted = true;
    return pending.settle;
  }

  holdForAdmission(messageId: string): (() => void) | undefined {
    const pending = this.completions.get(messageId);
    if (!pending) return undefined;
    pending.admissionPending = true;
    return () => {
      pending.admissionPending = false;
      if (!pending.adopted) pending.settle();
    };
  }

  settle(messageId: string): void {
    this.completions.get(messageId)?.settle();
  }

  settleUnadopted(messageId: string): void {
    const pending = this.completions.get(messageId);
    if (pending && !pending.adopted && !pending.admissionPending) pending.settle();
  }
}
