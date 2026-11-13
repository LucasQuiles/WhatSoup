"""Replace one protected launchd plist without changing its owner or protection.

The helper runs as root from a fixed root-owned path (root-helper.json; see
docs/runbooks/release-deployment.md), started by the one sudoers rule
`/usr/bin/python3 -I -S -B <that path>`. `-I` keeps the caller's environment,
user site and script folder off the import path, because sudo keeps HOME; `-S`
keeps site-packages and .pth files off it. The helper imports only the
standard library.

The sudo caller owns the folders on the path to its plist. Every filesystem
step therefore works through file descriptors bound to the inodes that were
checked: folders are opened one component at a time from "/" without following
a symlink, names are resolved relative to the opened folder (openat, renameat,
unlinkat), and owner, mode and flag changes go to descriptors this helper
opened.

Which inodes root changes, and why the caller cannot redirect it:
- the target plist: only its UF_IMMUTABLE flag is cleared and restored. Before
  that the target must be root-owned, single-link and immutable. A non-root
  caller can neither clear that flag nor add, remove or move a name of an
  immutable inode, so the inode opened through the folder keeps that one name.
  A target without flags is only read, never changed;
- files this run created with O_EXCL: written, chowned, chmodded and flagged.
  Their mode never exceeds 0644, so a copy the caller moves away is a
  non-executable file holding plist bytes the caller supplied anyway;
- entries of the caller-owned folder: renamed or removed by single-component
  name, which the caller could do itself.
A lock on this file serialises helper runs, so no other run changes a flag
meanwhile.

What it cannot guarantee: the caller owns the folder, so after the rename and
before the new file is made immutable it can replace the name. That is
detected and reported as RecoveryIncomplete (exit 3), never as success. The
caller can always replace its own LaunchAgents folder, so `uchg` there is
tamper resistance, not a security boundary.

The helper also runs no other program: sudo can keep the caller's PATH, so a
program named without a path would be one the caller chose, run as root.

The caller can signal its own sudo, which relays the signal, and its resource
limits carry over. While main() runs, run() therefore blocks in its own thread
every signal except SIGKILL, SIGSTOP and the crash signals (SIGSEGV, SIGBUS,
SIGFPE, SIGILL, SIGTRAP, SIGABRT, SIGSYS), and it sets to SIG_IGN, for the
whole process, the blocked ones whose default action terminates, cores or
stops: SIGHUP, SIGINT, SIGQUIT, SIGEMT, SIGPIPE, SIGALRM, SIGTERM, SIGTSTP,
SIGTTIN, SIGTTOU, SIGXCPU, SIGXFSZ, SIGVTALRM, SIGPROF, SIGUSR1 and SIGUSR2.
A mask alone is not enough: os.getgrouplist starts a thread that leaves
SIGPROF and SIGEMT deliverable. An ignored signal is discarded whichever
thread it reaches. The other blocked signals (SIGURG, SIGCONT, SIGCHLD, SIGIO,
SIGWINCH, SIGINFO) default to discard and keep their disposition. It also
raises the CPU limit. When main() returns or raises, the mask and the
dispositions are restored. SIGKILL and SIGSTOP cannot be blocked, caught or
ignored. SIGABRT and the fault signals stay deliverable because they report
the helper's own crash, but the caller can also relay them.

A failure raised during the change re-protects what it can; it exits 2 when
the plist is confirmed as found and 3 otherwise, and always 3 for an
interruption raised as an exception, such as KeyboardInterrupt. A death by a
signal left deliverable re-protects nothing. After the flag clear it leaves
the target without uchg, holding the old bytes before the rename or the new
bytes after it, and possibly this run's temporary file in the folder.
Activation (apply.ts) reports it, like every result but exit 0 with the new
bytes in place or exit 2, as unconfirmed.
"""
import contextlib
import ctypes
import errno
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import plistlib
import pwd
import re
import resource
import secrets
import signal
import stat
import sys
from xml.parsers import expat

