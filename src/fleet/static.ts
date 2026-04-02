import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

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

export function createStaticHandler(distDir: string, fleetToken?: string) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    const url = req.url?.split('?')[0] ?? '/';

    // Security: prevent path traversal
    const safePath = path.normalize(url).replace(/^(\.\.[/\\])+/, '');
    let filePath = path.join(distDir, safePath);

    // Try exact file first
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return serveFile(filePath, res);
    }

    // Try with index.html for directory requests
    if (fs.existsSync(path.join(filePath, 'index.html'))) {
      return serveFile(path.join(filePath, 'index.html'), res);
    }

    // SPA fallback: non-API routes without file extensions → index.html
    const ext = path.extname(safePath);
    if (!ext && !url.startsWith('/api/')) {
      const indexPath = path.join(distDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        // Inject fleet token meta tag for EventSource auth in production
        if (fleetToken) {
          return serveHtmlWithToken(indexPath, fleetToken, res);
        }
        return serveFile(indexPath, res);
      }
    }

    return false; // not handled
  };
}

function serveHtmlWithToken(filePath: string, token: string, res: ServerResponse): boolean {
  try {
    let html = fs.readFileSync(filePath, 'utf-8');
    // Inject fleet token meta tag before </head> — sanitize to prevent XSS
    const safeToken = token.replace(/[^0-9a-zA-Z_\-]/g, '');
    const meta = `<meta name="fleet-token" content="${safeToken}">`;
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
