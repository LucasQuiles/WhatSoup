import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isPathWithinAllowedRoot } from '../lib/path-boundary.ts';

/**
 * Canonicalize a candidate path and confine it to `root`, or return null.
 *
 * `path.normalize` + stripping a leading `..` is a LEXICAL defence: it cannot
 * see symlinks. A symlink planted inside the served root resolves outside it and
 * the lexical check still passes, so the file that actually gets read is not the
 * file that was validated. Canonicalizing first closes that gap — this is the
 * same realpath-then-check shape used by `mcp/tools/media.ts` and
 * `mcp/tools/status.ts`.
 *
 * Note `isPathWithinAllowedRoot` canonicalizes only the ROOT, not the candidate,
 * despite what its docstring used to claim (corrected in this change). The
 * caller must realpath the candidate, which is what happens here.
 *
 * Returns null rather than throwing for a missing path: a 404 is the normal,
 * frequent case on this handler and must not become an exception.
 */
function confineToRoot(candidate: string, root: string): string | null {
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  return isPathWithinAllowedRoot(real, root) ? real : null;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

/**
 * @param getVersion — function returning current version (called per-request so it stays fresh
 *   after git pull updates the code without restarting the fleet server).
 */
export function createStaticHandler(distDir: string, getVersion?: () => string) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    const url = req.url?.split('?')[0] ?? '/';

    // Security: prevent path traversal
    const safePath = path.normalize(url).replace(/^(\.\.[/\\])+/, '');
    let filePath = path.join(distDir, safePath);

    // Helper: serve HTML with public metadata injection (version + auth
    // mode). SECURITY (B1): served HTML must never contain the fleet root
    // token — the console unlocks via POST /api/console-session instead.
    const serveHtml = (htmlPath: string) => {
      let version: string | undefined;
      try {
        version = getVersion?.();
      } catch {
        // Version lookup failed. Serve the HTML without meta injection —
        // degraded but functional (issue #316 class).
        return serveFile(htmlPath, res);
      }
      return version ? serveHtmlWithMeta(htmlPath, version, res) : serveFile(htmlPath, res);
    };

    // Every candidate below is confined AFTER canonicalization, and the
    // canonical path is what gets served — resolving and then serving the
    // pre-resolution path would re-open the same gap.

    // Try exact file first
    const realFile = confineToRoot(filePath, distDir);
    if (realFile && fs.statSync(realFile).isFile()) {
      // Serve HTML with public metadata (version + auth mode) — no secrets injected
      if (path.extname(realFile) === '.html') return serveHtml(realFile);
      return serveFile(realFile, res);
    }

    // Try with index.html for directory requests
    const realDirIndex = confineToRoot(path.join(filePath, 'index.html'), distDir);
    if (realDirIndex) {
      return serveHtml(realDirIndex);
    }

    // SPA fallback: non-API routes without file extensions → index.html
    const ext = path.extname(safePath);
    if (!ext && !url.startsWith('/api/')) {
      const realIndex = confineToRoot(path.join(distDir, 'index.html'), distDir);
      if (realIndex) {
        return serveHtml(realIndex);
      }
    }

    return false; // not handled
  };
}

function serveHtmlWithMeta(filePath: string, version: string, res: ServerResponse): boolean {
  try {
    let html = fs.readFileSync(filePath, 'utf-8');
    // Inject public metadata before </head> — sanitize to prevent XSS.
    // Never inject secrets here: this HTML is served unauthenticated.
    const safeVersion = version.replace(/[^0-9a-zA-Z_\-]/g, '');
    const meta = `<meta name="fleet-version" content="${safeVersion}">\n<meta name="fleet-auth-mode" content="session">`;
    html = html.replace('</head>', `${meta}\n</head>`);
    const buf = Buffer.from(html, 'utf-8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buf.byteLength,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

function serveFile(filePath: string, res: ServerResponse): boolean {
  try {
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    const content = fs.readFileSync(filePath);

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.byteLength,
      'Cache-Control':
        ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}