LAUNCH_AGENT_NAME = re.compile(r'com\.whatsoup\.[A-Za-z0-9][A-Za-z0-9._-]*\.plist')
SYSTEM_LAUNCH_AGENTS = Path('/Library/LaunchAgents')
# The owner a replaced plist must have. Tests, which cannot create root-owned files, set their own uid.
PLIST_OWNER_UID = 0
# The widest mode a plist may have: the run's own copy takes this mode, so no exec, setuid or group/other write.
PLIST_MAX_MODE = 0o644
_DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
# O_NONBLOCK: opening a FIFO planted under the plist name must not block the helper.
_PLIST = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
RECOVERY_INCOMPLETE_EXIT = 3
# Signals shield() holds off while main() runs. sudo relays what it receives, so the caller can
# send the helper any signal, and a hangup, Ctrl-C or Ctrl-Z sends one too; a default action that
# ends or stops the run between clearing uchg and setting it again leaves the plist unprotected
# with no exit 3. Left deliverable: SIGKILL and SIGSTOP, which cannot be blocked, caught or
# ignored, and the fault signals and SIGABRT, which report the helper's own crash.
_DELIVERABLE_SIGNALS = frozenset((signal.SIGKILL, signal.SIGSTOP, signal.SIGSEGV, signal.SIGBUS, signal.SIGFPE,
                                  signal.SIGILL, signal.SIGTRAP, signal.SIGABRT, signal.SIGSYS))
SHIELDED_SIGNALS = frozenset(signal.valid_signals()) - _DELIVERABLE_SIGNALS
# A mask holds only in the thread that sets it. os.getgrouplist starts a thread that leaves SIGPROF
# and SIGEMT deliverable (Opus N-1), and a delivered default action ends the whole process, so the
# shielded signals whose default action terminates, cores or stops are also ignored, process-wide.
# The rest default to discard (signal(3)) and keep their disposition; SIGCHLD above all, since
# ignoring it changes waitpid. The helper starts and waits on no child process.
IGNORED_SIGNALS = frozenset((signal.SIGHUP, signal.SIGINT, signal.SIGQUIT, signal.SIGEMT, signal.SIGPIPE,
                             signal.SIGALRM, signal.SIGTERM, signal.SIGTSTP, signal.SIGTTIN, signal.SIGTTOU,
                             signal.SIGXCPU, signal.SIGXFSZ, signal.SIGVTALRM, signal.SIGPROF, signal.SIGUSR1,
                             signal.SIGUSR2))
# CPU seconds the run keeps beyond what it has used: resource limits carry over from the
# caller, and the kernel kills a process at its hard CPU limit. A normal run needs well under one.
CPU_SECONDS = 60
# <sys/acl.h>
ACL_TYPE_EXTENDED = 0x00000100

# The interpreter's os module has no dir_fd form of rename or unlink, and no fchflags,
# flistxattr or ACL reader on macOS, so these come from libc directly.
_libc = ctypes.CDLL(None, use_errno=True)
_libc.fchflags.argtypes = [ctypes.c_int, ctypes.c_uint]
_libc.flistxattr.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_size_t, ctypes.c_int]
_libc.flistxattr.restype = ctypes.c_ssize_t
_libc.acl_get_fd_np.argtypes = [ctypes.c_int, ctypes.c_int]
_libc.acl_get_fd_np.restype = ctypes.c_void_p
_libc.acl_free.argtypes = [ctypes.c_void_p]
_libc.renameat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p]
_libc.unlinkat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]


class RecoveryIncomplete(RuntimeError):
    """A failed replacement could not put back the original bytes and protection."""


def _checked(result):
    if result < 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return result


def digest(data):
    return hashlib.sha256(data).hexdigest()


def set_flags(fd, flags):
    _checked(_libc.fchflags(fd, flags))


def rename_in(folder_fd, source, target):
    """Rename one entry over another inside the opened folder; a symlink target is replaced, never followed."""
    _checked(_libc.renameat(folder_fd, os.fsencode(source), folder_fd, os.fsencode(target)))


def remove_in(folder_fd, name):
    _checked(_libc.unlinkat(folder_fd, os.fsencode(name), 0))


