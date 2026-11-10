import { ACCOUNT_RE, E164_RE } from './transport-refs.ts';
import type { ValidationError } from './agent-config-validator.ts';

function err(field: string, message: string): ValidationError {
  return { field, message, status: 400 };
}

export function validateSignalConfig(sc: Record<string, unknown>): ValidationError | null {
  const account = sc['account'];
  if (typeof account !== 'string' || !ACCOUNT_RE.test(account)) {
    return err(
      'signalConfig.account',
      'signalConfig.account must be a non-empty lowercase alphanumeric-and-dash string starting with a letter',
    );
  }
  const phoneNumber = sc['phoneNumber'];
  if (typeof phoneNumber !== 'string' || !E164_RE.test(phoneNumber)) {
    return err('signalConfig.phoneNumber', 'signalConfig.phoneNumber must be an E.164 number (e.g. +15559990000)');
  }
  const socketPath = sc['socketPath'];
  if (socketPath !== undefined && (typeof socketPath !== 'string' || socketPath === '' || !socketPath.startsWith('/'))) {
    return err('signalConfig.socketPath', 'signalConfig.socketPath must be an absolute path when set');
  }
  const tcpPort = sc['tcpPort'];
  if (tcpPort !== undefined && (typeof tcpPort !== 'number' || !Number.isInteger(tcpPort) || tcpPort < 1 || tcpPort > 65535)) {
    return err('signalConfig.tcpPort', 'signalConfig.tcpPort must be an integer between 1 and 65535');
  }
  if (socketPath !== undefined && tcpPort !== undefined) {
    return err('signalConfig', 'signalConfig must select exactly one of socketPath or tcpPort, not both');
  }
  const tcpHost = sc['tcpHost'];
  if (tcpHost !== undefined && (typeof tcpHost !== 'string' || tcpHost === '')) {
    return err('signalConfig.tcpHost', 'signalConfig.tcpHost must be a non-empty string');
  }
  if (tcpHost !== undefined && tcpPort === undefined) {
    return err('signalConfig.tcpHost', 'signalConfig.tcpHost requires signalConfig.tcpPort');
  }
  if (socketPath === undefined && tcpPort === undefined) {
    return err('signalConfig', 'signalConfig must select exactly one of socketPath or tcpPort');
  }
  if (tcpHost !== undefined && tcpHost !== '127.0.0.1' && tcpHost !== '::1' && tcpHost !== 'localhost') {
    return err('signalConfig.tcpHost', 'signalConfig.tcpHost must be a loopback host because signal-cli TCP is plaintext');
  }
  const inboundMode = sc['inboundMode'];
  if (inboundMode !== undefined && inboundMode !== 'poll') {
    return err('signalConfig.inboundMode', "signalConfig.inboundMode must be 'poll'; streaming is not implemented");
  }
  const pollIntervalMs = sc['pollIntervalMs'];
  if (
    pollIntervalMs !== undefined
    && (
      typeof pollIntervalMs !== 'number'
      || !Number.isInteger(pollIntervalMs)
      || pollIntervalMs <= 0
      || pollIntervalMs > 2_147_483_647
    )
  ) {
    return err('signalConfig.pollIntervalMs', 'signalConfig.pollIntervalMs must be a positive 32-bit timer integer');
  }
  const rateLimit = sc['rateLimit'];
  if (rateLimit !== undefined) {
    if (typeof rateLimit !== 'object' || rateLimit === null || Array.isArray(rateLimit)) {
      return err('signalConfig.rateLimit', 'signalConfig.rateLimit must be an object');
    }
    const messagesPerMinute = (rateLimit as Record<string, unknown>)['messagesPerMinute'];
    if (
      typeof messagesPerMinute !== 'number'
      || !Number.isInteger(messagesPerMinute)
      || messagesPerMinute < 1
      || messagesPerMinute > 600
    ) {
      return err('signalConfig.rateLimit.messagesPerMinute', 'signalConfig.rateLimit.messagesPerMinute must be an integer between 1 and 600');
    }
  }
  return null;
}
