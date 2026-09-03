import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  type Stats,
} from 'node:fs';

export interface AuthBondFileSnapshot {
  path: string;
  exists: boolean;
  mode: string | null;
  size: number | null;
  mtime: string | null;
  sha256: string | null;
  /**
   * errno of a non-ENOENT failure while snapshotting, else null.
   *
   * `exists: false` alone cannot be read as "absent": it is also what a bare
   * catch produced for EACCES/EIO. With this field, absent is `exists:false,
   * error:null` and unreadable is a non-null error — and when lstat succeeded
   * but the content read did not, `exists` stays TRUE alongside the error.
   */
  error: string | null;
}

/**
 * Ceiling on a credential file this reader will take bytes from.
 *
 * O_NONBLOCK bounds the OPEN. It does not bound the READ: POSIX gives it no
 * effect on read(2) for a regular file, so a large object that passes the kind
 * check is still read synchronously, on the main thread, on an unauthenticated
 * GET /health. The held-descriptor swap check is detection and not a boundary
 * (Node exposes no openat(2)), so an ABA swap can still put an attacker-chosen
 * regular file behind this descriptor. The cap is enforced against the
 * descriptor by a bounded readSync loop, so an actor who extends the object
 * between the fstat and the read cannot get more than MAX_CREDS_BYTES out of
 * the reader: the loop refuses `creds_json_too_large:<bytes>` on the first
 * chunk that would exceed the buffer.
 *
 * A real creds.json is a few kilobytes: the fixtures in this repo write ~150
 * bytes, and a live Baileys credential holds a handful of base64 keys plus one
 * signalIdentities array. 1 MiB is two to three orders of magnitude above that
 * — far above the "at least 10x the largest real file" bar, deliberately. The
 * cost of a cap that is too TIGHT is not a false alarm: a refused credential
 * makes status non-'present', and restoreLatestIfNeeded treats any non-present
 * status at connect time as grounds for a destructive quarantine-and-restore.
 */
export const MAX_CREDS_BYTES = 1_048_576;

/**
 * Starting capacity of the credential read buffer, before any growth.
 *
 * The cap above is the REFUSAL bound; this is the ALLOCATION the ordinary read
 * pays. They were the same number, which meant a fixed 1 MiB scratch buffer per
 * read of a ~150 byte credential — on a path an unauthenticated GET /health
 * reaches through inspectCached(), on the branch whose purpose is removing
 * per-request auth cost. The buffer now starts at the observed size and doubles
 * only when the descriptor actually yields more, so the stat informs the
 * allocation without ever becoming the bound.
 */
const CREDS_READ_INITIAL_BYTES = 4_096;

/**
 * Ceiling on readSync calls for one credential read.
 *
 * A byte bound is not an operation bound. A descriptor that legally returns one
 * byte per call reaches MAX_CREDS_BYTES only after a million synchronous reads,
 * blocking the event loop for all of them on the unauthenticated health path.
 * Reaching this ceiling is reported as `creds_json_read_incomplete:<ops>`, a
 * RETRYABLE class in TRANSIENT_AUTH_READ_ISSUE_PREFIXES: the descriptor was
 * never read to a verdict, so it must not reach the corruption class or the
 * destructive restore. Also bounds EINTR retries, which share the budget.
 */
const MAX_CREDS_READ_OPS = 4_096;

/** O_DIRECTORY is absent on some platforms; 0 is a safe no-op in an OR of flags. */
const O_DIRECTORY_FLAG = fsConstants.O_DIRECTORY ?? 0;

function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function modeString(mode: number): string {
  return (mode & 0o777).toString(8);
}

/**
 * True only for "the entry is no longer there" — Baileys rotates key files
 * constantly, so an entry can disappear between the readdir that listed it and
 * the stat/read that consumes it.
 *
 * ENOENT only, on purpose. EACCES means the tree is genuinely unreadable and
 * EIO means the disk is failing; both are real faults that must keep
 * propagating. A blanket `catch { continue }` here would convert them into a
 * silently short auth-tree observation.
 */
