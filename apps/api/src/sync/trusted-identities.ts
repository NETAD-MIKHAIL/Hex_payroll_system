import type { Pool, PoolClient } from 'pg';
import { requireBroadStreamsDisabled } from './pilot-scope.js';
import { canonicalSyncJson } from '@hexpayroll/shared';
import { transaction, databaseErrorCode } from '../foundation/repository.js';
import { tokenHash } from '../auth/service.js';
import { syncRequest, type SyncClientConfig } from './client.js';
import { identityPullSchema, verifyIdentity } from './trusted-identity-protocol.js';

export async function localTrustGate(c: PoolClient, config: SyncClientConfig) {
  if ((await c.query("SELECT to_regclass('central_identity_events') present")).rows[0].present)
    throw new Error('Identity projection is local-only');
  const setup = (await c.query('SELECT organization_id FROM application_setup FOR SHARE')).rows[0];
  const node = (
    await c.query(
      'SELECT organization_id FROM sync_nodes WHERE id=$1 AND token_hash=$2 AND enabled AND revoked_at IS NULL FOR SHARE',
      [config.nodeId, tokenHash(config.token)],
    )
  ).rows[0];
  if (!node || node.organization_id !== setup?.organization_id)
    throw new Error('Local organization enrollment required');
  return node.organization_id as string;
}
export async function pullNextTrustedIdentityBatch(pool: Pool, config: SyncClientConfig) {
  await requireBroadStreamsDisabled(pool);
  const url = new URL(config.url);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new Error('Trusted identity transport requires HTTPS');
  const org = await transaction(pool, (c) => localTrustGate(c, config));
  const after: string =
    (
      await pool.query(
        'SELECT last_sequence::text n FROM trusted_identity_checkpoints WHERE organization_id=$1 AND node_id=$2',
        [org, config.nodeId],
      )
    ).rows[0]?.n ?? '0';
  const page = identityPullSchema.parse(
    await syncRequest(config, 'identities/pull?after=' + after),
  );
  let position = BigInt(after);
  const events = page.changes.map((value) => {
    const event = verifyIdentity(value);
    if (event.organizationId !== org || BigInt(event.sequence) <= position)
      throw new Error('Invalid identity stream');
    position = BigInt(event.sequence);
    return event;
  });
  if (position !== BigInt(page.nextSequence)) throw new Error('Invalid identity cursor');
  await transaction(pool, async (c) => {
    if ((await localTrustGate(c, config)) !== org) throw new Error('Identity enrollment changed');
    await c.query(
      'INSERT INTO trusted_identity_checkpoints(organization_id,node_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [org, config.nodeId],
    );
    const current = (
      await c.query(
        'SELECT last_sequence::text n FROM trusted_identity_checkpoints WHERE organization_id=$1 AND node_id=$2 FOR UPDATE',
        [org, config.nodeId],
      )
    ).rows[0];
    if (current.n !== after) return;
    for (const event of events) {
      const rows = (
        await c.query(
          'SELECT envelope FROM trusted_identity_inbox WHERE organization_id=$1 AND (sequence=$2 OR event_id=$3)',
          [org, event.sequence, event.eventId],
        )
      ).rows;
      if (rows.length) {
        if (rows.length !== 1 || canonicalSyncJson(rows[0].envelope) !== canonicalSyncJson(event))
          throw new Error('Identity replay changed');
      } else
        await c.query(
          'INSERT INTO trusted_identity_inbox(organization_id,sequence,event_id,envelope) VALUES($1,$2,$3,$4)',
          [org, event.sequence, event.eventId, JSON.stringify(event)],
        );
    }
    await c.query(
      'UPDATE trusted_identity_checkpoints SET last_sequence=$3 WHERE organization_id=$1 AND node_id=$2',
      [org, config.nodeId, page.nextSequence],
    );
  });
  return events.length > 0;
}
class IdentityIssue extends Error {
  constructor(
    public status: 'pending' | 'conflict',
    public code: string,
  ) {
    super(code);
  }
}
export async function applyTrustedIdentityBatch(
  pool: Pool,
  config: SyncClientConfig,
  mode: 'local' | 'central' | 'disabled',
) {
  if (mode !== 'local') throw new Error('Identity application is local-only');
  await requireBroadStreamsDisabled(pool);
  return transaction(pool, async (c) => {
    const org = await localTrustGate(c, config);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,731))', [org]);
    const rows = (
      await c.query(
        `SELECT i.sequence::text,i.envelope FROM trusted_identity_inbox i
      LEFT JOIN trusted_identity_applications a USING(organization_id,sequence)
      LEFT JOIN trusted_identity_application_state s USING(organization_id,sequence)
      WHERE i.organization_id=$1 AND a.sequence IS NULL AND (s.sequence IS NULL OR (s.status='pending' AND s.next_attempt_at<=clock_timestamp()))
      AND NOT EXISTS(SELECT 1 FROM trusted_identity_inbox e LEFT JOIN trusted_identity_applications done USING(organization_id,sequence) WHERE e.organization_id=i.organization_id AND e.sequence<i.sequence AND done.sequence IS NULL AND e.envelope->>'userId'=i.envelope->>'userId')
      ORDER BY i.sequence LIMIT 20`,
        [org],
      )
    ).rows;
    const result = { applied: 0, pending: 0, conflicts: 0 };
    for (const entry of rows) {
      await c.query('SAVEPOINT identity_projection');
      try {
        const event = verifyIdentity(entry.envelope),
          snapshot = event.snapshot;
        if (event.organizationId !== org || event.sequence !== entry.sequence)
          throw new IdentityIssue('conflict', 'IDENTITY_BINDING_MISMATCH');
        const prior = (
          await c.query('SELECT * FROM trusted_actor_identities WHERE user_id=$1 FOR UPDATE', [
            event.userId,
          ])
        ).rows[0];
        if (prior && prior.organization_id !== org)
          throw new IdentityIssue('conflict', 'IDENTITY_ORGANIZATION_MISMATCH');
        const revision = prior?.revision ?? 0;
        if (revision < event.expectedRevision)
          throw new IdentityIssue('pending', 'IDENTITY_REVISION_GAP');
        if (
          revision !== event.expectedRevision ||
          (prior && prior.account_revision > snapshot.accountRevision)
        )
          throw new IdentityIssue('conflict', 'IDENTITY_REVISION_CONFLICT');
        const user = (
          await c.query(
            'SELECT id,organization_id,identity_only FROM auth_users WHERE id=$1 FOR UPDATE',
            [event.userId],
          )
        ).rows[0];
        if (user && user.organization_id !== org)
          throw new IdentityIssue('conflict', 'ACTOR_ORGANIZATION_MISMATCH');
        if (!user)
          await c.query(
            `INSERT INTO auth_users(id,organization_id,username,display_name,password_hash,active,identity_only,created_at) VALUES($1,$2,$3,$4,NULL,false,true,$5)`,
            [
              event.userId,
              org,
              'actor_' + event.userId.replaceAll('-', ''),
              snapshot.displayName,
              snapshot.createdAt,
            ],
          );
        else if (user.identity_only)
          await c.query('UPDATE auth_users SET display_name=$2 WHERE id=$1', [
            event.userId,
            snapshot.displayName,
          ]);
        await c.query(
          `INSERT INTO trusted_actor_identities(user_id,organization_id,revision,account_revision,active,display_name,canonical_snapshot,sequence,event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,account_revision=excluded.account_revision,active=excluded.active,display_name=excluded.display_name,canonical_snapshot=excluded.canonical_snapshot,sequence=excluded.sequence,event_id=excluded.event_id WHERE trusted_actor_identities.revision=$10`,
          [
            event.userId,
            org,
            event.resultingRevision,
            snapshot.accountRevision,
            snapshot.active,
            snapshot.displayName,
            canonicalSyncJson(snapshot),
            event.sequence,
            event.eventId,
            event.expectedRevision,
          ],
        );
        await c.query(
          'INSERT INTO trusted_identity_applications(organization_id,sequence,event_id,user_id,revision) VALUES($1,$2,$3,$4,$5)',
          [org, event.sequence, event.eventId, event.userId, event.resultingRevision],
        );
        // Wake durable evidence dependencies without bypassing their normal validation or CAS.
        await c.query(
          "UPDATE trusted_evidence_application_state SET next_attempt_at=clock_timestamp() WHERE organization_id=$1 AND status='pending' AND code='MISSING_TRUSTED_ACTOR'",
          [org],
        );
        await c.query('RELEASE SAVEPOINT identity_projection');
        result.applied++;
      } catch (error) {
        await c.query('ROLLBACK TO SAVEPOINT identity_projection');
        await c.query('RELEASE SAVEPOINT identity_projection');
        const issue =
          error instanceof IdentityIssue
            ? error
            : new IdentityIssue(
                ['23505', '23514'].includes(databaseErrorCode(error)) ? 'conflict' : 'pending',
                'IDENTITY_PROJECTION_FAILED',
              );
        await c.query(
          `INSERT INTO trusted_identity_application_state(organization_id,sequence,status,code,next_attempt_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '2 seconds') ON CONFLICT(organization_id,sequence) DO UPDATE SET status=excluded.status,code=excluded.code,attempts=trusted_identity_application_state.attempts+1,next_attempt_at=clock_timestamp()+make_interval(secs=>LEAST(300,power(2,LEAST(trusted_identity_application_state.attempts+1,8))::integer))`,
          [org, entry.sequence, issue.status, issue.code],
        );
        if (issue.status === 'conflict') result.conflicts++;
        else result.pending++;
      }
    }
    return result;
  });
}
