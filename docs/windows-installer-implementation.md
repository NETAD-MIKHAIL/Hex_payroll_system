# Windows standalone installer implementation

Status: unsigned rehearsal implementation; **not approved for coworker distribution**.

## Inspection / gap analysis (2026-11-03)

| Area         | Existing implementation                                                               | Gap / implementation stage                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Packaging    | NSIS shell and built renderer only                                                    | Stage 1: explicit resource staging, bundled API, PostgreSQL runtime and notices, artifact checksums                                    |
| Database     | External connection URLs; immutable, checksum-verified transactional migration runner | Stage 2: private cluster, SCRAM, separate migrator/runtime roles, protected credentials, backups, recovery                             |
| API          | Express with user sessions; externally launched                                       | Stage 2: Electron Node utility process, private launch credential, loopback, readiness and shutdown                                    |
| Sync         | Persistent outbox/inbox/checkpoints/conflicts and retries                             | Stage 3: import individually issued node credentials into Windows-protected storage; no central administrator secret                   |
| Biometrics   | Evidence workflows and manual device configuration; feature flags default off         | Preserve disabled capture; no certified discovery adapter or hardware evidence found                                                   |
| Upgrades     | No private data lifecycle                                                             | Stage 4: stable external data root, no uninstall deletion, backup before migrations, refuse incompatible history                       |
| Verification | Existing unit/database/browser suites                                                 | Run available checks; clean VM, offline, interrupted installation, upgrade/uninstall and hardware checks remain separate release gates |

No payroll calculations, existing migration files, production databases or VPS deployments are authorized to change here. Existing working-tree changes must be retained.

## Release gates

Do not distribute until a disposable Windows VM has passed: clean install with no Node/pnpm/PostgreSQL; network-disabled first launch; local admin setup; runtime-role DDL denial; invalid private API credential rejection; restart and crash recovery; isolated central enrollment and disconnect/reconnect with cursor/outbox preservation; populated upgrade; interrupted setup and interrupted migration recovery; uninstall/reinstall with data and credentials intact. Record Windows version, binary provenance, signatures, artifact hashes and logs. Never use a production central endpoint for rehearsal.

Schema rollback is forward repair or an explicit operator restore into an isolated cluster. Never automatically restore a backup over newer payroll data. Installing an older executable must fail closed when its migration history is older than the cluster.

## Primary references

- PostgreSQL Windows binary distribution: https://www.postgresql.org/download/windows/
- PostgreSQL license: https://www.postgresql.org/about/licence/
- Electron utility processes: https://www.electronjs.org/docs/latest/api/utility-process
- Windows secret protection: https://www.electronjs.org/docs/latest/api/safe-storage
- NSIS options: https://www.electron.build/docs/nsis/

## Stage 1 report: packaging

Files changed: `package.json`, `apps/desktop/package.json`, `apps/desktop/electron-builder.yml`, `apps/desktop/scripts/prepare-resources.mjs`, `audit-resources.cjs`, `artifact-checksums.cjs`, `apps/desktop/notices/drizzle-orm-LICENSE.txt`, and the script-specific Node globals in `eslint.config.mjs`.

The build explicitly bundles the API and JavaScript runtime dependencies, the production frontend, 41 numbered local migrations, PostgreSQL 18.6 Windows runtime binaries, designated Visual Studio x64 CRT redistributables, and dependency notices. It never copies the installed PostgreSQL data directory, `.env`, provisioning passwords, central-only migrations, tests, or diagnostics. Source maps are excluded from the installed UI. A pre-pack manifest/hash audit rejects missing, modified or stale migration resources. Runtime dependencies are compiled into a CommonJS bundle for Electron's Node utility process.

Security implications: the default release command requires code signing. The explicitly named rehearsal command permits unsigned builds. NSIS installs per user without elevation, uses a fixed installation path, disables automatic launch after setup and explicitly preserves application data on uninstall. Automatic updates and production publishing remain disabled. No dependency installation or network access is needed by a coworker at runtime.

Tests/results: production build and resource audit passed. NSIS produced `apps/desktop/release/Hex-Payroll-0.1.0-x64-Setup.exe` and its `.sha256` file. This is an unsigned rehearsal artifact. The source PostgreSQL and CRT files were read from the development machine's distribution directories, not its database. Retain distributor provenance and verify redistribution entitlements before release; replace the documented source overrides with the release build's approved binary inputs.

Remaining limitations: no publisher certificate was supplied; default Electron branding is still present. A generated installer is not evidence of a clean-machine install, recovery or uninstall test.

