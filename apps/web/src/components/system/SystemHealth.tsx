import { Link } from 'react-router-dom';
import { useNetworkConnection, useSystemHealth } from './useSystemHealth';
import { StatusIndicator, type StatusTone } from './StatusIndicator';
import { formatTime } from '../../utils/dates';
import { useQuery } from '@tanstack/react-query';
import { syncSummarySchema } from '@hexpayroll/shared';
import { z } from 'zod';
import { useAuth } from '../../auth/AuthProvider';
import { foundationRequest } from '../../api/foundation';

export function useHealthItems() {
  const { session } = useAuth();
  const integration = useQuery({
    queryKey: ['operations', 'biometric-health', session?.accessToken],
    queryFn: async () =>
      z
        .object({
          biometricIngestion: z.array(
            z.object({
              id: z.uuid(),
              name: z.string(),
              lastIngestionAt: z.string().nullable(),
              lastRecordAt: z.string().nullable(),
            }),
          ),
        })
        .parse(await foundationRequest('system/details', session!.accessToken)),
    enabled: !!session?.user.permissions?.includes('system_health.view'),
    networkMode: 'always',
    refetchInterval: 15000,
  });
  const sync = useQuery({
    queryKey: ['operations', 'sync', session?.user.organizationId, session?.accessToken],
    queryFn: async () =>
      syncSummarySchema.parse(await foundationRequest('sync/summary', session!.accessToken)),
    enabled: Boolean(
      session?.user.organizationId && session.user.permissions?.includes('sync.view'),
    ),
    networkMode: 'always',
    refetchInterval: 15000,
  });
  const health = useSystemHealth();
  const syncData = sync.isError ? undefined : sync.data;
  const online = useNetworkConnection();
  const data = health.isError ? undefined : health.data;
  const pending = health.isPending && !health.isError;
  const items: { name: string; label: string; tone: StatusTone; detail: string }[] = [
    {
      name: 'Local API',
      label: pending ? 'Checking' : data ? 'Running' : 'Unavailable',
      tone: pending ? 'checking' : data ? 'healthy' : 'error',
      detail: 'Local payroll service',
    },
    {
      name: 'Local Database',
      label: pending
        ? 'Checking'
        : !data
          ? 'Unknown'
          : data.database === 'reachable'
            ? 'Connected'
            : 'Disconnected',
      tone: pending
        ? 'checking'
        : !data
          ? 'warning'
          : data.database === 'reachable'
            ? 'healthy'
            : 'error',
      detail:
        data?.status === 'ok' && data.databaseVersion
          ? data.databaseVersion
          : 'Database readiness is checked by the local API.',
    },
    {
      name: 'Biometric Device',
      label: 'Not configured',
      tone: 'not-configured',
      detail: 'Device integration is not available yet.',
    },
    {
      name: 'Network / Internet',
      label: online ? 'Network available' : 'Offline',
      tone: online ? 'healthy' : 'offline',
      detail:
        'Browser-reported connectivity; Internet reachability is not verified. Local operations do not require Internet access.',
    },
    {
      name: 'Synchronization',
      label: sync.isError
        ? 'Status unavailable'
        : syncData
          ? syncData.conflicts > 0
            ? `${syncData.conflicts} data conflicts`
            : syncData.transportAvailability === 'available'
              ? `${syncData.pending} pending`
              : syncData.transportAvailability
          : 'Unknown',
      tone: sync.isError
        ? 'warning'
        : syncData?.failed || syncData?.conflicts
          ? 'warning'
          : syncData?.transportAvailability === 'available'
            ? 'healthy'
            : syncData?.transportAvailability === 'unavailable'
              ? 'offline'
              : syncData?.transportAvailability === 'unconfigured'
                ? 'not-configured'
                : 'checking',
      detail: syncData
        ? `Worker: ${syncData.workerState}. Transport: ${syncData.transportAvailability}. ${syncData.pending} pending, ${syncData.processing} processing, ${syncData.failed} failed. ${syncData.conflicts} open data conflicts, ${syncData.resolvedConflicts} resolved. Last attempt: ${syncData.lastSyncAttempt ?? 'none'}. Last successful push: ${syncData.lastSuccessfulPush ?? 'none'}. Local operations remain available offline.`
        : 'Synchronization status has not been verified.',
    },
  ];
  const syncEnabled = Boolean(
    session?.user.organizationId && session.user.permissions?.includes('sync.view'),
  );
  return { health, sync, syncEnabled, items, data, integration };
}
export function HealthCard({
  name,
  label,
  tone,
  detail,
}: ReturnType<typeof useHealthItems>['items'][number]) {
  return (
    <section className="panel p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">{name}</h2>
        <StatusIndicator tone={tone}>{label}</StatusIndicator>
      </div>
      <p className="break-words text-sm leading-6 text-slate-600">{detail}</p>
    </section>
  );
}
export function SystemHealthWidget() {
  const { items, data } = useHealthItems();
  return (
    <section className="panel p-5">
      <h2 className="mb-4 font-semibold">System Health</h2>
      <dl className="space-y-3">
        {items.map((item) => (
          <div key={item.name} className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-sm text-slate-600">{item.name}</dt>
            <dd>
              <StatusIndicator tone={item.tone}>{item.label}</StatusIndicator>
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-xs text-slate-500">
        {data?.status === 'ok' ? 'Local system operational' : 'Check local service readiness'}
      </p>
      <Link to="/system-health" className="text-action mt-4 inline-block text-sm">
        View System Health →
      </Link>
    </section>
  );
}
export function SystemHealthPage() {
  const { session } = useAuth();
  const { health, sync, syncEnabled, items, data, integration } = useHealthItems();
  return (
    <div className="space-y-5">
      {syncEnabled && !sync.isError && sync.data && (
        <p className="notice">
          Pending events: {sync.data.pending}. Failed events: {sync.data.failed}. Open data
          conflicts: {sync.data.conflicts}. Resolved conflicts: {sync.data.resolvedConflicts}. Last
          sync attempt: {sync.data.lastSyncAttempt ?? 'none'}.{' '}
          {session?.user.permissions?.includes('sync.conflicts.view') && (
            <Link className="text-action" to="/sync/conflicts">
              Review conflicts
            </Link>
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">
          Local infrastructure and connectivity are monitored separately.
        </p>
        <button
          className="secondary-button"
          disabled={health.isFetching || sync.isFetching}
          onClick={() => {
            void health.refetch();
            if (syncEnabled) void sync.refetch();
          }}
        >
          {health.isFetching ? 'Checking…' : 'Refresh status'}
        </button>
      </div>
      <p className="text-xs text-slate-500" role="status">
        {data
          ? `Last checked: ${formatTime(data.timestamp, Intl.DateTimeFormat().resolvedOptions().timeZone)} (workstation time)`
          : 'No current verified health response.'}
      </p>
      {health.isError && (
        <p role="alert" className="notice">
          Unable to verify the local API. Database status is unknown. Check the local service and
          refresh.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {items.map((item) => (
          <HealthCard key={item.name} {...item} />
        ))}
      </div>
      <section className="panel p-5 space-y-3">
        <h2 className="font-semibold">Biometric ingestion</h2>
        <p>
          Hardware communication is unconfigured. Received records remain available independently.
        </p>
        {integration.isPending ? (
          <p>Loading ingestion status…</p>
        ) : integration.isError ? (
          <p role="alert">Unable to read ingestion status.</p>
        ) : !integration.data?.biometricIngestion.length ? (
          <p>No biometric devices configured.</p>
        ) : (
          integration.data.biometricIngestion.map((d) => (
            <div key={d.id}>
              <h3 className="font-medium">{d.name}</h3>
              <p>Last successful ingestion: {d.lastIngestionAt ?? 'No batches received'}</p>
              <p>Latest punch timestamp: {d.lastRecordAt ?? 'No records received'}</p>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
