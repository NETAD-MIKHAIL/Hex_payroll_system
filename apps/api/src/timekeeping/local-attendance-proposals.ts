import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { attendanceStatusSchema, isoDateSchema } from '@hexpayroll/shared';
import {
  DomainError,
  getActor,
  normalize,
  requirePermission,
  transaction,
  type Actor,
} from '../foundation/repository.js';

const uuid7 = z.uuid().refine((value) => value[14] === '7', 'UUIDv7 required');
const revision = z.number().int().nonnegative().max(2147483647);
const localRevision = revision.refine((value) => value > 0);
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const reason = z
  .string()
  .min(1)
  .max(2000)
  .refine((value) => value.trim().length > 0);
const minutes = z.number().int().min(0).max(1440);
const instant = z.iso.datetime({ offset: true });

// Version-one local proposal payloads. These do not execute calculations or approvals.
const calculation = z
  .object({
    firstIn: instant.nullable(),
    lastOut: instant.nullable(),
    workedMinutes: minutes,
    lateMinutes: minutes,
    undertimeMinutes: minutes,
    attendanceStatus: attendanceStatusSchema,
    complete: z.boolean(),
    flags: z.array(z.string().min(1).max(100)).max(100),
  })
  .strict()
  .refine(
    (value) =>
      value.firstIn === null ||
      value.lastOut === null ||
      Date.parse(value.lastOut) >= Date.parse(value.firstIn),
    'Last out precedes first in',
  );
const overrides = z
  .object({
    workedMinutes: minutes.optional(),
    lateMinutes: minutes.optional(),
    undertimeMinutes: minutes.optional(),
    attendanceStatus: attendanceStatusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'An override is required');
const baseContent = {
  expectedCanonicalRevision: revision,
  evidenceFingerprint: fingerprint.nullable(),
};
export const localProposalContentSchema = z
  .discriminatedUnion('action', [
    z
      .object({
        ...baseContent,
        action: z.literal('calculate'),
        evidenceFingerprint: fingerprint,
        payload: calculation,
      })
      .strict(),
    z
      .object({
        ...baseContent,
        action: z.literal('adjust'),
        payload: z.object({ reason, overrides }).strict(),
      })
      .strict(),
    z
      .object({
        ...baseContent,
        action: z.literal('approve'),
        payload: z.object({ reason: reason.nullable() }).strict(),
      })
      .strict(),
    z
      .object({
        ...baseContent,
        action: z.literal('reopen'),
        payload: z.object({ reason }).strict(),
      })
      .strict(),
  ])
  .refine(
    (value) => value.action === 'calculate' || value.expectedCanonicalRevision > 0,
    'Only calculation proposals may create canonical attendance',
  );
const createSchema = z
  .object({
    proposalId: uuid7.optional(),
    employeeId: z.uuid(),
    workDate: isoDateSchema,
    content: localProposalContentSchema,
  })
  .strict();
const structuredReason = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/),
    message: reason,
    details: z.record(z.string(), z.json()),
  })
  .strict()
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 16384,
    'Reason exceeds storage limit',
  );
export const localProposalDecisionSchema = z
  .object({
    requestId: uuid7,
    decisionId: z.uuid(),
    category: z.enum(['accepted', 'conflicted', 'rejected']),
    reason: structuredReason,
    canonicalAttendanceId: z.uuid().nullable(),
    acceptedRevision: revision.nullable(),
    currentRevision: revision.nullable(),
    decidedAt: instant,
  })
  .strict()
  .refine(
    (value) =>
      value.category === 'accepted'
        ? value.canonicalAttendanceId !== null &&
          value.acceptedRevision !== null &&
          value.acceptedRevision > 0 &&
          (value.currentRevision === null || value.currentRevision >= value.acceptedRevision)
        : value.acceptedRevision === null,
    'Invalid canonical decision metadata',
  );

export type LocalProposalContent = z.infer<typeof localProposalContentSchema>;
export type LocalProposalDecision = z.infer<typeof localProposalDecisionSchema>;
type Identity = Pick<Actor, 'id' | 'organizationId'>;
export type LocalProposalStatus =
  'draft' | 'pending' | 'uncertain' | 'retryable' | 'accepted' | 'conflicted' | 'rejected';
