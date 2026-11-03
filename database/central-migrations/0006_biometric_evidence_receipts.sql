-- Enrollment alone cannot claim a biometric device. Bind devices explicitly at rollout.
CREATE TABLE central_biometric_sources (
 organization_id uuid NOT NULL,
 device_id uuid NOT NULL,
 node_id uuid NOT NULL,
 PRIMARY KEY(organization_id,device_id),
 FOREIGN KEY(organization_id,device_id) REFERENCES biometric_devices(organization_id,id),
 FOREIGN KEY(organization_id,node_id) REFERENCES sync_nodes(organization_id,id)
);
CREATE TRIGGER central_biometric_sources_immutable BEFORE UPDATE OR DELETE ON central_biometric_sources FOR EACH ROW EXECUTE FUNCTION hex_trusted_application_immutable();
CREATE TRIGGER central_biometric_sources_no_truncate BEFORE TRUNCATE ON central_biometric_sources FOR EACH STATEMENT EXECUTE FUNCTION hex_trusted_application_immutable();
CREATE TABLE central_attendance_evidence_reviews (
 request_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 employee_id uuid NOT NULL,
 work_date date NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 operator_id uuid NOT NULL,
 node_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason))>0),
 snapshot jsonb NOT NULL,
 fingerprint text NOT NULL CHECK(length(fingerprint)=64),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,employee_id,work_date,revision),
 FOREIGN KEY(organization_id,employee_id) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,operator_id) REFERENCES auth_users(organization_id,id),
 FOREIGN KEY(organization_id,node_id) REFERENCES sync_nodes(organization_id,id)
);
CREATE TRIGGER central_attendance_review_immutable BEFORE UPDATE OR DELETE ON central_attendance_evidence_reviews FOR EACH ROW EXECUTE FUNCTION hex_trusted_application_immutable();
CREATE TRIGGER central_attendance_review_no_truncate BEFORE TRUNCATE ON central_attendance_evidence_reviews FOR EACH STATEMENT EXECUTE FUNCTION hex_trusted_application_immutable();
REVOKE ALL ON central_attendance_evidence_reviews FROM PUBLIC;
REVOKE UPDATE,DELETE,TRUNCATE ON central_attendance_evidence_reviews FROM hexpayroll_app;
GRANT SELECT,INSERT ON central_attendance_evidence_reviews TO hexpayroll_app;
CREATE TABLE central_biometric_receipts (
 batch_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 device_id uuid NOT NULL,
 node_id uuid NOT NULL,
 sequence bigint NOT NULL CHECK(sequence>0),
 payload jsonb NOT NULL,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,device_id,sequence),
 FOREIGN KEY(organization_id,device_id) REFERENCES central_biometric_sources(organization_id,device_id),
 FOREIGN KEY(organization_id,node_id) REFERENCES sync_nodes(organization_id,id)
);
CREATE TABLE central_biometric_raw_evidence (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 device_id uuid NOT NULL,
 device_employee_id text NOT NULL,
 recorded_at timestamptz NOT NULL,
 record_type text NOT NULL,
 external_record_id text,
 first_batch_id uuid NOT NULL REFERENCES central_biometric_receipts(batch_id),
 UNIQUE(device_id,device_employee_id,recorded_at,record_type),
 FOREIGN KEY(organization_id,device_id) REFERENCES central_biometric_sources(organization_id,device_id)
);
CREATE UNIQUE INDEX central_biometric_external_identity ON central_biometric_raw_evidence(device_id,external_record_id) WHERE external_record_id IS NOT NULL;
CREATE FUNCTION hex_central_biometric_source_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM central_biometric_sources WHERE organization_id=NEW.organization_id AND device_id=NEW.device_id AND node_id=NEW.node_id) THEN
  RAISE EXCEPTION 'Biometric source binding mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER central_biometric_source_binding BEFORE INSERT ON central_biometric_receipts FOR EACH ROW EXECUTE FUNCTION hex_central_biometric_source_binding();
CREATE TRIGGER central_biometric_receipts_immutable BEFORE UPDATE OR DELETE ON central_biometric_receipts FOR EACH ROW EXECUTE FUNCTION hex_trusted_application_immutable();
CREATE TRIGGER central_biometric_receipts_no_truncate BEFORE TRUNCATE ON central_biometric_receipts FOR EACH STATEMENT EXECUTE FUNCTION hex_trusted_application_immutable();
CREATE TRIGGER central_biometric_raw_immutable BEFORE UPDATE OR DELETE ON central_biometric_raw_evidence FOR EACH ROW EXECUTE FUNCTION hex_trusted_application_immutable();
CREATE TRIGGER central_biometric_raw_no_truncate BEFORE TRUNCATE ON central_biometric_raw_evidence FOR EACH STATEMENT EXECUTE FUNCTION hex_trusted_application_immutable();
REVOKE ALL ON central_biometric_sources,central_biometric_receipts,central_biometric_raw_evidence FROM PUBLIC;
REVOKE ALL ON central_biometric_sources,central_biometric_receipts,central_biometric_raw_evidence FROM hexpayroll_app;
GRANT SELECT ON central_biometric_sources TO hexpayroll_app;
GRANT SELECT,INSERT ON central_biometric_receipts,central_biometric_raw_evidence TO hexpayroll_app;
