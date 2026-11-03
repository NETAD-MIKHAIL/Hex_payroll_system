import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import {
  createLocalAttendanceProposalService,
  type LocalProposalContent,
  type LocalProposalDecision,
} from '../src/timekeeping/local-attendance-proposals.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';

async function fixture() {
  const db = await databaseFixture();
  try {
    await migrate(db.migrator, db.migrations);
    const org = randomUUID(),
      foreignOrg = randomUUID();
    const employeeId = randomUUID(),
      foreignEmployee = randomUUID();
    const authorId = randomUUID(),
      otherAuthor = randomUUID(),
      foreignAuthor = randomUUID(),
      viewerId = randomUUID();
    await db.runtime.query(
      "INSERT INTO organizations(id,legal_name) VALUES($1,'Proposal test'),($2,'Foreign')",
      [org, foreignOrg],
    );
    await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);
    await db.runtime.query(
      `INSERT INTO employees(id,organization_id,employee_number,first_name,last_name)
       VALUES($1,$2,'E1','Ana','Santos'),($3,$4,'E1','Foreign','Employee')`,
      [employeeId, org, foreignEmployee, foreignOrg],
    );
    for (const [id, organization, username] of [
      [authorId, org, 'proposal_author'],
      [otherAuthor, org, 'other_author'],
      [foreignAuthor, foreignOrg, 'foreign_author'],
      [viewerId, org, 'proposal_viewer'],
    ]) {
      await db.runtime.query(
        `INSERT INTO auth_users(id,organization_id,username,display_name,password_hash)
         VALUES($1,$2,$3,$3,$4)`,
        [id, organization, username, DUMMY_PASSWORD_HASH],
      );
      await db.runtime.query(
        'INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code=$2',
        [id, id === viewerId ? 'viewer' : 'administrator'],
      );
    }
    const actor = { id: authorId, organizationId: org };
    const service = createLocalAttendanceProposalService(db.runtime);
    const content: LocalProposalContent = {
      action: 'calculate',
      expectedCanonicalRevision: 0,
      evidenceFingerprint: 'a'.repeat(64),
      payload: {
        firstIn: '2026-01-01T00:00:00Z',
        lastOut: '2026-01-01T09:00:00Z',
        workedMinutes: 480,
        lateMinutes: 0,
        undertimeMinutes: 0,
        attendanceStatus: 'present',
        complete: true,
        flags: [],
      },
    };
    async function uuid7() {
      return (await db.runtime.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id;
    }
    async function draft() {
      return service.createDraft(actor, { employeeId, workDate: '2026-01-01', content });
    }
    async function attempted() {
      const row = await draft();
      const queued = await service.queue(actor, row.proposalId, row.localRevision);
      return service.beginAttempt(actor, queued.proposalId, queued.localRevision);
    }
    function decision(
      requestId: string,
      category: LocalProposalDecision['category'] = 'accepted',
    ): LocalProposalDecision {
      return {
        requestId,
        decisionId: randomUUID(),
        category,
        reason: {
          code: category.toUpperCase(),
          message: 'Test central decision',
          details: { source: 'fixture' },
        },
        canonicalAttendanceId: category === 'rejected' ? null : randomUUID(),
        acceptedRevision: category === 'accepted' ? 1 : null,
        currentRevision: category === 'accepted' ? 1 : category === 'conflicted' ? 2 : null,
        decidedAt: '2026-01-02T00:00:00.000Z',
      };
    }
    async function noSideEffects() {
      for (const table of [
        'sync_outbox',
        'attendance_records',
        'attendance_history',
        'attendance_adjustments',
        'attendance_processing_jobs',
        'time_records',
        'time_record_corrections',
        'biometric_ingestion_state',
      ]) {
        assert.equal(
          (await db.runtime.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count,
          0,
        );
      }
    }
    return {
      ...db,
      org,
      foreignOrg,
      employeeId,
      foreignEmployee,
      actor,
      authorId,
      otherAuthor,
      foreignAuthor,
      viewerId,
      service,
      content,
      uuid7,
      draft,
      attempted,
      decision,
      noSideEffects,
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}

test(
  'local proposals persist UUIDv7 identity, authored content and scoped read/list without attendance writes',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      const row = await db.draft();
      assert.equal(row.proposalId[14], '7');
      assert.equal(row.organizationId, db.org);
      assert.equal(row.employeeId, db.employeeId);
      assert.equal(row.authorUserId, db.authorId);
      assert.equal(row.workDate, '2026-01-01');
      assert.equal(row.action, 'calculate');
      assert.equal(row.expectedCanonicalRevision, 0);
      assert.equal(row.evidenceFingerprint, db.content.evidenceFingerprint);
      assert.deepEqual(row.proposedPayload, db.content.payload);
      assert.equal(row.status, 'draft');
      assert.equal(row.localRevision, 1);
      assert.equal(row.submittedAt, null);
      assert.equal(row.attemptId, null);
      assert.equal(row.attemptCount, 0);
      assert.equal(row.decisionCategory, null);
      assert.equal(row.createdAt, row.updatedAt);
      assert.deepEqual(await db.service.read(db.actor, row.proposalId), row);
      assert.deepEqual(
        await db.service.list(db.actor, { employeeId: db.employeeId, status: 'draft' }),
        [row],
      );
      assert.deepEqual(await db.service.list(db.actor, { employeeId: db.foreignEmployee }), []);
      for (const content of [
        {
          action: 'approve',
          expectedCanonicalRevision: 1,
          evidenceFingerprint: null,
          payload: { reason: null },
        },
        {
          action: 'reopen',
          expectedCanonicalRevision: 1,
          evidenceFingerprint: null,
          payload: { reason: 'New evidence arrived' },
        },
      ] as const) {
        const saved = await db.service.createDraft(db.actor, {
          employeeId: db.employeeId,
          workDate: '2026-01-01',
          content,
        });
        assert.equal(saved.action, content.action);
        assert.equal(saved.status, 'draft');
      }
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'local proposals enforce enrollment, current user permissions and organization-scoped employee and author references',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      const input = { employeeId: db.employeeId, workDate: '2026-01-01', content: db.content };
      await assert.rejects(
        db.service.createDraft(db.actor, { ...input, employeeId: db.foreignEmployee }),
        /Employee is not/,
      );
      await assert.rejects(
        db.service.createDraft(db.actor, { ...input, employeeId: randomUUID() }),
        /Employee is not/,
      );
      await assert.rejects(
        db.service.createDraft({ id: db.foreignAuthor, organizationId: db.org }, input),
        /User organization mismatch/,
      );
      await assert.rejects(
        db.service.createDraft({ id: db.foreignAuthor, organizationId: db.foreignOrg }, input),
        /not enrolled/,
      );
      await assert.rejects(
        db.service.createDraft({ id: randomUUID(), organizationId: db.org }, input),
        /Session invalid/,
      );
      // Caller-invented permission arrays cannot grant rights to a viewer.
      const forged = {
        id: db.viewerId,
        organizationId: db.org,
        permissions: ['attendance.manage'],
      };
      await assert.rejects(db.service.createDraft(forged, input), /Permission required/);
      await db.runtime.query('UPDATE auth_users SET active=false WHERE id=$1', [db.authorId]);
      await assert.rejects(db.service.createDraft(db.actor, input), /Session invalid/);
      await db.runtime.query('UPDATE auth_users SET active=true WHERE id=$1', [db.authorId]);
      // Database composite keys also reject foreign users even if the service is bypassed.
      await assert.rejects(
        db.runtime.query(
          `INSERT INTO local_attendance_proposals(organization_id,employee_id,work_date,action,
         author_user_id,expected_canonical_revision,proposed_payload,evidence_fingerprint)
         VALUES($1,$2,'2026-01-01','calculate',$3,0,$4,$5)`,
          [
            db.org,
            db.employeeId,
            db.foreignAuthor,
            JSON.stringify(db.content.payload),
            db.content.evidenceFingerprint,
          ],
        ),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, '23503');
          return true;
        },
      );
      assert.equal((await db.service.list(db.actor)).length, 0);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'proposal UUID replays compare JSON content and reject altered identity, author or content without mutation',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      const proposalId = await db.uuid7();
      const input = {
        proposalId,
        employeeId: db.employeeId,
        workDate: '2026-01-01',
        content: db.content,
      };
      const row = await db.service.createDraft(db.actor, input);
      const reordered = {
        ...db.content,
        payload: Object.fromEntries(Object.entries(db.content.payload).reverse()),
      } as LocalProposalContent;
      assert.deepEqual(
        await db.service.createDraft(db.actor, { ...input, content: reordered }),
        row,
      );
      for (const changed of [
        { ...input, workDate: '2026-01-02' },
        { ...input, content: { ...db.content, expectedCanonicalRevision: 1 } },
        { ...input, content: { ...db.content, evidenceFingerprint: 'b'.repeat(64) } },
      ])
        await assert.rejects(db.service.createDraft(db.actor, changed), /UUID reused/);
      await assert.rejects(
        db.service.createDraft({ id: db.otherAuthor, organizationId: db.org }, input),
        /UUID reused/,
      );
      assert.deepEqual(await db.service.read(db.actor, proposalId), row);
      // Replaying a creation request after queuing must not reset lifecycle or attempt data.
      const queued = await db.service.queue(db.actor, proposalId, 1);
      assert.deepEqual(await db.service.createDraft(db.actor, input), queued);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'proposal reads and transitions cannot cross organizations or edit another authors work',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      const row = await db.draft();
      const foreign = { id: db.foreignAuthor, organizationId: db.foreignOrg };
      await assert.rejects(db.service.read(foreign, row.proposalId), /not enrolled/);
      await assert.rejects(db.service.queue(foreign, row.proposalId, 1), /not enrolled/);
      await assert.rejects(
        db.service.queue({ id: db.otherAuthor, organizationId: db.org }, row.proposalId, 1),
        /original author/,
      );
      await assert.rejects(db.service.read(db.actor, await db.uuid7()), /not found/);
      assert.deepEqual(
        await db.service.read({ id: db.viewerId, organizationId: db.org }, row.proposalId),
        row,
      );
      assert.deepEqual(await db.service.read(db.actor, row.proposalId), row);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'draft edits require optimistic revisions and submitted content cannot change through service or SQL',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      const row = await db.draft();
      const edit: LocalProposalContent = {
        action: 'adjust',
        expectedCanonicalRevision: 5,
        evidenceFingerprint: null,
        payload: { reason: 'Correct reviewed minutes', overrides: { workedMinutes: 450 } },
      };
      const edited = await db.service.editDraft(db.actor, row.proposalId, 1, edit);
      assert.equal(edited.localRevision, 2);
      assert.equal(edited.action, 'adjust');
      assert.deepEqual(edited.proposedPayload, edit.payload);
      assert.equal(edited.authorUserId, row.authorUserId);
      await assert.rejects(
        db.service.editDraft(db.actor, row.proposalId, 1, db.content),
        /changed/,
      );
      await assert.rejects(db.service.queue(db.actor, row.proposalId, 1), /changed/);
      const queued = await db.service.queue(db.actor, row.proposalId, 2);
      assert.equal(queued.status, 'pending');
      assert.ok(queued.submittedAt);
      await assert.rejects(
        db.service.editDraft(db.actor, row.proposalId, 3, db.content),
        /Only a draft/,
      );
      await assert.rejects(db.service.queue(db.actor, row.proposalId, 3), /Only a draft/);
      await assert.rejects(
        db.runtime.query(
          `UPDATE local_attendance_proposals SET proposed_payload='{}',local_revision=local_revision+1 WHERE proposal_id=$1`,
          [row.proposalId],
        ),
        /Submitted proposal content is immutable/,
      );
      await assert.rejects(
        db.runtime.query(
          'UPDATE local_attendance_proposals SET author_user_id=$2,local_revision=local_revision+1 WHERE proposal_id=$1',
          [row.proposalId, db.otherAuthor],
        ),
        /identity and author are immutable/,
      );
      assert.deepEqual(await db.service.read(db.actor, row.proposalId), queued);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'uncertain requests retry with the same immutable request identity and fresh attempt tokens',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      const attempt = await db.attempted();
      assert.equal(attempt.status, 'pending');
      assert.equal(attempt.attemptCount, 1);
      assert.equal(attempt.attemptId![14], '7');
      assert.ok(attempt.lastAttemptAt);
      const error = {
        code: 'TIMEOUT',
        message: 'Acceptance unknown',
        details: { timeoutMs: 10000 },
      };
      const uncertain = await db.service.recordAttemptOutcome(
        db.actor,
        attempt.proposalId,
        attempt.localRevision,
        attempt.attemptId!,
        'uncertain',
        error,
      );
      assert.equal(uncertain.status, 'uncertain');
      assert.deepEqual(uncertain.lastError, error);
      const retry = await db.service.beginAttempt(
        db.actor,
        attempt.proposalId,
        uncertain.localRevision,
      );
      assert.equal(retry.attemptCount, 2);
      assert.notEqual(retry.attemptId, attempt.attemptId);
      assert.equal(retry.proposalId, attempt.proposalId);
      assert.deepEqual(retry.proposedPayload, attempt.proposedPayload);
      assert.equal(retry.submittedAt, attempt.submittedAt);
      assert.equal(retry.lastError, null);
      await assert.rejects(
        db.service.recordDecision(
          db.actor,
          retry.proposalId,
          retry.localRevision,
          attempt.attemptId!,
          db.decision(retry.proposalId),
        ),
        /Stale proposal attempt/,
      );
      const retryable = await db.service.recordAttemptOutcome(
        db.actor,
        retry.proposalId,
        retry.localRevision,
        retry.attemptId!,
        'retryable',
        { ...error, code: 'TEMPORARY_UNAVAILABLE' },
      );
      const third = await db.service.beginAttempt(
        db.actor,
        retry.proposalId,
        retryable.localRevision,
      );
      assert.equal(third.attemptCount, 3);
      assert.equal(third.proposalId, attempt.proposalId);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'uncertain-to-accepted decisions persist explicit central metadata and terminal replay is immutable',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      const row = await db.attempted();
      const uncertain = await db.service.recordAttemptOutcome(
        db.actor,
        row.proposalId,
        row.localRevision,
        row.attemptId!,
        'uncertain',
        { code: 'TIMEOUT', message: 'No response', details: {} },
      );
      const decision = db.decision(row.proposalId);
      const accepted = await db.service.recordDecision(
        db.actor,
        row.proposalId,
        uncertain.localRevision,
        row.attemptId!,
        decision,
      );
      assert.equal(accepted.status, 'accepted');
      assert.equal(accepted.decisionCategory, 'accepted');
      assert.deepEqual(accepted.decisionReason, decision.reason);
      assert.equal(accepted.serverDecisionId, decision.decisionId);
      assert.equal(accepted.decisionRequestId, row.proposalId);
      assert.equal(accepted.serverDecidedAt, decision.decidedAt);
      assert.equal(accepted.canonicalAttendanceId, decision.canonicalAttendanceId);
      assert.equal(accepted.acceptedCanonicalRevision, 1);
      assert.equal(accepted.currentCanonicalRevision, 1);
      assert.equal(accepted.authorUserId, row.authorUserId);
      assert.deepEqual(accepted.proposedPayload, row.proposedPayload);
      assert.deepEqual(
        await db.service.recordDecision(
          db.actor,
          row.proposalId,
          uncertain.localRevision,
          row.attemptId!,
          decision,
        ),
        accepted,
      );
      await assert.rejects(
        db.service.recordDecision(
          db.actor,
          row.proposalId,
          accepted.localRevision,
          row.attemptId!,
          db.decision(row.proposalId, 'rejected'),
        ),
        /Terminal decision conflict/,
      );
      await assert.rejects(
        db.service.recordAttemptOutcome(
          db.actor,
          row.proposalId,
          accepted.localRevision,
          row.attemptId!,
          'retryable',
          { code: 'LATE_TIMEOUT', message: 'Old network result', details: {} },
        ),
        /Terminal/,
      );
      await assert.rejects(
        db.runtime.query(
          `UPDATE local_attendance_proposals SET status='pending',local_revision=local_revision+1 WHERE proposal_id=$1`,
          [row.proposalId],
        ),
        /Terminal proposal decisions are immutable/,
      );
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'conflicted and rejected proposals retain original content, author and structured central reasons',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      for (const category of ['conflicted', 'rejected'] as const) {
        const row = await db.attempted();
        const decision = db.decision(row.proposalId, category);
        const saved = await db.service.recordDecision(
          db.actor,
          row.proposalId,
          row.localRevision,
          row.attemptId!,
          decision,
        );
        assert.equal(saved.status, category);
        assert.equal(saved.authorUserId, db.authorId);
        assert.deepEqual(saved.proposedPayload, row.proposedPayload);
        assert.deepEqual(saved.decisionReason, decision.reason);
        assert.equal(saved.currentCanonicalRevision, decision.currentRevision);
        assert.equal(saved.canonicalAttendanceId, decision.canonicalAttendanceId);
        assert.equal(saved.acceptedCanonicalRevision, null);
        await assert.rejects(
          db.service.beginAttempt(db.actor, row.proposalId, saved.localRevision),
          /Terminal/,
        );
      }
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'concurrent duplicate proposal creation and competing decisions have a single consistent outcome',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      const input = {
        proposalId: await db.uuid7(),
        employeeId: db.employeeId,
        workDate: '2026-01-01',
        content: db.content,
      };
      const same = await Promise.all([
        db.service.createDraft(db.actor, input),
        db.service.createDraft(db.actor, input),
      ]);
      assert.deepEqual(same[0], same[1]);
      assert.equal((await db.service.list(db.actor)).length, 1);
      const collisionId = await db.uuid7();
      const collision = await Promise.allSettled([
        db.service.createDraft(db.actor, { ...input, proposalId: collisionId }),
        db.service.createDraft(db.actor, {
          ...input,
          proposalId: collisionId,
          workDate: '2026-01-02',
        }),
      ]);
      assert.equal(collision.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(collision.filter((r) => r.status === 'rejected').length, 1);
      const row = await db.attempted();
      const accepted = db.decision(row.proposalId);
      const rejected = db.decision(row.proposalId, 'rejected');
      const competing = await Promise.allSettled([
        db.service.recordDecision(
          db.actor,
          row.proposalId,
          row.localRevision,
          row.attemptId!,
          accepted,
        ),
        db.service.recordDecision(
          db.actor,
          row.proposalId,
          row.localRevision,
          row.attemptId!,
          rejected,
        ),
      ]);
      assert.equal(competing.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(competing.filter((r) => r.status === 'rejected').length, 1);
      const saved = await db.service.read(db.actor, row.proposalId);
      assert.ok(['accepted', 'rejected'].includes(saved.status));
      assert.equal(saved.localRevision, row.localRevision + 1);
      assert.deepEqual(saved.proposedPayload, row.proposedPayload);
      const retryRow = await db.attempted();
      const sameDecision = db.decision(retryRow.proposalId);
      const replays = await Promise.all([
        db.service.recordDecision(
          db.actor,
          retryRow.proposalId,
          retryRow.localRevision,
          retryRow.attemptId!,
          sameDecision,
        ),
        db.service.recordDecision(
          db.actor,
          retryRow.proposalId,
          retryRow.localRevision,
          retryRow.attemptId!,
          sameDecision,
        ),
      ]);
      assert.deepEqual(replays[0], replays[1]);
      assert.equal(replays[0]!.localRevision, retryRow.localRevision + 1);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'invalid action payloads, lifecycle jumps and mismatched decisions cannot finalize proposals',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      const input = { employeeId: db.employeeId, workDate: '2026-01-01', content: db.content };
      for (const content of [
        { ...db.content, action: 'payroll' },
        { ...db.content, evidenceFingerprint: null },
        { ...db.content, expectedCanonicalRevision: -1 },
        { ...db.content, payload: { salary: 999 } },
        {
          action: 'adjust',
          expectedCanonicalRevision: 1,
          evidenceFingerprint: null,
          payload: { reason: 'Adjust', overrides: {} },
        },
        {
          action: 'approve',
          expectedCanonicalRevision: 0,
          evidenceFingerprint: null,
          payload: { reason: null },
        },
      ]) {
        await assert.rejects(
          db.service.createDraft(db.actor, { ...input, content } as Parameters<
            typeof db.service.createDraft
          >[1]),
        );
      }
      const row = await db.draft();
      await assert.rejects(
        db.service.beginAttempt(db.actor, row.proposalId, row.localRevision),
        /Queue the draft/,
      );
      await assert.rejects(
        db.service.recordDecision(
          db.actor,
          row.proposalId,
          row.localRevision,
          await db.uuid7(),
          db.decision(row.proposalId),
        ),
        /Stale proposal attempt/,
      );
      const queued = await db.service.queue(db.actor, row.proposalId, row.localRevision);
      const attempt = await db.service.beginAttempt(db.actor, row.proposalId, queued.localRevision);
      await assert.rejects(
        db.service.beginAttempt(db.actor, row.proposalId, attempt.localRevision),
        /previous attempt/,
      );
      await assert.rejects(
        db.service.recordDecision(
          db.actor,
          row.proposalId,
          attempt.localRevision,
          attempt.attemptId!,
          db.decision(await db.uuid7()),
        ),
        /request identity mismatch/,
      );
      await assert.rejects(
        db.service.recordDecision(
          db.actor,
          row.proposalId,
          attempt.localRevision,
          attempt.attemptId!,
          { ...db.decision(row.proposalId), acceptedRevision: 2, currentRevision: 2 },
        ),
        /base revision/,
      );
      assert.deepEqual(await db.service.read(db.actor, row.proposalId), attempt);
      await assert.rejects(
        db.runtime.query('DELETE FROM local_attendance_proposals WHERE proposal_id=$1', [
          row.proposalId,
        ]),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, '42501');
          return true;
        },
      );
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);
