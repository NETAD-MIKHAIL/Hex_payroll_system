CREATE TABLE trusted_evidence_reconciliations (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,sequence bigint NOT NULL,operator_id uuid NOT NULL REFERENCES auth_users(id),
 decision text NOT NULL CHECK(decision IN ('preserveLocal','useCentral')),reason text NOT NULL CHECK(length(btrim(reason))>0),
 local_snapshot jsonb,local_fingerprint text NOT NULL,central_snapshot jsonb NOT NULL,central_fingerprint text NOT NULL,
 outbox_snapshot jsonb NOT NULL,competing_snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(organization_id,sequence) REFERENCES trusted_evidence_inbox(organization_id,sequence)
);
CREATE TABLE trusted_evidence_reconciliation_applications (
 reconciliation_id uuid PRIMARY KEY REFERENCES trusted_evidence_reconciliations(id),
 organization_id uuid NOT NULL,sequence bigint NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,sequence),FOREIGN KEY(organization_id,sequence) REFERENCES trusted_evidence_applications(organization_id,sequence)
);
CREATE TABLE trusted_evidence_reconciled_outbox (
 outbox_id uuid PRIMARY KEY REFERENCES sync_outbox(id),reconciliation_id uuid NOT NULL REFERENCES trusted_evidence_reconciliations(id),
 content jsonb NOT NULL
);
CREATE FUNCTION hex_reconciliation_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a trusted_evidence_reconciliations;
BEGIN
 SELECT * INTO STRICT a FROM trusted_evidence_reconciliations WHERE id=NEW.reconciliation_id;
 IF a.decision<>'useCentral' THEN RAISE EXCEPTION 'Reconciliation decision cannot authorize application' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='trusted_evidence_reconciled_outbox' THEN
  IF NOT (a.outbox_snapshot @> jsonb_build_array(NEW.content)) OR NEW.content->>'id'<>NEW.outbox_id::text
     OR NOT EXISTS(SELECT 1 FROM trusted_evidence_applications WHERE organization_id=a.organization_id AND sequence=a.sequence) THEN
   RAISE EXCEPTION 'Reconciled outbox binding mismatch' USING ERRCODE='23514';
  END IF;
 ELSE
  IF a.organization_id<>NEW.organization_id OR a.sequence<>NEW.sequence THEN
   RAISE EXCEPTION 'Reconciliation application binding mismatch' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_application_binding BEFORE INSERT ON trusted_evidence_reconciliation_applications FOR EACH ROW EXECUTE FUNCTION hex_reconciliation_binding();
CREATE TRIGGER reconciled_outbox_binding BEFORE INSERT ON trusted_evidence_reconciled_outbox FOR EACH ROW EXECUTE FUNCTION hex_reconciliation_binding();
CREATE TRIGGER reconciliation_immutable BEFORE UPDATE OR DELETE ON trusted_evidence_reconciliations FOR EACH ROW EXECUTE FUNCTION hex_trusted_application_immutable();
CREATE TRIGGER reconciliation_no_truncate BEFORE TRUNCATE ON trusted_evidence_reconciliations FOR EACH STATEMENT EXECUTE FUNCTION hex_trusted_application_immutable();
CREATE TRIGGER reconciliation_application_immutable BEFORE UPDATE OR DELETE ON trusted_evidence_reconciliation_applications FOR EACH ROW EXECUTE FUNCTION hex_trusted_application_immutable();
CREATE TRIGGER reconciliation_application_no_truncate BEFORE TRUNCATE ON trusted_evidence_reconciliation_applications FOR EACH STATEMENT EXECUTE FUNCTION hex_trusted_application_immutable();
CREATE TRIGGER reconciled_outbox_immutable BEFORE UPDATE OR DELETE ON trusted_evidence_reconciled_outbox FOR EACH ROW EXECUTE FUNCTION hex_trusted_application_immutable();
CREATE TRIGGER reconciled_outbox_no_truncate BEFORE TRUNCATE ON trusted_evidence_reconciled_outbox FOR EACH STATEMENT EXECUTE FUNCTION hex_trusted_application_immutable();
REVOKE ALL ON trusted_evidence_reconciliations,trusted_evidence_reconciliation_applications,trusted_evidence_reconciled_outbox FROM PUBLIC;
REVOKE UPDATE,DELETE,TRUNCATE ON trusted_evidence_reconciliations,trusted_evidence_reconciliation_applications,trusted_evidence_reconciled_outbox FROM hexpayroll_app;
GRANT SELECT,INSERT ON trusted_evidence_reconciliations,trusted_evidence_reconciliation_applications,trusted_evidence_reconciled_outbox TO hexpayroll_app;
