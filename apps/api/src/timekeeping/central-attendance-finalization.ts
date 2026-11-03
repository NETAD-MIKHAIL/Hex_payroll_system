import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { canonicalSyncJson, isoDateSchema } from '@hexpayroll/shared';
import { DomainError, transaction } from '../foundation/repository.js';
import {
  authorizeCentralUser,
  centralCredentialsSchema,
  type AttendanceAuthorizationCredentials,
} from './central-attendance-authorization.js';
import { verifyAttendanceWriter } from './central-attendance-writer.js';
import {
  buildAttendanceSourceSnapshot,
  type PeriodIdentity,
} from './attendance-source-snapshot.js';
import { digest } from './source-period-protocol.js';
import { tokenHash } from '../auth/service.js';

const uuid7 = z.uuid().refine((v) => v[14] === '7', 'UUIDv7 required');
const revision = z.number().int().nonnegative().max(2147483645);
const reason = z.string().trim().min(1).max(2000);
const certifySchema = z
  .object({
    requestId: z.uuid(),
    organizationId: z.uuid(),
    employeeId: z.uuid(),
    workDate: isoDateSchema,
    expectedRevision: revision,
    reason: reason.optional(),
  })
  .strict();
const resolutionSchema = z
  .object({
    requestId: z.uuid(),
    certificationId: z.uuid(),
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    policyRevision: z.number().int().positive(),
    decision: z.enum(['hold', 'reject', 'authorize_limited']),
    reason,
    artifacts: z
      .array(
        z
          .object({
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            reference: z.string().trim().min(1).max(500),
            kind: z.enum(['device_export', 'independent_attestation']),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
const proposalSchema = z
  .object({
    proposalId: uuid7,
    certificationId: z.uuid(),
    exceptionResolutionId: z.uuid().nullable().default(null),
    expectedCanonicalRevision: revision,
    reason: reason.optional(),
  })
  .strict();
const finalizeSchema = z.object({ requestId: uuid7, proposalId: uuid7, reason }).strict();
const reopenSchema = z
  .object({
    requestId: uuid7,
    organizationId: z.uuid(),
    employeeId: z.uuid(),
    workDate: isoDateSchema,
    expectedCanonicalRevision: revision.refine((v) => v > 0),
    reason,
  })
  .strict();
const fail = (code: string, message: string): never => {
  throw new DomainError(409, code, message);
};
const same = (a: unknown, b: unknown) => canonicalSyncJson(a) === canonicalSyncJson(b);
const period = (r: {
  organization_id: string;
  employee_id: string;
  work_date_text: string;
}): PeriodIdentity => ({
  organizationId: r.organization_id,
  employeeId: r.employee_id,
  workDate: r.work_date_text,
});
const lock = async (c: PoolClient, p: PeriodIdentity) => {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `canonical-attendance:${p.organizationId}:${p.employeeId}:${p.workDate}`,
  ]);
};
async function publish(c: PoolClient, decisionId: string) {
  const h = (
    await c.query('SELECT * FROM central_attendance_acceptance_history WHERE decision_id=$1', [
      decisionId,
    ])
  ).rows[0];
  const snapshot = canonicalSyncJson(h.new_state);
  await c.query(
    `INSERT INTO central_attendance_events(organization_id,canonical_id,canonical_revision,decision_id,snapshot,fingerprint) VALUES($1,$2,$3,$4,$5,$6)`,
    [
      h.organization_id,
      h.canonical_attendance_id,
      h.new_revision,
      decisionId,
      snapshot,
      digest(h.new_state),
    ],
  );
  return h.new_state;
}
async function insertRequest(
  c: PoolClient,
  params: {
    id: string;
    p: PeriodIdentity;
    action: string;
    author: string;
    node: string;
    expected: number;
    payload: unknown;
    fingerprint: string;
  },
) {
  const { id, p, action, author, node, expected, payload, fingerprint } = params;
  await c.query(
    `INSERT INTO central_attendance_requests(proposal_id,organization_id,employee_id,work_date,action,author_user_id,first_submitter_user_id,first_source_node_id,expected_canonical_revision,proposed_payload,evidence_fingerprint)
    VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10)`,
    [
      id,
      p.organizationId,
      p.employeeId,
      p.workDate,
      action,
      author,
      node,
      expected,
      canonicalSyncJson(payload),
      fingerprint,
    ],
  );
}
async function acceptedDecision(
  c: PoolClient,
  request: Record<string, unknown>,
  actor: string,
  node: string,
  canonicalId: string,
) {
  return (
    await c.query<{ decision_id: string }>(
      `INSERT INTO central_attendance_decisions(organization_id,proposal_id,employee_id,work_date,action,expected_canonical_revision,category,reason,canonical_attendance_id,resulting_revision,current_revision,actor_user_id,source_node_id)
    VALUES($1,$2,$3,$4,$5,$6,'accepted',$7,$8,$6+1,$6+1,$9,$10) RETURNING decision_id`,
      [
        request.organization_id,
        request.proposal_id,
        request.employee_id,
        request.work_date,
        request.action,
        request.expected_canonical_revision,
        JSON.stringify({
          code: 'CENTRAL_ACCEPTED',
          message: 'Authenticated central attendance acceptance',
          details: {},
        }),
        canonicalId,
        actor,
        node,
      ],
    )
  ).rows[0]!.decision_id;
}
async function writeState(
  c: PoolClient,
  request: Record<string, unknown>,
  canonicalId: string,
  decisionId: string,
  actor: string,
  result: Record<string, unknown>,
  approved: boolean,
) {
  const base = Number(request.expected_canonical_revision);
  const values = [
    canonicalId,
    request.organization_id,
    request.employee_id,
    request.work_date,
    base + 1,
    result.firstIn,
    result.lastOut,
    result.workedMinutes,
    result.lateMinutes,
    result.undertimeMinutes,
    result.attendanceStatus,
    approved ? 'approved' : 'unreviewed',
    JSON.stringify(result),
    request.evidence_fingerprint,
    result.processorVersion,
    approved ? actor : null,
    approved ? (await c.query('SELECT clock_timestamp()::text instant')).rows[0].instant : null,
    request.proposal_id,
    decisionId,
    actor,
  ];
  if (base === 0)
    await c.query(
      `INSERT INTO central_attendance_state(canonical_attendance_id,organization_id,employee_id,work_date,canonical_revision,first_in,last_out,worked_minutes,late_minutes,undertime_minutes,attendance_status,approval_status,result,accepted_evidence_fingerprint,processor_version,approved_by,approved_at,last_proposal_id,last_decision_id,updated_by)
    VALUES(${values.map((_, i) => '$' + (i + 1)).join(',')})`,
      values,
    );
  else {
    const columns = [
      'canonical_attendance_id',
      'organization_id',
      'employee_id',
      'work_date',
      'canonical_revision',
      'first_in',
      'last_out',
      'worked_minutes',
      'late_minutes',
      'undertime_minutes',
      'attendance_status',
      'approval_status',
      'result',
      'accepted_evidence_fingerprint',
      'processor_version',
      'approved_by',
      'approved_at',
      'last_proposal_id',
      'last_decision_id',
      'updated_by',
    ];
    const updated = await c.query(
      `UPDATE central_attendance_state SET ${columns.map((n, i) => n + '=$' + (i + 1)).join(',')} WHERE canonical_attendance_id=$1 AND canonical_revision=$21`,
      [...values, base],
    );
    if (!updated.rowCount) fail('CANONICAL_REVISION_MISMATCH', 'Canonical attendance changed');
  }
  return publish(c, decisionId);
}

export function createCentralAttendanceFinalizationService(
  writerPool: Pool,
  mode: 'local' | 'central',
  enabled = false,
) {
  function run<T>(
    credentials: AttendanceAuthorizationCredentials,
    work: (c: PoolClient, auth: AttendanceAuthorizationCredentials) => Promise<T>,
  ) {
    if (mode !== 'central' || !enabled)
      throw new DomainError(403, 'DISABLED', 'Central attendance finalization is disabled');
    const auth = centralCredentialsSchema.parse(credentials);
    return transaction(writerPool, async (c) => {
      await verifyAttendanceWriter(c);
      const result = await work(c, auth);
      // Authorization locks survive the transaction, but wall-clock expiry can
      // occur during a lock wait or calculation. Recheck immediately before commit.
      if (
        !(
          await c.query(
            'SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND expires_at>clock_timestamp()',
            [tokenHash(auth.sessionToken)],
          )
        ).rowCount
      )
        throw new DomainError(401, 'SESSION_INVALID', 'User session invalid');
      return result;
    });
  }
  async function certification(c: PoolClient, id: string) {
    const row = (
      await c.query(
        'SELECT *,work_date::text work_date_text FROM central_attendance_certifications WHERE id=$1',
        [id],
      )
    ).rows[0];
    if (!row) fail('CERTIFICATION_MISSING', 'Source certification is required');
    return row;
  }
  async function ensureReady(
    c: PoolClient,
    cert: Awaited<ReturnType<typeof certification>>,
    resolutionId: string | null,
  ) {
    const current = await buildAttendanceSourceSnapshot(c, period(cert));
    if (current.fingerprint !== cert.fingerprint)
      fail('STALE_EVIDENCE', 'Source evidence changed; recertify and propose again');
    let exception: Record<string, unknown> | null = null;
    if (current.blockers.length) {
      if (!current.blockers.every((code) => code.startsWith('SOURCE_UNSUPPORTED:')))
        fail(
          'INCOMPLETE_SOURCE_EVIDENCE',
          'Missing, conflicting or unverified source evidence cannot be finalized',
        );
      const resolution = (
        await c.query(
          'SELECT * FROM central_attendance_exception_resolutions WHERE id=$1 AND certification_id=$2',
          [resolutionId, cert.id],
        )
      ).rows[0];
      if (!resolution || resolution.decision !== 'authorize_limited')
        fail('EXCEPTION_UNRESOLVED', 'Unsupported source requires separately authorized exception');
      if (!current.snapshot.policy?.allow_limited)
        fail('EXCEPTION_POLICY_DENIED', 'Limited attendance finalization is prohibited');
      exception = {
        id: resolution.id,
        operatorId: resolution.operator_id,
        limitations: resolution.limitations,
        request: resolution.request,
      };
    } else if (resolutionId)
      fail('INVALID_EXCEPTION', 'Verified source does not require exception authorization');
    return { current, exception };
  }
  return {
    certify(credentials: AttendanceAuthorizationCredentials, input: unknown) {
      const cmd = certifySchema.parse(input);
      return run(credentials, async (c, auth) => {
        const actor = await authorizeCentralUser(c, auth, cmd.organizationId, 'attendance.manage');
        await lock(c, cmd);
        const existing = (
          await c.query('SELECT * FROM central_attendance_certifications WHERE id=$1', [
            cmd.requestId,
          ])
        ).rows[0];
        if (existing) {
          if (!same(existing.request, cmd) || existing.operator_id !== actor.submitterUserId)
            fail('CONFLICT', 'Certification identity reused');
          return existing;
        }
        const previous = (
          await c.query(
            'SELECT COALESCE(max(revision),0)::int revision FROM central_attendance_certifications WHERE organization_id=$1 AND employee_id=$2 AND work_date=$3',
            [cmd.organizationId, cmd.employeeId, cmd.workDate],
          )
        ).rows[0].revision;
        if (previous !== cmd.expectedRevision)
          fail('CERTIFICATION_REVISION_MISMATCH', 'Certification revision changed');
        const built = await buildAttendanceSourceSnapshot(c, cmd);
        return (
          await c.query(
            `INSERT INTO central_attendance_certifications(id,organization_id,employee_id,work_date,revision,operator_id,node_id,request,snapshot,fingerprint,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            [
              cmd.requestId,
              cmd.organizationId,
              cmd.employeeId,
              cmd.workDate,
              previous + 1,
              actor.submitterUserId,
              actor.nodeId,
              JSON.stringify(cmd),
              JSON.stringify(built.snapshot),
              built.fingerprint,
              built.blockers.length ? 'unresolved' : 'verified',
            ],
          )
        ).rows[0];
      });
    },
    resolveException(credentials: AttendanceAuthorizationCredentials, input: unknown) {
      const cmd = resolutionSchema.parse(input);
      return run(credentials, async (c, auth) => {
        const cert = await certification(c, cmd.certificationId),
          p = period(cert);
        const actor = await authorizeCentralUser(c, auth, p.organizationId, 'attendance.adjust');
        await authorizeCentralUser(c, auth, p.organizationId, 'attendance.approve');
        await lock(c, p);
        const existing = (
          await c.query('SELECT * FROM central_attendance_exception_resolutions WHERE id=$1', [
            cmd.requestId,
          ])
        ).rows[0];
        if (existing) {
          if (!same(existing.request, cmd) || existing.operator_id !== actor.submitterUserId)
            fail('CONFLICT', 'Exception request identity reused');
          return existing;
        }
        const built = await buildAttendanceSourceSnapshot(c, p);
        if (cmd.expectedFingerprint !== cert.fingerprint || built.fingerprint !== cert.fingerprint)
          fail('STALE_EVIDENCE', 'Exception evidence changed');
        const policy = built.snapshot.policy;
        if (!policy || policy.revision !== cmd.policyRevision)
          fail('EXCEPTION_POLICY_CHANGED', 'Exception policy revision changed');
        if (cmd.decision === 'authorize_limited') {
          if (
            !policy.allow_limited ||
            !built.blockers.length ||
            !built.blockers.every((code) => code.startsWith('SOURCE_UNSUPPORTED:'))
          )
            fail('EXCEPTION_POLICY_DENIED', 'Policy cannot waive missing or conflicting evidence');
          if (actor.submitterUserId === cert.operator_id)
            fail(
              'INDEPENDENT_REVIEW_REQUIRED',
              'A different central reviewer must resolve source limitations',
            );
          if (
            !cmd.artifacts.some((a) => a.kind === 'device_export') ||
            !cmd.artifacts.some((a) => a.kind === 'independent_attestation') ||
            new Set(cmd.artifacts.map((a) => a.sha256)).size < 2
          )
            fail(
              'SUPPORTING_EVIDENCE_REQUIRED',
              'Independent attestation and device export commitments are required',
            );
        }
        return (
          await c.query(
            `INSERT INTO central_attendance_exception_resolutions(id,certification_id,organization_id,operator_id,node_id,request,decision,limitations) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [
              cmd.requestId,
              cert.id,
              p.organizationId,
              actor.submitterUserId,
              actor.nodeId,
              JSON.stringify(cmd),
              cmd.decision,
              JSON.stringify(built.blockers),
            ],
          )
        ).rows[0];
      });
    },
    propose(credentials: AttendanceAuthorizationCredentials, input: unknown) {
      const cmd = proposalSchema.parse(input);
      return run(credentials, async (c, auth) => {
        const cert = await certification(c, cmd.certificationId),
          p = period(cert);
        const actor = await authorizeCentralUser(c, auth, p.organizationId, 'attendance.manage');
        await lock(c, p);
        const prior = (
          await c.query('SELECT * FROM central_attendance_requests WHERE proposal_id=$1', [
            cmd.proposalId,
          ])
        ).rows[0];
        if (prior) {
          if (
            prior.author_user_id !== actor.submitterUserId ||
            !same(prior.proposed_payload.command, cmd)
          )
            fail('CONFLICT', 'Proposal identity reused');
          return prior;
        }
        const { current, exception } = await ensureReady(c, cert, cmd.exceptionResolutionId);
        const result = {
          ...current.result,
          sourceSnapshot: current.snapshot,
          certificationId: cert.id,
          evidenceStatus: exception ? 'exception_authorized' : 'verified_complete',
          limitations: exception?.limitations ?? [],
          exception,
        };
        await insertRequest(c, {
          id: cmd.proposalId,
          p,
          action: 'calculate',
          author: actor.submitterUserId,
          node: actor.nodeId,
          expected: cmd.expectedCanonicalRevision,
          payload: { command: cmd, result },
          fingerprint: current.fingerprint,
        });
        return (
          await c.query('SELECT * FROM central_attendance_requests WHERE proposal_id=$1', [
            cmd.proposalId,
          ])
        ).rows[0];
      });
    },
    finalize(credentials: AttendanceAuthorizationCredentials, input: unknown) {
      const cmd = finalizeSchema.parse(input);
      return run(credentials, async (c, auth) => {
        const proposal = (
          await c.query(
            'SELECT *,work_date::text work_date_text FROM central_attendance_requests WHERE proposal_id=$1',
            [cmd.proposalId],
          )
        ).rows[0];
        if (!proposal || proposal.action !== 'calculate')
          fail('PROPOSAL_MISSING', 'Attendance calculation proposal is required');
        const p = period(proposal);
        const actor = await authorizeCentralUser(c, auth, p.organizationId, 'attendance.approve');
        await authorizeCentralUser(c, auth, p.organizationId, 'attendance.manage');
        await lock(c, p);
        const retry = (
          await c.query('SELECT * FROM central_attendance_requests WHERE proposal_id=$1', [
            cmd.requestId,
          ])
        ).rows[0];
        if (retry) {
          if (retry.author_user_id !== actor.submitterUserId || !same(retry.proposed_payload, cmd))
            fail('CONFLICT', 'Finalization identity reused');
          return (
            await c.query(
              "SELECT category,reason,decision_id FROM central_attendance_decisions WHERE proposal_id=$1 AND category IN ('accepted','conflict','rejected')",
              [cmd.requestId],
            )
          ).rows[0];
        }
        const terminal = (
          await c.query(
            "SELECT category,reason,decision_id FROM central_attendance_decisions WHERE proposal_id=$1 AND category IN ('accepted','conflict','rejected')",
            [cmd.proposalId],
          )
        ).rows[0];
        if (terminal)
          fail(
            'PROPOSAL_TERMINAL',
            'Calculation proposal already has a terminal decision; retain the original finalization request identity',
          );
        const head = (
          await c.query(
            'SELECT * FROM central_attendance_state WHERE organization_id=$1 AND employee_id=$2 AND work_date=$3',
            [p.organizationId, p.employeeId, p.workDate],
          )
        ).rows[0];
        let error: string | null = null;
        if (Number(head?.canonical_revision ?? 0) !== proposal.expected_canonical_revision)
          error = 'CANONICAL_REVISION_MISMATCH';
        else if (head?.approval_status === 'approved') error = 'REOPEN_REQUIRED';
        try {
          const command = proposalSchema.parse(proposal.proposed_payload.command);
          const cert = await certification(c, command.certificationId);
          if (
            !same(period(cert), p) ||
            command.proposalId !== proposal.proposal_id ||
            command.expectedCanonicalRevision !== proposal.expected_canonical_revision ||
            proposal.evidence_fingerprint !== cert.fingerprint
          )
            fail(
              'PROPOSAL_BINDING_MISMATCH',
              'Proposal identity, source period or fingerprint does not match its certification',
            );
          const ready = await ensureReady(c, cert, command.exceptionResolutionId);
          if (ready.exception?.operatorId === actor.submitterUserId)
            error = 'INDEPENDENT_APPROVAL_REQUIRED';
          if (
            !same(
              {
                ...ready.current.result,
                sourceSnapshot: ready.current.snapshot,
                certificationId: cert.id,
                evidenceStatus: ready.exception ? 'exception_authorized' : 'verified_complete',
                limitations: ready.exception?.limitations ?? [],
                exception: ready.exception,
              },
              proposal.proposed_payload.result,
            )
          )
            error = 'CALCULATION_MISMATCH';
        } catch (e) {
          if (e instanceof DomainError) error = e.code;
          else if (e instanceof z.ZodError) error = 'INVALID_PROPOSAL';
          else throw e;
        }
        if (error) {
          await insertRequest(c, {
            id: cmd.requestId,
            p,
            action: 'approve',
            author: actor.submitterUserId,
            node: actor.nodeId,
            expected: proposal.expected_canonical_revision + 1,
            payload: cmd,
            fingerprint: proposal.evidence_fingerprint,
          });
          const decision = (
            await c.query(
              `INSERT INTO central_attendance_decisions(organization_id,proposal_id,employee_id,work_date,action,expected_canonical_revision,category,reason,canonical_attendance_id,current_revision,actor_user_id,source_node_id)
            VALUES($1,$2,$3,$4,'approve',$5,'conflict',$6,$7,$8,$9,$10) RETURNING category,reason,decision_id`,
              [
                p.organizationId,
                cmd.requestId,
                p.employeeId,
                p.workDate,
                proposal.expected_canonical_revision + 1,
                JSON.stringify({
                  code: error,
                  message: 'Attendance proposal requires renewed evidence review',
                  details: {},
                }),
                head?.canonical_attendance_id ?? null,
                head?.canonical_revision ?? 0,
                actor.submitterUserId,
                actor.nodeId,
              ],
            )
          ).rows[0];
          return decision;
        }
        const id =
          head?.canonical_attendance_id ?? (await c.query('SELECT uuidv7() id')).rows[0].id;
        const calcDecision = await acceptedDecision(
          c,
          proposal,
          actor.submitterUserId,
          actor.nodeId,
          id,
        );
        await writeState(
          c,
          proposal,
          id,
          calcDecision,
          actor.submitterUserId,
          proposal.proposed_payload.result,
          false,
        );
        await insertRequest(c, {
          id: cmd.requestId,
          p,
          action: 'approve',
          author: actor.submitterUserId,
          node: actor.nodeId,
          expected: proposal.expected_canonical_revision + 1,
          payload: cmd,
          fingerprint: proposal.evidence_fingerprint,
        });
        const approval = (
          await c.query('SELECT * FROM central_attendance_requests WHERE proposal_id=$1', [
            cmd.requestId,
          ])
        ).rows[0];
        const approvalDecision = await acceptedDecision(
          c,
          approval,
          actor.submitterUserId,
          actor.nodeId,
          id,
        );
        await writeState(
          c,
          approval,
          id,
          approvalDecision,
          actor.submitterUserId,
          proposal.proposed_payload.result,
          true,
        );
        return {
          category: 'accepted',
          decision_id: approvalDecision,
          reason: {
            code: 'CENTRAL_ACCEPTED',
            message: 'Authenticated central attendance acceptance',
            details: {},
          },
        };
      });
    },
    reopen(credentials: AttendanceAuthorizationCredentials, input: unknown) {
      const cmd = reopenSchema.parse(input);
      return run(credentials, async (c, auth) => {
        const actor = await authorizeCentralUser(c, auth, cmd.organizationId, 'attendance.manage');
        await lock(c, cmd);
        const old = (
          await c.query('SELECT * FROM central_attendance_requests WHERE proposal_id=$1', [
            cmd.requestId,
          ])
        ).rows[0];
        if (old) {
          if (old.author_user_id !== actor.submitterUserId || !same(old.proposed_payload, cmd))
            fail('CONFLICT', 'Reopen identity reused');
          return (
            await c.query(
              'SELECT new_state FROM central_attendance_acceptance_history WHERE proposal_id=$1',
              [cmd.requestId],
            )
          ).rows[0].new_state;
        }
        const head = (
          await c.query(
            'SELECT * FROM central_attendance_state WHERE organization_id=$1 AND employee_id=$2 AND work_date=$3',
            [cmd.organizationId, cmd.employeeId, cmd.workDate],
          )
        ).rows[0];
        if (
          !head ||
          head.canonical_revision !== cmd.expectedCanonicalRevision ||
          head.approval_status !== 'approved'
        )
          fail('CANONICAL_REVISION_MISMATCH', 'Reopen requires the current approved revision');
        await insertRequest(c, {
          id: cmd.requestId,
          p: cmd,
          action: 'reopen',
          author: actor.submitterUserId,
          node: actor.nodeId,
          expected: cmd.expectedCanonicalRevision,
          payload: cmd,
          fingerprint: head.accepted_evidence_fingerprint,
        });
        const request = (
          await c.query('SELECT * FROM central_attendance_requests WHERE proposal_id=$1', [
            cmd.requestId,
          ])
        ).rows[0];
        const decision = await acceptedDecision(
          c,
          request,
          actor.submitterUserId,
          actor.nodeId,
          head.canonical_attendance_id,
        );
        return writeState(
          c,
          request,
          head.canonical_attendance_id,
          decision,
          actor.submitterUserId,
          head.result,
          false,
        );
      });
    },
  };
}
