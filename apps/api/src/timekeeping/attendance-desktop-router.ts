import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  attendanceDesktopCommandSchema,
  loginRequestSchema,
  loginResponseSchema,
  sessionResponseSchema,
  type PublicUser,
  type Permission,
} from '@hexpayroll/shared';
import { authenticate, domainErrors } from './middleware.js';
import {
  DomainError,
  requirePermission,
  transaction,
  type Actor,
} from '../foundation/repository.js';
import { tokenHash } from '../auth/service.js';
import { createLoginLimiter } from '../auth/rate-limit.js';
import type { SyncClientConfig } from '../sync/client.js';
import {
  createAttendanceManagementReader,
  attendancePeriodSchema,
  readLocalAttendanceEvidence,
} from './attendance-management-read.js';

type CentralSession = {
  token: string;
  user: PublicUser;
  expiresAt: string;
  localExpiresAt: number;
};
type Options = {
  mode: 'local' | 'central' | 'disabled';
  capture: boolean;
  finalization: boolean;
  central?: SyncClientConfig;
};
const permissions: Record<string, Permission[]> = {
  certify: ['attendance.manage'],
  proposals: ['attendance.manage'],
  finalize: ['attendance.manage', 'attendance.approve'],
  reopen: ['attendance.manage'],
  exceptions: ['attendance.adjust', 'attendance.approve'],
};
class UpstreamError extends DomainError {}

/** Same-origin desktop bridge. Node credentials and central session tokens never
 * reach the renderer. Session bindings are in memory, scoped to a live local
 * bearer session; commands are sent only on an explicit operator request.
 */
