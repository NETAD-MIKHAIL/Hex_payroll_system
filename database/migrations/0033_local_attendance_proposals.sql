-- Local work only. No canonical attendance, synchronization events or worker hooks.
-- proposal_id is ALSO the immutable future submission/request identity.
CREATE TABLE local_attendance_proposals (
 proposal_id uuid PRIMARY KEY DEFAULT uuidv7() CHECK(substring(proposal_id::text,15,1)='7'),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 employee_id uuid NOT NULL,
 work_date date NOT NULL CHECK(isfinite(work_date)),
 action text NOT NULL CHECK(action IN ('calculate','adjust','approve','reopen')),
 author_user_id uuid NOT NULL,
 expected_canonical_revision integer NOT NULL CHECK(expected_canonical_revision>=0),
 proposed_payload jsonb NOT NULL CHECK(jsonb_typeof(proposed_payload)='object' AND octet_length(proposed_payload::text)<=262144),
 evidence_fingerprint text CHECK(evidence_fingerprint ~ '^[0-9a-f]{64}$'),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','uncertain','retryable','accepted','conflicted','rejected')),
 local_revision integer NOT NULL DEFAULT 1 CHECK(local_revision>0),
 submitted_at timestamptz,
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
 attempt_id uuid CHECK(substring(attempt_id::text,15,1)='7'),
 last_attempt_at timestamptz,
 last_error jsonb CHECK(jsonb_typeof(last_error)='object' AND octet_length(last_error::text)<=16384),
 decision_category text CHECK(decision_category IN ('accepted','conflicted','rejected')),
 decision_reason jsonb CHECK(jsonb_typeof(decision_reason)='object' AND octet_length(decision_reason::text)<=16384),
 server_decision_id uuid,
 decision_request_id uuid CHECK(decision_request_id=proposal_id),
 server_decided_at timestamptz,
 canonical_attendance_id uuid,
 accepted_canonical_revision integer CHECK(accepted_canonical_revision>0),
 current_canonical_revision integer CHECK(current_canonical_revision>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,employee_id) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,author_user_id) REFERENCES auth_users(organization_id,id),
 CHECK(action='calculate' OR expected_canonical_revision>0),
 CHECK(action<>'calculate' OR evidence_fingerprint IS NOT NULL),
 CHECK((status='draft' AND submitted_at IS NULL) OR (status<>'draft' AND submitted_at IS NOT NULL)),
 CHECK((attempt_count=0 AND attempt_id IS NULL AND last_attempt_at IS NULL)
    OR (attempt_count>0 AND attempt_id IS NOT NULL AND last_attempt_at IS NOT NULL)),
 CHECK(status NOT IN ('uncertain','retryable','accepted','conflicted','rejected') OR attempt_count>0),
 CHECK((status IN ('uncertain','retryable') AND last_error IS NOT NULL)
    OR (status NOT IN ('uncertain','retryable') AND last_error IS NULL)),
 CHECK((status IN ('accepted','conflicted','rejected')
      AND decision_category IS NOT NULL AND decision_category=status
      AND decision_reason IS NOT NULL AND server_decision_id IS NOT NULL
      AND decision_request_id IS NOT NULL AND server_decided_at IS NOT NULL)
    OR (status NOT IN ('accepted','conflicted','rejected')
      AND decision_category IS NULL AND decision_reason IS NULL AND server_decision_id IS NULL
      AND decision_request_id IS NULL AND server_decided_at IS NULL
      AND canonical_attendance_id IS NULL AND accepted_canonical_revision IS NULL AND current_canonical_revision IS NULL)),
 CHECK((status='accepted' AND canonical_attendance_id IS NOT NULL
      AND accepted_canonical_revision IS NOT NULL
      AND accepted_canonical_revision::bigint=expected_canonical_revision::bigint+1)
    OR (status<>'accepted' AND accepted_canonical_revision IS NULL))
);
CREATE INDEX local_proposals_scope_idx ON local_attendance_proposals(organization_id,employee_id,work_date,created_at,proposal_id);
CREATE INDEX local_proposals_pending_idx ON local_attendance_proposals(organization_id,status,updated_at,proposal_id);
CREATE INDEX local_proposals_author_idx ON local_attendance_proposals(organization_id,author_user_id,created_at,proposal_id);

