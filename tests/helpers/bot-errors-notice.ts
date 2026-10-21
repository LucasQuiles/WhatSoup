import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DISPATCHER = fileURLToPath(new URL('../../deploy/scripts/bot-errors-dispatcher.py', import.meta.url));
const NOTICE_PACKET_INDEX_KIND = 'bot-errors-notice-packet-index';
const MAX_PACKET_OUTPUT_BYTES = 64 * 1024 * 1024;
const PACKET_READ_TIMEOUT_MS = 60_000;
const READ_COMPLETE_PACKET = [
  'import importlib.util, json, sys',
  'from pathlib import Path',
  'dispatcher, ref = sys.argv[1:]',
  'spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_packet_reader", Path(dispatcher))',
  'mod = importlib.util.module_from_spec(spec)',
  'assert spec.loader is not None',
  'spec.loader.exec_module(mod)',
  'packet = mod.read_notice_packet(mod.state_paths(), ref)',
  'if not isinstance(packet, dict) or not isinstance(packet.get("body"), str) or not isinstance(packet.get("card"), str):',
  '    raise SystemExit("no complete notice packet")',
  'if "included" in packet and not isinstance(packet["included"], list):',
  '    raise SystemExit("invalid included notices")',
  'output_packet = {"body": packet["body"], "card": packet["card"]}',
  'if "included" in packet:',
  '    output_packet["included"] = packet["included"]',
  'output = json.dumps(output_packet, ensure_ascii=False, separators=(",", ":"))',
  'if len(output.encode("utf-8")) > 64 * 1024 * 1024:',
  '    raise SystemExit("notice packet output exceeds bound")',
  'sys.stdout.write(output)',
].join('\n');

type NoticePacket = {
  body: string;
  card: string;
  kind?: string;
};

function readIndexedPacket(ref: string, stateRoot: string): NoticePacket {
  let output: string;
  try {
    output = execFileSync('python3', ['-B', '-c', READ_COMPLETE_PACKET, DISPATCHER, ref], {
      cwd: dirname(DISPATCHER),
      env: { ...process.env, BOT_ERRORS_STATE_DIR: stateRoot },
      encoding: 'utf8',
      maxBuffer: MAX_PACKET_OUTPUT_BYTES,
      timeout: PACKET_READ_TIMEOUT_MS,
    });
  } catch {
    throw new Error(`packet ${ref} is unreadable`);
  }
  return JSON.parse(output) as NoticePacket;
}

/**
 * Read a BOT ERRORS dry-send capture (BOT_ERRORS_DRY_SEND_CAPTURE, one JSON
 * record per line) the way an agent reads the group line since relay 16.
 *
 * The group line carries a short human card whose last line names a Ref. The
 * full body the message used to carry (every "  > field: value" line) is in the
 * packet that Ref names, `<state root>/packets/<ref>.json`, written before the
 * send. Each record's text is replaced by that packet's body, so delivery tests
 * keep asserting on the same fields and counts as before. A card whose Ref
 * names no packet, or a packet whose card differs from what was sent, throws;
 * a text with no Ref (the full-body fallback when a packet cannot be written)
 * is kept as sent.
 */
export function noticeBody(text: string, stateRoot: string): string {
  const match = /\nRef: ([0-9a-f]{8})$/.exec(text);
  if (!match) return text;
  const packet = JSON.parse(readFileSync(join(stateRoot, 'packets', `${match[1]}.json`), 'utf8')) as {
    kind?: string;
  } & NoticePacket;
  const complete = packet.kind === NOTICE_PACKET_INDEX_KIND
    ? readIndexedPacket(match[1], stateRoot)
    : packet;
  if (complete.card !== text) {
    throw new Error(`packet ${match[1]} does not hold the card that was sent`);
  }
  return complete.body;
}

/** The capture file with each record's text read through its Ref (state root defaults to the capture's directory). */
export function readCapture(capturePath: string, stateRoot: string = dirname(capturePath)): string {
  return readFileSync(capturePath, 'utf8')
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      const record = JSON.parse(line) as { text: string };
      return JSON.stringify({ ...record, text: noticeBody(record.text, stateRoot) });
    })
    .join('\n');
}

/** The cards exactly as sent, one per capture record. */
export function captureCards(capturePath: string): string[] {
  if (!existsSync(capturePath)) return [];
  return readFileSync(capturePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => (JSON.parse(line) as { text: string }).text);
}
