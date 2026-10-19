import { HEALTH_PATH, parseHealthResponse, type HealthStatus } from '@hexpayroll/shared';
export const API_BASE_URL =
  window.location.protocol === 'hexpayroll:'
    ? 'hexpayroll://app'
    : (import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:4311');
export async function fetchHealth(signal?: AbortSignal): Promise<HealthStatus> {
  const timeout = AbortSignal.timeout(4_000);
  const response = await fetch(`${API_BASE_URL.replace(/\/$/, '')}${HEALTH_PATH}`, {
    headers: { accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    cache: 'no-store',
  });
  return parseHealthResponse(response.status, await response.json());
}
