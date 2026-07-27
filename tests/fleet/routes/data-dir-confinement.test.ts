/**
 * #2291 M12: the directory-check route must confine to $HOME AFTER
 * canonicalization.
 *
 * `path.resolve` + `startsWith(os.homedir())` is lexical and cannot see
 * symlinks: a link inside $HOME pointing outside it passes the check, and the
 * stat that follows lands outside the home directory.
 *
 * The canonicalization has to tolerate a path that does not exist, because
 * `exists: false` is a normal response from this endpoint — that is the
 * over-correction guarded below.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleCheckDirectory } from '../../../src/fleet/routes/data.ts';
import { mockReq as helperMockReq, mockRes } from '../../helpers/http-mocks.ts';

function req(url: string) {
  return helperMockReq({ url });
}
function check(p: string) {
  const res = mockRes();
  handleCheckDirectory(req(`/api/directories/check?path=${encodeURIComponent(p)}`), res);
  return res;
}

let home: string;
let outside: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-confine-'));
  home = path.join(root, 'home');
  outside = path.join(root, 'outside');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(outside, 'secret'), { recursive: true });
  process.env.HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe('directory check confines to $HOME after canonicalization (#2291 M12)', () => {
  it('rejects a directory reached through a symlink out of $HOME', () => {
    // The request path is lexically inside $HOME and contains no "..".
    fs.symlinkSync(outside, path.join(home, 'escape'));
    const res = check(path.join(home, 'escape', 'secret'));
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/home directory/);
  });

  it('rejects a symlinked path even when the leaf does not exist', () => {
    // Exercises the walk-up: two missing levels below a symlinked ancestor,
    // which a single dirname-realpath would fail to canonicalize.
    fs.symlinkSync(outside, path.join(home, 'escape'));
    const res = check(path.join(home, 'escape', 'not-yet', 'nested'));
    expect(res._status).toBe(400);
  });

  // ── Over-correction guards ───────────────────────────────────────────────

  it('still reports a real directory inside $HOME as existing', () => {
    const real = path.join(home, 'workspace');
    fs.mkdirSync(real);
    const res = check(real);
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body).exists).toBe(true);
  });

  it('still reports a NOT-YET-CREATED directory inside $HOME as exists:false, not 400', () => {
    // The critical over-correction: realpath throws ENOENT here. If that were
    // allowed to reject the path, every "can I create this folder?" probe would
    // fail as out-of-bounds.
    const res = check(path.join(home, 'does-not-exist-yet'));
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body).exists).toBe(false);
  });

  it('accepts $HOME itself', () => {
    const res = check(home);
    expect(res._status).toBe(200);
  });
});
