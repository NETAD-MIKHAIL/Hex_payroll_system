-- Authorization observations only. This table is never a source of accepted evidence.
CREATE TABLE central_evidence_authorizations (
 decision_id uuid PRIMARY KEY DEFAULT uuidv7(),
 request_id uuid NOT NULL UNIQUE,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 entity_id uuid NOT NULL,
 entity_type text NOT NULL,
 action text NOT NULL,
 expected_revision integer NOT NULL CHECK(expected_revision BETWEEN 0 AND 2147483646),
 request_version integer NOT NULL CHECK(request_version=1),
 canonical_request text NOT NULL,
 payload_fingerprint text NOT NULL CHECK(payload_fingerprint ~ '^[a-f0-9]{64}$'),
 acting_user_id uuid NOT NULL REFERENCES auth_users(id),
 source_node_id uuid NOT NULL,
 permission_code text NOT NULL REFERENCES permissions(code),
 authorized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(organization_id,source_node_id) REFERENCES sync_nodes(organization_id,id),
 FOREIGN KEY(organization_id,acting_user_id) REFERENCES auth_users(organization_id,id),
 CHECK ((action,entity_type,permission_code) IN (
 ('schedule.create','work_schedules','schedules.create'),
 ('schedule.update','work_schedules','schedules.update'),
 ('schedule.status','work_schedules','schedules.update'),
 ('assignment.create','employee_schedule_assignments','schedules.assign'),
 ('assignment.update','employee_schedule_assignments','schedules.assign'),
 ('leaveType.create','leave_types','leave.configure'),
 ('leaveType.update','leave_types','leave.configure'),
 ('leave.request','leave_requests','leave.create'),
 ('leave.approve','leave_requests','leave.approve'),
 ('leave.reject','leave_requests','leave.reject'),
 ('leave.cancel','leave_requests','leave.cancel'))),
 CHECK ((expected_revision=0) = (action IN ('schedule.create','assignment.create','leaveType.create','leave.request'))),
 CHECK (canonical_request::jsonb @> jsonb_build_object(
   'requestId',request_id::text,'organizationId',organization_id::text,
   'entityId',entity_id::text,'action',action,'expectedRevision',expected_revision,
   'version',request_version) AND jsonb_typeof(canonical_request::jsonb->'payload')='object'),
 CHECK (payload_fingerprint=encode(sha256(convert_to(canonical_request,'UTF8')),'hex'))
);
CREATE TRIGGER central_evidence_authorization_immutable BEFORE UPDATE OR DELETE
 ON central_evidence_authorizations FOR EACH ROW EXECUTE FUNCTION hex_central_attendance_append_only();
CREATE TRIGGER central_evidence_authorization_no_truncate BEFORE TRUNCATE
 ON central_evidence_authorizations FOR EACH STATEMENT EXECUTE FUNCTION hex_central_attendance_append_only();
REVOKE ALL ON central_evidence_authorizations FROM PUBLIC;
REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON central_evidence_authorizations FROM hexpayroll_app;
GRANT SELECT,INSERT ON central_evidence_authorizations TO hexpayroll_app;
