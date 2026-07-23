import { describe, expect, it } from 'vitest';
import { parseImsgRpcRelayArgs } from '../../scripts/imsg-rpc-relay.ts';

describe('imsg rpc relay CLI', () => {
  it('requires explicit socket and binary paths', () => {
    expect(parseImsgRpcRelayArgs([
      '--socket', '/var/tmp/whatsoup-test/imsg.sock',
      '--imsg-bin', '/opt/homebrew/bin/imsg',
    ])).toEqual({
      socketPath: '/var/tmp/whatsoup-test/imsg.sock',
      imsgBinary: '/opt/homebrew/bin/imsg',
    });
    expect(() => parseImsgRpcRelayArgs(['--socket', '/tmp/imsg.sock'])).toThrow(/usage/);
    expect(() => parseImsgRpcRelayArgs(['--unknown', 'value'])).toThrow(/unknown/);
  });
});
