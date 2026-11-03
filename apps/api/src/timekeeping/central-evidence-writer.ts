import type { Pool, PoolClient } from 'pg';

export const testEvidenceWriter = 'hexpayroll_acceptance_test_writer';
export const productionEvidenceWriter = 'hexpayroll_evidence_writer';

export async function verifyEvidenceWriter(client: PoolClient) {
  const role = (
    await client.query(`SELECT current_user AS name,session_user AS session_name,current_database() AS database,
    r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,r.rolinherit,r.rolcanlogin,
    has_schema_privilege(current_user,current_schema(),'CREATE') AS can_create,
    EXISTS(SELECT 1 FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relowner=r.oid) AS owns_objects,
    EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS member,
    EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba=r.oid) AS owns_database
    FROM pg_roles r WHERE rolname=current_user`)
  ).rows[0];
  const expected =
    role?.database === 'hexpayroll_test' ? testEvidenceWriter : productionEvidenceWriter;
  if (
    !role ||
    role.name !== expected ||
    role.session_name !== role.name ||
    !role.rolcanlogin ||
    role.rolsuper ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.rolreplication ||
    role.rolbypassrls ||
    role.rolinherit ||
    role.can_create ||
    role.owns_objects ||
    role.member ||
    role.owns_database
  )
    throw new Error('A deliberately provisioned restricted central evidence writer is required');
  if (
    (
      await client.query(
        "SELECT has_column_privilege(current_user,'auth_users','password_hash','SELECT') AS unsafe",
      )
    ).rows[0].unsafe
  )
    throw new Error('Acceptance writer must not read password verifiers');
  // Reject accidental broad grants, in addition to rejecting wrong/DDL-capable roles.
  for (const table of [
    'application_setup',
    'organizations',
    'employees',
    'sync_nodes',
    'auth_users',
    'auth_sessions',
    'roles',
    'user_roles',
    'role_permissions',
    'permissions',
    'central_evidence_authorizations',
  ]) {
    if (
      (
        await client.query('SELECT has_table_privilege(current_user,$1,$2) AS unsafe', [
          table,
          'INSERT,DELETE,TRUNCATE,UPDATE',
        ])
      ).rows[0].unsafe
    )
      throw new Error('Acceptance writer has unexpected authority/transport mutation privileges');
  }
  for (const table of [
    'work_schedule_versions',
    'work_schedule_days',
    'schedule_assignment_history',
    'central_evidence_acceptances',
    'central_evidence_events',
    'central_identity_events',
  ]) {
    if (
      (
        await client.query('SELECT has_table_privilege(current_user,$1,$2) AS unsafe', [
          table,
          'UPDATE,DELETE,TRUNCATE',
        ])
      ).rows[0].unsafe
    )
      throw new Error('Acceptance history/publication writes must remain append-only');
  }
  for (const table of [
    'central_attendance_requests',
    'central_attendance_state',
    'central_attendance_decisions',
    'central_attendance_acceptance_history',
    'sync_changes',
    'sync_outbox',
    'sync_inbox',
  ]) {
    if (
      (
        await client.query('SELECT has_table_privilege(current_user,$1,$2) AS unsafe', [
          table,
          'INSERT,UPDATE,DELETE,TRUNCATE',
        ])
      ).rows[0].unsafe
    )
      throw new Error(
        'Acceptance writer must not mutate canonical attendance or generic transport',
      );
  }
}

/** Explicit administrative setup, never called by acceptance, HTTP or migration runners.
 * Role creation is manual. Only grants in the current, fully migrated schema change. */
