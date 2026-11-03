ALTER TABLE central_biometric_raw_evidence ADD COLUMN source_identity jsonb;
CREATE UNIQUE INDEX central_source_sequence ON central_biometric_raw_evidence(device_id,(source_identity->>'epoch'),(source_identity->>'sequence')) WHERE source_identity IS NOT NULL;
CREATE UNIQUE INDEX central_source_entry ON central_biometric_raw_evidence(device_id,(source_identity->>'epoch'),(source_identity->>'entryId')) WHERE source_identity IS NOT NULL;
-- Policy/configuration is installed only by reviewed administrative provisioning.
CREATE TABLE central_source_capabilities (
 organization_id uuid NOT NULL,device_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),
 contract text NOT NULL CHECK(contract IN ('signed-inventory-v1','unsupported')),epoch uuid NOT NULL,
 public_key text,assessment jsonb NOT NULL CHECK(jsonb_typeof(assessment)='object'),
 PRIMARY KEY(organization_id,device_id,revision),
 FOREIGN KEY(organization_id,device_id) REFERENCES central_biometric_sources(organization_id,device_id),
 CHECK((contract='signed-inventory-v1')=(public_key IS NOT NULL))
);
CREATE TABLE central_attendance_coverage (
 organization_id uuid NOT NULL,employee_id uuid NOT NULL,effective_from date NOT NULL,revision integer NOT NULL CHECK(revision>0),
 sources jsonb NOT NULL CHECK(jsonb_typeof(sources)='array' AND jsonb_array_length(sources)>0),
 PRIMARY KEY(organization_id,employee_id,revision),FOREIGN KEY(organization_id,employee_id) REFERENCES employees(organization_id,id)
);
CREATE TABLE central_attendance_exception_policies (
 organization_id uuid NOT NULL REFERENCES organizations(id),revision integer NOT NULL CHECK(revision>0),
 allow_limited boolean NOT NULL DEFAULT false,policy_reference text NOT NULL CHECK(length(btrim(policy_reference))>0),
 PRIMARY KEY(organization_id,revision)
);
CREATE TABLE central_source_closures (
 closure_id uuid PRIMARY KEY,organization_id uuid NOT NULL,device_id uuid NOT NULL,capability_revision integer NOT NULL,
 node_id uuid NOT NULL,manifest jsonb NOT NULL,signature text NOT NULL,fingerprint text NOT NULL,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(organization_id,device_id,capability_revision) REFERENCES central_source_capabilities(organization_id,device_id,revision),
 FOREIGN KEY(organization_id,node_id) REFERENCES sync_nodes(organization_id,id)
);
CREATE TABLE central_attendance_certifications (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,employee_id uuid NOT NULL,work_date date NOT NULL,revision integer NOT NULL CHECK(revision>0),
 operator_id uuid NOT NULL,node_id uuid NOT NULL,request jsonb NOT NULL,snapshot jsonb NOT NULL,fingerprint text NOT NULL,
 status text NOT NULL CHECK(status IN ('verified','unresolved')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,employee_id,work_date,revision),FOREIGN KEY(organization_id,employee_id) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,operator_id) REFERENCES auth_users(organization_id,id),FOREIGN KEY(organization_id,node_id) REFERENCES sync_nodes(organization_id,id)
);
CREATE FUNCTION hex_source_closure_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ((NEW.manifest->>'closureId')::uuid,(NEW.manifest->>'organizationId')::uuid,(NEW.manifest->>'deviceId')::uuid,(NEW.manifest->>'capabilityRevision')::integer)
  IS DISTINCT FROM (NEW.closure_id,NEW.organization_id,NEW.device_id,NEW.capability_revision)
  OR NOT EXISTS(SELECT 1 FROM central_biometric_sources WHERE organization_id=NEW.organization_id AND device_id=NEW.device_id AND node_id=NEW.node_id) THEN
  RAISE EXCEPTION 'Source closure manifest identity binding mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_closure_binding BEFORE INSERT ON central_source_closures FOR EACH ROW EXECUTE FUNCTION hex_source_closure_binding();
CREATE TABLE central_attendance_exception_resolutions (
 id uuid PRIMARY KEY,certification_id uuid NOT NULL UNIQUE REFERENCES central_attendance_certifications(id),
 organization_id uuid NOT NULL,operator_id uuid NOT NULL,node_id uuid NOT NULL,request jsonb NOT NULL,
 decision text NOT NULL CHECK(decision IN ('hold','reject','authorize_limited')),limitations jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(organization_id,operator_id) REFERENCES auth_users(organization_id,id),FOREIGN KEY(organization_id,node_id) REFERENCES sync_nodes(organization_id,id)
);
CREATE TABLE central_attendance_events (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,event_id uuid NOT NULL DEFAULT uuidv7() UNIQUE,
 organization_id uuid NOT NULL,canonical_id uuid NOT NULL,canonical_revision integer NOT NULL,
 decision_id uuid NOT NULL UNIQUE REFERENCES central_attendance_decisions(decision_id),snapshot text NOT NULL,fingerprint text NOT NULL,
 UNIQUE(organization_id,canonical_id,canonical_revision)
);
CREATE FUNCTION hex_attendance_input_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_advisory_xact_lock(736614); IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['central_biometric_raw_evidence','biometric_mappings','central_source_capabilities','central_attendance_coverage','central_attendance_exception_policies','central_source_closures'] LOOP
  EXECUTE format('CREATE TRIGGER attendance_input_lock BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION hex_attendance_input_lock()',t);
 END LOOP;
END $$;
CREATE FUNCTION hex_attendance_event_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h central_attendance_acceptance_history;
BEGIN
 SELECT * INTO STRICT h FROM central_attendance_acceptance_history WHERE decision_id=NEW.decision_id;
 IF (h.organization_id,h.canonical_attendance_id,h.new_revision,h.new_state) IS DISTINCT FROM
 (NEW.organization_id,NEW.canonical_id,NEW.canonical_revision,NEW.snapshot::jsonb)
 OR NEW.fingerprint<>encode(sha256(convert_to(NEW.snapshot,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'Attendance publication binding mismatch' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(736615);
 NEW.sequence=nextval(pg_get_serial_sequence(format('%I.central_attendance_events',TG_TABLE_SCHEMA),'sequence'));
 RETURN NEW;
END $$;
CREATE TRIGGER attendance_event_binding BEFORE INSERT ON central_attendance_events FOR EACH ROW EXECUTE FUNCTION hex_attendance_event_binding();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['central_source_capabilities','central_attendance_coverage','central_attendance_exception_policies','central_source_closures','central_attendance_certifications','central_attendance_exception_resolutions','central_attendance_events'] LOOP
  EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION hex_trusted_application_immutable()',t);
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION hex_trusted_application_immutable()',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,hexpayroll_app',t);
  EXECUTE format('GRANT SELECT ON %I TO hexpayroll_app',t);
 END LOOP;
END $$;
GRANT INSERT ON central_source_closures TO hexpayroll_app;
REVOKE ALL ON SEQUENCE central_attendance_events_sequence_seq FROM PUBLIC,hexpayroll_app;
-- Extend the existing lock-only dependency guard, without granting any role.
CREATE OR REPLACE FUNCTION hex_evidence_writer_lock_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user IN ('hexpayroll_evidence_writer','hexpayroll_attendance_writer','hexpayroll_acceptance_test_writer') AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'Acceptance writer may only lock this dependency' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