export function isVanishedEntry(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * errno of a filesystem rejection, defaulting to EIO when the thrown value
 * carries no code — an unlabelled failure is still a failure, and returning
 * null there would make it indistinguishable from success.
 */
export function errnoCode(err: unknown): string {
  return (err as NodeJS.ErrnoException | null)?.code ?? 'EIO';
}

/**
 * Errnos that mean "not right now", never "this object is broken".
 *
 * EAGAIN and EWOULDBLOCK share a value on Linux and macOS, so Node reports one
 * of them; both names are matched because the platform contract does not
 * promise which.
 */
function isTransientIoErrno(code: string): boolean {
  return code === 'EAGAIN' || code === 'EWOULDBLOCK';
}

/**
 * Snapshot one path, keeping "absent" and "unreadable" distinct.
 *
 * The two failures are stated separately on purpose, and it matters which one
 * you are looking at: absent means re-pair, unreadable means fix the mode or
 * the disk. The same ENOENT-only rule isVanishedEntry documents applies here —
 * a blanket catch turned EACCES/EIO into "there are no credentials".
 *
 * lstat and the content read are caught separately because a read that fails
 * AFTER a successful lstat has already proven the file exists; collapsing both
 * into one catch reported exists:false for a file the very same call had just
 * stat'd, and discarded the mode/size/mtime it had successfully obtained.
 */
export function fileSnapshot(path: string, includeHash = false): AuthBondFileSnapshot {
  const absent = (error: string | null): AuthBondFileSnapshot => ({
    path,
    exists: false,
    mode: null,
    size: null,
    mtime: null,
    sha256: null,
    error,
  });

  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    // ENOENT is the only code that means "not there"; anything else is a fault
    // we could not see past, so it is reported as such rather than as absence.
    return absent(isVanishedEntry(err) ? null : errnoCode(err));
  }

  const base = {
    path,
    exists: true,
    mode: modeString(st.mode),
    size: st.size,
    mtime: st.mtime.toISOString(),
  };

  if (!includeHash || !st.isFile() || st.isSymbolicLink()) {
    return { ...base, sha256: null, error: null };
  }

  try {
    return { ...base, sha256: hashBuffer(readFileSync(path)), error: null };
  } catch (err) {
    // The file demonstrably exists — lstat just returned for it. Keep the
    // metadata that succeeded and report why the content could not be hashed.
    return { ...base, sha256: null, error: errnoCode(err) };
  }
}

/** One creds.json read, through one descriptor that refuses to follow a link. */
export interface CredsRead {
  readonly snapshot: AuthBondFileSnapshot;
  /** Exactly the bytes `snapshot.sha256` covers; null when nothing was read. */
  readonly bytes: Buffer | null;
  /** Set when the path is not a regular file. Never null-and-readable together. */
  readonly kindIssue: string | null;
}

/**
 * One bounded read attempt: bytes taken, or the issue that stopped the read.
 *
 * A union rather than a throw so the two stop conditions the credential reader
 * must not confuse with a corrupt file — a mid-read transient and an exhausted
 * operation budget — travel back as data and cannot be caught by the generic
 * handler that turns throws into `creds_json_unreadable:<errno>`.
 */
type BoundedRead =
  | { readonly ok: true; readonly n: number }
  | { readonly ok: false; readonly kindIssue: string };

/**
 * One creds.json read, through one descriptor that refuses to follow a link.
 *
 * Replaces an lstat-then-read-then-read-again sequence with two defects. The
 * hash came from `readFileSync(path)` guarded by an lstat, and the JSON parse
 * came from a SECOND `readFileSync(path)` that had no guard at all, so a
 * creds.json swapped for a symlink between the two reads was hashed as absent
 * and then parsed through the link. Worse, the parse followed the link even
 * when the tree walk that was supposed to catch the symlink was serving a stale
 * clean result, and pointing the link at a FIFO would block the event loop
 * synchronously from an unauthenticated /health request — the exact failure
 * class this branch exists to remove.
 *
 * O_NOFOLLOW makes the kernel refuse the open, and fstat on the resulting
 * descriptor describes the object actually opened, so validation and read
 * cannot race. The bytes are returned so the caller hashes and parses the same
 * ones.
 */
