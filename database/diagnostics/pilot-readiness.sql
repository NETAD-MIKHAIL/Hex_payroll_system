\set ON_ERROR_STOP on
\pset pager off
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='2s';
SELECT current_database() database,current_schema() schema,current_user connected_role,
 current_setting('server_version') postgres_version,
 pg_database_size(current_database()) database_bytes,
 current_setting('transaction_read_only') read_only;
SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit,rolcanlogin
 FROM pg_roles WHERE rolname=current_user OR rolname LIKE 'hexpayroll%';
SELECT parent.rolname granted_role,member.rolname member_role
 FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member
 WHERE parent.rolname LIKE 'hexpayroll%' OR member.rolname LIKE 'hexpayroll%';
SELECT table_schema,table_name,grantee,privilege_type FROM information_schema.table_privileges
 WHERE table_schema=current_schema() AND (grantee LIKE 'hexpayroll%' OR grantee='PUBLIC') ORDER BY table_name,grantee,privilege_type;
SELECT table_name,column_name,grantee,privilege_type FROM information_schema.column_privileges
 WHERE table_schema=current_schema() AND grantee LIKE 'hexpayroll%' ORDER BY table_name,column_name,grantee;
SELECT n.nspname schema,r.rolname owner FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname=current_schema();
SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' ORDER BY table_name;
SELECT format('SELECT %L ledger,name,checksum,applied_at FROM %I ORDER BY name',tablename,tablename)
 FROM pg_tables WHERE schemaname=current_schema() AND tablename IN('schema_migrations','central_schema_migrations') ORDER BY tablename
\gexec
-- UUIDs are installation/organization identifiers, not employee records.
SELECT 'SELECT id,organization_id,enabled,revoked_at,last_seen_at,last_pull_sequence FROM sync_nodes ORDER BY id'
 WHERE to_regclass('sync_nodes') IS NOT NULL
\gexec
-- Counts only: never emit payload, error text, raw punches, account hashes or names.
SELECT format('SELECT %L relation,count(*) total FROM %I',tablename,tablename)
 FROM pg_tables WHERE schemaname=current_schema() AND (tablename LIKE 'sync_%' OR tablename LIKE 'trusted_%' OR tablename LIKE 'central_%' OR tablename LIKE 'biometric_%' OR tablename='attendance_desktop_outcomes') ORDER BY tablename
\gexec
SELECT format('SELECT %L relation,%I::text state,count(*) total FROM %I GROUP BY %I ORDER BY %I',table_name,column_name,table_name,column_name,column_name)
 FROM information_schema.columns WHERE table_schema=current_schema() AND column_name IN('status','outcome','code')
 AND table_name IN('sync_outbox','sync_inbox','sync_conflicts','trusted_evidence_application_state','trusted_identity_application_state','trusted_attendance_application_state','biometric_batch_attempts','biometric_closure_attempts','attendance_desktop_outcomes')
 -- Codes may be domain constants, but do not emit free-form conflict text.
 AND column_name<>'code' ORDER BY table_name,column_name
\gexec
SELECT format('SELECT %L relation,count(*) FILTER(WHERE applied_at IS NULL) pending FROM %I',table_name,table_name)
 FROM information_schema.columns WHERE table_schema=current_schema() AND column_name='applied_at' AND table_name='sync_inbox'
\gexec
SELECT format('SELECT %L relation,count(*) pending FROM %I i WHERE NOT EXISTS(SELECT 1 FROM %I a WHERE a.sequence=i.sequence)',i,i,a)
 FROM (VALUES('trusted_evidence_inbox','trusted_evidence_applications'),('trusted_identity_inbox','trusted_identity_applications'),('trusted_attendance_inbox','trusted_attendance_applications')) t(i,a)
 WHERE to_regclass(i) IS NOT NULL AND to_regclass(a) IS NOT NULL
\gexec
SELECT format('SELECT %L relation,%L timestamp_kind,max(%I) latest FROM %I',table_name,column_name,column_name,table_name)
 FROM information_schema.columns WHERE table_schema=current_schema() AND column_name IN('received_at','applied_at','synced_at','attempted_at')
 AND (table_name LIKE 'sync_%' OR table_name LIKE 'trusted_%' OR table_name LIKE 'biometric_%' OR table_name='central_biometric_receipts') ORDER BY table_name,column_name
\gexec
SELECT 'SELECT count(*) configured_scopes FROM attendance_pilot_scope' WHERE to_regclass('attendance_pilot_scope') IS NOT NULL
\gexec
SELECT c.relname table_name,exists(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='pilot_scope' AND t.tgenabled='O') scope_trigger
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=current_schema() AND c.relkind='r' AND c.relname NOT IN('schema_migrations','central_schema_migrations','attendance_pilot_scope') ORDER BY c.relname;
ROLLBACK;
