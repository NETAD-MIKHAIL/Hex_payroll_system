ALTER TABLE sync_conflicts DROP CONSTRAINT sync_conflicts_status_check;
ALTER TABLE sync_conflicts DROP CONSTRAINT sync_conflicts_check;
UPDATE sync_conflicts SET status='dismissed' WHERE status='ignored';
ALTER TABLE sync_conflicts
 ADD COLUMN conflict_type text NOT NULL DEFAULT 'EVENT_IDENTITY' CHECK(conflict_type IN ('UPDATE_UPDATE','UPDATE_ARCHIVE','DUPLICATE_CREATE','STALE_REVISION','MISSING_DEPENDENCY','INVALID_REFERENCE','LEAVE_CONFLICT','SCHEDULE_CONFLICT','PAYROLL_CONFLICT','AUTHORIZATION_CONFLICT','EVENT_IDENTITY')),
 ADD COLUMN base_revision integer CHECK(base_revision>=0),
 ADD COLUMN local_event_id uuid,
 ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0),
 ADD COLUMN authority text NOT NULL DEFAULT 'remote' CHECK(authority IN ('local','remote')),
 ADD COLUMN resolution_state text NOT NULL DEFAULT 'none' CHECK(resolution_state IN ('none','pending','confirmed')),
 ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
 ADD CONSTRAINT sync_conflicts_status_check CHECK(status IN ('open','under_review','resolved','dismissed')),
 ADD CONSTRAINT sync_conflicts_closed_check CHECK((status IN ('open','under_review') AND resolved_at IS NULL AND resolved_by IS NULL) OR (status IN ('resolved','dismissed') AND resolved_at IS NOT NULL)),
 ADD CONSTRAINT sync_conflicts_org_id_unique UNIQUE(organization_id,id);
ALTER TABLE sync_outbox ADD CONSTRAINT sync_outbox_org_id_unique UNIQUE(organization_id,id);
ALTER TABLE sync_conflicts ADD FOREIGN KEY(organization_id,local_event_id) REFERENCES sync_outbox(organization_id,id);
ALTER TABLE sync_conflicts ADD FOREIGN KEY(organization_id,node_id) REFERENCES sync_nodes(organization_id,id);
ALTER TABLE sync_outbox DROP CONSTRAINT sync_outbox_status_check;
ALTER TABLE sync_outbox ADD CONSTRAINT sync_outbox_status_check CHECK(status IN ('pending','processing','synced','failed','conflicted','rejected','superseded'));
ALTER TABLE sync_outbox ADD COLUMN actor_id uuid REFERENCES auth_users(id), ADD COLUMN dependency_keys text[];
CREATE TABLE sync_conflict_resolutions (
 id uuid PRIMARY KEY DEFAULT uuidv7(), organization_id uuid NOT NULL REFERENCES organizations(id), conflict_id uuid NOT NULL,
 request_id uuid NOT NULL, actor_id uuid NOT NULL, resolution text NOT NULL CHECK(resolution IN ('accept_authoritative','reapply_local','manual_merge','reject_mutation','escalate')),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000), state text NOT NULL CHECK(state IN ('pending','confirmed')),
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object' AND octet_length(request::text)<=262144), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,conflict_id) REFERENCES sync_conflicts(organization_id,id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES auth_users(organization_id,id), UNIQUE(organization_id,request_id)
);
CREATE INDEX sync_conflict_history_idx ON sync_conflict_resolutions(organization_id,conflict_id,created_at);
CREATE INDEX sync_conflict_filters_idx ON sync_conflicts(organization_id,status,conflict_type,created_at DESC,id);
CREATE UNIQUE INDEX sync_conflict_event_idx ON sync_conflicts(organization_id,local_event_id) WHERE local_event_id IS NOT NULL;
GRANT SELECT,INSERT ON sync_conflict_resolutions TO hexpayroll_app;
REVOKE UPDATE,DELETE,TRUNCATE ON sync_conflict_resolutions FROM hexpayroll_app;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK(action IN ('CREATE','UPDATE','ARCHIVE','ACTIVATE','DEACTIVATE','LOGIN','LOGOUT','CONFIG_CHANGE','ROLE_CHANGE','CONFLICT_DETECTED','CONFLICT_REVIEWED','CONFLICT_RESOLVED','CONFLICT_REJECTED','CONFLICT_ESCALATED'));
INSERT INTO permissions(code) VALUES('sync.conflicts.view'),('sync.conflicts.resolve'),('sync.conflicts.escalate');
INSERT INTO role_permissions SELECT r.id,p.code FROM roles r CROSS JOIN permissions p WHERE r.code='administrator' AND p.code LIKE 'sync.conflicts.%';
-- Remove credentials from legacy identity-conflict evidence without removing history.
UPDATE sync_conflicts SET incoming_payload=incoming_payload-'password_hash'-'passwordHash'-'token',current_payload=current_payload-'password_hash'-'passwordHash'-'token' WHERE entity_type='auth_users';
