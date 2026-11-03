CREATE TABLE central_identity_events (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,event_id uuid NOT NULL DEFAULT uuidv7() UNIQUE,
 request_id uuid NOT NULL UNIQUE,canonical_request text NOT NULL,
 organization_id uuid NOT NULL REFERENCES organizations(id),user_id uuid NOT NULL REFERENCES auth_users(id),
 expected_revision integer NOT NULL CHECK(expected_revision>=0),resulting_revision integer NOT NULL CHECK(resulting_revision=expected_revision+1),
 account_revision integer NOT NULL CHECK(account_revision>0),
 published_by uuid NOT NULL REFERENCES auth_users(id),source_node_id uuid NOT NULL,
 published_at timestamptz NOT NULL DEFAULT clock_timestamp(),canonical_snapshot text NOT NULL,snapshot_fingerprint text NOT NULL,
 UNIQUE(organization_id,user_id,resulting_revision),
 FOREIGN KEY(organization_id,source_node_id) REFERENCES sync_nodes(organization_id,id),
 CHECK(snapshot_fingerprint=encode(sha256(convert_to(canonical_snapshot,'UTF8')),'hex')),
 CHECK(canonical_snapshot::jsonb @> jsonb_build_object('id',user_id::text,'organizationId',organization_id::text,'revision',resulting_revision,'accountRevision',account_revision)),
 CHECK(canonical_request::jsonb @> jsonb_build_object('version',1,'requestId',request_id::text,'organizationId',organization_id::text,'userId',user_id::text,'expectedRevision',expected_revision,'expectedAccountRevision',account_revision))
);
CREATE FUNCTION hex_central_identity_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_revision integer;
BEGIN
 PERFORM pg_advisory_xact_lock(684297106);
 IF NOT EXISTS(SELECT 1 FROM auth_users WHERE id=NEW.user_id AND organization_id=NEW.organization_id AND revision=NEW.account_revision AND NEW.canonical_snapshot::jsonb @> jsonb_build_object('displayName',display_name,'active',active))
    OR NOT EXISTS(SELECT 1 FROM auth_users WHERE id=NEW.published_by AND organization_id=NEW.organization_id AND active) THEN
  RAISE EXCEPTION 'Central identity organization or account binding mismatch' USING ERRCODE='23514';
 END IF;
 SELECT max(resulting_revision) INTO last_revision FROM central_identity_events WHERE organization_id=NEW.organization_id AND user_id=NEW.user_id;
 IF NEW.expected_revision<>COALESCE(last_revision,0) THEN
  RAISE EXCEPTION 'Identity publication revision conflict' USING ERRCODE='23514';
 END IF;
 NEW.sequence:=nextval(pg_get_serial_sequence(format('%I.central_identity_events',TG_TABLE_SCHEMA),'sequence'));
 RETURN NEW;
END $$;
CREATE TRIGGER central_identity_sequence BEFORE INSERT ON central_identity_events FOR EACH ROW EXECUTE FUNCTION hex_central_identity_sequence();
CREATE TRIGGER central_identity_immutable BEFORE UPDATE OR DELETE ON central_identity_events FOR EACH ROW EXECUTE FUNCTION hex_central_attendance_append_only();
CREATE TRIGGER central_identity_no_truncate BEFORE TRUNCATE ON central_identity_events FOR EACH STATEMENT EXECUTE FUNCTION hex_central_attendance_append_only();
REVOKE ALL ON central_identity_events FROM PUBLIC,hexpayroll_app;
GRANT SELECT ON central_identity_events TO hexpayroll_app;
REVOKE ALL ON SEQUENCE central_identity_events_sequence_seq FROM PUBLIC,hexpayroll_app;
REVOKE ALL ON FUNCTION hex_central_identity_sequence() FROM PUBLIC;
