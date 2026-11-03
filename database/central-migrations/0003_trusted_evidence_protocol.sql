-- Contract only: no acceptance implementation and no runtime acceptance writer.
CREATE TABLE central_evidence_acceptances (
 acceptance_id uuid PRIMARY KEY DEFAULT uuidv7(),
 authorization_decision_id uuid NOT NULL UNIQUE REFERENCES central_evidence_authorizations(decision_id),
 organization_id uuid NOT NULL REFERENCES organizations(id), entity_id uuid NOT NULL,
 entity_type text NOT NULL, action text NOT NULL,
 expected_revision integer NOT NULL CHECK(expected_revision BETWEEN 0 AND 2147483646),
 resulting_revision integer NOT NULL CHECK(resulting_revision=expected_revision+1),
 canonical_snapshot text NOT NULL CHECK(octet_length(canonical_snapshot)<=262144),
 snapshot_fingerprint text NOT NULL CHECK(snapshot_fingerprint=encode(sha256(convert_to(canonical_snapshot,'UTF8')),'hex')),
 audit_snapshot jsonb NOT NULL CHECK(jsonb_typeof(audit_snapshot)='object'),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,entity_type,entity_id,resulting_revision),
 CHECK(acceptance_id<>authorization_decision_id),
 CHECK(canonical_snapshot::jsonb @> jsonb_build_object('id',entity_id::text,'organizationId',organization_id::text,'revision',resulting_revision))
);
CREATE FUNCTION hex_validate_evidence_acceptance_contract() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a central_evidence_authorizations;
BEGIN
 SELECT * INTO STRICT a FROM central_evidence_authorizations WHERE decision_id=NEW.authorization_decision_id FOR SHARE;
 IF (NEW.organization_id,NEW.entity_id,NEW.entity_type,NEW.action,NEW.expected_revision)
   IS DISTINCT FROM (a.organization_id,a.entity_id,a.entity_type,a.action,a.expected_revision) THEN
   RAISE EXCEPTION 'Acceptance authorization binding mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER central_evidence_acceptance_binding BEFORE INSERT ON central_evidence_acceptances
 FOR EACH ROW EXECUTE FUNCTION hex_validate_evidence_acceptance_contract();
CREATE TABLE central_evidence_events (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 event_id uuid NOT NULL DEFAULT uuidv7() UNIQUE,
 acceptance_id uuid NOT NULL UNIQUE REFERENCES central_evidence_acceptances(acceptance_id),
 protocol_version integer NOT NULL DEFAULT 2 CHECK(protocol_version=2),
 origin text NOT NULL DEFAULT 'central.accepted' CHECK(origin='central.accepted')
);
CREATE FUNCTION hex_trusted_evidence_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(684297106);
 NEW.sequence:=nextval(pg_get_serial_sequence(format('%I.central_evidence_events',TG_TABLE_SCHEMA),'sequence'));
 RETURN NEW;
END $$;
CREATE TRIGGER central_evidence_event_sequence BEFORE INSERT ON central_evidence_events
 FOR EACH ROW EXECUTE FUNCTION hex_trusted_evidence_sequence();
CREATE TRIGGER central_evidence_acceptance_immutable BEFORE UPDATE OR DELETE ON central_evidence_acceptances
 FOR EACH ROW EXECUTE FUNCTION hex_central_attendance_append_only();
CREATE TRIGGER central_evidence_acceptance_no_truncate BEFORE TRUNCATE ON central_evidence_acceptances
 FOR EACH STATEMENT EXECUTE FUNCTION hex_central_attendance_append_only();
CREATE TRIGGER central_evidence_event_immutable BEFORE UPDATE OR DELETE ON central_evidence_events
 FOR EACH ROW EXECUTE FUNCTION hex_central_attendance_append_only();
CREATE TRIGGER central_evidence_event_no_truncate BEFORE TRUNCATE ON central_evidence_events
 FOR EACH STATEMENT EXECUTE FUNCTION hex_central_attendance_append_only();
REVOKE ALL ON central_evidence_acceptances,central_evidence_events FROM PUBLIC;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON central_evidence_acceptances,central_evidence_events FROM hexpayroll_app;
REVOKE ALL ON SEQUENCE central_evidence_events_sequence_seq FROM PUBLIC,hexpayroll_app;
GRANT SELECT ON central_evidence_acceptances,central_evidence_events TO hexpayroll_app;