## Stage 2 report: private PostgreSQL and API

Files changed: `apps/desktop/src/main/index.ts`, `private-runtime.ts`, `private-storage.ts`, `renderer-server.ts`, `apps/desktop/src/preload/index.ts`, `apps/api/src/desktop/runtime.ts`, `router.ts`, `apps/api/src/middleware/private-api.ts`, `apps/api/src/config/env.ts`, `app.ts`, `server.ts`, `apps/web/src/App.tsx`, `api/health.ts`, `vite-env.d.ts`, and `components/DesktopSetup.tsx`.

The installed app stores its cluster, protected credentials, logs and migration backups below `%LOCALAPPDATA%\Hex Payroll\private-runtime`, outside `%LOCALAPPDATA%\Programs\Hex Payroll`. It uses only its bundled PostgreSQL tools and owned cluster marker. It never enumerates, reconfigures or stops unrelated Windows PostgreSQL services. Initialization uses a staging directory and a private named pipe for the generated superuser password. No plaintext password file or command argument is needed. Unknown clusters, missing credentials and interrupted initialization fail closed without deletion.

Security implications: DPAPI protects credentials under the installing Windows account; the private directory has explicit account/SYSTEM access. Loopback-only PostgreSQL uses SCRAM and separate owner, migrator and runtime credentials. Runtime cannot perform DDL, modify migration history, or bypass historical audit restrictions. Migration defaults are applied before migrations, without regranting existing append-only tables. Existing migration bytes and the existing transactional migration runner remain unchanged. A populated cluster gets a custom-format dump before pending migrations. An older application refuses newer/different migration history; it never automatically restores over payroll data.

Electron supervises a Node utility process, waits for PostgreSQL/migrations and a successful API health probe, then opens the UI. The API binds an ephemeral IPv4 loopback port. Its per-launch authentication header is separate from user sessions and never exposed to page JavaScript. The renderer uses a same-origin proxy; only the app's webContents receive the proxy capability header. Other local HTTP clients are rejected. A lost supervisor heartbeat shuts down the API and owned cluster; main also attempts owned-cluster cleanup if the utility process exits unexpectedly. Shutdown is bounded, and startup dialogs identify the retained data folder.

Tests/results: isolated `test:runtime` passed fresh initialization, all local migrations, API health, absent/wrong private credential and hostile-origin rejection, first administrator creation, repeated-bootstrap rejection, runtime DDL/audit/migration-ledger denial, restart, graceful shutdown, pre-upgrade backup, failed-migration DDL rollback, forward repair, downgrade refusal and heartbeat recovery. Reports are retained under `.diagnostics/standalone-*/verification.txt`. These tests use newly generated credentials and a new private cluster, not an existing database.

Remaining limitations: interrupted first-run initialization is deliberately retained for operator recovery rather than automatically discarded. Full backup restore, forced Windows reboot during startup, and a completely clean Windows host remain release gates. DPAPI recovery after losing the Windows account is not automatic; keep a separately protected, tested payroll backup. This implementation does not turn a backup into an automatic downgrade mechanism.

## Stage 3 report: enrollment and biometrics

Files changed: `apps/api/src/desktop/enrollment.ts`, `device-config.ts`, `router.ts`, `runtime.ts`, desktop `private-runtime.ts`/`private-storage.ts`, `apps/web/src/components/DesktopEnrollment.tsx`, `DesktopDevices.tsx`, and `pages/FoundationPages.tsx`.

A signed-in local administrator can import the existing `{nodeId, organizationId, deviceName, token}` credential file and supply the central HTTPS API endpoint separately. The implementation reuses `nodeCredentialSchema` and `importLocalNode`, preserving enrollment rules, hashes, cursors and history. An exact retry is supported after a database commit and failed credential-file save. Changes are serialized into Windows-protected storage and acknowledged only after persistence. Restart enables the existing local sync worker; offline failures retain its durable retry state. There is no central administrator credential, central database connection, or production deployment in this workflow.

Manual device UUID/IP/port inventory is available only to a local administrator for an active device in their organization. It is kept per PC in protected settings. The only accepted protocol label is `manual-unverified`, and `captureEnabled` must be false. Discovery advertises an empty verified-protocol list. Existing biometric evidence, source-closure and attendance code remains in place; no device is declared certified and no new network polling starts.

Tests/results: the three new desktop security tests passed (private API boundary, HTTPS/per-PC credential validation, and disabled/unverified biometric configuration). Existing isolated central enrollment, offline transport, revocation, outbox/inbox and recovery tests ran as part of the API regression suite. No production endpoint was contacted.

