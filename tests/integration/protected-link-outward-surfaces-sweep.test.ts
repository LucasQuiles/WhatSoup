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
import { FleetDiscovery } from '../../src/fleet/discovery.ts';
import { handleGetLogs } from '../../src/fleet/routes/data.ts';
import { enrichInstance } from '../../src/fleet/routes/lines.ts';
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

/** A child of a row's value that must carry the marker (or `mustContain`) on its own. */
type ChildCheck = ((value: never) => unknown) | { pick: (value: never) => unknown; mustContain: string };

interface SurfaceCase {
  surface: string;
  probe: () => unknown | Promise<unknown>;
  mustContain?: string;
  /**
   * One row per named child: each child needs its own positive check, so a
   * child the probe dropped or never reached fails its row.
   */
  children?: Record<string, ChildCheck>;
  /** Runs after the leak checks, so a leak is always the first reported failure. */
  verify?: (value: never) => void;
}

const bodyLine = (prefix: string) => (value: { body: string }): string | undefined =>
  value.body.split('\n').find((line) => line.startsWith(prefix));

/** Every `{type:'Buffer', data}` leaf of a parsed tool result, decoded as UTF-8. */
function decodedBufferLeaves(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(decodedBufferLeaves);
  if (value === null || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (record['type'] === 'Buffer' && Array.isArray(record['data'])) {
    return [Buffer.from(record['data'] as number[]).toString('utf8')];
  }
  return Object.values(record).flatMap(decodedBufferLeaves);
}

/** Baileys rc13 newsletterFetchMessages: the raw iq node, message text as a protobuf `plaintext` Buffer. */
function newsletterIqNode(text: string): unknown {
  const plaintext = Buffer.concat([Buffer.from([0x0a, Buffer.byteLength(text)]), Buffer.from(text)]);
  return {
    tag: 'iq',
    attrs: { type: 'result' },
    content: [{
      tag: 'message_updates',
      content: [{
        tag: 'messages',
        content: [{ tag: 'message', attrs: { server_id: '101' }, content: [{ tag: 'plaintext', content: plaintext }] }],
      }],
    }],
  };
}

const SURFACES: SurfaceCase[] = [
  {
    surface: 'get_profile tool',
    probe: () => withScratchDb((scratch) =>
      substrateTool(scratch, 'get_profile', { entity_ref: { entity_id: seedEntity(scratch) } })),
    children: {
      'entity name': (value: { entity: { canonical_name: string } }) => value.entity.canonical_name,
      'entity metadata': (value: { entity: { metadata_json: string } }) => value.entity.metadata_json,
      alias: (value: { aliases: Array<{ alias: string }> }) => value.aliases[0]?.alias,
      'alias source': (value: { aliases: Array<{ source: string }> }) => value.aliases[0]?.source,
      observation: (value: { observations: Array<{ text: string }> }) => value.observations[0]?.text,
    },
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
    children: {
      subject: (value: { subject: string }) => value.subject,
      'participant name': (value: { participants: Array<{ notify: string }> }) => value.participants[0]?.notify,
      description: (value: { desc: string }) => value.desc,
    },
  },
  {
    surface: 'list_groups tool',
    probe: () => sockTool(registerGroupTools as never, {
      groupFetchAllParticipating: async () => ({ [GROUP_JID]: { id: GROUP_JID, subject: GROUP_NAME, desc: CONTENT } }),
    }, 'list_groups', {}),
    children: {
      'remote group subject': (value: { groups: Array<{ subject: string }> }) => value.groups[0]?.subject,
      'remote group description': (value: { groups: Array<{ desc: string }> }) => value.groups[0]?.desc,
    },
  },
  {
    surface: 'list_groups tool, rejected remote call (application error text)',
    probe: async () => {
      const registry = new ToolRegistry();
      registerGroupTools((() => ({
        groupFetchAllParticipating: async () => { throw new Error(`remote metadata failed for ${LINK}`); },
      })) as never, (tool) => registry.register(tool));
      return registry.call('list_groups', {}, { tier: 'global' });
    },
    verify: (value: { isError?: boolean; content: Array<{ text: string }> }) => {
      expect(value.isError).toBe(true);
      expect(value.content[0]!.text).toContain('remote metadata failed for');
    },
  },
  {
    surface: 'newsletter_fetch_messages tool (Baileys iq node, protobuf plaintext Buffer)',
    probe: () => sockTool(registerNewsletterTools as never, {
      newsletterFetchMessages: async () => newsletterIqNode(`see ${LINK}`),
    }, 'newsletter_fetch_messages', { jid: '120363000000000000@newsletter', count: 1 }),
    verify: (value: unknown) => {
      for (const leaf of decodedBufferLeaves(value)) expect(leaf).not.toContain(TEST_LINK_HOST.slice(0, 6));
    },
  },
  {
    surface: 'knowledge search entity formatter',
    probe: () => formatEntityResults(parseHits(KNOWLEDGE_HITS)),
  },
  {
    surface: 'knowledge search text formatter',
    probe: () => formatTextResults(parseHits(KNOWLEDGE_HITS)),
    children: {
      source: (value: string) => value.split('\n')[0],
      summary: (value: string) => value.split('\n')[1],
    },
  },
  {
    // rawId is the internal duplicate key and is never output or sent; the
    // handler rows in protected-link-knowledge-sweep.test.ts prove that end to end.
    surface: 'knowledge search parsed hits (the fields every formatter and the rerank request read)',
    probe: () => parseHits(KNOWLEDGE_HITS).map(({ id, text, fields }) => ({ id, text, fields })),
    children: {
      id: (value: Array<{ id: string }>) => value[0]?.id,
      text: (value: Array<{ text: string }>) => value[0]?.text,
      'filepath field': (value: Array<{ fields: { filepath: string } }>) => value[0]?.fields.filepath,
    },
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
    surface: 'first transcription of a stored audio message',
    children: {
      'returned transcription': (value: { result: { transcription?: string } }) => value.result.transcription,
      'stored row': (value: { stored: unknown }) => value.stored,
    },
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
    surface: 'fleet logs route',
    probe: () => {
      const res = mockRes();
      handleGetLogs(mockReq({ url: `/api/lines/${SELF}/logs` }), res, {
        discovery: { getInstance: () => ({ name: SELF, logDir: logMetaDir, dbPath: '' }) } as never,
        dbReader: {} as never,
      }, { name: SELF });
      return JSON.parse(res._body);
    },
    children: {
      'first entry source (name)': (entries: Array<{ source: string }>) => entries[0]?.source,
      'first entry component': (entries: Array<{ component?: string }>) => entries[0]?.component,
      'second entry source (module)': (entries: Array<{ source: string }>) => entries[1]?.source,
      'third entry timestamp (foreign-writer time string)': (entries: Array<{ timestamp: string }>) => entries[2]?.timestamp,
    },
    verify: (entries: unknown[]) => expect(entries).toHaveLength(3),
  },
  {
    surface: 'fleet feed connection event',
    probe: () => feedLine({ msg: 'WhatsApp connection closed', component: `conn ${LINK}`, reason: `closed ${LINK}` }),
    children: {
      component: (event: { component?: string }) => event.component,
      reason: (event: { detail: { reason?: string } }) => event.detail.reason,
    },
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
    surface: 'console config projection',
    probe: () => projectClientOutputPolicyConfig({ name: SELF, systemPrompt: `Use ${LINK}`, notes: CONTENT }),
    children: {
      systemPrompt: (value: { systemPrompt: string }) => value.systemPrompt,
      'free text (notes)': (value: { notes: string }) => value.notes,
    },
  },
  {
    // The validator echoes the rejected value into configError, which the line
    // response repeats in statusEvidence, error and configError.
    surface: 'fleet line response for an invalid config',
    probe: () => withTempDir((root) => {
      fs.mkdirSync(path.join(root, SELF));
      fs.writeFileSync(path.join(root, SELF, 'config.json'), JSON.stringify({
        name: SELF, type: `agent ${LINK}`, accessMode: 'self_only', adminPhones: ['15551234567'],
      }));
      const inst = new FleetDiscovery(root).scan().get(SELF);
      expect(inst?.configError).toMatch(/^Invalid type /);
      return enrichInstance(inst!, undefined);
    }),
    children: {
      statusEvidence: (line: { statusEvidence: string[] }) => line.statusEvidence[0],
      error: (line: { error: string }) => line.error,
      configError: (line: { configError: string }) => line.configError,
    },
    verify: (line: { status: string }) => expect(line.status).toBe('config_error'),
  },
  {
    surface: 'console silences route',
    children: {
      reason: (body: { silences: Array<{ reason: string }> }) => body.silences[0]?.reason,
      silencedBy: (body: { silences: Array<{ silencedBy: string }> }) => body.silences[0]?.silencedBy,
    },
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
    surface: 'vault bead export',
    probe: () => withScratchDb((scratch) => withTempDir((dir) => {
      const file = projectBead(scratch.raw, { vaultPath: dir, beadId: seedBead(scratch) });
      expect(file).not.toBeNull();
      return { file: path.relative(dir, file!), body: fs.readFileSync(file!, 'utf8') };
    })),
    children: {
      title: bodyLine('# Job'),
      body: bodyLine('word '),
    },
  },
  {
    surface: 'vault entity export',
    probe: () => withScratchDb((scratch) => withTempDir((dir) => {
      const file = projectEntity(scratch.raw, { vaultPath: dir, entityId: seedEntity(scratch) });
      expect(file).not.toBeNull();
      return { file: path.relative(dir, file!), body: fs.readFileSync(file!, 'utf8') };
    })),
    children: {
      'file name': { pick: (value: { file: string }) => value.file, mustContain: 'protected-managed-link' },
      'name heading': bodyLine('# Mallory'),
      'front matter name': bodyLine('canonical_name:'),
      // The alias and its source share one line; only the alias segment holds `alias <marker> _(`.
      alias: { pick: bodyLine('- **url**:'), mustContain: `- **url**: alias ${PROTECTED_MESSAGE_MARKER} _(` },
      // `)` and `_` are fragment characters, so the marker also replaces the closing `)_`.
      'alias source': { pick: bodyLine('- **url**:'), mustContain: `_(src ${PROTECTED_MESSAGE_MARKER}` },
      observation: bodyLine('- (0.90) **fact**'),
    },
  },
];

/** A surface with children becomes one row per child, each with its own positive check. */
const ROWS = SURFACES.flatMap(({ children, ...row }) => (children === undefined
  ? [{ ...row, child: undefined as ChildCheck | undefined }]
  : Object.entries(children).map(([name, child]) => ({ ...row, surface: `${row.surface}: ${name}`, child }))));

describe('protected links never reach the remaining outward surfaces', () => {
  beforeAll(() => {
    logMetaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-link-log-meta-'));
    fs.writeFileSync(path.join(logMetaDir, 'current.log'), [
      { level: 30, time: TS * 1000, msg: 'first', name: `service ${LINK}`, component: `component ${LINK}` },
      { level: 30, time: TS * 1000 + 1, msg: 'second', module: `module ${LINK}` },
      // A foreign writer's time string: V8 reads the parenthesized part as a comment.
      { level: 30, time: `Jan 1 2026 (${LINK} T)`, msg: 'third' },
    ].map((line) => `${JSON.stringify(line)}\n`).join(''));
  });

  afterAll(() => {
    fs.rmSync(logMetaDir, { recursive: true, force: true });
  });

  it.each(ROWS)('$surface', async ({ probe, mustContain, verify, child }) => {
    const value = await probe();
    const serialized = JSON.stringify(value);

    expect(serialized).not.toContain(TEST_LINK_HOST.slice(0, 6));
    expect(serialized).not.toContain('Q'.repeat(22));
    const pick = typeof child === 'function' ? child : child?.pick;
    const target = pick === undefined ? value : pick(value as never);
    expect(JSON.stringify(target) ?? '').toContain(
      (typeof child === 'object' ? child.mustContain : undefined) ?? mustContain ?? PROTECTED_MESSAGE_MARKER,
    );
    verify?.(value as never);
  });
});

// A stored JSON column keeps a newline or tab as a two-character escape whose
// letter reads as a host character, so a scheme-less host right after it must
// still be found on the way out through the production registry.
describe('a scheme-less host after a JSON escape in entity metadata_json', () => {
  const BARE = LINK.slice('https://'.length);
  const TOOLS = ['get_profile', 'list_entities'] as const;

  interface EntityRow { canonical_name: string; metadata_json: string }

  async function readEntity(
    scratch: Database,
    tool: (typeof TOOLS)[number],
    entityId: number,
  ): Promise<{ serialized: string; entity: EntityRow }> {
    const value = tool === 'get_profile'
      ? await substrateTool(scratch, 'get_profile', { entity_ref: { entity_id: entityId } }) as { entity: EntityRow }
      : { entity: (await substrateTool(scratch, 'list_entities', {}) as { entities: EntityRow[] }).entities[0]! };
    return { serialized: JSON.stringify(value), entity: value.entity };
  }

  function expectNoLink(serialized: string): void {
    expect(serialized).not.toContain(TEST_LINK_HOST.slice(0, 6));
    expect(serialized).not.toContain('Q'.repeat(22));
  }

  it.each(TOOLS.flatMap((tool) => [
    { tool, escape: '\n', stored: '\\n' },
    { tool, escape: '\t', stored: '\\t' },
  ]))('$tool: bare host after the stored escape $stored', async ({ tool, escape, stored }) => {
    await withScratchDb(async (scratch) => {
      const { id } = upsertEntity(scratch.raw, {
        kind: 'person', canonicalName: 'Mallory', metadata: { note: `line${escape}${BARE}` },
      });

      const { serialized, entity } = await readEntity(scratch, tool, id);

      expectNoLink(serialized);
      expect(entity.metadata_json).toContain(`line${stored}`);
      expect(JSON.parse(entity.metadata_json)).toEqual({ note: `line${escape}${PROTECTED_MESSAGE_MARKER}` });
    });
  });

  it.each(TOOLS.flatMap((tool) => [
    { tool, label: 'scheme-bearing link after the stored escape', canonicalName: 'Mallory', note: `line\n${LINK}` },
    { tool, label: 'bare host after a real newline in a plain column', canonicalName: `Mallory\n${BARE}`, note: 'plain' },
  ]))('$tool control: $label', async ({ tool, canonicalName, note }) => {
    await withScratchDb(async (scratch) => {
      const { id } = upsertEntity(scratch.raw, { kind: 'person', canonicalName, metadata: { note } });

      const { serialized } = await readEntity(scratch, tool, id);

      expectNoLink(serialized);
      expect(serialized.split(PROTECTED_MESSAGE_MARKER)).toHaveLength(2);
    });
  });
});