def open_folder(path):
    """Open an absolute folder one component at a time from "/" without following any symlink."""
    path = Path(path)
    if not path.is_absolute() or any(part in ('.', '..') for part in path.parts[1:]):
        raise RuntimeError('folder must be a plain absolute path')
    fd = os.open('/', _DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, _DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = child
    except OSError as exc:
        os.close(fd)
        raise RuntimeError('folder must exist with no symlink in its path') from exc
    except BaseException:
        os.close(fd)
        raise
    return fd


def _identity(fd):
    info = os.fstat(fd)
    return info.st_dev, info.st_ino


def has_acl(fd):
    """Does the opened file carry an extended ACL? The xattr list does not show one, so libc is asked.

    NULL with ENOENT means none; any other failure refuses.
    """
    ctypes.set_errno(0)
    acl = _libc.acl_get_fd_np(fd, ACL_TYPE_EXTENDED)
    if acl:
        _libc.acl_free(acl)
        return True
    if ctypes.get_errno() != errno.ENOENT:
        raise RuntimeError('plist ACL could not be read')
    return False


def refuse_acl(fd):
    # Darwin applies an ACL before the mode bits, and the readability check reads mode bits only.
    if has_acl(fd):
        raise RuntimeError('plist must carry no ACL')


def fd_metadata(fd):
    info = os.fstat(fd)
    # One link only: a second name could make root act on a file outside the folder.
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise RuntimeError('plist must be a regular file with a single link')
    if _checked(_libc.flistxattr(fd, None, 0, 0)):
        raise RuntimeError('extended attributes require an explicit preservation path')
    refuse_acl(fd)
    return {'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode),
            'flags': info.st_flags}


def _readable_by(metadata, reader):
    """Darwin's read check by mode bits: exactly one class applies, with no fall-through to a wider one."""
    uid, groups = reader
    mode = metadata['mode']
    if metadata['uid'] == uid:
        return bool(mode & 0o400)
    if metadata['gid'] in groups:
        return bool(mode & 0o040)
    return bool(mode & 0o004)


def target_metadata(fd, owner_uid, reader):
    """Everything the replacement requires of the target, checked on the opened inode before any byte is read.

    Root-owned, single-link and flagged immutable (or not flagged at all): see
    the module docstring for why this pins the inode to the folder's name.
    Readable by the caller, so root reads nothing the caller could not; with no
    ACL (fd_metadata refuses one), the mode bits alone decide that.
    """
    metadata = fd_metadata(fd)
    if metadata['uid'] != owner_uid:
        raise RuntimeError('plist must be owned by root')
    if metadata['flags'] not in (0, stat.UF_IMMUTABLE) or metadata['mode'] & ~PLIST_MAX_MODE:
        raise RuntimeError('unsupported plist protection')
    if not _readable_by(metadata, reader):
        raise RuntimeError('plist must be readable by the sudo caller')
    return metadata


def open_plist(folder_fd, name):
    """Open an existing regular plist by name inside the opened folder, refusing a symlink."""
    try:
        fd = os.open(name, _PLIST, dir_fd=folder_fd)
    except OSError as exc:
        raise RuntimeError('target must be an existing regular plist with no symlink') from exc
    try:
        fd_metadata(fd)
    except BaseException:
        os.close(fd)
        raise
    return fd


def metadata(path):
    path = Path(path)
    folder_fd = open_folder(path.parent)
    try:
        fd = open_plist(folder_fd, path.name)
        try:
            return fd_metadata(fd)
        finally:
            os.close(fd)
    finally:
        os.close(folder_fd)


def read_all(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    chunks = []
    while True:
        chunk = os.read(fd, 1 << 16)
        if not chunk:
            return b''.join(chunks)
        chunks.append(chunk)


def _write_all(fd, data):
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]


def create_temporary(folder_fd, name, data, before):
    temporary = '.' + name + '.activate-' + secrets.token_hex(8)
    fd = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=folder_fd)
    try:
        # An inheritable entry on the caller's folder would put the caller's ACL on root's new plist;
        # refused here, before any change, rather than after the rename.
        refuse_acl(fd)
        _write_all(fd, data)
        os.fsync(fd)
        os.fchown(fd, before['uid'], before['gid'])
        os.fchmod(fd, before['mode'])
    except BaseException:
        os.close(fd)
        remove_in(folder_fd, temporary)
        raise
    return temporary, fd


