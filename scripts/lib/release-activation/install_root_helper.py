"""Install the root plist helper at its fixed root-owned path. The owner runs this once per host, as root.

    sudo /usr/bin/python3 -I -B <clone>/scripts/lib/release-activation/install_root_helper.py --user <bot-user>

Run it from a clone the bot user cannot write, checked out at the reviewed
commit: run from the bot's own release tree, the bot user could change this
script and the pin before root runs them.

The helper bytes are read once, compared with the digest in root-helper.json,
and those same bytes are written. The install folder and every ancestor must
be root-owned and not writable by group or other, and every folder on the
path of the interpreter that sudo will run must be unwritable by the bot user:
`/usr/bin/python3` resolves through the selected developer folder, and a bot
user who can replace that folder's `python3` would run code as root.
Re-running with an up-to-date install changes nothing.

Exit status: 0 installed or already current, 2 refused (nothing changed).
"""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import stat
import sys

HERE = Path(os.path.abspath(__file__)).parent
PIN = HERE / 'root-helper.json'
HELPER = HERE / 'protected_plist.py'
INSTALL_PATH = re.compile(r'/Library/PrivilegedHelperTools/[A-Za-z0-9][A-Za-z0-9._-]*')
SHA256 = re.compile(r'[0-9a-f]{64}')
SELECT_LINK = '/var/db/xcode_select_link'
ROOT = (0, 0)
FOLDER_MODE = 0o755
INSTALLED_MODE = 0o444
_DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

# No dir_fd form of mkdir, rename or unlink in every interpreter this runs under, so these come from libc.
_libc = ctypes.CDLL(None, use_errno=True)
_libc.mkdirat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint16]
_libc.renameat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p]
_libc.unlinkat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]


class InstallRefused(RuntimeError):
    """The install did not happen; nothing was changed."""


def _checked(result):
    if result < 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return result


def read_bytes(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        chunks = []
        while True:
            chunk = os.read(fd, 1 << 16)
            if not chunk:
                return b''.join(chunks)
            chunks.append(chunk)
    finally:
        os.close(fd)


def read_pin(path=PIN):
    """root-helper.json: the one record of where the helper is installed and which bytes it must have."""
    try:
        pin = json.loads(read_bytes(path))
    except (OSError, ValueError) as exc:
        raise InstallRefused('root-helper.json is unreadable') from exc
    if (not isinstance(pin, dict) or set(pin) != {'path', 'sha256'} or not isinstance(pin['path'], str)
            or not isinstance(pin['sha256'], str) or not INSTALL_PATH.fullmatch(pin['path'])
            or not SHA256.fullmatch(pin['sha256'])):
        raise InstallRefused('root-helper.json must hold a PrivilegedHelperTools path and a sha256')
    return pin


def parse_user(argv):
    if len(argv) != 2 or argv[0] != '--user' or not argv[1]:
        raise InstallRefused('usage: install_root_helper.py --user <bot-user>')
    return argv[1]


def bot_identity(name):
    """The bot user's uid and groups, from the user database."""
    try:
        user = pwd.getpwnam(name)
    except KeyError as exc:
        raise InstallRefused('--user names no account on this host') from exc
    if user.pw_uid == 0:
        raise InstallRefused('--user must be the bot account, not root')
    return user.pw_uid, frozenset(os.getgrouplist(user.pw_name, user.pw_gid))


def _writable_by(info, uid, groups):
    """Could this user change the entry? An owner can always chmod, so ownership alone counts."""
    mode = stat.S_IMODE(info.st_mode)
    return info.st_uid == uid or bool(mode & 0o020 and info.st_gid in groups) or bool(mode & 0o002)


def check_invocation(isolated, no_bytecode, executable, select_link=SELECT_LINK):
    """The chain check below inspects whichever interpreter runs this script; it must be the one sudo will run.

    That is `/usr/bin/python3 -I -B`, which resolves to a python3 inside the
    selected developer folder (or the Command Line Tools).
    """
    if not (isolated and no_bytecode):
        raise InstallRefused('run the install step as /usr/bin/python3 -I -B')
    roots = [Path('/Library/Developer/CommandLineTools')]
    if os.path.lexists(select_link):
        roots.append(Path(os.path.realpath(select_link)))
    real = Path(os.path.realpath(executable))
    if not any(root in real.parents for root in roots):
        raise InstallRefused('run the install step as /usr/bin/python3, the interpreter the sudoers rule names')


def interpreter_paths():
    """The real paths root trusts when sudo runs `/usr/bin/python3 -I -B`: this same interpreter's."""
    paths = [os.path.realpath(sys.executable)]
    paths += [os.path.realpath(entry) for entry in sys.path if entry and os.path.exists(entry)]
    if os.path.lexists(SELECT_LINK):
        paths += [os.path.realpath(os.path.dirname(SELECT_LINK)), os.path.realpath(SELECT_LINK)]
    return paths


def check_interpreter(paths, uid, groups, *, anchor='/'):
    """Refuse when the bot user could change any folder or file on these real paths (from `anchor` down)."""
    anchor = Path(anchor)
    for raw in paths:
        path = Path(raw)
        for component in [path, *path.parents]:
            if component != anchor and anchor not in component.parents:
                continue
            if _writable_by(os.lstat(component), uid, groups):
                raise InstallRefused('the bot user can write ' + str(component)
                                     + ', which the root interpreter trusts; select a root-owned developer folder')


def _trusted_folder(fd, owner):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner[0] or stat.S_IMODE(info.st_mode) & 0o022:
        raise InstallRefused('install folders must be root-owned and not writable by group or other')


def open_install_folder(anchor, parts, owner):
    """Open anchor/parts one component at a time without following a symlink; create only the last one."""
    fd = os.open(anchor, _DIRECTORY)
    try:
        _trusted_folder(fd, owner)
        for index, part in enumerate(parts):
            try:
                child = os.open(part, _DIRECTORY, dir_fd=fd)
            except FileNotFoundError:
                if index != len(parts) - 1:
                    raise InstallRefused('install folder ancestor is missing') from None
                _checked(_libc.mkdirat(fd, os.fsencode(part), FOLDER_MODE))
                child = os.open(part, _DIRECTORY, dir_fd=fd)
                os.fchown(child, *owner)
                os.fchmod(child, FOLDER_MODE)
            except OSError as exc:
                raise InstallRefused('install folder path must contain no symlink') from exc
            os.close(fd)
            fd = child
            _trusted_folder(fd, owner)
    except BaseException:
        os.close(fd)
        raise
    return fd


def _current(folder_fd, name, data, owner):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder_fd)
    except OSError:
        return False
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or (info.st_uid, info.st_gid) != tuple(owner)
                or stat.S_IMODE(info.st_mode) != INSTALLED_MODE or info.st_nlink != 1):
            return False
        chunks = []
        while True:
            chunk = os.read(fd, 1 << 16)
            if not chunk:
                return b''.join(chunks) == data
            chunks.append(chunk)
    finally:
        os.close(fd)


