import { Router, json } from 'express';
import type { Pool } from 'pg';
import { createUserSchema } from '@hexpayroll/shared';
import { hashPassword } from '../auth/password.js';
import { authenticate, domainErrors } from '../timekeeping/middleware.js';
import type { Actor } from '../foundation/repository.js';
import { desktopEnrollmentSchema, type DesktopEnrollment } from './enrollment.js';
import { manualDeviceConnectionSchema, type DesktopDeviceConfiguration } from './device-config.js';

/** Mounted only behind the private launch boundary; never on the central API. */
export function desktopSetupRouter(
  pool: Pool,
  enroll?: (input: DesktopEnrollment) => Promise<void>,
  devices?: DesktopDeviceConfiguration,
) {
  const router = Router();
  router.get('/device-connections', authenticate(pool), async (_req, res) => {
    const actor = res.locals.actor as Actor;
    if (!actor.roles.includes('administrator') || !actor.organizationId) {
      res.sendStatus(403);
      return;
    }
    const rows = await pool.query('SELECT id FROM biometric_devices WHERE organization_id=$1', [
      actor.organizationId,
    ]);
    res.json({
      supportedDiscoveryProtocols: [],
      captureEnabled: false,
      items: (devices?.list() ?? []).filter((item) =>
        rows.rows.some((row) => row.id === item.deviceId),
      ),
    });
  });
  router.post(
    '/device-connections',
    json({ limit: '8kb' }),
    authenticate(pool),
    async (req, res) => {
      const actor = res.locals.actor as Actor;
      if (!actor.roles.includes('administrator') || !actor.organizationId || !devices) {
        res.sendStatus(403);
        return;
      }
      const parsed = manualDeviceConnectionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.sendStatus(400);
        return;
      }
      const found = await pool.query(
        "SELECT id FROM biometric_devices WHERE id=$1 AND organization_id=$2 AND status='active'",
        [parsed.data.deviceId, actor.organizationId],
      );
      if (!found.rowCount) {
        res.sendStatus(404);
        return;
      }
      try {
        await devices.save(parsed.data);
        res.json({ saved: true, captureEnabled: false });
      } catch {
        res
          .status(503)
          .json({
            error: { code: 'STORAGE_FAILED', message: 'Device configuration could not be stored' },
          });
      }
    },
  );
  router.post('/enroll', json({ limit: '8kb' }), authenticate(pool), async (req, res) => {
    const actor = res.locals.actor as Actor;
    if (!actor.roles.includes('administrator') || !actor.organizationId || !enroll) {
      res
        .status(403)
        .json({ error: { code: 'FORBIDDEN', message: 'Local administrator required' } });
      return;
    }
    const parsed = desktopEnrollmentSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.organizationId !== actor.organizationId) {
      res
        .status(400)
        .json({
          error: {
            code: 'INVALID_ENROLLMENT',
            message: 'Invalid per-PC registration or organization mismatch',
          },
        });
      return;
    }
    try {
      await enroll(parsed.data);
      res.json({ saved: true, restartRequired: true });
    } catch {
      res
        .status(409)
        .json({
          error: {
            code: 'ENROLLMENT_FAILED',
            message:
              'Registration could not be stored. Existing enrollment and organization must be reviewed.',
          },
        });
    }
  });
  router.get('/status', async (_req, res) => {
    const result = await pool.query(
      'SELECT administrator_id FROM application_setup WHERE singleton',
    );
    res.json({ needsAdministrator: !result.rows[0]?.administrator_id });
  });
  router.post('/bootstrap', json({ limit: '8kb' }), async (req, res) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.password.length < 14) {
      res
        .status(400)
        .json({
          error: 'Use a valid username, display name and password of at least 14 characters',
        });
      return;
    }
    const hash = await hashPassword(parsed.data.password);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const setup = await client.query(
        'SELECT * FROM application_setup WHERE singleton FOR UPDATE',
      );
      if (
        !setup.rowCount ||
        setup.rows[0].administrator_id ||
        setup.rows[0].organization_id ||
        (await client.query('SELECT 1 FROM auth_users LIMIT 1')).rowCount
      ) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'Setup already exists; no account changed' });
        return;
      }
      const user = await client.query(
        'INSERT INTO auth_users(username,display_name,password_hash,email) VALUES($1,$2,$3,$4) RETURNING id',
        [parsed.data.username, parsed.data.displayName, hash, parsed.data.email ?? null],
      );
      await client.query(
        "INSERT INTO user_roles SELECT $1,id FROM roles WHERE code='administrator'",
        [user.rows[0].id],
      );
      await client.query('UPDATE application_setup SET administrator_id=$1 WHERE singleton', [
        user.rows[0].id,
      ]);
      await client.query(
        `INSERT INTO audit_events(user_id,action,entity_type,entity_id,description) VALUES($1,'ROLE_CHANGE','auth_users',$1,'Initial local administrator created')`,
        [user.rows[0].id],
      );
      await client.query('COMMIT');
      res.status(201).json({ created: true });
    } catch {
      await client.query('ROLLBACK');
      res.status(500).json({ error: 'Administrator setup failed; no credentials were logged' });
    } finally {
      client.release();
    }
  });
  router.use(domainErrors);
  return router;
}
