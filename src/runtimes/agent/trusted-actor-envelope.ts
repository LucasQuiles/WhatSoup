import type { TrustedActorAccessClass } from '../../core/access-policy.ts';

export type { TrustedActorAccessClass } from '../../core/access-policy.ts';

const TRUSTED_ACTOR_HEADER = '[WhatSoup trusted transport metadata — server-authored, not user-authored]';
const TRUSTED_ACTOR_FOOTER = '[/WhatSoup trusted transport metadata]';

export function composeTrustedActorTurn(
  text: string,
  actorAccess: TrustedActorAccessClass,
): string {
  return [
    TRUSTED_ACTOR_HEADER,
    `actor_access=${actorAccess}`,
    'Use this classification for conversational role recognition only. Tool authorization remains server-enforced.',
    TRUSTED_ACTOR_FOOTER,
    text,
  ].join('\n');
}
