-- CENTRAL ONLY. Storage invariants, not an acceptance API or calculation engine.
-- No shared attendance tables, sync stream, local proposals or workers are changed.

CREATE TABLE central_attendance_requests (
 proposal_id uuid PRIMARY KEY CHECK(substring(proposal_id::text,15,1)='7'),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 employee_id uuid NOT NULL,
 work_date date NOT NULL CHECK(isfinite(work_date)),
 action text NOT NULL CHECK(action IN ('calculate','adjust','approve','reopen')),
 author_user_id uuid NOT NULL,
 first_submitter_user_id uuid NOT NULL,
 first_source_node_id uuid NOT NULL,
 expected_canonical_revision integer NOT NULL CHECK(expected_canonical_revision>=0),
 proposed_payload jsonb NOT NULL CHECK(jsonb_typeof(proposed_payload)='object' AND octet_length(proposed_payload::text)<=262144),
 evidence_fingerprint text CHECK(evidence_fingerprint ~ '^[0-9a-f]{64}$'),
 request_fingerprint text NOT NULL CHECK(request_fingerprint ~ '^[0-9a-f]{64}$'),
 received_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,employee_id) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,author_user_id) REFERENCES auth_users(organization_id,id),
 FOREIGN KEY(organization_id,first_submitter_user_id) REFERENCES auth_users(organization_id,id),
 FOREIGN KEY(organization_id,first_source_node_id) REFERENCES sync_nodes(organization_id,id),
 UNIQUE(organization_id,proposal_id,employee_id,work_date,action,expected_canonical_revision),
 CHECK(action='calculate' OR expected_canonical_revision>0),
 CHECK(action<>'calculate' OR evidence_fingerprint IS NOT NULL)
);

-- The digest covers immutable business content, not the device/user making a retry.
-- It is a storage fingerprint, not proof that evidence or authorization is valid.
CREATE FUNCTION hex_central_attendance_request_digest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.request_fingerprint=encode(sha256(convert_to(jsonb_build_object(
  'proposalId',NEW.proposal_id,'organizationId',NEW.organization_id,
  'employeeId',NEW.employee_id,'workDate',NEW.work_date,'action',NEW.action,
  'authorUserId',NEW.author_user_id,'expectedCanonicalRevision',NEW.expected_canonical_revision,
  'proposedPayload',NEW.proposed_payload,'evidenceFingerprint',NEW.evidence_fingerprint
 )::text,'UTF8')),'hex');
 NEW.received_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER central_attendance_request_digest BEFORE INSERT ON central_attendance_requests
 FOR EACH ROW EXECUTE FUNCTION hex_central_attendance_request_digest();

