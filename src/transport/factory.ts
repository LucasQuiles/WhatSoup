// src/transport/factory.ts
// Transport factory — constructs the correct RuntimeConnection based on config.transport.
// Registry header (src/transport/registry.ts:9-10) prescribes: add a case in the
// transport factory switch; TypeScript surfaces any miss via assertNeverTransport.

import { ConnectionManager } from './connection.ts';
import { TwilioConnection } from './twilio/connection-bridge.ts';
import { TwilioSmsAdapter } from './twilio/adapter.ts';
import { SdkTwilioSmsPort } from './twilio/twilio-port.ts';
import { assertNeverTransport } from './registry.ts';
import type { RuntimeConnection } from './runtime-connection.ts';
import type { TransportId } from './registry.ts';
import type { TwilioSmsConfig } from './twilio/types.ts';

export type { RuntimeConnection };

interface FactoryConfig {
  transport: TransportId;
  twilioConfig?: TwilioSmsConfig;
}

/**
 * Create the runtime connection for the configured transport.
 *
 * - 'baileys' → new ConnectionManager() (Baileys WhatsApp socket)
 * - 'twilio'  → TwilioConnection wrapping TwilioSmsAdapter + SdkTwilioSmsPort
 * - unknown   → assertNeverTransport (compile-time exhaustiveness + runtime guard)
 *
 * The twilio arm fails loud if twilioConfig is missing; validation in
 * src/core/agent-config-validator.ts guarantees it is present when transport='twilio',
 * but defence-in-depth requires an explicit throw here.
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
      const port = new SdkTwilioSmsPort(config.twilioConfig);
      const adapter = new TwilioSmsAdapter(config.twilioConfig, port);
      return new TwilioConnection(adapter);
    }

    default:
      return assertNeverTransport(config.transport, 'createConnection');
  }
}
