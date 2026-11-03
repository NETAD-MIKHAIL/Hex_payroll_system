# Step 73M: trusted actor identities and local evidence reconciliation

This implements actor attribution distribution and explicit repair of compatible
local evidence conflicts. It does not distribute login credentials or RBAC grants,
accept new attendance decisions, finalize attendance or deploy anything.
The trusted worker remains off by default.

## Central identity authority

`createCentralIdentityPublisher(writerPool, 'central')` is an internal command.
It requires the deliberately provisioned restricted central evidence writer and
fresh enrolled-node and central-user session credentials. No publication endpoint
accepts node-only requests. The existing `users.update` permission is required;
publishing an inactive identity also requires `users.disable`. Permissions, user,
session, organization and node are checked and locked in the publication transaction.
The request cannot choose a publishing user, display name, active flag, role,
credential or arbitrary snapshot. The current central account supplies the fields.

The strict version-1 command contains `requestId`, `organizationId`, `userId`,
`expectedRevision` (identity publication revision) and `expectedAccountRevision`
(the current `auth_users.revision`). The first identity publication has revision 1
even if the account is older. Later publications use contiguous CAS revisions and
nondecreasing account revisions. Editing published identity content without an
account revision is rejected. Exact retries reauthenticate and return the original
event; altered request content, user or node cannot reuse the request identity.

Central-only migration `0005_trusted_identity_publication.sql` creates immutable
`central_identity_events`: canonical request, canonical snapshot/fingerprint,
request/event identities, revisions, publisher, node and publication time. Storage
guards enforce organization/account binding and contiguous revisions. Publication
sequence allocation follows commit order. A failed transaction publishes nothing.
The ordinary `hexpayroll_app`, node tokens and desktop clients cannot insert,
update, delete or truncate publications or use their sequence.

The existing explicit writer-provisioning function now requires migration 0005 and
adds only SELECT/INSERT on the identity ledger, USAGE/SELECT on its sequence,
EXECUTE on its trigger function, and SELECT on the source account's display name,
revision and creation/update timestamps. Existing identity-column lock-only
privileges remain guarded against edits. It does not grant account/RBAC mutation,
password-verifier SELECT, DDL, role membership or administrative powers. No role is
created automatically and no production grants were run. Test fixtures grant only
inside their own random test schema using the existing dedicated test writer.

## Versioned delivery and local application

The independent `GET /api/sync/identities/pull?after=0` stream uses:

- `protocolVersion: 2`, server-controlled `origin: 'central.identity'`.
- Immutable sequence/event/request IDs, organization and stable user UUID.
- Expected/resulting identity revision, publisher UUID, source-node UUID and time.
- Exact snapshot and SHA-256 fingerprint.

The snapshot contains only `id`, `organizationId`, `displayName`, `active`,
`revision`, `accountRevision`, `createdAt` and `updatedAt`. It contains no username,
email, password hash, session token, node secret, role or permission. Strict decoding
rejects extra fields, altered hashes, foreign organizations and inconsistent
identities/revisions before any receipt cursor write.

Identity delivery uses the same HTTPS/configured-central trust model as accepted
evidence; loopback HTTP is allowed for isolated tests. Hashes bind content but are
not signatures. Direct central/local database access and central TLS configuration
remain trusted. Independent identity, accepted-evidence and generic v1 cursors
prevent an older client from skipping or mistaking another stream's events.

Shared migration `0036_trusted_actor_identities.sql` adds:

- Immutable `trusted_identity_inbox` and `trusted_identity_applications` with event
  binding triggers, plus per-node `trusted_identity_checkpoints`.
- `trusted_actor_identities`, a revisioned, inbox-bound central identity projection.
- Separate pending/conflict attempts and bounded retry times.
- Explicit `auth_users.identity_only` references and their security constraints.

Entire-page receipt and checkpoint advancement are atomic. Projection and its
receipt are another atomic transaction, with per-event savepoints, organization
serialization, same-user ordering and bounded batches. Missing revisions defer;
organization or identity collisions conflict. Replays never regress identity state
or duplicate receipts. Central-only identity/publication tables remain absent from
local schemas.

The enabled local trusted worker pulls identities and evidence independently,
applies durable identities before evidence, and wakes pending
`MISSING_TRUSTED_ACTOR` attempts after installing an identity. Network backoff does
not prevent applying previously received events. It retains non-overlapping ticks,
awaited shutdown and `SYNC_TRUSTED_EVIDENCE_ENABLED=false` by default. No writer
credential is configured or read on a desktop.

## Attribution identities versus login accounts

A missing actor becomes an explicitly typed attribution-only reference with the
exact published UUID/organization/name. Its reserved local username is
`actor_<UUID without hyphens>`. This is a storage identifier, not a distributed
username. It has NULL password hash, `active=false`, no roles and no sessions.
Database checks and triggers forbid credentials, activation, sessions, role grants,
UUID/organization changes or conversion into a login account. The generated ORM
model reflects the nullable verifier and new identity-only flag. Ordinary accounts
still require a non-NULL password hash; that rule is not relaxed for login users.

If that UUID already belongs to a local login account in the same organization,
distribution preserves its credentials, activation and grants, while recording the
central identity separately. Different organization ownership is a conflict.
Name/username collisions do not cause identity remapping. No role or account
permission is inferred from an identity snapshot.

