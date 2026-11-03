-- Empty by default. Only the schema owner can install/remove a reviewed scope.
CREATE TABLE attendance_pilot_scope (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 scope jsonb NOT NULL CHECK(jsonb_typeof(scope)='object'),
 installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON attendance_pilot_scope FROM PUBLIC,hexpayroll_app;
GRANT SELECT ON attendance_pilot_scope TO hexpayroll_app;

-- Sync-only runtime needs just an activation bit, not policy/table access.
CREATE FUNCTION hex_pilot_active() RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
 SELECT EXISTS(SELECT 1 FROM attendance_pilot_scope)
$$;
REVOKE ALL ON FUNCTION hex_pilot_active() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hex_pilot_active() TO hexpayroll_app;

CREATE FUNCTION hex_pilot_check_json(value jsonb, scope jsonb) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE k text; v jsonb; allowed text;
BEGIN
 IF jsonb_typeof(value)='object' THEN
  FOR k,v IN SELECT * FROM jsonb_each(value) LOOP
   allowed:=CASE k
    WHEN 'organization_id' THEN 'organizations' WHEN 'organizationId' THEN 'organizations'
    WHEN 'employee_id' THEN 'employees' WHEN 'employeeId' THEN 'employees'
    WHEN 'device_id' THEN 'devices' WHEN 'deviceId' THEN 'devices'
    WHEN 'node_id' THEN 'nodes' WHEN 'nodeId' THEN 'nodes'
    WHEN 'source_node_id' THEN 'nodes' WHEN 'sourceNodeId' THEN 'nodes'
    WHEN 'device_employee_id' THEN 'nativeEmployees' WHEN 'deviceEmployeeId' THEN 'nativeEmployees'
    ELSE NULL END;
   IF allowed IS NOT NULL AND v<>'null'::jsonb AND NOT (scope->allowed @> jsonb_build_array(v)) THEN
    RAISE EXCEPTION 'PILOT_SCOPE_HOLD: %',k USING ERRCODE='23514';
   END IF;
   -- Some trusted snapshots are canonical JSON text, not a jsonb object.
   IF k='snapshot' AND jsonb_typeof(v)='string' THEN
    PERFORM hex_pilot_check_json((v#>>'{}')::jsonb,scope);
   ELSE PERFORM hex_pilot_check_json(v,scope); END IF;
  END LOOP;
 ELSIF jsonb_typeof(value)='array' THEN
  FOR v IN SELECT * FROM jsonb_array_elements(value) LOOP PERFORM hex_pilot_check_json(v,scope); END LOOP;
 END IF;
END $$;

CREATE FUNCTION hex_pilot_row_document(t text, row_data jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
 SELECT row_data || CASE t
 WHEN 'organizations' THEN jsonb_build_object('organization_id',row_data->'id')
 WHEN 'employees' THEN jsonb_build_object('employee_id',row_data->'id')
 WHEN 'biometric_devices' THEN jsonb_build_object('device_id',row_data->'id')
 WHEN 'sync_nodes' THEN jsonb_build_object('node_id',row_data->'id')
 ELSE '{}'::jsonb END
$$;

CREATE FUNCTION hex_pilot_scope_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE s jsonb;
BEGIN
 SELECT scope INTO s FROM attendance_pilot_scope WHERE singleton;
 IF s IS NOT NULL THEN PERFORM hex_pilot_check_json(hex_pilot_row_document(TG_TABLE_NAME,to_jsonb(NEW)),s); END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION hex_pilot_validate_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t record; r record; k text;
BEGIN
 IF (SELECT count(*) FROM jsonb_object_keys(NEW.scope))<>5 THEN RAISE EXCEPTION 'Invalid pilot scope'; END IF;
 FOREACH k IN ARRAY ARRAY['organizations','employees','devices','nodes','nativeEmployees'] LOOP
  IF jsonb_typeof(NEW.scope->k) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.scope->k)=0 THEN
   RAISE EXCEPTION 'Pilot allowlists must be nonempty';
  END IF;
 END LOOP;
 FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname=current_schema() AND c.relkind='r' AND c.relname NOT IN('attendance_pilot_scope','schema_migrations','central_schema_migrations') ORDER BY c.relname LOOP
  EXECUTE format('LOCK TABLE %I IN SHARE ROW EXCLUSIVE MODE',t.relname);
  FOR r IN EXECUTE format('SELECT to_jsonb(t) data FROM %I t',t.relname) LOOP
   BEGIN
    PERFORM hex_pilot_check_json(hex_pilot_row_document(t.relname,r.data),NEW.scope);
   EXCEPTION WHEN check_violation THEN RAISE EXCEPTION 'PILOT_SCOPE_HOLD: table %',t.relname USING ERRCODE='23514'; END;
  END LOOP;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER pilot_validate AFTER INSERT OR UPDATE ON attendance_pilot_scope FOR EACH ROW EXECUTE FUNCTION hex_pilot_validate_scope();

DO $$ DECLARE t record; BEGIN
 EXECUTE format('ALTER FUNCTION hex_pilot_scope_guard() SET search_path=%I,pg_catalog,pg_temp',current_schema());
 EXECUTE format('ALTER FUNCTION hex_pilot_active() SET search_path=%I,pg_catalog,pg_temp',current_schema());
 FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=current_schema() AND c.relkind='r' AND c.relname NOT IN('attendance_pilot_scope','schema_migrations','central_schema_migrations') LOOP
  EXECUTE format('CREATE TRIGGER pilot_scope BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION hex_pilot_scope_guard()',t.relname);
 END LOOP;
END $$;
