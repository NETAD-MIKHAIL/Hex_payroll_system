-- Transport journal only. These records never authorize local attendance approval.
CREATE TABLE attendance_desktop_requests (
 id uuid PRIMARY KEY CHECK(substring(id::text,15,1)='7'),organization_id uuid NOT NULL,
 employee_id uuid NOT NULL,work_date date NOT NULL,operator_id uuid NOT NULL,
 central_actor_id uuid NOT NULL,action text NOT NULL CHECK(action IN ('certify','exceptions','proposals','finalize','reopen')),
 command jsonb NOT NULL CHECK(octet_length(command::text)<=262144),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(organization_id,employee_id) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,operator_id) REFERENCES auth_users(organization_id,id)
);
CREATE TABLE attendance_desktop_outcomes (
 id uuid PRIMARY KEY DEFAULT uuidv7(),request_id uuid NOT NULL REFERENCES attendance_desktop_requests(id),
 outcome text NOT NULL CHECK(outcome IN ('confirmed','unconfirmed')),result jsonb,code text,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX attendance_desktop_confirmed ON attendance_desktop_outcomes(request_id) WHERE outcome='confirmed';
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['attendance_desktop_requests','attendance_desktop_outcomes'] LOOP
  EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION hex_trusted_application_immutable()',t);
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION hex_trusted_application_immutable()',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE ON %I FROM hexpayroll_app',t);
 END LOOP;
END $$;
