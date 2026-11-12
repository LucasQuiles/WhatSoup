"""Replace one protected launchd plist without changing its owner or protection.

The helper runs as root, and the sudo caller owns the folders on the path to its
plist. Every filesystem step therefore works through file descriptors bound to
the inodes that were checked: folders are opened one component at a time from
"/" without following a symlink, names are resolved relative to the opened
folder (openat, renameat, unlinkat), and owner, mode and flag changes go to
descriptors this helper opened. If the caller swaps a folder or the plist after
the checks, a root write, flag change or ownership change cannot land on
another file, and the run fails.

The helper also runs no other program: sudo can keep the caller's PATH, so a
program named without a path would be one the caller chose, run as root.
"""
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import plistlib
import pwd
import re
import secrets
import stat
import sys

LAUNCH_AGENT_NAME = re.compile(r'com\.whatsoup\.[A-Za-z0-9][A-Za-z0-9._-]*\.plist')
SYSTEM_LAUNCH_AGENTS = Path('/Library/LaunchAgents')
_DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
# O_NONBLOCK: opening a FIFO planted under the plist name must not block the helper.
_PLIST = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK

# The interpreter's os module has no dir_fd form of rename or unlink and no
# fchflags or flistxattr on macOS, so these come from libc directly.
_libc = ctypes.CDLL(None, use_errno=True)
_libc.fchflags.argtypes = [ctypes.c_int, ctypes.c_uint]
_libc.flistxattr.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_size_t, ctypes.c_int]
_libc.flistxattr.restype = ctypes.c_ssize_t
_libc.renameat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p]
_libc.unlinkat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]


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


def fd_metadata(fd):
    info = os.fstat(fd)
    # One link only: a second name could make root act on a file outside the folder.
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise RuntimeError('plist must be a regular file with a single link')
    if _checked(_libc.flistxattr(fd, None, 0, 0)):
        raise RuntimeError('extended attributes require an explicit preservation path')
    return {'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode),
            'flags': info.st_flags}


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
    """Put the original bytes and protection back when this run's file is the one in place."""
    try:
        current = open_plist(folder_fd, name)
    except RuntimeError:
        return
    try:
        ours = _identity(current) == _identity(replaced_fd)
    finally:
        os.close(current)
    if not ours or read_all(replaced_fd) != replacement:
        return
    observed = fd_metadata(replaced_fd)
    if observed not in (before, dict(before, flags=0)):
        return
    if observed['flags']:
        set_flags(replaced_fd, 0)
    restore_name, restore_fd = create_temporary(folder_fd, name, original, before)
    try:
        rename_in(folder_fd, restore_name, name)
        if before['flags']:
            set_flags(restore_fd, before['flags'])
        try:
            assert_current(folder_fd, name, restore_fd, original, before)
        except RuntimeError as exc:
            raise RuntimeError('original plist protection could not be restored') from exc
    finally:
        os.close(restore_fd)


def replace_at(folder_fd, name, expected_sha, replacement, expected_metadata, reopen_folder):
    """Replace folder/name using only descriptors: the opened folder, the plist and this run's own file."""
    target = open_plist(folder_fd, name)
    temporary = temp_fd = None
    replaced = False
    try:
        original = read_all(target)
        before = fd_metadata(target)
        if digest(original) != expected_sha or any(before[k] != v for k, v in expected_metadata.items()):
            raise RuntimeError('plist changed since observation')
        if before['flags'] not in (0, stat.UF_IMMUTABLE) or before['mode'] & 0o022:
            raise RuntimeError('unsupported plist protection')
        temporary, temp_fd = create_temporary(folder_fd, name, replacement, before)
        try:
            assert_current(folder_fd, name, target, original, before)
            assert_same_folder(folder_fd, reopen_folder)
            try:
                if before['flags']:
                    set_flags(target, 0)
                assert_current(folder_fd, name, target, original, dict(before, flags=0))
                rename_in(folder_fd, temporary, name)
                replaced = True
            finally:
                if before['flags']:
                    set_flags(temp_fd if replaced else target, before['flags'])
            assert_current(folder_fd, name, temp_fd, replacement, before)
            assert_same_folder(folder_fd, reopen_folder)
        except BaseException:
            if replaced:
                _restore(folder_fd, name, temp_fd, original, replacement, before)
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


def replace(path, expected_sha, replacement, expected_metadata):
    """Replace a plist named by an absolute path whose folders contain no symlink."""
    path = Path(path)
    folder_fd = open_folder(path.parent)
    try:
        return replace_at(folder_fd, path.name, expected_sha, replacement, expected_metadata,
                          lambda: open_folder(path.parent))
    finally:
        os.close(folder_fd)


def caller_uid():
    raw_uid = os.environ.get('SUDO_UID', '')
    if not re.fullmatch(r'[0-9]+', raw_uid) or int(raw_uid) == 0:
        raise RuntimeError('root replacement requires a non-root sudo caller')
    return int(raw_uid)


def caller_launch_agents(uid):
    """The sudo caller's home and its ~/Library/LaunchAgents path, from the user database."""
    home = Path(pwd.getpwuid(uid).pw_dir)
    folder = home / 'Library' / 'LaunchAgents'
    # A home of "/" would name the system folder, which this helper never writes.
    if not home.is_absolute() or home == Path('/') or folder == SYSTEM_LAUNCH_AGENTS:
        raise RuntimeError('sudo caller has no user LaunchAgents folder')
    return home, folder


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


def check_contents(replacement, label):
    """Refuse contents that are not an XML plist dictionary of JSON-representable values naming `label`.

    These are the checks the earlier `plutil -convert json` round trip gave, kept
    without running a program. Only validation uses the parsed value; the caller
    writes and digests the request bytes unchanged.
    """
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


def main():
    request = json.load(sys.stdin)
    if os.getuid() != 0:
        raise RuntimeError('root replacement must run as root')
    uid = caller_uid()
    home, folder = caller_launch_agents(uid)
    path = Path(request['path'])
    if path.parent != folder or not LAUNCH_AGENT_NAME.fullmatch(path.name):
        raise RuntimeError("root replacement is limited to the sudo caller's WhatSoup LaunchAgents")
    folder_fd = open_caller_folder(home, uid)
    try:
        os.close(open_plist(folder_fd, path.name))
        replacement = request['contents'].encode()
        check_contents(replacement, path.name[:-6])
        result = replace_at(folder_fd, path.name, request['expectedSha256'], replacement, request['metadata'],
                            lambda: open_caller_folder(home, uid))
    finally:
        os.close(folder_fd)
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error_type': type(exc).__name__}), file=sys.stderr)
        sys.exit(2)
