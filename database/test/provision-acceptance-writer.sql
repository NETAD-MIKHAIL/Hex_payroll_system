-- FOR REVIEW: MANUAL ADMINISTRATION ONLY. Never invoked by migrations or tests.
-- psql -U postgres -d hexpayroll_test -v ON_ERROR_STOP=1 -f this-file.sql
\set ON_ERROR_STOP on
BEGIN;
DO $$
BEGIN
 IF current_database()<>'hexpayroll_test' THEN
   RAISE EXCEPTION 'This provisioning script targets only hexpayroll_test';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hexpayroll_acceptance_test_writer') THEN
   CREATE ROLE hexpayroll_acceptance_test_writer LOGIN NOINHERIT NOSUPERUSER
     NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hexpayroll_acceptance_test_writer'
   AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit OR NOT rolcanlogin))
   OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
     WHERE r.rolname='hexpayroll_acceptance_test_writer')
   OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
     WHERE r.rolname='hexpayroll_acceptance_test_writer')
   OR EXISTS(SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba
     WHERE r.rolname='hexpayroll_acceptance_test_writer')
   OR EXISTS(SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner
     WHERE r.rolname='hexpayroll_acceptance_test_writer')
   OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
     WHERE r.rolname='hexpayroll_acceptance_test_writer')
   OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
     WHERE r.rolname='hexpayroll_acceptance_test_writer') THEN
   RAISE EXCEPTION 'Existing test writer attributes/memberships/ownership are unsafe; review manually';
 END IF;
END $$;
GRANT CONNECT ON DATABASE hexpayroll_test TO hexpayroll_acceptance_test_writer;
ALTER ROLE hexpayroll_acceptance_test_writer SET search_path=pg_catalog;
COMMENT ON ROLE hexpayroll_acceptance_test_writer IS
 'TEST ONLY. No memberships. Per-isolated-schema evidence grants provisioned by fixture owner.';
COMMIT;
-- No password is embedded, changed, or printed here. Set it interactively after review:
--   \password hexpayroll_acceptance_test_writer
-- Configure TEST_ACCEPTANCE_WRITER_DATABASE_URL in untracked apps/api/.env.test.
-- Only per-schema USAGE/SELECT/narrow DML/function/sequence grants are applied later
-- by provisionCentralEvidenceWriter, after central migrations, to each random test schema.
-- PostgreSQL has no per-role DENY overriding PUBLIC CONNECT. For network-level
-- database restriction, place these reviewed pg_hba.conf rules before broad allows:
-- host hexpayroll_test hexpayroll_acceptance_test_writer 127.0.0.1/32 scram-sha-256
-- host hexpayroll_test hexpayroll_acceptance_test_writer ::1/128 scram-sha-256
-- host all hexpayroll_acceptance_test_writer 0.0.0.0/0 reject
-- host all hexpayroll_acceptance_test_writer ::/0 reject
-- Do not revoke PUBLIC privileges cluster-wide as part of this test-only script.
