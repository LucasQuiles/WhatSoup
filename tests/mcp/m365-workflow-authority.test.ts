import { describe, expect, it } from 'vitest';
import { withdrawM365WorkflowAuthority } from '../../src/core/m365-bridge-policy.ts';
import {
  authorizeM365WorkflowAction,
  type M365WorkflowAuthorityContext,
} from '../../src/mcp/m365-workflow-authority.ts';

const authority = {
  accountId: 'account-employee-1',
  employeeActorJid: '15551230001@s.whatsapp.net',
  conversationKey: '15551230001',
};

const SOCKET_PATH = '/tmp/whatsoup-test-authority.sock';

const currentHumanRequest: M365WorkflowAuthorityContext = {
  actorJid: authority.employeeActorJid,
  conversationKey: '15551230001',
  requestRef: '3EB0123456789',
  workflowAuthority: authority,
  workflowAuthorityScope: 'per_chat',
  executingResolution: 'resolved',
  callerAttribution: { transport: 'socket', connectionId: 'test-connection', tokenResult: 'match', clientName: null, clientVersion: null },
  tokenBinding: () => ({ kind: 'session', socketPath: SOCKET_PATH }),
};

const requestTokenBinding = (overrides: { requestRef?: string; conversationKey?: string } = {}) => () => ({
  kind: 'request' as const,
  socketPath: SOCKET_PATH,
  conversationKey: overrides.conversationKey ?? '15551230001',
  requestRef: overrides.requestRef ?? '3EB0123456789',
});

const request = {
  version: 1 as const,
  toolName: 'send-mail',
  params: {
    subject: 'Hi',
    body: 'hello',
    recipients: ['a@example.test'],
  },
  accountId: authority.accountId,
  requestId: 'plugin-request-1',
};

