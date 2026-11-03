import pg from 'pg';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scheduleInputSchema } from '@hexpayroll/shared';
import { databaseFixture } from './database-fixture.js';
import { migrate, migrateCentral, readMigrations } from '../src/db/migrate.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';
import { tokenHash } from '../src/auth/service.js';
import {
  createCentralEvidenceDecisionService,
  evidenceActions,
} from '../src/timekeeping/central-evidence-decisions.js';
import { createCentralEvidenceAcceptanceService } from '../src/timekeeping/central-evidence-acceptance.js';
import {
  provisionCentralEvidenceWriter,
  testEvidenceWriter,
} from '../src/timekeeping/central-evidence-writer.js';

export const acceptanceTestsEnabled = Boolean(
  process.env.TEST_DATABASE_URL &&
  process.env.TEST_MIGRATION_DATABASE_URL &&
  process.env.TEST_ACCEPTANCE_WRITER_DATABASE_URL,
);
export const acceptanceOptions = {
  skip: acceptanceTestsEnabled
    ? false
    : 'BLOCKED: provision hexpayroll_acceptance_test_writer and set TEST_ACCEPTANCE_WRITER_DATABASE_URL plus existing dedicated test URLs',
};
export async function acceptanceFixture() {
  const db = await databaseFixture();
  let writer: pg.Pool | undefined;
  try {
    const url = new URL(process.env.TEST_ACCEPTANCE_WRITER_DATABASE_URL!);
    const baseline = new URL(process.env.TEST_DATABASE_URL!);
    if (
      decodeURIComponent(url.pathname.slice(1)) !== 'hexpayroll_test' ||
      decodeURIComponent(url.username) !== testEvidenceWriter ||
      url.hostname !== baseline.hostname ||
      url.port !== baseline.port
    )
      throw new Error(
        'Acceptance tests require the dedicated writer in the same isolated hexpayroll_test database',
      );
    await migrate(db.migrator, db.migrations);
    await migrateCentral(
      db.migrator,
      await readMigrations(
        fileURLToPath(new URL('../../../database/central-migrations/', import.meta.url)),
      ),
      db.migrations,
      { mode: 'central', expectedDatabase: 'hexpayroll_test' },
    );
    await provisionCentralEvidenceWriter(db.migrator, 'hexpayroll_test');
    const schema = (await db.migrator.query('SELECT current_schema() name')).rows[0].name;
    writer = new pg.Pool({ connectionString: url.toString(), options: `-c search_path=${schema}` });
    const org = randomUUID(),
      foreignOrg = randomUUID(),
      user = randomUUID(),
      role = randomUUID(),
      node = randomUUID(),
      employee = randomUUID();
    const credentials = {
      nodeToken: randomBytes(32).toString('base64url'),
      sessionToken: randomBytes(32).toString('base64url'),
    };
    await db.runtime.query(
      "INSERT INTO organizations(id,legal_name) VALUES($1,'Acceptance'),($2,'Foreign')",
      [org, foreignOrg],
    );
    await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);
    await db.runtime.query(
      "INSERT INTO employees(id,organization_id,employee_number,first_name,last_name) VALUES($1,$2,'E1','Ana','Santos')",
      [employee, org],
    );
    await db.runtime.query(
      "INSERT INTO auth_users(id,organization_id,username,display_name,password_hash) VALUES($1,$2,'acceptor','Acceptor',$3)",
      [user, org, DUMMY_PASSWORD_HASH],
    );
    await db.runtime.query(
      "INSERT INTO roles(id,organization_id,code,name) VALUES($1,$2,'acceptor','Acceptor')",
      [role, org],
    );
    await db.runtime.query('INSERT INTO user_roles VALUES($1,$2)', [user, role]);
    for (const permission of new Set(Object.values(evidenceActions).map((a) => a.permission)))
      await db.runtime.query('INSERT INTO role_permissions VALUES($1,$2)', [role, permission]);
    await db.runtime.query(
      "INSERT INTO sync_nodes(id,organization_id,device_name,token_hash) VALUES($1,$2,'Acceptance PC',$3)",
      [node, org, tokenHash(credentials.nodeToken)],
    );
    await db.runtime.query(
      "INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [user, tokenHash(credentials.sessionToken)],
    );
    const authorize = createCentralEvidenceDecisionService(db.runtime, 'central');
    const accept = createCentralEvidenceAcceptanceService(writer, 'central');
    async function propose(
      action: string,
      entityId: string,
      expectedRevision: number,
      payload: Record<string, unknown>,
    ) {
      const request = {
        version: 1,
        requestId: randomUUID(),
        organizationId: org,
        entityId,
        action,
        expectedRevision,
        payload,
      };
      const authorization = await authorize(credentials, request);
      return { authorizationDecisionId: authorization.decision_id as string, request };
    }
    const commit = async (
      action: string,
      id: string,
      revision: number,
      payload: Record<string, unknown>,
    ) => accept(credentials, await propose(action, id, revision, payload));
    const schedulePayload = (effectiveFrom = '2026-01-01') => ({
      ...scheduleInputSchema.parse({
        code: 'S' + randomUUID(),
        name: 'Night shift',
        reason: 'Authorized schedule',
        effectiveFrom,
        days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          dayOfWeek,
          isWorkDay: true,
          startTime: '22:00',
          endTime: '06:00',
          endDayOffset: 1,
          breakStart: '02:00',
          breakEnd: '03:00',
          breakStartDayOffset: 1,
          breakEndDayOffset: 1,
          graceMinutes: 10,
        })),
      }),
      versionId: randomUUID(),
      timezone: 'Asia/Manila',
    });
    const typePayload = (requiresApproval = true) => ({
      code: 'L' + randomUUID(),
      name: 'Vacation',
      description: null,
      status: 'active',
      paid: true,
      requiresApproval,
    });
    const assignmentPayload = (scheduleId: string) => ({
      employeeId: employee,
      scheduleId,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      reason: 'Authorized assignment',
    });
    const leavePayload = (leaveTypeId: string, date = '2026-03-01') => ({
      employeeId: employee,
      leaveTypeId,
      startDate: date,
      endDate: date,
      durationType: 'full_day',
      reason: 'Requested leave',
    });
    return {
      ...db,
      writer,
      org,
      foreignOrg,
      user,
      role,
      node,
      employee,
      credentials,
      accept,
      propose,
      commit,
      schedulePayload,
      typePayload,
      assignmentPayload,
      leavePayload,
      async counts() {
        const result: Record<string, number> = {};
        for (const table of [
          'work_schedules',
          'work_schedule_versions',
          'work_schedule_days',
          'employee_schedule_assignments',
          'schedule_assignment_history',
          'leave_types',
          'leave_requests',
          'central_evidence_acceptances',
          'central_evidence_events',
          'sync_outbox',
          'sync_changes',
          'attendance_records',
          'central_attendance_state',
          'attendance_processing_jobs',
        ])
          result[table] = (
            await db.runtime.query(`SELECT count(*)::int n FROM ${table}`)
          ).rows[0].n;
        return result;
      },
      async close() {
        await writer!.end();
        await db.close();
      },
    };
  } catch (error) {
    if (writer) await writer.end();
    await db.close();
    throw error;
  }
}
