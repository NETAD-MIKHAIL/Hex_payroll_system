# Step 73P — Controlled pilot readiness

Status: **hold at authorization checkpoint**. Preparation and isolated verification
do not authorize a real pilot. No live database query, migration, backup, role
provisioning, service operation, deployment or hardware access was performed.
Office/VPS/WFH are intended environment labels, not verified identities of this
workstation. Live PostgreSQL versions, ledgers, sizes, grants and queue states remain
unknown until the commands below are run by an authorized operator.

## Verified repository facts and readiness matrix

The worktree contains extensive pre-existing modified/untracked Step 73K–73O work.
It was preserved. Freeze and review a release commit and build hashes before any
deployment; the current workspace is not a reproducible approved release.

| Item                                                 | Office PC                                        | VPS central                     | WFH laptop                  |
| ---------------------------------------------------- | ------------------------------------------------ | ------------------------------- | --------------------------- |
| Intended database                                    | `payroll_sys`                                    | `payroll_central`               | its own `payroll_sys`       |
| Actual host/database/schema identity                 | Unverified                                       | Unverified                      | Unverified                  |
| PostgreSQL 18, live size, ledgers and grants         | Unverified                                       | Unverified                      | Unverified                  |
| Backup and independent restore rehearsal             | Not performed                                    | Not performed                   | Not performed               |
| Node UUID and canonical organization binding         | Unverified                                       | Unverified                      | Unverified                  |
| Existing pending work and quarantine review          | Unverified                                       | Unverified                      | Unverified                  |
| HTTPS/certificate/firewall/service state             | Central URL unverified                           | Unverified                      | Central URL unverified      |
| Runtime/writer segregation                           | Repository verifier exists                       | Actual provisioning unverified  | No writer permitted         |
| Pilot scope configuration                            | Not installed                                    | Not installed                   | Not installed               |
| Packaged renderer + local API/PG offline smoke       | Passed on this nonproduction Windows workstation | Not applicable                  | Not tested on actual laptop |
| Installed/signed Windows release and API supervision | Pending                                          | Not applicable                  | Pending                     |
| Physical device completeness                         | Unassessed                                       | Coverage/policy not provisioned | Not applicable              |

The repository contains **41 shared migrations** and **8 central-only migrations**.
The bundled `deploy/central-api-linux` documentation/runtime is an older artifact
describing shared migrations through 0031 and must not be deployed for this pilot.
It does not contain the current central migration/writer workflow. Rebuild a new
reviewed runtime from the frozen source instead of reusing the tarball.

The schedule/assignment/leave acceptance and trusted identity publication services
are implemented and tested, but `createApp` does not expose an administrative
acceptance/publication route or operator CLI backed by the evidence writer. The
running server configures the attendance writer only. A reviewed operator tool or
administrative integration for those prerequisites is therefore still required;
the isolated fixtures' direct service calls are not a deployed enrollment workflow.
Do not manufacture acceptance rows or actor references with owner SQL to compensate.

## A. Read-only environment inventory

Use an existing protected libpq service definition and password file for a
metadata-capable diagnostic account. Do not create roles, edit grants, paste URLs
with passwords, print environment files, enumerate sessions, or dump employee
tables. Do not use a migration command to discover pending migrations: the runners
write ledger/DDL. These commands use only catalog metadata, migration metadata,
installation UUIDs and aggregate counts, inside a read-only transaction with timeouts.

Run separately **on Office and WFH**, from a reviewed checkout or diagnostic bundle:

```powershell
Set-Location D:\hexpayrollsys
git status --short
git rev-parse HEAD
psql --version
# Set service independently on each PC; verify its target privately first.
$env:PGSERVICE = 'hex_office_inventory' # WFH: hex_wfh_inventory
$env:PGOPTIONS = '-c default_transaction_read_only=on -c search_path=public'
psql -X -q -v ON_ERROR_STOP=1 -f database/diagnostics/pilot-readiness.sql -o office-readiness.txt
psql -X -q -t -A -v ON_ERROR_STOP=1 -f database/diagnostics/pilot-ledgers.sql -o office-ledgers.json
# WFH uses wfh-readiness.txt / wfh-ledgers.json instead.
Remove-Item Env:PGOPTIONS
Remove-Item Env:PGSERVICE
```

