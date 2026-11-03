import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

/** Separate from the user's session bearer token. Rejected before body parsing or DB access. */
export function privateApiBoundary(token?: string, origin?: string): RequestHandler {
  return (req, res, next) => {
    if (!token) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    const candidate = req.get('X-Hex-Private-Token') ?? '';
    const supplied = Buffer.from(candidate);
    const expected = Buffer.from(token);
    if (
      (req.headers.origin && req.headers.origin !== origin) ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      res
        .status(401)
        .json({
          error: {
            code: 'PRIVATE_API_UNAUTHORIZED',
            message: 'Private application access required',
          },
        });
      return;
    }
    next();
  };
}
