import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { applyEmployeeEvent } from '../src/sync/employee-inbox.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';

async function fixture() {
  const db = await databaseFixture();
  try {
    await migrate(db.migrator, db.migrations);
    const org = randomUUID();
    const foreignOrg = randomUUID();
    const id = randomUUID();
    const departmentId = randomUUID();
    const positionId = randomUUID();
    const userId = randomUUID();
    await db.runtime.query(
      "INSERT INTO organizations(id,legal_name) VALUES($1,'Employee test'),($2,'Foreign')",
      [org, foreignOrg],
    );
    await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);
    await db.runtime.query(
      "INSERT INTO departments(id,organization_id,code,name) VALUES($1,$2,'ENG','Engineering')",
      [departmentId, org],
    );
    await db.runtime.query(
      `INSERT INTO positions(id,organization_id,department_id,code,name)
       VALUES($1,$2,$3,'DEV','Developer')`,
      [positionId, org, departmentId],
    );
    await db.runtime.query(
      `INSERT INTO auth_users(id,organization_id,username,display_name,password_hash)
       VALUES($1,$2,'employee_auditor','Auditor',$3)`,
      [userId, org, DUMMY_PASSWORD_HASH],
    );
    const payload = {
      id,
      organizationId: org,
      revision: 1,
      employeeNumber: 'EMP-001',
      firstName: 'Ana',
      middleName: null,
      lastName: 'Santos',
      suffix: null,
      birthDate: '1990-05-17',
      email: null,
      mobileNumber: null,
      address: null,
      barangay: null,
      city: null,
      province: null,
      postalCode: null,
      sssNumber: null,
      philhealthNumber: null,
      pagibigNumber: null,
      tin: null,
      status: 'active',
    };
    const version = {
      id: randomUUID(),
      organizationId: org,
      employeeId: id,
      departmentId,
      positionId,
      effectiveFrom: '2025-01-01',
      effectiveTo: null as string | null,
      employmentType: 'regular',
      employmentStatus: 'active',
      hireDate: '2025-01-01',
      regularizationDate: null,
      terminationDate: null,
      payType: 'monthly',
      payFrequency: 'semi_monthly',
      basicRateCentavos: 2500000,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      updatedBy: userId,
    };
    async function apply(
      snapshot: Record<string, unknown>,
      operation = 'UPDATE',
      envelope: Partial<Parameters<typeof applyEmployeeEvent>[1]> = {},
    ) {
      const client = await db.runtime.connect();
      try {
        await client.query('BEGIN');
        await applyEmployeeEvent(client, {
          organization_id: org,
          entity_id: snapshot.id as string,
          operation,
          revision: snapshot.revision as number,
          payload_version: 1,
          payload: snapshot,
          ...envelope,
        });
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    async function state() {
      return {
        employees: (await db.runtime.query('SELECT * FROM employees ORDER BY id')).rows,
        history: (await db.runtime.query('SELECT * FROM employment_versions ORDER BY id')).rows,
      };
    }
    async function noEcho() {
      assert.equal(
        (await db.runtime.query('SELECT count(*)::int AS count FROM sync_outbox')).rows[0].count,
        0,
      );
    }
    return {
      ...db,
      org,
      foreignOrg,
      id,
      departmentId,
      positionId,
      userId,
      payload,
      version,
      apply,
      state,
      noEcho,
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}

test(
  'employee inbox creates, replays, updates and protects revisions and audit metadata',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await db.apply(db.payload, 'CREATE');
      const original = await db.state();
      assert.equal(original.employees.length, 1);
      assert.equal(original.employees[0].id, db.id);
      assert.equal(original.employees[0].employee_number, 'EMP-001');
      assert.equal(original.employees[0].organization_id, db.org);
      assert.equal(original.employees[0].first_name, 'Ana');
      await db.apply(db.payload, 'CREATE');
      assert.deepEqual(await db.state(), original);
      const updated = { ...db.payload, revision: 2, firstName: 'Anna' };
      await db.apply(updated);
      const saved = await db.state();
      assert.equal(saved.employees[0].first_name, 'Anna');
      assert.equal(saved.employees[0].revision, 2);
      for (const key of ['created_at', 'updated_at', 'updated_by']) {
        assert.deepEqual(saved.employees[0][key], original.employees[0][key]);
      }
      await db.apply(updated);
      await assert.rejects(db.apply({ ...updated, firstName: 'Conflict' }), /revision conflict/);
      await db.apply(db.payload);
      assert.deepEqual(await db.state(), saved);
      await assert.rejects(db.apply({ ...updated, revision: 3 }, 'ARCHIVE'), /archive status/);
      await db.apply({ ...updated, revision: 3, status: 'terminated' }, 'ARCHIVE');
      assert.equal((await db.state()).employees[0].status, 'terminated');
      await db.noEcho();
    } finally {
      await db.close();
    }
  },
);

test(
  'employee inbox synchronizes complete history and closes open periods without deleting history',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await db.apply({ ...db.payload, employmentVersions: [db.version] }, 'CREATE');
      const closed = {
        ...db.version,
        effectiveTo: '2026-01-01',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      const next = {
        ...db.version,
        id: randomUUID(),
        effectiveFrom: '2026-01-01',
        basicRateCentavos: Number.MAX_SAFE_INTEGER,
        createdAt: closed.updatedAt,
        updatedAt: closed.updatedAt,
      };
      const snapshot = { ...db.payload, revision: 2, employmentVersions: [next, closed] };
      await db.apply(snapshot);
      const saved = await db.state();
      assert.equal(saved.history.length, 2);
      const records = (
        await db.runtime.query(
          `SELECT id,effective_from::text,effective_to::text,basic_rate_centavos::text,
          department_id,position_id,updated_by,created_at,updated_at
         FROM employment_versions WHERE employee_id=$1 ORDER BY effective_from`,
          [db.id],
        )
      ).rows;
      assert.equal(records[0].id, db.version.id);
      assert.equal(records[0].effective_from, '2025-01-01');
      assert.equal(records[0].effective_to, '2026-01-01');
      assert.equal(records[0].basic_rate_centavos, '2500000');
      assert.equal(records[1].id, next.id);
      assert.equal(records[1].effective_to, null);
      assert.equal(records[1].basic_rate_centavos, String(Number.MAX_SAFE_INTEGER));
      for (const row of records) {
        assert.equal(row.department_id, db.departmentId);
        assert.equal(row.position_id, db.positionId);
        assert.equal(row.updated_by, db.userId);
      }
      assert.equal(new Date(records[0].created_at).toISOString(), db.version.createdAt);
      assert.equal(new Date(records[0].updated_at).toISOString(), closed.updatedAt);
      await db.apply({ ...snapshot, employmentVersions: [closed, next] });
      assert.deepEqual(await db.state(), saved);
      await assert.rejects(
        db.apply({ ...snapshot, employmentVersions: [closed] }),
        /Incomplete employment history/,
      );
      for (const history of [[], [closed]]) {
        await assert.rejects(
          db.apply({ ...db.payload, revision: 3, employmentVersions: history }),
          /Incomplete employment history/,
        );
        assert.deepEqual(await db.state(), saved);
      }
      await assert.rejects(
        db.apply({
          ...snapshot,
          revision: 3,
          employmentVersions: [closed, { ...next, basicRateCentavos: 1 }],
        }),
        /Unsafe employment history rewrite/,
      );
      assert.deepEqual(await db.state(), saved);
      // Omitted history changes identity fields only; it never clears the collection.
      await db.apply({ ...db.payload, revision: 3, firstName: 'Updated' });
      assert.deepEqual((await db.state()).history, saved.history);
      await db.noEcho();
    } finally {
      await db.close();
    }
  },
);