Remaining limitations: a local installation must already have the same canonical organization UUID before node import; unrelated organizations are never silently remapped. A fresh independent company setup is not a supported way to join an existing canonical company. Canonical company/user onboarding and the new DPAPI import path still need an end-to-end isolated TLS rehearsal. Capture, trusted evidence and finalization flags remain disabled in the packaged runtime until a separately reviewed hardware/authorization configuration is implemented. Manual IP/port storage alone does not provide a device adapter.

## Stage 4 report: verification and release gates

Files added/changed: `apps/desktop/scripts/verify-runtime.mjs`, `runtime-node-shim.cjs`, `verify-packaged.mjs`, `Test-StandaloneInstaller.ps1`, `apps/api/test/desktop-security.test.ts`, and the renderer CSP expectation in `apps/api/test/pilot-scope-database.test.ts`.

Results recorded so far:

- `pnpm typecheck`: passed.
- `pnpm build`: passed.
- Targeted ESLint for new runtime, scripts, forms and security tests: passed.
- Existing browser regression suite: all 16 passed, including isolated offline Office/central/WFH attendance.
- Existing pure payroll-engine regression suite: all 42 passed; no calculation implementation was changed.
- Existing guarded API regression run: 290/291 passed; the single failure expected the previous fixed-port CSP. That expectation was corrected for the authenticated same-origin proxy. The affected pilot file plus new desktop tests were rerun: all 6 passed. Do not describe this as a second full green suite run.
- Isolated packaged Node runtime rehearsal: all checks above passed.
- Real unpacked Electron/DPAPI GUI rehearsal: passed first-run administrator creation, user sign-in through the private same-origin proxy, rejection of other local HTTP clients, restart with retained/decryptable credentials, PostgreSQL shutdown when Electron closes, and owned-cluster cleanup/reopening after forcibly terminating the named local utility process. Final report: `.diagnostics/packaged-1793691291034/verification.txt`.
- Final isolated runtime/recovery report: `.diagnostics/standalone-1793690894771/verification.txt`.
- Final installer: 142,920,339 bytes; Authenticode status `NotSigned`; SHA-256 `7581292c99a5c49d22acbfe6cdce5c5798fe5dabf3843fc8a300172dafaafe83`. The generated checksum file matched an independent `Get-FileHash` check. Unpacked resource exclusion scan and PowerShell VM-script syntax check passed.

The PowerShell installer rehearsal script is prepared for a disposable VM. It verifies checksums before executing, refuses an existing app/data folder, then exercises silent install, offline-ready startup, graceful shutdown, restart, optional upgrade, uninstall retention and reinstall. It has **not** been run here. Windows Sandbox and Hyper-V tooling were not available on this workstation. It does not substitute for populated payroll comparisons, interrupted NSIS installation, account recovery, backup restore or hardware testing.

## Build and verification commands

From the repository root:

```powershell
pnpm package:win:rehearsal  # unsigned internal rehearsal only
pnpm --filter @hexpayroll/desktop test:runtime
pnpm --filter @hexpayroll/desktop test:packaged
```

Approved release builders use `pnpm package:win` with their signing configuration (for example electron-builder's `CSC_LINK` and `CSC_KEY_PASSWORD`, supplied securely by the build environment). Neither certificate nor password belongs in this repository. Packaging always uses `--publish never`.

Binary input overrides: `HEX_POSTGRES_SOURCE` points to an approved PostgreSQL 18 Windows distribution; `HEX_VC_REDIST_SOURCE` points to its licensed Visual Studio x64 CRT redistribution folder; `HEX_VC_REDIST_NOTICE` points to that Visual Studio distribution's `Redist.txt`. The default paths match this workstation. Never point these at `System32` or at a database directory.

Verify the generated setup hash against the `.sha256` file obtained through a trusted channel:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\apps\desktop\release\Hex-Payroll-0.1.0-x64-Setup.exe'
Get-AuthenticodeSignature -LiteralPath '.\apps\desktop\release\Hex-Payroll-0.1.0-x64-Setup.exe'
```

After a startup failure, retain `startup-status.json`, `postgres.log`, rotated cluster logs and the original data folder. Never delete `postmaster.pid`, the cluster marker, the migration ledger or protected credentials to make an error disappear. Stop owned services normally before operator recovery. Restore only into a separate, explicitly chosen cluster and verify payroll/history before considering a switch.