def assert_current(folder_fd, name, fd, data, expected):
    """The name in the folder must still be this descriptor's file, with these bytes and this metadata."""
    current = open_plist(folder_fd, name)
    try:
        if _identity(current) != _identity(fd):
            raise RuntimeError('plist changed during replacement')
    finally:
        os.close(current)
    if read_all(fd) != data or fd_metadata(fd) != expected:
        raise RuntimeError('plist changed during replacement')


def assert_same_folder(folder_fd, reopen_folder):
    """The opened folder must still be the folder found at its path."""
    current = reopen_folder()
    try:
        if _identity(current) != _identity(folder_fd):
            raise RuntimeError('folder changed during replacement')
    finally:
        os.close(current)


def _restore(folder_fd, name, replaced_fd, original, replacement, before):
    """Put the original bytes and protection back; True only when that is confirmed.

    False when the name no longer holds this run's file, which the caller may
    have replaced: nothing is changed then. The restore copy is written before
    any protection is cleared, and a protection this function cleared is put
    back if its rename does not happen.
    """
    try:
        current = open_plist(folder_fd, name)
    except RuntimeError:
        return False
    try:
        ours = _identity(current) == _identity(replaced_fd)
    finally:
        os.close(current)
    if not ours or read_all(replaced_fd) != replacement:
        return False
    observed = fd_metadata(replaced_fd)
    if observed not in (before, dict(before, flags=0)):
        return False
    restore_name, restore_fd = create_temporary(folder_fd, name, original, before)
    cleared = renamed = protected = False
    try:
        if observed['flags']:
            cleared = True  # before the call: an interruption right after it must still re-protect
            set_flags(replaced_fd, 0)
        rename_in(folder_fd, restore_name, name)
        renamed = True
        if before['flags']:
            set_flags(restore_fd, before['flags'])
        protected = True
        assert_current(folder_fd, name, restore_fd, original, before)
        return True
    finally:
        # Best effort on the way out of any failure or interruption; the caller reports it as incomplete.
        if not renamed:
            try:
                remove_in(folder_fd, restore_name)
            except BaseException:
                pass
            if cleared:
                try:
                    set_flags(replaced_fd, observed['flags'])
                except BaseException:
                    pass
        elif not protected and before['flags']:
            try:
                set_flags(restore_fd, before['flags'])  # this run's own file, now at the name
            except BaseException:
                pass
        os.close(restore_fd)


def _current_reader():
    return os.getuid(), frozenset(os.getgroups())


def replace_at(folder_fd, name, expected_sha, replacement, expected_metadata, reopen_folder, *,
               owner_uid=PLIST_OWNER_UID, reader=None):
    """Replace folder/name using only descriptors: the opened folder, the plist and this run's own files.

    Raises RecoveryIncomplete when a failure after the first change could not
    be undone and confirmed; any other exception means the plist is as found.
    """
    target = open_plist(folder_fd, name)
    temporary = temp_fd = None
    replaced = False
    try:
        before = target_metadata(target, owner_uid, reader or _current_reader())
        original = read_all(target)
        if digest(original) != expected_sha or any(before[k] != v for k, v in expected_metadata.items()):
            raise RuntimeError('plist changed since observation')
        temporary, temp_fd = create_temporary(folder_fd, name, replacement, before)
        assert_current(folder_fd, name, target, original, before)
        assert_same_folder(folder_fd, reopen_folder)
        # From the flag clear on, any exception (shield() holds off every signal but KILL, STOP, ABRT and the
        # fault signals, but MemoryError or an injected KeyboardInterrupt still arrives) re-protects first and
        # is reported.
        cleared = False
        try:
            if before['flags']:
                cleared = True  # before the call: an interruption right after it must still re-protect
                set_flags(target, 0)
            assert_current(folder_fd, name, target, original, dict(before, flags=0))
            rename_in(folder_fd, temporary, name)
            replaced = True
        except BaseException:
            if cleared:
                try:
                    set_flags(target, before['flags'])
                except BaseException as exc:
                    raise RecoveryIncomplete('original plist protection could not be restored') from exc
            raise  # protection is back: an Exception means "as found"; run() maps an interruption to exit 3
        try:
            if before['flags']:
                set_flags(temp_fd, before['flags'])
            assert_current(folder_fd, name, temp_fd, replacement, before)
            assert_same_folder(folder_fd, reopen_folder)
        except BaseException as failure:
            try:
                restored = _restore(folder_fd, name, temp_fd, original, replacement, before)
            except BaseException as exc:
                raise RecoveryIncomplete('original plist could not be restored') from exc
            if not restored:
                raise RecoveryIncomplete('plist is not this run\'s file; it was left as found') from failure
            raise
    finally:
        if temp_fd is not None:
            if not replaced:
                try:
                    remove_in(folder_fd, temporary)
                except OSError:
                    pass  # keep the run's own error; a leftover temporary stays in the caller's folder
            os.close(temp_fd)
        os.close(target)
    return {'sha256': digest(replacement), 'metadata': before}


