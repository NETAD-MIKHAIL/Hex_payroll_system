import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { useAuth } from '../auth/AuthProvider';
import { foundationRequest } from '../api/foundation';
const stateSchema = z.object({
  pending: z.number(),
  legacyDelivered: z.number(),
  failed: z.number(),
  conflicts: z.number(),
  lastPush: z.string().nullable(),
  lastPull: z.string().nullable(),
  worker: z.string(),
  authorization: z.string(),
  authorizationProblem: z.string().nullable(),
  transportAvailability: z.string(),
  device: z
    .object({
      device_name: z.string(),
      registered: z.boolean(),
      enabled: z.boolean(),
      revoked_at: z.string().nullable(),
    })
    .nullable(),
});
const historySchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      device_name: z.string(),
      started_at: z.string(),
      pushed: z.number(),
      pulled: z.number(),
      accepted: z.number(),
      conflicts: z.number(),
      failed: z.number(),
      duration_ms: z.string().nullable(),
      result: z.string(),
    }),
  ),
});
export function CentralSyncPage() {
  const { session } = useAuth();
  const cache = useQueryClient();
  const [page, setPage] = useState(1),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const token = session!.accessToken;
  const scope = [session?.user.organizationId, token];
  const status = useQuery({
    queryKey: ['central-sync', ...scope],
    queryFn: async () => stateSchema.parse(await foundationRequest('sync/state', token)),
    refetchInterval: 15000,
    networkMode: 'always',
  });
  const history = useQuery({
    queryKey: ['sync-history', ...scope, page],
    queryFn: async () =>
      historySchema.parse(await foundationRequest('sync/history?page=' + page, token)),
    refetchInterval: 15000,
    networkMode: 'always',
  });
  const data = status.data;
  const sync = async () => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const r = z
        .object({ result: z.string() })
        .parse(await foundationRequest('sync/now', token, 'POST', {}, 60000));
      setMessage(
        r.result === 'success'
          ? 'Synchronization completed.'
          : r.result === 'partial'
            ? 'Synchronization completed with items requiring review.'
            : 'Synchronization failed; review device authorization and connection status.',
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Synchronization failed');
    } finally {
      setBusy(false);
      await cache.invalidateQueries({ queryKey: ['central-sync'] });
      await cache.invalidateQueries({ queryKey: ['sync-history'] });
    }
  };
  return (
    <div className="space-y-5">
      <h1>Synchronization</h1>
      {status.error && <p role="alert">{status.error.message}</p>}
      {data && data.legacyDelivered > 0 && (
        <p role="alert">
          {data.legacyDelivered} legacy transport receipts require administrator reconciliation
          before this installation can be considered fully synchronized.
        </p>
      )}
      {data && (
        <>
          <dl className="panel p-5 grid gap-3 sm:grid-cols-2">
            <dt>Central server</dt>
            <dd>
              {data.transportAvailability === 'available'
                ? 'Connected'
                : data.transportAvailability}
            </dd>
            <dt>Device</dt>
            <dd>
              {data.authorizationProblem === 'NODE_REVOKED'
                ? 'Revoked — contact an organization administrator'
                : data.authorizationProblem === 'CREDENTIAL_UNAVAILABLE'
                  ? 'Secure device credential unavailable — import it under the API Windows account'
                  : data.authorization === 'denied'
                    ? 'Authorization denied — review registration or rotate credentials'
                    : data.device?.revoked_at
                      ? 'Revoked'
                      : data.device?.registered
                        ? data.device.device_name
                        : 'Unregistered'}
            </dd>
            <dt>Worker</dt>
            <dd>{data.worker}</dd>
            <dt>Pending events</dt>
            <dd>{data.pending}</dd>
            <dt>Failed events</dt>
            <dd>{data.failed}</dd>
            <dt>Open conflicts</dt>
            <dd>{data.conflicts}</dd>
            <dt>Last push</dt>
            <dd>{data.lastPush ? new Date(data.lastPush).toLocaleString() : 'None'}</dd>
            <dt>Last pull</dt>
            <dd>{data.lastPull ? new Date(data.lastPull).toLocaleString() : 'None'}</dd>
          </dl>
          {session?.user.roles?.includes('administrator') && (
            <button
              type="button"
              disabled={busy || data.worker === 'disabled' || data.authorization === 'denied'}
              onClick={() => void sync()}
            >
              {busy ? 'Synchronizing…' : 'Sync Now'}
            </button>
          )}
        </>
      )}
      <p role="status">{message}</p>
      <Link to="/sync/conflicts">Review synchronization conflicts</Link>
      <h2>Sync history</h2>
      {history.error && <p role="alert">{history.error.message}</p>}
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              {[
                'Started',
                'Device',
                'Push',
                'Pull',
                'Accepted',
                'Conflicts',
                'Failed',
                'Duration (ms)',
                'Result',
              ].map((v) => (
                <th key={v}>{v}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {history.data?.items.map((h) => (
              <tr key={h.id}>
                <td>{new Date(h.started_at).toLocaleString()}</td>
                <td>{h.device_name}</td>
                <td>{h.pushed}</td>
                <td>{h.pulled}</td>
                <td>{h.accepted}</td>
                <td>{h.conflicts}</td>
                <td>{h.failed}</td>
                <td>{h.duration_ms ?? 'Running'}</td>
                <td>{h.result}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!history.isPending && history.data?.items.length === 0 && (
        <p>No synchronization attempts recorded.</p>
      )}
      <button type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>
        Previous
      </button>{' '}
      <span>Page {page}</span>{' '}
      <button
        type="button"
        disabled={!history.data || history.data.items.length < 25}
        onClick={() => setPage(page + 1)}
      >
        Next
      </button>
      <p>Local payroll operations remain available offline. History is retained for 90 days.</p>
    </div>
  );
}
