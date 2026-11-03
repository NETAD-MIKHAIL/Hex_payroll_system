import type { Pool, PoolClient } from 'pg';

/** This is a different capability from the Step 73M evidence writer. That
 * writer's verifier continues to reject canonical attendance grants. */
export async function verifyAttendanceWriter(c: PoolClient) {
  const r = (
    await c.query(`SELECT current_user name,session_user session_name,current_database() database,
    rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit,rolcanlogin,
    has_schema_privilege(current_user,current_schema(),'CREATE') can_create,
    EXISTS(SELECT 1 FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relowner=r.oid) owns,
    EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) member,
    EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba=r.oid) owns_database
    FROM pg_roles r WHERE rolname=current_user`)
  ).rows[0];
  const expected =
    r?.database === 'hexpayroll_test'
      ? 'hexpayroll_acceptance_test_writer'
      : 'hexpayroll_attendance_writer';
  if (
    !r ||
    r.name !== expected ||
    r.session_name !== r.name ||
    !r.rolcanlogin ||
    r.rolsuper ||
    r.rolcreatedb ||
    r.rolcreaterole ||
    r.rolreplication ||
    r.rolbypassrls ||
    r.rolinherit ||
    r.can_create ||
    r.owns ||
    r.member ||
    r.owns_database
  )
    throw new Error('A separately provisioned restricted attendance writer is required');
  if (
    (
      await c.query(
        "SELECT has_column_privilege(current_user,'auth_users','password_hash','SELECT') unsafe",
      )
    ).rows[0].unsafe
  )
    throw new Error('Attendance writer cannot read password verifiers');
  for (const table of [
    'auth_users',
    'auth_sessions',
    'sync_nodes',
    'roles',
    'permissions',
    'user_roles',
    'role_permissions',
    'application_setup',
    'employees',
    'organizations',
    'central_source_capabilities',
    'central_attendance_coverage',
    'central_attendance_exception_policies',
  ]) {
    if (
      (
        await c.query('SELECT has_table_privilege(current_user,$1,$2) unsafe', [
          table,
          'INSERT,UPDATE,DELETE,TRUNCATE',
        ])
      ).rows[0].unsafe
    )
      throw new Error('Attendance writer has unexpected authority mutation privileges');
  }
  for (const table of [
    'central_attendance_requests',
    'central_attendance_decisions',
    'central_attendance_acceptance_history',
    'central_attendance_certifications',
    'central_attendance_exception_resolutions',
    'central_attendance_events',
  ]) {
    if (
      (
        await c.query('SELECT has_table_privilege(current_user,$1,$2) unsafe', [
          table,
          'UPDATE,DELETE,TRUNCATE',
        ])
      ).rows[0].unsafe
    )
      throw new Error('Attendance audit must remain append-only');
  }
  for (const table of [
    'sync_outbox',
    'sync_changes',
    'sync_inbox',
    'work_schedules',
    'employee_schedule_assignments',
    'leave_requests',
    'leave_types',
    'central_evidence_acceptances',
    'central_identity_events',
  ]) {
    if (
      (
        await c.query('SELECT has_table_privilege(current_user,$1,$2) unsafe', [
          table,
          'INSERT,UPDATE,DELETE,TRUNCATE',
        ])
      ).rows[0].unsafe
    )
      throw new Error(
        'Attendance writer must not change generic transport or accepted source evidence',
      );
  }
}

/** Explicit administrative command, never invoked by migrations or startup.
 * Existing dedicated test login is reused ONLY inside random test schemas.
 * No CREATE/ALTER ROLE, memberships, owner bypass or production grants run here. */
export async function provisionCentralAttendanceWriter(pool: Pool, expectedDatabase: string) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const db = (
      await c.query('SELECT current_database() database,current_schema() schema,current_user name')
    ).rows[0];
    if (db.database !== expectedDatabase || !expectedDatabase || db.name === 'hexpayroll_app')
      throw new Error('Explicit attendance provisioning target mismatch');
    const role =
      expectedDatabase === 'hexpayroll_test'
        ? 'hexpayroll_acceptance_test_writer'
        : 'hexpayroll_attendance_writer';
    const safe = (
      await c.query(
        'SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit) AND rolcanlogin valid FROM pg_roles WHERE rolname=$1',
        [role],
      )
    ).rows[0];
    if (!safe?.valid) throw new Error('Dedicated attendance writer role is missing or unsafe');
    if (
      !(
        await c.query(
          "SELECT 1 FROM central_schema_migrations WHERE name='0007_source_certification_and_attendance_finalization.sql'",
        )
      ).rowCount
    )
      throw new Error('Current central migrations required');
    const schema = '"' + String(db.schema).replaceAll('"', '""') + '"';
    await c.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    // On the test-only role, remove earlier evidence-writer capabilities in THIS
    // isolated schema before provisioning the distinct attendance capability.
    if (expectedDatabase === 'hexpayroll_test') {
      for (const table of [
        'work_schedules',
        'employee_schedule_assignments',
        'leave_requests',
        'leave_types',
        'work_schedule_versions',
        'work_schedule_days',
        'schedule_assignment_history',
        'central_evidence_acceptances',
        'central_evidence_events',
        'central_identity_events',
      ])
        await c.query(`REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON ${schema}.${table} FROM ${role}`);
      for (const sequence of [
        'central_evidence_events_sequence_seq',
        'central_identity_events_sequence_seq',
      ])
        await c.query(`REVOKE ALL ON SEQUENCE ${schema}.${sequence} FROM ${role}`);
    }
    for (const [table, columns] of [
      ['application_setup', 'singleton'],
      ['organizations', 'id,timezone'],
      ['employees', 'id,organization_id'],
      ['sync_nodes', 'id,organization_id,token_hash,enabled,revoked_at'],
      ['auth_users', 'id,organization_id,active'],
      ['auth_sessions', 'token_hash,user_id,expires_at'],
      ['roles', 'id,organization_id,system'],
      ['user_roles', 'user_id,role_id'],
      ['role_permissions', 'role_id,permission_code'],
      ['permissions', 'code'],
    ])
      await c.query(`GRANT SELECT(${columns}) ON ${schema}.${table} TO ${role}`);
    for (const [table, column] of [
      ['application_setup', 'singleton'],
      ['sync_nodes', 'id'],
      ['auth_users', 'id'],
      ['auth_sessions', 'token_hash'],
      ['roles', 'id'],
      ['user_roles', 'user_id'],
      ['role_permissions', 'role_id'],
      ['permissions', 'code'],
    ])
      await c.query(`GRANT UPDATE(${column}) ON ${schema}.${table} TO ${role}`);
    for (const table of [
      'attendance_pilot_scope',
      'central_biometric_sources',
      'central_biometric_raw_evidence',
      'biometric_mappings',
      'central_source_capabilities',
      'central_attendance_coverage',
      'central_attendance_exception_policies',
      'central_source_closures',
      'central_evidence_acceptances',
    ])
      await c.query(`GRANT SELECT ON ${schema}.${table} TO ${role}`);
    for (const table of [
      'central_attendance_requests',
      'central_attendance_decisions',
      'central_attendance_acceptance_history',
      'central_attendance_certifications',
      'central_attendance_exception_resolutions',
      'central_attendance_events',
    ])
      await c.query(`GRANT SELECT,INSERT ON ${schema}.${table} TO ${role}`);
    await c.query(`GRANT SELECT,INSERT,UPDATE ON ${schema}.central_attendance_state TO ${role}`);
    await c.query(
      `GRANT USAGE,SELECT ON SEQUENCE ${schema}.central_attendance_events_sequence_seq TO ${role}`,
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
