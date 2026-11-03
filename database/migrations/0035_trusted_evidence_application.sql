CREATE TABLE trusted_evidence_applications (
 organization_id uuid NOT NULL, sequence bigint NOT NULL,
 event_id uuid NOT NULL, acceptance_id uuid NOT NULL,
 entity_type text NOT NULL, entity_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
 snapshot_fingerprint text NOT NULL, canonical_snapshot text NOT NULL,
 applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,sequence), UNIQUE(organization_id,event_id), UNIQUE(organization_id,acceptance_id),
 UNIQUE(organization_id,entity_type,entity_id,revision),
 FOREIGN KEY(organization_id,sequence) REFERENCES trusted_evidence_inbox(organization_id,sequence),
 CHECK(snapshot_fingerprint=encode(sha256(convert_to(canonical_snapshot,'UTF8')),'hex'))
);
CREATE TABLE trusted_evidence_application_state (
 organization_id uuid NOT NULL, sequence bigint NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','conflict')),
 attempts integer NOT NULL DEFAULT 1 CHECK(attempts>0), code text NOT NULL,
 last_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(), next_attempt_at timestamptz NOT NULL,
 PRIMARY KEY(organization_id,sequence),
 FOREIGN KEY(organization_id,sequence) REFERENCES trusted_evidence_inbox(organization_id,sequence)
);
CREATE INDEX trusted_evidence_aggregate_order ON trusted_evidence_inbox
 (organization_id,(envelope->>'entityType'),(envelope->>'entityId'),sequence);
CREATE INDEX trusted_evidence_application_retry ON trusted_evidence_application_state
 (organization_id,next_attempt_at) WHERE status='pending';
CREATE FUNCTION hex_trusted_application_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e jsonb;
BEGIN
 SELECT envelope INTO STRICT e FROM trusted_evidence_inbox WHERE organization_id=NEW.organization_id AND sequence=NEW.sequence;
 IF NOT (e @> jsonb_build_object('eventId',NEW.event_id::text,'acceptanceId',NEW.acceptance_id::text,
   'entityType',NEW.entity_type,'entityId',NEW.entity_id::text,'resultingRevision',NEW.revision,
   'snapshotFingerprint',NEW.snapshot_fingerprint)) OR e->'snapshot' IS DISTINCT FROM NEW.canonical_snapshot::jsonb THEN
  RAISE EXCEPTION 'Trusted application receipt binding mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION hex_trusted_application_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Trusted application receipts are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER trusted_application_binding BEFORE INSERT ON trusted_evidence_applications
 FOR EACH ROW EXECUTE FUNCTION hex_trusted_application_binding();
CREATE TRIGGER trusted_application_immutable BEFORE UPDATE OR DELETE ON trusted_evidence_applications
 FOR EACH ROW EXECUTE FUNCTION hex_trusted_application_immutable();
CREATE TRIGGER trusted_application_no_truncate BEFORE TRUNCATE ON trusted_evidence_applications
 FOR EACH STATEMENT EXECUTE FUNCTION hex_trusted_application_immutable();
REVOKE ALL ON trusted_evidence_applications,trusted_evidence_application_state FROM PUBLIC;
REVOKE UPDATE,DELETE,TRUNCATE ON trusted_evidence_applications FROM hexpayroll_app;
GRANT SELECT,INSERT ON trusted_evidence_applications TO hexpayroll_app;
REVOKE DELETE,TRUNCATE ON trusted_evidence_application_state FROM hexpayroll_app;
GRANT SELECT,INSERT,UPDATE ON trusted_evidence_application_state TO hexpayroll_app;
