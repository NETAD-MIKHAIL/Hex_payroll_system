-- Raw capture is independent of employee mapping and transport acknowledgement.
CREATE TABLE biometric_raw_captures (
 id uuid PRIMARY KEY DEFAULT uuidv7(),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 device_id uuid NOT NULL,
 device_employee_id text NOT NULL,
 recorded_at timestamptz NOT NULL,
 record_type text NOT NULL,
 external_record_id text,
 captured_by uuid NOT NULL REFERENCES auth_users(id),
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(organization_id,device_id) REFERENCES biometric_devices(organization_id,id),
 UNIQUE(device_id,device_employee_id,recorded_at,record_type)
);
CREATE UNIQUE INDEX biometric_raw_external_identity ON biometric_raw_captures(device_id,external_record_id) WHERE external_record_id IS NOT NULL;
CREATE TABLE biometric_capture_batches (
 id uuid PRIMARY KEY DEFAULT uuidv7(),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 device_id uuid NOT NULL,
 captured_by uuid NOT NULL REFERENCES auth_users(id),
 sequence bigint NOT NULL CHECK(sequence>0),
 raw_ids jsonb NOT NULL CHECK(jsonb_typeof(raw_ids)='array' AND jsonb_array_length(raw_ids)>0),
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(organization_id,device_id) REFERENCES biometric_devices(organization_id,id),
 UNIQUE(device_id,sequence)
);
CREATE TABLE biometric_batch_deliveries (
 batch_id uuid PRIMARY KEY REFERENCES biometric_capture_batches(id),
 node_id uuid NOT NULL REFERENCES sync_nodes(id),
 delivered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER biometric_delivery_immutable BEFORE UPDATE OR DELETE ON biometric_batch_deliveries FOR EACH ROW EXECUTE FUNCTION hex_trusted_application_immutable();
CREATE TRIGGER biometric_delivery_no_truncate BEFORE TRUNCATE ON biometric_batch_deliveries FOR EACH STATEMENT EXECUTE FUNCTION hex_trusted_application_immutable();
REVOKE ALL ON biometric_batch_deliveries FROM PUBLIC;
REVOKE UPDATE,DELETE,TRUNCATE ON biometric_batch_deliveries FROM hexpayroll_app;
GRANT SELECT,INSERT ON biometric_batch_deliveries TO hexpayroll_app;
CREATE TRIGGER biometric_raw_immutable BEFORE UPDATE OR DELETE ON biometric_raw_captures FOR EACH ROW EXECUTE FUNCTION hex_trusted_application_immutable();
CREATE TRIGGER biometric_raw_no_truncate BEFORE TRUNCATE ON biometric_raw_captures FOR EACH STATEMENT EXECUTE FUNCTION hex_trusted_application_immutable();
CREATE TRIGGER biometric_batches_immutable BEFORE UPDATE OR DELETE ON biometric_capture_batches FOR EACH ROW EXECUTE FUNCTION hex_trusted_application_immutable();
CREATE TRIGGER biometric_batches_no_truncate BEFORE TRUNCATE ON biometric_capture_batches FOR EACH STATEMENT EXECUTE FUNCTION hex_trusted_application_immutable();
REVOKE ALL ON biometric_raw_captures,biometric_capture_batches FROM PUBLIC;
REVOKE UPDATE,DELETE,TRUNCATE ON biometric_raw_captures,biometric_capture_batches FROM hexpayroll_app;
GRANT SELECT,INSERT ON biometric_raw_captures,biometric_capture_batches TO hexpayroll_app;
