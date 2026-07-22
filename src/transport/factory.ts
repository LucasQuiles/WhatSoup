// src/transport/factory.ts
// Transport factory — constructs the correct RuntimeConnection based on config.transport.
// Registry header (src/transport/registry.ts:9-10) prescribes: add a case in the
// transport factory switch; TypeScript surfaces any miss via assertNeverTransport.

import { ConnectionManager } from './connection.ts';
import { TwilioConnection } from './twilio/connection-bridge.ts';
import { TwilioSmsAdapter } from './twilio/adapter.ts';
import { SdkTwilioSmsPort } from './twilio/twilio-port.ts';
import { ImessageConnection } from './imessage/connection-bridge.ts';
import { ImessageAdapter } from './imessage/adapter.ts';
import { BlueBubblesPort } from './imessage/bluebubbles-port.ts';
import { ImsgPort } from './imessage/imsg-port.ts';
import { SignalConnection } from './signal/connection-bridge.ts';
import { SignalAdapter } from './signal/adapter.ts';
import { SignalCliPort } from './signal/signal-cli-port.ts';
import { assertNeverTransport } from './registry.ts';
import type { RuntimeConnection } from './runtime-connection.ts';
import type { TransportId } from './registry.ts';
import type { TwilioSmsConfig } from './twilio/types.ts';
import type { ImessageConfig } from './imessage/types.ts';
import type { ImessagePort } from './imessage/port.ts';
import type { SignalConfig } from './signal/types.ts';
import { TwilioWebhookServer } from './twilio/webhook-server.ts';
import { lookupCredential } from '../lib/keyring.ts';
import { isBluebubblesPasswordServiceForAccount, isTrustedBluebubblesUrl } from '../lib/bluebubbles-config.ts';
import { canonicalizeImessageDirectIdentity } from '../core/transport-refs.ts';
import { twilioAuthTokenServiceForAccount } from '../lib/twilio-config.ts';

export type { RuntimeConnection };

interface FactoryConfig {
  transport: TransportId;
  botName?: string;
  twilioConfig?: TwilioSmsConfig;
  imessageConfig?: ImessageConfig;
  signalConfig?: SignalConfig;
}

function assertAccountMatchesLine(
  transport: Exclude<TransportId, 'baileys'>,
  account: string,
  botName: string | undefined,
): asserts botName is string {
  if (botName === undefined || botName === '') {
    throw new Error(`[createConnection] ${transport} requires immutable line identity (botName).`);
  }
  if (account !== botName) {
    throw new Error(`[createConnection] ${transport} account must match the immutable line identity.`);
  }
}