export function createAttendanceDesktopRouter(pool: Pool, options: Options) {
  const router = Router(),
    sessions = new Map<string, CentralSession>(),
    limiter = createLoginLimiter();
  const reader = createAttendanceManagementReader(pool, {
    capture: options.capture,
    finalization: options.finalization,
    centralConfigured: !!options.central,
  });
  if (options.central) {
    const u = new URL(options.central.url);
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      (u.protocol !== 'https:' &&
        !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
    )
      throw new Error('Configured central must use HTTPS or loopback HTTP');
  }
  router.use('/attendance-management', authenticate(pool));
  router.use('/attendance-management', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      requirePermission(res.locals.actor as Actor, 'attendance.view');
      next();
    } catch (e) {
      next(e);
    }
  });
  const key = (header: string | undefined) =>
    tokenHash(/^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header ?? '')?.[1] ?? '');
  async function remote(
    path: string,
    method: string,
    body?: unknown,
    userToken?: string,
    node = false,
  ) {
    if (!options.central || !options.finalization)
      throw new UpstreamError(
        503,
        'CENTRAL_DISABLED',
        'Central attendance is not enabled on this installation',
      );
    let response: Response;
    try {
      response = await fetch(options.central.url.replace(/\/$/, '') + '/api/' + path, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(node
            ? {
                Authorization: 'Bearer ' + options.central.token,
                'X-Central-Session': userToken ?? '',
              }
            : userToken
              ? { Authorization: 'Bearer ' + userToken }
              : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
        cache: 'no-store',
      });
    } catch {
      throw new UpstreamError(
        503,
        'CENTRAL_UNAVAILABLE',
        'Central service is unreachable. Local evidence remains available; no approval is queued.',
      );
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    const stream = response.body?.getReader();
    if (stream) {
      try {
        for (;;) {
          const p = await stream.read();
          if (p.done) break;
          length += p.value.length;
          if (length > 4194304)
            throw new UpstreamError(
              502,
              'CENTRAL_RESPONSE_INVALID',
              'Central response exceeds the reviewed size limit',
            );
          chunks.push(p.value);
        }
      } finally {
        await stream.cancel();
      }
    }
    let result: unknown;
    try {
      result = length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    } catch {
      throw new UpstreamError(
        502,
        'CENTRAL_RESPONSE_INVALID',
        'Central returned an invalid response',
      );
    }
    if (!response.ok) {
      const error = z
        .object({ error: z.object({ code: z.string(), message: z.string().optional() }) })
        .safeParse(result);
      if (response.status === 401)
        throw new UpstreamError(
          409,
          'CENTRAL_SESSION_EXPIRED',
          'Central authorization expired. Sign in centrally again; your local session remains active.',
        );
      throw new UpstreamError(
        response.status >= 500 ? 503 : response.status,
        error.success ? error.data.error.code : 'CENTRAL_REQUEST_FAILED',
        error.success
          ? (error.data.error.message ?? 'Central sign-in was denied')
          : 'Central request could not be confirmed',
      );
    }
    return result;
  }
  function prune() {
    for (const [k, s] of sessions)
      if (Date.parse(s.expiresAt) <= Date.now() || s.localExpiresAt <= Date.now())
        sessions.delete(k);
  }
  async function current(sessionKey: string, actor: Actor) {
    if (
      !options.central ||
      !(
        await pool.query(
          'SELECT 1 FROM sync_nodes WHERE id=$1 AND organization_id=$2 AND token_hash=$3 AND enabled AND revoked_at IS NULL',
          [options.central.nodeId, actor.organizationId, tokenHash(options.central.token)],
        )
      ).rowCount
    )
      throw new UpstreamError(
        403,
        'NODE_INVALID',
        'Local installation enrollment is unavailable; central actions are disabled',
      );
    prune();
    const s = sessions.get(sessionKey);
    if (!s)
      throw new UpstreamError(
        409,
        'CENTRAL_SIGN_IN_REQUIRED',
        'Sign in to the central attendance service',
      );
    try {
      const checked = sessionResponseSchema.parse(
        await remote('auth/session', 'GET', undefined, s.token),
      );
      if (checked.user.organizationId !== actor.organizationId)
        throw new UpstreamError(
          403,
          'ORGANIZATION_MISMATCH',
          'Central account belongs to another organization',
        );
      s.user = checked.user;
      s.expiresAt = checked.expiresAt;
      return s;
    } catch (e) {
      if (e instanceof UpstreamError && e.code === 'CENTRAL_SESSION_EXPIRED')
        sessions.delete(sessionKey);
      throw e;
    }
  }
  router.get('/attendance-management/days', async (req, res) =>
    res.json(await reader.days(res.locals.actor, req.query)),
  );
  router.get('/attendance-management/monitor', async (_req, res) =>
    res.json(await reader.monitor(res.locals.actor)),
  );
  router.get('/attendance-management/detail', async (req, res) =>
    res.json(await reader.detail(res.locals.actor, req.query)),
  );
  router.post('/attendance-management/evidence', async (req, res) =>
    res.json(await readLocalAttendanceEvidence(pool, res.locals.actor, req.body)),
  );
  router.post('/attendance-management/request-id', async (_req, res) =>
    res.json((await pool.query('SELECT uuidv7() id')).rows[0]),
  );
  router.get('/attendance-management/central/connection', async (req, res) => {
    const sessionKey = key(req.headers.authorization);
    prune();
    if (!sessions.has(sessionKey)) {
      res.json({
        configured: !!options.central && options.finalization,
        connected: false,
        user: null,
        expiresAt: null,
        checkedAt: null,
        reason: options.finalization
          ? 'Central sign-in required'
          : 'Central finalization is disabled',
      });
      return;
    }
    const s = await current(sessionKey, res.locals.actor);
    res.json({
      configured: true,
      connected: true,
      user: s.user,
      expiresAt: s.expiresAt,
      checkedAt: new Date().toISOString(),
    });
  });
  router.post('/attendance-management/central/login', async (req, res) => {
    const actor = res.locals.actor as Actor,
      sessionKey = key(req.headers.authorization);
    const retry = limiter(sessionKey);
    if (retry) throw new DomainError(429, 'RATE_LIMITED', 'Wait before retrying central sign-in');
    prune();
    if (sessions.size >= 1000 && !sessions.has(sessionKey))
      throw new DomainError(503, 'CENTRAL_SESSION_LIMIT', 'Central session capacity reached');
    const input = loginRequestSchema.parse(req.body);
    const login = loginResponseSchema.parse(await remote('auth/login', 'POST', input));
    if (login.user.organizationId !== actor.organizationId) {
      await remote('auth/logout', 'POST', undefined, login.accessToken).catch(() => {});
      throw new DomainError(
        403,
        'ORGANIZATION_MISMATCH',
        'Central account belongs to another organization',
      );
    }
    const local = (
      await pool.query(
        'SELECT expires_at FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp()',
        [sessionKey, actor.id],
      )
    ).rows[0];
    if (!local) {
      await remote('auth/logout', 'POST', undefined, login.accessToken).catch(() => {});
      throw new DomainError(401, 'SESSION_INVALID', 'Local session expired');
    }
    const previous = sessions.get(sessionKey);
    if (previous) await remote('auth/logout', 'POST', undefined, previous.token).catch(() => {});
    sessions.set(sessionKey, {
      token: login.accessToken,
      user: login.user,
      expiresAt: login.expiresAt,
      localExpiresAt: Date.parse(local.expires_at),
    });
    res.json({
      configured: true,
      connected: true,
      user: login.user,
      expiresAt: login.expiresAt,
      checkedAt: new Date().toISOString(),
    });
  });
  router.post('/attendance-management/central/disconnect', async (req, res) => {
    const k = key(req.headers.authorization),
      s = sessions.get(k);
    sessions.delete(k);
    let revoked = !s;
    if (s)
      try {
        await remote('auth/logout', 'POST', undefined, s.token);
        revoked = true;
      } catch {
        /* Binding is already removed; central expiry remains authoritative. */
      }
    res.json({ disconnected: true, revocationConfirmed: revoked });
  });
  router.post('/attendance-management/central/workspace', async (req, res) => {
    const p = attendancePeriodSchema.parse(req.body),
      actor = res.locals.actor as Actor,
      s = await current(key(req.headers.authorization), actor);
    res.json(
      await remote(
        'sync/attendance/workspace',
        'POST',
        { ...p, organizationId: actor.organizationId },
        s.token,
        true,
      ),
    );
  });
  router.post('/attendance-management/central/evidence', async (req, res) => {
    const q = attendancePeriodSchema
        .extend({
          kind: z.enum(['certification', 'proposal', 'history', 'exception']),
          id: z.uuid(),
        })
        .strict()
        .parse(req.body),
      actor = res.locals.actor as Actor,
      s = await current(key(req.headers.authorization), actor);
    res.json(
      await remote(
        'sync/attendance/evidence',
        'POST',
        { ...q, organizationId: actor.organizationId },
        s.token,
        true,
      ),
    );
  });
  router.post('/attendance-management/central/command', async (req, res) => {
    const input = attendanceDesktopCommandSchema.strict().parse(req.body),
      actor = res.locals.actor as Actor;
    for (const p of permissions[input.action]!) requirePermission(actor, p);
    const s = await current(key(req.headers.authorization), actor);
    for (const p of permissions[input.action]!)
      if (!s.user.permissions?.includes(p))
        throw new UpstreamError(
          403,
          'CENTRAL_PERMISSION_DENIED',
          'The current central account does not have permission for this command',
        );
    const command = {
      ...input.command,
      reason: z.string().trim().min(1).max(2000).parse(input.command.reason),
      ...(input.action === 'proposals'
        ? { proposalId: input.requestId }
        : { requestId: input.requestId }),
      ...(['certify', 'reopen'].includes(input.action)
        ? {
            organizationId: actor.organizationId,
            employeeId: input.employeeId,
            workDate: input.workDate,
          }
        : {}),
    };
    if (['proposals', 'exceptions', 'finalize'].includes(input.action)) {
      const target = z
        .uuid()
        .parse(
          input.action === 'finalize' ? input.command.proposalId : input.command.certificationId,
        );
      await remote(
        'sync/attendance/evidence',
        'POST',
        {
          organizationId: actor.organizationId,
          employeeId: input.employeeId,
          workDate: input.workDate,
          kind: input.action === 'finalize' ? 'proposal' : 'certification',
          id: target,
        },
        s.token,
        true,
      );
    }
    const id = input.requestId;
    const response = await transaction(pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'attendance-desktop:' + id,
      ]);
      const prior = (
        await c.query(
          'SELECT *,command=$2::jsonb matches FROM attendance_desktop_requests WHERE id=$1',
          [id, JSON.stringify(command)],
        )
      ).rows[0];
      if (prior) {
        if (
          !prior.matches ||
          prior.operator_id !== actor.id ||
          prior.central_actor_id !== s.user.id ||
          prior.organization_id !== actor.organizationId ||
          prior.employee_id !== input.employeeId ||
          prior.action !== input.action ||
          String(prior.work_date) !== input.workDate
        )
          throw new DomainError(
            409,
            'REQUEST_ID_REUSED',
            'Desktop request identity changed; inspect its immutable journal',
          );
      } else
        await c.query(
          'INSERT INTO attendance_desktop_requests(id,organization_id,employee_id,work_date,operator_id,central_actor_id,action,command) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            id,
            actor.organizationId,
            input.employeeId,
            input.workDate,
            actor.id,
            s.user.id,
            input.action,
            JSON.stringify(command),
          ],
        );
      return (
        (
          await c.query(
            "SELECT result FROM attendance_desktop_outcomes WHERE request_id=$1 AND outcome='confirmed'",
            [id],
          )
        ).rows[0] ?? null
      );
    });
    // The immutable local intent commits BEFORE the network operation, so a
    // timeout/restart cannot require a newly invented central request identity.
    if (response) {
      res.json(response.result);
      return;
    }
    try {
      const result = await remote(
        'sync/attendance/' + input.action,
        'POST',
        command,
        s.token,
        true,
      );
      await pool.query(
        "INSERT INTO attendance_desktop_outcomes(request_id,outcome,result) VALUES($1,'confirmed',$2) ON CONFLICT(request_id) WHERE outcome='confirmed' DO NOTHING",
        [id, JSON.stringify(result)],
      );
      res.json(result);
    } catch (e) {
      await pool.query(
        "INSERT INTO attendance_desktop_outcomes(request_id,outcome,code) VALUES($1,'unconfirmed',$2)",
        [id, e instanceof DomainError ? e.code : 'CENTRAL_RESPONSE_UNCONFIRMED'],
      );
      throw e;
    }
  });
  router.use(domainErrors);
  return router;
}