On the **VPS**, use its existing reviewed connection and checkout/bundle paths:

```sh
cd /path/to/reviewed/hexpayrollsys
git status --short
git rev-parse HEAD
psql --version
PGSERVICE=hex_central_inventory PGOPTIONS='-c default_transaction_read_only=on -c search_path=public' \
  psql -X -q -v ON_ERROR_STOP=1 -f database/diagnostics/pilot-readiness.sql -o central-readiness.txt
PGSERVICE=hex_central_inventory PGOPTIONS='-c default_transaction_read_only=on -c search_path=public' \
  psql -X -q -t -A -v ON_ERROR_STOP=1 -f database/diagnostics/pilot-ledgers.sql -o central-ledgers.json
```

`public` is an explicit assumption to verify, not a discovered fact. If another
application schema is in use, review and substitute that schema consistently.
Stop if the first inventory row shows an unexpected database/schema/role or if
permissions/timeouts prevent complete inventory; an omitted result is not zero.
The commands never inspect token/password values, names, punch contents or errors
that might contain employee data. Store metadata outputs privately too.

Compare each exported ledger offline in this checkout (no database connection):

```powershell
node --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/src/cli/pilot-migration-report.ts office-ledgers.json
node --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/src/cli/pilot-migration-report.ts wfh-ledgers.json
node --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/src/cli/pilot-migration-report.ts central-ledgers.json
node --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/src/cli/pilot-migration-report.ts --manifest
```

This compares every filename and normalized-LF SHA-256 checksum. `drift` is a hard
stop. `notApplied` is authoritative only for that actual exported ledger. The
central list printed for a local database is **not applicable**, not an instruction
to apply it there. No per-environment unapplied list can honestly be established
before those live ledgers are supplied. The repository manifest is also recorded
in `.diagnostics/step-73p-migration-manifest.ndjson`.

Additional read-only host checks, without printing service environment/secrets:

```powershell
# Both Windows PCs: no startup/restart or configuration changes.
Get-Service | Where-Object Name -Match 'postgres|hexpayroll' | Select-Object Name,Status
Get-NetTCPConnection -State Listen | Where-Object LocalPort -In 4311,5432,5433 | Select-Object LocalAddress,LocalPort,OwningProcess
```

```sh
# VPS: substitute reviewed names/hostname. No reload/restart; no journal dump.
systemctl is-active hexpayroll-api
systemctl show hexpayroll-api --property=User,Group,WorkingDirectory,FragmentPath
ss -ltn '( sport = :4311 or sport = :5433 )'
curl --fail --silent --show-error --connect-timeout 5 https://REVIEWED_HOST/api/health
openssl s_client -connect REVIEWED_HOST:443 -servername REVIEWED_HOST </dev/null 2>/dev/null \
  | openssl x509 -noout -dates -issuer -subject
```

Compare configured node UUIDs privately with inventory rows; never print their
token or its hash. Independently review protected configuration in place and record
only present/absent/matches for central URL, database target, node UUID and writer
connections. TLS health alone does not verify authorization or source completeness.

## Migration risk and dependency review

All migrations are ordered, checksum-protected, explicit operator actions. Shared
and central runners share an advisory lock; central runner requires the full current
shared ledger and an explicit matching central database name. Neither desktop nor
API startup runs migrations.

| Shared range | Risk and dependency                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0001–0006    | High: authentication, organization/RBAC, workforce and relationship constraints; existing account/data compatibility review first                |
| 0007–0014    | High: schedules, time records, leave, attendance, overnight rules and immutable history; existing data can fail constraints                      |
| 0015–0016    | Medium: processing actor/queue fairness; review pending local work before workers run                                                            |
| 0017–0027    | High: existing payroll storage, rules, freezes and permissions; schema dependencies only, no calculation or payroll selection change authorized  |
| 0028–0032    | High: transport, delivery safety, restricted runtime grants and inbox materialization; inspect legacy pending/account quarantine first           |
| 0033–0037    | High: proposal snapshots, trusted evidence/actors, reconciliation and immutable histories; Step 73M holds remain                                 |
| 0038–0039    | High: durable biometric provenance, closures and trusted attendance delivery; no device capability inferred                                      |
| 0040         | Medium: immutable desktop command/outcome journal; no approval authority                                                                         |
| 0041 (new)   | High: optional schema-wide pilot fence; empty/default-off; adds triggers without activating scope; scan and locks on explicit scope installation |