export function readCredsThroughNoFollow(authDir: string, path: string): CredsRead {
  const absent = (error: string | null): CredsRead => ({
    snapshot: { path, exists: false, mode: null, size: null, mtime: null, sha256: null, error },
    bytes: null,
    kindIssue: null,
  });
  const present = (
    st: Stats,
    sha256: string | null,
    error: string | null,
  ): AuthBondFileSnapshot => ({
    path,
    exists: true,
    mode: modeString(st.mode),
    size: st.size,
    mtime: st.mtime.toISOString(),
    sha256,
    error,
  });

  // `credsExists` defaults to FALSE because most refusals happen on the ROOT,
  // before the child is looked at at all, and a snapshot that claims
  // creds.json exists while carrying null mode, size, mtime and hash is
  // internally inconsistent telemetry. Only a refusal that observed the child
  // AND can still vouch for the root it was resolved through passes true —
  // `auth_dir_replaced_during_read` opened the child but cannot vouch for the
  // pathname the descriptor still names, so it takes the false default even
  // though a child was looked at.
  //
  // This describes `refused()` and nothing else. The exits that DID observe
  // the descriptor and can describe it — both `creds_json_too_large` refusals
  // and the two bounded-read refusals below — return `present(st, …)` instead,
  // reporting the real mode, size and mtime they read off it.
  const refused = (kindIssue: string, credsExists = false): CredsRead => ({
    snapshot: { path, exists: credsExists, mode: null, size: null, mtime: null, sha256: null, error: null },
    bytes: null,
    kindIssue,
  });

  // Pin the auth root by descriptor first. O_DIRECTORY refuses a non-directory
  // and O_NOFOLLOW refuses a symlinked root, both in the kernel, before any
  // child path is resolved through it. Holding the descriptor open across the
  // child open is what lets the swap check below mean anything: on POSIX the
  // descriptor keeps referring to the directory we validated even if the path
  // is renamed away underneath it.
  //
  // Node exposes no openat(2), so the child is still opened by path. This is
  // therefore swap DETECTION anchored on a held descriptor, not true openat
  // semantics: a root that is still swapped when the check runs is refused,
  // and a swap-and-restore inside the window is not.
  let rootFd: number;
  try {
    rootFd = openSync(authDir, fsConstants.O_RDONLY | O_DIRECTORY_FLAG | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    if (isVanishedEntry(err)) return absent(null);
    const code = errnoCode(err);
    if (code === 'ELOOP') return refused('auth_dir_symlink');
    if (code === 'ENOTDIR') return refused('auth_dir_not_directory');
    if (isTransientIoErrno(code)) return refused(`auth_dir_read_transient:${code}`);
    return absent(code);
  }

  try {
    let rootStat: ReturnType<typeof fstatSync>;
    try {
      rootStat = fstatSync(rootFd);
    } catch (err) {
      // Every other filesystem call in this function turns a throw into an
      // issue. This one sat inside a try that has only a finally, so a throw
      // escaped readCredsThroughNoFollow, buildSnapshot and inspectCached into
      // the /health handler. Reported against the auth DIRECTORY, because that
      // is the descriptor that failed; the credential was never looked at.
      return refused(`auth_dir_stat_failed:${errnoCode(err)}`);
    }

    let fd: number;
    try {
      // O_NONBLOCK is load-bearing, not tidiness. open(2) on a FIFO with
      // O_RDONLY and no writer BLOCKS until a writer arrives. This is a
      // synchronous call on the main thread reached from an unauthenticated
      // GET /health, so without it a FIFO planted at creds.json stops the
      // process serving anything, forever, and no watchdog that waits for exit
      // ever fires. The kind check below cannot help: it runs after the open.
      fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (err) {
      if (isVanishedEntry(err)) return absent(null);
      const code = errnoCode(err);
      // O_NOFOLLOW reports a symlinked target as ELOOP on Linux and macOS. That
      // is a refusal to follow, which is a finding about the tree, not an
      // unreadable file — the operator's next move differs.
      if (code === 'ELOOP') return refused('creds_json_symlink', true);
      // A nonblocking open that reports "not now" says nothing about the file's
      // contents. Reported apart from `creds_json_unreadable:` so an operator —
      // and any future classifier — can tell "retry" from "corrupt".
      if (isTransientIoErrno(code)) return refused(`creds_json_read_transient:${code}`);
      return absent(code);
    }

    try {
      const st = fstatSync(fd);
      // A FIFO, socket or device would block or misreport on read. Refuse by
      // kind rather than by name, before any byte is taken from it.
      if (!st.isFile()) {
        return { snapshot: present(st, null, null), bytes: null, kindIssue: 'creds_json_not_regular_file' };
      }
      // Bound the READ, which O_NONBLOCK does not. Checked on the DESCRIPTOR,
      // so it describes the object actually opened rather than whatever the
      // pathname resolves to now. See MAX_CREDS_BYTES.
      if (st.size > MAX_CREDS_BYTES) {
        return {
          snapshot: present(st, null, null),
          bytes: null,
          kindIssue: `creds_json_too_large:${st.size}`,
        };
      }
      // The root that resolved this child must still be the root we validated.
      const rootNow = lstatSync(authDir);
      if (rootNow.dev !== rootStat.dev || rootNow.ino !== rootStat.ino) {
        return refused('auth_dir_replaced_during_read');
      }
      // Enforce the cap against the DESCRIPTOR, not st.size, so an actor who
      // extends the object between the fstat above and this read cannot get
      // more bytes past the check than the buffer holds. readFileSync(fd) took
      // its own stat internally, which made the earlier size check informative
      // and not load-bearing. See MAX_CREDS_BYTES.
      //
      // st.size picks the STARTING capacity and nothing else — see
      // CREDS_READ_INITIAL_BYTES. It is never trusted as the bound: a
      // descriptor that yields more than the stat promised GROWS the buffer
      // rather than being refused, so a credential that legitimately grows
      // while staying under the cap still reads cleanly, and the cap-plus-probe
      // refusal below stays the only thing that bounds the read.
      let operations = 0;
      // One bounded readSync carrying the two errno rules this path needs.
      // EINTR is a signal landing mid-call and says nothing about the file, so
      // it is retried against the operation budget rather than surfacing.
      // EAGAIN/EWOULDBLOCK mid-read is the same "not now" the two opens above
      // report, so it takes the same transient class: without this it fell
      // through to the outer catch as `creds_json_unreadable:<errno>`, which is
      // the input that pages as local corruption and satisfies the destructive
      // restore's precondition.
      //
      // Deliberately NOT readPrivateFileSync (src/lib/private-fs.ts:249), which
      // reads a capped private file with the same open flags. Two reasons it
      // cannot serve this path: it THROWS on every refusal, and a throw here
      // escapes buildSnapshot and inspectCached into the unauthenticated
      // /health handler; and its `Buffer.alloc(maxBytes + 1)` at :281 is
      // unconditional, which at a 1 MiB cap is the per-request allocation this
      // reader exists to avoid. A shared size-informed reader for the three
      // call sites is tracked as follow-up outside this branch.
      const readBounded = (target: Buffer, offset: number, length: number): BoundedRead => {
        while (operations < MAX_CREDS_READ_OPS) {
          operations += 1;
          try {
            return { ok: true, n: readSync(fd, target, offset, length, null) };
          } catch (err) {
            const code = errnoCode(err);
            if (code === 'EINTR') continue;
            if (isTransientIoErrno(code)) {
              return { ok: false, kindIssue: `creds_json_read_transient:${code}` };
            }
            throw err;
          }
        }
        return { ok: false, kindIssue: `creds_json_read_incomplete:${operations}` };
      };
      // Reported through present(), not refused(): the child was opened and
      // fstat'd, so its mode, size and mtime are real observations of the
      // object that failed, and a null-everything snapshot would discard them.
      const incomplete = (kindIssue: string): CredsRead => ({
        snapshot: present(st, null, null),
        bytes: null,
        kindIssue,
      });

      let capacity = Math.min(Math.max(st.size + 1, CREDS_READ_INITIAL_BYTES), MAX_CREDS_BYTES);
      let buf = Buffer.allocUnsafe(capacity);
      let filled = 0;
      while (filled < MAX_CREDS_BYTES) {
        if (filled === capacity) {
          capacity = Math.min(capacity * 2, MAX_CREDS_BYTES);
          const grown = Buffer.allocUnsafe(capacity);
          buf.copy(grown, 0, 0, filled);
          buf = grown;
        }
        const read = readBounded(buf, filled, capacity - filled);
        if (!read.ok) return incomplete(read.kindIssue);
        if (read.n === 0) break;
        filled += read.n;
      }
      // The read reached the cap and the descriptor still has more to give.
      // Refuse by kind: reported bytes are the ones observed on the descriptor,
      // which is the same shape as the fstat-based refusal above. The probe is
      // allocated only on the one branch that needs it.
      let overflow = false;
      if (filled === MAX_CREDS_BYTES) {
        const probe = readBounded(Buffer.allocUnsafe(1), 0, 1);
        if (!probe.ok) return incomplete(probe.kindIssue);
        overflow = probe.n > 0;
      }
      if (overflow) {
        return {
          snapshot: present(st, null, null),
          bytes: null,
          kindIssue: `creds_json_too_large:${filled + 1}`,
        };
      }
      // Copy the filled prefix out so the read buffer — which may have grown
      // well past the credential — stays local rather than backing the bytes
      // that are retained and hashed.
      const bytes = Buffer.from(buf.subarray(0, filled));
      return { snapshot: present(st, hashBuffer(bytes), null), bytes, kindIssue: null };
    } catch (err) {
      let st = null;
      try {
        st = fstatSync(fd);
      } catch {
        // Intentional: the original read failure remains the reported evidence
        // when the already-failing descriptor cannot be inspected again.
      }
      return {
        snapshot: st
          ? present(st, null, errnoCode(err))
          : { path, exists: true, mode: null, size: null, mtime: null, sha256: null, error: errnoCode(err) },
        bytes: null,
        kindIssue: null,
      };
    } finally {
      // Every descriptor this function opens is closed by this function. Stated
      // without reference to how the bytes are taken, so a change of reader
      // cannot leave the reason stale: the open above is the only thing that
      // makes this necessary.
      try {
        closeSync(fd);
      } catch {
        // Intentional: cleanup follows a completed observation, and a close
        // failure cannot improve or invalidate the evidence already produced.
      }
    }
  } finally {
    try {
      closeSync(rootFd);
    } catch {
      // Intentional: cleanup follows a completed observation, and a close
      // failure cannot improve or invalidate the evidence already produced.
    }
  }
}
