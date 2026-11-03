import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { LoginResponse } from '@hexpayroll/shared';
import { revokeSession } from './authentication';
import { useQueryClient } from '@tanstack/react-query';
interface AuthContextValue {
  session: LoginResponse | null;
  notice: string | undefined;
  acceptSession: (session: LoginResponse) => void;
  clearSession: (notice?: string) => void;
  signOut: () => Promise<void>;
}
const AuthContext = createContext<AuthContextValue | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<LoginResponse | null>(null);
  const [notice, setNotice] = useState<string>();
  const sessionRef = useRef<LoginResponse | null>(null);
  const acceptSession = useCallback(
    (value: LoginResponse) => {
      const previous = sessionRef.current;
      if (
        previous &&
        (previous.user.id !== value.user.id ||
          previous.user.organizationId !== value.user.organizationId ||
          JSON.stringify(previous.user.permissions) !== JSON.stringify(value.user.permissions))
      ) {
        void queryClient.cancelQueries({
          predicate: (query) =>
            ['operations', 'timekeeping', 'payroll'].includes(String(query.queryKey[0])),
        });
        queryClient.removeQueries({ queryKey: ['operations'] });
        queryClient.removeQueries({ queryKey: ['payroll'] });
        queryClient.removeQueries({ queryKey: ['timekeeping'] });
      }
      sessionRef.current = value;
      setNotice(undefined);
      setSession(value);
    },
    [queryClient],
  );
  const clearSession = useCallback(
    (message?: string) => {
      setSession(null);
      sessionRef.current = null;
      setNotice(message);
      const scoped = {
        predicate: (query: { queryKey: readonly unknown[] }) =>
          query.queryKey[0] === 'auth-session' ||
          query.queryKey[0] === 'operations' ||
          query.queryKey[0] === 'payroll' ||
          query.queryKey[0] === 'timekeeping',
      };
      void queryClient.cancelQueries(scoped);
      queryClient.removeQueries(scoped);
    },
    [queryClient],
  );
  useEffect(() => {
    const invalid = () => clearSession('Your session is no longer valid. Please sign in again.');
    window.addEventListener('hex-session-invalid', invalid);
    return () => window.removeEventListener('hex-session-invalid', invalid);
  }, [clearSession]);
  useEffect(() => {
    if (!session) return;
    const remaining = Date.parse(session.expiresAt) - Date.now();
    if (remaining <= 0) {
      clearSession('Your session has expired. Please sign in again.');
      return;
    }
    const timer = setTimeout(
      () => clearSession('Your session has expired. Please sign in again.'),
      remaining,
    );
    return () => clearTimeout(timer);
  }, [session, clearSession]);
  async function signOut() {
    if (!session) return;
    const token = session.accessToken;
    // Stop rendering protected content immediately, including during an API outage.
    clearSession();
    try {
      await revokeSession(token);
    } catch {
      setNotice(
        'Signed out on this device. Server revocation could not be confirmed; the previous session expires within eight hours.',
      );
    }
  }
  return (
    <AuthContext.Provider
      value={{
        session,
        notice,
        acceptSession,
        clearSession,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider is required');
  return value;
}
