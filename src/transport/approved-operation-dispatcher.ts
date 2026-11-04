import { withTransportInboundContext } from '../core/transport-inbound-context.ts';
import { MS_PER_SECOND } from '../lib/time-units.ts';
import type { OperationsAuthorityPort } from './operations-authority-client.ts';
import { retryApprovedWhatsappOperations } from './operations-authority-gate.ts';
import { runWithTransportSendDeadline } from './send-deadline.ts';

interface ApprovedDispatcherOptions {
  accountId: string;
  authority: Pick<OperationsAuthorityPort, 'readyOperations' | 'readyOperation'>;
  send(recipient: string, content: unknown, options?: Record<string, unknown>): Promise<unknown>;
  onError(error: unknown, operationId?: string): void;
}

/** Discover approved work; only the final transport seam can claim it. */
export class ApprovedOperationDispatcher {
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly options: ApprovedDispatcherOptions;

  constructor(options: ApprovedDispatcherOptions) {
    this.options = options;
  }

  start(): void {
    if (this.controller !== null) return;
    const controller = new AbortController();
    this.controller = controller;
    withTransportInboundContext(undefined, () => { void this.run(controller); });
  }

  stop(): void {
    this.controller?.abort();
    this.controller = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private report(error: unknown, operationId?: string): void {
    try {
      this.options.onError(error, operationId);
    } catch {
      this.stop();
      process.emitWarning('Approved transport dispatcher stopped because error reporting failed.',
        { code: 'TRANSPORT_DISPATCH_REPORTING_FAILED' });
    }
  }

  private async run(controller: AbortController): Promise<void> {
    const current = () => this.controller === controller && !controller.signal.aborted;
    try {
      const references = await this.options.authority.readyOperations(controller.signal);
      for (const reference of references) {
        if (!current()) return;
        try {
          const operation = await this.options.authority.readyOperation(reference, controller.signal);
          if (!current()) return;
          await runWithTransportSendDeadline(() => retryApprovedWhatsappOperations({
            accountId: this.options.accountId,
            operations: [operation],
            send: this.options.send,
          }), controller.signal);
        } catch (error) {
          if (current()) this.report(error, reference.id);
        }
      }
    } catch (error) {
      if (current()) this.report(error);
    } finally {
      if (current()) {
        this.timer = setTimeout(() => { void this.run(controller); }, MS_PER_SECOND);
        this.timer.unref?.();
      }
    }
  }
}
