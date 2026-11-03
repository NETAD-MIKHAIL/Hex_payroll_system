-- SELECT FOR SHARE/UPDATE requires UPDATE privilege on at least one column.
-- Restricted writers receive only an identity-column grant on read-only lock
-- dependencies. Prevent those grants from allowing real identity/authority edits.
CREATE FUNCTION hex_evidence_writer_lock_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user IN ('hexpayroll_evidence_writer','hexpayroll_acceptance_test_writer')
    AND NEW IS DISTINCT FROM OLD THEN
   RAISE EXCEPTION 'Acceptance writer may only lock this dependency' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['application_setup','organizations','employees','sync_nodes',
   'auth_users','auth_sessions','roles','user_roles','role_permissions','permissions',
   'work_schedule_versions','work_schedule_days'] LOOP
  EXECUTE format('CREATE TRIGGER evidence_writer_lock_only BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION hex_evidence_writer_lock_only()',t);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION hex_evidence_writer_lock_only() FROM PUBLIC;
