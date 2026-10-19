import type { SyncEvent } from '@hexpayroll/shared';

export interface SyncClientConfig {
  url: string;
  nodeId: string;
  token: string;
}
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export type OutgoingEvent = SyncEvent & {
  organizationId: string;
  originNodeId: string;
  baseRevision: number;
  createdAt: string;
  actorId?: string | null;
};
export interface PushTransport {
  push(events: readonly OutgoingEvent[], signal: AbortSignal): Promise<unknown>;
}
export class TransportError extends Error {
  constructor(
    public status: number,
    public code = 'HTTP_ERROR',
  ) {
    super(`Synchronization HTTP ${status}`);
  }
}
export function requestSignal(options: RequestOptions): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10000);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

/** Bound even a custom transport that does not settle when aborted. */
export async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export async function syncRequest(
  config: SyncClientConfig,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
) {
  const response = await fetch(config.url.replace(/\/$/, '') + '/api/sync/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'X-Hex-Sync-Protocol': '2',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: requestSignal(options),
    redirect: 'error',
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty synchronization response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > (response.ok ? 1048576 : 4096))
        throw new Error('Synchronization response exceeds limit');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  const bodyText = Buffer.concat(chunks).toString('utf8');
  if (!response.ok) {
    let code = 'HTTP_ERROR';
    try {
      const body = JSON.parse(bodyText) as { error?: { code?: unknown } };
      if (
        typeof body.error?.code === 'string' &&
        ['NODE_REVOKED', 'NODE_DISABLED', 'NODE_INVALID', 'SYNC_PROTOCOL_INCOMPATIBLE'].includes(
          body.error.code,
        )
      )
        code = body.error.code;
    } catch {
      /* Untrusted error bodies are not exposed. */
    }
    throw new TransportError(response.status, code);
  }
  return JSON.parse(bodyText) as unknown;
}

export function httpPushTransport(config: SyncClientConfig, timeoutMs: number): PushTransport {
  return {
    push: (events, signal) =>
      syncRequest(
        config,
        'push',
        {
          protocolVersion: 2,
          events: events.map(
            ({
              eventId,
              entityType,
              entityId,
              operation,
              revision,
              payloadVersion,
              payload,
              baseRevision,
              originNodeId,
              actorId,
            }) => ({
              baseRevision,
              originNodeId,
              actorId: actorId ?? null,
              eventId,
              entityType,
              entityId,
              operation,
              revision,
              payloadVersion,
              payload,
            }),
          ),
        },
        { signal, timeoutMs },
      ),
  };
}
