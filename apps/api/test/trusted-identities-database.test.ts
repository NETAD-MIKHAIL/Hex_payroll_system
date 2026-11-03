import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonicalSyncJson } from '@hexpayroll/shared';
import { acceptanceOptions } from './central-evidence-acceptance-fixture.js';
import { identityFixture } from './trusted-identity-fixture.js';
import {
  pullTrustedIdentities,
  createCentralIdentityPublisher,
} from '../src/sync/central-identities.js';
import {
  pullNextTrustedIdentityBatch,
  applyTrustedIdentityBatch,
} from '../src/sync/trusted-identities.js';
import { createAuthService, tokenHash } from '../src/auth/service.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';
import { getActor } from '../src/foundation/repository.js';
import { pushEvents } from '../src/sync/service.js';
import { startTrustedEvidenceWorker } from '../src/sync/trusted-worker.js';

test(
  'enabled real trusted worker installs central identities before recovering evidence on both PCs',
  acceptanceOptions,
  async () => {
    const f = await identityFixture();
    try {
      const id = randomUUID();
      await f.central.commit('leaveType.create', id, 0, f.central.typePayload());
      await f.publish();
      for (const pc of f.pcs) {
        await pc.pull();
        assert.equal((await pc.apply()).pending, 1);
        let warnings = 0;
        const worker = startTrustedEvidenceWorker(
          pc.runtime,
          pc.config,
          { mode: 'local', enabled: true, interval: 300000 },
          () => {
            warnings++;
          },
        );
        try {
          await worker.tick();
        } finally {
          await worker.stop();
        }
        assert.equal(warnings, 0);
        assert.equal(
          (await pc.runtime.query('SELECT updated_by FROM leave_types WHERE id=$1', [id])).rows[0]
            .updated_by,
          f.central.user,
        );
        assert.equal(
          (await pc.runtime.query('SELECT count(*)::int n FROM trusted_identity_applications'))
            .rows[0].n,
          1,
        );
        assert.equal(
          (await pc.runtime.query('SELECT count(*)::int n FROM trusted_evidence_applications'))
            .rows[0].n,
          1,
        );
      }
    } finally {
      await f.close();
    }
  },
);

test(
  'identity publication and pull reauthenticate revoked nodes, sessions and issuing users',
  acceptanceOptions,
  async () => {
    const f = await identityFixture();
    try {
      const c = f.central;
      await c.runtime.query('UPDATE sync_nodes SET enabled=false,revoked_at=now() WHERE id=$1', [
        c.node,
      ]);
      await assert.rejects(f.publish());
      await c.runtime.query('UPDATE sync_nodes SET enabled=true,revoked_at=NULL WHERE id=$1', [
        c.node,
      ]);
      await c.runtime.query('UPDATE auth_users SET active=false WHERE id=$1', [f.issuer]);
      await assert.rejects(f.publish());
      await c.runtime.query('UPDATE auth_users SET active=true WHERE id=$1', [f.issuer]);
      await c.runtime.query('DELETE FROM auth_sessions WHERE token_hash=$1', [
        tokenHash(f.credentials.sessionToken),
      ]);
      await assert.rejects(f.publish());
      assert.equal(
        (await c.runtime.query('SELECT count(*)::int n FROM central_identity_events')).rows[0].n,
        0,
      );
      const pc = f.pcs[0]!;
      await c.runtime.query('UPDATE sync_nodes SET enabled=false,revoked_at=now() WHERE id=$1', [
        pc.config.nodeId,
      ]);
      await assert.rejects(pullTrustedIdentities(c.runtime, pc.config.token, '0'));
    } finally {
      await f.close();
    }
  },
);