export async function provisionCentralEvidenceWriter(database: Pool, expectedDatabase: string) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const identity = (
      await client.query(
        'SELECT current_database() AS database,current_schema() AS schema,current_user AS owner',
      )
    ).rows[0];
    if (
      identity.database !== expectedDatabase ||
      !expectedDatabase ||
      identity.owner === 'hexpayroll_app'
    )
      throw new Error('Explicit central writer provisioning target mismatch');
    const name =
      expectedDatabase === 'hexpayroll_test' ? testEvidenceWriter : productionEvidenceWriter;
    const role = (
      await client.query(
        `SELECT oid,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit,rolcanlogin
      FROM pg_roles WHERE rolname=$1`,
        [name],
      )
    ).rows[0];
    if (
      !role ||
      role.rolsuper ||
      role.rolcreatedb ||
      role.rolcreaterole ||
      role.rolreplication ||
      role.rolbypassrls ||
      role.rolinherit ||
      !role.rolcanlogin ||
      (await client.query('SELECT 1 FROM pg_auth_members WHERE member=$1 OR roleid=$1', [role.oid]))
        .rowCount
    )
      throw new Error('Dedicated evidence writer role is missing or unsafe; provision it manually');
    const ready = await client.query(
      "SELECT 1 FROM central_schema_migrations WHERE name='0005_trusted_identity_publication.sql'",
    );
    if (!ready.rowCount)
      throw new Error('Apply current central migrations before writer provisioning');
    const schema = '"' + String(identity.schema).replaceAll('"', '""') + '"';
    // All object names and roles below are fixed application constants.
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${name}`);
    for (const [table, columns] of [
      ['application_setup', 'singleton'],
      ['organizations', 'id,timezone'],
      ['employees', 'id,organization_id'],
      ['sync_nodes', 'id,organization_id,token_hash,enabled,revoked_at'],
      ['auth_users', 'id,organization_id,active,display_name,revision,created_at,updated_at'],
      ['auth_sessions', 'token_hash,user_id,expires_at'],
      ['roles', 'id,organization_id,system'],
      ['user_roles', 'user_id,role_id'],
      ['role_permissions', 'role_id,permission_code'],
      ['permissions', 'code'],
    ])
      await client.query(`GRANT SELECT(${columns}) ON ${schema}.${table} TO ${name}`);
    const reads = [
      'work_schedules',
      'work_schedule_versions',
      'work_schedule_days',
      'employee_schedule_assignments',
      'schedule_assignment_history',
      'leave_types',
      'leave_requests',
      'central_evidence_authorizations',
      'central_evidence_acceptances',
      'central_evidence_events',
      'central_identity_events',
    ];
    for (const table of reads) await client.query(`GRANT SELECT ON ${schema}.${table} TO ${name}`);
    for (const [table, column] of [
      ['application_setup', 'singleton'],
      ['organizations', 'id'],
      ['employees', 'id'],
      ['sync_nodes', 'id'],
      ['auth_users', 'id'],
      ['auth_sessions', 'token_hash'],
      ['roles', 'id'],
      ['user_roles', 'user_id'],
      ['role_permissions', 'role_id'],
      ['permissions', 'code'],
      ['work_schedule_versions', 'id'],
      ['work_schedule_days', 'id'],
      ['central_evidence_authorizations', 'decision_id'],
      ['central_evidence_acceptances', 'acceptance_id'],
    ])
      await client.query(`GRANT UPDATE(${column}) ON ${schema}.${table} TO ${name}`);
    for (const table of [
      'work_schedules',
      'employee_schedule_assignments',
      'leave_types',
      'leave_requests',
    ])
      await client.query(`GRANT INSERT,UPDATE ON ${schema}.${table} TO ${name}`);
    for (const table of [
      'work_schedule_versions',
      'work_schedule_days',
      'schedule_assignment_history',
      'central_evidence_acceptances',
      'central_evidence_events',
      'central_identity_events',
    ])
      await client.query(`GRANT INSERT ON ${schema}.${table} TO ${name}`);
    await client.query(
      `GRANT USAGE,SELECT ON SEQUENCE ${schema}.central_evidence_events_sequence_seq TO ${name}`,
    );
    await client.query(
      `GRANT USAGE,SELECT ON SEQUENCE ${schema}.central_identity_events_sequence_seq TO ${name}`,
    );
    await client.query(
      `GRANT EXECUTE ON FUNCTION ${schema}.hex_central_identity_sequence() TO ${name}`,
    );
    for (const fn of [
      'hex_evidence_writer_lock_only',
      'hex_validate_evidence_acceptance_contract',
      'hex_trusted_evidence_sequence',
      'hex_central_attendance_append_only',
      'hex_payroll_source_lock',
      'hex_validate_schedule_assignment',
      'hex_validate_leave_overlap',
    ]) {
      // Trigger EXECUTE is checked at creation, but explicit grants document the full capability.
      if (
        (await client.query('SELECT to_regprocedure($1) present', [`${identity.schema}.${fn}()`]))
          .rows[0].present
      )
        await client.query(`GRANT EXECUTE ON FUNCTION ${schema}.${fn}() TO ${name}`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
