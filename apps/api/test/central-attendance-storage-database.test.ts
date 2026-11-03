import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import '../src/db/types.js';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate, migrateCentral, readMigrations } from '../src/db/migrate.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';

const target = { mode: 'central' as const, expectedDatabase: 'hexpayroll_test' };
const tables = [
  'central_attendance_requests',
  'central_attendance_state',
  'central_attendance_decisions',
  'central_attendance_acceptance_history',
];
const reason = {
  code: 'STORAGE_FIXTURE',
  message: 'Explicit storage test decision',
  details: { test: true },
};

async function fixture() {
  const db = await databaseFixture();
  try {
    await migrate(db.migrator, db.migrations);
    const central = await readMigrations(
      fileURLToPath(new URL('../../../database/central-migrations/', import.meta.url)),
    );
    const org = randomUUID(),
      foreignOrg = randomUUID();
    const employee = randomUUID(),
      foreignEmployee = randomUUID();
    const author = randomUUID(),
      submitter = randomUUID(),
      foreignUser = randomUUID();
    const node = randomUUID(),
      foreignNode = randomUUID();
    await db.runtime.query(
      "INSERT INTO organizations(id,legal_name) VALUES($1,'Central storage'),($2,'Foreign')",
      [org, foreignOrg],
    );
    await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);
    await db.runtime.query(
      `INSERT INTO employees(id,organization_id,employee_number,first_name,last_name)
       VALUES($1,$2,'E1','Ana','Santos'),($3,$4,'E1','Foreign','Employee')`,
      [employee, org, foreignEmployee, foreignOrg],
    );
    for (const [id, organization, username] of [
      [author, org, 'central_author'],
      [submitter, org, 'central_submitter'],
      [foreignUser, foreignOrg, 'foreign_user'],
    ]) {
      await db.runtime.query(
        `INSERT INTO auth_users(id,organization_id,username,display_name,password_hash)
         VALUES($1,$2,$3,$3,$4)`,
        [id, organization, username, DUMMY_PASSWORD_HASH],
      );
    }
    await db.runtime.query(
      "INSERT INTO sync_nodes(id,organization_id,device_name) VALUES($1,$2,'Laptop'),($3,$4,'Foreign')",
      [node, org, foreignNode, foreignOrg],
    );
    async function uuid7() {
      return (await db.migrator.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id;
    }
    async function install() {
      return migrateCentral(db.migrator, central, db.migrations, target);
    }
    async function request(overrides: Record<string, unknown> = {}) {
      const value = {
        proposalId: await uuid7(),
        organizationId: org,
        employeeId: employee,
        workDate: '2026-01-01',
        action: 'calculate',
        authorUserId: author,
        submitterUserId: submitter,
        sourceNodeId: node,
        expectedRevision: 0,
        payload: { workedMinutes: 480, attendanceStatus: 'present', complete: true, flags: [] },
        fingerprint: 'a'.repeat(64),
        ...overrides,
      };
      return (
        await db.migrator.query(
          `INSERT INTO central_attendance_requests(proposal_id,organization_id,employee_id,work_date,action,
           author_user_id,first_submitter_user_id,first_source_node_id,expected_canonical_revision,
           proposed_payload,evidence_fingerprint)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [
            value.proposalId,
            value.organizationId,
            value.employeeId,
            value.workDate,
            value.action,
            value.authorUserId,
            value.submitterUserId,
            value.sourceNodeId,
            value.expectedRevision,
            JSON.stringify(value.payload),
            value.fingerprint,
          ],
        )
      ).rows[0];
    }
    type Request = Awaited<ReturnType<typeof request>>;
    // These helpers deliberately write explicit fixture decisions with the schema owner.
    // They are not a repository/authorization layer and are never imported by runtime code.
    async function decision(
      client: PoolClient,
      req: Request,
      values: {
        id: string;
        category: string;
        canonicalId?: string | null;
        resultingRevision?: number | null;
        currentRevision?: number | null;
        duplicateOf?: string | null;
        actor?: string;
        sourceNode?: string;
      },
    ) {
      await client.query(
        `INSERT INTO central_attendance_decisions(decision_id,organization_id,proposal_id,employee_id,
          work_date,action,expected_canonical_revision,category,reason,canonical_attendance_id,
          resulting_revision,current_revision,actor_user_id,source_node_id,duplicate_of_decision_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          values.id,
          req.organization_id,
          req.proposal_id,
          req.employee_id,
          req.work_date,
          req.action,
          req.expected_canonical_revision,
          values.category,
          JSON.stringify(reason),
          values.canonicalId ?? null,
          values.resultingRevision ?? null,
          values.currentRevision ?? null,
          values.actor ?? submitter,
          values.sourceNode ?? node,
          values.duplicateOf ?? null,
        ],
      );
    }
    async function accept(
      req: Request,
      canonicalId: string,
      overrides: {
        revision?: number;
        approval?: string;
        approvedBy?: string | null;
        actor?: string;
        update?: boolean;
        changedId?: string;
        sourceNode?: string;
      } = {},
    ) {
      const client = await db.migrator.connect();
      const decisionId = await uuid7();
      const revision = Number(req.expected_canonical_revision) + 1;
      try {
        await client.query('BEGIN');
        await decision(client, req, {
          id: decisionId,
          category: 'accepted',
          canonicalId,
          resultingRevision: revision,
          currentRevision: revision,
          actor: overrides.actor,
          sourceNode: overrides.sourceNode,
        });
        const values = [
          overrides.changedId ?? canonicalId,
          req.organization_id,
          req.employee_id,
          req.work_date,
          overrides.revision ?? revision,
          JSON.stringify({ workedMinutes: 480, complete: true, flags: [] }),
          req.proposal_id,
          decisionId,
          overrides.actor ?? submitter,
          overrides.approval ?? 'unreviewed',
          overrides.approvedBy ?? null,
        ];
        if (overrides.update) {
          await client.query(
            `UPDATE central_attendance_state SET canonical_attendance_id=$1,organization_id=$2,
             employee_id=$3,work_date=$4,canonical_revision=$5,result=$6,last_proposal_id=$7,
             last_decision_id=$8,updated_by=$9,approval_status=$10,approved_by=$11,
             approved_at=CASE WHEN $10='approved' THEN now() ELSE NULL END
             WHERE canonical_attendance_id=$12`,
            [...values, canonicalId],
          );
        } else {
          await client.query(
            `INSERT INTO central_attendance_state(canonical_attendance_id,organization_id,employee_id,work_date,
              canonical_revision,result,last_proposal_id,last_decision_id,updated_by,approval_status,approved_by,
              approved_at,worked_minutes,late_minutes,undertime_minutes,attendance_status,
              accepted_evidence_fingerprint,processor_version)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               CASE WHEN $10='approved' THEN now() ELSE NULL END,480,0,0,'present',$12,1)`,
            [...values, 'a'.repeat(64)],
          );
        }
        await client.query('COMMIT');
        return decisionId;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    async function observe(req: Request, values: Parameters<typeof decision>[2]) {
      const client = await db.migrator.connect();
      try {
        await client.query('BEGIN');
        await decision(client, req, values);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    async function rows(table: string) {
      assert.ok(tables.includes(table));
      return (await db.migrator.query(`SELECT * FROM ${table}`)).rows;
    }
    async function noSideEffects() {
      for (const table of [
        'sync_changes',
        'sync_outbox',
        'attendance_records',
        'attendance_history',
        'attendance_adjustments',
        'attendance_processing_jobs',
        'local_attendance_proposals',
      ]) {
        assert.equal(
          (await db.runtime.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count,
          0,
        );
      }
    }
    return {
      ...db,
      central,
      org,
      foreignOrg,
      employee,
      foreignEmployee,
      author,
      submitter,
      foreignUser,
      node,
      foreignNode,
      uuid7,
      install,
      request,
      decision,
      accept,
      observe,
      rows,
      noSideEffects,
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}
const sqlCode = (code: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, code);
  return true;
};

test(
  'canonical storage is central-only, has independent replay-safe migration history and no runtime writers',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      for (const table of tables) {
        assert.equal(
          (await db.migrator.query('SELECT to_regclass($1) IS NULL AS absent', [table])).rows[0]
            .absent,
          true,
        );
      }
      const shared = (await db.migrator.query('SELECT * FROM schema_migrations ORDER BY name'))
        .rows;
      assert.deepEqual(
        await db.install(),
        db.central.map((m) => m.name),
      );
      assert.deepEqual(await db.install(), []);
      assert.deepEqual(await migrate(db.migrator, db.migrations), []);
      assert.deepEqual(
        (await db.migrator.query('SELECT * FROM schema_migrations ORDER BY name')).rows,
        shared,
      );
      assert.deepEqual(
        (await db.migrator.query('SELECT name FROM central_schema_migrations ORDER BY name')).rows,
        db.central.map((m) => ({ name: m.name })),
      );
      for (const table of tables) {
        const permissions = (
          await db.runtime.query(
            `SELECT has_table_privilege(current_user,$1,'SELECT') AS read,
           has_table_privilege(current_user,$1,'INSERT') AS insert,
           has_table_privilege(current_user,$1,'UPDATE') AS update,
           has_table_privilege(current_user,$1,'DELETE') AS delete,
           has_table_privilege(current_user,$1,'TRUNCATE') AS truncate`,
            [table],
          )
        ).rows[0];
        assert.deepEqual(permissions, {
          read: true,
          insert: false,
          update: false,
          delete: false,
          truncate: false,
        });
        await assert.rejects(
          db.runtime.query(`INSERT INTO ${table} DEFAULT VALUES`),
          sqlCode('42501'),
        );
      }
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'explicit accepted decisions retain a stable canonical UUID, contiguous revisions and complete audit snapshots',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await db.install();
      const canonicalId = await db.uuid7();
      const first = await db.request();
      const firstDecision = await db.accept(first, canonicalId);
      const before = (await db.rows('central_attendance_state'))[0];
      const next = await db.request({
        action: 'approve',
        expectedRevision: 1,
        fingerprint: null,
        payload: { reason: null },
      });
      const nextDecision = await db.accept(next, canonicalId, {
        update: true,
        approval: 'approved',
        approvedBy: db.submitter,
      });
      const saved = (await db.rows('central_attendance_state'))[0];
      assert.equal(saved.canonical_attendance_id, canonicalId);
      assert.equal(saved.organization_id, db.org);
      assert.equal(saved.employee_id, db.employee);
      assert.equal(saved.work_date, '2026-01-01');
      assert.equal(saved.canonical_revision, 2);
      assert.equal(saved.approval_status, 'approved');
      assert.equal(saved.approved_by, db.submitter);
      assert.ok(saved.approved_at);
      assert.equal(saved.updated_by, db.submitter);
      assert.equal(saved.last_proposal_id, next.proposal_id);
      assert.equal(saved.last_decision_id, nextDecision);
      assert.deepEqual(saved.created_at, before.created_at);
      assert.equal(saved.accepted_evidence_fingerprint, 'a'.repeat(64));
      const history = (await db.rows('central_attendance_acceptance_history')).sort(
        (a, b) => a.new_revision - b.new_revision,
      );
      assert.deepEqual(
        history.map((r) => [r.old_revision, r.new_revision, r.action, r.decision_id]),
        [
          [0, 1, 'calculate', firstDecision],
          [1, 2, 'approve', nextDecision],
        ],
      );
      assert.equal(history[0].old_state, null);
      assert.deepEqual(history[0].new_state, history[1].old_state);
      assert.equal(history[1].new_state.canonical_revision, 2);
      assert.equal(history[1].new_state.last_proposal_id, next.proposal_id);
      assert.equal(history[1].actor_user_id, db.submitter);
      // A replay of revision 1 remains a duplicate acceptance after revision 2 exists.
      await db.observe(first, {
        id: await db.uuid7(),
        category: 'duplicate_accepted',
        canonicalId,
        resultingRevision: 1,
        currentRevision: 2,
        duplicateOf: firstDecision,
      });
      assert.equal((await db.rows('central_attendance_acceptance_history')).length, 2);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'canonical employee/date uniqueness serializes competing creates without two accepted results',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await db.install();
      const requests = await Promise.all([db.request(), db.request()]);
      const ids = await Promise.all([db.uuid7(), db.uuid7()]);
      const result = await Promise.allSettled(requests.map((r, i) => db.accept(r, ids[i]!)));
      assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
      const failure = result.find((r) => r.status === 'rejected');
      assert.ok(failure && failure.status === 'rejected');
      sqlCode('23505')(failure.reason);
      assert.equal((await db.rows('central_attendance_state')).length, 1);
      assert.equal((await db.rows('central_attendance_decisions')).length, 1);
      assert.equal((await db.rows('central_attendance_acceptance_history')).length, 1);
      assert.equal((await db.rows('central_attendance_requests')).length, 2);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'canonical revisions cannot start above one, skip, regress or change the stable identity',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await db.install();
      const canonicalId = await db.uuid7();
      const first = await db.request();
      await assert.rejects(db.accept(first, canonicalId, { revision: 2 }), /start at revision 1/);
      assert.equal((await db.rows('central_attendance_decisions')).length, 0);
      await db.accept(first, canonicalId);
      const before = (await db.rows('central_attendance_state'))[0];
      for (const [expectedRevision, writtenRevision] of [
        [1, 1],
        [1, 3],
        [2, 3],
      ]) {
        const req = await db.request({ expectedRevision });
        await assert.rejects(
          db.accept(req, canonicalId, { update: true, revision: writtenRevision }),
          /revision must advance once/,
        );
      }
      const next = await db.request({ expectedRevision: 1 });
      await assert.rejects(
        db.accept(next, canonicalId, { update: true, approval: 'approved' }),
        sqlCode('23514'),
      );
      await assert.rejects(
        db.accept(next, canonicalId, { update: true, changedId: await db.uuid7() }),
        /identity is immutable/,
      );
      assert.deepEqual((await db.rows('central_attendance_state'))[0], before);
      assert.equal((await db.rows('central_attendance_acceptance_history')).length, 1);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'request UUIDs and computed payload fingerprints are immutable and cannot be reused for changed proposals',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await db.install();
      const first = await db.request();
      assert.match(first.request_fingerprint, /^[0-9a-f]{64}$/);
      assert.equal(first.author_user_id, db.author);
      assert.equal(first.first_submitter_user_id, db.submitter);
      assert.equal(first.first_source_node_id, db.node);
      for (const overrides of [
        {},
        { payload: { changed: true } },
        { expectedRevision: 1 },
        { workDate: '2026-01-02' },
      ]) {
        await assert.rejects(
          db.request({ proposalId: first.proposal_id, ...overrides }),
          sqlCode('23505'),
        );
      }
      await assert.rejects(
        db.migrator.query(
          "UPDATE central_attendance_requests SET proposed_payload='{}' WHERE proposal_id=$1",
          [first.proposal_id],
        ),
        /append-only/,
      );
      const after = await db.rows('central_attendance_requests');
      assert.deepEqual(after, [first]);
      assert.equal((await db.rows('central_attendance_state')).length, 0);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'retryable observations, terminal conflicts/rejections and duplicate acceptance remain distinct and preserved',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await db.install();
      const req = await db.request();
      await db.observe(req, { id: await db.uuid7(), category: 'retryable' });
      assert.equal((await db.rows('central_attendance_state')).length, 0);
      const canonicalId = await db.uuid7();
      const acceptedId = await db.accept(req, canonicalId);
      await db.observe(req, {
        id: await db.uuid7(),
        category: 'duplicate_accepted',
        canonicalId,
        resultingRevision: 1,
        currentRevision: 1,
        duplicateOf: acceptedId,
      });
      const conflict = await db.request({ expectedRevision: 0, payload: { competing: true } });
      await db.observe(conflict, {
        id: await db.uuid7(),
        category: 'conflict',
        canonicalId,
        currentRevision: 1,
      });
      const rejected = await db.request({
        workDate: '2026-01-02',
        payload: { retained: 'invalid proposal' },
      });
      await db.observe(rejected, {
        id: await db.uuid7(),
        category: 'rejected',
        currentRevision: 0,
      });
      await assert.rejects(
        db.observe(conflict, { id: await db.uuid7(), category: 'rejected', currentRevision: 0 }),
        sqlCode('23505'),
      );
      await assert.rejects(
        db.observe(rejected, {
          id: await db.uuid7(),
          category: 'duplicate_accepted',
          canonicalId,
          resultingRevision: 1,
          currentRevision: 1,
          duplicateOf: acceptedId,
        }),
        sqlCode('23503'),
      );
      const decisions = await db.rows('central_attendance_decisions');
      assert.deepEqual(decisions.map((r) => r.category).sort(), [
        'accepted',
        'conflict',
        'duplicate_accepted',
        'rejected',
        'retryable',
      ]);
      for (const row of decisions) assert.deepEqual(row.reason, reason);
      assert.deepEqual(
        (await db.rows('central_attendance_requests')).find(
          (r) => r.proposal_id === rejected.proposal_id,
        ).proposed_payload,
        { retained: 'invalid proposal' },
      );
      assert.equal((await db.rows('central_attendance_acceptance_history')).length, 1);
      assert.equal((await db.rows('central_attendance_state'))[0].canonical_revision, 1);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'organization-scoped employee, author, submitter, node and canonical decision links cannot cross tenants',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await db.install();
      for (const overrides of [
        { employeeId: db.foreignEmployee },
        { authorUserId: db.foreignUser },
        { submitterUserId: db.foreignUser },
        { sourceNodeId: db.foreignNode },
      ]) {
        await assert.rejects(db.request(overrides), sqlCode('23503'));
      }
      const req = await db.request();
      for (const values of [{ actor: db.foreignUser }, { sourceNode: db.foreignNode }]) {
        await assert.rejects(
          db.observe(req, { id: await db.uuid7(), category: 'rejected', ...values }),
          sqlCode('23503'),
        );
      }
      const foreign = await db.request({
        organizationId: db.foreignOrg,
        employeeId: db.foreignEmployee,
        authorUserId: db.foreignUser,
        submitterUserId: db.foreignUser,
        sourceNodeId: db.foreignNode,
      });
      const foreignCanonical = await db.uuid7();
      await db.accept(foreign, foreignCanonical, {
        actor: db.foreignUser,
        sourceNode: db.foreignNode,
      });
      // A canonical UUID must exist and belong to the same employee/date/organization.
      await assert.rejects(
        db.observe(req, {
          id: await db.uuid7(),
          category: 'conflict',
          canonicalId: foreignCanonical,
          currentRevision: 1,
        }),
        sqlCode('23503'),
      );
      const canonicalId = await db.uuid7();
      await db.accept(req, canonicalId);
      const approve = await db.request({
        action: 'approve',
        expectedRevision: 1,
        fingerprint: null,
      });
      await assert.rejects(
        db.accept(approve, canonicalId, {
          update: true,
          approval: 'approved',
          approvedBy: db.foreignUser,
        }),
        sqlCode('23503'),
      );
      const otherDate = await db.request({ workDate: '2026-01-02' });
      await assert.rejects(
        db.observe(otherDate, {
          id: await db.uuid7(),
          category: 'conflict',
          canonicalId,
          currentRevision: 1,
        }),
        sqlCode('23503'),
      );
      assert.equal((await db.rows('central_attendance_state')).length, 2);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'decisions and acceptance history are append-only and incomplete acceptance transactions roll back',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await db.install();
      const req = await db.request();
      const canonicalId = await db.uuid7();
      const acceptedId = await db.accept(req, canonicalId);
      const before = await db.rows('central_attendance_state');
      const history = await db.rows('central_attendance_acceptance_history');
      for (const table of [
        'central_attendance_decisions',
        'central_attendance_acceptance_history',
      ]) {
        for (const sql of [
          `DELETE FROM ${table}`,
          `UPDATE ${table} SET organization_id=organization_id`,
        ]) {
          await assert.rejects(db.migrator.query(sql), /append-only/);
        }
      }
      await assert.rejects(
        db.migrator.query('DELETE FROM central_attendance_state'),
        /append-only/,
      );
      await assert.rejects(
        db.migrator.query(
          `INSERT INTO central_attendance_acceptance_history SELECT * FROM central_attendance_acceptance_history`,
        ),
        /generated only/,
      );
      const orphan = await db.request({ expectedRevision: 1 });
      // A decision claiming revision 2 cannot commit without the matching state change/history.
      await assert.rejects(
        db.observe(orphan, {
          id: await db.uuid7(),
          category: 'accepted',
          canonicalId,
          resultingRevision: 2,
          currentRevision: 2,
        }),
        sqlCode('23503'),
      );
      await assert.rejects(
        db.migrator.query(
          'UPDATE central_attendance_state SET canonical_revision=2 WHERE canonical_attendance_id=$1',
          [canonicalId],
        ),
        /matching explicit accepted decision/,
      );
      assert.deepEqual(await db.rows('central_attendance_state'), before);
      assert.deepEqual(await db.rows('central_attendance_acceptance_history'), history);
      assert.equal((await db.rows('central_attendance_decisions'))[0].decision_id, acceptedId);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);
