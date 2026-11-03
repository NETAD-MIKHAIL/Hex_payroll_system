import type { PoolClient } from 'pg';
import { z } from 'zod';
import { canonicalSyncJson, type TimeRecordType } from '@hexpayroll/shared';
import {
  trustedAssignmentSchema,
  trustedScheduleSchema,
  trustedLeaveSchema,
  trustedLeaveTypeSchema,
} from '../sync/trusted-snapshots.js';
import { DomainError } from '../foundation/repository.js';
import { digest, sourceEntrySchema, verifySourceClosure } from './source-period-protocol.js';
import { interpretAttendance, type Shift, type Punch } from './processor.js';
import { nextDate } from './services.js';

const coverageSource = z
  .object({ deviceId: z.uuid(), deviceEmployeeId: z.string().min(1).max(254) })
  .strict();
const canonical = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
const same = (a: unknown, b: unknown) => canonicalSyncJson(a) === canonicalSyncJson(b);
function ranges(values: string[]) {
  const result: { first: string; last: string }[] = [];
  for (const value of values.map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const last = result.at(-1);
    if (last && BigInt(last.last) + 1n === value) last.last = value.toString();
    else result.push({ first: value.toString(), last: value.toString() });
  }
  return result;
}
export interface PeriodIdentity {
  organizationId: string;
  employeeId: string;
  workDate: string;
}

/** Caller holds the input lock and publication lock through its eventual write.
 * Only immutable accepted snapshots are schedule/leave authority; v1 projections
 * and local attendance_records never enter this calculation.
 */
