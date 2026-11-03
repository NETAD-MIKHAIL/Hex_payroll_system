import { randomUUID, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { acceptanceFixture } from './central-evidence-acceptance-fixture.js';
import { databaseFixture } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';
import { tokenHash } from '../src/auth/service.js';
import { registerNode } from '../src/sync/service.js';
import { createSyncRouter } from '../src/sync/router.js';
import { createCentralIdentityPublisher } from '../src/sync/central-identities.js';
import {
  pullNextTrustedIdentityBatch,
  applyTrustedIdentityBatch,
} from '../src/sync/trusted-identities.js';
import { pullNextTrustedEvidenceBatch } from '../src/sync/client.js';
import { applyTrustedEvidenceBatch } from '../src/sync/trusted-application.js';
import { createEvidenceReconciliationService } from '../src/sync/evidence-reconciliation.js';

export async function identityFixture() {
  const central = await acceptanceFixture();
  const locals: Awaited<ReturnType<typeof databaseFixture>>[] = [];
  let server: ReturnType<ReturnType<typeof express>['listen']> | undefined;
  try {
    const issuer = randomUUID(),
      issuerSession = randomBytes(32).toString('base64url');
    await central.runtime.query(
      "INSERT INTO auth_users(id,organization_id,username,display_name,password_hash) VALUES($1,$2,'issuer','Identity Issuer',$3)",
      [issuer, central.org, DUMMY_PASSWORD_HASH],
    );
    await central.runtime.query(
      "INSERT INTO user_roles SELECT $1,id FROM roles WHERE code='administrator'",
      [issuer],
    );
    await central.runtime.query(
      "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [tokenHash(issuerSession), issuer],
    );
    const credentials = { nodeToken: central.credentials.nodeToken, sessionToken: issuerSession };
    const publisher = createCentralIdentityPublisher(central.writer, 'central');
    const request = (revision = 0, accountRevision = 1, userId = central.user) => ({
      version: 1 as const,
      requestId: randomUUID(),
      organizationId: central.org,
      userId,
      expectedRevision: revision,
      expectedAccountRevision: accountRevision,
    });
    const publish = (revision = 0, accountRevision = 1, userId = central.user) =>
      publisher(credentials, request(revision, accountRevision, userId));
    let override: unknown,
      outage = false;
    const app = express();
    app.use(express.json());
    app.get('/api/sync/identities/pull', (_req, res, next) => {
      if (outage) res.sendStatus(503);
      else if (override !== undefined) res.json(override);
      else next();
    });
    app.use('/api', createSyncRouter(central.runtime, true));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const pcs = [] as (Awaited<ReturnType<typeof databaseFixture>> & {
      config: { url: string; nodeId: string; token: string };
      operator: string;
      session: string;
      identities: () => Promise<
        ReturnType<typeof applyTrustedIdentityBatch> extends Promise<infer R> ? R : never
      >;
      pull: () => Promise<boolean>;
      apply: () => ReturnType<typeof applyTrustedEvidenceBatch>;
      reconcile: ReturnType<typeof createEvidenceReconciliationService>;
    })[];
    for (let n = 0; n < 2; n++) {
      const db = await databaseFixture();
      locals.push(db);
      await migrate(db.migrator, db.migrations);
      await db.runtime.query(
        "INSERT INTO organizations(id,legal_name) VALUES($1,'Local identity test')",
        [central.org],
      );
      await db.runtime.query('UPDATE application_setup SET organization_id=$1', [central.org]);
      await db.runtime.query(
        "INSERT INTO employees(id,organization_id,employee_number,first_name,last_name) VALUES($1,$2,'E1','Ana','Santos')",
        [central.employee, central.org],
      );
      const node = await registerNode(central.runtime, central.org, 'Identity PC ' + n);
      await db.runtime.query(
        "INSERT INTO sync_nodes(id,organization_id,device_name,token_hash) VALUES($1,$2,'Identity PC',$3)",
        [node.nodeId, central.org, tokenHash(node.token)],
      );
      // Existing authenticated local administrator, never created/granted by distribution.
      const operator = randomUUID(),
        session = randomBytes(32).toString('base64url');
      await db.runtime.query(
        "INSERT INTO auth_users(id,organization_id,username,display_name,password_hash) VALUES($1,$2,'operator','Operator',$3)",
        [operator, central.org, DUMMY_PASSWORD_HASH],
      );
      await db.runtime.query(
        "INSERT INTO user_roles SELECT $1,id FROM roles WHERE code='administrator'",
        [operator],
      );
      await db.runtime.query(
        "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
        [tokenHash(session), operator],
      );
      const config = {
        url: `http://127.0.0.1:${address.port}`,
        nodeId: node.nodeId,
        token: node.token,
      };
      pcs.push({
        ...db,
        config,
        operator,
        session,
        identities: async () => {
          while (await pullNextTrustedIdentityBatch(db.runtime, config));
          const total = { applied: 0, pending: 0, conflicts: 0 };
          for (let i = 0; i < 30; i++) {
            const r = await applyTrustedIdentityBatch(db.runtime, config, 'local');
            total.applied += r.applied;
            total.pending += r.pending;
            total.conflicts += r.conflicts;
            if (!r.applied) break;
          }
          return total;
        },
        pull: () => pullNextTrustedEvidenceBatch(db.runtime, config),
        apply: () => applyTrustedEvidenceBatch(db.runtime, config, 'local'),
        reconcile: createEvidenceReconciliationService(db.runtime, config, 'local'),
      });
    }
    return {
      central,
      issuer,
      credentials,
      publisher,
      publish,
      request,
      pcs,
      override: (value: unknown) => {
        override = value;
      },
      outage: (value: boolean) => {
        outage = value;
      },
      close: async () => {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
          server!.closeAllConnections();
        });
        for (const db of locals) await db.close();
        await central.close();
      },
    };
  } catch (error) {
    server?.close();
    for (const db of locals) await db.close();
    await central.close();
    throw error;
  }
}
