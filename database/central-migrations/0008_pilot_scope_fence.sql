-- Shared 0041 must exist before central migrations. Cover central-only tables too.
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=current_schema() AND c.relkind='r' AND c.relname<>'central_schema_migrations'
 AND c.relname LIKE 'central_%' AND NOT EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid=c.oid AND g.tgname='pilot_scope') LOOP
  EXECUTE format('CREATE TRIGGER pilot_scope BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION hex_pilot_scope_guard()',t.relname);
 END LOOP;
END $$;
