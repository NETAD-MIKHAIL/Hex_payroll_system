import type { ConflictType } from '@hexpayroll/shared';

export interface ConflictInput {
  entityType: string;
  operation: 'CREATE' | 'UPDATE' | 'ARCHIVE';
  baseRevision: number;
  incoming: Record<string, unknown>;
  authoritative: Record<string, unknown> | null;
  authorized: boolean;
  dependency?: 'pending' | 'missing' | 'invalid';
  duplicateIdentity?: boolean;
  overlaps?: boolean;
}
export type DetectionResult =
  | { outcome: 'accepted'; currentRevision: number; idempotent?: boolean }
  | { outcome: 'deferred'; reason: string }
  | {
      outcome: 'conflict';
      conflictType: ConflictType;
      currentRevision: number | null;
      reason: string;
    };
export function detectConflict(input: ConflictInput): DetectionResult {
  const current = input.authoritative;
  const revision = current ? Number(current.revision) : null;
  const conflict = (conflictType: ConflictType, reason: string): DetectionResult => ({
    outcome: 'conflict',
    conflictType,
    currentRevision: revision,
    reason,
  });
  if (!input.authorized)
    return conflict('AUTHORIZATION_CONFLICT', 'Mutation is no longer authorized');
  if (input.dependency === 'pending')
    return { outcome: 'deferred', reason: 'Dependency delivery is pending' };
  if (input.dependency === 'missing')
    return conflict('MISSING_DEPENDENCY', 'Required dependency is unavailable');
  if (input.dependency === 'invalid')
    return conflict('INVALID_REFERENCE', 'Reference is invalid in this organization');
  if (input.entityType === 'time_records' && current) {
    const keys = ['employeeId', 'deviceId', 'externalRecordId', 'recordedAt', 'recordType'];
    if (input.operation === 'CREATE' && keys.every((k) => current[k] === input.incoming[k]))
      return { outcome: 'accepted', currentRevision: revision ?? 1, idempotent: true };
    return conflict('UPDATE_UPDATE', 'Original time record evidence is immutable');
  }
  if (input.entityType.startsWith('payroll_') || input.entityType === 'employee_payroll_results') {
    if (
      current?.finalized === true ||
      current?.status === 'finalized' ||
      input.incoming.finalized === true ||
      input.incoming.status === 'finalized'
    )
      return conflict(
        'PAYROLL_CONFLICT',
        'Finalized payroll requires an approved correction or reversal workflow',
      );
  }
  if (input.duplicateIdentity || (input.operation === 'CREATE' && current))
    return conflict('DUPLICATE_CREATE', 'Business identity already exists');
  if (input.overlaps) return conflict('SCHEDULE_CONFLICT', 'Effective-dated assignments overlap');
  if (!current && input.operation !== 'CREATE')
    return conflict('MISSING_DEPENDENCY', 'Target record is unavailable');
  if (
    input.entityType === 'leave_requests' &&
    current &&
    current.status !== input.incoming.status &&
    current.status !== 'pending'
  )
    return conflict('LEAVE_CONFLICT', 'Leave decisions are incompatible');
  if (input.baseRevision !== (revision ?? 0)) {
    if (
      input.operation === 'ARCHIVE' ||
      current?.status === 'inactive' ||
      input.incoming.status === 'inactive'
    )
      return conflict('UPDATE_ARCHIVE', 'Archive and update revisions conflict');
    return conflict(
      input.baseRevision < (revision ?? 0) ? 'STALE_REVISION' : 'UPDATE_UPDATE',
      'Authoritative revision changed',
    );
  }
  return { outcome: 'accepted', currentRevision: revision ?? 0 };
}

