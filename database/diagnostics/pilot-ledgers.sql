\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout='20s';
SELECT 'SELECT COALESCE(jsonb_agg(r),''[]''::jsonb) FROM (' || COALESCE(string_agg(
 format('SELECT %L::text ledger,name::text,checksum::text FROM %I',CASE tablename WHEN 'schema_migrations' THEN 'shared' ELSE 'central' END,tablename),' UNION ALL '),
 'SELECT NULL::text ledger,NULL::text name,NULL::text checksum WHERE false') || ') r'
 FROM pg_tables WHERE schemaname=current_schema() AND tablename IN('schema_migrations','central_schema_migrations')
\gexec
ROLLBACK;