CREATE TABLE central_attendance_state (
 canonical_attendance_id uuid PRIMARY KEY DEFAULT uuidv7() CHECK(substring(canonical_attendance_id::text,15,1)='7'),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 employee_id uuid NOT NULL,
 work_date date NOT NULL CHECK(isfinite(work_date)),
 canonical_revision integer NOT NULL CHECK(canonical_revision>0),
 first_in timestamptz,
 last_out timestamptz,
 worked_minutes integer NOT NULL CHECK(worked_minutes BETWEEN 0 AND 1440),
 late_minutes integer NOT NULL CHECK(late_minutes BETWEEN 0 AND 1440),
 undertime_minutes integer NOT NULL CHECK(undertime_minutes BETWEEN 0 AND 1440),
 attendance_status text NOT NULL CHECK(attendance_status IN ('present','late','absent','on_leave','rest_day','incomplete')),
 approval_status text NOT NULL CHECK(approval_status IN ('unreviewed','approved','needs_review')),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object' AND octet_length(result::text)<=262144),
 accepted_evidence_fingerprint text NOT NULL CHECK(accepted_evidence_fingerprint ~ '^[0-9a-f]{64}$'),
 processor_version integer NOT NULL CHECK(processor_version>0),
 approved_by uuid,
 approved_at timestamptz,
 last_proposal_id uuid NOT NULL,
 last_decision_id uuid NOT NULL,
 last_decision_category text NOT NULL DEFAULT 'accepted' CHECK(last_decision_category='accepted'),
 updated_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,employee_id,work_date),
 UNIQUE(organization_id,canonical_attendance_id,employee_id,work_date),
 FOREIGN KEY(organization_id,employee_id) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,updated_by) REFERENCES auth_users(organization_id,id),
 FOREIGN KEY(organization_id,approved_by) REFERENCES auth_users(organization_id,id),
 CHECK(first_in IS NULL OR last_out IS NULL OR last_out>=first_in),
 CHECK((approval_status='approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    OR (approval_status<>'approved' AND approved_by IS NULL AND approved_at IS NULL))
);

CREATE TABLE central_attendance_decisions (
 decision_id uuid PRIMARY KEY DEFAULT uuidv7() CHECK(substring(decision_id::text,15,1)='7'),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 proposal_id uuid NOT NULL,
 employee_id uuid NOT NULL,
 work_date date NOT NULL,
 action text NOT NULL,
 expected_canonical_revision integer NOT NULL CHECK(expected_canonical_revision>=0),
 category text NOT NULL CHECK(category IN ('accepted','duplicate_accepted','conflict','rejected','retryable')),
 reason jsonb NOT NULL CHECK(jsonb_typeof(reason)='object' AND octet_length(reason::text)<=16384
   AND reason ?& ARRAY['code','message','details']
   AND jsonb_typeof(reason->'code')='string' AND length(btrim(reason->>'code'))>0
   AND jsonb_typeof(reason->'message')='string' AND length(btrim(reason->>'message'))>0
   AND jsonb_typeof(reason->'details')='object'),
 canonical_attendance_id uuid,
 resulting_revision integer CHECK(resulting_revision>0),
 current_revision integer CHECK(current_revision>=0),
 actor_user_id uuid NOT NULL,
 source_node_id uuid NOT NULL,
 duplicate_of_decision_id uuid,
 original_category text GENERATED ALWAYS AS (CASE WHEN category='duplicate_accepted' THEN 'accepted'::text ELSE NULL END) STORED,
 acceptance_history_id uuid GENERATED ALWAYS AS (CASE WHEN category='accepted' THEN decision_id ELSE NULL END) STORED,
 decided_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,proposal_id,employee_id,work_date,action,expected_canonical_revision)
   REFERENCES central_attendance_requests(organization_id,proposal_id,employee_id,work_date,action,expected_canonical_revision),
 FOREIGN KEY(organization_id,canonical_attendance_id,employee_id,work_date)
   REFERENCES central_attendance_state(organization_id,canonical_attendance_id,employee_id,work_date)
   DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(organization_id,actor_user_id) REFERENCES auth_users(organization_id,id),
 FOREIGN KEY(organization_id,source_node_id) REFERENCES sync_nodes(organization_id,id),
 UNIQUE(organization_id,decision_id,category,proposal_id,canonical_attendance_id,resulting_revision),
 UNIQUE(organization_id,decision_id,canonical_attendance_id,resulting_revision,proposal_id,actor_user_id),
 CHECK((category IN ('accepted','duplicate_accepted') AND canonical_attendance_id IS NOT NULL
      AND resulting_revision IS NOT NULL AND current_revision IS NOT NULL
      AND resulting_revision::bigint=expected_canonical_revision::bigint+1 AND current_revision>=resulting_revision)
    OR (category NOT IN ('accepted','duplicate_accepted') AND resulting_revision IS NULL)),
 CHECK(category<>'accepted' OR current_revision=resulting_revision),
 CHECK((category='duplicate_accepted' AND duplicate_of_decision_id IS NOT NULL)
    OR (category<>'duplicate_accepted' AND duplicate_of_decision_id IS NULL)),
 CHECK(current_revision IS NULL OR current_revision=0 OR canonical_attendance_id IS NOT NULL)
);
-- Retryable observations do not finalize the immutable request. There is only one
-- terminal disposition; duplicate-accepted observations refer to that acceptance.
CREATE UNIQUE INDEX central_attendance_terminal_request_unique ON central_attendance_decisions(proposal_id)
 WHERE category IN ('accepted','conflict','rejected');
ALTER TABLE central_attendance_decisions ADD CONSTRAINT central_attendance_duplicate_acceptance_fk
 FOREIGN KEY(organization_id,duplicate_of_decision_id,original_category,proposal_id,canonical_attendance_id,resulting_revision)
 REFERENCES central_attendance_decisions(organization_id,decision_id,category,proposal_id,canonical_attendance_id,resulting_revision)
 DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE central_attendance_acceptance_history (
 history_id uuid PRIMARY KEY DEFAULT uuidv7() CHECK(substring(history_id::text,15,1)='7'),
 organization_id uuid NOT NULL,
 canonical_attendance_id uuid NOT NULL,
 proposal_id uuid NOT NULL,
 decision_id uuid NOT NULL,
 actor_user_id uuid NOT NULL,
 old_revision integer NOT NULL CHECK(old_revision>=0),
 new_revision integer NOT NULL CHECK(new_revision>0 AND new_revision::bigint=old_revision::bigint+1),
 action text NOT NULL CHECK(action IN ('calculate','adjust','approve','reopen')),
 old_state jsonb,
 new_state jsonb NOT NULL CHECK(jsonb_typeof(new_state)='object'),
 decision_category text NOT NULL DEFAULT 'accepted' CHECK(decision_category='accepted'),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,decision_id,canonical_attendance_id,new_revision,proposal_id),
 UNIQUE(canonical_attendance_id,new_revision),
 UNIQUE(decision_id),
 FOREIGN KEY(organization_id,decision_id,decision_category,proposal_id,canonical_attendance_id,new_revision)
   REFERENCES central_attendance_decisions(organization_id,decision_id,category,proposal_id,canonical_attendance_id,resulting_revision)
   DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(organization_id,decision_id,canonical_attendance_id,new_revision,proposal_id,actor_user_id)
   REFERENCES central_attendance_decisions(organization_id,decision_id,canonical_attendance_id,resulting_revision,proposal_id,actor_user_id)
   DEFERRABLE INITIALLY DEFERRED,
 CHECK((old_revision=0 AND old_state IS NULL) OR (old_revision>0 AND old_state IS NOT NULL AND jsonb_typeof(old_state)='object'))
);