def replace(path, expected_sha, replacement, expected_metadata, *, owner_uid=PLIST_OWNER_UID, reader=None):
    """Replace a plist named by an absolute path whose folders contain no symlink."""
    path = Path(path)
    folder_fd = open_folder(path.parent)
    try:
        return replace_at(folder_fd, path.name, expected_sha, replacement, expected_metadata,
                          lambda: open_folder(path.parent), owner_uid=owner_uid, reader=reader)
    finally:
        os.close(folder_fd)


def caller_uid():
    raw_uid = os.environ.get('SUDO_UID', '')
    if not re.fullmatch(r'[0-9]+', raw_uid) or int(raw_uid) == 0:
        raise RuntimeError('root replacement requires a non-root sudo caller')
    return int(raw_uid)


def caller_launch_agents(user):
    """The sudo caller's home and its ~/Library/LaunchAgents path, from its user database entry."""
    home = Path(user.pw_dir)
    folder = home / 'Library' / 'LaunchAgents'
    # A home of "/" would name the system folder, which this helper never writes.
    if not home.is_absolute() or home == Path('/') or folder == SYSTEM_LAUNCH_AGENTS:
        raise RuntimeError('sudo caller has no user LaunchAgents folder')
    return home, folder


def caller_reader(uid, user):
    """The sudo caller's uid and groups, for the check that root reads only what the caller could."""
    return uid, frozenset(os.getgrouplist(user.pw_name, user.pw_gid))


def open_caller_folder(home, uid):
    """Open ~/Library/LaunchAgents; the home, Library and LaunchAgents must be folders the caller owns."""
    fd = open_folder(home)
    try:
        for part in (None, 'Library', 'LaunchAgents'):
            if part is not None:
                child = os.open(part, _DIRECTORY, dir_fd=fd)
                os.close(fd)
                fd = child
            info = os.fstat(fd)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid:
                raise RuntimeError("LaunchAgents path must be folders the sudo caller owns")
    except OSError as exc:
        os.close(fd)
        raise RuntimeError('LaunchAgents folder must exist with no symlink in its path') from exc
    except BaseException:
        os.close(fd)
        raise
    return fd


def lock_helper(path):
    """Hold an exclusive lock on this helper's own root-owned file for the whole run, or refuse.

    A caller holding the lock itself can only make the helper refuse.
    """
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        os.close(fd)
        raise RuntimeError('another root plist replacement is running') from exc
    return fd