test(
  'identity gaps defer, organization collisions conflict, and another PC applies every revision in order',
  acceptanceOptions,
  async () => {
    const f = await identityFixture();
    try {
      await f.publish();
      await f.central.runtime.query(
        "UPDATE auth_users SET display_name='Central revised actor',revision=2,updated_at=clock_timestamp() WHERE id=$1",
        [f.central.user],
      );
      await f.publish(1, 2);
      const pc = f.pcs[0]!,
        page = await pullTrustedIdentities(f.central.runtime, pc.config.token, '0');
      f.override({ ...page, changes: page.changes.slice(1) });
      await pullNextTrustedIdentityBatch(pc.runtime, pc.config);
      assert.equal((await applyTrustedIdentityBatch(pc.runtime, pc.config, 'local')).pending, 1);
      assert.equal(
        (await pc.runtime.query('SELECT code FROM trusted_identity_application_state')).rows[0]
          .code,
        'IDENTITY_REVISION_GAP',
      );
      f.override(undefined);
      const other = f.pcs[1]!;
      assert.equal((await other.identities()).applied, 2);
      assert.equal(
        (await other.runtime.query('SELECT revision,display_name FROM trusted_actor_identities'))
          .rows[0].revision,
        2,
      );
      // A foreign-organization actor collision is never moved into the enrolled organization.
      await pc.runtime.query("INSERT INTO organizations(id,legal_name) VALUES($1,'Foreign')", [
        f.central.foreignOrg,
      ]);
      const issuerRequest = f.request(0, 1, f.issuer);
      await f.publisher(f.credentials, issuerRequest);
      await pc.runtime.query(
        "INSERT INTO auth_users(id,organization_id,username,display_name,password_hash) VALUES($1,$2,'foreign','Foreign',$3)",
        [f.issuer, f.central.foreignOrg, DUMMY_PASSWORD_HASH],
      );
      await pullNextTrustedIdentityBatch(pc.runtime, pc.config);
      assert.equal((await applyTrustedIdentityBatch(pc.runtime, pc.config, 'local')).conflicts, 1);
      assert.equal(
        (await pc.runtime.query('SELECT organization_id FROM auth_users WHERE id=$1', [f.issuer]))
          .rows[0].organization_id,
        f.central.foreignOrg,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'identity publication rollback and competing CAS requests leave one durable immutable winner',
  acceptanceOptions,
  async () => {
    const f = await identityFixture();
    try {
      const c = f.central,
        request = f.request();
      await c.migrator.query(
        "CREATE FUNCTION fail_identity_publication_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected publication failure'; END $$",
      );
      await c.migrator.query(
        'CREATE TRIGGER fail_identity_publication AFTER INSERT ON central_identity_events FOR EACH ROW EXECUTE FUNCTION fail_identity_publication_test()',
      );
      await assert.rejects(f.publisher(f.credentials, request));
      assert.equal(
        (await c.runtime.query('SELECT count(*)::int n FROM central_identity_events')).rows[0].n,
        0,
      );
      await c.migrator.query('DROP TRIGGER fail_identity_publication ON central_identity_events');
      const outcomes = await Promise.allSettled([
        f.publisher(f.credentials, request),
        f.publisher(f.credentials, f.request()),
      ]);
      assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(
        (await c.runtime.query('SELECT count(*)::int n FROM central_identity_events')).rows[0].n,
        1,
      );
      // Altered source content without a central account revision is not publishable.
      await c.runtime.query("UPDATE auth_users SET display_name='Unrevisioned edit' WHERE id=$1", [
        c.user,
      ]);
      await assert.rejects(f.publish(1, 1));
    } finally {
      await f.close();
    }
  },
);

test(
  'trusted identities unblock real central evidence on two independent PCs without credentials, sessions, roles or outbox echo',
  acceptanceOptions,
  async () => {
    const f = await identityFixture();
    try {
      const c = f.central,
        id = randomUUID();
      await c.commit('schedule.create', id, 0, c.schedulePayload());
      for (const pc of f.pcs) {
        await pc.pull();
        assert.equal((await pc.apply()).pending, 1);
      }
      await f.publish();
      const stream = await pullTrustedIdentities(c.runtime, f.pcs[0]!.config.token, '0');
      assert.equal(JSON.stringify(stream).includes('password'), false);
      assert.equal(JSON.stringify(stream).includes('sessionToken'), false);
      assert.deepEqual(Object.keys(stream.changes[0]!.snapshot).sort(), [
        'accountRevision',
        'active',
        'createdAt',
        'displayName',
        'id',
        'organizationId',
        'revision',
        'updatedAt',
      ]);
      for (const pc of f.pcs) {
        assert.equal((await pc.identities()).applied, 1);
        assert.equal((await pc.apply()).applied, 1);
        const user = (
          await pc.runtime.query(
            'SELECT password_hash,active,identity_only FROM auth_users WHERE id=$1',
            [c.user],
          )
        ).rows[0];
        assert.deepEqual(user, { password_hash: null, active: false, identity_only: true });
        assert.equal(
          (await pc.runtime.query('SELECT 1 FROM user_roles WHERE user_id=$1', [c.user])).rowCount,
          0,
        );
        assert.equal(
          (await pc.runtime.query('SELECT count(*)::int n FROM sync_outbox')).rows[0].n,
          0,
        );
        assert.equal(
          (await pc.runtime.query("SELECT to_regclass('central_identity_events') present")).rows[0]
            .present,
          null,
        );
        await assert.rejects(getActor(pc.runtime, c.user));
        await assert.rejects(
          pc.runtime.query(
            'UPDATE auth_users SET active=true,password_hash=$2,identity_only=false WHERE id=$1',
            [c.user, DUMMY_PASSWORD_HASH],
          ),
        );
        await assert.rejects(
          pc.runtime.query(
            "INSERT INTO user_roles SELECT $1,id FROM roles WHERE code='administrator'",
            [c.user],
          ),
        );
        await assert.rejects(
          pc.runtime.query(
            "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
            ['a'.repeat(64), c.user],
          ),
        );
      }
      assert.equal(
        canonicalSyncJson(
          (await f.pcs[0]!.runtime.query('SELECT id,revision FROM work_schedules')).rows,
        ),
        canonicalSyncJson(
          (await f.pcs[1]!.runtime.query('SELECT id,revision FROM work_schedules')).rows,
        ),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'identity publication uses current central permissions, exact revisions, immutable requests and restricted writer only',
  acceptanceOptions,
  async () => {
    const f = await identityFixture();
    try {
      const c = f.central,
        request = f.request();
      for (const pool of [c.runtime, c.migrator])
        await assert.rejects(
          createCentralIdentityPublisher(pool, 'central')(f.credentials, request),
        );
      await assert.rejects(f.publisher({ ...f.credentials, userId: c.user }, request));
      await assert.rejects(
        f.publisher(f.credentials, { ...request, displayName: 'Forged', active: true }),
      );
      await assert.rejects(f.publisher(f.credentials, { ...request, expectedAccountRevision: 99 }));
      await assert.rejects(f.publisher(c.credentials, request)); // evidence permissions do not grant users.update
      const [a, b] = await Promise.all([
        f.publisher(f.credentials, request),
        f.publisher(f.credentials, request),
      ]);
      assert.deepEqual(a, b);
      await assert.rejects(f.publisher(f.credentials, { ...request, expectedRevision: 1 }));
      await assert.rejects(
        f.publisher(f.credentials, { ...f.request(0), organizationId: c.foreignOrg }),
      );
      await c.runtime.query('DELETE FROM user_roles WHERE user_id=$1', [f.issuer]);
      await assert.rejects(f.publisher(f.credentials, request));
      assert.equal(
        (await c.runtime.query('SELECT count(*)::int n FROM central_identity_events')).rows[0].n,
        1,
      );
      await assert.rejects(
        c.runtime.query(
          'INSERT INTO central_identity_events SELECT * FROM central_identity_events',
        ),
      );
      await assert.rejects(
        c.migrator.query('UPDATE central_identity_events SET resulting_revision=3'),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'received central deactivation blocks future local actions while preserving historical actor attribution; activation grants no login',
  acceptanceOptions,
  async () => {
    const f = await identityFixture();
    try {
      const c = f.central,
        pc = f.pcs[0]!,
        type = randomUUID();
      // An already-provisioned credential account is kept intact; distribution does not replace its verifier or roles.
      await pc.runtime.query(
        "INSERT INTO auth_users(id,organization_id,username,display_name,password_hash) VALUES($1,$2,'existing','Existing',$3)",
        [c.user, c.org, DUMMY_PASSWORD_HASH],
      );
      await pc.runtime.query(
        "INSERT INTO user_roles SELECT $1,id FROM roles WHERE code='administrator'",
        [c.user],
      );
      await pc.runtime.query(
        "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
        [tokenHash(c.credentials.sessionToken), c.user],
      );
      await c.commit('leaveType.create', type, 0, c.typePayload());
      await f.publish();
      await pc.identities();
      await pc.pull();
      assert.equal((await pc.apply()).applied, 1);
      await getActor(pc.runtime, c.user);
      await c.runtime.query(
        'UPDATE auth_users SET active=false,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1',
        [c.user],
      );
      await f.publish(1, 2);
      await pc.identities();
      await assert.rejects(getActor(pc.runtime, c.user));
      assert.equal(await createAuthService(pc.runtime).session(c.credentials.sessionToken), null);
      assert.equal(
        (await pc.runtime.query('SELECT updated_by FROM leave_types WHERE id=$1', [type])).rows[0]
          .updated_by,
        c.user,
      );
      assert.equal(
        (await pc.runtime.query('SELECT password_hash FROM auth_users WHERE id=$1', [c.user]))
          .rows[0].password_hash,
        DUMMY_PASSWORD_HASH,
      );
      // Non-login identities on the other PC remain attribution-only through deactivation and reactivation.
      await f.pcs[1]!.identities();
      await c.runtime.query(
        'UPDATE auth_users SET active=true,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1',
        [c.user],
      );
      await f.publish(2, 3);
      await f.pcs[1]!.identities();
      const user = (
        await f.pcs[1]!.runtime.query(
          'SELECT active,identity_only,password_hash FROM auth_users WHERE id=$1',
          [c.user],
        )
      ).rows[0];
      assert.deepEqual(user, { active: false, identity_only: true, password_hash: null });
    } finally {
      await f.close();
    }
  },
);

test(
  'identity page tampering, forged origins and generic node publication cannot advance identity checkpoints',
  acceptanceOptions,
  async () => {
    const f = await identityFixture();
    try {
      await f.publish();
      const pc = f.pcs[0]!,
        page = await pullTrustedIdentities(f.central.runtime, pc.config.token, '0');
      for (const change of [
        { ...page.changes[0], origin: 'node' },
        { ...page.changes[0], snapshotFingerprint: '0'.repeat(64) },
        { ...page.changes[0], snapshot: { ...page.changes[0]!.snapshot, passwordHash: 'secret' } },
        { ...page.changes[0], organizationId: f.central.foreignOrg },
      ]) {
        f.override({ ...page, changes: [change] });
        await assert.rejects(pullNextTrustedIdentityBatch(pc.runtime, pc.config));
        assert.equal(
          (await pc.runtime.query('SELECT count(*)::int n FROM trusted_identity_checkpoints'))
            .rows[0].n,
          0,
        );
      }
      for (const entityType of [
        'central_identity_events',
        'trusted_identity_inbox',
        'trusted_actor_identities',
        'trusted_evidence_reconciliations',
        'trusted_evidence_reconciled_outbox',
        'auth_users',
      ])
        await assert.rejects(
          pushEvents(f.central.runtime, pc.config.token, {
            events: [
              {
                eventId: randomUUID(),
                entityType,
                entityId: f.central.user,
                operation: 'CREATE',
                revision: 1,
                payloadVersion: 1,
                payload: page.changes[0]!.snapshot,
              },
            ],
          }),
        );
      f.override(undefined);
      assert.equal((await pc.identities()).applied, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  'identity replay, concurrent delivery, outage recovery and application rollback preserve durable exactly-once receipts',
  acceptanceOptions,
  async () => {
    const f = await identityFixture();
    try {
      await f.publish();
      const pc = f.pcs[0]!;
      f.outage(true);
      await assert.rejects(pc.identities());
      f.outage(false);
      await Promise.all([
        pullNextTrustedIdentityBatch(pc.runtime, pc.config),
        pullNextTrustedIdentityBatch(pc.runtime, pc.config),
      ]);
      await pc.migrator.query(
        "CREATE FUNCTION fail_identity_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected identity failure'; END $$",
      );
      await pc.migrator.query(
        'CREATE TRIGGER fail_identity BEFORE INSERT ON trusted_identity_applications FOR EACH ROW EXECUTE FUNCTION fail_identity_test()',
      );
      assert.equal((await applyTrustedIdentityBatch(pc.runtime, pc.config, 'local')).pending, 1);
      assert.equal(
        (await pc.runtime.query('SELECT 1 FROM auth_users WHERE id=$1', [f.central.user])).rowCount,
        0,
      );
      assert.equal(
        (await pc.runtime.query('SELECT count(*)::int n FROM trusted_actor_identities')).rows[0].n,
        0,
      );
      await pc.migrator.query('DROP TRIGGER fail_identity ON trusted_identity_applications');
      await pc.runtime.query(
        "UPDATE trusted_identity_application_state SET next_attempt_at=now()-interval '1 second'",
      );
      const result = await Promise.all([
        applyTrustedIdentityBatch(pc.runtime, pc.config, 'local'),
        applyTrustedIdentityBatch(pc.runtime, pc.config, 'local'),
      ]);
      assert.equal(
        result.reduce((n, r) => n + r.applied, 0),
        1,
      );
      await pc.runtime.query('UPDATE trusted_identity_checkpoints SET last_sequence=0');
      await pc.identities();
      assert.equal(
        (await pc.runtime.query('SELECT count(*)::int n FROM trusted_identity_applications'))
          .rows[0].n,
        1,
      );
      await assert.rejects(pc.runtime.query('UPDATE trusted_identity_applications SET revision=7'));
      await assert.rejects(pc.runtime.query('DELETE FROM trusted_identity_inbox'));
    } finally {
      await f.close();
    }
  },
);