export interface LocalAttendanceProposal {
  proposalId: string;
  organizationId: string;
  employeeId: string;
  workDate: string;
  action: LocalProposalContent['action'];
  authorUserId: string;
  expectedCanonicalRevision: number;
  proposedPayload: LocalProposalContent['payload'];
  evidenceFingerprint: string | null;
  status: LocalProposalStatus;
  localRevision: number;
  submittedAt: string | null;
  attemptCount: number;
  attemptId: string | null;
  lastAttemptAt: string | null;
  lastError: z.infer<typeof structuredReason> | null;
  decisionCategory: LocalProposalDecision['category'] | null;
  decisionReason: LocalProposalDecision['reason'] | null;
  serverDecisionId: string | null;
  decisionRequestId: string | null;
  serverDecidedAt: string | null;
  canonicalAttendanceId: string | null;
  acceptedCanonicalRevision: number | null;
  currentCanonicalRevision: number | null;
  createdAt: string;
  updatedAt: string;
}

function proposal(row: Record<string, unknown>): LocalAttendanceProposal {
  return normalize(row) as unknown as LocalAttendanceProposal;
}
const permissions = {
  calculate: 'attendance.manage',
  adjust: 'attendance.adjust',
  approve: 'attendance.approve',
  reopen: 'attendance.manage',
} as const;
const terminal = (status: LocalProposalStatus) =>
  ['accepted', 'conflicted', 'rejected'].includes(status);
const conflict = (message: string): never => {
  throw new DomainError(409, 'CONFLICT', message);
};

async function authorize(client: PoolClient, identity: Identity) {
  z.uuid().parse(identity.id);
  const org = z.uuid().parse(identity.organizationId);
  const enrolled = await client.query(
    'SELECT organization_id FROM application_setup WHERE singleton FOR SHARE',
  );
  if (enrolled.rows[0]?.organization_id !== org) {
    throw new DomainError(403, 'FORBIDDEN', 'Proposal organization is not enrolled');
  }
  // Refresh permissions from storage, rather than trusting caller-supplied role arrays.
  const actor = await getActor(client, identity.id);
  if (actor.organizationId !== org)
    throw new DomainError(403, 'FORBIDDEN', 'User organization mismatch');
  return actor;
}
async function readLocked(client: PoolClient, org: string, id: string) {
  const result = await client.query(
    'SELECT * FROM local_attendance_proposals WHERE proposal_id=$1 AND organization_id=$2 FOR UPDATE',
    [id, org],
  );
  if (!result.rows[0]) throw new DomainError(404, 'NOT_FOUND', 'Proposal not found');
  return proposal(result.rows[0]);
}
function canEdit(actor: Actor, row: LocalAttendanceProposal) {
  requirePermission(actor, permissions[row.action]);
  if (row.authorUserId !== actor.id)
    throw new DomainError(
      403,
      'FORBIDDEN',
      'Only the original author may change this local proposal',
    );
}
function expectRevision(row: LocalAttendanceProposal, expected: number) {
  if (row.localRevision !== localRevision.parse(expected))
    conflict('Proposal changed; reload before retrying');
  if (terminal(row.status)) conflict('Terminal proposal decisions are immutable');
}
function expectAttempt(row: LocalAttendanceProposal, attemptId: string) {
  if (row.attemptId !== uuid7.parse(attemptId) || row.attemptCount === 0)
    conflict('Stale proposal attempt');
}

/** Persistence only: no routes, network client, sync outbox or attendance worker uses this service.
 * recordDecision is reserved for a future trusted central-response adapter. Storing a decision
 * here does not validate its provenance, apply canonical attendance or grant approval rights.
 */
