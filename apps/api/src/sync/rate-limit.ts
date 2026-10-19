import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';

/** Operational throttling only; event acceptance never depends on memory. */
export function syncRateLimit(limit = 120): RequestHandler {
  const windows = new Map<string, { until: number; count: number }>();
  return (req, res, next) => {
    if (!/^\/sync\/(push|pull|nodes)(\/|$)/.test(req.path)) return next();
    const now = Date.now();
    const key = createHash('sha256')
      .update((req.ip ?? '') + '\0' + (req.headers.authorization ?? ''))
      .digest('hex');
    let window = windows.get(key);
    if (!window || window.until <= now) {
      if (windows.size >= 10000) {
        for (const [k, v] of windows) if (v.until <= now) windows.delete(k);
      }
      if (windows.size >= 10000) {
        res.status(429).setHeader('Retry-After', '60');
        res.json({ error: { code: 'RATE_LIMITED', message: 'Retry synchronization later' } });
        return;
      }
      window = { until: now + 60000, count: 0 };
      windows.set(key, window);
    }
    if (++window.count > limit) {
      res.status(429).setHeader('Retry-After', String(Math.ceil((window.until - now) / 1000)));
      res.json({ error: { code: 'RATE_LIMITED', message: 'Retry synchronization later' } });
      return;
    }
    next();
  };
}
