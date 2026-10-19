# Phase 4.4 implementation report

Verification date: 19 October 2026. Application version: 0.1.0. Target: Windows x64.

Implementation is present; full installed-application verification is blocked by the host's application-control policy. Phase 4.5 was not started. No existing development or production database was imported, reset or deleted.

## Repository inspection and changes

Reused Electron 44.4.5, electron-vite, electron-builder 26.15.3/NSIS, single-instance protection, the sandboxed preload, React/HashRouter, authentication/RBAC, the restricted application role, the immutable SQL migration runner and all existing synchronization/payroll services.

Added private database and API utility-process entrypoints, startup/error orchestration, persistent storage and encrypted credentials, a fixed renderer protocol and private API proxy, desktop-only request protection, atomic first-run administrator setup, a maintenance credential-import utility, backup safeguards, resource staging, dependency verification and packaging tests.

The payroll engine, finalized-payroll guards, numbered migration sources and central server were not rewritten. A minimal pnpm patch to app-builder-lib 26.15.3 preserves the Windows environment during NSIS uninstaller generation; no dependency versions were upgraded.

## Packaging

| Item                   | Implementation                                                                |
| ---------------------- | ----------------------------------------------------------------------------- |
| Tool                   | electron-builder 26.15.3, NSIS                                                |
| Product / identity     | Hex Payroll / `ph.hexpayroll.desktop`                                         |
| Version / architecture | 0.1.0 / x64                                                                   |
| Installation           | Per-user default, assisted setup, Start Menu and desktop shortcuts            |
| Icon                   | Generated 256×256 geometric H monogram                                        |
| Unpacked output        | `apps/desktop/release/win-unpacked/Hex Payroll.exe`                           |
| Installer target       | `apps/desktop/release/Hex Payroll Setup.exe`                                  |
| Signing / updates      | No invented publisher, certificate or update URL; signing credentials absent  |
| Persistence            | `%LOCALAPPDATA%\Hex Payroll`; normal uninstall is configured to preserve data |

Production dependencies are deployed from the locked pnpm graph and materialized as ordinary directories. A copy hook explicitly includes the API dependency tree, and traversal rejects external dependency paths and links. PostgreSQL and Microsoft runtime sources/checksums are recorded in checked-in manifests. PostgreSQL normal/delayed PE imports, architecture and executable versions are checked during staging. Redistributed runtime and dependency notices are included.

Final installer: 160,604,485 bytes (153.16 MiB), product Hex Payroll, version 0.1.0, signature status NotSigned. SHA-256: `d9c72cbac63e47468dbbc840b2ead26d18078aa425fdb6a8306e972bf2ea8af0`. The packaged main process and API/database service files were compared with the current compiled outputs and matched.

## PostgreSQL, Electron, API and sync

- PostgreSQL 18.6 is bundled with `bin`, required `lib` and `share` support, initialization/lifecycle tools and backup utilities. Unused Perl/Python/Tcl extensions are excluded. Required Microsoft C++ runtime DLLs are bundled app-locally from a signature-verified Microsoft redistributable.
- Initialization uses a staging cluster, random installation-specific credentials, SCRAM and loopback-only binding. Credentials are DPAPI-encrypted; the data root has a Windows user/SYSTEM ACL.
- Cluster reuse verifies the data directory and system identifier with authenticated SQL. Port conflicts preserve unrelated listeners. Supported `pg_ctl` operations manage only the private cluster, including stale-lock recovery. Incompatible clusters are blocked.
- A separate migrator owns schema changes. Existing installations receive a verified-format backup before pending migrations. Failure blocks API startup and preserves the database. Actual isolated backup restoration was tested.
- Electron coordinates ordered startup, authenticated readiness, health monitoring, one worker-owning API process and bounded shutdown. A startup screen and reference-based recovery dialog are implemented. Storage errors must not suppress the recovery dialog.
- The renderer uses `hexpayroll://app`; Electron proxies API requests and adds a per-launch credential outside React. The loopback API checks credential, Host and Origin before routes. User authentication and RBAC remain active. Preload exposes immutable facts only; navigation, popups and external links are restricted.
- First-run administrator creation, role assignment and setup selection are atomic. Concurrent/repeated bootstrap attempts are rejected. Existing company setup remains in use.
- `Hex Payroll.exe --admin` uses the same instance lock, pauses workers and requires administrator login before existing canonical node import and Windows Credential Manager storage. HTTPS endpoint and node identity persist separately from the secret token. Normal launch does not require a configured or reachable central server.
- Structured logs retain allowlisted events. PostgreSQL suppresses ordinary SQL diagnostics that could include personal values. No automatic reset, major PostgreSQL upgrade or destructive uninstall is implemented.