| Central-only migration                 | Risk and dependency                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| 0001 canonical attendance storage      | High: central request/state/decision/history storage, never on PCs                            |
| 0002 evidence authorizations           | High: current central session/node authorization                                              |
| 0003 trusted evidence protocol         | High: authoritative publication and immutable snapshots                                       |
| 0004 acceptance writer guards          | High: separate restricted capability and append-only guards                                   |
| 0005 trusted identity publication      | High: credential-free actor references; not account synchronization                           |
| 0006 biometric evidence receipts       | High: authenticated source/node binding and immutable raw receipts                            |
| 0007 source certification/finalization | High: source assessments, coverage, policies, canonical acceptance and trusted attendance     |
| 0008 pilot fence (new)                 | High: extends shared 0041 guards onto central-only tables; does not grant canonical authority |

Review lock duration/disk headroom and rehearse all pending migrations on a private
restore. Do not bypass failed constraints, checksum mismatches, triggers or writers.
Reversing shared schema migrations in place is not the rollback strategy.

## Pilot scope and safe holds

Shared 0041 adds an empty `attendance_pilot_scope` table. Runtime cannot insert,
update, delete or truncate it. Its owner-installed allowlists cover organization,
employee, device, enrolled node and native device employee identities, recursively
including nested evidence and canonical JSON snapshots. Installation scans existing
tables under write-blocking locks and rolls back if **any** scoped historical value
is outside the allowlists. Row triggers then reject out-of-scope writes atomically.
Central 0008 covers central-only tables. Future tables need explicit trigger coverage
and migration review; the diagnostic output reports coverage.

A pinned-search-path, read-only security-definer function exposes only the activation
bit to the sync-only runtime; it does not require granting that role policy or
business-table reads. Database guards use a separately pinned trigger function.

This intentionally supports a **dedicated, coherent pilot dataset**, not a filter
over a mixed operational database. A real `payroll_sys` or `payroll_central` with
nonpilot organizations/employees/history **cannot activate this fence**. Do not
delete, remap or trim those live records to make it pass. Mixed live databases remain
blocked pending a separately reviewed scoped-stream implementation or a separately
authorized pilot database/schema design. No such topology change is authorized now.

The first pilot should contain one reviewed organization, a small explicit employee
UUID set, one dedicated test device with only those native identities, and exactly
the enrolled Office/WFH nodes. IDs are selected by operators, never generated fake
employees in live databases. A shared device that returns other employees' logs is
held as a whole; dropping records and advancing its checkpoint is prohibited.

During an active scope, the API blocks unrelated mutations, including payroll and
reconciliation. Generic push/pull/apply and broad trusted identity/evidence streams
are held in backend services; the trusted worker skips those broad streams while
continuing scoped biometric/closure and attendance delivery. Database guards apply
even to direct service calls and canonical writer transactions. Missing/unknown
native identities roll back the complete batch; no capture checkpoint or central
receipt is acknowledged. Scope violations are operator holds, never auto-expansion.

Pre-stage accepted schedule/assignment/leave revisions and trusted actor references
through the existing reviewed mechanisms **before** activation, while all background
workers are stopped in the authorized maintenance window. Verify their immutable
fingerprints across both PCs. In-scope evidence changes still invalidate proposals.
Schedule/actor updates requiring broad delivery pause this pilot; this is a limitation,
not permission to reenable broad streams while it is running.

The scope installation statement is deliberately not supplied with live IDs or
executable deployment automation. Review a specific allowlist document, policy JSON,
all historical dependencies and its scan result on the restore before authorizing
the owner to install it. Runtime/attendance writer cannot widen this scope. Scope
removal is also an owner-only, reviewed maintenance action with workers stopped.

Keep these durable holds visible and unchanged:

- `RECONCILIATION_IMMUTABLE_CHILD_BLOCKER`,
  `RECONCILIATION_IMMUTABLE_HISTORY_BLOCKER` and
  `RECONCILIATION_UNBOUND_AGGREGATE`: preserve both identities and history; isolate
  affected periods/employees, do not overwrite children or transfer UUIDs.