Receiving central `active=false` blocks future local login, session use and
protected actions through the central-identity deny check. Existing credential
material and historical attribution are preserved. A later central active snapshot
does not activate an attribution-only reference or supply login credentials/grants;
an existing independently active login account can use its existing rights again.
Offline devices cannot know a revocation until it is received. Central operations
always reauthenticate against current central state regardless of a PC's snapshot.

This resolves evidence actor foreign keys, not general multi-PC user login/RBAC
provisioning. New login enrollment for a UUID already installed as attribution-only
requires a separate reviewed enrollment/migration policy; it cannot silently promote
the reference. Historical actor UUIDs and audit provenance are never deleted.

## Explicit local operator reconciliation

Shared migration `0037_evidence_reconciliation.sql` adds append-only decision and
application audits and exact-content outbox preservation bindings. Local-mode APIs:

- `GET /api/sync/local-evidence/:sequence`: inspect local and accepted central
  UUIDs/revisions/full content, the trusted predecessor, pending outbox content and
  different local identities with colliding codes or overlapping assignments/leave.
- `POST /api/sync/local-evidence/reconcile`: submit `requestId`, `sequence`,
  `decision`, a nonempty `reason`, and the returned `localFingerprint`,
  `centralFingerprint`, `outboxFingerprint` and `competingFingerprint`.

Both require the current local operator's bearer session, organization administrator
role and the existing permission for the central evidence action. They recheck and
lock actual sessions/users/grants in the transaction rather than trusting caller
claims or cached HTTP actor objects. Node bearer credentials cannot authorize repair.
The local server's enrolled-node configuration supplies installation identity;
clients cannot choose an installation or operator UUID. Central/disabled servers
do not expose this local reconciliation path.

Local authorization permits repairing a local projection using **already accepted
central content only**. It cannot publish a new central decision, change accepted
content, elevate an account, or approve leave centrally. Central identity publication
separately requires a current central session and restricted server writer.

`preserveLocal` records an immutable operator hold. It does not mark the event
applied, dismiss a central conflict, delete the local draft or deliver its outbox.
The immutable audit retains competing content and the operator's reason.

`useCentral` is supported for a compatible conflict at the exact inspected UUID:

1. Bind exact local, central, competing and pending-outbox fingerprints. Reject
   stale inspection, earlier unapplied revisions or an in-flight delivery lease.
2. Preserve the complete local snapshot and pending outbox content in the immutable
   operator audit. Validate all central content/dependencies normally.
3. Require the exact accepted predecessor/revision. Immutable local schedule
   versions/weekdays and assignment history must match the accepted history;
   no child/history can be deleted or overwritten.
4. CAS the inspected local root revision to the exact central result and compare
   the whole persisted aggregate to the accepted snapshot.
5. Insert application and reconciliation receipts atomically. Preserve reviewed
   outbox entries as failed/held, never synced or deleted, with immutable exact
   content bindings. Later accepted revisions ignore only that reviewed content;
   an altered outbox payload becomes pending local work again.

A failure rolls back the root/children/history, receipts, audit and outbox state
together. Exact operator retries return the original decision after fresh
authorization. Competing requests at the inspected state have one winner.
The ordinary outbox retry route does not release reconciled entries.

## Explicit blockers and rollout prerequisites

- `RECONCILIATION_IMMUTABLE_CHILD_BLOCKER` or
  `RECONCILIATION_IMMUTABLE_HISTORY_BLOCKER`: independently authored children/history
  cannot be discarded under the database's append-only evidence rules. Keep the
  local evidence and pending central event. A separately reviewed identity/version
  migration must preserve references/history; this service has no owner bypass.
- `RECONCILIATION_UNBOUND_AGGREGATE`: another local UUID has a colliding code or
  overlapping employee/date range. Inspection and `preserveLocal` expose/audit it,
  but this command cannot rename, close, delete or remap an aggregate it was not
  authorized to change. Resolve that specific aggregate through an explicit
  reviewed policy before retrying central application.
- Previously applied generic account changes still need an operator security
  review. Step 73M closes the remaining **pending** legacy generic inbox path:
  `applyAccountEvent` always quarantines without any account/credential/RBAC writes.
  Once marked, those events do not starve independent generic evidence batches;
  they remain unapplied and retained for review. No old credentials or grants are
  automatically assumed safe or silently revoked by this change.
- Production backups, reviewed shared/central migrations, explicit restricted
  writer grants, existing credential-account/actor mapping review and device
  validation are still required before enabling the worker.

## Tests and commands

The new isolated tests use real central publication/acceptance, authenticated HTTP
delivery and two enrolled local schemas. They cover actor recovery, the real
enabled worker, revocation/history, permissions, CAS/concurrency, replay, malformed
envelopes, organization isolation, rollback, local conflicts, immutable blockers,
operator HTTP authorization and outbox preservation. Legacy account-inbox tests
now assert quarantine rather than the superseded credential/role distribution
behavior; their ordering, batch bounds and no-mutation protections remain tested.

```powershell
cd D:\hexpayrollsys
pnpm --filter @hexpayroll/api test:regression
pnpm --filter @hexpayroll/shared build
pnpm --filter @hexpayroll/api typecheck
pnpm exec eslint apps/api/src apps/api/test packages/shared/src --max-warnings=0
pnpm exec prettier --check apps/api/src apps/api/test packages/shared/src docs/trusted-identities-and-reconciliation.md
```

Only the ignored dedicated test configuration is loaded by the regression runner.
All fixtures validate `hexpayroll_test`, isolate their schema and clean up only that
schema. No production database, VPS role/service, hardware, UI, canonical attendance
finalization or payroll calculation change is included.
