import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
    body: string;
    card: string;
  };
  if (packet.card !== text) {
    throw new Error(`packet ${match[1]} does not hold the card that was sent`);
  }
  return packet.body;
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