test(
  'employee inbox distinguishes empty history and rejects malformed or unsafe history atomically',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await db.apply({ ...db.payload, employmentVersions: [] }, 'CREATE');
      const before = await db.state();
      const incomplete = { ...db.version } as Record<string, unknown>;
      delete incomplete.basicRateCentavos;
      const invalid: unknown[] = [
        null,
        {},
        [incomplete],
        ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2500000', null].map((rate) => [
          { ...db.version, basicRateCentavos: rate },
        ]),
        [{ ...db.version, effectiveFrom: '2025-02-30' }],
        [{ ...db.version, effectiveTo: '2025-01-01' }],
        [{ ...db.version, regularizationDate: '2024-12-31' }],
        [{ ...db.version, terminationDate: '2024-12-31' }],
        [db.version, db.version],
        [db.version, { ...db.version, id: randomUUID() }],
        [db.version, { ...db.version, id: randomUUID(), effectiveFrom: '2026-01-01' }],
        [{ ...db.version, employeeId: randomUUID() }],
        [{ ...db.version, organizationId: db.foreignOrg }],
        [{ ...db.version, unexpected: true }],
      ];
      for (const employmentVersions of invalid) {
        await assert.rejects(
          db.apply({
            ...db.payload,
            revision: 2,
            firstName: 'Must not persist',
            employmentVersions,
          }),
        );
        assert.deepEqual(await db.state(), before);
      }
      // Zero is a legitimate payroll rate; references and audit user can be explicitly null.
      await db.apply({
        ...db.payload,
        revision: 2,
        employmentVersions: [
          {
            ...db.version,
            basicRateCentavos: 0,
            departmentId: null,
            positionId: null,
            updatedBy: null,
          },
        ],
      });
      assert.equal((await db.state()).history.length, 1);
      assert.equal(
        (
          await db.runtime.query(
            'SELECT basic_rate_centavos::text AS rate FROM employment_versions WHERE id=$1',
            [db.version.id],
          )
        ).rows[0].rate,
        '0',
      );
      await db.noEcho();
    } finally {
      await db.close();
    }
  },
);

