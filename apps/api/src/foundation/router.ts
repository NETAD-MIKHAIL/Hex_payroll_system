import { authenticate, domainErrors } from '../timekeeping/middleware.js';
import { Router } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  organizationInputSchema,
  organizationSetupSchema,
  departmentInputSchema,
  positionInputSchema,
  employeeInputSchema,
  employmentInputSchema,
  deviceInputSchema,
  mappingInputSchema,
  payrollConfigurationSchema,
  roleInputSchema,
  listQuerySchema,
  createUserSchema,
  revisionSchema,
  type Permission,
  type FoundationRecord,
} from '@hexpayroll/shared';
import { hashPassword } from '../auth/password.js';
import { syncWorkerStatus, type SyncWorkerStatus } from '../sync/status.js';
import { captureLocalConflict } from '../sync/local-conflicts.js';
import { updateFoundationRecord } from './mutations.js';
import {
  DomainError,
  transaction,
  requirePermission,
  audit,
  outbox,
  insert,
  update,
  normalize,
  project,
  lockEmployee,
  sensitiveFields,
  readOrganization,
  type Actor,
} from './repository.js';
const userUpdateSchema = createUserSchema
  .omit({ password: true })
  .extend({
    password: createUserSchema.shape.password.optional(),
    active: z.boolean(),
    roleIds: z.array(z.uuid()).min(1),
    expectedRevision: revisionSchema,
  })
  .strict();
