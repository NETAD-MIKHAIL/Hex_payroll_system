# Phase 4.4 — Windows desktop packaging

Hex Payroll 0.1.0 targets Windows x64 with electron-builder 26.15.3 and a per-user NSIS installer. Phase 4.5 deployment, signing credentials, production hosting and automatic updates are outside this change.

## Reused infrastructure and packaging gaps

The existing Electron shell supplied a sandboxed preload, single-instance protection, an independent React build and an NSIS configuration. The API already supplied authentication/RBAC, restricted runtime roles, checksummed numbered SQL migrations, attendance processing, durable synchronization queues and protocol-2 central transport.

Phase 4.4 adds production resource staging, private PostgreSQL initialization and ownership checks, Electron utility-process services, startup/error UI, a fixed renderer origin, desktop request authentication, offline administrator bootstrap, maintenance-mode credential import, migration backups and Windows packaging tests. The payroll engine, numbered SQL migrations and central server are unchanged.

## Building

Use the repository-pinned pnpm version and Node.js version supported by the root manifest on a Windows x64 build computer:

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm desktop:pack
pnpm test:desktop
pnpm desktop:dist
```

`pnpm build` compiles production code. `desktop:stage` stages runtime resources after compilation. `desktop:pack` builds the unpacked application; `desktop:dist` builds NSIS. The installer is `apps/desktop/release/Hex Payroll Setup.exe`; the unpacked executable is `apps/desktop/release/win-unpacked/Hex Payroll.exe`.

`pnpm test:desktop` exercises the staged database/API runtime in a unique directory under `apps/desktop/build/test-runs`. `node scripts/test-desktop-ui.mjs` exercises the unpacked executable with an isolated LOCALAPPDATA. Pass an installed executable path as its argument to exercise that installation. Reports and screenshots remain under `apps/desktop/build` for review. Tests never import the development database.

Build tools are required only on the build computer. Installed users do not need Node.js, pnpm, PostgreSQL, TypeScript, Express or Vite installed separately. Build scripts download pinned archives; application startup never downloads runtime binaries.

Staging converts pnpm's locked dependency graph to ordinary directories without junctions. An explicit `afterPack` hook copies this tree because electron-builder excludes nested dependency directories from ordinary extra-resource copying. Build validation rejects dependencies outside the standalone runtime. A checked-in pnpm patch for app-builder-lib 26.15.3 preserves the Windows environment when generating the NSIS uninstaller; package versions are unchanged.

PostgreSQL 18.6 comes from EDB's distribution linked by PostgreSQL.org. `apps/desktop/postgres-runtime.json` records its HTTPS source and SHA-256. The PostgreSQL hash was recorded from the downloaded archive, rather than an independently published vendor checksum. Microsoft C++ 14.44.35211 runtime DLLs are extracted app-locally from a pinned Microsoft redistributable after SHA-256 and Authenticode verification. No redistributable installer or elevation runs on application startup. Archive layouts and hashes are pinned; changing either runtime requires a deliberate manifest update and repeat validation.

The stage includes PostgreSQL binaries, libraries, support data and backup tools. Optional Perl, Python and Tcl language extensions are excluded because payroll does not use them and their external interpreters are not bundled. PE import inspection checks normal and delayed imports against bundled libraries and an explicit Windows system-library list. A runtime dependency manifest is included. Clean-machine execution is still necessary to establish environmental compatibility.

## Installation and first use

Run the installer as the intended Windows user. It creates Start Menu and desktop shortcuts and supports normal uninstall. No publisher or signing identity is invented. Without a configured signing certificate, this build is unsigned and may trigger SmartScreen warnings; production signing and reputation must be addressed before distribution.

On first launch, Hex Payroll initializes a separate private PostgreSQL cluster, provisions unique roles, applies migrations and opens a one-time administrator form. Passwords follow existing account validation (15–128 characters). Account creation and administrator selection are atomic and cannot be replayed. Sign in with that account and complete the existing company setup. Internet and central configuration are optional.

An existing development PostgreSQL installation is neither adopted nor modified. Importing its records is outside this phase.

## Persistent storage and security

Persistent data lives in `%LOCALAPPDATA%\Hex Payroll`, independently of installed resources:

| Directory       | Contents                                                                               |
| --------------- | -------------------------------------------------------------------------------------- |
| `database`      | PostgreSQL 18 cluster                                                                  |
| `configuration` | DPAPI-encrypted role credentials, cluster identity/port, non-secret sync configuration |
| `logs`          | Rotated structured desktop events and PostgreSQL diagnostics                           |
| `sync`          | Reserved local sync resources; durable queues/checkpoints remain in PostgreSQL         |
| `backups`       | Custom-format backups before upgrade migrations                                        |

Electron's userData is set to this same root. Chromium may also create its own user-data files there. The root ACL grants the current Windows user and SYSTEM access and removes inherited grants. Treat database files and backups as sensitive payroll records; they are not encrypted database storage. DPAPI protects credentials for the Windows user and is not a portable backup mechanism.

The database listens on IPv4 loopback and uses SCRAM. A random private port is selected at each stopped-cluster startup. Running clusters are adopted only after authenticating with installation-specific credentials and verifying the exact data directory and PostgreSQL system identifier. Supported `pg_ctl` checks handle stale locks; the application never removes a lock blindly or kills processes by executable name.

Bootstrap credentials remain in the database utility process. Migrations use the schema owner. The API receives only the restricted application connection and a random per-launch desktop token over private IPC. The compiled API binds to loopback port zero and reports the actual bound port. The renderer uses `hexpayroll://app`; Electron proxies `/api` and inserts the desktop token. React never receives database credentials or this token. Existing bearer authentication and RBAC remain required for user operations. The desktop guard checks the token, Host and Origin before routes, including setup and health.