/**
 * Create the runtime connection for the configured transport.
 *
 * - 'baileys'  → new ConnectionManager() (Baileys WhatsApp socket)
 * - 'twilio'   → TwilioConnection wrapping TwilioSmsAdapter + SdkTwilioSmsPort
 * - 'signal'   → SignalConnection wrapping SignalAdapter + SignalCliPort
 * - 'imessage' → ImessageConnection wrapping its configured backend adapter
 * - unknown    → assertNeverTransport (compile-time exhaustiveness + runtime guard)
 *
 * The twilio arm fails loud if twilioConfig is missing; validation in
 * src/core/agent-config-validator.ts guarantees it is present when transport='twilio',
 * but defence-in-depth requires an explicit throw here.
 *
 * The imessage arm is fully wired as well; each non-Baileys arm validates its
 * required transport config before constructing provider-specific objects.
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
      assertAccountMatchesLine('twilio', config.twilioConfig.account, config.botName);
      // Validation rejects these upstream, but an unvalidated path (e.g. a
      // hand-injected INSTANCE_CONFIG) must still fail loud, not construct a
      // port with empty credentials.
      if (config.twilioConfig.accountSid === '' || config.twilioConfig.authTokenService === '') {
        throw new Error(
          '[createConnection] twilioConfig is missing accountSid or authTokenService.',
        );
      }
      const expectedAuthTokenService = twilioAuthTokenServiceForAccount(config.botName);
      if (expectedAuthTokenService === null) {
        throw new Error('[createConnection] twilio requires a valid immutable line identity.');
      }
      if (config.twilioConfig.authTokenService !== expectedAuthTokenService) {
        throw new Error(
          `[createConnection] twilioConfig.authTokenService must be ${expectedAuthTokenService}.`,
        );
      }
      const twilioConfig = { ...config.twilioConfig };
      const port = new SdkTwilioSmsPort(twilioConfig);
      const adapter = new TwilioSmsAdapter(twilioConfig, port);

      let webhookServer: TwilioWebhookServer | undefined;
      if (twilioConfig.inboundMode === 'webhook' && twilioConfig.webhook !== undefined) {
        const { webhook } = twilioConfig;
        webhookServer = new TwilioWebhookServer({
          getAuthToken: () => lookupCredential(expectedAuthTokenService),
          publicBaseUrl: webhook.publicBaseUrl,
          listenPort: webhook.listenPort,
          listenAddress: webhook.listenAddress,
          voice: twilioConfig.voice ?? { enabled: false, voicemailMaxLengthSec: 120 },
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
      assertAccountMatchesLine('signal', config.signalConfig.account, config.botName);
      if (config.signalConfig.phoneNumber === '') {
        throw new Error('[createConnection] signalConfig is missing phoneNumber.');
      }
      const port = new SignalCliPort(config.signalConfig);
      const adapter = new SignalAdapter(config.signalConfig, port);
      return new SignalConnection(adapter, port, config.botName);
    }

    case 'imessage': {
      if (config.imessageConfig === undefined) {
        throw new Error(
          '[createConnection] transport is "imessage" but imessageConfig is undefined. ' +
          'Instance config must include a valid imessageConfig block.',
        );
      }
      assertAccountMatchesLine('imessage', config.imessageConfig.account, config.botName);
      // Validation rejects these upstream, but an unvalidated path (e.g. a
      // hand-injected INSTANCE_CONFIG) must still fail loud.
      if (config.imessageConfig.sender === '') {
        throw new Error(
          '[createConnection] imessageConfig is missing sender.',
        );
      }
      if (canonicalizeImessageDirectIdentity(config.imessageConfig.sender) !== config.imessageConfig.sender) {
        throw new Error(
          '[createConnection] imessageConfig.sender must be a lowercase AppleID email or E.164 phone number.',
        );
      }

      let port: ImessagePort;
      if (config.imessageConfig.backend === 'bluebubbles') {
        if (config.imessageConfig.imsgSocketPath !== undefined) {
          throw new Error('[createConnection] imessageConfig.imsgSocketPath is only valid with the imsg backend.');
        }
        const pwService = config.imessageConfig.bluebubblesPasswordService;
        if (pwService === undefined || pwService === '') {
          throw new Error(
            '[createConnection] imessageConfig.backend is "bluebubbles" but bluebubblesPasswordService is missing.',
          );
        }
        if (!isBluebubblesPasswordServiceForAccount(pwService, config.botName)) {
          throw new Error('[createConnection] BlueBubbles credential service is not bound to this line.');
        }
        if (!isTrustedBluebubblesUrl(config.imessageConfig.bluebubblesUrl ?? '')) {
          throw new Error('[createConnection] BlueBubbles endpoint is untrusted; use HTTPS or a loopback HTTP URL.');
        }
        // Resolve the credential here (composition root side), never in the
        // port — mirrors the Twilio arm's keyring-at-factory pattern. A
        // missing credential fails loud rather than constructing a port
        // that 401s on every call.
        const bluebubblesPassword = lookupCredential(pwService);
        if (bluebubblesPassword === null) {
          throw new Error(
            `[createConnection] keyring has no credential for service "${pwService}" ` +
            '(imessageConfig.bluebubblesPasswordService).',
          );
        }
        port = new BlueBubblesPort({ ...config.imessageConfig, bluebubblesPassword });
      } else if (config.imessageConfig.backend === 'imsg') {
        if (
          config.imessageConfig.bluebubblesUrl !== undefined
          || config.imessageConfig.bluebubblesPasswordService !== undefined
          || config.imessageConfig.bluebubblesPassword !== undefined
        ) {
          throw new Error('[createConnection] BlueBubbles fields are only valid with the bluebubbles backend.');
        }
        port = new ImsgPort(config.imessageConfig);
      } else {
        throw new Error('[createConnection] imessageConfig.backend must be "imsg" or "bluebubbles".');
      }

      const adapter = new ImessageAdapter(config.imessageConfig, port);
      return new ImessageConnection(adapter);
    }

    default:
      return assertNeverTransport(config.transport, 'createConnection');
  }
}