test(
  'employee inbox checks enrollment, identities and all employment dependencies without partial application',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await assert.rejects(db.apply(db.payload), /Employee dependency missing/);
      await assert.rejects(
        db.apply(db.payload, 'CREATE', { organization_id: db.foreignOrg }),
        /identity mismatch/,
      );
      await assert.rejects(
        db.apply({ ...db.payload, organizationId: db.foreignOrg }, 'CREATE', {
          organization_id: db.foreignOrg,
        }),
        /not enrolled/,
      );
      await assert.rejects(db.apply(db.payload, 'CREATE', { revision: 2 }), /identity mismatch/);
      await assert.rejects(
        db.apply(db.payload, 'CREATE', { payload_version: 2 }),
        /snapshot or version/,
      );
      const incomplete = { ...db.payload } as Record<string, unknown>;
      delete incomplete.middleName;
      await assert.rejects(db.apply(incomplete, 'CREATE'), /Incomplete/);
      assert.deepEqual(await db.state(), { employees: [], history: [] });
      await db.apply(db.payload, 'CREATE');
      const before = await db.state();
      const foreignDepartment = randomUUID();
      const foreignPosition = randomUUID();
      const foreignUser = randomUUID();
      await db.runtime.query(
        "INSERT INTO departments(id,organization_id,code,name) VALUES($1,$2,'F','Foreign')",
        [foreignDepartment, db.foreignOrg],
      );
      await db.runtime.query(
        "INSERT INTO positions(id,organization_id,code,name) VALUES($1,$2,'F','Foreign')",
        [foreignPosition, db.foreignOrg],
      );
      await db.runtime.query(
        `INSERT INTO auth_users(id,organization_id,username,display_name,password_hash)
         VALUES($1,$2,'foreign_auditor','Foreign auditor',$3)`,
        [foreignUser, db.foreignOrg, DUMMY_PASSWORD_HASH],
      );
      for (const version of [
        { ...db.version, departmentId: randomUUID() },
        { ...db.version, positionId: randomUUID() },
        { ...db.version, updatedBy: randomUUID() },
        { ...db.version, departmentId: foreignDepartment },
        { ...db.version, positionId: foreignPosition },
        { ...db.version, updatedBy: foreignUser },
        { ...db.version, departmentId: null },
      ]) {
        await assert.rejects(
          db.apply({
            ...db.payload,
            revision: 2,
            firstName: 'Rejected',
            employmentVersions: [version],
          }),
          /dependency missing|department mismatch/,
        );
        assert.deepEqual(await db.state(), before);
      }
      // A history UUID already owned by another employee must never be reassigned.
      const otherId = randomUUID();
      await db.apply(
        {
          ...db.payload,
          id: otherId,
          employeeNumber: 'EMP-002',
          employmentVersions: [{ ...db.version, employeeId: otherId }],
        },
        'CREATE',
      );
      const occupied = await db.state();
      await assert.rejects(
        db.apply({ ...db.payload, revision: 2, employmentVersions: [db.version] }),
        /belongs to another/,
      );
      assert.deepEqual(await db.state(), occupied);
      await db.noEcho();
    } finally {
      await db.close();
    }
  },
);

test(
  'employee inbox rolls back earlier employee and history writes when a later database insert fails',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await db.apply({ ...db.payload, employmentVersions: [db.version] }, 'CREATE');
      const before = await db.state();
      // Force a real PostgreSQL failure after the employee update and old-period closure.
      await db.migrator.query(`
        CREATE FUNCTION reject_test_history() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Injected history insert failure'; END $$;
        CREATE TRIGGER reject_test_history BEFORE INSERT ON employment_versions
        FOR EACH ROW EXECUTE FUNCTION reject_test_history();
      `);
      await assert.rejects(
        db.apply({
          ...db.payload,
          revision: 2,
          firstName: 'Rollback',
          employmentVersions: [
            { ...db.version, effectiveTo: '2026-01-01' },
            { ...db.version, id: randomUUID(), effectiveFrom: '2026-01-01' },
          ],
        }),
        /Injected history insert failure/,
      );
      assert.deepEqual(await db.state(), before);
      await db.noEcho();
    } finally {
      await db.close();
    }
  },
);
