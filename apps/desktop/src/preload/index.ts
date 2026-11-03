import { contextBridge } from 'electron';

/**
 * The renderer-facing bridge.
 *
 * Exposes immutable runtime facts. Packaged requests use the renderer's own
 * origin; main adds private credentials outside the renderer JavaScript world.
 *
 * NOTE: apps/web is deliberately Electron-agnostic and does NOT depend on this
 * shape. It must remain buildable for a plain browser.
 */
const bridge = {
  privateRuntime: process.argv.includes('--hex-private-runtime'),
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
} as const;

contextBridge.exposeInMainWorld('hexpayroll', bridge);

export type HexPayrollBridge = typeof bridge;