// Unknown event shapes are organization barriers. Known keys include both writes
// and reads, so a conflicted reference blocks consumers transitively.
export function dependencyKeys(
  entityType: string,
  entityId: string,
  payload: Record<string, unknown>,
): string[] | null {
  if (entityType === 'sync_snapshot_chunk')
    return ['payroll-snapshot:' + String(payload.aggregateId)];
  if (entityType === 'sync_resolution_proposals') return ['resolution-proposal:' + entityId];
  if (entityType === 'departments')
    return [`departments:${entityId}`, `department-code:${String(payload.code).toLowerCase()}`];
  if (entityType === 'positions')
    return [
      `positions:${entityId}`,
      `position-code:${String(payload.code).toLowerCase()}`,
      ...(typeof payload.departmentId === 'string' ? [`departments:${payload.departmentId}`] : []),
    ];
  if (entityType === 'employees') {
    const keys = [
      `employees:${entityId}`,
      `employee-number:${String(payload.employeeNumber).toLowerCase()}`,
    ];
    if (Array.isArray(payload.employmentVersions))
      for (const version of payload.employmentVersions) {
        if (!version || typeof version !== 'object') return null;
        for (const [field, table] of [
          ['departmentId', 'departments'],
          ['positionId', 'positions'],
        ] as const)
          if (field in version && typeof version[field] === 'string')
            keys.push(`${table}:${version[field]}`);
      }
    return keys;
  }
  if (entityType === 'work_schedules') return [`work_schedules:${entityId}`, 'scheduling'];
  if (entityType === 'work_schedule_versions' && typeof payload.scheduleId === 'string')
    return [
      `work_schedule_versions:${entityId}`,
      `work_schedules:${payload.scheduleId}`,
      'scheduling',
    ];
  if (
    [
      'employee_schedule_assignments',
      'leave_requests',
      'time_records',
      'attendance_records',
    ].includes(entityType) &&
    typeof payload.employeeId === 'string'
  ) {
    const keys = [`${entityType}:${entityId}`, `employees:${payload.employeeId}`];
    if (['employee_schedule_assignments', 'attendance_records'].includes(entityType))
      keys.push('scheduling');
    for (const [field, table] of [
      ['scheduleId', 'work_schedules'],
      ['leaveTypeId', 'leave_types'],
      ['deviceId', 'biometric_devices'],
      ['scheduleAssignmentId', 'employee_schedule_assignments'],
      ['scheduleVersionId', 'work_schedule_versions'],
    ] as const)
      if (typeof payload[field] === 'string') keys.push(`${table}:${payload[field]}`);
    return keys;
  }
  if (entityType === 'leave_types') return [`leave_types:${entityId}`];
  const reference = (name: string, table: string) => {
    const value = payload[name] ?? payload[name.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())];
    return typeof value === 'string' ? [table + ':' + value] : [];
  };
  const refs: Record<string, readonly (readonly [string, string])[]> = {
    payroll_periods: [
      ['latestRunId', 'payroll_runs'],
      ['reviewedRunId', 'payroll_runs'],
    ],
    payroll_runs: [['periodId', 'payroll_periods']],
    employee_payroll_results: [
      ['payrollRunId', 'payroll_runs'],
      ['employeeId', 'employees'],
    ],
    payroll_earning_lines: [['resultId', 'employee_payroll_results']],
    payroll_deduction_lines: [['resultId', 'employee_payroll_results']],
    payroll_contribution_lines: [
      ['resultId', 'employee_payroll_results'],
      ['ruleSetId', 'statutory_rule_sets'],
    ],
    payroll_entries: [
      ['employeeId', 'employees'],
      ['typeId', 'payroll_types'],
      ['periodId', 'payroll_periods'],
    ],
    payroll_types: [],
    payroll_configurations: [],
    biometric_devices: [],
    biometric_mappings: [
      ['employeeId', 'employees'],
      ['deviceId', 'biometric_devices'],
    ],
    time_record_corrections: [['timeRecordId', 'time_records']],
    attendance_adjustments: [['attendanceId', 'attendance_records']],
  };
  if (entityType === 'payroll_runs' && !reference('periodId', 'payroll_periods').length)
    return null;
  if (refs[entityType]) {
    const keys = [
      entityType + ':' + entityId,
      ...refs[entityType].flatMap(([field, table]) => reference(field, table)),
    ];
    if (entityType === 'payroll_runs' && payload.snapshot && typeof payload.snapshot === 'object') {
      const snapshot = payload.snapshot as Record<string, unknown>;
      if (Array.isArray(snapshot.chunkIds))
        for (const id of snapshot.chunkIds) keys.push('snapshot-chunk:' + String(id));
      if (Array.isArray(snapshot.employees))
        for (const item of snapshot.employees) {
          if (item && typeof item === 'object' && 'id' in item)
            keys.push('employees:' + String(item.id));
        }
    }
    return keys;
  }
  // Unknown shapes remain barriers rather than guessing their dependencies.
  return null;
}