- Generic account/RBAC snapshots: retain quarantined/pending rows and receipts;
  never mark them delivered, clear their errors or restore generic account authority.
  Review any previously applied changes as a security issue before pilot enrollment.
- Local pending processing, leased outboxes, deferred inboxes and unconfirmed desktop
  requests: inventory counts, reasons and ownership privately. Preserve identities,
  leases and exact retry payloads. No blanket queue deletion, cursor reset, retry-all
  or conflict resolution. Conflicted pilot prerequisites block that pilot scope.

## B. Backup and independent restore rehearsal

These are **future authorized operator steps**, not actions performed by Step 73P.
Use one protected backup destination per environment, adequate free space, encryption
at rest and restricted OS permissions. Archives contain real personal data; never
upload them into this repository or print their contents. Use protected libpq services
and password files, not credentials in commands or documentation.

Windows Office example (repeat separately on WFH with different service/file):

```powershell
# Only after backup authorization; destination must already be secured.
pg_dump --dbname='service=hex_office_backup' --format=custom --no-owner --no-acl --file='E:\ProtectedBackups\office-prepilot.dump'
if ($LASTEXITCODE -ne 0) { throw 'Backup failed' }
pg_restore --list 'E:\ProtectedBackups\office-prepilot.dump' > 'E:\ProtectedBackups\office-prepilot.toc'
if ($LASTEXITCODE -ne 0) { throw 'Archive unreadable' }
Get-FileHash -Algorithm SHA256 'E:\ProtectedBackups\office-prepilot.dump'
```

VPS equivalent, using its protected destination and backup role:

```sh
umask 077
pg_dump --dbname='service=hex_central_backup' --format=custom --no-owner --no-acl --file=/PROTECTED/central-prepilot.dump
pg_restore --list /PROTECTED/central-prepilot.dump > /PROTECTED/central-prepilot.toc
sha256sum /PROTECTED/central-prepilot.dump
```

Check exit status after each Unix command; stop on any failure. Save backup time,
server version, database identity, size, migration metadata and archive hash. Capture
role/grant definitions separately without password verifiers using an authorized
`pg_dumpall --roles-only --no-role-passwords` connection, into the protected backup
area. No production role change is needed to prepare this plan. Record schema owners
and exact grants too: `--no-owner --no-acl` means they must be rebuilt/reviewed on restore.

Rehearse each archive independently on a **separate disposable PostgreSQL 18
instance**, disconnected from workers, real device LAN and VPS, with the database
named `hexpayroll_test`. Do not restore over the working test database or a live
database. Confirm the rehearsal service's host, port, instance and empty target first:

```sh
# REVIEWED rehearsal instance only; never a payroll_sys/payroll_central service.
psql 'service=hex_rehearsal_admin dbname=postgres' -X -c 'SELECT current_database(),inet_server_addr(),inet_server_port(),version();'
createdb --maintenance-db='service=hex_rehearsal_admin dbname=postgres' hexpayroll_test
pg_restore --dbname='service=hex_rehearsal_target dbname=hexpayroll_test' --single-transaction --exit-on-error --no-owner --no-acl /PROTECTED/environment-prepilot.dump
```

Verify restore exit status, ledger checksums, relation counts, constraints, immutable
triggers and private integrity checks without outputting employee records. Rebuild
only rehearsal roles/grants, apply pending migrations there in order, test restricted
writers and the actual proposed scope, and run the simulated attendance workflow.
Archive readability alone is not restore proof. Record elapsed time and usable
rollback/recovery time for each environment; no real restore has been rehearsed here.

## Reviewed deployment sequence (not executed)

1. Complete live metadata inventory and security review; freeze a clean reviewed
   source commit, lockfiles, build manifest and hashes. Resolve the pilot dataset
   topology blocker and approve exact employee/device/node scope.
2. Review independent backup and restore results. Enter an explicitly authorized
   maintenance window, quiesce workers/capture, and take final per-environment backups.
3. Apply only missing shared migrations in order on each approved target using the
   migration role. Confirm matching ledgers. Apply central-only 0001–0008 on the VPS
   only, using the explicit central target guard. Never run central DDL on PCs.