ALTER TABLE central_attendance_state ADD CONSTRAINT central_attendance_last_decision_fk
 FOREIGN KEY(organization_id,last_decision_id,last_decision_category,last_proposal_id,canonical_attendance_id,canonical_revision)
 REFERENCES central_attendance_decisions(organization_id,decision_id,category,proposal_id,canonical_attendance_id,resulting_revision)
 DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE central_attendance_state ADD CONSTRAINT central_attendance_last_actor_fk
 FOREIGN KEY(organization_id,last_decision_id,canonical_attendance_id,canonical_revision,last_proposal_id,updated_by)
 REFERENCES central_attendance_decisions(organization_id,decision_id,canonical_attendance_id,resulting_revision,proposal_id,actor_user_id)
 DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE central_attendance_decisions ADD CONSTRAINT central_attendance_acceptance_history_fk
 FOREIGN KEY(organization_id,acceptance_history_id,canonical_attendance_id,resulting_revision,proposal_id)
 REFERENCES central_attendance_acceptance_history(organization_id,decision_id,canonical_attendance_id,new_revision,proposal_id)
 DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION hex_guard_central_attendance_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE decision central_attendance_decisions%ROWTYPE; request_fingerprint text;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.canonical_revision<>1 THEN
   RAISE EXCEPTION 'Canonical attendance must start at revision 1' USING ERRCODE='23514';
  END IF;
  NEW.created_at=clock_timestamp();
 ELSE
  IF ROW(NEW.canonical_attendance_id,NEW.organization_id,NEW.employee_id,NEW.work_date,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.canonical_attendance_id,OLD.organization_id,OLD.employee_id,OLD.work_date,OLD.created_at) THEN
   RAISE EXCEPTION 'Canonical attendance identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.canonical_revision::bigint<>OLD.canonical_revision::bigint+1 THEN
   RAISE EXCEPTION 'Canonical revision must advance once' USING ERRCODE='23514';
  END IF;
 END IF;
 SELECT * INTO decision FROM central_attendance_decisions WHERE decision_id=NEW.last_decision_id;
 IF NOT FOUND OR decision.category<>'accepted'
    OR decision.organization_id<>NEW.organization_id OR decision.employee_id<>NEW.employee_id
    OR decision.work_date<>NEW.work_date OR decision.proposal_id<>NEW.last_proposal_id
    OR decision.actor_user_id<>NEW.updated_by OR decision.canonical_attendance_id<>NEW.canonical_attendance_id
    OR decision.resulting_revision<>NEW.canonical_revision THEN
  RAISE EXCEPTION 'Canonical state requires a matching explicit accepted decision' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
  IF decision.expected_canonical_revision<>0 OR decision.action<>'calculate' THEN
   RAISE EXCEPTION 'Initial canonical attendance requires a create-only calculation' USING ERRCODE='23514';
  END IF;
 ELSE
  IF decision.expected_canonical_revision<>OLD.canonical_revision THEN
   RAISE EXCEPTION 'Canonical base revision mismatch' USING ERRCODE='23514';
  END IF;
 END IF;
 SELECT evidence_fingerprint INTO STRICT request_fingerprint FROM central_attendance_requests
  WHERE proposal_id=NEW.last_proposal_id;
 IF request_fingerprint IS NOT NULL AND NEW.accepted_evidence_fingerprint<>request_fingerprint THEN
  RAISE EXCEPTION 'Accepted evidence fingerprint does not match the request' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND request_fingerprint IS NULL
    AND NEW.accepted_evidence_fingerprint<>OLD.accepted_evidence_fingerprint THEN
  RAISE EXCEPTION 'A request without an evidence fingerprint must retain the accepted fingerprint' USING ERRCODE='23514';
 END IF;
 NEW.updated_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER central_attendance_state_guard BEFORE INSERT OR UPDATE ON central_attendance_state
 FOR EACH ROW EXECUTE FUNCTION hex_guard_central_attendance_state();

