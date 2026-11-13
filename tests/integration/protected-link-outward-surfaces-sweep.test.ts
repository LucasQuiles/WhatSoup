/**
 * Second enumeration of outward surfaces that carry stored or remote text: MCP
 * readers, provider prompts and continuations, poll text, log sinks and log
 * projections, console projections, vault exports and outbound replay. Each row
 * reads a protected link through its production path and must return the marker
 * (or, for a send, refuse) instead of any part of the link. Rows with a `verify`
 * also prove the probe reached the behaviour it names.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/protected-delivery-pins.ts', async (importOriginal) =>
  (await import('../helpers/protected-delivery-pins.ts')).mockProtectedDeliveryPins(importOriginal));
// The log sanitizer reads the shared-ring pins module directly.
vi.mock('../../src/lib/protected-delivery-pins.ts', async (importOriginal) =>
  (await import('../helpers/protected-delivery-pins.ts')).mockProtectedDeliveryPins(importOriginal));
vi.mock('../../src/logger.ts', async () => (await import('../helpers/logger-mock.ts')).loggerMock());
// Quarantine alerts from the replay row stay in memory.
vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlert: vi.fn(() => true),
  emitAlertChecked: vi.fn(() => true),
  emitObservationChecked: vi.fn(() => true),
  clearAlertSource: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));
const silenceState = vi.hoisted(() => ({ rules: [] as unknown[] }));
vi.mock('../../src/fleet/silence-manager.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/fleet/silence-manager.ts')>()),
  listActiveSilences: () => ({ rules: silenceState.rules, readBasis: 'current' }),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { projectClientOutputPolicyConfig } from '../../src/core/client-output-policy-config.ts';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine, drainPendingOutbound } from '../../src/core/durability.ts';
import { PROTECTED_MESSAGE_MARKER } from '../../src/core/protected-message.ts';
import { ensureStoredAudioTranscript } from '../../src/core/stored-audio-transcript.ts';
import { createBead } from '../../src/core/substrate/beads.ts';
import { addAlias, captureObservation, upsertEntity } from '../../src/core/substrate/entities.ts';
import { TriggerPoller } from '../../src/core/substrate/poller.ts';
import { createTrigger } from '../../src/core/substrate/triggers.ts';
import { projectBead, projectEntity } from '../../src/core/substrate/vault.ts';
import { handleGetLogs } from '../../src/fleet/routes/data.ts';
import { parsePinoLine } from '../../src/fleet/routes/feed.ts';
import { handleGetSilences } from '../../src/fleet/routes/silence.ts';
import { sanitizingLogHook } from '../../src/lib/log-sanitizer.ts';
import { registerChatOperationTools } from '../../src/mcp/tools/chat-operations.ts';
import { registerGroupTools } from '../../src/mcp/tools/groups.ts';
import { formatEntityResults, formatTextResults, parseHits } from '../../src/mcp/tools/knowledge.ts';
import { registerNewsletterTools } from '../../src/mcp/tools/newsletter.ts';
import { makeSockTool } from '../../src/mcp/tools/sock-tool-factory.ts';
import { registerSubstrateTools } from '../../src/mcp/tools/substrate.ts';
import { redactHandoffPii } from '../../src/runtimes/agent/handoff-pii-redactor.ts';
import { buildHandoffPrelude } from '../../src/runtimes/agent/handoff-prelude.ts';
import {
  ASKUSER_OTHER_OPTION_LABEL,
  formatOtherDirective,
  formatPollAnswerTurnText,
  formatPollQuestion,
  formatTextFallbackQuestion,
} from '../../src/runtimes/agent/poll-resolution.ts';
import { TEST_LINK_HOST } from '../helpers/protected-delivery-pins.ts';
import { mockReq, mockRes } from '../helpers/http-mocks.ts';
import { ToolRegistry } from '../helpers/resolved-tool-registry.ts';

const LINK = `https://${TEST_LINK_HOST}/s/#v3.${'Q'.repeat(22)}.${'Z'.repeat(43)}`;
const SENDER = `Mallory Account ${LINK}`;
const GROUP_NAME = `Team ${LINK}`;
const CONTENT = `${'word '.repeat(19)}${LINK}`;
const DM_JID = '15550100001@s.whatsapp.net';
const DM_KEY = '15550100001';
const GROUP_JID = 'protected-group@g.us';
const TS = 1_700_000_000;
const SELF = 'self';
const QUESTION = {
  header: 'Decision',
  question: CONTENT,
  options: [{ label: `Open ${LINK}`, description: CONTENT }, { label: ASKUSER_OTHER_OPTION_LABEL, description: 'none fit' }],
  multiSelect: false,
};
const KNOWLEDGE_HITS = [{
  _id: `doc ${LINK}`,
  _score: 0.9,
  fields: { text: CONTENT, entity_type: 'person', summary: CONTENT, filepath: `notes ${LINK}` },
}];

let logMetaDir: string;

async function withScratchDb<T>(read: (scratch: Database) => T | Promise<T>): Promise<T> {
  const scratch = new Database(':memory:');
  scratch.open();
  try {
    return await read(scratch);
  } finally {
    scratch.close();
  }
}

async function withTempDir<T>(read: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-link-sweep-'));
  try {
    return await read(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function seedBead(target: Database): number {
  return createBead(target.raw, {
    kind: 'agent_job', title: `Job ${LINK}`, body: CONTENT, ownerJid: SELF, actor: SELF,
  }).id;
}

/** One person entity whose name, metadata, alias and observation carry the link. */
function seedEntity(target: Database): number {
  const entity = upsertEntity(target.raw, { kind: 'person', canonicalName: SENDER, metadata: { note: CONTENT } });
  addAlias(target.raw, { entityId: entity.id, alias: `alias ${LINK}`, aliasKind: 'url', source: `src ${LINK}` });
  captureObservation(target.raw, {
    entityRef: { entityId: entity.id }, kind: 'fact', text: CONTENT, confidence: 0.9, sourceKind: 'manual',
  });
  return entity.id;
}

