import { createServer, request, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { once } from 'node:events';

/** Serve only the packaged renderer on an ephemeral loopback origin. This keeps
 * Origin:null closed at the API and requires no embedded credentials or network. */
export async function serveRenderer(
  directory: string,
  privateToken?: string,
): Promise<{
  url: string;
  server: Server;
  setApi(url: string): void;
}> {
  const root = resolve(directory);
  let apiUrl: string | undefined;
  let origin = '';
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  };
  const server = createServer(async (req, res) => {
    if (req.headers.host !== new URL(origin).host) {
      res.writeHead(403).end();
      return;
    }
    if (req.url?.startsWith('/api/')) {
      const supplied = Buffer.from(String(req.headers['x-hex-renderer-token'] ?? ''));
      const expected = Buffer.from(privateToken ?? '');
      if (
        !privateToken ||
        !apiUrl ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected) ||
        (req.headers.origin && req.headers.origin !== origin)
      ) {
        res.writeHead(401).end();
        return;
      }
      const upstream = request(
        new URL(req.url, apiUrl),
        {
          method: req.method,
          headers: {
            'X-Hex-Private-Token': privateToken,
            Origin: origin,
            ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
            ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}),
          },
          timeout: 30_000,
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, {
            'Content-Type': response.headers['content-type'] ?? 'application/json',
            'Cache-Control': 'no-store',
          });
          response.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(503);
        res.end();
      });
      upstream.on('timeout', () => upstream.destroy());
      req.on('aborted', () => upstream.destroy());
      req.pipe(upstream);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + sep) || !types[extname(file)]) {
        res.writeHead(404).end();
        return;
      }
      const data = await readFile(file);
      res.setHeader('Content-Type', types[extname(file)]!);
      res.writeHead(200).end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Renderer failed to bind loopback');
  origin = `http://127.0.0.1:${addr.port}`;
  return {
    server,
    url: origin,
    setApi(url) {
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('Invalid private API address');
      apiUrl = url;
    },
  };
}