CREATE FUNCTION hex_guard_local_attendance_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM application_setup WHERE singleton AND organization_id=NEW.organization_id) THEN
  RAISE EXCEPTION 'Proposal organization is not enrolled' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'draft' OR NEW.local_revision<>1 OR NEW.attempt_count<>0 THEN
   RAISE EXCEPTION 'Proposals must start as unsubmitted drafts' USING ERRCODE='23514';
  END IF;
  NEW.created_at=clock_timestamp(); NEW.updated_at=NEW.created_at;
  RETURN NEW;
 END IF;
 IF OLD.status IN ('accepted','conflicted','rejected') THEN
  RAISE EXCEPTION 'Terminal proposal decisions are immutable' USING ERRCODE='23514';
 END IF;
 IF ROW(NEW.proposal_id,NEW.organization_id,NEW.employee_id,NEW.work_date,NEW.author_user_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.proposal_id,OLD.organization_id,OLD.employee_id,OLD.work_date,OLD.author_user_id,OLD.created_at) THEN
  RAISE EXCEPTION 'Proposal identity and author are immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.local_revision<>OLD.local_revision+1 THEN
  RAISE EXCEPTION 'Proposal local revision must advance once' USING ERRCODE='23514';
 END IF;
 IF OLD.status<>'draft' AND
    ROW(NEW.action,NEW.expected_canonical_revision,NEW.proposed_payload,NEW.evidence_fingerprint,NEW.submitted_at)
    IS DISTINCT FROM ROW(OLD.action,OLD.expected_canonical_revision,OLD.proposed_payload,OLD.evidence_fingerprint,OLD.submitted_at) THEN
  RAISE EXCEPTION 'Submitted proposal content is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.status='draft' THEN
  IF NEW.status NOT IN ('draft','pending') OR NEW.attempt_count<>0 THEN
   RAISE EXCEPTION 'Invalid draft transition' USING ERRCODE='23514';
  END IF;
  IF NEW.status='pending' THEN
   IF ROW(NEW.action,NEW.expected_canonical_revision,NEW.proposed_payload,NEW.evidence_fingerprint)
      IS DISTINCT FROM ROW(OLD.action,OLD.expected_canonical_revision,OLD.proposed_payload,OLD.evidence_fingerprint) THEN
    RAISE EXCEPTION 'Edit the draft separately before queuing' USING ERRCODE='23514';
   END IF;
   NEW.submitted_at=clock_timestamp();
  END IF;
 ELSE
  IF NEW.attempt_count=OLD.attempt_count+1 THEN
   IF NEW.status<>'pending' OR NEW.attempt_id IS NULL OR NEW.attempt_id IS NOT DISTINCT FROM OLD.attempt_id THEN
    RAISE EXCEPTION 'Retry requires a fresh attempt token' USING ERRCODE='23514';
   END IF;
   NEW.last_attempt_at=clock_timestamp();
  ELSIF NEW.attempt_count=OLD.attempt_count THEN
   IF ROW(NEW.attempt_id,NEW.last_attempt_at) IS DISTINCT FROM ROW(OLD.attempt_id,OLD.last_attempt_at)
      OR NOT ((OLD.status='pending' AND NEW.status IN ('uncertain','retryable'))
         OR NEW.status IN ('accepted','conflicted','rejected')) THEN
    RAISE EXCEPTION 'Invalid proposal lifecycle transition' USING ERRCODE='23514';
   END IF;
  ELSE
   RAISE EXCEPTION 'Invalid proposal attempt count' USING ERRCODE='23514';
  END IF;
 END IF;
 NEW.updated_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER local_attendance_proposal_guard BEFORE INSERT OR UPDATE ON local_attendance_proposals
 FOR EACH ROW EXECUTE FUNCTION hex_guard_local_attendance_proposal();
GRANT SELECT,INSERT,UPDATE ON local_attendance_proposals TO hexpayroll_app;
REVOKE DELETE,TRUNCATE ON local_attendance_proposals FROM hexpayroll_app;
