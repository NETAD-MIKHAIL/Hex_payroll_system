export type WorkerState =
  'disabled' | 'starting' | 'idle' | 'running' | 'blocked' | 'stopping' | 'stopped';
export type TransportAvailability = 'unconfigured' | 'unknown' | 'available' | 'unavailable';

/** Process-owned diagnostics; queue counts and receipts remain database-owned. */
export class SyncWorkerStatus {
  state: WorkerState = 'disabled';
  authorization: 'unknown' | 'authorized' | 'denied' = 'unknown';
  authorizationProblem: string | null = null;
  failAuthorization(code: string) {
    this.authorization = 'denied';
    this.authorizationProblem = code;
    this.state = 'blocked';
  }
  requestCycle: (() => Promise<void>) | null = null;
  organizationId: string | null = null;
  private availability: TransportAvailability = 'unknown';
  private verifiedAt: number | null = null;

  constructor(private now: () => number = Date.now) {}

  recordTransport(available: boolean) {
    if (available && this.authorization !== 'denied') this.authorization = 'authorized';
    this.availability = available ? 'available' : 'unavailable';
    this.verifiedAt = this.now();
  }

  snapshot(mode: string, organizationId: string | null, interval: number) {
    const ownsOrganization = organizationId !== null && organizationId === this.organizationId;
    const configured = mode === 'local';
    const fresh = this.verifiedAt !== null && this.now() - this.verifiedAt < interval * 2;
    return {
      workerState:
        configured && ownsOrganization
          ? this.state
          : mode === 'local'
            ? ('starting' as const)
            : ('disabled' as const),
      transportAvailability: !configured
        ? ('unconfigured' as const)
        : ownsOrganization && fresh
          ? this.availability
          : ('unknown' as const),
      lastTransportVerification:
        ownsOrganization && this.verifiedAt !== null
          ? new Date(this.verifiedAt).toISOString()
          : null,
    };
  }
}

export const syncWorkerStatus = new SyncWorkerStatus();
