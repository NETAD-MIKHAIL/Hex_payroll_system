export interface DesktopConfiguration {
  root: string;
  postgres: string;
  migrations: string;
  secrets: { bootstrap: string; migrator: string; application: string };
}
export interface DesktopSyncConfiguration {
  mode: 'disabled' | 'local';
  url?: string;
  nodeId?: string;
}
export type DesktopMessage =
  | { type: 'initialize'; configuration: DesktopConfiguration }
  | {
      type: 'api';
      databaseUrl: string;
      token: string;
      sync: DesktopSyncConfiguration;
      maintenance?: boolean;
    }
  | { type: 'shutdown' };
export type ServiceMessage =
  | { type: 'progress'; state: string }
  | { type: 'database-ready'; databaseUrl: string }
  | { type: 'api-ready'; port: number }
  | { type: 'stopped' }
  | { type: 'error'; code: string };
export interface ParentPort {
  on(event: 'message', listener: (event: { data: DesktopMessage }) => void): void;
  postMessage(message: ServiceMessage): void;
}
export const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
