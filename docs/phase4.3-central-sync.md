# Phase 4.3 — central synchronization

## Inspection and architecture

The repository already provided one Express application factory, PostgreSQL 18,
UUIDv7 publication, immutable numbered migrations, generated Drizzle tables,
transactional audit/outbox writes, leased delivery, enrollment, a commit-ordered
transport ledger, and Phase 4.2 conflict persistence and review.

The missing business receivers, application checkpoint, structured HTTP
acknowledgments, resolution propagation, credential storage, central route
boundary, manual cycle, and durable history are implemented in the existing sync
subsystem. The factory accepts injected database/mode options for integration
tests; production entrypoints still share the same factory. Central mode starts
neither synchronization nor attendance workers. Payroll formulas are unchanged.

## Ownership and protocol

| Domain                                  | Policy                                                                                                                                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization                            | Central administrator owns configuration. Enrollment publishes the canonical organization. An empty installation can adopt it through credential import and pull. Existing unrelated organizations are never reassigned.                          |
| Accounts, sessions, roles               | Local only. No password verifiers, sessions, roles, or login access are replicated. Remote actor references create inactive principals with an unusable password and no roles.                                                                    |
| Departments, positions, employees       | Revision-based writes, scoped references, employee employment aggregates.                                                                                                                                                                         |
| Employment and schedules                | Preserve effective intervals, version/day identities, and assignment history; database overlap constraints remain active.                                                                                                                         |
| Time evidence                           | Append-only, scoped device/employee references and database uniqueness. Corrections remain separate records.                                                                                                                                      |
| Attendance                              | Replicate versioned facts and preserve prior snapshots. Existing explicit recomputation remains available. Remote application itself does not launch outbound derived mutations.                                                                  |
| Leave                                   | Revision and incompatible-decision protection; approval audit references survive replication.                                                                                                                                                     |
| Payroll configuration, entries, periods | Device-authorized writes and controlled lifecycle; existing closed-period and reference constraints remain active.                                                                                                                                |
| Payroll results                         | Append-only snapshots, traces, earnings, deductions, contributions, engine and rule references. Exact integer centavos only.                                                                                                                      |
| Finalized payroll                       | Never overwrite, merge, or recalculate. One finalization manifest verifies all persisted run/results/lines and reconciliation before atomically freezing run and period. Conflicting financial history requires the approved correction workflow. |
| Statutory rules and monetary policies   | Versioned, central-owned reference data. Publish through authenticated central administration.                                                                                                                                                    |

HTTP requires `X-Hex-Sync-Protocol: 2`. Push bodies additionally contain
`protocolVersion: 2`; event contracts include base revision, stable event ID,
historical origin, actor reference, payload version, and snapshot. Organization
authorization always comes from the hashed device credential's server record.
`originNodeId` is descriptive metadata, never an authorization authority.

- `POST /api/sync/push`: at most three events, each at most 256 KiB. Results are
  `accepted`, `already_applied`, `conflict`, `rejected`, or `retryable_failure`.
- `GET /api/sync/pull?after=<decimal bigint>`: at most three changes, protocol
  version, next sequence, and `hasMore`. Bigint cursors stay strings. The cursor
  is organization-filtered and is never itself an authorization credential.
- `POST /api/sync/nodes`, `GET /api/sync/nodes`: authenticated organization
  administrator registration/listing.
- `PUT /api/sync/nodes/:id/domains`: explicit device domain authorization.
- `POST /api/sync/nodes/:id/rotate`, `.../:id/revoke`: audited credential lifecycle.
- `POST /api/sync/reference`: administrator publication of a shared-contract event
  for organizations, statutory rules, or payroll policies. Devices cannot push
  these central-owned entities. Use existing version supersession constraints.
- Existing `/api/sync/conflicts` review/resolution routes remain authoritative.
  Central administrators can inspect `/api/sync/proposals`; proposals do not
  automatically grant a workstation authority to resolve a central conflict.
- Local `/api/sync/state`, `/api/sync/history?page=1`, and administrator-only
  `POST /api/sync/now` support the `/sync` UI.

Malformed/obsolete HTTP contracts cannot fall back to transport-only receipts.
Injected test adapters retain compatibility with older worker tests.

## Durability, database, and safety

Migration `0036_central_synchronization.sql` adds:

