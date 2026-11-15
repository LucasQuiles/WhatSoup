import { z } from 'zod';
import { resolvePhoneFromJidForGrant } from '../../core/access-list.ts';
import type { Database } from '../../core/database.ts';
import {
  ProtectedDeliveryService,
  type ProtectedDeliveryPurpose,
  type ProtectedSecretInputKind,
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
    name: 'list_secret_input_resources',
    description: 'List the safe metadata for resources authorized to this direct conversation. Use returned resource IDs only after matching the requested account.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'read_only',
    externalEffect: { version: EXTERNAL_EFFECT_CONTRACT_VERSION, kind: 'none' },
    schema: z.object({
      chatJid: z.string(),
      cursor: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }).strict(),
    handler: async (params, session) => {
      const identity = directRecipient(session, deps.db);
      return deps.service.listSecretInputResources({
        principal: identity.principal,
        ...(params['cursor'] === undefined ? {} : { cursor: params['cursor'] as string }),
        ...(params['limit'] === undefined ? {} : { limit: params['limit'] as number }),
      });
    },
  });

  registry.register({
    name: 'request_secret_input',
    description: 'Request a one-use password, token, or challenge-backed MFA input for a bound resource in this direct conversation.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    externalEffect: { version: EXTERNAL_EFFECT_CONTRACT_VERSION, kind: 'external' },
    schema: z.object({
      chatJid: z.string(),
      resource_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
      kind: z.enum(['password', 'token', 'mfa']),
      purpose: z.string().trim().min(1).max(256),
    }).strict(),
    handler: async (params, session) => {
      const identity = directRecipient(session, deps.db);
      return deps.service.requestSecretInput({
        resourceId: params['resource_id'] as string,
        kind: params['kind'] as ProtectedSecretInputKind,
        purpose: params['purpose'] as string,
        principal: identity.principal,
        recipientJid: identity.recipientJid,
      });
    },
  });

  registry.register({
    name: 'get_secret_input_status',
    description: 'Get metadata-only input, delivery status, and the recorded fixed-consumer operationResult for this direct conversation. A null result leaves completion unknown; mfa_required does not mean login completed or that a challenge is still open.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'read_only',
    externalEffect: { version: EXTERNAL_EFFECT_CONTRACT_VERSION, kind: 'none' },
    schema: z.object({
      chatJid: z.string(),
      input_id: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    }).strict(),
    handler: async (params, session) => {
      const identity = directRecipient(session, deps.db);
      return deps.service.secretInputStatus({ id: params['input_id'] as string, principal: identity.principal });
    },
  });

  registry.register({
    name: 'cancel_secret_input',
    description: 'Cancel a secret-input request in this direct conversation.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    externalEffect: { version: EXTERNAL_EFFECT_CONTRACT_VERSION, kind: 'external' },
    schema: z.object({
      chatJid: z.string(),
      input_id: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    }).strict(),
    handler: async (params, session) => {
      const identity = directRecipient(session, deps.db);
      return deps.service.cancelSecretInput({ id: params['input_id'] as string, principal: identity.principal });
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