export async function buildAttendanceSourceSnapshot(c: PoolClient, p: PeriodIdentity) {
  await c.query('SELECT pg_advisory_xact_lock(736614)');
  await c.query('SELECT pg_advisory_xact_lock(684297106)');
  const blockers: string[] = [];
  const accepted = (
    await c.query<{
      entity_type: string;
      canonical_snapshot: string;
      snapshot_fingerprint: string;
    }>(
      `SELECT DISTINCT ON(entity_type,entity_id) entity_type,canonical_snapshot,snapshot_fingerprint
    FROM central_evidence_acceptances WHERE organization_id=$1 ORDER BY entity_type,entity_id,resulting_revision DESC`,
      [p.organizationId],
    )
  ).rows;
  const assignments = accepted
    .filter((a) => a.entity_type === 'employee_schedule_assignments')
    .map((a) => trustedAssignmentSchema.parse(JSON.parse(a.canonical_snapshot)))
    .filter((a) => a.employeeId === p.employeeId);
  const schedules = accepted
    .filter((a) => a.entity_type === 'work_schedules')
    .map((a) => trustedScheduleSchema.parse(JSON.parse(a.canonical_snapshot)));
  const leaves = accepted
    .filter((a) => a.entity_type === 'leave_requests')
    .map((a) => trustedLeaveSchema.parse(JSON.parse(a.canonical_snapshot)))
    .filter(
      (a) => a.employeeId === p.employeeId && a.startDate <= p.workDate && a.endDate >= p.workDate,
    );
  const leaveTypes = accepted
    .filter((a) => a.entity_type === 'leave_types')
    .map((a) => trustedLeaveTypeSchema.parse(JSON.parse(a.canonical_snapshot)))
    .filter((t) => leaves.some((l) => l.leaveTypeId === t.id));
  async function shiftFor(date: string) {
    const matches = assignments.filter(
      (a) => a.effectiveFrom <= date && (a.effectiveTo === null || a.effectiveTo > date),
    );
    if (matches.length !== 1) return null;
    const assignment = matches[0]!;
    const schedule = schedules.find((s) => s.id === assignment.scheduleId);
    const version = schedule?.versions.filter((v) => v.effectiveFrom <= date).at(-1);
    const day = version?.days.find(
      (d) => d.dayOfWeek === new Date(date + 'T12:00:00Z').getUTCDay(),
    );
    if (!schedule || !version || !day) return null;
    const instant = async (time: string, offset: number) => {
      const r = (
        await c.query<{ instant: string }>(
          `SELECT (($1::date+$2::int+$3::time) AT TIME ZONE $4)::text instant`,
          [date, offset, time, version.timezone],
        )
      ).rows[0]!;
      return Date.parse(r.instant);
    };
    const shift: Shift | null = day.isWorkDay
      ? {
          start: await instant(day.startTime!, 0),
          end: await instant(day.endTime!, day.endDayOffset),
          graceMinutes: day.graceMinutes,
          break:
            day.breakStart && day.breakEnd
              ? [
                  await instant(day.breakStart, day.breakStartDayOffset),
                  await instant(day.breakEnd, day.breakEndDayOffset),
                ]
              : null,
        }
      : null;
    return { assignment, schedule, version, day, shift };
  }
  const resolved = await shiftFor(p.workDate);
  if (!resolved) blockers.push('ACCEPTED_SHIFT_UNAVAILABLE');
  const timezone =
    resolved?.version.timezone ??
    (
      await c.query<{ timezone: string }>('SELECT timezone FROM organizations WHERE id=$1', [
        p.organizationId,
      ])
    ).rows[0]?.timezone;
  if (!timezone)
    throw new DomainError(409, 'ORGANIZATION_MISSING', 'Attendance organization unavailable');
  const calendar = (
    await c.query<{ start: string; end: string }>(
      `SELECT ($1::date::timestamp AT TIME ZONE $2)::text start,(($1::date+1)::timestamp AT TIME ZONE $2)::text "end"`,
      [p.workDate, timezone],
    )
  ).rows[0]!;
  const start = resolved?.shift ? resolved.shift.start - 7200000 : Date.parse(calendar.start);
  const end = resolved?.shift ? resolved.shift.end + 7200000 : Date.parse(calendar.end);
  const window = {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    timezone,
  };
  if (
    !(await c.query('SELECT clock_timestamp()>=$1::timestamptz closed', [window.end])).rows[0]
      .closed
  )
    blockers.push('SHIFT_WINDOW_OPEN');
  const adjacent = [];
  for (const offset of [-2, -1, 1, 2]) {
    const other = await shiftFor(nextDate(p.workDate, offset));
    if (other) adjacent.push(other);
  }
  const coverage = (
    await c.query(
      `SELECT to_jsonb(t) data FROM central_attendance_coverage t WHERE organization_id=$1 AND employee_id=$2 AND effective_from<=$3 ORDER BY revision DESC LIMIT 1`,
      [p.organizationId, p.employeeId, p.workDate],
    )
  ).rows[0]?.data;
  const sources = coverage ? z.array(coverageSource).min(1).max(20).parse(coverage.sources) : [];
  if (!sources.length) blockers.push('EXPECTED_DEVICE_COVERAGE_MISSING');
  if (new Set(sources.map((s) => s.deviceId)).size !== sources.length)
    blockers.push('EXPECTED_DEVICE_COVERAGE_CONFLICT');
  const mappings = (
    await c.query(
      'SELECT to_jsonb(m) data FROM biometric_mappings m WHERE organization_id=$1 AND employee_id=$2 ORDER BY device_id,device_employee_id',
      [p.organizationId, p.employeeId],
    )
  ).rows.map((r) => r.data);
  for (const m of mappings.filter((m) => m.status === 'active'))
    if (
      !sources.some(
        (s) => s.deviceId === m.device_id && s.deviceEmployeeId === m.device_employee_id,
      )
    )
      blockers.push('UNBOUND_EMPLOYEE_MAPPING');
  const sourceProofs: unknown[] = [];
  const punches: Punch[] = [];
  const punchEvidence: unknown[] = [];
  for (const source of sources) {
    const mapping = mappings.find(
      (m) =>
        m.device_id === source.deviceId &&
        m.device_employee_id === source.deviceEmployeeId &&
        m.status === 'active',
    );
    if (!mapping) blockers.push('EXPECTED_MAPPING_MISSING:' + source.deviceId);
    const capability = (
      await c.query(
        'SELECT to_jsonb(t) data FROM central_source_capabilities t WHERE organization_id=$1 AND device_id=$2 ORDER BY revision DESC LIMIT 1',
        [p.organizationId, source.deviceId],
      )
    ).rows[0]?.data;
    const binding = (
      await c.query(
        'SELECT to_jsonb(t) data FROM central_biometric_sources t WHERE organization_id=$1 AND device_id=$2',
        [p.organizationId, source.deviceId],
      )
    ).rows[0]?.data;
    const raw = (
      await c.query(
        `SELECT id,device_employee_id AS "deviceEmployeeId",to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "recordedAt",
      record_type AS "recordType",external_record_id AS "externalRecordId",source_identity AS "sourceIdentity"
      FROM central_biometric_raw_evidence WHERE organization_id=$1 AND device_id=$2 AND recorded_at>=$3 AND recorded_at<$4 ORDER BY recorded_at,id`,
        [p.organizationId, source.deviceId, window.start, window.end],
      )
    ).rows;
    const manifests = (
      await c.query(
        `SELECT closure_id,manifest,signature,fingerprint FROM central_source_closures WHERE organization_id=$1 AND device_id=$2 AND capability_revision=$3
      AND (manifest->>'start')::timestamptz<=$4 AND (manifest->>'end')::timestamptz>=$5 ORDER BY (manifest->>'issuedAt')::timestamptz DESC,closure_id`,
        [p.organizationId, source.deviceId, capability?.revision ?? 0, window.start, window.end],
      )
    ).rows;
    let proof: unknown = null;
    if (!binding || !capability) blockers.push('SOURCE_CAPABILITY_MISSING:' + source.deviceId);
    else if (capability.contract !== 'signed-inventory-v1')
      blockers.push('SOURCE_UNSUPPORTED:' + source.deviceId);
    else if (capability.assessment?.contractVerified !== true)
      blockers.push('SOURCE_CONTRACT_UNVERIFIED:' + source.deviceId);
    else if (!manifests.length) blockers.push('SOURCE_CLOSURE_MISSING:' + source.deviceId);
    else {
      const row = manifests[0]!;
      const closure = verifySourceClosure(
        { manifest: row.manifest, signature: row.signature },
        capability.public_key,
      );
      const m = closure.manifest;
      if (
        m.organizationId !== p.organizationId ||
        m.deviceId !== source.deviceId ||
        m.closureId !== row.closure_id ||
        m.capabilityRevision !== capability.revision ||
        digest(closure) !== row.fingerprint
      )
        blockers.push('SOURCE_CLOSURE_BINDING_CONFLICT:' + source.deviceId);
      if (m.epoch !== capability.epoch || m.timezone !== timezone)
        blockers.push('SOURCE_WINDOW_OR_EPOCH_MISMATCH:' + source.deviceId);
      const inventory = m.inventory;
      const inWindow = (entry: { recordedAt: string }) =>
        Date.parse(entry.recordedAt) >= start && Date.parse(entry.recordedAt) < end;
      const expected = inventory.filter(inWindow);
      for (const previous of manifests.slice(1)) {
        const other = verifySourceClosure(
          { manifest: previous.manifest, signature: previous.signature },
          capability.public_key,
        );
        if (
          other.manifest.organizationId !== p.organizationId ||
          other.manifest.deviceId !== source.deviceId ||
          other.manifest.closureId !== previous.closure_id ||
          other.manifest.capabilityRevision !== capability.revision ||
          digest(other) !== previous.fingerprint
        )
          blockers.push('SOURCE_CLOSURE_BINDING_CONFLICT:' + source.deviceId);
        if (!same(expected, other.manifest.inventory.filter(inWindow)))
          blockers.push('SOURCE_CLOSURE_CONFLICT:' + source.deviceId);
      }
      // Check the complete signed range, including signed guard entries outside
      // the shift window: a missing trailing source entry is never invisible.
      const received = (
        await c.query(
          `SELECT source_identity AS "sourceIdentity",device_employee_id AS "deviceEmployeeId",to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "recordedAt",record_type AS "recordType",external_record_id AS "externalRecordId"
        FROM central_biometric_raw_evidence WHERE organization_id=$1 AND device_id=$2 AND source_identity->>'epoch'=$3 AND (source_identity->>'sequence')::bigint BETWEEN $4 AND $5 ORDER BY (source_identity->>'sequence')::bigint`,
          [p.organizationId, source.deviceId, m.epoch, m.firstSequence, m.lastSequence],
        )
      ).rows;
      if (received.length !== inventory.length)
        blockers.push('MISSING_SOURCE_ENTRIES:' + source.deviceId);
      for (const entry of inventory) {
        const actual = received.find(
          (r) => r.sourceIdentity?.sequence === entry.sourceIdentity.sequence,
        );
        if (!actual) continue;
        if (!same(sourceEntrySchema.parse(actual), entry))
          blockers.push('SOURCE_ENTRY_CONFLICT:' + source.deviceId);
      }
      for (const actual of raw) {
        const { id: unused, ...entry } = actual;
        void unused;
        if (!entry.sourceIdentity || !expected.some((e) => same(e, entry)))
          blockers.push('SOURCE_CLOSURE_CONFLICT:' + source.deviceId);
      }
      proof = {
        closureId: row.closure_id,
        fingerprint: row.fingerprint,
        firstSequence: m.firstSequence,
        lastSequence: m.lastSequence,
        inventoryFingerprint: digest(inventory),
        receivedFingerprint: digest(received),
        receivedRanges: ranges(received.map((r) => r.sourceIdentity.sequence)),
        missingRanges: ranges(
          inventory
            .filter(
              (entry) =>
                !received.some((r) => r.sourceIdentity.sequence === entry.sourceIdentity.sequence),
            )
            .map((entry) => entry.sourceIdentity.sequence),
        ),
        coveringClosures: manifests.map((r) => ({ id: r.closure_id, fingerprint: r.fingerprint })),
      };
    }
    for (const r of raw.filter((r) => r.deviceEmployeeId === source.deviceEmployeeId)) {
      const at = Date.parse(r.recordedAt);
      const ambiguous = adjacent.some(
        (a) => a.shift && at >= a.shift.start - 7200000 && at < a.shift.end + 7200000,
      );
      punches.push({
        id: r.id,
        recordedAt: r.recordedAt,
        recordType: r.recordType as TimeRecordType,
        ambiguous,
      });
      punchEvidence.push({ deviceId: source.deviceId, ...r });
    }
    sourceProofs.push({
      source,
      capability: capability ?? null,
      binding: binding ?? null,
      proof,
      windowInventoryFingerprint: digest(raw),
    });
  }
  const approved = leaves.filter((l) => l.status === 'approved');
  if (leaves.some((l) => l.status === 'pending')) blockers.push('PENDING_ACCEPTED_LEAVE');
  if (approved.some((l) => !leaveTypes.some((t) => t.id === l.leaveTypeId)))
    blockers.push('ACCEPTED_LEAVE_TYPE_MISSING');
  const halves = approved.map((l) => l.durationType);
  const leave = halves.includes('full_day')
    ? 'full_day'
    : halves.includes('first_half') && halves.includes('second_half')
      ? 'both_halves'
      : halves.includes('first_half')
        ? 'first_half'
        : halves.includes('second_half')
          ? 'second_half'
          : null;
  const result = interpretAttendance({
    shift: resolved?.shift ?? null,
    isRestDay: resolved ? !resolved.day.isWorkDay : false,
    punches,
    leave,
    now: end,
  });
  if (result.flags.length || !result.complete) blockers.push('ATTENDANCE_RESULT_REQUIRES_REVIEW');
  const policy =
    (
      await c.query(
        'SELECT to_jsonb(t) data FROM central_attendance_exception_policies t WHERE organization_id=$1 ORDER BY revision DESC LIMIT 1',
        [p.organizationId],
      )
    ).rows[0]?.data ?? null;
  const snapshot = {
    version: 1,
    organizationId: p.organizationId,
    employeeId: p.employeeId,
    workDate: p.workDate,
    window,
    coverage: coverage ?? null,
    mappings,
    sourceProofs,
    punchEvidence,
    accepted: {
      assignment: resolved?.assignment ?? null,
      schedule: resolved?.schedule ?? null,
      version: resolved?.version ?? null,
      day: resolved?.day ?? null,
      adjacent: adjacent.map((a) => ({
        assignment: a.assignment,
        version: a.version,
        day: a.day,
        shift: a.shift,
      })),
      leaves,
      leaveTypes,
    },
    policy,
    blockers: [...new Set(blockers)].sort(),
    result,
  };
  const normalized = canonical(snapshot);
  if (Buffer.byteLength(canonicalSyncJson(normalized)) > 220000)
    throw new DomainError(
      409,
      'EVIDENCE_LIMIT',
      'Period evidence exceeds bounded certification size',
    );
  return {
    snapshot: normalized as typeof snapshot,
    fingerprint: digest(normalized),
    result,
    blockers: snapshot.blockers,
  };
}