The preload exposes immutable runtime facts only. Context isolation, sandboxing and disabled Node integration remain enabled. Navigation and window creation are restricted; external HTTPS links may open in the default browser. Content Security Policy limits application scripts and connections to the application origin.

Startup progresses through database readiness, migrations, API readiness and authenticated health checks. One API process owns the existing background workers. Central outages do not block startup. Maintenance mode starts no background workers. Shutdown stops workers and requests, closes pools and uses `pg_ctl fast` against the verified private cluster. Startup-time database work is serialized before shutdown; normal API shutdown has a 25-second deadline and database startup/shutdown has a bounded extended deadline for an in-progress initialization or backup. Windows session-ending notification requests best-effort shutdown; forced OS termination cannot guarantee completion.

## Configure central synchronization

Close the normal application, then run:

```powershell
& 'C:\path\to\Hex Payroll.exe' --admin
```

The same single-instance lock prevents concurrent normal and maintenance services. If Hex Payroll is already open, close it before launching the utility. Sign in as a local administrator. Use a device credential issued by the existing central node administration workflow, enter the central HTTPS endpoint and select whether transport should be enabled on the next normal launch.

The utility reuses the existing node-import service, checks canonical organization identity and stores the node token in Windows Credential Manager. Non-secret settings are saved atomically to `configuration/sync.json`. Retry an interrupted import with the same credential after reviewing local state. Remove the transferred credential file securely after a successful import. Close the utility and launch normally to start synchronization. No shared production secret or development central URL is embedded.

When joining an existing central organization on a fresh workstation, create the local administrator and use maintenance mode to import the canonical device identity before completing an independent local company setup. The existing import service can initialize the matching organization; it refuses to overwrite a different organization that has already been created locally.

Device registration, authentication and connection state continue to appear through the existing synchronization screens. Registration issuance and central server administration remain the existing Phase 4.3 workflows.

## Upgrades, backups and recovery

Ordinary installation upgrades and uninstall preserve persistent data by default. Keep the same application identity and Windows user. Application 0.1.0 requires PostgreSQL cluster major version 18 and sync protocol 2. An incompatible cluster major or an applied migration missing/changed in the installer blocks startup; downgrading application versions is not assumed safe. Major PostgreSQL conversion requires a separate explicit upgrade workflow.

Before pending migrations on an existing migration history, `pg_dump -Fc` creates a backup under `backups` and `pg_restore --list` validates its archive directory. Backup creation/validation failure blocks migration. Each numbered migration remains transactional. A failure preserves the cluster and committed migration history and stops the API from starting. A successful archive listing alone does not prove recovery; use the isolated restore test and perform representative recovery drills before relying on an upgrade.

To restore, close all Hex Payroll instances, preserve the entire existing data/configuration directory, and have an administrator restore the chosen archive with the bundled `pg_restore` into a separate PostgreSQL 18 database/cluster with the same role model. Verify records, migration history, privileges and sync identity before any intentional replacement. Never restore into the only copy of a payroll database. Database archives contain sync state; protect the matching Windows Credential Manager token and configuration separately. Moving to a different Windows user may require reauthorizing the device.

Missing runtime files can be repaired by reinstalling the same application version without deleting data. Disk, permission, credential-decryption, interrupted initialization, cluster-version, ownership and migration failures show a reference and log location. Interrupted `database-initializing` directories require administrator review; they are never overwritten. No automatic database reset is provided.

To intentionally remove payroll data, first create and verify a backup and obtain explicit administrator confirmation, close the application, uninstall it and then remove only `%LOCALAPPDATA%\Hex Payroll`. Remove the corresponding `HexPayroll/Sync/<node-id>` credential through Windows Credential Manager only after reviewing the installation's registration. Normal uninstall does neither.

PostgreSQL records only panic-level server diagnostics and suppresses SQL statements, parameters and error details; ordinary SQL errors can contain personal values. Structured desktop service checks report startup and availability failures. Desktop logs retain allowlisted events rather than raw worker output. Electron/Node notices remain with the application, PostgreSQL/EDB and Microsoft notices accompany the runtime, and dependency notices are collected under installed `resources/notices`.

## Verification boundaries

Record actual results in the Phase 4.4 implementation report. A successful build does not establish fresh installation, packaged UI, upgrade, offline reconnect or restore correctness. A host installation test does not establish clean-machine compatibility when the host already has development runtimes installed. No clean disposable Windows VM or Windows Sandbox should be assumed available.

Production central URLs, operational backup retention, signing credentials, rollout and production deployment remain Phase 4.5 responsibilities.
