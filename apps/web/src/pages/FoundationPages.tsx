import { useState, type FormEvent } from 'react';
import { EmployeeSchedule } from './TimekeepingPages';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { z } from 'zod';
import {
  organizationInputSchema,
  departmentInputSchema,
  positionInputSchema,
  employeeInputSchema,
  employmentInputSchema,
  deviceInputSchema,
  mappingInputSchema,
  payrollConfigurationSchema,
  roleInputSchema,
  createUserSchema,
  permissionCodes,
  decimalStringToCentavos,
  centavosToDecimalString,
  formatPeso,
  managedUserSchema,
  type FoundationRecord,
} from '@hexpayroll/shared';
import { useAuth } from '../auth/AuthProvider';
import { foundationRequest, readPage, readRecord } from '../api/foundation';
import { UsersTable } from '../components/users/UsersTable';
import { StatusIndicator } from '../components/system/StatusIndicator';
export function usePermission(permission: string) {
  return useAuth().session?.user.permissions?.some((value) => value === permission) === true;
}
type Field = {
  key: string;
  label: string;
  type?: string;
  options?: { value: string; label: string }[];
  required?: boolean;
  group?: string;
};
const option = (values: string[]) =>
  values.map((value) => ({ value, label: value.replace(/_/g, ' ') }));
