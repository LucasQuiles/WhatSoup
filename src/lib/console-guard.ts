// Silence libsignal's direct console.* session/key dumps that bypass pino.
//
// @whiskeysockets/baileys depends on libsignal-node, whose session_record.js
// calls console.info("Closing session:", <SessionEntry>) and similar, each
// serializing a full libsignal Double Ratchet record (private keys, root key,
// prekeys) to stdout — where launchd captures it into an unbounded plaintext
// log. These calls use Node's global console, so pino log levels, pino
// redaction, and the baileys child-logger level override cannot suppress them.
//
// This guard wraps console.{info,log,debug,warn} and drops only calls whose
// first argument is a string starting with one of the known libsignal session
// prefixes. console.error is left untouched (it carries auth/QR UX), and any
// call whose first argument is not one of these prefixes passes through
// unchanged, so legitimate logging is unaffected.

const LIBSIGNAL_KEY_DUMP_PREFIXES = [
  'Closing session:',
  'Removing old closed session:',
  'Opening session:',
  'Migrating session to:',
  'Session already closed',
  'Session already open',
] as const;

function isLibsignalKeyDump(args: unknown[]): boolean {
  const first = args[0];
  return (
    typeof first === 'string' &&
    LIBSIGNAL_KEY_DUMP_PREFIXES.some((prefix) => first.startsWith(prefix))
  );
}

type GuardedMethod = 'info' | 'log' | 'debug' | 'warn';

let installed = false;

export function installConsoleGuard(): void {
  if (installed) return;
  installed = true;
  const c = console as unknown as Record<GuardedMethod, (...args: unknown[]) => void>;
  const methods: GuardedMethod[] = ['info', 'log', 'debug', 'warn'];
  for (const method of methods) {
    const original = c[method].bind(console) as (...args: unknown[]) => void;
    c[method] = (...args: unknown[]): void => {
      if (isLibsignalKeyDump(args)) return;
      original(...args);
    };
  }
}

// Installs on import: pulling this module in from the process entry point is
// sufficient — no explicit call is required.
installConsoleGuard();
