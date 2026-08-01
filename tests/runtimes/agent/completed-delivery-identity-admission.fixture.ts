export type CompletedCheckpointInput = {
  conversationKey: string;
  deliveryJid: string;
  deliveryNamespace: 's.whatsapp.net' | 'lid' | 'g.us';
  scope: 'per_chat' | 'shared' | 'singleton';
  sessionId: string;
};

type ProactiveResumeIdentityRejectionCase = {
  label: string;
  checkpoint: CompletedCheckpointInput;
  reason: 'invalid' | 'scope_mismatch';
};

export const PROACTIVE_RESUME_IDENTITY_REJECTION_CASES: readonly ProactiveResumeIdentityRejectionCase[] = [
  {
    label: 'semantic identity mismatch',
    checkpoint: {
      conversationKey: '15551230991',
      deliveryJid: '15551230992@s.whatsapp.net',
      deliveryNamespace: 's.whatsapp.net',
      scope: 'per_chat',
      sessionId: 'invalid-proactive-session',
    },
    reason: 'invalid',
  },
  {
    label: 'scope mismatch',
    checkpoint: {
      conversationKey: '15551230993',
      deliveryJid: '15551230993@s.whatsapp.net',
      deliveryNamespace: 's.whatsapp.net',
      scope: 'shared',
      sessionId: 'scope-mismatch-proactive-session',
    },
    reason: 'scope_mismatch',
  },
];

export const LEGACY_ACTIVE_SESSION_WITHOUT_COMPLETED_IDENTITY = {
  id: 8,
  session_id: 'sess-legacy-null-chat',
  chat_jid: null,
  claude_pid: 0,
  status: 'active',
  started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  last_message_at: null,
  message_count: 0,
};

export const COMPLETED_DELIVERY_IDENTITY_DEBT_HEALTH = {
  unresolvedCount: 1,
  oldestTransitionAt: '2026-06-10 09:55:00',
  maximumAttempts: 1,
  nextAction: 'operator',
};

export const LEGACY_COMPLETED_DELIVERY_IDENTITY_QUARANTINE = {
  agentSessionRowId: 8,
  providerSessionId: 'sess-legacy-null-chat',
  provider: undefined,
  workspaceKey: null,
  reason: 'missing',
};