const status: Field = { key: 'status', label: 'Status', options: option(['active', 'inactive']) };
const personalFields: Field[] = [
  { key: 'employeeNumber', label: 'Employee Number', required: true },
  { key: 'firstName', label: 'First Name', required: true },
  { key: 'middleName', label: 'Middle Name' },
  { key: 'lastName', label: 'Last Name', required: true },
  { key: 'suffix', label: 'Suffix' },
  { key: 'birthDate', label: 'Birth Date', type: 'date' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'mobileNumber', label: 'Mobile Number' },
  ...['address', 'barangay', 'city', 'province', 'postalCode'].map((key) => ({
    key,
    label: key.replace(/([A-Z])/g, ' $1'),
  })),
  { ...status, options: option(['active', 'inactive', 'on_leave', 'terminated']) },
];
const governmentFields: Field[] = ['sssNumber', 'philhealthNumber', 'pagibigNumber', 'tin'].map(
  (key) => ({ key, label: key.replace(/([A-Z])/g, ' $1'), group: 'Government Information' }),
);
const organizationFields: Field[] = [
  { key: 'legalName', label: 'Legal Name', required: true },
  ...[
    'tradeName',
    'tin',
    'rdoCode',
    'sssNumber',
    'philhealthNumber',
    'pagibigNumber',
    'address',
    'barangay',
    'city',
    'province',
    'postalCode',
    'phone',
  ].map((key) => ({ key, label: key.replace(/([A-Z])/g, ' $1') })),
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'timezone', label: 'Timezone', required: true },
  { key: 'currency', label: 'Currency', options: option(['PHP']) },
  { key: 'country', label: 'Country', options: [{ value: 'PH', label: 'Philippines' }] },
  status,
];
const masterFields: Field[] = [
  { key: 'code', label: 'Code', required: true },
  { key: 'name', label: 'Name', required: true },
  { key: 'description', label: 'Description' },
  status,
];
function message(error: unknown) {
  return error instanceof Error ? error.message : 'Unable to complete the request';
}
export function QueryNotice({ pending, error }: { pending: boolean; error: unknown }) {
  return pending ? (
    <p role="status" className="notice">
      Loading local records…
    </p>
  ) : error ? (
    <p role="alert" className="notice">
      {message(error)}
    </p>
  ) : null;
}
export function RecordForm({
  title,
  fields,
  initial = {},
  schema,
  onSave,
  onClose,
}: {
  title: string;
  fields: Field[];
  initial?: Record<string, unknown>;
  schema: z.ZodType;
  onSave: (data: Record<string, unknown>) => Promise<unknown>;
  onClose?: () => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      const input: Record<string, unknown> = {};
      for (const field of fields) {
        const value = values[field.key];
        input[field.key] =
          field.type === 'checkbox'
            ? Boolean(value)
            : field.type === 'number'
              ? Number(value)
              : value === '' || value === undefined
                ? null
                : value;
      }
      const data = schema.parse(input) as Record<string, unknown>;
      await onSave(data);
      onClose?.();
    } catch (e) {
      setError(
        e instanceof z.ZodError
          ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
          : message(e),
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="panel p-5">
      <form onSubmit={(event) => void submit(event)}>
        <h2 className="mb-4 font-semibold">{title}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {fields.map((field) => (
            <label key={field.key} className="block text-sm">
              <span className="mb-1 block font-medium">
                {field.label}
                {field.required ? ' *' : ''}
              </span>
              {field.options ? (
                <select
                  className="w-full rounded border border-slate-300 p-2"
                  value={String(values[field.key] ?? '')}
                  onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                  required={field.required}
                >
                  <option value="">Select…</option>
                  {field.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="w-full rounded border border-slate-300 p-2"
                  type={field.type ?? 'text'}
                  value={field.type === 'checkbox' ? undefined : String(values[field.key] ?? '')}
                  checked={field.type === 'checkbox' ? Boolean(values[field.key]) : undefined}
                  onChange={(e) =>
                    setValues({
                      ...values,
                      [field.key]: field.type === 'checkbox' ? e.target.checked : e.target.value,
                    })
                  }
                  required={field.required}
                  step={field.type === 'number' ? 1 : undefined}
                />
              )}
            </label>
          ))}
        </div>
        {error && (
          <p role="alert" className="notice my-4">
            {error}
          </p>
        )}
        <div className="mt-5 flex gap-3">
          <button className="primary-button" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {onClose && (
            <button type="button" className="secondary-button" disabled={saving} onClick={onClose}>
              Cancel
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
export function OrganizationPage({ setup = false }: { setup?: boolean }) {
  const { session } = useAuth();
  const token = session!.accessToken;
  const queryClient = useQueryClient();
  const canEdit = usePermission('organization.update');
  const organization = useQuery({
    queryKey: ['operations', 'organization'],
    queryFn: () => readRecord('organization', token),
    enabled: !setup,
    networkMode: 'always',
  });
  const [saved, setSaved] = useState(false);
  return (
    <div className="space-y-5">
      {setup && (
        <p className="notice">
          Enter the primary company details to begin. An operator must select the first
          Administrator with <code>pnpm --filter @hexpayroll/api auth:bootstrap-admin</code>.
        </p>
      )}
      <QueryNotice
        pending={!setup && organization.isPending}
        error={!setup ? organization.error : null}
      />
      {(setup || organization.data) && canEdit ? (
        <RecordForm
          key={organization.data?.revision ?? 'setup'}
          title={setup ? 'Company Setup' : 'Organization'}
          fields={organizationFields}
          initial={
            organization.data ?? {
              timezone: organizationInputSchema.shape.timezone.parse(undefined),
              currency: 'PHP',
              country: 'PH',
              status: 'active',
            }
          }
          schema={organizationInputSchema}
          onSave={async (data) => {
            await foundationRequest(
              setup ? 'organization/setup' : 'organization',
              token,
              setup ? 'POST' : 'PUT',
              { ...data, ...(setup ? {} : { expectedRevision: organization.data?.revision }) },
            );
            await queryClient.invalidateQueries({ queryKey: ['operations'] });
            await queryClient.invalidateQueries({ queryKey: ['auth-session'] });
            setSaved(true);
          }}
        />
      ) : organization.data ? (
        <RecordDetails record={organization.data} />
      ) : !canEdit ? (
        <p className="notice">Company setup requires the selected Administrator.</p>
      ) : null}
      {saved && (
        <p role="status" className="notice">
          Company details saved.
        </p>
      )}
    </div>
  );
}
function RecordDetails({ record }: { record: FoundationRecord }) {
  return (
    <dl className="panel grid gap-4 p-5 sm:grid-cols-2">
      {Object.entries(record)
        .filter(
          ([key, v]) => v !== null && typeof v !== 'object' && !['passwordHash'].includes(key),
        )
        .map(([key, value]) => (
          <div key={key}>
            <dt className="text-xs text-slate-500">{key.replace(/([A-Z])/g, ' $1')}</dt>
            <dd className="mt-1 break-words text-sm">
              {key === 'basicRateCentavos' && typeof value === 'number'
                ? formatPeso(value)
                : String(value)}
            </dd>
          </div>
        ))}
    </dl>
  );
}
function useLookups() {
  const { session } = useAuth();
  const token = session!.accessToken;
  const deps = useQuery({
    queryKey: ['operations', 'department-choices'],
    queryFn: () => readPage('departments?pageSize=100', token),
    networkMode: 'always',
    enabled: session?.user.permissions?.includes('departments.view'),
  });
  const positions = useQuery({
    queryKey: ['operations', 'position-choices'],
    queryFn: () => readPage('positions?pageSize=100', token),
    networkMode: 'always',
    enabled: session?.user.permissions?.includes('positions.view'),
  });
  return {
    departments: deps.data?.items ?? [],
    positions: positions.data?.items ?? [],
    error: deps.error ?? positions.error,
  };
}
export function MasterPage({
  kind,
}: {
  kind: 'departments' | 'positions' | 'biometric-devices' | 'biometric-mappings' | 'employees';
}) {
  const { session } = useAuth();
  const token = session!.accessToken;
  const queryClient = useQueryClient();
  const employee = kind === 'employees';
  const canManage = usePermission(
    employee
      ? 'employees.update'
      : kind === 'departments'
        ? 'departments.manage'
        : kind === 'positions'
          ? 'positions.manage'
          : 'employees.update',
  );
  const canCreate = usePermission(
    employee
      ? 'employees.create'
      : kind === 'departments'
        ? 'departments.manage'
        : kind === 'positions'
          ? 'positions.manage'
          : 'employees.update',
  );
  const sensitive = usePermission('employees.sensitive.update');
  const { departments } = useLookups();
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<FoundationRecord | null | undefined>();
  const query = useQuery({
    queryKey: ['operations', kind, search, filterStatus, departmentId, page],
    queryFn: () =>
      readPage(
        `${kind}?${new URLSearchParams({ search, page: String(page), ...(filterStatus ? { status: filterStatus } : {}), ...(departmentId ? { departmentId } : {}) })}`,
        token,
      ),
    networkMode: 'always',
  });
  let fields: Field[] = masterFields;
  let schema: z.ZodType = departmentInputSchema;
  if (kind === 'positions') {
    fields = [
      ...masterFields,
      {
        key: 'departmentId',
        label: 'Department',
        options: departments.map((r) => ({ value: r.id, label: String(r.name) })),
      },
    ];
    schema = positionInputSchema;
  }
  if (employee) {
    fields = [...personalFields, ...(sensitive ? governmentFields : [])];
    schema = employeeInputSchema;
  }
  if (kind === 'biometric-devices') {
    fields = masterFields.filter((f) => f.key !== 'description');
    schema = deviceInputSchema;
  }
  if (kind === 'biometric-mappings') {
    fields = [
      { key: 'employeeId', label: 'Payroll Employee UUID', required: true },
      { key: 'deviceId', label: 'Biometric Device UUID', required: true },
      { key: 'deviceEmployeeId', label: 'Device Employee Identifier', required: true },
      status,
    ];
    schema = mappingInputSchema;
  }
  const columns = employee
    ? [
        'employeeNumber',
        'employeeName',
        'departmentName',
        'positionName',
        'employmentType',
        'status',
      ]
    : kind === 'biometric-mappings'
      ? ['employeeId', 'deviceId', 'deviceEmployeeId', 'status']
      : ['code', 'name', 'status'];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-3">
        <input
          aria-label="Search records"
          placeholder="Search…"
          className="rounded border border-slate-300 p-2"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <select
          aria-label="Status filter"
          className="rounded border border-slate-300 p-2"
          value={filterStatus}
          onChange={(e) => {
            setFilterStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {(employee
            ? ['active', 'inactive', 'on_leave', 'terminated']
            : ['active', 'inactive']
          ).map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        {employee && (
          <select
            aria-label="Department filter"
            className="rounded border border-slate-300 p-2"
            value={departmentId}
            onChange={(e) => {
              setDepartmentId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {String(d.name)}
              </option>
            ))}
          </select>
        )}
        {canCreate && (
          <button className="primary-button" onClick={() => setEditing(null)}>
            Create {employee ? 'Employee' : 'Record'}
          </button>
        )}
      </div>
      <QueryNotice pending={query.isPending} error={query.error} />
      {editing !== undefined && (
        <RecordForm
          key={editing?.id ?? 'new'}
          title={editing ? 'Edit Record' : 'Create Record'}
          fields={fields}
          schema={schema}
          initial={editing ?? { status: 'active' }}
          onClose={() => setEditing(undefined)}
          onSave={async (data) => {
            if (
              editing &&
              data.status !== editing.status &&
              !window.confirm('Change this record’s status? Historical records will be retained.')
            )
              throw new Error('Status change cancelled');
            await foundationRequest(
              kind + (editing ? '/' + editing.id : ''),
              token,
              editing ? 'PUT' : 'POST',
              { ...data, ...(editing ? { expectedRevision: editing.revision } : {}) },
            );
            await queryClient.invalidateQueries({ queryKey: ['operations'] });
          }}
        />
      )}
      {query.data && (
        <>
          <section className="panel overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c} className="p-3">
                      {c.replace(/([A-Z])/g, ' $1')}
                    </th>
                  ))}
                  <th className="p-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((row) => (
                  <tr key={row.id} className="border-t border-slate-200">
                    {columns.map((c) => (
                      <td key={c} className="p-3">
                        {c === 'status' ? (
                          <StatusIndicator
                            tone={
                              row.status === 'active'
                                ? 'healthy'
                                : row.status === 'on_leave'
                                  ? 'warning'
                                  : 'offline'
                            }
                          >
                            {String(row.status)}
                          </StatusIndicator>
                        ) : c === 'employeeName' ? (
                          [row.firstName, row.middleName, row.lastName, row.suffix]
                            .filter(Boolean)
                            .join(' ')
                        ) : (
                          String(row[c] ?? '—')
                        )}
                      </td>
                    ))}
                    <td className="flex gap-3 p-3">
                      {employee && (
                        <Link className="text-action" to={'/employees/' + row.id}>
                          View
                        </Link>
                      )}
                      {canManage && (
                        <button className="text-action" onClick={() => setEditing(row)}>
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {query.data.items.length === 0 && (
              <p className="p-5 text-sm text-slate-500">No records found.</p>
            )}
          </section>
          <Pagination page={page} total={query.data.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}
function Pagination({
  page,
  total,
  onPage,
}: {
  page: number;
  total: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="flex items-center gap-4 text-sm">
      <button className="secondary-button" disabled={page === 1} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span>
        Page {page} · {total} records
      </span>
      <button
        className="secondary-button"
        disabled={page * 25 >= total}
        onClick={() => onPage(page + 1)}
      >
        Next
      </button>
    </div>
  );
}
export function EmployeeProfilePage() {
  const { id } = useParams();
  const { session } = useAuth();
  const token = session!.accessToken;
  const queryClient = useQueryClient();
  const [employmentOpen, setEmploymentOpen] = useState(false);
  const [personalOpen, setPersonalOpen] = useState(false);
  const [mappingOpen, setMappingOpen] = useState(false);
  const { departments, positions } = useLookups();
  const canEdit = usePermission('employees.update');
  const canSensitive = usePermission('employees.sensitive.update');
  const canViewSensitive = usePermission('employees.sensitive.view');
  const record = useQuery({
    queryKey: ['operations', 'employee', id],
    queryFn: () => readRecord('employees/' + id, token),
    networkMode: 'always',
  });
  const devices = useQuery({
    queryKey: ['operations', 'devices'],
    queryFn: () => readPage('biometric-devices?pageSize=100', token),
    networkMode: 'always',
  });
  const employmentFields: Field[] = [
    {
      key: 'departmentId',
      label: 'Department',
      options: departments.map((d) => ({ value: d.id, label: String(d.name) })),
    },
    {
      key: 'positionId',
      label: 'Position',
      options: positions.map((d) => ({ value: d.id, label: String(d.name) })),
    },
    { key: 'effectiveFrom', label: 'Effective From', type: 'date', required: true },
    {
      key: 'employmentType',
      label: 'Employment Type',
      options: option(['regular', 'probationary', 'contractual', 'project_based', 'part_time']),
      required: true,
    },
    {
      key: 'employmentStatus',
      label: 'Employment Status',
      options: option(['active', 'inactive', 'on_leave', 'terminated']),
      required: true,
    },
    { key: 'hireDate', label: 'Hire Date', type: 'date', required: true },
    { key: 'regularizationDate', label: 'Regularization Date', type: 'date' },
    { key: 'terminationDate', label: 'Termination Date', type: 'date' },
    {
      key: 'payType',
      label: 'Pay Type',
      options: option(['monthly', 'daily', 'hourly']),
      required: true,
    },
    {
      key: 'payFrequency',
      label: 'Pay Frequency',
      options: option(['monthly', 'semi_monthly', 'weekly', 'biweekly']),
      required: true,
    },
    { key: 'basicRate', label: 'Basic Rate (PHP)', required: true },
  ];
  const employmentFormSchema = z.object({ basicRate: z.string() }).passthrough();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['operations'] });
  return (
    <div className="space-y-5">
      <Link className="text-action" to="/employees">
        ← Employees
      </Link>
      <QueryNotice pending={record.isPending} error={record.error} />
      {record.data && (
        <>
          <div className="flex gap-3">
            {canEdit && (
              <button className="secondary-button" onClick={() => setPersonalOpen(true)}>
                Edit Personal Information
              </button>
            )}
            {canEdit && canSensitive && (
              <button className="primary-button" onClick={() => setEmploymentOpen(true)}>
                Add Employment Version
              </button>
            )}
            {canEdit && (
              <button className="secondary-button" onClick={() => setMappingOpen(true)}>
                Add Biometric Mapping
              </button>
            )}
          </div>
          {personalOpen && (
            <RecordForm
              title="Personal and Government Information"
              fields={[...personalFields, ...(canSensitive ? governmentFields : [])]}
              initial={record.data}
              schema={employeeInputSchema}
              onClose={() => setPersonalOpen(false)}
              onSave={async (data) => {
                await foundationRequest('employees/' + id, token, 'PUT', {
                  ...data,
                  expectedRevision: record.data?.revision,
                });
                await refresh();
              }}
            />
          )}
          <EmployeeSchedule employee={record.data} />
          <h2 className="font-semibold">Personal Information</h2>
          <RecordDetails
            record={
              Object.fromEntries(
                Object.entries(record.data).filter(
                  ([k]) =>
                    ![
                      'sssNumber',
                      'philhealthNumber',
                      'pagibigNumber',
                      'tin',
                      'employmentVersions',
                      'biometricMappings',
                    ].includes(k),
                ),
              ) as FoundationRecord
            }
          />
          <h2 className="font-semibold">Government Information</h2>
          {canViewSensitive ? (
            <RecordDetails
              record={{
                id: record.data.id,
                ...Object.fromEntries(governmentFields.map((f) => [f.key, record.data?.[f.key]])),
              }}
            />
          ) : (
            <p className="notice">Sensitive information requires additional permission.</p>
          )}
          {employmentOpen && (
            <RecordForm
              title="New Employment Version"
              fields={employmentFields}
              schema={employmentFormSchema}
              initial={{
                ...((record.data.employmentVersions as FoundationRecord[])?.[0] ?? {}),
                effectiveFrom: '',
                employmentStatus: 'active',
                basicRate:
                  typeof (record.data.employmentVersions as FoundationRecord[])?.[0]
                    ?.basicRateCentavos === 'number'
                    ? centavosToDecimalString(
                        Number(
                          (record.data.employmentVersions as FoundationRecord[])[0]
                            ?.basicRateCentavos,
                        ),
                      )
                    : '',
              }}
              onClose={() => setEmploymentOpen(false)}
              onSave={async (data) => {
                const { basicRate, ...rest } = data;
                const input = employmentInputSchema.parse({
                  ...rest,
                  basicRateCentavos: decimalStringToCentavos(String(basicRate)),
                });
                await foundationRequest('employees/' + id + '/employment', token, 'POST', {
                  ...input,
                  expectedRevision: record.data?.revision,
                });
                await refresh();
              }}
            />
          )}
          <h2 className="font-semibold">Employment History</h2>
          {((record.data.employmentVersions ?? []) as FoundationRecord[]).map((version) => (
            <RecordDetails key={version.id} record={version} />
          ))}
          {(record.data.employmentVersions as unknown[])?.length === 0 && (
            <p className="notice">No employment information recorded.</p>
          )}
          {mappingOpen && (
            <RecordForm
              title="Biometric Mapping"
              fields={[
                {
                  key: 'deviceId',
                  label: 'Device',
                  required: true,
                  options: (devices.data?.items ?? []).map((d) => ({
                    value: d.id,
                    label: String(d.name),
                  })),
                },
                { key: 'deviceEmployeeId', label: 'Device Employee Identifier', required: true },
                status,
              ]}
              schema={mappingInputSchema.omit({ employeeId: true })}
              initial={{ status: 'active' }}
              onClose={() => setMappingOpen(false)}
              onSave={async (data) => {
                await foundationRequest('biometric-mappings', token, 'POST', {
                  ...data,
                  employeeId: id,
                });
                await refresh();
              }}
            />
          )}
          <h2 className="font-semibold">Attendance / Biometric</h2>
          <p className="text-sm text-slate-500">
            Device mappings are stored locally. Device communication and attendance ingestion are
            pending.
          </p>
          {((record.data.biometricMappings ?? []) as FoundationRecord[]).map((mapping) => (
            <RecordDetails key={mapping.id} record={mapping} />
          ))}
          <h2 className="font-semibold">Audit / Metadata</h2>
          <RecordDetails
            record={{
              id: record.data.id,
              revision: record.data.revision,
              createdAt: record.data.createdAt,
              updatedAt: record.data.updatedAt,
            }}
          />
        </>
      )}
    </div>
  );
}
export function RolesPage() {
  const { session } = useAuth();
  const token = session!.accessToken;
  const qc = useQueryClient();
  const manage = usePermission('roles.manage');
  const [editing, setEditing] = useState<FoundationRecord | null | undefined>();
  const [selected, setSelected] = useState<string[]>([]);
  const query = useQuery({
    queryKey: ['operations', 'roles'],
    queryFn: async () =>
      z
        .array(z.object({ id: z.uuid() }).catchall(z.unknown()))
        .parse(await foundationRequest('roles', token)),
    networkMode: 'always',
  });
  return (
    <div className="space-y-5">
      <QueryNotice pending={query.isPending} error={query.error} />
      {manage && (
        <button
          className="primary-button"
          onClick={() => {
            setEditing(null);
            setSelected([]);
          }}
        >
          Create Role
        </button>
      )}
      {editing !== undefined && (
        <section className="panel p-5">
          <h2 className="mb-3 font-semibold">Permissions</h2>
          <div className="grid gap-2 sm:grid-cols-3">
            {permissionCodes.map((p) => (
              <label key={p} className="text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(p)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? [...selected, p] : selected.filter((v) => v !== p),
                    )
                  }
                />{' '}
                {p}
              </label>
            ))}
          </div>
          <RecordForm
            title={editing ? 'Edit Role' : 'New Role'}
            fields={[
              { key: 'code', label: 'Code', required: true },
              { key: 'name', label: 'Name', required: true },
            ]}
            initial={editing ?? {}}
            schema={roleInputSchema.omit({ permissions: true })}
            onClose={() => setEditing(undefined)}
            onSave={async (data) => {
              await foundationRequest(
                'roles' + (editing ? '/' + editing.id : ''),
                token,
                editing ? 'PUT' : 'POST',
                { ...data, permissions: selected },
              );
              await qc.invalidateQueries({ queryKey: ['operations'] });
              await qc.invalidateQueries({ queryKey: ['auth-session'] });
            }}
          />
        </section>
      )}
      {query.data?.map((role) => (
        <section key={role.id} className="panel p-5">
          <div className="flex justify-between">
            <h2 className="font-semibold">{String(role.name)}</h2>
            {manage && role.code !== 'administrator' && (
              <button
                className="text-action"
                onClick={() => {
                  setEditing(role);
                  setSelected(role.permissions as string[]);
                }}
              >
                Edit
              </button>
            )}
          </div>
          <p className="mt-3 text-sm text-slate-500">{(role.permissions as string[]).join(', ')}</p>
        </section>
      ))}
    </div>
  );
}
export function PersistedUsersPage() {
  const { session } = useAuth();
  const token = session!.accessToken;
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<FoundationRecord | null | undefined>();
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const roleManage = usePermission('roles.manage');
  const updateUsers = usePermission('users.update');
  const createUsers = usePermission('users.create');
  const canManage = updateUsers && roleManage;
  const canCreate = createUsers && roleManage;
  const users = useQuery({
    queryKey: ['operations', 'users', page, search],
    queryFn: () => readPage(`users?page=${page}&search=${encodeURIComponent(search)}`, token),
    networkMode: 'always',
  });
  const roles = useQuery({
    queryKey: ['operations', 'roles'],
    queryFn: async () =>
      z
        .array(z.object({ id: z.uuid() }).catchall(z.unknown()))
        .parse(await foundationRequest('roles', token)),
    networkMode: 'always',
  });
  const fields: Field[] = [
    { key: 'username', label: 'Username', required: true },
    { key: 'displayName', label: 'Full Name', required: true },
    { key: 'email', label: 'Email', type: 'email' },
    {
      key: 'password',
      label: editing ? 'New Password (optional)' : 'Password',
      type: 'password',
      required: !editing,
    },
    ...(editing ? [{ key: 'active', label: 'Active', type: 'checkbox' }] : []),
  ];
  const schema = editing
    ? createUserSchema.extend({
        password: createUserSchema.shape.password.nullable().optional(),
        email: z.email().nullable().optional(),
        active: z.boolean(),
      })
    : createUserSchema.extend({ email: z.email().nullable().optional() });
  return (
    <div className="space-y-5">
      <div className="flex gap-3">
        <input
          aria-label="Search users"
          className="rounded border p-2"
          placeholder="Search users…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        {canCreate && (
          <button
            className="primary-button"
            onClick={() => {
              setEditing(null);
              setRoleIds([]);
            }}
          >
            Create User
          </button>
        )}
      </div>
      <QueryNotice pending={users.isPending} error={users.error} />
      {editing !== undefined && (
        <section className="panel p-5">
          <h2 className="mb-3 font-semibold">Assigned Roles</h2>
          {roles.data?.map((role) => (
            <label key={role.id} className="mr-5 text-sm">
              <input
                type="checkbox"
                checked={roleIds.includes(role.id)}
                onChange={(e) =>
                  setRoleIds(
                    e.target.checked ? [...roleIds, role.id] : roleIds.filter((v) => v !== role.id),
                  )
                }
              />{' '}
              {String(role.name)}
            </label>
          ))}
          <RecordForm
            title={editing ? 'Edit User' : 'Create User'}
            fields={fields}
            initial={editing ?? {}}
            schema={schema}
            onClose={() => setEditing(undefined)}
            onSave={async (data) => {
              if (roleIds.length === 0) throw new Error('Select at least one role');
              if (
                editing?.active &&
                data.active === false &&
                !window.confirm('Disable this user and revoke their sessions?')
              )
                throw new Error('User deactivation cancelled');
              if (data.password === null) delete data.password;
              if (data.email === null) delete data.email;
              await foundationRequest(
                'users' + (editing ? '/' + editing.id : ''),
                token,
                editing ? 'PUT' : 'POST',
                { ...data, roleIds, ...(editing ? { expectedRevision: editing.revision } : {}) },
              );
              await qc.invalidateQueries({ queryKey: ['operations'] });
              await qc.invalidateQueries({ queryKey: ['auth-session'] });
            }}
          />
        </section>
      )}
      {users.data && (
        <>
          <section className="panel overflow-x-auto">
            <UsersTable
              users={users.data.items.map((row) => managedUserSchema.parse(row))}
              onEdit={
                canManage
                  ? (user) => {
                      setEditing(user);
                      setRoleIds(user.roleIds);
                    }
                  : undefined
              }
            />
          </section>
          <Pagination page={page} total={users.data.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}
export function PayrollConfigurationPage() {
  const { session } = useAuth();
  const token = session!.accessToken;
  const qc = useQueryClient();
  const edit = usePermission('payroll_config.update');
  const query = useQuery({
    queryKey: ['operations', 'payroll-config'],
    queryFn: () => foundationRequest('payroll-config', token),
    networkMode: 'always',
  });
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const row = query.data as FoundationRecord | undefined;
  const defaults = {
    payFrequency: 'semi_monthly',
    cutoffs: [
      { startDay: 1, endDay: 15 },
      { startDay: 16, endDay: 'end_of_month' },
    ],
    weekday: null,
    anchorDate: null,
    workWeekdays: [1, 2, 3, 4, 5],
    workStart: '08:00',
    workEnd: '17:00',
    breakMinutes: 60,
    standardMinutesPerDay: 480,
    graceMinutes: 0,
    lateEnabled: false,
    undertimeEnabled: false,
    overtimeEnabled: false,
    roundingMode: 'none',
    roundingIncrementMinutes: 1,
  };
  return (
    <div className="space-y-5">
      <p className="notice">
        {row?.id ? 'Configuration is saved.' : 'Configuration is incomplete until saved.'} Phase 1
        stores policies; payroll calculation is deferred.
      </p>
      <QueryNotice pending={query.isPending} error={query.error} />
      {row && (
        <PayrollForm
          key={row.revision ?? 'new'}
          initial={(row.configuration ?? defaults) as Record<string, unknown>}
          disabled={!edit}
          onSave={async (input) => {
            setError('');
            setSaved(false);
            try {
              const configuration = payrollConfigurationSchema.parse(input);
              await foundationRequest('payroll-config', token, 'PUT', {
                configuration,
                expectedRevision: row.revision ?? null,
              });
              await qc.invalidateQueries({ queryKey: ['operations'] });
              setSaved(true);
            } catch (e) {
              setError(message(e));
              throw e;
            }
          }}
        />
      )}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="notice">
          Payroll configuration saved.
        </p>
      )}
    </div>
  );
}
function PayrollForm({
  initial,
  disabled,
  onSave,
}: {
  initial: Record<string, unknown>;
  disabled: boolean;
  onSave: (input: Record<string, unknown>) => Promise<void>;
}) {
  const [data, setData] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const frequency = String(data.payFrequency);
  const cutoffs = data.cutoffs as { startDay: number; endDay: number | string }[];
  const set = (key: string, value: unknown) => setData({ ...data, [key]: value });
  const fields: Field[] = [
    { key: 'workStart', label: 'Work Start', type: 'time' },
    { key: 'workEnd', label: 'Work End', type: 'time' },
    ...['breakMinutes', 'standardMinutesPerDay', 'graceMinutes', 'roundingIncrementMinutes'].map(
      (key) => ({ key, label: key.replace(/([A-Z])/g, ' $1'), type: 'number' }),
    ),
    {
      key: 'roundingMode',
      label: 'Rounding Mode',
      options: option(['none', 'nearest', 'up', 'down']),
    },
    ...['lateEnabled', 'undertimeEnabled', 'overtimeEnabled'].map((key) => ({
      key,
      label: key.replace(/([A-Z])/g, ' $1'),
      type: 'checkbox',
    })),
  ];
  return (
    <form
      className="panel space-y-5 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        setError('');
        void onSave(data)
          .catch((e) => setError(message(e)))
          .finally(() => setSaving(false));
      }}
    >
      <fieldset disabled={disabled || saving} className="space-y-5">
        <label className="block text-sm">
          Pay Frequency{' '}
          <select
            className="ml-3 rounded border p-2"
            value={frequency}
            onChange={(e) => {
              const value = e.target.value;
              setData({
                ...data,
                payFrequency: value,
                cutoffs:
                  value === 'monthly'
                    ? [{ startDay: 1, endDay: 'end_of_month' }]
                    : value === 'semi_monthly'
                      ? [
                          { startDay: 1, endDay: 15 },
                          { startDay: 16, endDay: 'end_of_month' },
                        ]
                      : [],
                weekday: value === 'weekly' || value === 'biweekly' ? 5 : null,
                anchorDate: null,
              });
            }}
          >
            {option(['monthly', 'semi_monthly', 'weekly', 'biweekly']).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {frequency === 'semi_monthly' && (
          <label className="block text-sm">
            First cutoff end day (1–27){' '}
            <input
              type="number"
              min={1}
              max={27}
              className="ml-3 rounded border p-2"
              value={cutoffs[0]?.endDay ?? 15}
              onChange={(e) =>
                set('cutoffs', [
                  { startDay: 1, endDay: Number(e.target.value) },
                  { startDay: Number(e.target.value) + 1, endDay: 'end_of_month' },
                ])
              }
            />
          </label>
        )}
        {['weekly', 'biweekly'].includes(frequency) && (
          <label className="block text-sm">
            Cutoff weekday{' '}
            <select
              className="ml-3 rounded border p-2"
              value={String(data.weekday ?? '')}
              onChange={(e) => set('weekday', Number(e.target.value))}
            >
              {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(
                (d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ),
              )}
            </select>
          </label>
        )}
        {frequency === 'biweekly' && (
          <label className="block text-sm">
            Anchor Date{' '}
            <input
              type="date"
              className="ml-3 rounded border p-2"
              value={String(data.anchorDate ?? '')}
              onChange={(e) => set('anchorDate', e.target.value)}
            />
          </label>
        )}
        <div className="flex flex-wrap gap-3 text-sm">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
            <label key={d}>
              <input
                type="checkbox"
                checked={(data.workWeekdays as number[]).includes(i)}
                onChange={(e) =>
                  set(
                    'workWeekdays',
                    e.target.checked
                      ? [...(data.workWeekdays as number[]), i]
                      : (data.workWeekdays as number[]).filter((v) => v !== i),
                  )
                }
              />{' '}
              {d}
            </label>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {fields.map((f) => (
            <label key={f.key} className="text-sm">
              {f.label}
              {f.options ? (
                <select
                  className="ml-3 rounded border p-2"
                  value={String(data[f.key])}
                  onChange={(e) => set(f.key, e.target.value)}
                >
                  {f.options.map((o) => (
                    <option key={o.value}>{o.value}</option>
                  ))}
                </select>
              ) : (
                <input
                  className="ml-3 rounded border p-2"
                  type={f.type}
                  value={f.type === 'checkbox' ? undefined : String(data[f.key])}
                  checked={f.type === 'checkbox' ? Boolean(data[f.key]) : undefined}
                  onChange={(e) =>
                    set(
                      f.key,
                      f.type === 'checkbox'
                        ? e.target.checked
                        : f.type === 'number'
                          ? Number(e.target.value)
                          : e.target.value,
                    )
                  }
                />
              )}
            </label>
          ))}
        </div>
        {!disabled && (
          <button className="primary-button">{saving ? 'Saving…' : 'Save Configuration'}</button>
        )}
      </fieldset>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
export function AuditPage() {
  const { session } = useAuth();
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({
    from: '',
    to: '',
    action: '',
    entityType: '',
    userId: '',
  });
  const params = new URLSearchParams({
    page: String(page),
    ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
  });
  const query = useQuery({
    queryKey: ['operations', 'audit', page, filters],
    queryFn: () => readPage('audit?' + params, session!.accessToken),
    networkMode: 'always',
  });
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-3">
        {Object.entries(filters).map(([key, value]) => (
          <label key={key} className="text-sm">
            {key}
            <input
              className="ml-2 rounded border p-2"
              type={['from', 'to'].includes(key) ? 'date' : 'text'}
              value={value}
              onChange={(e) => {
                setFilters({ ...filters, [key]: e.target.value });
                setPage(1);
              }}
            />
          </label>
        ))}
      </div>
      <QueryNotice pending={query.isPending} error={query.error} />
      {query.data && (
        <>
          <section className="panel overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  {['Timestamp', 'User', 'Action', 'Entity', 'Description'].map((c) => (
                    <th className="p-3" key={c}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((event) => (
                  <tr className="border-t" key={event.id}>
                    {['createdAt', 'userName', 'action', 'entityType', 'description'].map((k) => (
                      <td key={k} className="p-3">
                        {String(event[k] ?? '—')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {query.data.items.length === 0 && (
              <p className="p-5">No audit events match these filters.</p>
            )}
          </section>
          <Pagination page={page} total={query.data.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}
export { CentralSyncPage as SyncPage } from './CentralSyncPage';
export function SystemSettingsPage() {
  const { session } = useAuth();
  const query = useQuery({
    queryKey: ['operations', 'system-details'],
    queryFn: () => foundationRequest('system/details', session!.accessToken),
    networkMode: 'always',
  });
  return (
    <div className="space-y-5">
      <Link className="text-action" to="/system-health">
        Open System Health
      </Link>
      <QueryNotice pending={query.isPending} error={query.error} />
      {Boolean(query.data) && (
        <RecordDetails record={{ id: 'local', ...(query.data as Record<string, unknown>) }} />
      )}
      <Link className="text-action" to="/settings/biometric-devices">
        Manage Biometric Devices
      </Link>
      <p className="text-sm text-slate-500">Biometric connectivity is unconfigured.</p>
    </div>
  );
}
