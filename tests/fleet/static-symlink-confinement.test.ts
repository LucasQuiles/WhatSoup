/**
 * #2291 M11: the static handler must confine served files to distDir AFTER
 * canonicalization.
 *
 * `path.normalize` + stripping a leading `..` is lexical and cannot see
 * symlinks, so a link planted inside distDir resolves outside it while the
 * lexical check still passes — the file that gets READ is not the file that was
 * validated.
 *
 * Note the fixture root is `mkdtempSync(os.tmpdir())`, which on macOS is itself
 * under a symlink (/var -> /private/var, /tmp -> /private/tmp). That makes these
 * tests exercise real canonicalization rather than a synthetic case, and it is
 * why an over-correction here would show up as legitimate files 404ing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createStaticHandler } from '../../src/fleet/static.ts';

let root: string;
let distDir: string;
let outsideDir: string;
let server: Server;
let port: number;

async function get(urlPath: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`);
  return { status: res.status, body: await res.text() };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-confine-'));
  distDir = path.join(root, 'dist');
  outsideDir = path.join(root, 'outside');
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body>app</body></html>');
  fs.writeFileSync(path.join(distDir, 'assets', 'legit.js'), 'console.log("legit");');

  // The secret lives OUTSIDE the served root.
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'TOP-SECRET-OUTSIDE-ROOT');

  // A symlink planted INSIDE distDir that points outside it. This is the attack:
  // every lexical check passes because the request path contains no "..".
  fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(distDir, 'leak.txt'));
  // Same, one level deeper and via a symlinked DIRECTORY.
  fs.symlinkSync(outsideDir, path.join(distDir, 'escape'));

  const handler = createStaticHandler(distDir);
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!handler(req, res)) {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('static handler confines served files to distDir (#2291 M11)', () => {
  it('refuses a file symlinked out of the served root', async () => {
    const res = await get('/leak.txt');
    expect(res.body).not.toContain('TOP-SECRET-OUTSIDE-ROOT');
    expect(res.status).toBe(404);
  });

  it('refuses a file reached through a symlinked directory inside the root', async () => {
    const res = await get('/escape/secret.txt');
    expect(res.body).not.toContain('TOP-SECRET-OUTSIDE-ROOT');
    expect(res.status).toBe(404);
  });

  // ── Over-correction guards ───────────────────────────────────────────────
  // Adding canonicalization risks rejecting legitimate paths — especially on
  // macOS, where the temp root is reached through /var and /tmp symlinks. If
  // the root were compared without canonicalization these would 404.

  it('still serves a legitimate nested asset', async () => {
    const res = await get('/assets/legit.js');
    expect(res.status).toBe(200);
    expect(res.body).toContain('legit');
  });

  it('still serves index.html at the root', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('app');
  });

  it('still serves the SPA fallback for an extensionless route', async () => {
    const res = await get('/some/client/route');
    expect(res.status).toBe(200);
    expect(res.body).toContain('app');
  });

  it('returns 404 — not a 500 — for a path that does not exist', async () => {
    // realpathSync throws ENOENT for a missing path. If that escaped instead of
    // being converted to "not handled", every 404 would become a server error.
    const res = await get('/assets/does-not-exist.js');
    expect(res.status).toBe(404);
  });
});