describe('authorizeM365WorkflowAction', () => {
  it('allows the assigned employee in another admitted chat when no conversation restriction is configured', () => {
    expect(authorizeM365WorkflowAction(request, {
      ...currentHumanRequest,
      conversationKey: 'an-existing-allowed-group',
      workflowAuthority: { accountId: authority.accountId, employeeActorJid: authority.employeeActorJid },
    }, 1_000)).toMatchObject({ allowed: true, receipt: { conversationKey: 'an-existing-allowed-group' } });
  });

  it.each(['absent', 'mismatch'] as const)('rejects a socket caller with %s session attribution', (tokenResult) => {
    expect(authorizeM365WorkflowAction(request, {
      ...currentHumanRequest,
      callerAttribution: { transport: 'socket', connectionId: 'other-connection', tokenResult, clientName: null, clientVersion: null },
    }, 1_000)).toEqual({ allowed: false, code: 'MISSING_SESSION_BINDING' });
  });
  it('mints a bound 15-minute receipt for the assigned employee current request', () => {
    const result = authorizeM365WorkflowAction(request, currentHumanRequest, 1_000);

    expect(result).toEqual({
      allowed: true,
      receipt: {
        version: 1,
        actorJid: authority.employeeActorJid,
        conversationKey: '15551230001',
        requestRef: '3EB0123456789',
        toolName: 'send-mail',
        paramsSha256: '2892ea3c3a15f1161e4d20bad5fac1920ff4ec88fa3937c5ad538da402eb072b',
        accountId: authority.accountId,
        issuedAtMs: 1_000,
        expiresAtMs: 901_000,
        operationId: 'm365-v1-069e198455f989f918dc87344deca08ff4dab02c2737c88071f2f568d26da956',
        caller: 'session',
      },
    });
  });

  // The receipt binds the declared account, not what an operation does, so no switch is authorized.
  it.each([
    'select-account',
    'select-dataverse-environment',
    'Select-Account',
    'SELECT-DATAVERSE-ENVIRONMENT',
    'mcp__plugin_microsoft_365_microsoft_365__select-account',
  ])('refuses the account or environment selection operation %j', (toolName) => {
    expect(authorizeM365WorkflowAction({ ...request, toolName }, currentHumanRequest, 1_000))
      .toEqual({ allowed: false, code: 'ACCOUNT_SELECTION_REFUSED' });
  });

  // Lock-in: apart from account and environment selection, the plugin decides which tools need a receipt.
  it('binds a receipt to any other tool name the plugin asks for, and never to another tool', () => {
    const result = authorizeM365WorkflowAction({ ...request, toolName: 'execute-dataverse-function' }, currentHumanRequest, 1_000);
    expect(result).toMatchObject({
      allowed: true,
      receipt: {
        toolName: 'execute-dataverse-function',
        paramsSha256: '2892ea3c3a15f1161e4d20bad5fac1920ff4ec88fa3937c5ad538da402eb072b',
        operationId: expect.stringMatching(/^m365-v1-[0-9a-f]{64}$/),
      },
    });
    // Same params in the same turn: the operation identity still differs from the send-mail receipt's
    // above, so this receipt cannot authorize a send-mail call.
    expect(result).not.toMatchObject({
      receipt: { operationId: 'm365-v1-069e198455f989f918dc87344deca08ff4dab02c2737c88071f2f568d26da956' },
    });
  });

  it.each([
    ['missing current actor', { ...currentHumanRequest, actorJid: undefined }, 'MISSING_CURRENT_HUMAN_REQUEST'],
    ['missing current request reference', { ...currentHumanRequest, requestRef: undefined }, 'MISSING_CURRENT_HUMAN_REQUEST'],
    ['scheduled request', { ...currentHumanRequest, purpose: 'scheduled-agent-job' as const }, 'BACKGROUND_REQUEST'],
    ['other employee', { ...currentHumanRequest, actorJid: '15551230002@s.whatsapp.net' }, 'ACTOR_NOT_ASSIGNED'],
    ['other conversation', { ...currentHumanRequest, conversationKey: '15551230002' }, 'CONVERSATION_NOT_ASSIGNED'],
  ])('rejects %s', (_case, context, code) => {
    expect(authorizeM365WorkflowAction(request, context, 1_000)).toEqual({ allowed: false, code });
  });

  it('rejects a request for another configured account', () => {
    expect(authorizeM365WorkflowAction({ ...request, accountId: 'account-employee-2' }, currentHumanRequest, 1_000)).toEqual({
      allowed: false,
      code: 'ACCOUNT_NOT_ASSIGNED',
    });
  });

  it('binds parameter hashes to sorted object keys while preserving array order', () => {
    const reordered = authorizeM365WorkflowAction({
      ...request,
      params: { recipients: ['a@example.test'], body: 'hello', subject: 'Hi' },
    }, currentHumanRequest, 1_000);
    const reorderedArray = authorizeM365WorkflowAction({
      ...request,
      params: { recipients: ['different@example.test', 'a@example.test'], body: 'hello', subject: 'Hi' },
    }, currentHumanRequest, 1_000);

    expect(reordered).toEqual(authorizeM365WorkflowAction(request, currentHumanRequest, 1_000));
    expect(reorderedArray).not.toEqual(authorizeM365WorkflowAction(request, currentHumanRequest, 1_000));
  });

  it('marks a receipt issued on a session token as the session caller', () => {
    expect(authorizeM365WorkflowAction(request, currentHumanRequest, 1_000))
      .toMatchObject({ allowed: true, receipt: { caller: 'session' } });
  });

  it('marks a receipt issued on a request token as the adapter caller', () => {
    expect(authorizeM365WorkflowAction(request, { ...currentHumanRequest, tokenBinding: requestTokenBinding() }, 1_000))
      .toMatchObject({ allowed: true, receipt: { caller: 'adapter' } });
  });

  it('keeps an in-process caller turn-owned without a token, under the session caller path', () => {
    expect(authorizeM365WorkflowAction(request, {
      ...currentHumanRequest,
      callerAttribution: { transport: 'in_process', connectionId: null, tokenResult: 'not_applicable', clientName: null, clientVersion: null },
      tokenBinding: undefined,
    }, 1_000)).toMatchObject({ allowed: true, receipt: { caller: 'session' } });
  });

  describe('in a sandboxPerChat instance', () => {
    const sandboxTurn = { ...currentHumanRequest, workflowAuthoritySandboxPerChat: true as const };

    it('refuses a session token caller before any receipt is minted', () => {
      expect(authorizeM365WorkflowAction(request, sandboxTurn, 1_000))
        .toEqual({ allowed: false, code: 'WORKFLOW_AUTHORITY_SANDBOX_SESSION' });
    });

    it('refuses an in-process session caller', () => {
      expect(authorizeM365WorkflowAction(request, {
        ...sandboxTurn,
        callerAttribution: { transport: 'in_process', connectionId: null, tokenResult: 'not_applicable', clientName: null, clientVersion: null },
        tokenBinding: undefined,
      }, 1_000)).toEqual({ allowed: false, code: 'WORKFLOW_AUTHORITY_SANDBOX_SESSION' });
    });

    it('still admits the adapter request token caller', () => {
      expect(authorizeM365WorkflowAction(request, { ...sandboxTurn, tokenBinding: requestTokenBinding() }, 1_000))
        .toMatchObject({ allowed: true, receipt: { caller: 'adapter' } });
    });

    it('keeps the earlier refusals ahead of it', () => {
      expect(authorizeM365WorkflowAction(request, { ...sandboxTurn, workflowAuthorityScope: 'shared' }, 1_000))
        .toEqual({ allowed: false, code: 'WORKFLOW_AUTHORITY_SCOPE_NOT_PER_CHAT' });
      expect(authorizeM365WorkflowAction(request, { ...sandboxTurn, tokenBinding: () => undefined }, 1_000))
        .toEqual({ allowed: false, code: 'MISSING_SESSION_BINDING' });
    });
  });

  it.each([
    ['no token binding resolver', { tokenBinding: undefined }],
    ['a token that is no longer live', { tokenBinding: () => undefined }],
  ])('rejects a socket caller with %s', (_case, overrides) => {
    expect(authorizeM365WorkflowAction(request, { ...currentHumanRequest, ...overrides }, 1_000))
      .toEqual({ allowed: false, code: 'MISSING_SESSION_BINDING' });
  });

  it.each([
    ['another request reference', { requestRef: '3EB0000000000' }],
    ['another conversation', { conversationKey: '15551230002' }],
  ])('rejects a request token bound to %s as stale', (_case, overrides) => {
    expect(authorizeM365WorkflowAction(request, { ...currentHumanRequest, tokenBinding: requestTokenBinding(overrides) }, 1_000))
      .toEqual({ allowed: false, code: 'STALE_REQUEST' });
  });

  it.each([
    ['shared', 'shared' as const],
    ['single', 'single' as const],
    ['unknown', undefined],
  ])('refuses workflow authority for a turn whose session scope is %s', (_case, workflowAuthorityScope) => {
    expect(authorizeM365WorkflowAction(request, { ...currentHumanRequest, workflowAuthorityScope }, 1_000))
      .toEqual({ allowed: false, code: 'WORKFLOW_AUTHORITY_SCOPE_NOT_PER_CHAT' });
  });

  it('uses the same operation identity for duplicate plugin requests and changes it with the action', () => {
    const duplicate = authorizeM365WorkflowAction({ ...request, requestId: 'plugin-request-2' }, currentHumanRequest, 1_200);
    const changed = authorizeM365WorkflowAction({
      ...request,
      params: { ...request.params, subject: 'Changed subject' },
    }, currentHumanRequest, 1_200);
    const first = authorizeM365WorkflowAction(request, currentHumanRequest, 1_000);

    if (!first.allowed || !duplicate.allowed || !changed.allowed) throw new Error('expected admitted receipts');
    expect(duplicate.receipt.operationId).toBe(first.receipt.operationId);
    expect(changed.receipt.operationId).not.toBe(first.receipt.operationId);
  });

  it('refuses a turn that published no workflow assignment', () => {
    expect(authorizeM365WorkflowAction(request, { ...currentHumanRequest, workflowAuthority: undefined }, 1_000))
      .toEqual({ allowed: false, code: 'WORKFLOW_AUTHORITY_DISABLED' });
  });

  it('refuses an in-flight turn whose published assignment the runtime has since withdrawn', () => {
    // A fresh assignment object: the withdrawal is permanent for the object it marks.
    const published = { ...authority };
    const context = { ...currentHumanRequest, workflowAuthority: published };
    // Positive control: the same published turn is authorized while its assignment is live.
    expect(authorizeM365WorkflowAction(request, context, 1_000)).toMatchObject({ allowed: true });
    withdrawM365WorkflowAuthority(published);
    expect(authorizeM365WorkflowAction(request, context, 1_000)).toEqual({ allowed: false, code: 'WORKFLOW_AUTHORITY_DISABLED' });
    // An equal assignment that was never withdrawn is unaffected.
    expect(authorizeM365WorkflowAction(request, { ...context, workflowAuthority: { ...authority } }, 1_000)).toMatchObject({ allowed: true });
  });

  it.each([
    ['a non-finite number', { subject: 'Hi', count: Number.NaN }],
    ['a non-plain object', { subject: 'Hi', when: new Date(0) }],
    ['an undefined value', { subject: 'Hi', body: undefined }],
  ])('refuses params that carry %s', (_case, params) => {
    expect(authorizeM365WorkflowAction({ ...request, params }, currentHumanRequest, 1_000))
      .toEqual({ allowed: false, code: 'INVALID_PARAMS' });
  });
});