function seedPineconeWatch(target: Database, now: number): void {
  createTrigger(target.raw, {
    beadId: seedBead(target),
    kind: 'poll.pinecone',
    spec: { index: 'memory-index', namespace: 'facts', query: CONTENT, top_k: 3 },
    reportChatJid: DM_JID,
    nextFireAt: now,
    actor: SELF,
  });
}

async function substrateTool(target: Database, name: string, params: Record<string, unknown>): Promise<unknown> {
  const registry = new ToolRegistry();
  registerSubstrateTools(registry, {
    db: target.raw, instanceName: SELF, dbWrapper: target, adminPhones: new Set<string>(),
  } as never);
  const result = await registry.call(name, params, { tier: 'global' });
  return JSON.parse(result.content[0].text);
}

async function sockTool(
  register: (getSock: () => never, add: (tool: never) => void) => void,
  sock: Record<string, unknown>,
  name: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const registry = new ToolRegistry();
  register(() => sock as never, (tool) => registry.register(tool));
  const result = await registry.call(name, params, { tier: 'global' });
  return JSON.parse(result.content[0].text);
}

function logSink(args: unknown[]): unknown[] {
  const recorded: unknown[][] = [];
  sanitizingLogHook.call(null, args, (...forwarded: unknown[]) => { recorded.push(forwarded); }, 30);
  expect(recorded).toHaveLength(1);
  return recorded[0]!;
}

function feedLine(line: Record<string, unknown>): unknown {
  return parsePinoLine(JSON.stringify({ level: 50, time: TS * 1000, ...line }), {
    instanceName: SELF, instanceType: 'agent',
  });
}

interface SurfaceCase {
  surface: string;
  probe: () => unknown | Promise<unknown>;
  mustContain?: string;
  /** Runs after the leak checks, so a leak is always the first reported failure. */
  verify?: (value: never) => void;
}