export function createLocalAttendanceProposalService(pool: Pool) {
  return {
    async createDraft(identity: Identity, input: z.input<typeof createSchema>) {
      const value = createSchema.parse(input);
      return transaction(pool, async (client) => {
        const actor = await authorize(client, identity);
        requirePermission(actor, permissions[value.content.action]);
        const org = actor.organizationId!;
        const id =
          value.proposalId ??
          (await client.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id;
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'local_attendance_proposals:' + id,
        ]);
        const existing = await client.query(
          `SELECT *,proposed_payload=$2::jsonb AS payload_matches
           FROM local_attendance_proposals WHERE proposal_id=$1 FOR UPDATE`,
          [id, JSON.stringify(value.content.payload)],
        );
        const current = existing.rows[0];
        if (current) {
          if (current.organization_id !== org) conflict('Proposal identity is unavailable');
          const row = proposal(current);
          if (
            row.employeeId !== value.employeeId ||
            row.workDate !== value.workDate ||
            row.authorUserId !== actor.id ||
            row.action !== value.content.action ||
            row.expectedCanonicalRevision !== value.content.expectedCanonicalRevision ||
            row.evidenceFingerprint !== value.content.evidenceFingerprint ||
            current.payload_matches !== true
          ) {
            conflict('Proposal UUID reused with different content');
          }
          // Do not expose the internal comparison column.
          delete current.payload_matches;
          return proposal(current);
        }
        const employee = await client.query(
          'SELECT id FROM employees WHERE id=$1 AND organization_id=$2 FOR KEY SHARE',
          [value.employeeId, org],
        );
        if (!employee.rows[0])
          throw new DomainError(
            400,
            'INVALID_REQUEST',
            'Employee is not in the proposal organization',
          );
        const saved = await client.query(
          `INSERT INTO local_attendance_proposals(proposal_id,organization_id,employee_id,work_date,action,
             author_user_id,expected_canonical_revision,proposed_payload,evidence_fingerprint)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [
            id,
            org,
            value.employeeId,
            value.workDate,
            value.content.action,
            actor.id,
            value.content.expectedCanonicalRevision,
            JSON.stringify(value.content.payload),
            value.content.evidenceFingerprint,
          ],
        );
        return proposal(saved.rows[0]);
      });
    },
    async read(identity: Identity, id: string) {
      uuid7.parse(id);
      return transaction(pool, async (client) => {
        const actor = await authorize(client, identity);
        requirePermission(actor, 'attendance.view');
        const result = await client.query(
          'SELECT * FROM local_attendance_proposals WHERE proposal_id=$1 AND organization_id=$2',
          [id, actor.organizationId],
        );
        if (!result.rows[0]) throw new DomainError(404, 'NOT_FOUND', 'Proposal not found');
        return proposal(result.rows[0]);
      });
    },
    async list(
      identity: Identity,
      input: {
        employeeId?: string;
        status?: LocalProposalStatus;
        limit?: number;
        offset?: number;
      } = {},
    ) {
      const filter = z
        .object({
          employeeId: z.uuid().optional(),
          status: z
            .enum([
              'draft',
              'pending',
              'uncertain',
              'retryable',
              'accepted',
              'conflicted',
              'rejected',
            ])
            .optional(),
          limit: z.number().int().min(1).max(100).default(50),
          offset: z.number().int().min(0).max(2147483647).default(0),
        })
        .strict()
        .parse(input);
      return transaction(pool, async (client) => {
        const actor = await authorize(client, identity);
        requirePermission(actor, 'attendance.view');
        const rows = await client.query(
          `SELECT * FROM local_attendance_proposals WHERE organization_id=$1
             AND ($2::uuid IS NULL OR employee_id=$2) AND ($3::text IS NULL OR status=$3)
           ORDER BY created_at,proposal_id LIMIT $4 OFFSET $5`,
          [
            actor.organizationId,
            filter.employeeId ?? null,
            filter.status ?? null,
            filter.limit,
            filter.offset,
          ],
        );
        return rows.rows.map(proposal);
      });
    },
    async editDraft(
      identity: Identity,
      id: string,
      expected: number,
      content: LocalProposalContent,
    ) {
      uuid7.parse(id);
      const value = localProposalContentSchema.parse(content);
      return transaction(pool, async (client) => {
        const actor = await authorize(client, identity);
        const row = await readLocked(client, actor.organizationId!, id);
        canEdit(actor, row);
        requirePermission(actor, permissions[value.action]);
        expectRevision(row, expected);
        if (row.status !== 'draft') conflict('Only a draft can be edited');
        return proposal(
          (
            await client.query(
              `UPDATE local_attendance_proposals SET action=$3,expected_canonical_revision=$4,
             proposed_payload=$5,evidence_fingerprint=$6,local_revision=local_revision+1
           WHERE proposal_id=$1 AND organization_id=$2 RETURNING *`,
              [
                id,
                actor.organizationId,
                value.action,
                value.expectedCanonicalRevision,
                JSON.stringify(value.payload),
                value.evidenceFingerprint,
              ],
            )
          ).rows[0],
        );
      });
    },
    async queue(identity: Identity, id: string, expected: number) {
      uuid7.parse(id);
      return transaction(pool, async (client) => {
        const actor = await authorize(client, identity);
        const row = await readLocked(client, actor.organizationId!, id);
        canEdit(actor, row);
        expectRevision(row, expected);
        if (row.status !== 'draft') conflict('Only a draft can be queued');
        return proposal(
          (
            await client.query(
              `UPDATE local_attendance_proposals SET status='pending',local_revision=local_revision+1
           WHERE proposal_id=$1 AND organization_id=$2 RETURNING *`,
              [id, actor.organizationId],
            )
          ).rows[0],
        );
      });
    },
    async beginAttempt(identity: Identity, id: string, expected: number) {
      uuid7.parse(id);
      return transaction(pool, async (client) => {
        const actor = await authorize(client, identity);
        const row = await readLocked(client, actor.organizationId!, id);
        canEdit(actor, row);
        expectRevision(row, expected);
        if (!['pending', 'uncertain', 'retryable'].includes(row.status))
          conflict('Queue the draft before attempting submission');
        if (row.status === 'pending' && row.attemptCount > 0)
          conflict('Mark the previous attempt uncertain or retryable first');
        return proposal(
          (
            await client.query(
              `UPDATE local_attendance_proposals SET status='pending',attempt_count=attempt_count+1,
             attempt_id=uuidv7(),last_error=NULL,local_revision=local_revision+1
           WHERE proposal_id=$1 AND organization_id=$2 RETURNING *`,
              [id, actor.organizationId],
            )
          ).rows[0],
        );
      });
    },
    async recordAttemptOutcome(
      identity: Identity,
      id: string,
      expected: number,
      attemptId: string,
      outcome: 'uncertain' | 'retryable',
      error: z.infer<typeof structuredReason>,
    ) {
      uuid7.parse(id);
      const status = z.enum(['uncertain', 'retryable']).parse(outcome);
      const details = structuredReason.parse(error);
      return transaction(pool, async (client) => {
        const actor = await authorize(client, identity);
        const row = await readLocked(client, actor.organizationId!, id);
        canEdit(actor, row);
        expectRevision(row, expected);
        expectAttempt(row, attemptId);
        if (row.status !== 'pending')
          conflict('Only the current pending attempt can record an outcome');
        return proposal(
          (
            await client.query(
              `UPDATE local_attendance_proposals SET status=$3,last_error=$4,local_revision=local_revision+1
           WHERE proposal_id=$1 AND organization_id=$2 RETURNING *`,
              [id, actor.organizationId, status, JSON.stringify(details)],
            )
          ).rows[0],
        );
      });
    },
    async recordDecision(
      identity: Identity,
      id: string,
      expected: number,
      attemptId: string,
      input: LocalProposalDecision,
    ) {
      uuid7.parse(id);
      const value = localProposalDecisionSchema.parse(input);
      if (value.requestId !== id) conflict('Decision request identity mismatch');
      return transaction(pool, async (client) => {
        const actor = await authorize(client, identity);
        const row = await readLocked(client, actor.organizationId!, id);
        canEdit(actor, row);
        const values = [
          id,
          actor.organizationId,
          value.category,
          JSON.stringify(value.reason),
          value.decisionId,
          value.requestId,
          value.decidedAt,
          value.canonicalAttendanceId,
          value.acceptedRevision,
          value.currentRevision,
        ];
        if (terminal(row.status)) {
          // JSONB and PostgreSQL timestamp comparisons avoid property-order/offset differences.
          const replay = await client.query(
            `SELECT decision_category=$3 AND decision_reason=$4::jsonb AND server_decision_id=$5
               AND decision_request_id=$6 AND server_decided_at=$7::timestamptz
               AND canonical_attendance_id IS NOT DISTINCT FROM $8::uuid
               AND accepted_canonical_revision IS NOT DISTINCT FROM $9::integer
               AND current_canonical_revision IS NOT DISTINCT FROM $10::integer AS matches
             FROM local_attendance_proposals WHERE proposal_id=$1 AND organization_id=$2`,
            values,
          );
          if (replay.rows[0]?.matches === true) return row;
          conflict('Terminal decision conflict; previous decision preserved');
        }
        expectRevision(row, expected);
        expectAttempt(row, attemptId);
        if (!['pending', 'uncertain', 'retryable'].includes(row.status))
          conflict('Drafts cannot receive central decisions');
        if (
          value.category === 'accepted' &&
          value.acceptedRevision !== row.expectedCanonicalRevision + 1
        ) {
          conflict('Accepted revision does not match the proposal base revision');
        }
        return proposal(
          (
            await client.query(
              `UPDATE local_attendance_proposals SET status=$3,decision_category=$3,decision_reason=$4,
             server_decision_id=$5,decision_request_id=$6,server_decided_at=$7,canonical_attendance_id=$8,
             accepted_canonical_revision=$9,current_canonical_revision=$10,last_error=NULL,
             local_revision=local_revision+1 WHERE proposal_id=$1 AND organization_id=$2 RETURNING *`,
              values,
            )
          ).rows[0],
        );
      });
    },
  };
}