const userCreateSchema = createUserSchema.extend({ roleIds: z.array(z.uuid()).min(1) }).strict();
const uuid = z.uuid();
const employeeSelect = `SELECT e.*,v.department_id,v.position_id,v.employment_type,v.employment_status,v.pay_type,v.pay_frequency,v.basic_rate_centavos,d.name department_name,p.name position_name FROM employees e JOIN organizations o ON o.id=e.organization_id LEFT JOIN LATERAL (SELECT * FROM employment_versions WHERE employee_id=e.id AND effective_from <= (now() AT TIME ZONE o.timezone)::date AND (effective_to IS NULL OR effective_to > (now() AT TIME ZONE o.timezone)::date) ORDER BY effective_from DESC LIMIT 1) v ON true LEFT JOIN departments d ON d.id=v.department_id LEFT JOIN positions p ON p.id=v.position_id`;
async function employeeSnapshot(client: PoolClient, id: string, org: string) {
  const result = await client.query('SELECT * FROM employees WHERE id=$1 AND organization_id=$2', [
    id,
    org,
  ]);
  const row = normalize(result.rows[0]!);
  row.employmentVersions = (
    await client.query(
      'SELECT * FROM employment_versions WHERE employee_id=$1 AND organization_id=$2 ORDER BY effective_from',
      [id, org],
    )
  ).rows.map(normalize);
  return row;
}
async function validateRoles(client: PoolClient, ids: string[], org: string) {
  const result = await client.query(
    'SELECT id FROM roles WHERE id=ANY($1::uuid[]) AND (organization_id=$2 OR system)',
    [ids, org],
  );
  if (result.rowCount !== new Set(ids).size)
    throw new DomainError(400, 'INVALID_REQUEST', 'Invalid role selection');
}
async function protectAdministrator(client: PoolClient) {
  const result = await client.query(
    "SELECT 1 FROM auth_users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE u.active AND r.code='administrator' LIMIT 1",
  );
  if (!result.rowCount)
    throw new DomainError(409, 'CONFLICT', 'At least one active Administrator is required');
}
export function createFoundationRouter(
  pool: Pool,
  syncConfig: { mode: string; nodeId?: string; interval?: number; status?: SyncWorkerStatus } = {
    mode: 'disabled',
  },
) {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(authenticate(pool));
  const actor = (res: { locals: Record<string, unknown> }) => res.locals.actor as Actor;
  router.get('/organization/setup', async (_req, res) => {
    const result = await pool.query(
      'SELECT organization_id,administrator_id IS NOT NULL administrator_ready FROM application_setup WHERE singleton',
    );
    res.json({
      required: !result.rows[0]?.organization_id,
      administratorReady: result.rows[0]?.administrator_ready === true,
    });
  });
  router.post('/organization/setup', async (req, res) => {
    const who = actor(res);
    requirePermission(who, 'organization.update');
    const input = organizationSetupSchema.parse(req.body);
    const { id, ...organizationInput } = input;
    if (id && syncConfig.mode !== 'central')
      throw new DomainError(
        400,
        'INVALID_REQUEST',
        'Explicit organization ID is only allowed during central setup',
      );
    const organization = await transaction(pool, async (client) => {
      const setup = await client.query<{
        organization_id: string | null;
        administrator_id: string | null;
      }>('SELECT * FROM application_setup WHERE singleton FOR UPDATE');
      if (setup.rows[0]?.organization_id)
        throw new DomainError(409, 'CONFLICT', 'Company already configured');
      if (setup.rows[0]?.administrator_id !== who.id)
        throw new DomainError(403, 'FORBIDDEN', 'Bootstrap administrator must complete setup');
      const row = await insert(client, 'organizations', {
        ...organizationInput,
        ...(id ? { id } : {}),
        updatedBy: who.id,
      });
      await client.query('UPDATE application_setup SET organization_id=$1 WHERE singleton', [
        row.id,
      ]);
      await client.query('UPDATE auth_users SET organization_id=$1 WHERE organization_id IS NULL', [
        row.id,
      ]);
      await client.query(
        "INSERT INTO user_roles SELECT u.id,r.id FROM auth_users u CROSS JOIN roles r WHERE r.code='viewer' AND NOT EXISTS(SELECT 1 FROM user_roles WHERE user_id=u.id)",
      );
      await audit(
        client,
        { ...who, organizationId: row.id },
        'CREATE',
        'organizations',
        row.id,
        Object.keys(organizationInput),
      );
      await outbox(client, 'organizations', row, 'CREATE');
      return row;
    });
    res.status(201).json(organization);
  });
  router.use((_req, res, next) => {
    if (!actor(res).organizationId)
      return next(new DomainError(409, 'SETUP_REQUIRED', 'Complete organization setup first'));
    next();
  });
  router.get('/organization', async (_req, res) => {
    const who = actor(res);
    requirePermission(who, 'organization.view');
    res.json(await readOrganization(pool, who.organizationId!));
  });
  router.put('/organization', async (req, res) => {
    const who = actor(res);
    requirePermission(who, 'organization.update');
    const { expectedRevision, ...body } = z
      .object({ expectedRevision: revisionSchema })
      .passthrough()
      .parse(req.body);
    const input = organizationInputSchema.parse(body);
    res.json(
      await transaction(pool, async (client) => {
        const row = await update(
          client,
          'organizations',
          who.organizationId!,
          who.organizationId!,
          expectedRevision,
          input,
          who,
        );
        await audit(client, who, 'CONFIG_CHANGE', 'organizations', row.id, Object.keys(input));
        await outbox(client, 'organizations', row, 'UPDATE');
        return row;
      }),
    );
  });
  const domains: {
    path: string;
    table: string;
    schema: z.ZodType<Record<string, unknown>>;
    view: Permission;
    manage: Permission;
  }[] = [
    {
      path: 'departments',
      table: 'departments',
      schema: departmentInputSchema,
      view: 'departments.view',
      manage: 'departments.manage',
    },
    {
      path: 'positions',
      table: 'positions',
      schema: positionInputSchema,
      view: 'positions.view',
      manage: 'positions.manage',
    },
    {
      path: 'employees',
      table: 'employees',
      schema: employeeInputSchema,
      view: 'employees.view',
      manage: 'employees.update',
    },
    {
      path: 'biometric-devices',
      table: 'biometric_devices',
      schema: deviceInputSchema,
      view: 'employees.view',
      manage: 'employees.update',
    },
    {
      path: 'biometric-mappings',
      table: 'biometric_mappings',
      schema: mappingInputSchema,
      view: 'employees.view',
      manage: 'employees.update',
    },
  ];
  for (const domain of domains) {
    router.get('/' + domain.path, async (req, res) => {
      const who = actor(res);
      requirePermission(who, domain.view);
      const q = listQuerySchema.parse(req.query);
      const employee = domain.table === 'employees';
      const conditions = [
        sql`${sql.identifier(employee ? 'e' : 't')}.organization_id=${who.organizationId}`,
      ];
      if (q.status)
        conditions.push(sql`${sql.identifier(employee ? 'e' : 't')}.status=${q.status}`);
      if (q.search) {
        const columns = employee
          ? ['employee_number', 'first_name', 'last_name']
          : domain.table === 'biometric_mappings'
            ? ['device_employee_id']
            : ['code', 'name'];
        conditions.push(
          sql`(${sql.join(
            columns.map(
              (c) =>
                sql`${sql.identifier(employee ? 'e' : 't')}.${sql.identifier(c)} ILIKE ${'%' + q.search + '%'}`,
            ),
            sql` OR `,
          )})`,
        );
      }
      if (q.departmentId && employee) conditions.push(sql`v.department_id=${q.departmentId}`);
      const base = employee
        ? sql.raw(employeeSelect)
        : sql`SELECT t.* FROM ${sql.identifier(domain.table)} t`;
      const db = drizzle(pool);
      const filtered = sql`${base} WHERE ${sql.join(conditions, sql` AND `)}`;
      const rows = await db.execute(
        sql`${filtered} ORDER BY ${sql.identifier(employee ? 'e' : 't')}.created_at DESC,${sql.identifier(employee ? 'e' : 't')}.id LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
      );
      const count = await db.execute(
        sql`SELECT count(*)::integer total FROM (${filtered}) records`,
      );
      res.json({
        items: rows.rows.map((r) => project(normalize(r), who)),
        total: count.rows[0]?.total,
        page: q.page,
        pageSize: q.pageSize,
      });
    });
    router.get('/' + domain.path + '/:id', async (req, res) => {
      const who = actor(res);
      requirePermission(who, domain.view);
      const id = uuid.parse(req.params.id);
      const result = await drizzle(pool).execute(
        sql`SELECT * FROM ${sql.identifier(domain.table)} WHERE id=${id} AND organization_id=${who.organizationId}`,
      );
      if (!result.rows[0]) throw new DomainError(404, 'NOT_FOUND', 'Record not found');
      const row = normalize(result.rows[0]);
      if (domain.table === 'employees') {
        row.employmentVersions = (
          await pool.query(
            'SELECT * FROM employment_versions WHERE employee_id=$1 AND organization_id=$2 ORDER BY effective_from DESC',
            [id, who.organizationId],
          )
        ).rows.map((r) => project(normalize(r), who));
        row.biometricMappings = (
          await pool.query(
            'SELECT * FROM biometric_mappings WHERE employee_id=$1 AND organization_id=$2',
            [id, who.organizationId],
          )
        ).rows.map(normalize);
      }
      res.json(project(row, who));
    });
    router.post('/' + domain.path, async (req, res) => {
      const who = actor(res);
      requirePermission(who, domain.table === 'employees' ? 'employees.create' : domain.manage);
      const input = domain.schema.parse(req.body);
      if (
        domain.table === 'employees' &&
        !who.permissions.includes('employees.sensitive.update') &&
        sensitiveFields.some((k) => input[k] != null)
      )
        throw new DomainError(403, 'FORBIDDEN', 'Sensitive field permission required');
      const row = await transaction(pool, async (client) => {
        const saved = await insert(client, domain.table, {
          ...input,
          organizationId: who.organizationId,
          updatedBy: who.id,
        });
        await audit(client, who, 'CREATE', domain.table, saved.id, Object.keys(input));
        await outbox(client, domain.table, saved, 'CREATE');
        return saved;
      });
      res.status(201).json(project(row, who));
    });
    router.put('/' + domain.path + '/:id', async (req, res) => {
      const who = actor(res);
      requirePermission(who, domain.manage);
      const id = uuid.parse(req.params.id);
      const { expectedRevision, ...body } = z
        .object({ expectedRevision: revisionSchema })
        .passthrough()
        .parse(req.body);
      const input = domain.schema.parse(body);
      const row = await transaction(pool, (client) =>
        updateFoundationRecord(client, who, domain.table, id, expectedRevision, input),
      );
      res.json(project(row, who));
    });
  }
  router.post('/employees/:id/employment', async (req, res) => {
    const who = actor(res);
    requirePermission(who, 'employees.update');
    requirePermission(who, 'employees.sensitive.update');
    const id = uuid.parse(req.params.id);
    const { expectedRevision, ...body } = z
      .object({ expectedRevision: revisionSchema })
      .passthrough()
      .parse(req.body);
    const input = employmentInputSchema.parse(body);
    const row = await transaction(pool, async (client) => {
      await lockEmployee(client, who.organizationId!, id, expectedRevision);
      const latest = await client.query<{ effective_from: string; effective_to: string | null }>(
        'SELECT effective_from::text,effective_to::text FROM employment_versions WHERE employee_id=$1 ORDER BY effective_from DESC LIMIT 1',
        [id],
      );
      if (latest.rows[0] && input.effectiveFrom <= latest.rows[0].effective_from)
        throw new DomainError(
          409,
          'CONFLICT',
          'New employment version must follow the latest version',
        );
      await client.query(
        'UPDATE employment_versions SET effective_to=$2,updated_at=now(),updated_by=$3 WHERE employee_id=$1 AND effective_to IS NULL',
        [id, input.effectiveFrom, who.id],
      );
      await insert(client, 'employment_versions', {
        ...input,
        organizationId: who.organizationId,
        employeeId: id,
        updatedBy: who.id,
      });
      await client.query(
        'UPDATE employees SET revision=revision+1,updated_at=now(),updated_by=$2 WHERE id=$1',
        [id, who.id],
      );
      const saved = await employeeSnapshot(client, id, who.organizationId!);
      await audit(client, who, 'UPDATE', 'employment_versions', id, Object.keys(input));
      await outbox(client, 'employees', saved, 'UPDATE');
      return saved;
    });
    res.status(201).json(
      project(
        {
          ...row,
          employmentVersions: (row.employmentVersions as FoundationRecord[]).map((r) =>
            project(r, who),
          ),
        },
        who,
      ),
    );
  });
  router.get('/permissions', async (_req, res) => {
    requirePermission(actor(res), 'roles.view');
    res.json(
      (await pool.query('SELECT code FROM permissions ORDER BY code')).rows.map((r) => r.code),
    );
  });
  router.get('/roles', async (_req, res) => {
    const who = actor(res);
    if (!who.permissions.includes('users.view') && !who.permissions.includes('roles.view'))
      throw new DomainError(403, 'FORBIDDEN', 'Permission required');
    const result = await pool.query(
      "SELECT r.*,COALESCE(array_agg(p.permission_code) FILTER(WHERE p.permission_code IS NOT NULL),'{}') permissions FROM roles r LEFT JOIN role_permissions p ON p.role_id=r.id WHERE r.system OR r.organization_id=$1 GROUP BY r.id ORDER BY r.name",
      [who.organizationId],
    );
    res.json(result.rows.map(normalize));
  });
  for (const method of ['post', 'put'] as const)
    router[method](method === 'post' ? '/roles' : '/roles/:id', async (req, res) => {
      const who = actor(res);
      requirePermission(who, 'roles.manage');
      const input = roleInputSchema.parse(req.body);
      const row = await transaction(pool, async (client) => {
        await client.query('SELECT singleton FROM application_setup WHERE singleton FOR UPDATE');
        let saved: FoundationRecord;
        if (method === 'post')
          saved = await insert(client, 'roles', {
            code: input.code,
            name: input.name,
            organizationId: who.organizationId,
          });
        else {
          const id = uuid.parse((req.params as Record<string, string>).id);
          const current = await client.query(
            'SELECT * FROM roles WHERE id=$1 AND (system OR organization_id=$2) FOR UPDATE',
            [id, who.organizationId],
          );
          if (!current.rows[0]) throw new DomainError(404, 'NOT_FOUND', 'Role not found');
          if (current.rows[0].code === 'administrator')
            throw new DomainError(409, 'CONFLICT', 'Administrator role permissions are protected');
          if (current.rows[0].system && current.rows[0].code !== input.code)
            throw new DomainError(400, 'INVALID_REQUEST', 'System role code cannot change');
          saved = normalize(
            (
              await client.query(
                'UPDATE roles SET code=$2,name=$3,updated_at=now() WHERE id=$1 RETURNING *',
                [id, input.code, input.name],
              )
            ).rows[0]!,
          );
        }
        await client.query('DELETE FROM role_permissions WHERE role_id=$1', [saved.id]);
        for (const p of new Set(input.permissions))
          await client.query(
            'INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2)',
            [saved.id, p],
          );
        await audit(client, who, 'ROLE_CHANGE', 'roles', saved.id, ['code', 'name', 'permissions']);
        return { ...saved, permissions: input.permissions };
      });
      res.status(method === 'post' ? 201 : 200).json(row);
    });
  router.get('/users', async (req, res) => {
    const who = actor(res);
    requirePermission(who, 'users.view');
    const q = listQuerySchema.parse(req.query);
    const where = 'u.organization_id=$1 AND (u.username ILIKE $2 OR u.display_name ILIKE $2)';
    const args = [who.organizationId, '%' + q.search + '%'];
    const rows = await pool.query(
      `SELECT u.id,u.organization_id,u.username,u.email,u.display_name,u.active,u.last_login_at,u.revision,u.created_at,u.updated_at,COALESCE(array_agg(r.id) FILTER(WHERE r.id IS NOT NULL),'{}') role_ids,COALESCE(array_agg(r.name) FILTER(WHERE r.id IS NOT NULL),'{}') roles FROM auth_users u LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id WHERE ${where} GROUP BY u.id ORDER BY u.username LIMIT $3 OFFSET $4`,
      [...args, q.pageSize, (q.page - 1) * q.pageSize],
    );
    const count = await pool.query(
      `SELECT count(*)::integer total FROM auth_users u WHERE ${where}`,
      args,
    );
    res.json({
      items: rows.rows.map(normalize),
      total: count.rows[0].total,
      page: q.page,
      pageSize: q.pageSize,
    });
  });
  router.post('/users', async (req, res) => {
    const who = actor(res);
    requirePermission(who, 'users.create');
    requirePermission(who, 'roles.manage');
    const input = userCreateSchema.parse(req.body);
    const passwordHash = await hashPassword(input.password);
    const row = await transaction(pool, async (client) => {
      await validateRoles(client, input.roleIds, who.organizationId!);
      const saved = await insert(client, 'auth_users', {
        username: input.username,
        email: input.email ?? null,
        displayName: input.displayName,
        passwordHash,
        organizationId: who.organizationId,
        updatedBy: who.id,
      });
      for (const id of new Set(input.roleIds))
        await client.query('INSERT INTO user_roles VALUES($1,$2)', [saved.id, id]);
      await audit(client, who, 'CREATE', 'auth_users', saved.id, [
        'username',
        'displayName',
        'roles',
      ]);
      return { id: saved.id, username: saved.username, displayName: saved.displayName };
    });
    res.status(201).json(row);
  });
  router.put('/users/:id', async (req, res) => {
    const who = actor(res);
    requirePermission(who, 'users.update');
    const id = uuid.parse(req.params.id);
    const input = userUpdateSchema.parse(req.body);
    const passwordHash = input.password ? await hashPassword(input.password) : undefined;
    await transaction(pool, async (client) => {
      await client.query('SELECT singleton FROM application_setup WHERE singleton FOR UPDATE');
      const current = await client.query(
        'SELECT active FROM auth_users WHERE id=$1 AND organization_id=$2',
        [id, who.organizationId],
      );
      if (!current.rows[0]) throw new DomainError(404, 'NOT_FOUND', 'User not found');
      if (input.active !== current.rows[0].active) requirePermission(who, 'users.disable');
      requirePermission(who, 'roles.manage');
      await validateRoles(client, input.roleIds, who.organizationId!);
      await update(
        client,
        'auth_users',
        id,
        who.organizationId!,
        input.expectedRevision,
        {
          username: input.username,
          email: input.email ?? null,
          displayName: input.displayName,
          active: input.active,
          ...(passwordHash ? { passwordHash } : {}),
        },
        who,
      );
      await client.query('DELETE FROM user_roles WHERE user_id=$1', [id]);
      for (const roleId of new Set(input.roleIds))
        await client.query('INSERT INTO user_roles VALUES($1,$2)', [id, roleId]);
      await protectAdministrator(client);
      if (!input.active || passwordHash)
        await client.query('DELETE FROM auth_sessions WHERE user_id=$1', [id]);
      await audit(client, who, 'ROLE_CHANGE', 'auth_users', id, [
        'username',
        'displayName',
        'active',
        'roles',
        ...(passwordHash ? ['passwordChanged'] : []),
      ]);
    });
    res.json({ id });
  });
  router.get('/payroll-config', async (_req, res) => {
    const who = actor(res);
    requirePermission(who, 'payroll_config.view');
    const result = await pool.query(
      'SELECT * FROM payroll_configurations WHERE organization_id=$1',
      [who.organizationId],
    );
    res.json(result.rows[0] ? normalize(result.rows[0]) : { configured: false });
  });
  router.put('/payroll-config', async (req, res) => {
    const who = actor(res);
    requirePermission(who, 'payroll_config.update');
    const { expectedRevision, configuration } = z
      .object({
        expectedRevision: revisionSchema.nullable(),
        configuration: payrollConfigurationSchema,
      })
      .strict()
      .parse(req.body);
    res.json(
      await transaction(pool, async (client) => {
        await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [
          who.organizationId,
        ]);
        const current = await client.query<{ id: string }>(
          'SELECT id FROM payroll_configurations WHERE organization_id=$1',
          [who.organizationId],
        );
        if (Boolean(current.rows[0]) !== (expectedRevision !== null))
          throw new DomainError(409, 'CONFLICT', 'Configuration changed; reload');
        const saved = current.rows[0]
          ? await update(
              client,
              'payroll_configurations',
              current.rows[0].id,
              who.organizationId!,
              expectedRevision!,
              { configuration },
              who,
            )
          : await insert(client, 'payroll_configurations', {
              organizationId: who.organizationId,
              configuration,
              updatedBy: who.id,
            });
        await audit(
          client,
          who,
          'CONFIG_CHANGE',
          'payroll_configurations',
          saved.id,
          Object.keys(configuration),
        );
        await outbox(
          client,
          'payroll_configurations',
          saved,
          current.rows[0] ? 'UPDATE' : 'CREATE',
        );
        return saved;
      }),
    );
  });
  router.get('/audit', async (req, res) => {
    const who = actor(res);
    requirePermission(who, 'audit.view');
    const q = listQuerySchema.parse(req.query);
    const clauses = [sql`a.organization_id=${who.organizationId}`];
    if (q.action) clauses.push(sql`a.action=${q.action}`);
    if (q.entityType) clauses.push(sql`a.entity_type=${q.entityType}`);
    if (q.userId) clauses.push(sql`a.user_id=${q.userId}`);
    const timezone = sql`(SELECT timezone FROM organizations WHERE id=${who.organizationId})`;
    if (q.from)
      clauses.push(sql`a.created_at>=(${q.from}::date::timestamp AT TIME ZONE ${timezone})`);
    if (q.to)
      clauses.push(sql`a.created_at<((${q.to}::date+1)::timestamp AT TIME ZONE ${timezone})`);
    const where = sql.join(clauses, sql` AND `);
    const db = drizzle(pool);
    const result = await db.execute(
      sql`SELECT a.*,u.display_name user_name FROM audit_events a LEFT JOIN auth_users u ON u.id=a.user_id WHERE ${where} ORDER BY a.created_at DESC,a.id DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
    );
    const count = await db.execute(
      sql`SELECT count(*)::integer total FROM audit_events a WHERE ${where}`,
    );
    res.json({
      items: result.rows.map(normalize),
      total: count.rows[0]?.total,
      page: q.page,
      pageSize: q.pageSize,
    });
  });
  router.get('/dashboard/summary', async (_req, res) => {
    const who = actor(res);
    requirePermission(who, 'dashboard.view');
    const result = await pool.query(
      "SELECT count(*)::integer total_employees,count(*) FILTER(WHERE status='active')::integer active_employees FROM employees WHERE organization_id=$1",
      [who.organizationId],
    );
    const departments = await pool.query(
      'SELECT count(*)::integer count FROM departments WHERE organization_id=$1',
      [who.organizationId],
    );
    const attendance = await pool.query(
      `SELECT count(*)::integer processed,
      count(*) FILTER(WHERE attendance_status='present')::integer present,
      count(*) FILTER(WHERE attendance_status='late')::integer late,
      count(*) FILTER(WHERE attendance_status='absent')::integer absent,
      count(*) FILTER(WHERE attendance_status='on_leave')::integer on_leave,
      count(*) FILTER(WHERE attendance_status='incomplete')::integer incomplete,
      count(*) FILTER(WHERE approval_status='needs_review')::integer stale
      FROM attendance_records WHERE organization_id=$1 AND work_date=(SELECT (now() AT TIME ZONE timezone)::date FROM organizations WHERE id=$1)`,
      [who.organizationId],
    );
    const pending = await pool.query(
      'SELECT count(*)::integer pending FROM attendance_processing_jobs WHERE organization_id=$1',
      [who.organizationId],
    );
    res.json({
      ...normalize({ ...result.rows[0], id: who.organizationId }),
      departments: departments.rows[0].count,
      attendanceAvailable: true,
      ...normalize({ id: who.organizationId, ...attendance.rows[0] }),
      pending: pending.rows[0].pending,
    });
  });
  router.get('/sync/summary', async (_req, res) => {
    const who = actor(res);
    requirePermission(who, 'sync.view');
    const result = await pool.query(
      'SELECT status,count(*)::integer count FROM sync_outbox WHERE organization_id=$1 GROUP BY status',
      [who.organizationId],
    );
    res.json({
      configured: syncConfig.mode !== 'disabled',
      mode: syncConfig.mode,
      ...(syncConfig.status ?? syncWorkerStatus).snapshot(
        syncConfig.mode,
        who.organizationId,
        syncConfig.interval ?? 15000,
      ),
      lastSuccessfulPush:
        (
          await pool.query(
            "SELECT max(synced_at) AS last FROM sync_outbox WHERE organization_id=$1 AND status='synced'",
            [who.organizationId],
          )
        ).rows[0].last?.toISOString() ?? null,
      nodeProvisioned: Boolean(
        syncConfig.nodeId &&
        (
          await pool.query(
            'SELECT 1 FROM sync_nodes WHERE id=$1 AND organization_id=$2 AND enabled AND revoked_at IS NULL AND token_hash IS NOT NULL',
            [syncConfig.nodeId, who.organizationId],
          )
        ).rowCount,
      ),
      awaitingApplication: (
        await pool.query(
          'SELECT count(*)::integer count FROM sync_inbox WHERE organization_id=$1 AND applied_at IS NULL',
          [who.organizationId],
        )
      ).rows[0].count,
      conflicts: (
        await pool.query(
          "SELECT count(*)::integer count FROM sync_conflicts WHERE organization_id=$1 AND status IN ('open','under_review')",
          [who.organizationId],
        )
      ).rows[0].count,
      resolvedConflicts: (
        await pool.query(
          "SELECT count(*)::integer count FROM sync_conflicts WHERE organization_id=$1 AND status IN ('resolved','dismissed')",
          [who.organizationId],
        )
      ).rows[0].count,
      lastSyncAttempt:
        (
          await pool.query(
            'SELECT max(last_attempt_at) AS last FROM sync_outbox WHERE organization_id=$1',
            [who.organizationId],
          )
        ).rows[0].last?.toISOString() ?? null,
      pending: 0,
      processing: 0,
      synced: 0,
      failed: 0,
      ...Object.fromEntries(result.rows.map((r) => [r.status, r.count])),
    });
  });
  router.get('/system/details', async (_req, res) => {
    requirePermission(actor(res), 'system_health.view');
    const result = await pool.query('SELECT version() version');
    res.json({
      databaseVersion: result.rows[0].version,
      biometric: 'unconfigured',
      sync: syncConfig.mode,
      biometricIngestion: (
        await pool.query(
          'SELECT d.id,d.name,s.last_ingestion_at,s.last_record_at FROM biometric_devices d LEFT JOIN biometric_ingestion_state s ON s.device_id=d.id WHERE d.organization_id=$1',
          [actor(res).organizationId],
        )
      ).rows.map(normalize),
    });
  });
  router.use(captureLocalConflict(pool));
  router.use(domainErrors);
  return router;
}
