/**
 * Standalone auth CLI for WhatsApp pairing.
 * Interactive — prints QR to terminal.
 * Must not run while the bot process holds its lock file.
 *
 * Usage: node --experimental-strip-types src/transport/auth.ts
 */

import { existsSync } from 'node:fs';
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import { config } from '../config.ts';

// ---------------------------------------------------------------------------
// Lock check
// ---------------------------------------------------------------------------

const lockPath = (config as any).lockPath ?? '/var/run/whatsoup.lock';

if (existsSync(lockPath)) {
  console.error(
    `Bot is currently running. Stop it first: systemctl --user stop whatsoup`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Auth flow
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 120_000;

const timeoutHandle = setTimeout(() => {
  console.error('Timed out after 120 seconds — no successful authentication.');
  process.exit(1);
}, TIMEOUT_MS);

async function startSocket(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version } = await fetchLatestBaileysVersion();

  // Suppress Baileys internals (handshake material, signal keys, etc.)
  const baileysLogger = { level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => baileysLogger } as any;

  const sock = makeWASocket({
    version,
    logger: baileysLogger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.error('\nScan the QR code below with WhatsApp > Linked Devices > Link a Device:\n');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'open') {
      clearTimeout(timeoutHandle);
      const rawId: string | undefined = (sock as any).user?.id;
      const jid = rawId ?? 'unknown';
      console.error(`\nAuthenticated successfully as ${jid}`);
      console.error('Saving credentials...');
      await saveCreds();
      // Give the file system a moment to flush before we exit
      setTimeout(() => {
        try { sock.end(undefined); } catch { /* best-effort */ }
        console.error('Done. You can now start the bot.');
        process.exit(0);
      }, 2_000);
    }

    if (connection === 'close') {
      const statusCode: number | undefined = (lastDisconnect?.error as any)?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        clearTimeout(timeoutHandle);
        console.error('Logged out — delete the auth directory and re-run this script.');
        process.exit(1);
      }

      if (statusCode === DisconnectReason.restartRequired) {
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
}

async function main(): Promise<void> {
  console.error('Starting WhatsApp authentication...');
  console.error(`Auth directory: ${config.authDir}`);
  await startSocket();
}

main().catch((err) => {
  console.error('Auth failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