- `sync_received_events`: globally unique event identity, authenticated node and
  tenant foreign keys, canonical request digest, durable terminal result. Rejected
  secrets are not retained in request bodies.
- `sync_checkpoints`: tenant/device primary key, durable applied bigint sequence.
- `sync_history`: real attempt timing, device, push/pull/accept/conflict/failure
  counts and outcome; organization/time index. Retention is 90 days, enforced
  when the worker runs.
- `sync_remote_actors`: non-login actor references, scoped foreign keys.
- `sync_resolution_proposals`: durable, administrator-reviewable proposals.
- `sync_snapshot_chunks`: bounded chunks keyed by organization, aggregate,
  checksum, and index; no mutable business results are stored as staging rows.

It extends existing nodes with domain permissions and rotation time, the ledger
with protocol/base revision/actor metadata and an indexed v2 feed, local identity
with an explicit initial-reference adoption flag, and outbox receipts with their
delivery protocol. Existing nodes receive no implicit upgrade permission; grant
the required domains administratively. New administrator-enrolled workstations
receive the supported business domains and can be narrowed immediately.

Prior migrations remain unchanged. Drizzle schema is regenerated from a disposable
database using the existing introspection workflow, never `drizzle-kit push`.

Each central event has its own transaction. Business mutation, audit, terminal
idempotency record, and v2 publication commit together. Missing dependencies and
temporary database contention remain retryable and do not receive terminal
receipts. A changed request cannot reuse an existing ID. A failed event cannot
roll back another event already acknowledged in the same batch.

The existing ledger insertion trigger holds a transaction advisory lock while
allocating its published sequence. Therefore no publisher can commit a higher
sequence ahead of an uncommitted lower one. Rollback gaps are harmless. Pull
orders by the numeric database column, not its string output alias. This is an
explicit serialization guarantee, not an assumption about PostgreSQL sequences.

Local remote application, durable inbox evidence, conflict persistence, and
checkpoint advancement share one transaction. A failed batch rolls back its
business changes and checkpoint. An unresolved local edit is retained as a
conflict; its authoritative incoming evidence is durable before advancing. Own
accepted events do not overwrite subsequent local edits. A transaction-local
remote context suppresses outbox publication while preserving audit history.

Large run snapshots are staged as 128 KiB binary chunks encoded in bounded
events, with at most 128 chunks (16 MiB per run snapshot). The run is not accepted
until all chunks assemble and verify their SHA-256 checksum. Finalization uses
the reconstructed full snapshot and the immutable result components, without
re-running the engine. Existing per-employee event limits still apply.

The existing worker retains stable IDs, owned leases, bounded queue reads,
exponential equal-jitter retry, cancellation, and stale-response protection.
Each cycle drains at most ten push and ten pull pages. Timer and manual requests
share one running promise. Partial results remain visible; domain conflicts stop
their dependency chain while unrelated known entities can continue. Invalid
credentials, revocation, and incompatible HTTP protocols block automatic
transport until corrected/restarted. Ordinary local operations remain available.

Offline resolution proposals remain pending until a central administrator
confirms a resolution. Accepted resolution state and authoritative master data
are published durably. Local proposal history only permits the one-way
`pending` → `confirmed` change; its evidence remains immutable. A new local edit
prevents an older resolution from silently replacing it.

## Configuration and upgrade requirements

1. Apply the existing migration runner to each installation and the central
   database using a migration role. Do not run tests or schema generation against
   real payroll data. The runtime role remains `hexpayroll_app`.
2. Bootstrap the canonical organization and central administrator using the
   existing central CLI. Register distinct devices and grant their domains.
   Central mode exposes health, authentication, and sync administration only.
3. Bootstrap a separate local administrator. Import the one-time device credential
   with `pnpm --filter @hexpayroll/api sync:import` under the Windows account that
   runs the local API. Empty local organization setup adopts the canonical ID;
   existing organization IDs must match. Import supports rotation of the same
   active identity and preserves queued historical origins.
4. Credentials are stored through Windows Credential Manager native APIs, never
   in React, command arguments, or the generated `.env`. Environment files retain
   only mode, endpoint, and node ID. Remove old transferred credential files and
   old plaintext tokens after secure import. The runtime does not fall back to
   `SYNC_NODE_TOKEN`. Missing secure storage blocks sync rather than local payroll.
   Non-Windows local credential providers are not implemented; central Linux mode
   does not need the local provider.
