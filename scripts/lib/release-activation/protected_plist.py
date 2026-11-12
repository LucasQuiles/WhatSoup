"""Replace one protected launchd plist without changing its owner or protection."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import tempfile

LAUNCH_AGENT_NAME = re.compile(r'com\.whatsoup\.[A-Za-z0-9][A-Za-z0-9._-]*\.plist')
SYSTEM_LAUNCH_AGENTS = Path('/Library/LaunchAgents')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def metadata(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.resolve() != path:
        raise RuntimeError('plist must be regular and have no symlink ancestry')
    if subprocess.run(['/usr/bin/xattr', str(path)], check=True, capture_output=True, timeout=10).stdout:
        raise RuntimeError('extended attributes require an explicit preservation path')
    return {'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode),
            'flags': info.st_flags}


def replace(path, expected_sha, replacement, expected_metadata):
    original = path.read_bytes()
    before = metadata(path)
    if digest(original) != expected_sha or any(before[k] != v for k, v in expected_metadata.items()):
        raise RuntimeError('plist changed since observation')
    if before['flags'] not in (0, stat.UF_IMMUTABLE) or before['mode'] & 0o022:
        raise RuntimeError('unsupported plist protection')
    fd, name = tempfile.mkstemp(prefix='.'+path.name+'.activate-', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(replacement)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchown(stream.fileno(), before['uid'], before['gid'])
            os.fchmod(stream.fileno(), before['mode'])
        if path.read_bytes() != original or metadata(path) != before:
            raise RuntimeError('plist changed before replacement')
        try:
            if before['flags']:
                os.chflags(path, 0)
            if path.read_bytes() != original:
                raise RuntimeError('plist changed during protection transition')
            os.replace(temporary, path)
        finally:
            if before['flags']:
                os.chflags(path, before['flags'])
        if path.read_bytes() != replacement or metadata(path) != before:
            raise RuntimeError('plist replacement verification failed')
    except BaseException:
        observed = metadata(path)
        if path.read_bytes() == replacement and observed in (before, dict(before, flags=0)):
            if observed['flags']:
                os.chflags(path, 0)
            with temporary.open('xb') as stream:
                stream.write(original)
                stream.flush()
                os.fsync(stream.fileno())
                os.fchown(stream.fileno(), before['uid'], before['gid'])
                os.fchmod(stream.fileno(), before['mode'])
            os.replace(temporary, path)
            if before['flags']:
                os.chflags(path, before['flags'])
            if path.read_bytes() != original or metadata(path) != before:
                raise RuntimeError('original plist protection could not be restored')
        raise
    finally:
        if temporary.exists():
            temporary.unlink()
    return {'sha256': digest(replacement), 'metadata': before}


def caller_launch_agents():
    """The sudo caller's own ~/Library/LaunchAgents, from SUDO_UID and the user database."""
    raw_uid = os.environ.get('SUDO_UID', '')
    if not re.fullmatch(r'[0-9]+', raw_uid) or int(raw_uid) == 0:
        raise RuntimeError('root replacement requires a non-root sudo caller')
    home = Path(pwd.getpwuid(int(raw_uid)).pw_dir)
    folder = home / 'Library' / 'LaunchAgents'
    # A home of "/" would name the system folder, which this helper never writes.
    if not home.is_absolute() or home == Path('/') or folder == SYSTEM_LAUNCH_AGENTS:
        raise RuntimeError('sudo caller has no user LaunchAgents folder')
    try:
        resolved = folder.resolve(strict=True)
    except OSError as exc:
        raise RuntimeError('sudo caller has no user LaunchAgents folder') from exc
    if resolved != folder:
        raise RuntimeError('LaunchAgents folder must have no symlink ancestry')
    return folder


def confined_target(raw_path):
    """Limit root replacement to an existing WhatSoup plist in the caller's own LaunchAgents."""
    path = Path(raw_path)
    if path.parent != caller_launch_agents() or not LAUNCH_AGENT_NAME.fullmatch(path.name):
        raise RuntimeError("root replacement is limited to the sudo caller's WhatSoup LaunchAgents")
    if path.is_symlink() or not path.is_file() or path.resolve(strict=True) != path:
        raise RuntimeError('target must be an existing regular plist with no symlink ancestry')
    return path


def main():
    request = json.load(sys.stdin)
    if os.getuid() != 0:
        raise RuntimeError('root replacement must run as root')
    path = confined_target(request['path'])
    replacement = request['contents'].encode()
    parsed = json.loads(subprocess.run(['plutil', '-convert', 'json', '-o', '-', '-'], input=replacement,
                                      check=True, capture_output=True, timeout=10).stdout)
    if parsed.get('Label') != path.name[:-6]:
        raise RuntimeError('plist label does not match target')
    print(json.dumps(replace(path, request['expectedSha256'], replacement, request['metadata'])))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error_type': type(exc).__name__}), file=sys.stderr)
        sys.exit(2)