4. Provision distinct central evidence and attendance writers with existing verifier/
   provisioning routines and reviewed least-privilege SQL. Neither may be owner,
   superuser, role member, schema creator or password-verifier reader. Runtime/node
   credentials cannot write canonical decisions. Keep migration credentials out of
   API runtime and desktop packages. Test negative grants on the restore first.
5. Stage a newly built central runtime into a new release directory. Review protected
   environment, service account/working directory, loopback bindings, HTTPS reverse
   proxy and certificate chain. Keep PostgreSQL and API ports private. No existing
   service restart or switch is authorized by this document.
6. Provision approved central users, independent exception reviewers/approvers and
   organization/node enrollment through existing authorized commands, privately.
   No generic account synchronization. Verify trusted actor references and immutable
   accepted schedule/assignment/leave inputs on both PCs before scope activation.
7. Install the reviewed Windows build and separately supervised loopback API with
   existing PostgreSQL. Electron now serves its bundled UI on ephemeral loopback;
   it **does not bundle, launch or supervise PostgreSQL or the API**. Installation
   paths, service management, Windows signing and actual Office/WFH acceptance remain
   prerequisites. The test package is unsigned and is not an approved installer.
8. Install the reviewed schema-owned pilot scope only after restore validation and
   with all writers/workers quiesced. Confirm all application tables have guards.
   Keep generic and broad evidence/identity delivery held. Enable only approved pilot
   flags in a separate reviewed activation change.
9. Verify Office capture/central outage/reconnect, certification, authorized proposal/
   finalization, both trusted receipts, replay, reopening, restart and identical
   canonical revisions. Inspect limitations and audit before declaring a pilot passed.

Flag review checklist (record actual present/absent/value privately, no secret output):

- `SYNC_MODE`: default `disabled`; approved locals `local`, VPS `central`.
- `SYNC_BIOMETRIC_EVIDENCE_ENABLED`, `SYNC_TRUSTED_EVIDENCE_ENABLED`,
  `ATTENDANCE_FINALIZATION_ENABLED`: default `false`; retain off until activation
  authorization. Finalization requires biometric and, locally, trusted delivery.
- `SYNC_CENTRAL_URL`: reviewed HTTPS origin, no URL credentials/query/fragment;
  `SYNC_NODE_ID`/private token must match current enrollment.
- `CENTRAL_ATTENDANCE_WRITER_DATABASE_URL`: separate verified VPS-only capability;
  evidence writer is also separately controlled. No writer connection on PCs.
- `DATABASE_URL`: DML-only target; DDL credentials only in explicit migration process.
  `API_HOST=127.0.0.1`; firewall/TLS and `SYNC_INTERVAL_MS` reviewed.

## Rollback and disable

An incident first disables capture and pilot synchronization/finalization in the
authorized service configuration, then stops affected workers/API under operator
control. Disconnect central sessions and revoke compromised nodes only through the
reviewed administrative procedure. Preserve logs, unconfirmed commands, immutable
receipts, raw evidence, queues and policy. Do not mark failed delivery as successful.

Do not remove the scope while workers run: that would reopen broad streams. Keep
it installed until an approved maintenance action. Do not deploy an older binary
against an incompatible migrated schema. Prefer disabling features while retaining
schema/audit; if a full restore is required, restore verified matching backups and
binaries as a coordinated set, account for all post-backup evidence and reconcile
through reviewed append-only procedures. Never reset cursors or reuse receipt IDs.
Capture RPO/RTO from rehearsal before approving any live migration.

## Physical source capability assessment (not performed)

Record the exact model, serial reference privately, firmware, SDK/library versions,
transport and signed vendor/SDK documentation. Verify rather than infer:

1. Stable immutable native entry IDs, reliable ordering/sequence ranges and epoch
   changes on reset, rollover, deletion, replacement and clock/time-zone changes.
2. Complete native inventories, including trailing/missing entries, guard entries,
   delayed punches, pagination consistency and outages. A timestamp or contiguous
   local batch ordinal does not prove completeness.
3. Bounded signed closure manifests for the full padded overnight shift window,
   time zone, inventory and assessed epoch/key. Identify who can sign and whether
   the device/SDK actually provides the proof; a collector signature alone does not
   establish that device logs were complete.
