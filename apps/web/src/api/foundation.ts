import {
  foundationErrorSchema,
  pageResultSchema,
  foundationRecordSchema,
  type FoundationRecord,
  type PageResult,
} from '@hexpayroll/shared';
import { API_BASE_URL } from './health';
import { z } from 'zod';
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function foundationRequest(
  path: string,
  token: string,
  method = 'GET',
  body?: unknown,
  timeoutMs = 10000,
): Promise<unknown> {
  const response = await fetch(`${API_BASE_URL.replace(/\/$/, '')}/api/${path}`, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
    credentials: 'omit',
  });
  const payload: unknown = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('hex-session-invalid'));
    const known = foundationErrorSchema.safeParse(payload);
    const error = known.success
      ? known
      : z
          .object({ error: z.object({ code: z.string().max(100), message: z.string().max(4000) }) })
          .safeParse(payload);
    throw new ApiError(
      response.status,
      error.success ? error.data.error.code : 'REQUEST_FAILED',
      error.success ? error.data.error.message : 'Local service request failed',
    );
  }
  return payload;
}
export async function readPage(path: string, token: string): Promise<PageResult> {
  return pageResultSchema.parse(await foundationRequest(path, token));
}
export async function readRecord(path: string, token: string): Promise<FoundationRecord> {
  return foundationRecordSchema.parse(await foundationRequest(path, token));
}
