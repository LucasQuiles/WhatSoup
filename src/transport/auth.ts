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
import { decideDisconnectAction } from './auth-disconnect-policy.ts';
import { redactAuthCliText } from './auth-cli-redaction.ts';
import { createAtomicCredsSaver } from './atomic-auth-save.ts';
import { installThirdPartyConsoleRedaction } from './third-party-console-redaction.ts';
import { baileysVersionLabel, resolveBaileysVersion } from './baileys-version.ts';
import { errorMessage } from '../lib/error-message.ts';
import { classifyPairNumber, maskPairingCode, pairingEmissionLine, pairingGate } from './pairing.ts';

// ---------------------------------------------------------------------------
// Lock check
// ---------------------------------------------------------------------------

const lockPath = (config as any).lockPath ?? join(tmpdir(), 'whatsoup-auth.lock');

if (existsSync(lockPath)) {
  console.error(
    `Bot is currently running. Stop it first:\n` +
    `  Linux: systemctl --user stop whatsoup\n` +
    `  macOS: use the Fleet auth flow or see docs/runbooks/macos-launchd-deployment.md#restart-procedures\n` +
    `         (do not use legacy launchctl stop for a KeepAlive job)`,
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
  console.error('Timed out after 120 seconds — no successful authentication.');
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
  const resolvedVersion = await resolveBaileysVersion();
  console.error(`Using Baileys web version ${baileysVersionLabel(resolvedVersion.version)} (${resolvedVersion.source})`);

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
      console.error('Credential save failed:', redactAuthCliText(errorMessage(err)));
    });
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && classifyPairNumber(process.env.WHATSOUP_PAIR_NUMBER).reason === 'unset') {
      // Emit raw QR for fleet SSE consumers (stdout = structured JSON only)
      process.stdout.write(JSON.stringify({ event: 'qr', data: qr }) + '\n');
      // Terminal QR for interactive use — redirect to stderr so stdout stays clean
      console.error('\nScan the QR code below with WhatsApp > Linked Devices > Link a Device:\n');
      qrcodeTerminal.generate(qr, { small: true }, (asciiArt: string) => {
        process.stderr.write(asciiArt + '\n');
      });
    }

    if (connection === 'open') {
      clearTimeout(timeoutHandle);
      const rawId: string | undefined = (sock as any).user?.id;
      const jid = rawId ?? 'unknown';
      console.error(`\nAuthenticated successfully as ${redactAuthCliText(jid)}`);
      console.error('Saving credentials...');
      // #2165: an unguarded await here had two failure modes, both silent to
      // the operator — the rejection was unhandled (listener bodies are outside
      // main()'s chain), and the success path below never ran, so the CLI
      // neither printed "Done" nor exited. Pairing is worthless without
      // persisted creds, so a save failure is fatal and must say so.
      try {
        await saveCreds();
      } catch (err) {
        console.error('FATAL: credential save failed:', redactAuthCliText(errorMessage(err)));
        console.error('Pairing did not complete — the bot cannot start without saved credentials.');
        process.exit(1);
        return;
      }
      // Fleet activation treats this as a persisted credential success signal.
      // It must not start the managed instance while a failed save is still
      // possible, because the instance would otherwise race its auth material.
      process.stdout.write(JSON.stringify({ event: 'connected' }) + '\n');
      // Give the file system a moment to flush before we exit
      setTimeout(() => {
        try { sock.end(undefined); } catch { /* best-effort */ }
        console.error('Done. You can now start the bot.');
        process.exit(0);
      }, 2_000);
    }

    if (connection === 'close') {
      const statusCode: number | undefined = (lastDisconnect?.error as any)?.output?.statusCode;
      const restartRequiredCount = recordRestartRequired(statusCode);
      const action = decideDisconnectAction(statusCode, { restartRequiredCount });

      if (action.type === 'exit') {
        clearTimeout(timeoutHandle);
        console.error('Logged out — delete the auth directory and re-run this script.');
        process.exit(1);
        return;
      }

      if (action.type === 'reconnect' && action.reason === 'restart-required-flapping') {
        console.error(
          `restartRequired flapping detected (${action.count} in <60s) — backing off before reconnecting...`,
        );
        restartRequiredTimestamps = [];
        try { sock.end(undefined); } catch { /* best-effort */ }
        setTimeout(() => {
          void startSocket();
        }, RESTART_REQUIRED_FLAP_RECONNECT_DELAY_MS);
        return;
      }

      if (action.type === 'reconnect' && action.reason === 'restart-required') {
        console.error('Restart required — reconnecting...');
        try { sock.end(undefined); } catch { /* best-effort */ }
        await startSocket();
        return;
      }
      const reason = statusCode !== undefined ? (DisconnectReason[statusCode] ?? `unknown(${statusCode})`) : 'unknown';
      console.error(`Connection closed during auth: ${reason} — reconnecting...`);
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
        console.error(
          `Pairing code ready (masked ${maskPairingCode(code)}). Enter it on the primary phone: ` +
          `Linked devices > Link a device > Link with phone number.`,
        );
      } catch (err) {
        console.error('requestPairingCode failed:', redactAuthCliText(errorMessage(err)));
        pairingRequested = false;
      }
    }, 2_500);
  }
}

async function main(): Promise<void> {
  const pairCls = classifyPairNumber(process.env.WHATSOUP_PAIR_NUMBER);
  if (pairCls.reason === 'invalid') {
    console.error('FATAL: WHATSOUP_PAIR_NUMBER is set but not a valid number (expected 8-15 digits).');
    process.exit(1);
  }
  console.error('Starting WhatsApp authentication...');
  console.error(`Auth mode: ${pairCls.ok ? 'pairing-code' : 'QR'}`);
  console.error(`Auth directory: ${redactAuthCliText(config.authDir)}`);
  await startSocket();
}

main().catch((err) => {
  console.error('Auth failed:', redactAuthCliText(errorMessage(err)));
  process.exit(1);
});