5. Set `SYNC_MODE=local`, `SYNC_CENTRAL_URL`, and `SYNC_NODE_ID` and restart the local
   API. Existing polling, batch, timeout, lease and attempt settings remain.
   Production clients require HTTPS; central TLS termination and network/database
   access configuration remain deployment responsibilities. Operational throttling
   returns HTTP 429 without retaining plaintext credentials.
6. Rotate centrally, securely transfer/import the new credential under the same
   Windows account, then restart. Revocation rejects both push and pull and does
   not delete any local payroll data.

**Legacy transport receipts require reconciliation.** Version 1 acknowledged
ledger delivery without applying business rows. Those receipts are deliberately
not relabeled as business acceptance, replayed over existing data, or exposed in
the v2 change feed. The UI reports their separate count. Existing fleets with v1
receipts need an administrator-reviewed baseline before they can be declared
fully synchronized. Automatic legacy baseline conversion is not implemented;
incomplete historical payroll snapshots must not be guessed or silently replaced.
Previously queued account exports are rejected by the migration; authentication
accounts must be provisioned separately on each workstation.

## Verification and remaining work

`pnpm test:integration` creates three unpredictable disposable PostgreSQL databases
(central, local A, local B), migrates isolated stores, exercises real Express HTTP
and synchronization with the DML role, and removes only its generated databases.
It needs a local test administrative connection able to create/drop databases;
set `TEST_ADMIN_DATABASE_URL`, `TEST_MIGRATION_DATABASE_URL`, and
`TEST_DATABASE_URL` explicitly for a separate test server. Without explicit
overrides, localhost connection credentials are templates only; real payroll
databases are never test targets.

`pnpm --filter @hexpayroll/api exec tsx src/cli/test-integration.ts --all` additionally
runs the existing API database regression suite with no database skips.
`... --schema` generates Drizzle tables from a disposable migrated database.

Coverage includes employee propagation, offline saves/reconnect, duplicates,
identity tampering, competing edits and leave decisions, confirmed resolutions,
chunked actual-engine payroll snapshots and immutability, a real child process
exiting after commit before response, tenant isolation, partial batch rejection,
missing dependencies, rejected-secret minimization, initial enrollment,
checkpoint rollback, delayed transaction commits, manual-cycle overlap, real
Windows credential storage/rotation, device rotation, and revocation. Browser
tests separately verify status, partial success, legacy warnings, and revocation.

Implemented: protocol v2, real business replication, durable checkpoint/feed,
secure Windows credentials, financial freeze, device/tenant authorization,
Phase 4.2 proposal/review/confirmation, status/manual/history UI, and isolated
integration harness. Requires configuration: database migrations, canonical
organization/reference versions, device permissions, and secure enrollment.
Partial: automatic conversion of legacy v1 transport-only receipt history.
Requires real deployment testing: TLS/proxy behavior, real network interruptions,
and each deployed Windows service-account credential store.
Deferred to Phase 4.4: Electron packaging and API/database process management.
Deferred to Phase 4.5: production rollout/operations and any new approved payroll
correction workflow. No production deployment was performed.

## Validation results (2026-10-19)

- `pnpm typecheck`: passed.
- `pnpm lint`: passed.
- `pnpm build`: passed, including desktop compilation; no installer packaging.
- `pnpm -r --if-present test`: passed: 42 engine, 14 browser, and 53 API tests.
  The ordinary API invocation skipped 14 database tests by design; use the
  database-enabled regression command above to execute them.
- `pnpm test:integration`: passed, 17 tests, zero failures and zero skips, using
  real HTTP applications and three disposable PostgreSQL 18 databases.
- `pnpm --filter @hexpayroll/api exec tsx src/cli/test-integration.ts --all`:
  passed, 125 tests, zero failures and zero skips, including database regressions.
- `git diff --check`: passed.

Earlier validation attempts encountered a Playwright dev-server startup timeout
and a PostgreSQL administrative connection timeout while checks ran concurrently.
The browser startup allowance is now 180 seconds; both commands subsequently
passed. These failures occurred during test startup, before scenario execution.
The Windows Credential Manager test exercised native write, read, rotation, and
removal under the current Windows account.
