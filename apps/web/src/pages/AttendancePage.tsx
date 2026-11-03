import { useEffect, useState, useRef, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams, Link } from 'react-router-dom';
import type { AttendanceJson, AttendanceDesktopCommand } from '@hexpayroll/shared';
import { useAuth } from '../auth/AuthProvider';
import { attendanceApi } from '../api/attendance-management';
import { foundationRequest, ApiError } from '../api/foundation';
import { useOrganizationTime, ErrorNotice } from './TimekeepingPages';
import { formatTime, minutesLabel } from '../utils/dates';

const obj = (v: unknown): AttendanceJson =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as AttendanceJson) : {};
const rows = (v: unknown): AttendanceJson[] => (Array.isArray(v) ? v.map(obj) : []);
const label = (v: unknown) =>
  v === null || v === undefined ? '—' : String(v).replaceAll('_', ' ');
const minutes = (v: unknown) => (typeof v === 'number' ? minutesLabel(v) : '—');
const id = (v: AttendanceJson | undefined) => (typeof v?.id === 'string' ? v.id : '');
const at = (v: unknown) =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString() : '—';
export function EvidenceBadge({ status }: { status: string }) {
  const good = ['verified', 'verified_complete', 'approved', 'connected'].includes(status);
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${good ? 'border-teal-200 bg-teal-50 text-teal-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`}
    >
      {label(status)}
    </span>
  );
}
function Ledger({
  title,
  items,
  onInspect,
}: {
  title: string;
  items: AttendanceJson[];
  onInspect?: (row: AttendanceJson) => void;
}) {
  return (
    <section className="panel overflow-hidden">
      <h3 className="border-b border-slate-200 px-5 py-4 font-semibold">{title}</h3>
      {!items.length ? (
        <p className="empty-state">No records received for this view.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((r, i) => (
            <li
              key={String(r.id ?? r.history_id ?? r.sequence ?? i)}
              className="space-y-1 px-5 py-3 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>
                  {label(
                    r.name ??
                      r.status ??
                      r.decision ??
                      r.action ??
                      r.code ??
                      r.kind ??
                      r.record_type ??
                      r.name ??
                      r.id ??
                      r.sequence,
                  )}
                </strong>
                {onInspect && (
                  <button className="text-action" onClick={() => onInspect(r)}>
                    Inspect immutable record
                  </button>
                )}
              </div>
              <p className="break-words text-xs text-slate-500">
                {label(r.id ?? r.history_id ?? r.batch_id ?? r.device_id)} · revision{' '}
                {label(r.revision ?? r.new_revision ?? r.canonical_revision)} ·{' '}
                {at(
                  r.created_at ??
                    r.recorded_at ??
                    r.received_at ??
                    r.delivered_at ??
                    r.attempted_at ??
                    r.at,
                )}
              </p>
              {r.code !== undefined && r.status !== undefined && (
                <p className="text-amber-900">{label(r.code)}</p>
              )}
              {r.pendingBatches !== undefined && (
                <p>Pending delivery: {label(r.pendingBatches)} batches</p>
              )}
              {r.device_employee_id !== undefined && (
                <p>Device employee: {label(r.device_employee_id)}</p>
              )}
              {r.source_identity !== undefined && r.source_identity !== null && (
                <p className="text-xs">
                  Native entry {label(obj(r.source_identity).entryId)} · sequence{' '}
                  {label(obj(r.source_identity).sequence)}
                </p>
              )}
              {r.delivery !== undefined && (
                <p className="text-xs">
                  {r.delivery === null
                    ? 'Awaiting central receipt'
                    : `Receipt confirmed ${at(obj(r.delivery).delivered_at ?? obj(r.delivery).received_at)}`}
                </p>
              )}
              {r.reason !== undefined && (
                <p>{typeof r.reason === 'string' ? r.reason : label(obj(r.reason).message)}</p>
              )}
              {(r.operator_id ?? r.actor_user_id ?? r.created_by) !== undefined && (
                <p className="text-xs">
                  Actor {label(r.operator_id ?? r.actor_user_id ?? r.created_by)}
                </p>
              )}
              {r.appliedAt !== undefined && <p>Applied locally: {at(r.appliedAt)}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
type Confirmation = {
  action: AttendanceDesktopCommand['action'];
  command: AttendanceJson;
  sent?: AttendanceDesktopCommand;
};
const titles = {
  certify: 'Certify source window',
  proposals: 'Prepare central proposal',
  finalize: 'Finalize centrally',
  reopen: 'Reopen centrally',
  exceptions: 'Resolve source exception',
};

export function AttendancePage() {
  const sending = useRef(false);
  const [submitting, setSubmitting] = useState(false),
    [commandError, setCommandError] = useState<unknown>(null);
  const { session } = useAuth(),
    token = session!.accessToken,
    client = useQueryClient(),
    org = useOrganizationTime();
  const [params, setParams] = useSearchParams();
  const date = params.get('date') || org.date,
    employeeId = params.get('employeeId') || '',
    tab = params.get('tab') || 'daily';
  const [search, setSearch] = useState(''),
    [page, setPage] = useState(1),
    [identifier, setIdentifier] = useState(''),
    [password, setPassword] = useState('');
  const [certificateId, setCertificateId] = useState(''),
    [proposalId, setProposalId] = useState(''),
    [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<Confirmation | null>(null),
    [reason, setReason] = useState(''),
    [ack, setAck] = useState(false),
    [decision, setDecision] = useState('hold');
  const [exportHash, setExportHash] = useState(''),
    [exportRef, setExportRef] = useState(''),
    [attestHash, setAttestHash] = useState(''),
    [attestRef, setAttestRef] = useState('');
  const [inspection, setInspection] = useState<{ title: string; value: unknown } | null>(null),
    [capture, setCapture] = useState(''),
    [closure, setClosure] = useState(''),
    [captureKind, setCaptureKind] = useState<'punches' | 'closure'>('punches');
  const [reprocess, setReprocess] = useState(false),
    [localReason, setLocalReason] = useState(''),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const can = (p: string) => session!.user.permissions?.some((v) => v === p) === true;
  const key = ['timekeeping', 'management', token] as const;
  const days = useQuery({
    queryKey: [...key, 'days', date, search, page],
    queryFn: () => attendanceApi.days(token, date, search, page),
    enabled: !!date,
    networkMode: 'always',
    retry: false,
    refetchInterval: 15000,
  });
  const detail = useQuery({
    queryKey: [...key, 'detail', employeeId, date],
    queryFn: () => attendanceApi.detail(token, employeeId, date),
    enabled: !!employeeId && !!date,
    networkMode: 'always',
    retry: false,
    refetchInterval: 15000,
  });
  const monitoring = useQuery({
    queryKey: [...key, 'monitor'],
    queryFn: () => attendanceApi.monitor(token),
    networkMode: 'always',
    retry: false,
    refetchInterval: 15000,
  });
  const connection = useQuery({
    queryKey: [...key, 'connection'],
    queryFn: () => attendanceApi.connection(token),
    networkMode: 'always',
    retry: false,
    refetchInterval: 15000,
  });
  const authenticated =
    connection.data?.connected === true &&
    !connection.isError &&
    Date.parse(connection.data.expiresAt ?? '') > now;
  const central = useQuery({
    queryKey: [...key, 'central', employeeId, date, connection.data?.user?.id],
    queryFn: () => attendanceApi.workspace(token, employeeId, date),
    enabled: !!employeeId && !!date && authenticated,
    networkMode: 'always',
    retry: false,
    refetchInterval: 15000,
  });
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const login = useMutation({
    mutationFn: () => attendanceApi.login(token, identifier, password),
    networkMode: 'always',
    retry: false,
    onSuccess: (data) => {
      client.setQueryData([...key, 'connection'], data);
      void refresh();
    },
    onSettled: () => setPassword(''),
  });
  const disconnect = useMutation({
    mutationFn: () => attendanceApi.disconnect(token),
    networkMode: 'always',
    onSuccess: () => {
      client.removeQueries({ queryKey: [...key, 'central'] });
      void refresh();
    },
  });
  const write = useMutation({
    mutationFn: (body: AttendanceDesktopCommand) => attendanceApi.command(token, body),
    networkMode: 'always',
    retry: false,
    onSettled: () => void refresh(),
  });
  const localWrite = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) =>
      foundationRequest(path, token, 'POST', body),
    networkMode: 'always',
    retry: false,
    onSuccess: () => void client.invalidateQueries({ queryKey: ['timekeeping'] }),
  });
  const inspectionRead = useMutation({
    mutationFn: ({ kind, recordId }: { kind: string; recordId: string }) =>
      attendanceApi.evidence(token, employeeId, date, kind, recordId),
    networkMode: 'always',
    onSuccess: (value) => setInspection({ title: 'Immutable central evidence', value }),
  });
  const localEvidence = useMutation({
    mutationFn: ({ kind, recordId }: { kind: string; recordId: string }) =>
      attendanceApi.localEvidence(token, employeeId, date, kind, recordId),
    networkMode: 'always',
    onSuccess: (value) => setInspection({ title: 'Immutable local evidence', value }),
  });
  const centralCan = (p: string) =>
    authenticated && connection.data?.user?.permissions?.some((v) => v === p) === true;
  const ready =
    authenticated &&
    !!central.data &&
    !central.isError &&
    !central.isFetching &&
    !connection.isFetching;
  const certificates = central.data?.certifications ?? [],
    proposals = (central.data?.proposals ?? []).filter((p) => p.action === 'calculate');
  const certificate = certificates.find((c) => c.id === certificateId) ?? certificates[0],
    proposal = proposals.find((p) => p.proposal_id === proposalId) ?? proposals[0];
  const head = central.data?.canonical,
    certSnapshot = obj(certificate?.snapshot),
    proofs = rows(certSnapshot.sourceProofs),
    blockers = Array.isArray(certSnapshot.blockers) ? certSnapshot.blockers.map(String) : [];
  const resolutions = (central.data?.exceptions ?? []).filter(
      (e) => e.certification_id === certificate?.id,
    ),
    limited = resolutions.find((e) => e.decision === 'authorize_limited');
  const localCanonical = detail.data?.canonical,
    trustedResult = obj(localCanonical?.result),
    localResult = obj(detail.data?.provisional?.result),
    frozen = !!confirm?.sent;
  function change(values: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(values)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next);
  }
  useEffect(() => {
    setConfirm(null);
    setCertificateId('');
    setProposalId('');
    setInspection(null);
    setNotice('');
  }, [employeeId, date]);
  function open(
    action: Confirmation['action'],
    command: AttendanceJson,
    sent?: AttendanceDesktopCommand,
  ) {
    write.reset();
    setCommandError(null);
    setReason(typeof command.reason === 'string' ? command.reason : '');
    setAck(false);
    setConfirm({ action, command, ...(sent ? { sent } : {}) });
    setDecision(String(command.decision ?? 'hold'));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!confirm || !ack || !reason.trim() || !ready || sending.current) return;
    sending.current = true;
    setSubmitting(true);
    setCommandError(null);
    try {
      let body = confirm.sent;
      if (!body) {
        const requestId = await attendanceApi.requestId(token);
        const command = {
          ...confirm.command,
          reason: reason.trim(),
          ...(confirm.action === 'exceptions'
            ? {
                decision,
                artifacts:
                  decision === 'authorize_limited'
                    ? [
                        { kind: 'device_export', sha256: exportHash, reference: exportRef },
                        {
                          kind: 'independent_attestation',
                          sha256: attestHash,
                          reference: attestRef,
                        },
                      ]
                    : [],
              }
            : {}),
        };
        body = { requestId, action: confirm.action, employeeId, workDate: date, command };
        setConfirm({ ...confirm, sent: body });
      }
      const result = await write.mutateAsync(body);
      setNotice(
        result.category === 'conflict'
          ? `Central conflict: ${label(obj(result.reason).code)}. Inspect the audit and refresh evidence; nothing was overwritten.`
          : 'Central response confirmed. Approval is shown only from the central record or trusted local result.',
      );
      setConfirm(null);
    } catch (error) {
      setCommandError(error);
    } finally {
      sending.current = false;
      setSubmitting(false);
    }
  }
  const disabled = (p: string) => !ready || write.isPending || !can(p) || !centralCan(p);
  const time = (v: unknown) =>
    typeof v === 'string' && Number.isFinite(Date.parse(v)) ? formatTime(v, org.timezone) : '—';
  const inspect = (title: string) => (value: AttendanceJson) => setInspection({ title, value });
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Daily review and source evidence</h2>
          <p className="mt-1 text-sm text-slate-500">
            Local evidence, central review and trusted attendance ·{' '}
            {org.timezone ?? 'Organization time'}
          </p>
        </div>
        <button className="secondary-button" onClick={() => void refresh()}>
          Refresh attendance
        </button>
      </header>
      <p className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
        Captured locally → Received centrally → Source certified or explicitly limited → Approved
        centrally. Successful synchronization is not attendance approval.
      </p>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {(days.isError || detail.isError) && (
        <p role="alert" className="notice">
          Local refresh failed. Previously loaded data may be stale.{' '}
          <button className="text-action" onClick={() => void refresh()}>
            Retry local read
          </button>
        </p>
      )}
      <ErrorNotice error={org.error} />
      <ErrorNotice error={localWrite.error} />
      <section className="panel p-5" aria-label="Central authorization">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">Central authorization</h3>
            <p className="mt-1 text-sm text-slate-500">
              Local operator: {session!.user.displayName}. Central actions use a separate authorized
              account.
            </p>
          </div>
          <EvidenceBadge
            status={authenticated && !central.isError ? 'connected' : 'not connected'}
          />
        </div>
        {authenticated ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <strong>{connection.data?.user?.displayName}</strong>
            <span>Expires {at(connection.data?.expiresAt)}</span>
            <button
              className="text-action"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              Disconnect central session
            </button>
          </div>
        ) : (
          <form
            className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              login.mutate();
            }}
          >
            <label className="field-label">
              Central username
              <input
                className="credential-input mt-1"
                autoComplete="username"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
              />
            </label>
            <label className="field-label">
              Central password
              <input
                className="credential-input mt-1"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <button
              className="primary-button self-end"
              disabled={
                login.isPending ||
                !days.data?.features.centralConfigured ||
                !days.data.features.finalization
              }
            >
              Sign in centrally
            </button>
          </form>
        )}
        {connection.data?.reason && (
          <p className="mt-3 text-sm text-slate-500">{connection.data.reason}</p>
        )}
        <ErrorNotice error={login.error ?? connection.error ?? central.error ?? disconnect.error} />
        {(central.isError || connection.isError) && (
          <p className="mt-2 text-sm text-amber-900">
            Central actions are unavailable. Local viewing and supported capture remain available.
            No approval is queued.
          </p>
        )}
        {central.data && (
          <p className="mt-2 text-xs text-slate-500">
            Last central view: {at(central.data.generatedAt)}
            {central.isError || !authenticated ? ' · saved view, not a current connection' : ''}
          </p>
        )}
      </section>
      <nav aria-label="Attendance views" className="flex flex-wrap gap-2">
        {[
          ['daily', 'Daily attendance'],
          ['sources', 'Biometric monitoring'],
          ['audit', 'Audit history'],
        ].map(([value, caption]) => (
          <button
            key={value}
            aria-pressed={tab === value}
            className={tab === value ? 'primary-button' : 'secondary-button'}
            onClick={() => change({ tab: value! })}
          >
            {caption}
          </button>
        ))}
      </nav>
      <div className="panel grid gap-3 p-4 md:grid-cols-[220px_1fr_auto]">
        <label className="field-label">
          Work date
          <input
            className="credential-input mt-1"
            type="date"
            value={date}
            disabled={write.isPending}
            onChange={(e) => {
              change({ date: e.target.value });
              setPage(1);
            }}
          />
        </label>
        <label className="field-label">
          Search employee
          <input
            className="credential-input mt-1"
            type="search"
            placeholder="Name or employee number"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </label>
        {can('attendance.manage') && (
          <button className="secondary-button self-end" onClick={() => setReprocess(!reprocess)}>
            Reprocess local results
          </button>
        )}
      </div>
      {reprocess && (
        <form
          className="panel flex flex-wrap items-end gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            localWrite.mutate(
              {
                path: 'attendance/reprocess',
                body: {
                  startDate: date,
                  endDate: date,
                  reason: localReason,
                  ...(employeeId ? { employeeId } : {}),
                },
              },
              {
                onSuccess: () => {
                  setReprocess(false);
                  setNotice(
                    'Local calculation scheduled. This does not approve or finalize attendance.',
                  );
                },
              },
            );
          }}
        >
          <label className="field-label flex-1">
            Local reprocessing reason
            <input
              className="credential-input mt-1"
              required
              value={localReason}
              onChange={(e) => setLocalReason(e.target.value)}
            />
          </label>
          <button className="primary-button" disabled={localWrite.isPending}>
            Schedule local calculation
          </button>
        </form>
      )}
      {tab === 'daily' && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ['Employees', days.data?.total ?? '—'],
              [
                'Local results on this page',
                days.data?.items.filter((r) => r.provisional).length ?? '—',
              ],
              [
                'Trusted approvals on this page',
                days.data?.items.filter((r) => r.canonical?.approval_status === 'approved')
                  .length ?? '—',
              ],
            ].map(([caption, value]) => (
              <div className="panel p-4" key={String(caption)}>
                <p className="text-sm text-slate-500">{caption}</p>
                <p className="mt-2 text-2xl font-semibold">{value}</p>
              </div>
            ))}
          </div>
          <section className="panel overflow-x-auto" aria-label="Daily attendance">
            <table className="data-table">
              <thead>
                <tr>
                  {[
                    'Employee',
                    'Calculated shift',
                    'Time in / out',
                    'Worked',
                    'Late',
                    'Undertime',
                    'Local result',
                    'Trusted central result',
                  ].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {days.isPending && (
                  <tr>
                    <td colSpan={8}>Loading attendance…</td>
                  </tr>
                )}
                {days.data?.items.map((r) => {
                  const derived = r.provisional,
                    result = r.canonical ?? derived;
                  return (
                    <tr
                      key={r.employee.id}
                      className={employeeId === r.employee.id ? 'bg-teal-50' : ''}
                    >
                      <td>
                        <button
                          className="text-action"
                          onClick={() => change({ employeeId: r.employee.id })}
                        >
                          {r.employee.name}
                        </button>
                        <p className="text-xs text-slate-500">{r.employee.employeeNumber}</p>
                      </td>
                      <td>
                        {label(
                          r.canonical?.schedule_name ??
                            r.provisional?.schedule_name ??
                            'Not calculated',
                        )}
                      </td>
                      <td>
                        {time(result?.first_in)} / {time(result?.last_out)}
                      </td>
                      <td>{minutes(result?.worked_minutes)}</td>
                      <td>{minutes(result?.late_minutes)}</td>
                      <td>{minutes(result?.undertime_minutes)}</td>
                      <td>
                        {derived ? (
                          <>
                            <EvidenceBadge status={String(derived.attendance_status)} />
                            <p className="mt-1 text-xs">
                              Provisional · r{String(derived.revision)}
                            </p>
                          </>
                        ) : (
                          'No local result'
                        )}
                      </td>
                      <td>
                        {r.canonical ? (
                          <>
                            <EvidenceBadge
                              status={
                                r.canonical.approval_status === 'approved'
                                  ? obj(r.canonical.result).evidenceStatus ===
                                    'exception_authorized'
                                    ? 'approved with limitations'
                                    : 'approved'
                                  : 'unreviewed'
                              }
                            />
                            <p className="mt-1 text-xs">
                              Received revision {String(r.canonical.canonical_revision)}
                            </p>
                          </>
                        ) : (
                          'No trusted result received'
                        )}
                      </td>
                    </tr>
                  );
                })}
                {days.data?.items.length === 0 && (
                  <tr>
                    <td colSpan={8}>No matching employees.</td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="flex items-center justify-between p-3 text-sm">
              <button
                className="secondary-button"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <span>
                Page {page} · {days.data?.total ?? 0} employees
              </span>
              <button
                className="secondary-button"
                disabled={page * (days.data?.pageSize ?? 25) >= (days.data?.total ?? 0)}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </section>
        </>
      )}
      {tab === 'sources' && (
        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            Device timestamps and batches describe capture, not complete native inventory. Showing
            recent records; no hardware connection is implied.
          </p>
          <div className="grid gap-4 lg:grid-cols-2">
            <Ledger
              title="Device capture status"
              items={monitoring.data?.devices ?? []}
              onInspect={inspect('Device status')}
            />
            <Ledger
              title="Unmapped raw evidence"
              items={monitoring.data?.unmatched ?? []}
              onInspect={inspect('Mapping exception')}
            />
            <Ledger title="Last confirmed batch receipts" items={monitoring.data?.receipts ?? []} />
            <Ledger
              title="Deferred result dependencies"
              items={monitoring.data?.dependencies ?? []}
            />
            <Ledger title="Closure retry failures" items={monitoring.data?.attempts ?? []} />
            <Ledger title="Trusted result checkpoints" items={monitoring.data?.checkpoints ?? []} />
          </div>
          <ErrorNotice error={monitoring.error} />
          {can('time_records.ingest') && days.data?.features.capture && (
            <form
              className="panel space-y-3 p-5"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  const payload = JSON.parse(captureKind === 'punches' ? capture : closure);
                  await localWrite.mutateAsync({
                    path:
                      captureKind === 'punches'
                        ? 'time-records/ingest'
                        : 'biometric-source-closures',
                    body: payload,
                  });
                  setNotice(
                    'Evidence captured durably on this PC. Central receipt, completeness and approval are separate.',
                  );
                } catch (error) {
                  if (!(error instanceof ApiError))
                    setNotice('Check the evidence JSON; no capture success was confirmed.');
                }
              }}
            >
              <h3 className="font-semibold">Capture provided device evidence</h3>
              <p className="text-sm text-slate-500">
                Import device/adapter output or isolated simulated inputs. No physical device is
                accessed here.
              </p>
              <label className="field-label">
                Evidence type
                <select
                  className="credential-input mt-1"
                  value={captureKind}
                  onChange={(e) => setCaptureKind(e.target.value as 'punches' | 'closure')}
                >
                  <option value="punches">Biometric punch batch</option>
                  <option value="closure" disabled={!days.data.features.finalization}>
                    Signed source closure
                  </option>
                </select>
              </label>
              <label className="field-label">
                Evidence JSON
                <textarea
                  className="credential-input mt-1 min-h-36 font-mono"
                  required
                  value={captureKind === 'punches' ? capture : closure}
                  onChange={(e) =>
                    captureKind === 'punches'
                      ? setCapture(e.target.value)
                      : setClosure(e.target.value)
                  }
                />
              </label>
              <button className="primary-button" disabled={localWrite.isPending}>
                Capture locally
              </button>
            </form>
          )}
          <Link className="text-action" to="/time-records">
            Manual punches and corrections
          </Link>
        </div>
      )}
      {!employeeId && (
        <p className="notice">
          Select an employee in Daily attendance to review evidence, approvals and period history.
        </p>
      )}
      {employeeId && detail.data && (
        <section className="space-y-4" aria-label="Selected attendance">
          <ErrorNotice error={localEvidence.error} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">
              {detail.data.employee.name} · {date}
            </h2>
            <span className="text-sm text-slate-500">{detail.data.timezone}</span>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <section className="panel space-y-2 p-4">
              <h3 className="font-semibold">Local provisional result</h3>
              <EvidenceBadge
                status={String(detail.data.provisional?.attendance_status ?? 'not calculated')}
              />
              <p>
                {time(detail.data.provisional?.first_in)} →{' '}
                {time(detail.data.provisional?.last_out)}
              </p>
              <p className="text-sm">
                Worked {minutes(detail.data.provisional?.worked_minutes)} · Late{' '}
                {minutes(detail.data.provisional?.late_minutes)} · Undertime{' '}
                {minutes(detail.data.provisional?.undertime_minutes)}
              </p>
              <p className="text-xs text-slate-500">
                {label(obj(detail.data.schedule).scheduleName)} · Shift{' '}
                {label(obj(obj(detail.data.schedule).day).startTime)} →{' '}
                {label(obj(obj(detail.data.schedule).day).endTime)}
                {obj(obj(detail.data.schedule).day).endDayOffset ? ' next day' : ''} · Break{' '}
                {label(obj(obj(detail.data.schedule).day).breakStart)} →{' '}
                {label(obj(obj(detail.data.schedule).day).breakEnd)} · Grace{' '}
                {label(obj(obj(detail.data.schedule).day).graceMinutes)}m
              </p>
              <p className="text-xs">
                Local leave context:{' '}
                {detail.data.leave.length
                  ? detail.data.leave
                      .map((l) => `${label(l.status)} ${label(l.duration_type)}`)
                      .join(', ')
                  : 'None recorded'}
              </p>
              <p className="text-xs">
                Review flags:{' '}
                {label(
                  Array.isArray(localResult.flags) ? localResult.flags.join(', ') : 'None recorded',
                )}
              </p>
              <p className="text-xs text-slate-500">
                Local approval flags are provisional, not central finalization.
              </p>
            </section>
            <section className="panel space-y-2 p-4" data-testid="trusted-result">
              <h3 className="font-semibold">Trusted result on this PC</h3>
              <EvidenceBadge status={String(localCanonical?.approval_status ?? 'not received')} />
              <p>Canonical revision {label(localCanonical?.canonical_revision)}</p>
              <p>{label(trustedResult.evidenceStatus)}</p>
              <p className="text-sm">
                Limitations:{' '}
                {Array.isArray(trustedResult.limitations) && trustedResult.limitations.length
                  ? trustedResult.limitations.join(', ')
                  : 'None recorded in received result'}
              </p>
              <p className="text-xs text-slate-500">
                Last central update {at(localCanonical?.updated_at)}
              </p>
              <button
                className="text-action"
                disabled={!localCanonical}
                onClick={() =>
                  setInspection({ title: 'Trusted canonical snapshot', value: localCanonical })
                }
              >
                Inspect received snapshot
              </button>
            </section>
            <section className="panel space-y-2 p-4" data-testid="central-result">
              <h3 className="font-semibold">Central authority</h3>
              <EvidenceBadge
                status={String(
                  head?.approval_status ?? (ready ? 'not yet finalized' : 'not checked'),
                )}
              />
              <p>Canonical revision {label(head?.canonical_revision)}</p>
              <p className="text-xs">Source status: {label(obj(head?.result).evidenceStatus)}</p>
              <p className="text-xs">
                Approver {label(head?.approved_by)} · {at(head?.approved_at)}
              </p>
              {head &&
                Number(head.canonical_revision) >
                  Number(localCanonical?.canonical_revision ?? 0) && (
                  <p className="text-sm text-amber-900">
                    Central revision is newer. Trusted local delivery is still pending.
                  </p>
                )}
              {!ready && (
                <p className="text-xs text-amber-900">
                  Central authorization unavailable; displayed data may be a prior confirmed view.
                </p>
              )}
            </section>
          </div>
          {tab !== 'sources' && (
            <>
              <section className="panel space-y-4 p-5">
                <h3 className="font-semibold">Source certification and central review</h3>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="field-label">
                    Certification revision
                    <select
                      className="credential-input mt-1"
                      value={id(certificate)}
                      onChange={(e) => setCertificateId(e.target.value)}
                    >
                      <option value="">No certification</option>
                      {certificates.map((c) => (
                        <option key={id(c)} value={id(c)}>
                          Revision {label(c.revision)} · {label(c.status)} · {id(c)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field-label">
                    Calculation proposal
                    <select
                      className="credential-input mt-1"
                      value={String(proposal?.proposal_id ?? '')}
                      onChange={(e) => setProposalId(e.target.value)}
                    >
                      <option value="">No proposal</option>
                      {proposals.map((p) => (
                        <option key={String(p.proposal_id)} value={String(p.proposal_id)}>
                          {String(p.proposal_id)} · base {label(p.expected_canonical_revision)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <EvidenceBadge status={String(certificate?.status ?? 'not assessed')} />
                  {blockers.map((b) => (
                    <span key={b} className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">
                      {b.replaceAll('_', ' ')}
                    </span>
                  ))}
                </div>
                {proofs.map((p, i) => (
                  <div key={i} className="rounded border border-slate-200 p-3 text-sm">
                    <strong>{label(obj(p.source).deviceId)}</strong>
                    <p>
                      Contract {label(obj(p.capability).contract)} · epoch{' '}
                      {label(obj(p.capability).epoch)}
                    </p>
                    <p>Missing native ranges: {JSON.stringify(obj(p.proof).missingRanges ?? [])}</p>
                    <p>
                      Received native ranges: {JSON.stringify(obj(p.proof).receivedRanges ?? [])}
                    </p>
                  </div>
                ))}
                <div className="flex flex-wrap gap-2">
                  <button
                    className="secondary-button"
                    disabled={disabled('attendance.manage')}
                    onClick={() =>
                      open('certify', { expectedRevision: Number(certificates[0]?.revision ?? 0) })
                    }
                  >
                    Certify source window
                  </button>
                  <button
                    className="secondary-button"
                    disabled={
                      disabled('attendance.manage') ||
                      !certificate ||
                      (certificate.status !== 'verified' && !limited) ||
                      head?.approval_status === 'approved'
                    }
                    onClick={() =>
                      open('proposals', {
                        certificationId: id(certificate),
                        exceptionResolutionId: limited ? id(limited) : null,
                        expectedCanonicalRevision: Number(head?.canonical_revision ?? 0),
                      })
                    }
                  >
                    Prepare central proposal
                  </button>
                  <button
                    className="primary-button"
                    disabled={
                      disabled('attendance.approve') ||
                      !can('attendance.manage') ||
                      !centralCan('attendance.manage') ||
                      !proposal ||
                      head?.approval_status === 'approved'
                    }
                    onClick={() => open('finalize', { proposalId: proposal?.proposal_id })}
                  >
                    Finalize centrally
                  </button>
                  <button
                    className="secondary-button"
                    disabled={disabled('attendance.manage') || head?.approval_status !== 'approved'}
                    onClick={() =>
                      open('reopen', {
                        expectedCanonicalRevision: Number(head?.canonical_revision),
                      })
                    }
                  >
                    Reopen centrally
                  </button>
                  <button
                    className="secondary-button"
                    disabled={
                      disabled('attendance.adjust') ||
                      !can('attendance.approve') ||
                      !centralCan('attendance.approve') ||
                      !certificate ||
                      !obj(certSnapshot.policy).revision ||
                      resolutions.length > 0
                    }
                    onClick={() =>
                      open('exceptions', {
                        certificationId: id(certificate),
                        expectedFingerprint: certificate?.fingerprint,
                        policyRevision: obj(certSnapshot.policy).revision,
                      })
                    }
                  >
                    Resolve source exception
                  </button>
                </div>
                <p className="text-xs text-slate-500">
                  Every command is confirmed separately with a reason. Gaps, stale evidence and
                  missing source coverage are enforced centrally. An exception never becomes
                  automatic completeness.
                </p>
                <ErrorNotice error={write.error ?? commandError} />
                <ErrorNotice error={inspectionRead.error} />
                <div className="flex gap-4">
                  {certificate && (
                    <button
                      className="text-action"
                      disabled={!ready}
                      onClick={() =>
                        inspectionRead.mutate({ kind: 'certification', recordId: id(certificate) })
                      }
                    >
                      Inspect certification snapshot
                    </button>
                  )}
                  {proposal && (
                    <button
                      className="text-action"
                      disabled={!ready}
                      onClick={() =>
                        inspectionRead.mutate({
                          kind: 'proposal',
                          recordId: String(proposal.proposal_id),
                        })
                      }
                    >
                      Inspect proposal
                    </button>
                  )}
                </div>
              </section>
              <div className="grid gap-4 lg:grid-cols-2">
                <Ledger
                  title="Accepted source exceptions"
                  items={central.data?.exceptions ?? []}
                  onInspect={(r) => inspectionRead.mutate({ kind: 'exception', recordId: id(r) })}
                />
                <Ledger
                  title="Central decisions"
                  items={central.data?.decisions ?? []}
                  onInspect={inspect('Central decision')}
                />
              </div>
            </>
          )}
          {tab === 'audit' && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Ledger
                title="Central immutable attendance revisions"
                items={central.data?.history ?? []}
                onInspect={(r) =>
                  inspectionRead.mutate({ kind: 'history', recordId: String(r.history_id) })
                }
              />
              <Ledger
                title="Local and trusted history"
                items={detail.data.history}
                onInspect={(r) => localEvidence.mutate({ kind: String(r.kind), recordId: id(r) })}
              />
              <Ledger
                title="Organization reconciliation holds"
                items={detail.data.reconciliation}
                onInspect={inspect('Reconciliation remains auditable')}
              />
              <Ledger
                title="Leave context"
                items={detail.data.leave}
                onInspect={inspect('Leave evidence')}
              />
            </div>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <Ledger
              title="Underlying time records"
              items={detail.data.timeRecords}
              onInspect={inspect('Local punch and corrections')}
            />
            <Ledger
              title="Immutable raw punches"
              items={detail.data.rawPunches}
              onInspect={inspect('Captured biometric evidence')}
            />
            {tab === 'sources' && (
              <>
                <Ledger
                  title="Capture batches and confirmed delivery"
                  items={detail.data.batches}
                  onInspect={inspect('Batch receipt')}
                />
                <Ledger
                  title="Source closures"
                  items={detail.data.closures}
                  onInspect={(r) => localEvidence.mutate({ kind: 'closure', recordId: id(r) })}
                />
                <Ledger title="Central receipt metadata" items={central.data?.receipts ?? []} />
                <Ledger
                  title="Expected device coverage"
                  items={central.data?.coverage ?? []}
                  onInspect={inspect('Expected source coverage')}
                />
              </>
            )}
          </div>
          {detail.data.commands.length > 0 && (
            <section className="panel p-4">
              <h3 className="font-semibold">Durable command recovery</h3>
              <p className="mt-1 text-xs text-slate-500">
                Unconfirmed commands are not approvals. Retry preserves the original request
                identity and evidence.
              </p>
              {detail.data.commands.map((r) => {
                const confirmed = rows(r.outcomes).some((o) => o.outcome === 'confirmed');
                return (
                  <div
                    key={id(r)}
                    className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 text-sm"
                  >
                    <span>
                      {label(r.action)} · {id(r)} ·{' '}
                      {confirmed ? 'Response confirmed' : 'Unconfirmed; inspect central state'}
                    </span>
                    {!confirmed && (
                      <button
                        className="secondary-button"
                        disabled={
                          !ready ||
                          write.isPending ||
                          r.central_actor_id !== connection.data?.user?.id
                        }
                        onClick={() =>
                          open(r.action as Confirmation['action'], obj(r.command), {
                            requestId: id(r),
                            action: r.action as Confirmation['action'],
                            employeeId,
                            workDate: date,
                            command: obj(r.command),
                          })
                        }
                      >
                        Review exact retry
                      </button>
                    )}
                  </div>
                );
              })}
            </section>
          )}
        </section>
      )}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/50 p-4">
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="attendance-confirm-title"
            className="panel my-6 max-h-[90vh] w-full max-w-xl space-y-4 overflow-y-auto p-6"
            onSubmit={submit}
          >
            <h2 id="attendance-confirm-title" className="text-lg font-semibold">
              {titles[confirm.action]}
            </h2>
            <p className="text-sm">
              {detail.data?.employee.name} · {date} · Central actor{' '}
              {connection.data?.user?.displayName}
            </p>
            <p className="notice">
              This sends a central command. Local capture, a receipt or a review is not final
              approval.
            </p>
            {confirm.action === 'exceptions' && (
              <>
                <label className="field-label">
                  Exception decision
                  <select
                    className="credential-input mt-1"
                    value={decision}
                    disabled={frozen}
                    onChange={(e) => setDecision(e.target.value)}
                  >
                    <option value="hold">Hold unresolved</option>
                    <option value="reject">Reject</option>
                    <option
                      value="authorize_limited"
                      disabled={
                        !obj(certSnapshot.policy).allow_limited ||
                        !blockers.length ||
                        !blockers.every((b) => b.startsWith('SOURCE_UNSUPPORTED:'))
                      }
                    >
                      Authorize limited evidence under policy
                    </option>
                  </select>
                </label>
                {decision === 'authorize_limited' && !frozen && (
                  <div className="grid gap-3">
                    <p className="text-sm text-amber-900">
                      Independent review and final approval are required. Limitations stay in the
                      audit.
                    </p>
                    {[
                      ['Device export SHA-256', exportHash, setExportHash],
                      ['Device export reference', exportRef, setExportRef],
                      ['Independent attestation SHA-256', attestHash, setAttestHash],
                      ['Independent attestation reference', attestRef, setAttestRef],
                    ].map(([caption, value, setter]) => (
                      <label className="field-label" key={String(caption)}>
                        {String(caption)}
                        <input
                          required
                          className="credential-input mt-1"
                          value={String(value)}
                          pattern={String(caption).includes('SHA-256') ? '[a-f0-9]{64}' : undefined}
                          onChange={(e) => (setter as (v: string) => void)(e.target.value)}
                        />
                      </label>
                    ))}
                  </div>
                )}
              </>
            )}
            <label className="field-label block">
              Review reason
              <textarea
                className="credential-input mt-1"
                required
                maxLength={2000}
                disabled={frozen}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />I
              reviewed the evidence, revisions and source limitations for this command.
            </label>
            {frozen && (
              <p className="text-xs text-slate-500">
                Frozen request {confirm.sent?.requestId}. Retries reuse this content; closing
                retains the journal.
              </p>
            )}
            <ErrorNotice error={write.error ?? commandError} />
            <div className="flex flex-wrap justify-end gap-3">
              <button
                type="button"
                className="secondary-button"
                disabled={submitting}
                onClick={() => setConfirm(null)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={!ack || !reason.trim() || !ready || submitting}
              >
                Confirm central command
              </button>
            </div>
          </form>
        </div>
      )}
      {inspection && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-label={inspection.title}
            className="panel w-full max-w-4xl space-y-3 p-5"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold">{inspection.title}</h2>
              <button className="secondary-button" onClick={() => setInspection(null)}>
                Close evidence
              </button>
            </div>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-950 p-4 text-xs leading-6 text-slate-100">
              {JSON.stringify(inspection.value, null, 2)}
            </pre>
          </section>
        </div>
      )}
    </div>
  );
}
