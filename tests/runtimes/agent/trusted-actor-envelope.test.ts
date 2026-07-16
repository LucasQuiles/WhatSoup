import { describe, expect, it, vi } from 'vitest';
import {
  composeTrustedActorTurn,
  type TrustedActorAccessClass,
} from '../../../src/runtimes/agent/trusted-actor-envelope.ts';
import { SessionManager } from '../../../src/runtimes/agent/session.ts';

describe('composeTrustedActorTurn', () => {
  it.each<TrustedActorAccessClass>([
    'administrator',
    'authorized_user',
    'untrusted_or_unknown',
    'system',
  ])('adds only the trusted access enum for %s', (actorAccess) => {
    const message = 'review the queue';
    const composed = composeTrustedActorTurn(message, actorAccess);

    expect(composed).toContain('trusted transport metadata');
    expect(composed).toContain(`actor_access=${actorAccess}`);
    expect(composed).toContain(message);
    expect(composed).not.toMatch(/@(?:lid|s\.whatsapp\.net|g\.us)/);
    expect(composed).not.toMatch(/adminPhones|\+?1\d{10}/);
  });

  it('does not retain the previous actor classification across consecutive turns', () => {
    const admin = composeTrustedActorTurn('first', 'administrator');
    const unknown = composeTrustedActorTurn('second', 'untrusted_or_unknown');

    expect(admin).toContain('actor_access=administrator');
    expect(unknown).toContain('actor_access=untrusted_or_unknown');
    expect(unknown).not.toContain('actor_access=administrator');
  });
});

describe('SessionManager.sendTrustedActorTurn', () => {
  it('composes the per-turn envelope before using the normal provider path', async () => {
    const manager = Object.create(SessionManager.prototype) as SessionManager;
    const sendTurn = vi.spyOn(manager, 'sendTurn').mockResolvedValue(undefined);

    await manager.sendTrustedActorTurn('inspect status', 'administrator');

    expect(sendTurn).toHaveBeenCalledOnce();
    expect(sendTurn).toHaveBeenCalledWith(expect.stringContaining('actor_access=administrator'));
    expect(sendTurn).toHaveBeenCalledWith(expect.stringContaining('inspect status'));
  });
});
