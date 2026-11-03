# Internal central attendance authorization (Step 73I)

This adds no endpoint or acceptance service. Existing attendance processing,
sync push/pull, local proposals, canonical storage and migration paths are unchanged.

## Interface and trust boundary

Trusted server code constructs
`createCentralAttendanceAuthorizationResolver(centralPool, 'central')`.
The pool and mode must come from server configuration, never request data.
Local mode fails before connecting. No actor/session context supplied by a caller
is accepted as authenticated identity.

The returned function takes two strict objects:

```typescript
resolve({ nodeToken, sessionToken }, { organizationId, authorUserId, action });
```

The tokens are independent bearer credentials using the existing 43-character
base64url format and SHA-256 `tokenHash`. Node verification reuses
`authenticateNode`, then locks/rechecks the central `sync_nodes` row (enabled,
non-revoked, matching current credential). The session must exist in central
`auth_sessions`, not a desktop session store. Expiration is checked against
PostgreSQL wall time. Logout revocation is represented by session deletion;
there is no separate session revocation column. The active central account and
its current organization, role assignments and permission grants are read from
central tables. A system role is eligible across organizations; a custom role
must match the authenticated user's organization.

`organizationId` and `authorUserId` are untrusted assertions, compared with
authenticated identities. Node, user and requested organization must match.
The author must equal the session-derived submitter, consistent with the current
local proposal author's exclusive editing rights. Delegation is unavailable.
Extra fields such as submitter ID, node ID, roles or permissions are rejected.

| Action    | Required current permission |
| --------- | --------------------------- |
| calculate | attendance.manage           |
| adjust    | attendance.adjust           |
| approve   | attendance.approve          |
| reopen    | attendance.manage           |

The frozen result contains only `organizationId`, `nodeId`, `submitterUserId`,
`authorUserId`, `action`, `permission`, `authorizedAt`, and `sessionExpiresAt`.
It excludes credentials, credential hashes, password verifiers and session IDs.
Failures use fixed DomainError messages rather than serializing credential input.

## Revocation and concurrency

Each resolution owns a short transaction. It first shares the setup lock used by
existing RBAC administration, then locks the node, active user, session and actual
grant rows FOR SHARE. User-before-session ordering matches account updates.
Concurrent node changes, session deletion and grant deletion serialize against
these reads. Committed revocation before lock acquisition causes rejection;
rolled-back revocation leaves valid identities usable. A final wall-clock expiry
check prevents waiting transactions from relying on transaction-start `now()`.
No last-seen, session or audit row is written by authorization.

The result is a point-in-time snapshot, **not a reusable authorization capability**.
Revocation after resolution cannot retroactively invalidate the snapshot. Future
canonical acceptance must revalidate inside its write transaction, holding the
relevant locks until commit; it must not authorize a later write using this result.
Database/locking failures propagate and never produce an authorized result.

## Blockers for future canonical acceptance

`sync/service.ts:pushEvents` authenticates a node and stores arbitrary entity
snapshots, including `auth_users`, in `sync_changes`, without authenticating an
acting user or authorizing role changes. Currently this is transport storage,
not central RBAC mutation: the account inbox consumer runs in local sync mode.
However, `sync/inbox.ts:applyAccountEvent` can change account credentials,
active state and role assignments from those snapshots on receiving databases.
Reusing that generic projection for trusted central identities would allow
node-supplied role claims to become authority. This is a blocker for any future
central identity materialization/acceptance that trusts such claims. This step
does not change that transport or promote account payloads into trusted grants.

An eventual endpoint also needs central user login/session provisioning on remote
PCs; a local session token is not central authentication. Evidence completeness,
calculation validation and canonical revision acceptance remain separate blockers.
No permission to accept canonical data is implied by this resolver alone.

## Verification

Eleven isolated PostgreSQL tests cover the returned audit-safe snapshot, all four
action mappings and denial paths, invalid/expired/deleted sessions, inactive users,
invalid/disabled/revoked nodes, organization mismatch, forged claims, current grant
and role removal, concurrent session/node/permission revocation and rollback recovery.
Three separate unit tests verify mode and malformed/forged-input gates without a
database. PostgreSQL tests use the existing fixture, which requires both URLs to
target `hexpayroll_test` and creates/drops only a random isolated schema.
No central migration or production database is required.

```powershell
cd D:\hexpayrollsys
pnpm --filter @hexpayroll/api exec tsc --noEmit
pnpm --filter @hexpayroll/api exec tsx --test test/central-attendance-authorization.test.ts
```

Run only from the PowerShell session with both isolated test URL variables set:

```powershell
pnpm --filter @hexpayroll/api exec tsx --test test/central-attendance-authorization-database.test.ts
```

Target: 11 passed, 0 failed, 0 skipped. Combined regression (72 previous + 11):

```powershell
pnpm --filter @hexpayroll/api exec tsx --test `
  test/central-attendance-authorization-database.test.ts `
  test/central-attendance-storage-database.test.ts `
  test/local-attendance-proposals-database.test.ts `
  test/central-migration-isolation-database.test.ts `
  test/inbox-database.test.ts `
  test/organization-inbox-database.test.ts `
  test/department-inbox-database.test.ts `
  test/position-inbox-database.test.ts `
  test/employee-inbox-database.test.ts `
  test/biometric-device-inbox-database.test.ts `
  test/biometric-mapping-inbox-database.test.ts `
  test/time-record-inbox-database.test.ts `
  test/time-record-ingestion-concurrency-database.test.ts `
  test/time-record-correction-inbox-database.test.ts
```

Target: 83 PostgreSQL tests, excluding separate unit tests. These totals are
targets, not claimed results. Neither test database variable was available in the
implementation session, so PostgreSQL tests and the baseline were not rerun.
The smallest next step is to run these tests, then separately address central
identity trust and evidence validation before building any acceptance endpoint.

Implementation-session checks: API TypeScript passed; separate strict TypeScript
checking of both new test files passed; ESLint and formatting passed. The three
database-free unit tests passed (0 failed, 0 skipped). The sandbox initially
blocked the test runner child process (`spawn EPERM`); the authorized retry outside
the sandbox passed. No PostgreSQL test was executed or reported as passing here.
