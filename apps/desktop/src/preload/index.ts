import { contextBridge } from 'electron';

/** Immutable runtime facts only. The main-process protocol proxy owns desktop credentials. */
const bridge = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
} as const;
contextBridge.exposeInMainWorld('hexpayroll', bridge);
export type HexPayrollBridge = typeof bridge;