_CONTAINERS = ('plist', 'dict', 'array')
_TEXT_VALUES = ('key', 'string', 'integer', 'real')
_EMPTY_VALUES = ('true', 'false')
# The only document type the helper accepts: the one plistlib and the renderers write, with no internal subset.
_APPLE_DOCTYPE = ('plist', 'http://www.apple.com/DTDs/PropertyList-1.0.dtd', '-//Apple//DTD PLIST 1.0//EN', 0)
# plistlib parses numbers with int() and float(), which accept underscores, non-ASCII digits and any
# magnitude. These are ASCII-only subsets of what native plutil accepts (measured), checked first.
_INTEGER = re.compile(r'[+-]?[0-9]+')
_REAL = re.compile(r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?')
# plutil's <integer> range: signed 64-bit below zero, unsigned 64-bit above.
_INTEGER_MIN, _INTEGER_MAX = -(1 << 63), (1 << 64) - 1
_NUMBERS = ('integer', 'real')


def _refuse_structure(*_):
    raise RuntimeError('plist contents must be a strict XML property list')


def _check_number(element, text):
    if element == 'integer':
        # 2**64 - 1 has 20 digits; the length bound keeps int() off a huge string.
        if (not _INTEGER.fullmatch(text) or len(text.lstrip('+-').lstrip('0')) > 20
                or not _INTEGER_MIN <= int(text) <= _INTEGER_MAX):
            _refuse_structure()
    elif not _REAL.fullmatch(text):
        _refuse_structure()


def check_xml_structure(data):
    """Refuse XML that native plutil refuses but plistlib accepts, and anything else outside a plain plist.

    One <plist> root holding one value; only plist elements; keys and values
    alternate in a dictionary; no text between elements; no processing
    instruction (the XML declaration is not one); no document type but Apple's,
    and no internal subset or entity declaration; integers and reals in strict
    ASCII form, integers within plutil's 64-bit range.
    """
    parser = expat.ParserCreate()
    stack = []  # [element, children so far, text pieces]
    roots = []

    def start(name, attributes):
        if not stack:
            if name != 'plist' or roots or set(attributes) - {'version'}:
                _refuse_structure()
            roots.append(name)
        else:
            parent = stack[-1]
            if parent[0] not in _CONTAINERS or attributes:
                _refuse_structure()
            if name not in _TEXT_VALUES + _EMPTY_VALUES + ('dict', 'array'):
                _refuse_structure()
            if parent[0] == 'plist' and parent[1]:
                _refuse_structure()
            if parent[0] == 'dict':
                if (name == 'key') != (parent[1] % 2 == 0):
                    _refuse_structure()
            elif name == 'key':
                _refuse_structure()
            parent[1] += 1
        stack.append([name, 0, []])

    def end(name):
        element, children, pieces = stack.pop()
        if (element == 'dict' and children % 2) or (element == 'plist' and children != 1):
            _refuse_structure()
        if element in _NUMBERS:
            _check_number(element, ''.join(pieces))  # expat may split one text node

    def text(content):
        if stack and stack[-1][0] not in _TEXT_VALUES and content.strip(' \t\r\n'):
            _refuse_structure()
        if stack and stack[-1][0] in _EMPTY_VALUES and content:
            _refuse_structure()
        if stack and stack[-1][0] in _NUMBERS:
            stack[-1][2].append(content)

    def doctype(name, system_id, public_id, has_internal_subset):
        if (name, system_id, public_id, has_internal_subset) != _APPLE_DOCTYPE:
            _refuse_structure()

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = text
    parser.StartDoctypeDeclHandler = doctype
    parser.ProcessingInstructionHandler = _refuse_structure
    parser.EntityDeclHandler = _refuse_structure
    parser.UnparsedEntityDeclHandler = _refuse_structure
    parser.NotationDeclHandler = _refuse_structure
    parser.ElementDeclHandler = _refuse_structure
    parser.AttlistDeclHandler = _refuse_structure
    try:
        parser.Parse(data, True)
    except expat.ExpatError as exc:
        raise RuntimeError('plist contents must be an XML property list') from exc
    if len(roots) != 1:
        _refuse_structure()


def check_contents(replacement, label):
    """Refuse contents that are not a strict XML plist dictionary of JSON-representable values naming `label`.

    These are the checks the earlier `plutil -convert json` round trip gave, kept
    without running a program. Only validation uses the parsed value; the caller
    writes and digests the request bytes unchanged.
    """
    check_xml_structure(replacement)
    try:
        parsed = plistlib.loads(replacement, fmt=plistlib.FMT_XML)
    except Exception as exc:  # any parse failure is a refusal; the reason stays out of the output
        raise RuntimeError('plist contents must be an XML property list') from exc
    if not isinstance(parsed, dict):
        raise RuntimeError('plist contents must be a dictionary')
    pending = [parsed]
    while pending:  # a loop, not recursion: nesting depth is the caller's choice
        value = pending.pop()
        if isinstance(value, dict):
            if not all(isinstance(key, str) for key in value):
                raise RuntimeError('plist dictionary keys must be strings')
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
        elif isinstance(value, float):
            if not math.isfinite(value):
                raise RuntimeError('plist reals must be finite')
        elif not isinstance(value, (str, int)):  # bool is an int; data and date have no JSON form
            raise RuntimeError('plist value has no JSON form')
    if parsed.get('Label') != label:
        raise RuntimeError('plist label does not match target')


def read_request(stream):
    """The JSON request, decoded from bytes as strict UTF-8: sudo keeps LANG and LC_ALL, so a text read would follow the caller's locale."""
    return json.loads(stream.buffer.read().decode('utf-8'))


def main():
    request = read_request(sys.stdin)
    if os.getuid() != 0:
        raise RuntimeError('root replacement must run as root')
    lock_fd = lock_helper(__file__)
    try:
        uid = caller_uid()
        user = pwd.getpwuid(uid)
        home, folder = caller_launch_agents(user)
        path = Path(request['path'])
        if path.parent != folder or not LAUNCH_AGENT_NAME.fullmatch(path.name):
            raise RuntimeError("root replacement is limited to the sudo caller's WhatSoup LaunchAgents")
        folder_fd = open_caller_folder(home, uid)
        try:
            os.close(open_plist(folder_fd, path.name))
            replacement = request['contents'].encode('utf-8')
            check_contents(replacement, path.name[:-6])
            result = replace_at(folder_fd, path.name, request['expectedSha256'], replacement, request['metadata'],
                                lambda: open_caller_folder(home, uid),
                                owner_uid=PLIST_OWNER_UID, reader=caller_reader(uid, user))
        finally:
            os.close(folder_fd)
    finally:
        os.close(lock_fd)
    print(json.dumps(result))


def ensure_cpu_time(seconds=CPU_SECONDS):
    """Raise, never lower, the CPU limits to `seconds` beyond the time used so far; root may raise a hard limit."""
    usage = resource.getrusage(resource.RUSAGE_SELF)
    floor = math.ceil(usage.ru_utime + usage.ru_stime) + seconds
    soft, hard = resource.getrlimit(resource.RLIMIT_CPU)

    def raised(limit):
        return limit if limit == resource.RLIM_INFINITY or limit >= floor else floor

    if (raised(soft), raised(hard)) != (soft, hard):
        resource.setrlimit(resource.RLIMIT_CPU, (raised(soft), raised(hard)))


@contextlib.contextmanager
def shield():
    """While the block runs, no relayed signal ends or stops it, and the CPU limit leaves it time to finish.

    Blocks SHIELDED_SIGNALS in this thread, then sets IGNORED_SIGNALS to
    SIG_IGN for the whole process, which discards them on arrival in any
    thread. On the way out it restores the mask, then the dispositions. A
    signal can then end the process again, but only once main() has finished
    the change or its recovery. SIGKILL, SIGSTOP, SIGABRT and the fault signals
    arrive throughout. Activation therefore treats any result but exit 0 with
    the new bytes in place or exit 2 as unconfirmed, a signal death included.
    """
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, SHIELDED_SIGNALS)
    previous = {}
    try:
        for number in sorted(IGNORED_SIGNALS):
            previous[number] = signal.signal(number, signal.SIG_IGN)
        ensure_cpu_time()
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        for number, handler in previous.items():
            if handler is not None:  # None: set outside Python, which cannot put it back; it stays ignored
                signal.signal(number, handler)


def run():
    """Exit status: 0 replaced, 3 recovery incomplete (the plist may lack protection), 2 refused or failed as found."""
    try:
        with shield():
            main()
    except RecoveryIncomplete as exc:
        print(json.dumps({'error_type': type(exc).__name__}), file=sys.stderr)
        return RECOVERY_INCOMPLETE_EXIT
    except Exception as exc:
        print(json.dumps({'error_type': type(exc).__name__}), file=sys.stderr)
        return 2
    except BaseException as exc:  # an interruption: whatever re-protection could do is done, but unconfirmed
        print(json.dumps({'error_type': type(exc).__name__}), file=sys.stderr)
        return RECOVERY_INCOMPLETE_EXIT
    return 0


if __name__ == '__main__':
    sys.exit(run())
