import { Router, json } from 'express';
import type { Pool } from 'pg';
import { createUserSchema } from '@hexpayroll/shared';
import { hashPassword } from '../auth/password.js';
import { transaction, audit, getActor } from '../foundation/repository.js';

export function desktopBootstrapRouter(database: Pool): Router {
  const router = Router();
  router.get('/api/desktop/setup', async (_req, res) => {
    const result = await database.query(
      'SELECT administrator_id FROM application_setup WHERE singleton',
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({ required: result.rows[0]?.administrator_id === null });
  });
  router.post('/api/desktop/setup', json({ limit: '16kb' }), async (req, res, next) => {
    const input = createUserSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({
        error: { message: 'Check account details; use a password of 15–128 characters.' },
      });
      return;
    }
    try {
      const hash = await hashPassword(input.data.password);
      const created = await transaction(database, async (client) => {
        const setup = await client.query(
          'SELECT administrator_id,organization_id FROM application_setup WHERE singleton FOR UPDATE',
        );
        if (setup.rowCount !== 1 || setup.rows[0].administrator_id || setup.rows[0].organization_id)
          return false;
        if ((await client.query('SELECT 1 FROM auth_users LIMIT 1')).rowCount) return false;
        const result = await client.query<{ id: string }>(
          'INSERT INTO auth_users(username,email,display_name,password_hash) VALUES($1,$2,$3,$4) RETURNING id',
          [input.data.username, input.data.email ?? null, input.data.displayName, hash],
        );
        const id = result.rows[0]!.id;
        const role = await client.query(
          "INSERT INTO user_roles SELECT $1,id FROM roles WHERE code='administrator' AND system RETURNING role_id",
          [id],
        );
        if (role.rowCount !== 1) throw new Error('Administrator role missing');
        await client.query('UPDATE application_setup SET administrator_id=$1 WHERE singleton', [
          id,
        ]);
        await audit(client, await getActor(client, id), 'CREATE', 'auth_users', id, [
          'username',
          'displayName',
        ]);
        return true;
      });
      res.status(created ? 201 : 409).json({ created });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
