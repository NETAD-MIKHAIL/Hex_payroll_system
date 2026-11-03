-- Attribution-only references are deliberately incapable of authenticating.
ALTER TABLE auth_users ADD COLUMN identity_only boolean NOT NULL DEFAULT false;
ALTER TABLE auth_users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE auth_users ADD CONSTRAINT auth_identity_credential_boundary CHECK
 ((identity_only AND password_hash IS NULL AND NOT active) OR (NOT identity_only AND password_hash IS NOT NULL));
CREATE FUNCTION hex_identity_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='auth_users' THEN
  IF NEW.identity_only<>OLD.identity_only OR (OLD.identity_only AND (NEW.id<>OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id)) THEN
   RAISE EXCEPTION 'Attribution identity cannot become an account' USING ERRCODE='23514';
  END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM auth_users WHERE id=NEW.user_id AND identity_only) THEN
   RAISE EXCEPTION 'Attribution identity cannot receive sessions or roles' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER identity_reference_guard BEFORE UPDATE ON auth_users FOR EACH ROW EXECUTE FUNCTION hex_identity_reference_guard();
CREATE TRIGGER identity_role_guard BEFORE INSERT OR UPDATE ON user_roles FOR EACH ROW EXECUTE FUNCTION hex_identity_reference_guard();
CREATE TRIGGER identity_session_guard BEFORE INSERT OR UPDATE ON auth_sessions FOR EACH ROW EXECUTE FUNCTION hex_identity_reference_guard();

CREATE TABLE trusted_identity_checkpoints (
 organization_id uuid NOT NULL,node_id uuid NOT NULL,last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence>=0),
 PRIMARY KEY(organization_id,node_id),FOREIGN KEY(organization_id,node_id) REFERENCES sync_nodes(organization_id,id)
);
CREATE TABLE trusted_identity_inbox (
 organization_id uuid NOT NULL REFERENCES organizations(id),sequence bigint NOT NULL CHECK(sequence>0),event_id uuid NOT NULL,
 envelope jsonb NOT NULL,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,sequence),UNIQUE(organization_id,event_id),
 CHECK(envelope @> jsonb_build_object('protocolVersion',2,'origin','central.identity','organizationId',organization_id::text,'sequence',sequence::text,'eventId',event_id::text))
);
CREATE TABLE trusted_actor_identities (
 user_id uuid PRIMARY KEY REFERENCES auth_users(id),organization_id uuid NOT NULL REFERENCES organizations(id),
 revision integer NOT NULL CHECK(revision>0),account_revision integer NOT NULL CHECK(account_revision>0),
 active boolean NOT NULL,display_name text NOT NULL,canonical_snapshot text NOT NULL,
 sequence bigint NOT NULL,event_id uuid NOT NULL,FOREIGN KEY(organization_id,sequence) REFERENCES trusted_identity_inbox(organization_id,sequence)
);
CREATE TABLE trusted_identity_applications (
 organization_id uuid NOT NULL,sequence bigint NOT NULL,event_id uuid NOT NULL,user_id uuid NOT NULL,revision integer NOT NULL,
 applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(organization_id,sequence),UNIQUE(organization_id,event_id),
 UNIQUE(organization_id,user_id,revision),FOREIGN KEY(organization_id,sequence) REFERENCES trusted_identity_inbox(organization_id,sequence)
);
CREATE TABLE trusted_identity_application_state (
 organization_id uuid NOT NULL,sequence bigint NOT NULL,status text NOT NULL CHECK(status IN ('pending','conflict')),
 code text NOT NULL,attempts integer NOT NULL DEFAULT 1,next_attempt_at timestamptz NOT NULL,
 PRIMARY KEY(organization_id,sequence),FOREIGN KEY(organization_id,sequence) REFERENCES trusted_identity_inbox(organization_id,sequence)
);
CREATE FUNCTION hex_identity_application_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e jsonb;
BEGIN
 SELECT envelope INTO STRICT e FROM trusted_identity_inbox WHERE organization_id=NEW.organization_id AND sequence=NEW.sequence;
 IF NOT (e @> jsonb_build_object('eventId',NEW.event_id::text,'userId',NEW.user_id::text,'resultingRevision',NEW.revision)) THEN
  RAISE EXCEPTION 'Identity receipt binding mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION hex_actor_projection_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e jsonb;
BEGIN
 SELECT envelope INTO STRICT e FROM trusted_identity_inbox WHERE organization_id=NEW.organization_id AND sequence=NEW.sequence;
 IF NOT(e @> jsonb_build_object('eventId',NEW.event_id::text,'userId',NEW.user_id::text,'resultingRevision',NEW.revision))
   OR e->'snapshot' IS DISTINCT FROM NEW.canonical_snapshot::jsonb
   OR NOT(e->'snapshot' @> jsonb_build_object('active',NEW.active,'displayName',NEW.display_name,'accountRevision',NEW.account_revision))
   OR NOT EXISTS(SELECT 1 FROM auth_users WHERE id=NEW.user_id AND organization_id=NEW.organization_id) THEN
  RAISE EXCEPTION 'Actor projection binding mismatch' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.user_id<>OLD.user_id OR NEW.organization_id<>OLD.organization_id OR NEW.revision<>OLD.revision+1 OR NEW.account_revision<OLD.account_revision) THEN
  RAISE EXCEPTION 'Actor projection revision mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER actor_projection_binding BEFORE INSERT OR UPDATE ON trusted_actor_identities FOR EACH ROW EXECUTE FUNCTION hex_actor_projection_binding();
CREATE TRIGGER identity_application_binding BEFORE INSERT ON trusted_identity_applications FOR EACH ROW EXECUTE FUNCTION hex_identity_application_binding();
CREATE TRIGGER identity_inbox_immutable BEFORE UPDATE OR DELETE ON trusted_identity_inbox FOR EACH ROW EXECUTE FUNCTION hex_trusted_application_immutable();
CREATE TRIGGER identity_application_immutable BEFORE UPDATE OR DELETE ON trusted_identity_applications FOR EACH ROW EXECUTE FUNCTION hex_trusted_application_immutable();
CREATE TRIGGER identity_inbox_no_truncate BEFORE TRUNCATE ON trusted_identity_inbox FOR EACH STATEMENT EXECUTE FUNCTION hex_trusted_application_immutable();
CREATE TRIGGER identity_application_no_truncate BEFORE TRUNCATE ON trusted_identity_applications FOR EACH STATEMENT EXECUTE FUNCTION hex_trusted_application_immutable();
REVOKE ALL ON trusted_identity_checkpoints,trusted_identity_inbox,trusted_actor_identities,trusted_identity_applications,trusted_identity_application_state FROM PUBLIC;
REVOKE UPDATE,DELETE,TRUNCATE ON trusted_identity_inbox,trusted_identity_applications FROM hexpayroll_app;
REVOKE DELETE,TRUNCATE ON trusted_actor_identities,trusted_identity_checkpoints,trusted_identity_application_state FROM hexpayroll_app;
GRANT SELECT,INSERT ON trusted_identity_inbox,trusted_identity_applications TO hexpayroll_app;
GRANT SELECT,INSERT,UPDATE ON trusted_actor_identities,trusted_identity_checkpoints,trusted_identity_application_state TO hexpayroll_app;
