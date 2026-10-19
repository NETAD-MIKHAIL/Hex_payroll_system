import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { readSession, SessionInvalidError } from '../auth/authentication';
import { useAuth } from '../auth/AuthProvider';
import { useHealthItems } from '../components/system/SystemHealth';
import { StatusIndicator } from '../components/system/StatusIndicator';
import { OrganizationPage } from '../pages/FoundationPages';
import { settingsNavigation } from '../pages/SettingsPage';

const navigation = [
  {
    group: 'Payroll',
    title: 'Payroll Periods',
    path: '/payroll/periods',
    icon: 'M5 5h14v16H5z M8 10h8 M8 14h8',
  },
  {
    group: 'Payroll',
    title: 'Earnings',
    path: '/payroll/earnings',
    icon: 'M5 5h14v16H5z M8 10h8 M8 14h8',
  },
  {
    group: 'Payroll',
    title: 'Deductions',
    path: '/payroll/deductions',
    icon: 'M5 5h14v16H5z M8 10h8 M8 14h8',
  },
  {
    group: 'Main',
    title: 'Dashboard',
    path: '/dashboard',
    icon: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  },
  {
    group: 'Workforce',
    title: 'Employees',
    path: '/employees',
    icon: 'M5 5h14v16H5z M8 10h8 M8 14h8',
  },
  {
    group: 'Workforce',
    title: 'Employee Attendance',
    path: '/attendance',
    icon: 'M5 5h14v16H5z M8 3v4 M16 3v4 M5 10h14 M8 14h3 M8 17h7',
  },
  {
    group: 'Workforce',
    title: 'Time Records',
    path: '/time-records',
    icon: 'M5 5h14v16H5z M8 10h8 M8 14h8',
  },
  { group: 'Workforce', title: 'Leave', path: '/leave', icon: 'M5 5h14v16H5z M8 10h8 M8 14h8' },
  {
    group: 'Workforce',
    title: 'Schedules',
    path: '/schedules',
    icon: 'M5 5h14v16H5z M8 10h8 M8 14h8',
  },
  {
    group: 'System',
    title: 'System Health',
    path: '/system-health',
    icon: 'M3 12h4l3-7 4 14 3-7h4',
  },
  {
    group: 'System',
    title: 'Sync Status',
    path: '/sync',
    icon: 'M4 12a8 8 0 0 1 14-5 M20 12a8 8 0 0 1-14 5',
  },
  {
    group: 'System',
    title: 'Sync Conflicts',
    path: '/sync/conflicts',
    icon: 'M12 3 2 21h20L12 3 M12 9v5 M12 17v1',
  },
  {
    group: 'Administration',
    title: 'Settings',
    path: '/settings',
    icon: 'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
  },
];
export function AppLayout() {
  const { session, clearSession, signOut, acceptSession } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const verification = useQuery({
    queryKey: ['auth-session', session?.accessToken],
    queryFn: () => readSession(session!.accessToken),
    enabled: session !== null,
    networkMode: 'always',
    retry: false,
    refetchInterval: 60000,
    staleTime: 0,
    gcTime: 0,
  });
  const { items } = useHealthItems();
  useEffect(() => {
    if (
      verification.data &&
      session &&
      JSON.stringify(verification.data.user) !== JSON.stringify(session.user)
    )
      acceptSession({ ...session, user: verification.data.user });
  }, [verification.data, session, acceptSession]);
  useEffect(() => {
    if (
      verification.error instanceof SessionInvalidError ||
      (verification.data && Date.parse(verification.data.expiresAt) <= Date.now())
    )
      clearSession('Your session has expired or is no longer valid. Please sign in again.');
  }, [verification.error, verification.data, clearSession]);
  if (!session) return <Navigate to="/login" replace />;
  const title =
    location.pathname === '/settings/users'
      ? 'User Management'
      : (settingsNavigation.find((item) => item.path === location.pathname)?.title ??
        navigation.find((item) => item.path === location.pathname)?.title ??
        (location.pathname.startsWith('/employees/') ? 'Employee Profile' : 'Dashboard'));
  const permissions: readonly string[] =
    verification.data?.user.permissions ?? session.user.permissions ?? [];
  const routePermissions: Record<string, string> = {
    '/payroll/periods': 'payroll.view',
    '/payroll/earnings': 'earnings.view',
    '/payroll/deductions': 'deductions.view',
    '/time-records': 'time_records.view',
    '/leave': 'leave.view',
    '/schedules': 'schedules.view',
    '/dashboard': 'dashboard.view',
    '/employees': 'employees.view',
    '/attendance': 'attendance.view',
    '/system-health': 'system_health.view',
    '/sync': 'sync.view',
    '/sync/conflicts': 'sync.conflicts.view',
  };
  const navigationGroups = new Map<string, typeof navigation>();
  const groupOrder = ['Main', 'Workforce', 'Payroll', 'System', 'Administration'];
  for (const item of [...navigation].sort(
    (a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group),
  )) {
    if (item.path !== '/settings' && !permissions.includes(routePermissions[item.path] ?? ''))
      continue;
    const group = navigationGroups.get(item.group) ?? [];
    group.push(item);
    navigationGroups.set(item.group, group);
  }
  return (
    <div className="flex min-h-full flex-col bg-slate-100 text-slate-900">
      <a
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:p-3"
      >
        Skip to content
      </a>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4">
        <div className="flex items-center gap-3">
          <svg aria-hidden="true" viewBox="0 0 48 48" className="h-9 w-9 text-teal-700">
            <path d="M24 3 43 14v20L24 45 5 34V14Z" fill="currentColor" />
            <path d="M17 15v18m14-18v18M17 24h14" stroke="white" strokeWidth="3" />
          </svg>
          <span className="text-sm font-bold tracking-[0.12em]">HEX PAYROLL</span>
          <span className="hidden border-l border-slate-200 pl-4 text-sm text-slate-500 lg:block">
            {title}
          </span>
        </div>
        <details className="relative">
          <summary className="cursor-pointer rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-teal-700">
            {verification.data?.user.displayName ?? session.user.displayName}
          </summary>
          <div className="absolute right-0 z-20 mt-2 min-w-56 rounded-md border border-slate-200 bg-white p-4 shadow-lg">
            <p className="mb-3 break-all text-xs text-slate-500">{session.user.username}</p>
            <button className="text-action text-sm" onClick={() => void signOut()}>
              Sign Out
            </button>
          </div>
        </details>
      </header>
      <div className="flex flex-1 flex-col md:flex-row">
        <aside className="border-b border-slate-200 bg-white md:w-60 md:shrink-0 md:border-r md:border-b-0">
          <button
            className="secondary-button m-3 md:hidden"
            aria-expanded={menuOpen}
            aria-controls="app-navigation"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            Navigation
          </button>
          <nav
            id="app-navigation"
            aria-label="Main navigation"
            className={`${menuOpen ? 'block' : 'hidden'} space-y-5 p-4 md:block`}
          >
            {Array.from(navigationGroups, ([group, links]) => (
              <div key={group}>
                <p className="mb-2 px-3 text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
                  {group}
                </p>
                {links.map((item) => (
                  <div key={item.path}>
                    <NavLink
                      to={item.path}
                      onClick={() => setMenuOpen(false)}
                      className={({ isActive }) =>
                        `flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium ${isActive ? 'bg-teal-50 text-teal-800' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`
                      }
                    >
                      <svg
                        aria-hidden="true"
                        className="h-5 w-5 shrink-0"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d={item.icon} />
                      </svg>
                      {item.title}
                    </NavLink>
                    {item.path === '/settings' && location.pathname.startsWith('/settings') && (
                      <div>
                        {settingsNavigation
                          .filter(
                            (s) =>
                              permissions.includes(s.permission) ||
                              (s.path === '/settings/statutory-tables' &&
                                permissions.includes('tax.view')),
                          )
                          .map((setting) => (
                            <NavLink
                              key={setting.path}
                              to={setting.path}
                              className={({ isActive }) =>
                                `mt-1 ml-8 block rounded-md px-3 py-2 text-sm ${isActive ? 'bg-teal-50 font-medium text-teal-800' : 'text-slate-600'}`
                              }
                            >
                              {setting.title}
                            </NavLink>
                          ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </nav>
        </aside>
        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 p-5 outline-none lg:p-8">
          <div className="mx-auto max-w-7xl">
            <h1 className="mb-5 text-2xl font-semibold tracking-tight">{title}</h1>
            {verification.isPending && (
              <p className="notice mb-5" role="status">
                Verifying your session…
              </p>
            )}
            {verification.isError && !(verification.error instanceof SessionInvalidError) && (
              <div className="notice mb-5" role="alert">
                Session verification is unavailable. Check the local payroll service.{' '}
                <button
                  className="text-action"
                  disabled={verification.isFetching}
                  onClick={() => void verification.refetch()}
                >
                  Retry verification
                </button>
              </div>
            )}
            {session.user.organizationId ? <Outlet /> : <OrganizationPage setup />}
          </div>
        </main>
      </div>
      <footer
        className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-200 bg-white px-5 py-3"
        aria-label="Workstation status"
      >
        {items
          .filter((item) =>
            ['Local Database', 'Biometric Device', 'Synchronization'].includes(item.name),
          )
          .map((item) => (
            <div key={item.name} className="flex items-center gap-2">
              <span className="text-xs text-slate-500">{item.name}</span>
              <StatusIndicator tone={item.tone}>{item.label}</StatusIndicator>
            </div>
          ))}
      </footer>
    </div>
  );
}
