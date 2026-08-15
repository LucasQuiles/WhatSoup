/**
 * Standalone auth CLI for WhatsApp pairing.
 * Interactive — prints QR to terminal.
 * Must not run while the bot process holds its lock file.
 *
 * Usage: node --experimental-strip-types src/transport/auth.ts
 */

import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import { config } from '../config.ts';
// createChildLogger must be imported after config.ts in source order — config.ts sets
// process.env.LOG_DIR at its own module top level, and logger.ts reads it once at import
// time (see src/config.ts:421-422). No transitive dependency enforces this ordering.
import { createChildLogger } from '../logger.ts';
import { decideDisconnectAction } from './auth-disconnect-policy.ts';
import { redactAuthCliText } from './auth-cli-redaction.ts';
import { createAtomicCredsSaver } from './atomic-auth-save.ts';
import { installThirdPartyConsoleRedaction } from './third-party-console-redaction.ts';
import { baileysVersionLabel, resolveBaileysVersion } from './baileys-version.ts';
import { errorMessage } from '../lib/error-message.ts';
import { classifyPairNumber, maskPairingCode, pairingEmissionLine, pairingGate } from './pairing.ts';

const log = createChildLogger('auth-cli');

// ---------------------------------------------------------------------------
// Lock check
// ---------------------------------------------------------------------------

const lockPath = (config as any).lockPath ?? join(tmpdir(), 'whatsoup-auth.lock');