## Verification

| Check                                      | Result                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                           | Passed                                                                                                                            |
| `pnpm lint`                                | Passed                                                                                                                            |
| `pnpm test`                                | Passed: payroll engine 42, browser 14, API unit/default suite 54; 14 database tests intentionally skipped in that default API run |
| Isolated existing API integration suite    | Passed: 126 tests, zero skips, using disposable databases on staged PostgreSQL 18.6                                               |
| Production compilation                     | Passed                                                                                                                            |
| Unpacked Windows build                     | Passed; packaged API dependencies were explicitly checked after correcting resource-copy exclusions                               |
| Runtime/failure/restore test               | Passed; see retained reports under `apps/desktop/build/test-runs`                                                                 |
| NSIS installer build                       | Passed: final Windows x64 NSIS installer and blockmap generated                                                                   |
| Packaged UI launch                         | Blocked by Device Guard; not verified                                                                                             |
| Clean installation without system runtimes | Not verified; no disposable Windows VM/Sandbox was available                                                                      |
| Older-build installer upgrade              | Not verified; isolated numbered-migration upgrade and restoration were tested instead                                             |
| Installed uninstall/reinstall preservation | Not verified; configuration preserves persistent data by default                                                                  |

The runtime test covers fresh initialization/all migrations, runtime DDL denial, desktop access guard, concurrent/replayed setup, administrator login, protected routes, an occupied previous port, stable identity/records on restart, stale-lock recovery, PostgreSQL startup failure, interrupted initialization, pre-migration backup/restoration, failed migration, incompatible cluster version and missing binaries. The integration suite additionally exercises offline backlog/reconnect, crash replay, stable sync identity, conflicts, payroll finalization and immutable finalized records.

Runtime reports: `apps/desktop/build/test-runs/1482aadf-d23b-44cb-967c-eeba637bfd76/report.json` records the full 126-test integration run and backup restoration; `apps/desktop/build/test-runs/2a89fb45-410c-4b25-bb74-106d2932d4ff/report.json` records the final expanded runtime/failure checks. These are generated local verification artifacts.

The initial browser-suite run had a login-form timeout in one conflict test. That test passed individually and the complete final browser suite passed. Earlier packaging attempts exposed missing runtime dependencies and Windows lifecycle issues; the source changes and checks address them. Those failed attempts are not counted as successful application verification.

Windows explicitly reported that the unsigned `Hex Payroll.exe` was blocked by the organization's Device Guard policy. The policy was not disabled or bypassed. Consequently the current host cannot establish packaged UI, installed runtime lifecycle, actual installer-upgrade or clean-machine compatibility. Tests performed directly against the staged database/API runtime do not substitute for these checks.

## Remaining work classification

| Classification                    | Work                                                                                                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete                          | Implementation, production compilation, unit/browser tests, isolated API/payroll/sync integration, private-runtime failure tests and backup restoration                                            |
| Partially complete                | Desktop lifecycle and installation behavior are implemented but require permitted-machine end-to-end verification                                                                                  |
| Requires Windows testing          | Clean installation, packaged setup/login/routes, second-instance focus, worker/process shutdown, forced crash/OS shutdown, installed data persistence, uninstall/reinstall and older-build upgrade |
| Requires production configuration | Approved signing identity, compatible application-control policy, central HTTPS endpoint and installation-specific canonical node credential                                                       |
| Deferred to Phase 4.5             | Production rollout/hosting, operational backup retention/monitoring and production deployment                                                                                                      |
| Blocked                           | Packaged executable launch on this Device Guard-controlled host                                                                                                                                    |

Use [the packaging guide](phase4.4-desktop-packaging.md) for the actual commands, configuration, compatibility and recovery procedures. Do not classify Phase 4.4 as fully verified until the outstanding installation tests pass on a permitted isolated Windows environment.
