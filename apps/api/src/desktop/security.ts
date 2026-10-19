import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

export function desktopGuard(token: string): RequestHandler {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid desktop credential');
  return (req, res, next) => {
    const supplied = req.headers['x-hex-desktop'];
    const origin = req.headers.origin;
    const expectedHost = `127.0.0.1:${req.socket.localPort}`;
    if (
      req.headers.host !== expectedHost ||
      (origin !== undefined && origin !== 'hexpayroll://app') ||
      typeof supplied !== 'string' ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
    ) {
      res.status(403).json({ error: { code: 'DESKTOP_ACCESS_DENIED', message: 'Access denied' } });
      return;
    }
    next();
  };
}
