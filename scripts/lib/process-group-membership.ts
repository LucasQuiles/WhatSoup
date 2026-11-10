// The implementation lives in src/lib, because ring boundaries forbid src importing scripts.
export { classifyGroupMembership, probeGroupMembership } from '../../src/lib/process-group-membership.ts';
export type { GroupMembership } from '../../src/lib/process-group-membership.ts';