const secret = /password|token|credential|secret|authorization|cookie|hash/i;
const sensitive =
  /sss|philhealth|pagibig|(^|_)tin$|basic.?rate|basic.?pay|salary|compensation|amount|centavos|gross|net.?pay|deduction|contribution|tax|totals/i;
export function redact(value: unknown, includeSensitive = false): unknown {
  if (Array.isArray(value)) return value.map((v) => redact(v, includeSensitive));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            (!secret.test(key) ||
              ['inputHash', 'input_hash', 'contentChecksum', 'content_checksum'].includes(key)) &&
            (includeSensitive || !sensitive.test(key)),
        )
        .map(([key, v]) => [key, redact(v, includeSensitive)]),
    );
  return value;
}

const evidenceFields = new Set([
  'id',
  'organizationId',
  'revision',
  'employeeId',
  'employeeNumber',
  'firstName',
  'middleName',
  'lastName',
  'suffix',
  'birthDate',
  'email',
  'mobileNumber',
  'address',
  'barangay',
  'city',
  'province',
  'postalCode',
  'sssNumber',
  'philhealthNumber',
  'pagibigNumber',
  'tin',
  'code',
  'name',
  'description',
  'status',
  'departmentId',
  'positionId',
  'employmentVersions',
  'effectiveFrom',
  'effectiveTo',
  'employmentType',
  'employmentStatus',
  'hireDate',
  'regularizationDate',
  'terminationDate',
  'payType',
  'payFrequency',
  'basicRateCentavos',
  'scheduleId',
  'days',
  'timezone',
  'reason',
  'deviceId',
  'deviceEmployeeId',
  'externalRecordId',
  'recordedAt',
  'recordType',
  'source',
  'timeRecordId',
  'operation',
  'leaveTypeId',
  'startDate',
  'endDate',
  'durationType',
  'remarks',
  'attendanceId',
  'workDate',
  'overrides',
  'result',
  'periodId',
  'periodStart',
  'periodEnd',
  'payrollRunId',
  'finalized',
  'grossPay',
  'netPay',
  'basicPay',
  'totalDeductions',
  'snapshot',
  'lines',
  'earnings',
  'deductions',
  'contributions',
  'amountCentavos',
  'username',
  'displayName',
  'active',
]);
export function safeEvidence(value: Record<string, unknown>): Record<string, unknown> {
  const financialFields = new Set([
    'inputHash',
    'contentChecksum',
    'finalization',
    'ordinaryDeductions',
    'employeeContributions',
    'employerContributions',
    'withholdingTax',
    'taxableCompensation',
    'taxTrace',
    'totals',
    'issues',
    'engineVersion',
    'resultId',
    'typeId',
    'amount',
    'taxable',
    'kind',
    'category',
    'metadata',
    'employeeShare',
    'employerShare',
    'period',
    'employees',
    'policy',
    'rules',
    'latestRunId',
    'reviewedRunId',
    'finalizedAt',
    'correctionOfId',
  ]);
  // Nested domain snapshots and financial traces must retain their complete
  // evidence. Restrict the root projection and strip secrets recursively.
  const result = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => {
        const name = key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
        return evidenceFields.has(name) || financialFields.has(name);
      })
      .map(([key, v]) => [key, redact(v, true)]),
  );
  if (Buffer.byteLength(JSON.stringify(result)) > 262144)
    throw new Error('Conflict evidence exceeds limit');
  return result;
}
