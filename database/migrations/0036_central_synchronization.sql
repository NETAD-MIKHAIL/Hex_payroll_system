-- Protocol v2 applies business state before publishing a receipt.
ALTER TABLE sync_nodes ADD COLUMN allowed_domains text[] NOT NULL DEFAULT '{}',
 ADD COLUMN credential_rotated_at timestamptz;
ALTER TABLE sync_changes ADD COLUMN base_revision integer NOT NULL DEFAULT 0 CHECK(base_revision>=0),
 ADD COLUMN actor_id uuid;
CREATE TABLE sync_received_events (
 organization_id uuid NOT NULL REFERENCES organizations(id), event_id uuid NOT NULL UNIQUE,
 node_id uuid NOT NULL, request jsonb NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,event_id),
 FOREIGN KEY(organization_id,node_id) REFERENCES sync_nodes(organization_id,id)
);
CREATE TABLE sync_checkpoints (
 organization_id uuid NOT NULL REFERENCES organizations(id), node_id uuid NOT NULL,
 applied_sequence bigint NOT NULL DEFAULT 0 CHECK(applied_sequence>=0),
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,node_id),
 FOREIGN KEY(organization_id,node_id) REFERENCES sync_nodes(organization_id,id)
);
CREATE TABLE sync_history (
 id uuid PRIMARY KEY DEFAULT uuidv7(), organization_id uuid NOT NULL REFERENCES organizations(id),
 node_id uuid NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 pushed integer NOT NULL DEFAULT 0, pulled integer NOT NULL DEFAULT 0,
 accepted integer NOT NULL DEFAULT 0, conflicts integer NOT NULL DEFAULT 0, failed integer NOT NULL DEFAULT 0,
 result text NOT NULL DEFAULT 'running' CHECK(result IN ('running','success','partial','failed','interrupted')),
 FOREIGN KEY(organization_id,node_id) REFERENCES sync_nodes(organization_id,id)
);
CREATE INDEX sync_history_recent_idx ON sync_history(organization_id,started_at DESC,id);
GRANT SELECT,INSERT,UPDATE ON sync_received_events,sync_checkpoints,sync_history TO hexpayroll_app;
GRANT DELETE ON sync_history TO hexpayroll_app;
-- Previously queued credential exports must never enter protocol v2.
UPDATE sync_outbox SET status='rejected',error='Accounts are local; provision separately',
 lease_token=NULL,lease_expires_at=NULL WHERE entity_type='auth_users' AND status NOT IN ('synced','rejected','superseded');
-- actor stubs preserve audit references but cannot authenticate or gain roles.
CREATE TABLE sync_remote_actors (
 organization_id uuid NOT NULL REFERENCES organizations(id), actor_id uuid NOT NULL UNIQUE,
 PRIMARY KEY(organization_id,actor_id), FOREIGN KEY(organization_id,actor_id) REFERENCES auth_users(organization_id,id)
);
GRANT SELECT,INSERT ON sync_remote_actors TO hexpayroll_app;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK(action IN ('CREATE','UPDATE','ARCHIVE','ACTIVATE','DEACTIVATE','LOGIN','LOGOUT','CONFIG_CHANGE','ROLE_CHANGE','CONFLICT_DETECTED','CONFLICT_REVIEWED','CONFLICT_RESOLVED','CONFLICT_REJECTED','CONFLICT_ESCALATED','SYNC_APPLIED','DEVICE_REGISTERED','DEVICE_REVOKED','DEVICE_ROTATED','DEVICE_AUTHORIZED'));
ALTER TABLE sync_changes ADD COLUMN protocol_version integer NOT NULL DEFAULT 1 CHECK(protocol_version IN (1,2));
CREATE INDEX sync_changes_v2_pull_idx ON sync_changes(organization_id,sequence) WHERE protocol_version=2;
CREATE TABLE sync_resolution_proposals (
 organization_id uuid NOT NULL REFERENCES organizations(id), request_id uuid NOT NULL,
 conflict_id uuid NOT NULL, node_id uuid NOT NULL, request jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,request_id),
 FOREIGN KEY(organization_id,conflict_id) REFERENCES sync_conflicts(organization_id,id),
 FOREIGN KEY(organization_id,node_id) REFERENCES sync_nodes(organization_id,id)
);
GRANT SELECT,INSERT ON sync_resolution_proposals TO hexpayroll_app;
-- Preserve proposal evidence while permitting the one-way central confirmation.
GRANT UPDATE(state) ON sync_conflict_resolutions TO hexpayroll_app;
CREATE FUNCTION hex_confirm_sync_resolution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state<>'pending' OR NEW.state<>'confirmed' OR
 (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') THEN
  RAISE EXCEPTION 'Resolution evidence is immutable; only central confirmation is allowed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sync_resolution_confirmation_guard BEFORE UPDATE ON sync_conflict_resolutions FOR EACH ROW EXECUTE FUNCTION hex_confirm_sync_resolution();
ALTER TABLE sync_local_identity ADD COLUMN reference_bootstrap_pending boolean NOT NULL DEFAULT false;
CREATE TABLE sync_snapshot_chunks (
 organization_id uuid NOT NULL REFERENCES organizations(id), id uuid PRIMARY KEY DEFAULT uuidv7(),
 aggregate_id uuid NOT NULL, chunk_index integer NOT NULL CHECK(chunk_index BETWEEN 0 AND 127),
 total integer NOT NULL CHECK(total BETWEEN 1 AND 128), hash char(64) NOT NULL CHECK(hash ~ '^[a-f0-9]{64}$'),
 data text NOT NULL CHECK(octet_length(data)<=174764), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,aggregate_id,hash,chunk_index)
);
GRANT SELECT,INSERT ON sync_snapshot_chunks TO hexpayroll_app;
ALTER TABLE sync_outbox ADD COLUMN delivery_protocol_version integer NOT NULL DEFAULT 1 CHECK(delivery_protocol_version IN (1,2));
ALTER TABLE sync_outbox ALTER COLUMN delivery_protocol_version SET DEFAULT 2;
