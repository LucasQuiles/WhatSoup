// src/transport/factory.ts
// Transport factory — constructs the correct RuntimeConnection based on config.transport.
// Registry header (src/transport/registry.ts:9-10) prescribes: add a case in the
// transport factory switch; TypeScript surfaces any miss via assertNeverTransport.

import { ConnectionManager } from './connection.ts';
import { TwilioConnection } from './twilio/connection-bridge.ts';
import { TwilioSmsAdapter } from './twilio/adapter.ts';
import { SdkTwilioSmsPort } from './twilio/twilio-port.ts';
import { SignalConnection } from './signal/connection-bridge.ts';
import { SignalAdapter } from './signal/adapter.ts';
import { SignalCliPort } from './signal/signal-cli-port.ts';
import { assertNeverTransport } from './registry.ts';
import type { RuntimeConnection } from './runtime-connection.ts';
import type { TransportId } from './registry.ts';
import type { TwilioSmsConfig } from './twilio/types.ts';
import type { SignalConfig } from './signal/types.ts';
import { TwilioWebhookServer } from './twilio/webhook-server.ts';
import { lookupCredential } from '../lib/keyring.ts';

export type { RuntimeConnection };

interface FactoryConfig {
  transport: TransportId;
  twilioConfig?: TwilioSmsConfig;
  signalConfig?: SignalConfig;
}

/**
 * Create the runtime connection for the configured transport.
 *
 * - 'baileys'  → new ConnectionManager() (Baileys WhatsApp socket)
 * - 'twilio'   → TwilioConnection wrapping TwilioSmsAdapter + SdkTwilioSmsPort
 * - 'signal'   → foundation stub; wiring lands in a follow-on phase
 * - 'imessage' → foundation stub; wiring lands in a follow-on phase
 * - unknown    → assertNeverTransport (compile-time exhaustiveness + runtime guard)
 *
 * The twilio arm fails loud if twilioConfig is missing; validation in
 * src/core/agent-config-validator.ts guarantees it is present when transport='twilio',
 * but defence-in-depth requires an explicit throw here.
 *
 * The signal and imessage arms are deliberately stub throws: the registry
 * recognises the IDs (so config validation, factory exhaustiveness, and
 * type-narrowing all see them), but constructing the connection requires the
 * adapter + port + bridge wiring that lands in subsequent phases. The stub
 * keeps the type system honest in the meantime — `default: assertNeverTransport`
 * would otherwise fail compilation because the narrowed union is non-empty.
 */
export function createConnection(config: FactoryConfig): RuntimeConnection {
  switch (config.transport) {
    case 'baileys':
      return new ConnectionManager();

    case 'twilio': {
      if (config.twilioConfig === undefined) {
        throw new Error(
          '[createConnection] transport is "twilio" but twilioConfig is undefined. ' +
          'Instance config must include a valid twilioConfig block.',
        );
      }
      // Validation rejects these upstream, but an unvalidated path (e.g. a
      // hand-injected INSTANCE_CONFIG) must still fail loud, not construct a
      // port with empty credentials.
      if (config.twilioConfig.accountSid === '' || config.twilioConfig.authTokenService === '') {
        throw new Error(
          '[createConnection] twilioConfig is missing accountSid or authTokenService.',
        );
      }
      const port = new SdkTwilioSmsPort(config.twilioConfig);
      const adapter = new TwilioSmsAdapter(config.twilioConfig, port);

      let webhookServer: TwilioWebhookServer | undefined;
      if (config.twilioConfig.inboundMode === 'webhook' && config.twilioConfig.webhook !== undefined) {
        const { webhook } = config.twilioConfig;
        webhookServer = new TwilioWebhookServer({
          getAuthToken: () => lookupCredential(config.twilioConfig!.authTokenService),
          publicBaseUrl: webhook.publicBaseUrl,
          listenPort: webhook.listenPort,
          listenAddress: webhook.listenAddress,
          voice: config.twilioConfig.voice ?? { enabled: false, voicemailMaxLengthSec: 120 },
          onSms: (r) => adapter.handleInboundRecord(r),
          onTranscript: (t) => adapter.handleTranscript(t),
        });
      }

      return new TwilioConnection(adapter, webhookServer);
    }

    case 'signal': {
      if (config.signalConfig === undefined) {
        throw new Error(
          '[createConnection] transport is "signal" but signalConfig is undefined. ' +
          'Instance config must include a valid signalConfig block.',
        );
      }
      // Validation rejects these upstream, but an unvalidated path (e.g. a
      // hand-injected INSTANCE_CONFIG) must still fail loud, not construct a
      // port with an empty self-number.
      if (config.signalConfig.phoneNumber === '') {
        throw new Error(
          '[createConnection] signalConfig is missing phoneNumber.',
        );
      }
      const port = new SignalCliPort(config.signalConfig);
      const adapter = new SignalAdapter(config.signalConfig, port);
      return new SignalConnection(adapter, port);
    }

    case 'imessage':
      // Foundation stub — adapter + port + bridge wiring lands in a follow-on
      // phase. The case exists so the TransportId union stays exhaustive
      // (otherwise assertNeverTransport's `never` argument fails typecheck).
      throw new Error(
        '[createConnection] imessage transport is registered but not yet implemented. ' +
        'Adapter/port/bridge wiring is pending; see the transport-signal-and-imessage plan.',
      );

    default:
      return assertNeverTransport(config.transport, 'createConnection');
  }
}
