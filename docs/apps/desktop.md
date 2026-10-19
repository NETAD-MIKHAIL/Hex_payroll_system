# Desktop application

Hex Payroll's Electron shell owns service startup and shutdown while apps/web remains the independent renderer.

Run `pnpm dev` from the repository root for development. The desktop alone waits for Vite at 127.0.0.1:5273; it does not provision a private development cluster.

Packaged mode uses a private PostgreSQL 18 cluster, compiled API utility processes, the fixed hexpayroll://app renderer origin and persistent data under %LOCALAPPDATA%\Hex Payroll. The preload exposes immutable runtime facts only.

See [Phase 4.4 packaging](../phase4.4-desktop-packaging.md) for build commands, runtime architecture, first-run setup, maintenance mode, backups and recovery. See [Phase 4.4 implementation report](../phase4.4-implementation-report.md) for actual verification results.
