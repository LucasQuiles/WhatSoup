import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TERMINAL_AUTH_FAILURE_CLASSES,
  hasExplicitAuthLossSignal,
  isLoggedOutDisconnectReason,
  isTerminalAuthFailureClass,
} from '../../src/fleet/auth-loss-signals.ts';

function pythonSetMembers(source: string, pattern: RegExp): string[] {
  const match = source.match(pattern);
  expect(match, `missing Python set matching ${pattern}`).not.toBeNull();
  return Array.from((match?.[1] ?? '').matchAll(/["']([^"']+)["']/g), m => m[1]).sort();
}

describe('auth-loss signal classification', () => {
  it('recognizes explicit logged-out status codes without treating arbitrary values as terminal', () => {
    const withStatusCode = (lastStatusCode: unknown) =>
      hasExplicitAuthLossSignal({ lastStatusCode, lastDisconnectReason: null, authFailureClass: null });
    expect(withStatusCode(401)).toBe(true);
    expect(withStatusCode('401')).toBe(true);
    expect(withStatusCode(440)).toBe(false);
    expect(withStatusCode('401-ish')).toBe(false);
  });

  it('normalizes logged-out reason separators and casing', () => {
    expect(isLoggedOutDisconnectReason('loggedOut')).toBe(true);
    expect(isLoggedOutDisconnectReason('logged_out')).toBe(true);
    expect(isLoggedOutDisconnectReason('Logged Out')).toBe(true);
    expect(isLoggedOutDisconnectReason('connectionReplaced')).toBe(false);
  });

  it('recognizes only terminal auth failure classes', () => {
    expect(isTerminalAuthFailureClass('serverside_logout_irreversible')).toBe(true);
    expect(isTerminalAuthFailureClass('PAIRING_REQUIRED')).toBe(true);
    expect(isTerminalAuthFailureClass('none')).toBe(false);
    expect(isTerminalAuthFailureClass('provider_auth_required')).toBe(false);
  });

  it('requires at least one explicit auth-loss signal', () => {
    expect(hasExplicitAuthLossSignal({
      lastStatusCode: 440,
      lastDisconnectReason: 'connectionReplaced',
      authFailureClass: 'none',
    })).toBe(false);
    expect(hasExplicitAuthLossSignal({
      lastStatusCode: null,
      lastDisconnectReason: null,
      authFailureClass: 'pairing_required',
    })).toBe(true);
  });

  it('keeps deployment health-check terminal auth classes aligned with the TypeScript classifier', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'deploy/scripts/bot-errors-health-check.py'),
      'utf8',
    );
    expect(pythonSetMembers(
      source,
      /TERMINAL_AUTH_FAILURE_CLASSES\s*=\s*\{([^}]+)\}/,
    )).toEqual([...TERMINAL_AUTH_FAILURE_CLASSES].sort());
  });

  it('keeps dispatcher physical-intervention evidence aligned with terminal auth classes', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'deploy/scripts/bot-errors-dispatcher.py'),
      'utf8',
    );
    expect(pythonSetMembers(
      source,
      /TERMINAL_AUTH_FAILURE_CLASSES\s*=\s*\{([^}]+)\}/,
    )).toEqual([...TERMINAL_AUTH_FAILURE_CLASSES].sort());
  });

  it('keeps heartbeat watchdog terminal auth classes aligned with the TypeScript classifier', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'deploy/scripts/bot-errors-heartbeat-watchdog.py'),
      'utf8',
    );
    expect(pythonSetMembers(
      source,
      /TERMINAL_AUTH_FAILURE_CLASSES\s*=\s*\{([^}]+)\}/,
    )).toEqual([...TERMINAL_AUTH_FAILURE_CLASSES].sort());
  });
});