def install(data, pin, *, anchor='/', owner=ROOT):
    """Install `data` at the pinned path below `anchor`, owned by `owner`, mode 0444; idempotent."""
    if hashlib.sha256(data).hexdigest() != pin['sha256']:
        raise InstallRefused('helper bytes do not match root-helper.json; run from a clone at the reviewed commit')
    *parts, name = Path(pin['path']).relative_to('/').parts
    folder_fd = open_install_folder(anchor, parts, owner)
    try:
        if _current(folder_fd, name, data, owner):
            return {'changed': False}
        temporary = '.' + name + '.install-' + secrets.token_hex(8)
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=folder_fd)
        except FileExistsError as exc:
            raise InstallRefused('a temporary install file already exists; inspect the install folder') from exc
        try:
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
            os.fchown(fd, *owner)
            os.fchmod(fd, INSTALLED_MODE)
            os.close(fd)
            fd = None
            _checked(_libc.renameat(folder_fd, os.fsencode(temporary), folder_fd, os.fsencode(name)))
        except BaseException:
            if fd is not None:
                os.close(fd)
            _libc.unlinkat(folder_fd, os.fsencode(temporary), 0)
            raise
        os.fsync(folder_fd)
        if not _current(folder_fd, name, data, owner):
            raise InstallRefused('installed helper did not verify after the rename')
        return {'changed': True}
    finally:
        os.close(folder_fd)


def main(argv):
    name = parse_user(argv)
    if os.geteuid() != 0:
        raise InstallRefused('run the install step as root (sudo)')
    check_invocation(sys.flags.isolated, sys.dont_write_bytecode, sys.executable)
    uid, groups = bot_identity(name)
    pin = read_pin()
    data = read_bytes(HELPER)
    check_interpreter(interpreter_paths(), uid, groups)
    result = install(data, pin)
    result.update(path=pin['path'], sha256=pin['sha256'],
                  sudoers=name + ' ALL = (root) NOPASSWD: /usr/bin/python3 -I -B ' + pin['path'])
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (InstallRefused, OSError) as exc:
        print(json.dumps({'refused': str(exc)}), file=sys.stderr)
        sys.exit(2)