4. Employee/native identity mapping and required device coverage, including updates,
   employee transfers and employees expected on more than one device.
5. Durable capture, transactional checkpoint acknowledgement, duplicate identity/
   changed-payload rejection and recovery after disconnect/restart at each boundary.
6. If proof is unavailable, preserve `unsupported`/unresolved status. Assess signed
   export plus independent attestation commitments against an explicitly reviewed
   exception policy with separate reviewer and approver. A reason alone is insufficient;
   known gaps/conflicts cannot be waived. Limitations remain in final attendance audit.

## Verification and authorization checkpoint

| Check                                                              | Final result                                                                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Full API regression                                                | **288 passed, 0 failed, 0 skipped**; all 284 baseline cases retained                                                                             |
| Complete frontend suite                                            | **16 passed, 0 failed, 0 skipped**                                                                                                               |
| Final targeted scope/worker checks                                 | **7 passed, 0 failed, 0 skipped**                                                                                                                |
| Shared, API, frontend and Electron builds                          | Passed                                                                                                                                           |
| API/frontend/desktop typechecks and strict new API-test typechecks | Passed                                                                                                                                           |
| Scoped source/test ESLint and Prettier                             | Passed                                                                                                                                           |
| `git diff --check`                                                 | Passed                                                                                                                                           |
| Windows x64 unpacked package build                                 | Passed; unsigned, not installed or distributed                                                                                                   |
| Final packaged Electron smoke                                      | Passed: fresh login, real isolated local API/PostgreSQL, simulated central outage, evidence view, restart and fresh login with evidence retained |
| Archive inspection                                                 | 6 ASAR entries; no environment/private-key files                                                                                                 |

The four additional API cases cover static loopback file boundaries, owner-only
scope installation/mixed-history rejection, scoped transactional ingestion and
central finalization, and worker holds/failed-policy reads. The scope case also
checks API mutation holds, no generic cursor advance, and restricted-writer denial.
After the complete run, the same seven targeted tests were rerun with additional
metadata pending/last-receipt diagnostic queries and trusted attendance delivery to
two local schemas while the fence was active. Both local projections converged.

The initial complete API run found a sync-only-role permission regression in the
pilot activation check. It was fixed with the narrow activation-bit function; the
final complete run passes without broadening business-table access. Final logs:
`.diagnostics/step-73p-api-regression-final.log`, `step-73p-frontend.log`,
`step-73p-scope-final.log`, `step-73p-package-final.log` and
`step-73p-package-smoke-final.log`. Existing repository-wide lint/format issues
outside this scope remain as documented in Step 73O.

Test package SHA-256 (not a code signature or deployment authorization):

```text
Hex Payroll.exe 3185238E8E407E61BF666BC7B7D1DF1ABEEFA000058524C519CF1A922D823F0D
app.asar        279D3597769F1072B04F344C6C7DA1FF4E458232DE6326D5B304F24C94B029AF
```

The smoke harness binds its isolated API exclusively on loopback port 4311 before
launching Electron; it aborts if another service owns that port. It never probes,
stops or replaces an existing local API. Only dedicated test credentials exist in
the fixture process; Electron receives a sanitized environment without database
URLs, writer connections or node tokens. The build uses the existing renderer
whitelist, serves only allowed static files, keeps `Origin:null` closed at the API,
blocks cross-origin window navigation and refuses external file/custom protocols.

Test artifacts and metadata logs remain in `.diagnostics/step-73p-*`; the package smoke screenshot is
[packaged offline attendance](../.diagnostics/step-73p-packaged-offline.png).

**STOP:** No deployment, database/role write, service restart, feature activation or
hardware access is authorized. Remaining blockers include live inventory, exact
pending migrations, backup/restore proof, mixed-dataset scope compatibility,
restricted writer/enrollment/TLS validation, current deployment artifacts, signed
installer/API supervision on both PCs, administrative accepted-evidence/identity
publication tooling and real device capability assessment.

The next authorization should name the precise environment and approved action,
release/hash, scope, maintenance window, backup/rehearsal evidence, rollback owner
and activation flags. Approve the read-only inventory first if execution by this
agent on a named real environment is desired; pilot activation needs a separate
review after those facts are known. Passing isolated tests does not approve a pilot.
