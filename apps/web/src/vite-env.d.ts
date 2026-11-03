/// <reference types="vite/client" />

interface Window {
  readonly hexpayroll?: { readonly privateRuntime: boolean };
}

interface ImportMetaEnv {
  /**
   * Base URL of the Hex Payroll API.
   *
   * In the browser this defaults to the loopback API port. In the Electron
   * desktop the shell will inject the actual ephemeral port its private API
   * bound to — which is why this is read at runtime rather than hardcoded.
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
