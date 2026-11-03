ALTER TABLE biometric_raw_captures ADD COLUMN source_identity jsonb;
CREATE UNIQUE INDEX biometric_source_sequence ON biometric_raw_captures(device_id,(source_identity->>'epoch'),(source_identity->>'sequence')) WHERE source_identity IS NOT NULL;
CREATE UNIQUE INDEX biometric_source_entry ON biometric_raw_captures(device_id,(source_identity->>'epoch'),(source_identity->>'entryId')) WHERE source_identity IS NOT NULL;
CREATE TABLE biometric_source_closures (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL,device_id uuid NOT NULL,payload jsonb NOT NULL,
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(organization_id,device_id) REFERENCES biometric_devices(organization_id,id)
);
CREATE TABLE biometric_closure_deliveries (
 closure_id uuid PRIMARY KEY REFERENCES biometric_source_closures(id),node_id uuid NOT NULL REFERENCES sync_nodes(id),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE biometric_closure_attempts (
 id uuid PRIMARY KEY DEFAULT uuidv7(),closure_id uuid NOT NULL REFERENCES biometric_source_closures(id),
 node_id uuid NOT NULL REFERENCES sync_nodes(id),code text NOT NULL,attempted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE trusted_attendance_inbox (
 sequence bigint PRIMARY KEY,event_id uuid NOT NULL UNIQUE,organization_id uuid NOT NULL REFERENCES organizations(id),
 canonical_id uuid NOT NULL,canonical_revision integer NOT NULL CHECK(canonical_revision>0),
 envelope jsonb NOT NULL,UNIQUE(organization_id,canonical_id,canonical_revision)
);
CREATE TABLE trusted_attendance_checkpoints (
 organization_id uuid NOT NULL,node_id uuid NOT NULL,last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence>=0),
 PRIMARY KEY(organization_id,node_id),FOREIGN KEY(organization_id,node_id) REFERENCES sync_nodes(organization_id,id)
);
CREATE TABLE trusted_attendance_applications (
 sequence bigint PRIMARY KEY REFERENCES trusted_attendance_inbox(sequence),applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE trusted_attendance_state (
 canonical_id uuid PRIMARY KEY,organization_id uuid NOT NULL,employee_id uuid NOT NULL,work_date date NOT NULL,
 canonical_revision integer NOT NULL CHECK(canonical_revision>0),sequence bigint NOT NULL UNIQUE REFERENCES trusted_attendance_inbox(sequence),
 snapshot jsonb NOT NULL,UNIQUE(organization_id,employee_id,work_date),
 FOREIGN KEY(organization_id,employee_id) REFERENCES employees(organization_id,id)
);
CREATE TABLE trusted_attendance_application_state (
 sequence bigint PRIMARY KEY REFERENCES trusted_attendance_inbox(sequence),status text NOT NULL CHECK(status IN ('pending','conflict')),
 code text NOT NULL,attempts integer NOT NULL DEFAULT 1,next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION hex_trusted_attendance_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evidence trusted_attendance_inbox; s jsonb;
BEGIN
 SELECT * INTO STRICT evidence FROM trusted_attendance_inbox WHERE sequence=NEW.sequence;
 s=evidence.envelope->'snapshot';
 IF TG_TABLE_NAME='trusted_attendance_state' THEN
  IF (NEW.canonical_id,NEW.organization_id,NEW.employee_id,NEW.work_date,NEW.canonical_revision,NEW.snapshot)
   IS DISTINCT FROM (evidence.canonical_id,evidence.organization_id,(s->>'employee_id')::uuid,(s->>'work_date')::date,evidence.canonical_revision,s) THEN
   RAISE EXCEPTION 'Trusted attendance snapshot binding mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
   IF NEW.canonical_revision<>1 THEN RAISE EXCEPTION 'Trusted attendance initial revision gap' USING ERRCODE='23514'; END IF;
  ELSE
   IF (NEW.canonical_id,NEW.organization_id,NEW.employee_id,NEW.work_date) IS DISTINCT FROM (OLD.canonical_id,OLD.organization_id,OLD.employee_id,OLD.work_date)
    OR NEW.canonical_revision<>OLD.canonical_revision+1 THEN RAISE EXCEPTION 'Trusted attendance revision mismatch' USING ERRCODE='23514'; END IF;
  END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM trusted_attendance_state WHERE canonical_id=evidence.canonical_id AND canonical_revision=evidence.canonical_revision AND sequence=evidence.sequence) THEN
   RAISE EXCEPTION 'Trusted attendance application requires matching projection' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trusted_attendance_projection_binding BEFORE INSERT OR UPDATE ON trusted_attendance_state FOR EACH ROW EXECUTE FUNCTION hex_trusted_attendance_binding();
CREATE TRIGGER trusted_attendance_application_binding BEFORE INSERT ON trusted_attendance_applications FOR EACH ROW EXECUTE FUNCTION hex_trusted_attendance_binding();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['biometric_source_closures','biometric_closure_deliveries','biometric_closure_attempts','trusted_attendance_inbox','trusted_attendance_applications'] LOOP
  EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION hex_trusted_application_immutable()',t);
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION hex_trusted_application_immutable()',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE ON %I FROM hexpayroll_app',t);
 END LOOP;
END $$;
CREATE TRIGGER trusted_attendance_no_delete BEFORE DELETE ON trusted_attendance_state FOR EACH ROW EXECUTE FUNCTION hex_trusted_application_immutable();
CREATE TRIGGER trusted_attendance_no_truncate BEFORE TRUNCATE ON trusted_attendance_state FOR EACH STATEMENT EXECUTE FUNCTION hex_trusted_application_immutable();
REVOKE DELETE,TRUNCATE ON trusted_attendance_state FROM hexpayroll_app;
