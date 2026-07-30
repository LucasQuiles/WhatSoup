import { UnsupportedTransportOperationError } from '../unsupported-operation.ts';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, OutboundMedia, SendOptions, SubmissionReceipt, TypingState } from '../../core/types.ts';
import { ContactsDirectory } from '../../core/mentions.ts';
import { applyOutboundIdentityGuard } from '../../core/outbound-identity/guard.ts';
import type { GuardMode, IdentityStore } from '../../core/outbound-identity/types.ts';
import { fromSignalJid, toSignalJid } from '../../core/jid-constants.ts';
import { createChildLogger } from '../../logger.ts';
import { clearAlertSourceChecked, emitAlertChecked } from '../../lib/emit-alert.ts';
import type { ConnectionStateSnapshot, WhatsAppSocket } from '../connection.ts';
import type { InboundMessage as ContractInboundMessage } from '../contract/events.ts';
import type { Subscription } from '../contract/subscription.ts';
import { PresenceCache } from '../presence-cache.ts';
import type { RuntimeConnection } from '../runtime-connection.ts';
import { emptyConnectionStateSnapshot } from '../twilio/connection-snapshot.ts';
import type { SignalAdapter } from './adapter.ts';

interface DisposableSignalPort {
  dispose(): void;
}

// #2202: the canonical error lives in transport/unsupported-operation.ts.
// Re-exported here so existing importers of this module keep working.
export { UnsupportedTransportOperationError };

/** Build the Signal-flavoured unsupported-operation error. */
function unsupported(operation: string): UnsupportedTransportOperationError {
  return new UnsupportedTransportOperationError('SignalConnection', 'Signal', operation);
}

function contractToIncoming(message: ContractInboundMessage, isGroup: boolean): IncomingMessage {
  return {
    // signal-cli uses a millisecond timestamp as the provider message ID. It
    // is not globally unique: different senders/conversations can legitimately
    // share it. Persist inbound deliveries under the adapter's composite key,
    // while preserving the raw provider ID for from-me sync echoes so the
    // durability engine can still correlate them with the original send.
    messageId: message.fromMe
      ? message.ref.id
      : `signal:${message.inboundEventKey}`,
    chatJid: toSignalJid(message.conversation.id),
    senderJid: toSignalJid(message.sender.id),
    senderName: null,
    content: message.text,
    contentText: null,
    contentType: 'text',
    isFromMe: message.fromMe,
    isGroup,
    mentionedJids: [],
    timestamp: Math.floor(message.timestamp.getTime() / 1000),
    quotedMessageId: message.inReplyTo?.id ?? null,
    isResponseWorthy: message.text !== null && message.text.trim().length > 0,
  };
}

export class SignalConnection extends EventEmitter implements RuntimeConnection {
  botJid: string | null = null;
  botLid: string | null = null;
  onMessage: ((message: IncomingMessage) => void) | null = null;
  readonly contactsDir = new ContactsDirectory();
  readonly presenceCache = new PresenceCache();

  private readonly adapter: SignalAdapter;
  private readonly port: DisposableSignalPort | null;
  private readonly instanceName: string;
  private readonly log = createChildLogger('signal-bridge');
  private messageSubscription: Subscription | null = null;
  private errorSubscription: Subscription | null = null;
  private identityStore: IdentityStore | null = null;
  private identityMode: GuardMode = 'log-only';
  private unregisteredAlertEmitted = false;

  constructor(
    adapter: SignalAdapter,
    port?: DisposableSignalPort,
    instanceName = 'signal',
  ) {
    super();
    this.adapter = adapter;
    this.port = port ?? null;
    this.instanceName = instanceName;
  }

  setIdentityStore(store: IdentityStore, mode: GuardMode): void {
    this.identityStore = store;
    this.identityMode = mode;
  }

  async connect(): Promise<void> {
    try {
      await this.adapter.connect();
    } catch (error) {
      this.emitUnregisteredAlert(error);
      throw error;
    }
    clearAlertSourceChecked(
      this.instanceName,
      'signal_cli_unregistered',
      'signal-cli account verification recovered',
    );
    this.unregisteredAlertEmitted = false;
    this.botJid = toSignalJid(this.adapter.selfRef().id);

    this.messageSubscription?.dispose();
    this.messageSubscription = this.adapter.on('message', (message) => {
      this.onMessage?.(
        contractToIncoming(
          message,
          this.adapter.isGroupConversation(message.conversation),
        ),
      );
    });

    this.errorSubscription?.dispose();
    this.errorSubscription = this.adapter.on('error', (error) => {
      const payload = error.payload;
      this.log.error(
        {
          code: payload.code,
          operation: payload.operation,
          correlationId: payload.correlationId,
          retryable: payload.retryable,
          providerCode: payload.providerCode,
          channelId: payload.channelId,
          scope: payload.scope,
        },
        'signal transport operation failed',
      );
      this.emitUnregisteredAlert(error);
    });

    setImmediate(() => this.emit('historySyncComplete'));
  }

  private emitUnregisteredAlert(error: unknown): void {
    const payload = (error as { payload?: { code?: unknown; providerCode?: unknown } })?.payload;
    if (payload?.code !== 'transport.auth_required' || this.unregisteredAlertEmitted) return;
    this.unregisteredAlertEmitted = emitAlertChecked(
      this.instanceName,
      'signal_cli_unregistered',
      'Signal transport requires external signal-cli account repair',
      JSON.stringify({
        operation: 'signal_account_verification',
        providerCode: typeof payload.providerCode === 'string'
          ? payload.providerCode
          : 'unknown',
        redaction: 'phone and identity values omitted',
      }),
      'critical',
    );
  }

  async shutdown(): Promise<void> {
    this.messageSubscription?.dispose();
    this.messageSubscription = null;
    this.errorSubscription?.dispose();
    this.errorSubscription = null;
    this.port?.dispose();
    await this.adapter.disconnect();
  }

  async sendMessage(chatJid: string, text: string, opts?: SendOptions): Promise<SubmissionReceipt> {
    applyOutboundIdentityGuard(
      chatJid,
      { caller: opts?.caller ?? 'agent', mode: this.identityMode },
      this.identityStore,
    );
    const ref = await this.adapter.sendText(
      {
        channel: this.adapter.capabilities.channel,
        id: fromSignalJid(chatJid),
      },
      text,
    );
    return { waMessageId: ref.id };
  }

  async setTyping(chatJid: string, typing: TypingState): Promise<void> {
    await this.adapter.setTyping(
      {
        channel: this.adapter.capabilities.channel,
        id: fromSignalJid(chatJid),
      },
      typing !== 'paused' && typing !== false,
    );
  }

  async sendMedia(_chatJid: string, _media: OutboundMedia): Promise<SubmissionReceipt> {
    throw unsupported('sendMedia');
  }

  getSocket(): WhatsAppSocket | null {
    return null;
  }

  getConnectionState(): ConnectionStateSnapshot {
    const health = this.adapter.state();
    return emptyConnectionStateSnapshot({
      connected: health.state === 'connected',
      stateChangedAt: health.since.toISOString(),
      lastDisconnectReason: health.reasonCode ?? null,
    });
  }

  async sendRaw(
    _chatJid: string,
    _content: Record<string, unknown>,
  ): Promise<SubmissionReceipt> {
    throw unsupported('sendRaw');
  }

  async sendPollMessage(
    _chatJid: string,
    _name: string,
    _values: string[],
    _selectableCount: number,
  ): Promise<{ waMessageId: string | null; hasSecret: boolean }> {
    throw unsupported('sendPollMessage');
  }
}