if (existsSync(lockPath)) {
  log.fatal({ lockPath }, 'bot is currently running; refusing auth attempt');
  // Human-readable pairing-CLI channel — writes to stderr (byte-identical to the
  // prior console.error). The structured pipeline is served in parallel by the
  // adjacent log.* twins (added by the #2930 console-ratchet tranche); stdout
  // stays reserved for fleet JSON ({event:'qr'}/{event:'connected'}).
  process.stderr.write(
    `Bot is currently running. Stop it first:\n` +
    `  Linux: systemctl --user stop whatsoup\n` +
    `  macOS: use the Fleet auth flow or see docs/runbooks/macos-launchd-deployment.md#restart-procedures\n` +
    `         (do not use legacy launchctl stop for a KeepAlive job)\n`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Auth flow
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 120_000;
const RESTART_REQUIRED_FLAP_WINDOW_MS = 60_000;
const RESTART_REQUIRED_FLAP_RECONNECT_DELAY_MS = 1_000;

const timeoutHandle = setTimeout(() => {
  log.error('auth timed out after 120s with no successful authentication');
  process.stderr.write('Timed out after 120 seconds — no successful authentication.\n');
  process.exit(1);
}, TIMEOUT_MS);

let restartRequiredTimestamps: number[] = [];
let pairingRequested = false;

function recordRestartRequired(statusCode: number | undefined): number {
  if (statusCode !== DisconnectReason.restartRequired) return 0;

  const now = Date.now();
  restartRequiredTimestamps.push(now);
  restartRequiredTimestamps = restartRequiredTimestamps.filter(
    timestamp => now - timestamp < RESTART_REQUIRED_FLAP_WINDOW_MS,
  );
  return restartRequiredTimestamps.length;
}

async function startSocket(): Promise<void> {
  installThirdPartyConsoleRedaction();

  const { state } = await useMultiFileAuthState(config.authDir);
  const saveCreds = createAtomicCredsSaver(config.authDir, () => state.creds);
  const resolvedVersion = await resolveBaileysVersion(config.baileysVersionPinned);
  log.info({ version: resolvedVersion.version, source: resolvedVersion.source }, 'using baileys web version');
  process.stderr.write(`Using Baileys web version ${baileysVersionLabel(resolvedVersion.version)} (${resolvedVersion.source})\n`);

  // Suppress Baileys internals (handshake material, signal keys, etc.)
  const baileysLogger = { level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => baileysLogger } as any;

  const sock = makeWASocket({
    version: resolvedVersion.version,
    logger: baileysLogger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    generateHighQualityLinkPreview: false,
  });

  // #2165: `saveCreds()` rejects on a real write failure (full disk, EACCES).
  // Passing it straight to `.on` discards the returned promise, so that
  // rejection had no handler — and the `main().catch` at the bottom of this
  // file does NOT cover it, because listener callbacks are outside main()'s
  // promise chain. Under Node's default unhandled-rejection policy that
  // terminates the pairing CLI with no explanation of what failed.
  sock.ev.on('creds.update', () => {
    void saveCreds().catch((err) => {
      log.error({ err }, 'credential save failed');
      process.stderr.write(`Credential save failed: ${redactAuthCliText(errorMessage(err))}\n`);
    });
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && classifyPairNumber(process.env.WHATSOUP_PAIR_NUMBER).reason === 'unset') {
      // Emit raw QR for fleet SSE consumers (stdout = structured JSON only)
      process.stdout.write(JSON.stringify({ event: 'qr', data: qr }) + '\n');
      // Terminal QR for interactive use — redirect to stderr so stdout stays clean
      log.info('qr code ready for scanning');
      process.stderr.write('\nScan the QR code below with WhatsApp > Linked Devices > Link a Device:\n');
      qrcodeTerminal.generate(qr, { small: true }, (asciiArt: string) => {
        process.stderr.write(asciiArt + '\n');
      });
    }

    if (connection === 'open') {
      clearTimeout(timeoutHandle);
      const rawId: string | undefined = (sock as any).user?.id;
      const jid = rawId ?? 'unknown';
      log.info({ jid: redactAuthCliText(jid) }, 'authenticated successfully');
      process.stderr.write(`\nAuthenticated successfully as ${redactAuthCliText(jid)}\n`);
      log.info('saving credentials');
      process.stderr.write('Saving credentials...\n');
      // #2165: an unguarded await here had two failure modes, both silent to
      // the operator — the rejection was unhandled (listener bodies are outside
      // main()'s chain), and the success path below never ran, so the CLI
      // neither printed "Done" nor exited. Pairing is worthless without
      // persisted creds, so a save failure is fatal and must say so.
      try {
        await saveCreds();
      } catch (err) {
        log.fatal({ err }, 'credential save failed; pairing cannot complete');
        process.stderr.write(`FATAL: credential save failed: ${redactAuthCliText(errorMessage(err))}\n`);
        process.stderr.write('Pairing did not complete — the bot cannot start without saved credentials.\n');
        process.exit(1);
        return;
      }
      // Fleet activation treats this as a persisted credential success signal.
      // It must not start the managed instance while a failed save is still
      // possible, because the instance would otherwise race its auth material.
      process.stdout.write(JSON.stringify({ event: 'connected' }) + '\n');
      // #2322 M5: saveCreds() already fsync'd + renamed above — durability is
      // guaranteed by the time the await returns, so there is nothing left to
      // wait on. A wall-clock sleep here was a TOCTOU-flavored fragility (it
      // misrepresented where the durability boundary actually is) and added
      // 2s to every pair flow for no benefit.
      try { sock.end(undefined); } catch { /* best-effort */ }
      log.info('pairing complete; bot can now be started');
      process.stderr.write('Done. You can now start the bot.\n');
      process.exit(0);
    }

    if (connection === 'close') {
      const statusCode: number | undefined = (lastDisconnect?.error as any)?.output?.statusCode;
      const restartRequiredCount = recordRestartRequired(statusCode);
      const action = decideDisconnectAction(statusCode, { restartRequiredCount });

      if (action.type === 'exit') {
        clearTimeout(timeoutHandle);
        log.warn('logged out; auth directory must be deleted before re-running');
        process.stderr.write('Logged out — delete the auth directory and re-run this script.\n');
        process.exit(1);
        return;
      }

      if (action.type === 'reconnect' && action.reason === 'restart-required-flapping') {
        log.warn({ count: action.count }, 'restartRequired flapping detected; backing off before reconnecting');
        process.stderr.write(
          `restartRequired flapping detected (${action.count} in <60s) — backing off before reconnecting...\n`,
        );
        restartRequiredTimestamps = [];
        try { sock.end(undefined); } catch { /* best-effort */ }
        setTimeout(() => {
          void startSocket();
        }, RESTART_REQUIRED_FLAP_RECONNECT_DELAY_MS);
        return;
      }

      if (action.type === 'reconnect' && action.reason === 'restart-required') {
        log.info('restart required; reconnecting');
        process.stderr.write('Restart required — reconnecting...\n');
        try { sock.end(undefined); } catch { /* best-effort */ }
        await startSocket();
        return;
      }
      const reason = statusCode !== undefined ? (DisconnectReason[statusCode] ?? `unknown(${statusCode})`) : 'unknown';
      log.warn({ reason }, 'connection closed during auth; reconnecting');
      process.stderr.write(`Connection closed during auth: ${reason} — reconnecting...\n`);
      try { sock.end(undefined); } catch { /* best-effort */ }
      await startSocket();
    }
  });

  // Pairing-code mode — inert unless WHATSOUP_PAIR_NUMBER is set (QR mode is
  // unaffected). Deferred + single-fire so repeated connection updates never
  // request multiple codes; skipped when creds are already registered.
  const pgate = pairingGate({
    rawNumber: process.env.WHATSOUP_PAIR_NUMBER,
    registered: Boolean(state.creds.registered),
    alreadyRequested: pairingRequested,
  });
  if (pgate.request) {
    pairingRequested = true;
    setTimeout(async () => {
      try {
        const cls = classifyPairNumber(process.env.WHATSOUP_PAIR_NUMBER);
        if (!cls.ok) return;
        const code = await sock.requestPairingCode(cls.number);
        // Real code: stdout automation channel only (consumed by the relink orchestrator).
        process.stdout.write(pairingEmissionLine(code) + '\n');
        // Logs/human: masked only — never the full code, never the phone number.
        log.info({ maskedCode: maskPairingCode(code) }, 'pairing code ready');
        process.stderr.write(
          `Pairing code ready (masked ${maskPairingCode(code)}). Enter it on the primary phone: ` +
          `Linked devices > Link a device > Link with phone number.\n`,
        );
      } catch (err) {
        log.error({ err }, 'requestPairingCode failed');
        process.stderr.write(`requestPairingCode failed: ${redactAuthCliText(errorMessage(err))}\n`);
        pairingRequested = false;
      }
    }, 2_500);
  }
}

async function main(): Promise<void> {
  const pairCls = classifyPairNumber(process.env.WHATSOUP_PAIR_NUMBER);
  if (pairCls.reason === 'invalid') {
    log.fatal('WHATSOUP_PAIR_NUMBER is set but not a valid number (expected 8-15 digits)');
    process.stderr.write('FATAL: WHATSOUP_PAIR_NUMBER is set but not a valid number (expected 8-15 digits).\n');
    process.exit(1);
  }
  log.info(
    { mode: pairCls.ok ? 'pairing-code' : 'QR', authDir: redactAuthCliText(config.authDir) },
    'starting whatsapp authentication',
  );
  process.stderr.write('Starting WhatsApp authentication...\n');
  process.stderr.write(`Auth mode: ${pairCls.ok ? 'pairing-code' : 'QR'}\n`);
  process.stderr.write(`Auth directory: ${redactAuthCliText(config.authDir)}\n`);
  await startSocket();
}

main().catch((err) => {
  log.fatal({ err }, 'auth failed');
  process.stderr.write(`Auth failed: ${redactAuthCliText(errorMessage(err))}\n`);
  process.exit(1);
});
