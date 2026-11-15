import { z } from 'zod';
import { resolvePhoneFromJidForGrant } from '../../core/access-list.ts';
import type { Database } from '../../core/database.ts';
import {
  ProtectedDeliveryService,
  type ProtectedDeliveryPurpose,
} from '../../core/protected-delivery.ts';
import { isGroupJid, isLidJid, JID_PERSONAL } from '../../core/jid-constants.ts';
import { resolveLid } from '../../core/lid-resolver.ts';
import { EXTERNAL_EFFECT_CONTRACT_VERSION } from '../external-effect.ts';
import type { ToolRegistry } from '../registry.ts';
import type { SessionContext } from '../types.ts';

export function registerProtectedDeliveryTools(
  registry: ToolRegistry,
  deps: { db: Database; service: ProtectedDeliveryService },
): void {
  registry.register({
    name: 'request_rustdesk_access',
    description: 'Request an opaque, time-limited RustDesk access delivery for this direct conversation.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    externalEffect: { version: EXTERNAL_EFFECT_CONTRACT_VERSION, kind: 'external' },
    schema: z.object({
      chatJid: z.string(),
      device_id: z.string().min(1).max(256),
      purpose: z.enum(['login', 'recovery']),
    }).strict(),
    handler: async (params, session) => {
      const identity = directRecipient(session, deps.db);
      return deps.service.requestRustdeskAccess({
        deviceId: params['device_id'] as string,
        purpose: params['purpose'] as ProtectedDeliveryPurpose,
        principal: identity.principal,
        recipientJid: identity.recipientJid,
      });
    },
  });

  registry.register({
    name: 'deliver_secret',
    description: 'Deliver an already-staged protected delivery to this direct conversation.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    externalEffect: { version: EXTERNAL_EFFECT_CONTRACT_VERSION, kind: 'external' },
    schema: z.object({
      chatJid: z.string(),
      delivery_ref: z.string().min(1).max(512),
    }).strict(),
    handler: async (params, session) => {
      const identity = directRecipient(session, deps.db);
      return deps.service.deliver({
        deliveryRef: params['delivery_ref'] as string,
        principal: identity.principal,
        recipientJid: identity.recipientJid,
      });
    },
  });

  registry.register({
    name: 'get_secret_delivery_status',
    description: 'Get metadata-only status for a protected delivery in this direct conversation.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'read_only',
    externalEffect: { version: EXTERNAL_EFFECT_CONTRACT_VERSION, kind: 'none' },
    schema: z.object({
      chatJid: z.string(),
      delivery_id: z.string().min(1).max(512),
    }).strict(),
    handler: async (params, session) => {
      const identity = directRecipient(session, deps.db);
      return deps.service.status({
        deliveryId: params['delivery_id'] as string,
        principal: identity.principal,
      });
    },
  });
}

function directRecipient(session: SessionContext, db: Database): { principal: string; recipientJid: string } {
  // As send_message does, a refused session token (other socket, revoked lease) never reaches a
  // protected delivery. A token that was presented and matched but no longer binds is refused too.
  // Every socket request carries a binding callback that also answers undefined when no token was
  // presented; such a tokenless caller stays accepted, as it is for send_message.
  const attribution = session.callerAttribution;
  const matchedTokenUnbound = attribution?.transport === 'socket' && attribution.tokenResult === 'match'
    && session.tokenBinding !== undefined && session.tokenBinding() === undefined;
  if (session.sessionTokenRefusal !== undefined || matchedTokenUnbound) {
    throw new Error('protected delivery requires an accepted session token');
  }
  const actorJid = session.actorJid;
  const recipientJid = session.binding?.deliveryJid
    ?? (session.tier === 'chat-scoped' ? session.deliveryJid : undefined);
  if (!actorJid || !recipientJid || isGroupJid(actorJid) || isGroupJid(recipientJid)) {
    throw new Error('protected delivery requires an authenticated, bound direct conversation');
  }
  const principal = resolvePhoneFromJidForGrant(actorJid, db);
  const recipientPrincipal = resolvePhoneFromJidForGrant(recipientJid, db);
  if (
    principal === null
    || recipientPrincipal === null
    || (isLidJid(actorJid) && resolveLid(db, actorJid.split('@', 1)[0]) === null)
    || (isLidJid(recipientJid) && resolveLid(db, recipientJid.split('@', 1)[0]) === null)
  ) {
    throw new Error('protected delivery requires resolved WhatsApp direct identities');
  }
  if (principal !== recipientPrincipal) {
    throw new Error('protected delivery requires the actor and direct recipient to match');
  }
  return { principal, recipientJid: principal + JID_PERSONAL };
}
