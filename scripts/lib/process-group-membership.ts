// The implementation lives in src/lib, because ring boundaries forbid src importing scripts.
export { classifyGroupMembership, groupGone, probeGroupMembership } from '../../src/lib/process-group-membership.ts';
export type { GroupGoneAnswer, GroupMembership } from '../../src/lib/process-group-membership.ts';
