import type { RuntimeConnection } from '../../../../src/transport/runtime-connection.ts';
import { SignalAdapter } from '../../../../src/transport/signal/adapter.ts';
import { SignalConnection } from '../../../../src/transport/signal/connection-bridge.ts';
import { ImessageAdapter } from '../../../../src/transport/imessage/adapter.ts';
import { ImessageConnection } from '../../../../src/transport/imessage/connection-bridge.ts';
import { TwilioSmsAdapter } from '../../../../src/transport/twilio/adapter.ts';
import { TwilioConnection } from '../../../../src/transport/twilio/connection-bridge.ts';
import { MockSignalPort, makeSignalConfig } from '../../../transport/signal/mock-port.ts';
import { MockImessagePort, makeImessageConfig } from '../../../transport/imessage/mock-port.ts';
import { MockTwilioSmsPort } from '../../../../src/transport/twilio/testing/mock-port.ts';
import { makeTwilioConfig } from '../../../transport/twilio/helpers.ts';

export interface TransportIdentityFixture {
  connection: RuntimeConnection;
  inbound(text: string): void;
  echo(id: string, text: string): void;
  sends(): number;
}

/** Real adapters and bridges; only the provider I/O port is substituted. */
export function transportIdentityFixture(
  kind: 'signal' | 'sms' | 'imessage',
  peer: string,
  group = false,
): TransportIdentityFixture {
  let sequence = 1_800_000_000_000;
  if (kind === 'signal') {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 60_000 }), port);
    const connection = new SignalConnection(adapter);
    const record = (text: string, fromMe: boolean, timestamp: number): void => {
      adapter.handleInboundRecord({
        timestamp, body: text, fromMe, type: fromMe ? 'sync' : 'data',
        source: fromMe ? '+15551234567' : group ? '+15550008101' : peer,
        destination: fromMe || group ? peer : '+15551234567',
        ...(group ? { groupId: peer } : {}),
      });
    };
    return { connection, inbound: (text) => record(text, false, ++sequence),
      echo: (id, text) => record(text, true, Number(id)), sends: () => port.sent.length };
  }
  if (kind === 'imessage') {
    const port = new MockImessagePort();
    const adapter = new ImessageAdapter(makeImessageConfig(), port);
    const connection = new ImessageConnection(adapter, port);
    const record = (text: string, fromMe: boolean, guid: string): void => {
      adapter.handleInboundRecord({
        guid, body: text, fromMe, kind: 'text', timestamp: ++sequence,
        from: fromMe ? 'bot@example.com' : group ? 'person@example.test' : peer,
        to: fromMe || group ? peer : 'bot@example.com',
        ...(group ? { chatGuid: peer } : {}),
      });
    };
    return { connection, inbound: (text) => record(text, false, `inbound-${++sequence}`),
      echo: (id, text) => record(text, true, id), sends: () => port.sent.length };
  }
  const port = new MockTwilioSmsPort();
  const adapter = new TwilioSmsAdapter(makeTwilioConfig({ phoneNumber: '+15551234567' }), port);
  const connection = new TwilioConnection(adapter);
  const record = (text: string, fromMe: boolean, sid: string): void => {
    adapter.handleInboundRecord({
      sid, body: text, fromMe, sentAt: new Date(++sequence),
      from: fromMe ? '+15551234567' : peer, to: fromMe ? peer : '+15551234567',
    });
  };
  return { connection, inbound: (text) => record(text, false, `SM-inbound-${++sequence}`),
    echo: (id, text) => record(text, true, id), sends: () => port.sent.length };
}
