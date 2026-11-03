import express from 'express';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { finalizationFixture } from './attendance-finalization-fixture.js';
import { createAttendanceDesktopRouter } from '../src/timekeeping/attendance-desktop-router.js';
import { createAttendanceFinalizationRouter } from '../src/timekeeping/attendance-finalization-router.js';
import { createSyncRouter } from '../src/sync/router.js';
import { createTimekeepingRouter } from '../src/timekeeping/router.js';
import { createFoundationRouter } from '../src/foundation/router.js';
import { createAuthRouter } from '../src/routes/auth.js';
import { createAuthService } from '../src/auth/service.js';
import { hashPassword } from '../src/auth/password.js';
import { corsMiddleware } from '../src/middleware/cors.js';
import type { Pool } from 'pg';

export const desktopTestPassword = 'Attendance isolated UI test passphrase 73O!';
async function listen(app: ReturnType<typeof express>) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Missing isolated HTTP address');
  return { server, url: `http://127.0.0.1:${addr.port}` };
}
const stop = (server: Server) =>
  new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
export async function desktopFixture(
  options: { unsupported?: boolean; allowLimited?: boolean } = {},
) {
  const f = await finalizationFixture(options);
  const servers: Server[] = [];
  const office = await f.local(true),
    wfh = await f.local();
  try {
    const hash = await hashPassword(desktopTestPassword);
    for (const db of [f, office, wfh])
      await db.runtime.query('UPDATE auth_users SET password_hash=$1 WHERE id=$2', [hash, f.user]);
    await f.runtime.query(
      "INSERT INTO role_permissions VALUES($1,'attendance.view') ON CONFLICT DO NOTHING",
      [f.role],
    );
    for (const db of [office, wfh])
      await db.runtime.query(
        "INSERT INTO user_roles SELECT $1,id FROM roles WHERE code='administrator'",
        [f.user],
      );
    let available = true,
      loseFinal = false;
    const central = express();
    central.use(express.json({ limit: '1mb' }));
    central.use((req, res, next) => {
      if (!available) {
        res.status(503).json({
          error: { code: 'CENTRAL_UNAVAILABLE', message: 'Isolated simulated central outage' },
        });
        return;
      }
      const original = res.json.bind(res);
      res.json = (body: unknown) => {
        if (loseFinal && req.originalUrl === '/api/sync/attendance/finalize') {
          loseFinal = false;
          res.status(503);
          return original({
            error: { code: 'CENTRAL_UNAVAILABLE', message: 'Isolated response lost after commit' },
          });
        }
        return original(body);
      };
      next();
    });
    central.use('/api/auth', createAuthRouter(createAuthService(f.runtime)));
    central.use('/api', createSyncRouter(f.runtime, true, undefined, true));
    central.use('/api', createAttendanceFinalizationRouter(f.runtime, 'central', true, f.writer));
    const centralHttp = await listen(central);
    servers.push(centralHttp.server);
    office.config.url = wfh.config.url = centralHttp.url;
    const localServer = async (db: typeof office) => {
      const app = express();
      app.use(corsMiddleware);
      app.use(express.json({ limit: '1mb' }));
      app.use('/api/auth', createAuthRouter(createAuthService(db.runtime)));
      app.get('/api/health', (_req, res) =>
        res.json({ status: 'ok', database: 'reachable', timestamp: new Date().toISOString() }),
      );
      app.use(
        '/api',
        createAttendanceDesktopRouter(db.runtime, {
          mode: 'local',
          capture: true,
          finalization: true,
          central: db.config,
        }),
      );
      app.use('/api', createSyncRouter(db.runtime, false, db.config, true));
      app.use('/api', createTimekeepingRouter(db.runtime, true, true));
      app.use(
        '/api',
        createFoundationRouter(db.runtime, { mode: 'local', nodeId: db.config.nodeId }),
      );
      const http = await listen(app);
      servers.push(http.server);
      return http;
    };
    const officeHttp = await localServer(office),
      wfhHttp = await localServer(wfh);
    const request = async (url: string, path: string, token?: string, body?: unknown) => {
      const response = await fetch(url + '/api/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        data: response.status === 204 ? null : await response.json(),
      };
    };
    const localLogin = async (url = officeHttp.url) => {
      const result = await request(url, 'auth/login', undefined, {
        identifier: 'collector',
        password: desktopTestPassword,
      });
      if (result.status !== 200) throw new Error('Isolated desktop login failed');
      return String(result.data.accessToken);
    };
    const centralLogin = async (token: string, url = officeHttp.url, identifier = 'acceptor') =>
      request(url, 'attendance-management/central/login', token, {
        identifier,
        password: desktopTestPassword,
      });
    const command = async (
      token: string,
      action: string,
      body: Record<string, unknown>,
      requestId?: string,
      url = officeHttp.url,
    ) =>
      request(url, 'attendance-management/central/command', token, {
        requestId: requestId ?? (await f.uuid7()),
        action,
        employeeId: f.employee,
        workDate: f.identity.workDate,
        command: { ...body, reason: body.reason ?? 'Isolated desktop evidence review' },
      });
    return {
      ...f,
      office,
      wfh,
      officeHttp,
      wfhHttp,
      centralHttp,
      request,
      localLogin,
      centralLogin,
      command,
      setAvailable: (value: boolean) => {
        available = value;
      },
      loseFinalResponse: () => {
        loseFinal = true;
      },
      resetLocalBridge: async () => {
        const http = await localServer(office);
        return http;
      },
      async countLocal(pool: Pool, table: string) {
        return Number((await pool.query(`SELECT count(*) n FROM ${table}`)).rows[0].n);
      },
      async close() {
        for (const s of servers.reverse()) await stop(s);
        await office.close();
        await wfh.close();
        await f.close();
      },
    };
  } catch (e) {
    for (const s of servers.reverse()) await stop(s);
    await office.close();
    await wfh.close();
    await f.close();
    throw e;
  }
}
