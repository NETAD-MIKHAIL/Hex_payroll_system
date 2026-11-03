import { Navigate, Route, Routes } from 'react-router-dom';
import { LoginPage } from './pages/LoginPage';
import { DesktopSetup } from './components/DesktopSetup';
import { AppLayout } from './layouts/AppLayout';
import { DashboardPage } from './pages/DashboardPage';
import { AttendancePage } from './pages/AttendancePage';
import {
  PayrollPeriodsPage,
  PayrollReviewPage,
  EmployeePayrollPage,
  PayrollEntriesPage,
  PayrollPolicyPage,
  StatutoryRulesPage,
} from './pages/PayrollPages';
import { SchedulesPage, TimeRecordsPage, LeavePage } from './pages/TimekeepingPages';
import { SystemHealthPage } from './components/system/SystemHealth';
import { SettingsPage } from './pages/SettingsPage';
import {
  OrganizationPage,
  MasterPage,
  EmployeeProfilePage,
  RolesPage,
  PayrollConfigurationPage,
  AuditPage,
  SyncPage,
  SystemSettingsPage,
  usePermission,
} from './pages/FoundationPages';
import { UsersPage } from './pages/UsersPage';
import type { ReactNode } from 'react';
function Protected({ permission, children }: { permission: string; children: ReactNode }) {
  const allowed = usePermission(permission);
  return allowed ? (
    <>{children}</>
  ) : (
    <p className="notice" role="alert">
      You do not have permission to access this page.
    </p>
  );
}
import { SystemHealthProvider } from './components/system/useSystemHealth';
import { AuthProvider, useAuth } from './auth/AuthProvider';
function AppRoutes() {
  const { session } = useAuth();
  return (
    <Routes>
      <Route
        path="/login"
        element={session ? <Navigate to="/dashboard" replace /> : <LoginPage />}
      />
      <Route element={session ? <AppLayout /> : <Navigate to="/login" replace />}>
        <Route path="/payroll" element={<Navigate to="/payroll/periods" replace />} />
        <Route
          path="/payroll/periods"
          element={
            <Protected permission="payroll.view">
              <PayrollPeriodsPage />
            </Protected>
          }
        />
        <Route
          path="/payroll/periods/:periodId"
          element={
            <Protected permission="payroll.view">
              <PayrollReviewPage />
            </Protected>
          }
        />
        <Route
          path="/payroll/periods/:periodId/runs/:runId"
          element={
            <Protected permission="payroll.view">
              <PayrollReviewPage />
            </Protected>
          }
        />
        <Route
          path="/payroll/periods/:periodId/results/:resultId"
          element={
            <Protected permission="payroll.view">
              <EmployeePayrollPage />
            </Protected>
          }
        />
        <Route
          path="/payroll/earnings"
          element={
            <Protected permission="earnings.view">
              <PayrollEntriesPage kind="earning" />
            </Protected>
          }
        />
        <Route
          path="/payroll/deductions"
          element={
            <Protected permission="deductions.view">
              <PayrollEntriesPage kind="deduction" />
            </Protected>
          }
        />
        <Route
          path="/settings/payroll-policies"
          element={
            <Protected permission="payroll_config.view">
              <PayrollPolicyPage />
            </Protected>
          }
        />
        <Route path="/settings/statutory-tables" element={<StatutoryRulesPage />} />
        <Route
          path="/schedules"
          element={
            <Protected permission="schedules.view">
              <SchedulesPage />
            </Protected>
          }
        />
        <Route
          path="/time-records"
          element={
            <Protected permission="time_records.view">
              <TimeRecordsPage />
            </Protected>
          }
        />
        <Route
          path="/leave"
          element={
            <Protected permission="leave.view">
              <LeavePage />
            </Protected>
          }
        />
        <Route
          path="/dashboard"
          element={
            <Protected permission="dashboard.view">
              <DashboardPage />
            </Protected>
          }
        />
        <Route
          path="/attendance"
          element={
            <Protected permission="attendance.view">
              <AttendancePage />
            </Protected>
          }
        />
        <Route
          path="/employees"
          element={
            <Protected permission="employees.view">
              <MasterPage kind="employees" />
            </Protected>
          }
        />
        <Route
          path="/employees/:id"
          element={
            <Protected permission="employees.view">
              <EmployeeProfilePage />
            </Protected>
          }
        />
        <Route
          path="/system-health"
          element={
            <Protected permission="system_health.view">
              <SystemHealthPage />
            </Protected>
          }
        />
        <Route
          path="/sync-status"
          element={
            <Protected permission="sync.view">
              <SyncPage />
            </Protected>
          }
        />
        <Route path="/settings" element={<SettingsPage />} />
        <Route
          path="/settings/users"
          element={
            <Protected permission="users.view">
              <UsersPage />
            </Protected>
          }
        />
        <Route
          path="/settings/organization"
          element={
            <Protected permission="organization.view">
              <OrganizationPage />
            </Protected>
          }
        />
        <Route
          path="/settings/roles"
          element={
            <Protected permission="roles.view">
              <RolesPage />
            </Protected>
          }
        />
        <Route
          path="/settings/departments"
          element={
            <Protected permission="departments.view">
              <MasterPage kind="departments" />
            </Protected>
          }
        />
        <Route
          path="/settings/positions"
          element={
            <Protected permission="positions.view">
              <MasterPage kind="positions" />
            </Protected>
          }
        />
        <Route
          path="/settings/biometric-devices"
          element={
            <Protected permission="employees.view">
              <MasterPage kind="biometric-devices" />
            </Protected>
          }
        />
        <Route
          path="/settings/biometric-mappings"
          element={
            <Protected permission="employees.view">
              <MasterPage kind="biometric-mappings" />
            </Protected>
          }
        />
        <Route
          path="/settings/payroll-config"
          element={
            <Protected permission="payroll_config.view">
              <PayrollConfigurationPage />
            </Protected>
          }
        />
        <Route
          path="/settings/audit"
          element={
            <Protected permission="audit.view">
              <AuditPage />
            </Protected>
          }
        />
        <Route
          path="/settings/system"
          element={
            <Protected permission="system_health.view">
              <SystemSettingsPage />
            </Protected>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to={session ? '/dashboard' : '/login'} replace />} />
    </Routes>
  );
}
export default function App() {
  return (
    <DesktopSetup>
      <SystemHealthProvider>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </SystemHealthProvider>
    </DesktopSetup>
  );
}