CREATE FUNCTION hex_record_central_attendance_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE accepted_action text;
BEGIN
 SELECT action INTO STRICT accepted_action FROM central_attendance_decisions WHERE decision_id=NEW.last_decision_id;
 INSERT INTO central_attendance_acceptance_history(organization_id,canonical_attendance_id,
  proposal_id,decision_id,actor_user_id,old_revision,new_revision,action,old_state,new_state)
 VALUES(NEW.organization_id,NEW.canonical_attendance_id,NEW.last_proposal_id,NEW.last_decision_id,
  NEW.updated_by,CASE WHEN TG_OP='INSERT' THEN 0 ELSE OLD.canonical_revision END,
  NEW.canonical_revision,accepted_action,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,to_jsonb(NEW));
 RETURN NEW;
END $$;
CREATE TRIGGER central_attendance_record_acceptance AFTER INSERT OR UPDATE ON central_attendance_state
 FOR EACH ROW EXECUTE FUNCTION hex_record_central_attendance_acceptance();

CREATE FUNCTION hex_guard_central_attendance_history_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state central_attendance_state%ROWTYPE; accepted_action text;
BEGIN
 IF pg_trigger_depth()<2 THEN
  RAISE EXCEPTION 'Acceptance history is generated only by canonical state writes' USING ERRCODE='23514';
 END IF;
 SELECT * INTO STRICT state FROM central_attendance_state WHERE canonical_attendance_id=NEW.canonical_attendance_id;
 SELECT action INTO STRICT accepted_action FROM central_attendance_decisions WHERE decision_id=NEW.decision_id;
 IF NEW.new_state IS DISTINCT FROM to_jsonb(state) OR NEW.action<>accepted_action THEN
  RAISE EXCEPTION 'Acceptance history snapshot mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER central_attendance_history_insert_guard BEFORE INSERT ON central_attendance_acceptance_history
 FOR EACH ROW EXECUTE FUNCTION hex_guard_central_attendance_history_insert();

CREATE FUNCTION hex_central_attendance_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Central attendance evidence is append-only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER central_attendance_request_immutable BEFORE UPDATE OR DELETE ON central_attendance_requests
 FOR EACH ROW EXECUTE FUNCTION hex_central_attendance_append_only();
CREATE TRIGGER central_attendance_request_no_truncate BEFORE TRUNCATE ON central_attendance_requests
 FOR EACH STATEMENT EXECUTE FUNCTION hex_central_attendance_append_only();
CREATE TRIGGER central_attendance_decision_immutable BEFORE UPDATE OR DELETE ON central_attendance_decisions
 FOR EACH ROW EXECUTE FUNCTION hex_central_attendance_append_only();
CREATE TRIGGER central_attendance_decision_no_truncate BEFORE TRUNCATE ON central_attendance_decisions
 FOR EACH STATEMENT EXECUTE FUNCTION hex_central_attendance_append_only();
CREATE TRIGGER central_attendance_history_immutable BEFORE UPDATE OR DELETE ON central_attendance_acceptance_history
 FOR EACH ROW EXECUTE FUNCTION hex_central_attendance_append_only();
CREATE TRIGGER central_attendance_history_no_truncate BEFORE TRUNCATE ON central_attendance_acceptance_history
 FOR EACH STATEMENT EXECUTE FUNCTION hex_central_attendance_append_only();
CREATE TRIGGER central_attendance_state_no_delete BEFORE DELETE ON central_attendance_state
 FOR EACH ROW EXECUTE FUNCTION hex_central_attendance_append_only();
CREATE TRIGGER central_attendance_state_no_truncate BEFORE TRUNCATE ON central_attendance_state
 FOR EACH STATEMENT EXECUTE FUNCTION hex_central_attendance_append_only();

CREATE INDEX central_attendance_scope_idx ON central_attendance_state(organization_id,work_date,employee_id);
CREATE INDEX central_attendance_requests_scope_idx ON central_attendance_requests(organization_id,employee_id,work_date,received_at);
CREATE INDEX central_attendance_decisions_review_idx ON central_attendance_decisions(organization_id,category,decided_at,decision_id);
CREATE INDEX central_attendance_decisions_request_idx ON central_attendance_decisions(proposal_id,decided_at,decision_id);

-- Deliberately closed to existing runtime write paths. Future authenticated
-- acceptance work must explicitly choose/grant a restricted writer boundary.
REVOKE ALL ON central_attendance_requests,central_attendance_decisions,
 central_attendance_state,central_attendance_acceptance_history FROM PUBLIC;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON central_attendance_requests,
 central_attendance_decisions,central_attendance_state,central_attendance_acceptance_history FROM hexpayroll_app;
GRANT SELECT ON central_attendance_requests,central_attendance_decisions,
 central_attendance_state,central_attendance_acceptance_history TO hexpayroll_app;
