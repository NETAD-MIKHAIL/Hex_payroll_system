import type { SyncWorkerStatus } from './status.js';

export interface WorkerOperations {
  prepare(): Promise<void>;
  push(signal: AbortSignal): Promise<unknown>;
  pull(signal: AbortSignal): Promise<unknown>;
  apply(): Promise<void>;
  finish?(failed: boolean): Promise<void>;
}

export function startWorker(
  operations: WorkerOperations,
  options: {
    interval: number;
    status: SyncWorkerStatus;
    onError: () => void;
    schedule?: (tick: () => void, interval: number) => () => void;
  },
) {
  let stopped = false;
  let running: Promise<void> | null = null;
  const controller = new AbortController();
  const status = options.status;
  status.state = 'starting';
  const tick = () => {
    if (stopped || running) return running ?? Promise.resolve();
    if (status.authorization === 'denied') return Promise.resolve();
    status.state = 'running';
    running = (async () => {
      let failed = false;
      try {
        await operations.prepare();
      } catch {
        if (!stopped) options.onError();
        await operations.finish?.(true);
        return;
      }
      const workItems = [
        () => operations.push(controller.signal),
        () => operations.pull(controller.signal),
        () => operations.apply(),
      ];
      for (const work of workItems) {
        if (stopped || status.authorization === 'denied') break;
        try {
          await work();
        } catch {
          failed = true;
          if (!stopped) options.onError();
        }
      }
      await operations.finish?.(failed);
    })()
      .catch(() => {
        if (!stopped) options.onError();
      })
      .finally(() => {
        running = null;
        if (!stopped && status.state !== 'blocked') status.state = 'idle';
      });
    return running;
  };
  status.requestCycle = () => tick();
  const cancelSchedule = (
    options.schedule ??
    ((callback, interval) => {
      const timer = setInterval(callback, interval);
      timer.unref();
      return () => clearInterval(timer);
    })
  )(tick, options.interval);
  tick();
  return async () => {
    if (stopped) {
      await running;
      return;
    }
    stopped = true;
    status.requestCycle = null;
    status.state = 'stopping';
    cancelSchedule();
    controller.abort(new Error('Synchronization worker stopping'));
    await running;
    status.state = 'stopped';
  };
}
