ALTER TABLE sync_outbox ADD CONSTRAINT sync_outbox_actor_scope FOREIGN KEY(organization_id,actor_id) REFERENCES auth_users(organization_id,id);
ALTER TABLE sync_conflicts
 ADD CONSTRAINT sync_conflicts_incoming_size CHECK(octet_length(incoming_payload::text)<=262144),
 ADD CONSTRAINT sync_conflicts_current_size CHECK(current_payload IS NULL OR octet_length(current_payload::text)<=262144);
CREATE FUNCTION hex_preserve_conflict_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.organization_id,NEW.node_id,NEW.source_event_id,NEW.entity_type,NEW.entity_id,NEW.incoming_revision,NEW.current_revision,NEW.incoming_payload,NEW.current_payload,NEW.base_revision,NEW.local_event_id,NEW.authority,NEW.conflict_type,NEW.reason,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.organization_id,OLD.node_id,OLD.source_event_id,OLD.entity_type,OLD.entity_id,OLD.incoming_revision,OLD.current_revision,OLD.incoming_payload,OLD.current_payload,OLD.base_revision,OLD.local_event_id,OLD.authority,OLD.conflict_type,OLD.reason,OLD.created_at) THEN
  RAISE EXCEPTION 'Original conflict evidence is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sync_conflict_evidence_guard BEFORE UPDATE ON sync_conflicts FOR EACH ROW EXECUTE FUNCTION hex_preserve_conflict_evidence();