const SURFACES: SurfaceCase[] = [
  {
    surface: 'get_profile tool (entity name, metadata, alias and observation)',
    probe: () => withScratchDb((scratch) =>
      substrateTool(scratch, 'get_profile', { entity_ref: { entity_id: seedEntity(scratch) } })),
  },
  {
    surface: 'list_entities tool (entity name and metadata)',
    probe: () => withScratchDb((scratch) => {
      seedEntity(scratch);
      return substrateTool(scratch, 'list_entities', {});
    }),
  },
  {
    surface: 'list_triggers tool, unpaged (stored spec_json)',
    probe: () => withScratchDb((scratch) => {
      seedPineconeWatch(scratch, TS);
      return substrateTool(scratch, 'list_triggers', {});
    }),
  },
  {
    surface: 'list_triggers tool, paged (stored spec_json)',
    probe: () => withScratchDb((scratch) => {
      seedPineconeWatch(scratch, TS);
      return substrateTool(scratch, 'list_triggers', { limit: 10 });
    }),
  },
  {
    surface: 'get_reactions tool (stored reaction text)',
    probe: () => withScratchDb(async (scratch) => {
      scratch.raw.prepare(`
        INSERT INTO reactions (message_id, conversation_key, sender_jid, reaction, timestamp)
        VALUES ('dm-protected', ?, ?, ?, '2026-01-01 00:00:00')
      `).run(DM_KEY, DM_JID, `react ${LINK}`);
      const registry = new ToolRegistry();
      registerChatOperationTools(scratch, () => null, (tool) => registry.register(tool));
      const result = await registry.call('get_reactions', { message_id: 'dm-protected' }, { tier: 'global' });
      return JSON.parse(result.content[0].text);
    }),
    verify: (value: { count: number }) => expect(value.count).toBe(1),
  },
  {
    surface: 'sock tool factory result (every WhatsApp-backed reader)',
    probe: () => makeSockTool(() => ({}) as never, {
      name: 'probe_reader',
      description: 'probe',
      schema: z.object({}),
      call: async () => ({ subject: GROUP_NAME, participants: [{ notify: SENDER }], desc: CONTENT }),
    }).handler({}, {} as never, undefined),
  },
  {
    surface: 'list_groups tool (remote group subject and description)',
    probe: () => sockTool(registerGroupTools as never, {
      groupFetchAllParticipating: async () => ({ [GROUP_JID]: { id: GROUP_JID, subject: GROUP_NAME, desc: CONTENT } }),
    }, 'list_groups', {}),
  },
  {
    surface: 'newsletter_fetch_messages tool (remote message text)',
    probe: () => sockTool(registerNewsletterTools as never, {
      newsletterFetchMessages: async () => [{ message: { conversation: CONTENT } }],
    }, 'newsletter_fetch_messages', { jid: '120363000000000000@newsletter', count: 1 }),
  },
  {
    surface: 'knowledge search entity formatter',
    probe: () => formatEntityResults(parseHits(KNOWLEDGE_HITS)),
  },
  {
    surface: 'knowledge search text formatter (source and summary)',
    probe: () => formatTextResults(parseHits(KNOWLEDGE_HITS)),
  },
  {
    surface: 'knowledge search parsed hits (the external rerank input)',
    probe: () => parseHits(KNOWLEDGE_HITS),
  },
  {
    surface: 'poll.pinecone watch query (sent to the search boundary)',
    probe: () => withScratchDb(async (scratch) => {
      seedPineconeWatch(scratch, TS);
      const searches: unknown[] = [];
      const poller = new TriggerPoller(scratch.raw, {
        sendMessage: async () => ({ waMessageId: null }),
        sendMedia: async () => ({ waMessageId: null }),
      } as never, {
        now: () => TS,
        pineconeAllowedIndexes: ['memory-index'],
        pineconeSearch: async (args: unknown) => { searches.push(args); return { matches: [] }; },
      } as never);
      try {
        await poller.tickOnce();
      } finally {
        poller.stop();
      }
      return searches;
    }),
    verify: (searches: unknown[]) => expect(searches).toHaveLength(1),
  },
  {
    surface: 'durability replay of a stored text (refused before the transport)',
    probe: () => withScratchDb(async (scratch) => {
      const engine = new DurabilityEngine(scratch);
      const opId = engine.createOutboundOp({
        conversationKey: DM_KEY, chatJid: DM_JID, opType: 'text',
        payload: JSON.stringify({ text: CONTENT }), replayPolicy: 'safe',
      });
      const sent: unknown[] = [];
      const { resent } = await drainPendingOutbound({
        sendMessage: async (jid: string, text: string) => { sent.push({ jid, text }); return { waMessageId: 'WA-1' }; },
        sendMedia: async () => ({ waMessageId: null }),
      } as never, engine);
      const row = scratch.raw.prepare('SELECT status, retry_count, error FROM outbound_ops WHERE id = ?').get(opId);
      return { sent, resent, row };
    }),
    mustContain: 'protected_link_send_refused',
    verify: (value: { sent: unknown[]; resent: number; row: { status: string; retry_count: number } }) => {
      expect(value.sent).toHaveLength(0);
      expect(value.resent).toBe(0);
      expect(value.row.status).toBe('quarantined');
      expect(value.row.retry_count).toBe(0);
    },
  },
  {
    surface: 'poll rendering (question and option labels)',
    probe: () => formatPollQuestion(QUESTION),
  },
  {
    surface: 'poll text fallback',
    probe: () => formatTextFallbackQuestion(QUESTION),
  },
  {
    surface: 'poll "Other" directive (provider turn)',
    probe: () => formatOtherDirective(QUESTION, [ASKUSER_OTHER_OPTION_LABEL]),
  },
  {
    surface: 'poll answer continuation (provider turn from stored questions and answers)',
    probe: () => formatPollAnswerTurnText({ questions: [QUESTION], answersCollected: { 0: `Open ${LINK}` } }),
  },
  {
    surface: 'handoff prelude system block (stored summary)',
    probe: () => buildHandoffPrelude({
      artifact: {
        conversationKey: DM_KEY, summary: CONTENT, seededArtifacts: null,
        updatedAt: TS * 1000, sourceProvider: 'provider-a', sourceModel: null, tokenBaseline: 0,
      },
      now: TS * 1000, staleAfterMs: 60_000, redact: redactHandoffPii,
    }),
  },
  {
    surface: 'handoff prelude system block (stored seeded artifacts)',
    probe: () => buildHandoffPrelude({
      artifact: {
        conversationKey: DM_KEY, summary: null, seededArtifacts: `seed ${LINK}`,
        updatedAt: TS * 1000, sourceProvider: 'provider-a', sourceModel: null, tokenBaseline: 0,
      },
      now: TS * 1000, staleAfterMs: 60_000, redact: redactHandoffPii,
    }),
  },
  {
    surface: 'first transcription of a stored audio message (returned and stored)',
    probe: () => withScratchDb((scratch) => withTempDir(async (dir) => {
      const mediaPath = path.join(dir, 'clip.ogg');
      fs.writeFileSync(mediaPath, Buffer.from('audio'));
      scratch.raw.prepare(`
        INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp, media_path)
        VALUES (?, ?, ?, 'audio-fresh', 'audio', 0, ?, ?)
      `).run(DM_JID, DM_KEY, DM_JID, TS, mediaPath);
      const result = await ensureStoredAudioTranscript(scratch, {
        message_id: 'audio-fresh', content: null, content_text: null, media_path: mediaPath, raw_message: null,
      }, async () => CONTENT);
      const stored = scratch.raw.prepare("SELECT content, content_text FROM messages WHERE message_id = 'audio-fresh'").get();
      return { result, stored };
    })),
    verify: (value: { result: { status: string } }) => expect(value.result.status).toBe('transcribed'),
  },
  {
    surface: 'fleet logs route (source and component metadata)',
    probe: () => {
      const res = mockRes();
      handleGetLogs(mockReq({ url: `/api/lines/${SELF}/logs` }), res, {
        discovery: { getInstance: () => ({ name: SELF, logDir: logMetaDir, dbPath: '' }) } as never,
        dbReader: {} as never,
      }, { name: SELF });
      return JSON.parse(res._body);
    },
    verify: (entries: unknown[]) => expect(entries).toHaveLength(2),
  },
  {
    surface: 'fleet feed connection event (component and reason)',
    probe: () => feedLine({ msg: 'WhatsApp connection closed', component: `conn ${LINK}`, reason: `closed ${LINK}` }),
    verify: (event: { detail: { type: string } }) => expect(event.detail.type).toBe('connection'),
  },
  {
    surface: 'fleet feed tool error event (tool name)',
    probe: () => feedLine({ msg: 'tool error reported', toolName: `fetch ${LINK}`, error: 'failed' }),
    verify: (event: { detail: { type: string } }) => expect(event.detail.type).toBe('tool_error'),
  },
  {
    surface: 'log sink, string-only message',
    probe: () => logSink([`delivery failed for ${LINK}`]),
  },
  {
    surface: 'log sink, message after a merge object',
    probe: () => logSink([{ attempt: 1 }, `delivery failed for ${LINK}`]),
  },
  {
    surface: 'log sink, interpolation value after the message',
    probe: () => logSink([{ attempt: 1 }, 'delivery failed for %s', LINK]),
  },
  {
    surface: 'log sink, string inside the merge object',
    probe: () => logSink([{ target: `delivery to ${LINK}` }, 'delivery failed']),
  },
  {
    surface: 'console config projection (systemPrompt and free text)',
    probe: () => projectClientOutputPolicyConfig({ name: SELF, systemPrompt: `Use ${LINK}`, notes: CONTENT }),
  },
  {
    surface: 'console silences route (reason and silencedBy)',
    probe: async () => {
      silenceState.rules = [{
        instance: SELF, until: '2027-01-01T00:00:00.000Z', reason: `maintenance ${LINK}`, silencedBy: SENDER,
        createdAt: '2026-01-01T00:00:00.000Z',
      }];
      const res = mockRes();
      await handleGetSilences(mockReq({ url: '/api/fleet/silences' }), res);
      return JSON.parse(res._body);
    },
    verify: (body: { silences: unknown[] }) => expect(body.silences).toHaveLength(1),
  },
  {
    surface: 'vault bead export (file name, title and body)',
    probe: () => withScratchDb((scratch) => withTempDir((dir) => {
      const file = projectBead(scratch.raw, { vaultPath: dir, beadId: seedBead(scratch) });
      expect(file).not.toBeNull();
      return { file: path.relative(dir, file!), body: fs.readFileSync(file!, 'utf8') };
    })),
  },
  {
    surface: 'vault entity export (file name, name, aliases and observations)',
    probe: () => withScratchDb((scratch) => withTempDir((dir) => {
      const file = projectEntity(scratch.raw, { vaultPath: dir, entityId: seedEntity(scratch) });
      expect(file).not.toBeNull();
      return { file: path.relative(dir, file!), body: fs.readFileSync(file!, 'utf8') };
    })),
  },
];

describe('protected links never reach the remaining outward surfaces', () => {
  beforeAll(() => {
    logMetaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-link-log-meta-'));
    fs.writeFileSync(path.join(logMetaDir, 'current.log'), [
      { level: 30, time: TS * 1000, msg: 'first', name: `service ${LINK}`, component: `component ${LINK}` },
      { level: 30, time: TS * 1000 + 1, msg: 'second', module: `module ${LINK}` },
    ].map((line) => `${JSON.stringify(line)}\n`).join(''));
  });

  afterAll(() => {
    fs.rmSync(logMetaDir, { recursive: true, force: true });
  });

  it.each(SURFACES)('$surface', async ({ probe, mustContain, verify }) => {
    const value = await probe();
    const serialized = JSON.stringify(value);

    expect(serialized).not.toContain(TEST_LINK_HOST.slice(0, 6));
    expect(serialized).not.toContain('Q'.repeat(22));
    expect(serialized).toContain(mustContain ?? PROTECTED_MESSAGE_MARKER);
    verify?.(value as never);
  });
});
