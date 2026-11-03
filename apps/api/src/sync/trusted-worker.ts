import type { Pool } from 'pg';
import { pilotActive } from './pilot-scope.js';
import { pullNextTrustedEvidenceBatch, type SyncClientConfig } from './client.js';
import { applyTrustedEvidenceBatch } from './trusted-application.js';
import { pullNextTrustedIdentityBatch, applyTrustedIdentityBatch } from './trusted-identities.js';
import { pushNextBiometricBatch } from './biometric-evidence.js';
import { pushNextSourceClosure } from './source-closures.js';
import {
  pullNextTrustedAttendanceBatch,
  applyTrustedAttendanceBatch,
} from './trusted-attendance.js';

/** Separate from v1: network failure never prevents applying already durable evidence. */
export function startTrustedEvidenceWorker(
  pool: Pool,
  config: SyncClientConfig,
  options: {
    mode: 'local' | 'central' | 'disabled';
    enabled: boolean;
    interval: number;
    biometricEnabled?: boolean;
    attendanceEnabled?: boolean;
  },
  onError: () => void,
  dependencies: {
    pull: typeof pullNextTrustedEvidenceBatch;
    apply: typeof applyTrustedEvidenceBatch;
    now: () => number;
    pullIdentities?: typeof pullNextTrustedIdentityBatch;
    applyIdentities?: typeof applyTrustedIdentityBatch;
    pilotActive?: typeof pilotActive;
  } = {
    pull: pullNextTrustedEvidenceBatch,
    apply: applyTrustedEvidenceBatch,
    now: Date.now,
    pullIdentities: pullNextTrustedIdentityBatch,
    applyIdentities: applyTrustedIdentityBatch,
    pilotActive,
  },
) {
  if (options.mode !== 'local' || !options.enabled)
    return { tick: async () => {}, stop: async () => {} };
  if (!Number.isInteger(options.interval) || options.interval < 1000 || options.interval > 300000)
    throw new Error('Invalid trusted worker interval');
  let stopped = false,
    running: Promise<void> | null = null,
    failures = 0,
    nextPull = 0;
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      let scoped: boolean;
      try {
        scoped = (await dependencies.pilotActive?.(pool)) ?? false;
      } catch {
        onError();
        return; // Unknown policy must not advance any stream.
      }
      if (options.attendanceEnabled) {
        try {
          await pushNextSourceClosure(pool, config);
        } catch {
          onError();
        }
        try {
          await pullNextTrustedAttendanceBatch(pool, config);
        } catch {
          onError();
        }
      }
      if (options.biometricEnabled) {
        try {
          await pushNextBiometricBatch(pool, config);
        } catch {
          onError();
        }
      }
      if (!scoped && dependencies.now() >= nextPull) {
        let identityFailed = false;
        try {
          await dependencies.pullIdentities?.(pool, config);
        } catch {
          identityFailed = true;
          onError();
        }
        try {
          await dependencies.pull(pool, config);
          if (identityFailed) throw new Error('Identity transport unavailable');
          failures = 0;
          nextPull = 0;
        } catch {
          failures = Math.min(failures + 1, 8);
          nextPull = dependencies.now() + Math.min(300000, options.interval * 2 ** failures);
          onError();
        }
      }
      try {
        const result = !scoped && (await dependencies.applyIdentities?.(pool, config, 'local'));
        if (result && (result.pending || result.conflicts)) onError();
      } catch {
        onError();
      }
      try {
        const result = !scoped && (await dependencies.apply(pool, config, 'local'));
        if (result && (result.pending || result.conflicts)) onError();
      } catch {
        onError();
      }
      if (options.attendanceEnabled) {
        try {
          const result = await applyTrustedAttendanceBatch(pool, config);
          if (result.pending || result.conflicts) onError();
        } catch {
          onError();
        }
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };
  const timer = setInterval(() => {
    void tick();
  }, options.interval);
  timer.unref();
  void tick();
  return {
    tick,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
