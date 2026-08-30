// #3427 — the global WhatSoup socket is the second surface where a scheduled
// agent job's `purpose` was lost (single/shared scope), leaving the registry's
// scheduled-agent-job forbidden-tools gate inert. #3426 gave the socket a
// read-time ACTOR resolver; #3427 adds the sibling read-time PURPOSE resolver.
//
// These drive a REAL WhatSoupSocketServer over a real unix socket, with a REAL
// ToolRegistry + the REAL gate + a REAL forbidden tool name, and observe the
// JSON-RPC tools/call response. The executing-turn purpose register is modeled
// by a mutable variable the resolver closes over.

import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import {
  WhatSoupSocketServer,
} from '../../src/mcp/socket-server.ts';
import { ToolRegistry, SCHEDULED_AGENT_JOB_FORBIDDEN_TOOLS } from '../../src/mcp/registry.ts';
import type { SessionContext } from '../../src/mcp/types.ts';
import { waitForSocket } from '../helpers/wait-for.ts';
import { makeSocketPath, sendJsonRpc } from '../helpers/socket-rpc.ts';

const ADMIN_JID = '15550001@s.whatsapp.net';
const FORBIDDEN_TOOL = 'delete_message';
const SCHEDULED = 'scheduled-agent-job' as const;

type CallResponse = { result: { content: Array<{ type: string; text: string }>; isError?: boolean } };

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  // Real forbidden-set NAME; caller-supplied keeps the reachable path free of
  // target injection so the gate's "Unknown tool" denial is the only failure a
  // scheduled turn can hit. The gate keys on name+purpose only.
  registry.register({
    name: FORBIDDEN_TOOL,
    description: 'Delete a message (forbidden to scheduled jobs).',
    scope: 'chat',
    targetMode: 'caller-supplied',
    schema: z.object({}),
    handler: async () => ({ reached: true }),
  });
  return registry;
}

describe('global socket — read-time scheduled-agent-job purpose scoping (#3427)', () => {
  let server: WhatSoupSocketServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  async function callForbidden(
    purposeResolver: (() => SessionContext['purpose']) | undefined,
  ): Promise<CallResponse['result']> {
    const socketPath = makeSocketPath();
    const registry = makeRegistry();
    // Global-tier base session with NO static purpose — exactly the single/shared
    // providerToolSession. actorResolver present (admin executing), purpose from
    // the read-time resolver only.
    server = new WhatSoupSocketServer(
      socketPath,
      registry,
      { tier: 'global', actorJid: ADMIN_JID, conversationKey: 'c' },
      () => ADMIN_JID,
      purposeResolver,
    );
    server.start();
    await waitForSocket(socketPath);
    const response = (await sendJsonRpc(socketPath, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: FORBIDDEN_TOOL, arguments: {} },
    })) as CallResponse;
    return response.result;
  }

  it('POSITIVE CONTROL: delete_message is a real member of the forbidden set', () => {
    expect(SCHEDULED_AGENT_JOB_FORBIDDEN_TOOLS.has(FORBIDDEN_TOOL)).toBe(true);
  });

  it('AUTH RED→GREEN: a scheduled-job purpose resolver DENIES the forbidden tool ("Unknown tool")', async () => {
    // Executing turn is a scheduled job. On unmodified base the socket has no
    // purpose resolver → the request session carries no purpose → the gate is
    // inert → the tool is REACHABLE (this fails). With the fix the read-time
    // purpose engages the gate → "Unknown tool".
    const result = await callForbidden(() => SCHEDULED);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(`Unknown tool: ${FORBIDDEN_TOOL}`);
  });

  it('a normal turn (resolver yields undefined) still reaches the tool — no over-restriction', async () => {
    const result = await callForbidden(() => undefined);
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain('"reached": true');
  });

  it('without a purpose resolver the request uses the base purpose (unchanged legacy contract: reachable)', async () => {
    const result = await callForbidden(undefined);
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain('"reached": true');
  });
});
