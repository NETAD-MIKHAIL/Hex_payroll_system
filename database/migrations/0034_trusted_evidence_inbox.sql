-- Desktop persistence only. Never a source of accepted central decisions.
CREATE TABLE trusted_evidence_checkpoints (
 organization_id uuid NOT NULL, node_id uuid NOT NULL, last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence>=0),
 PRIMARY KEY(organization_id,node_id),
 FOREIGN KEY(organization_id,node_id) REFERENCES sync_nodes(organization_id,id)
);
CREATE TABLE trusted_evidence_inbox (
 organization_id uuid NOT NULL REFERENCES organizations(id), sequence bigint NOT NULL CHECK(sequence>0),
 event_id uuid NOT NULL, acceptance_id uuid NOT NULL, envelope jsonb NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,sequence), UNIQUE(organization_id,event_id), UNIQUE(organization_id,acceptance_id),
 CHECK(envelope @> jsonb_build_object('protocolVersion',2,'origin','central.accepted',
   'organizationId',organization_id::text,'sequence',sequence::text,'eventId',event_id::text,'acceptanceId',acceptance_id::text)),
 CHECK(jsonb_typeof(envelope->'snapshot')='object')
);
REVOKE UPDATE,DELETE,TRUNCATE ON trusted_evidence_inbox FROM hexpayroll_app;
GRANT SELECT,INSERT ON trusted_evidence_inbox TO hexpayroll_app;
GRANT SELECT,INSERT,UPDATE ON trusted_evidence_checkpoints TO hexpayroll_app;
