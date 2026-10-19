import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  conflictListResponseSchema,
  conflictDetailsSchema,
  conflictTypeSchema,
  conflictStatusSchema,
  type ConflictResolution,
} from '@hexpayroll/shared';
import { useAuth } from '../auth/AuthProvider';
import { foundationRequest } from '../api/foundation';

export function ConflictsPage() {
  const { session } = useAuth();
  const cache = useQueryClient();
  const [filters, setFilters] = useState({
    status: '',
    entityType: '',
    conflictType: '',
    from: '',
    to: '',
    device: '',
  });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [resolution, setResolution] = useState<ConflictResolution>('escalate');
  const [merge, setMerge] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const scope = [session?.user.organizationId, session?.accessToken];
  const params = new URLSearchParams({
    page: String(page),
    ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
  });
  const list = useQuery({
    queryKey: ['conflicts', ...scope, page, filters],
    networkMode: 'always',
    queryFn: async () =>
      conflictListResponseSchema.parse(
        await foundationRequest('sync/conflicts?' + params, session!.accessToken),
      ),
    refetchInterval: 15000,
  });
  const detail = useQuery({
    queryKey: ['conflict', ...scope, selected],
    networkMode: 'always',
    enabled: !!selected,
    queryFn: async () =>
      conflictDetailsSchema.parse(
        await foundationRequest('sync/conflicts/' + selected, session!.accessToken),
      ),
  });
  const data = detail.isError ? undefined : detail.data;
  const authoritative = data?.latestSnapshot ?? data?.remoteSnapshot;
  async function submit() {
    if (!data || !reason.trim()) return;
    if (
      !window.confirm(
        `${resolution.replaceAll('_', ' ')}? The original event and conflict history will remain available for auditing.${data.authority === 'remote' ? ' This request will remain pending central confirmation.' : ''}`,
      )
    )
      return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await foundationRequest(
        'sync/conflicts/' + data.id + '/resolve',
        session!.accessToken,
        'POST',
        {
          requestId: crypto.randomUUID(),
          resolution,
          reason,
          expectedVersion: data.version,
          ...(['reapply_local', 'manual_merge'].includes(resolution)
            ? { expectedRevision: data.latestRevision ?? data.remoteRevision }
            : {}),
          ...(resolution === 'manual_merge' ? { fields: merge } : {}),
        },
      );
      setMessage(
        data.authority === 'remote' && resolution !== 'escalate'
          ? 'Resolution requested. Pending synchronization and central confirmation.'
          : resolution === 'escalate'
            ? 'Conflict escalated for review.'
            : 'Resolution confirmed.',
      );
      setReason('');
      setMerge({});
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['conflicts'] }),
        cache.invalidateQueries({ queryKey: ['conflict'] }),
        cache.invalidateQueries({ queryKey: ['operations', 'sync'] }),
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Resolution failed');
    } finally {
      setBusy(false);
    }
  }
  const editable = new Set(
    data?.entityType === 'employees'
      ? [
          'firstName',
          'middleName',
          'lastName',
          'suffix',
          'birthDate',
          'email',
          'mobileNumber',
          'address',
          'barangay',
          'city',
          'province',
          'postalCode',
          'sssNumber',
          'philhealthNumber',
          'pagibigNumber',
          'tin',
        ]
      : [
          'code',
          'name',
          'description',
          ...(data?.entityType === 'positions' ? ['departmentId'] : []),
        ],
  );
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Synchronization conflicts</h1>
      <p className="notice">
        Conflict history is stored locally. Requests concerning central data remain pending until
        the central service confirms them.
      </p>
      <div className="flex flex-wrap gap-3">
        {Object.entries(filters).map(([key, value]) => (
          <label className="text-sm" key={key}>
            {key}
            <br />
            {key === 'status' || key === 'conflictType' ? (
              <select
                className="rounded border p-2"
                value={value}
                onChange={(e) => {
                  setFilters({ ...filters, [key]: e.target.value });
                  setPage(1);
                }}
              >
                <option value="">All</option>
                {(key === 'status' ? conflictStatusSchema.options : conflictTypeSchema.options).map(
                  (v) => (
                    <option key={v}>{v}</option>
                  ),
                )}
              </select>
            ) : (
              <input
                className="rounded border p-2"
                type={key === 'from' || key === 'to' ? 'date' : 'text'}
                value={value}
                placeholder={key === 'device' ? 'Device UUID' : ''}
                onChange={(e) => {
                  setFilters({ ...filters, [key]: e.target.value });
                  setPage(1);
                }}
              />
            )}
          </label>
        ))}
      </div>
      {list.isPending && <p role="status">Loading conflicts…</p>}
      {list.error && (
        <p role="alert" className="notice">
          {list.error.message}
        </p>
      )}
      {!list.isError && list.data && (
        <section className="panel overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {[
                  'Detected at',
                  'Entity',
                  'Conflict type',
                  'Originating device',
                  'Local revision',
                  'Remote revision',
                  'Status',
                  'Actions',
                ].map((x) => (
                  <th className="p-3" key={x}>
                    {x}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((c) => (
                <tr className="border-t" key={c.id}>
                  {[
                    c.detectedAt,
                    c.entityType,
                    c.conflictType,
                    c.deviceName,
                    c.localRevision,
                    c.remoteRevision ?? 'Unavailable',
                    c.status,
                  ].map((v, i) => (
                    <td className="p-3" key={i}>
                      {String(v)}
                    </td>
                  ))}
                  <td>
                    <button
                      className="secondary-button"
                      onClick={() => {
                        setSelected(c.id);
                        setMerge({});
                        setReason('');
                        setMessage('');
                        setError('');
                      }}
                    >
                      Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.data.items.length && <p className="p-5">No conflicts match these filters.</p>}
          <div className="flex gap-3 p-3">
            <button disabled={page === 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span>Page {page}</span>
            <button
              disabled={page * list.data.pageSize >= list.data.total}
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </div>
        </section>
      )}
      {selected && detail.isPending && <p role="status">Loading conflict details…</p>}
      {detail.error && <p role="alert">{detail.error.message}</p>}
      {data && (
        <section className="panel p-5 space-y-4">
          <h2 className="font-semibold">Conflict information</h2>
          <p>
            {data.entityType}: {data.entityId}. {data.reason}
          </p>
          <p>
            Authority: {data.authority}. Resolution:{' '}
            {data.resolutionState === 'pending'
              ? 'Pending synchronization'
              : data.resolutionState === 'confirmed'
                ? 'Confirmed'
                : 'Not requested'}
            .
          </p>
          {data.blockingReason && <p className="notice">{data.blockingReason}</p>}
          {data.entityType === 'employees' && (
            <p className="notice">
              Reapply and merge affect editable profile fields only. Employment history,
              compensation, employee number, and employment status require the employee workflow.
            </p>
          )}
          <h3 className="font-semibold">
            Changed fields — local changes vs. authoritative version
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Local</th>
                  <th>Authoritative</th>
                  <th>Merge value</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ...new Set([
                    ...Object.keys(data.localPayload),
                    ...Object.keys(authoritative ?? {}),
                  ]),
                ].map((key) => {
                  const local = data.localPayload[key],
                    remote = authoritative?.[key];
                  return (
                    <tr className="border-t" key={key}>
                      <td className="p-2">
                        {key}
                        {JSON.stringify(local) !== JSON.stringify(remote) ? ' (changed)' : ''}
                      </td>
                      <td className="p-2 break-all">{JSON.stringify(local) ?? 'Unavailable'}</td>
                      <td className="p-2 break-all">{JSON.stringify(remote) ?? 'Unavailable'}</td>
                      <td>
                        {editable.has(key) && data.allowedActions.includes('manual_merge') && (
                          <label>
                            <input
                              type="checkbox"
                              checked={key in merge}
                              onChange={(e) => {
                                const next = { ...merge };
                                if (e.target.checked) next[key] = local;
                                else delete next[key];
                                setMerge(next);
                              }}
                            />{' '}
                            Use local{' '}
                            <input
                              aria-label={'Merged ' + key}
                              className="rounded border p-1"
                              disabled={!(key in merge)}
                              value={String(merge[key] ?? '')}
                              onChange={(e) =>
                                setMerge({ ...merge, [key]: e.target.value || null })
                              }
                            />
                          </label>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!!data.allowedActions.length && (
            <div className="space-y-3">
              <h3 className="font-semibold">Resolution options</h3>
              <select
                aria-label="Resolution"
                className="rounded border p-2"
                value={data.allowedActions.includes(resolution) ? resolution : ''}
                onChange={(e) => setResolution(e.target.value as ConflictResolution)}
              >
                <option value="" disabled>
                  Select an action
                </option>
                {data.allowedActions.map((a) => (
                  <option key={a} value={a}>
                    {a.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
              <textarea
                aria-label="Resolution reason"
                placeholder="Required resolution reason"
                maxLength={1000}
                className="block w-full rounded border p-2"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <button
                className="primary-button"
                disabled={
                  busy ||
                  !reason.trim() ||
                  !data.allowedActions.includes(resolution) ||
                  (resolution === 'manual_merge' && !Object.keys(merge).length)
                }
                onClick={() => void submit()}
              >
                {busy ? 'Saving…' : 'Confirm resolution'}
              </button>
            </div>
          )}
          <h3 className="font-semibold">Resolution history</h3>
          {!data.history.length ? (
            <p>No resolution actions recorded.</p>
          ) : (
            data.history.map((h) => (
              <p key={h.id}>
                {h.createdAt} · {h.resolution} · {h.state} · {h.reason}
              </p>
            ))
          )}
        </section>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
    </div>
  );
}
