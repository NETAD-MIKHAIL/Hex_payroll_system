# Step 73J: central account synchronization security

An enrolled node credential authorizes evidence transport, not account administration.
Ordinary sync push now rejects auth_users, auth_sessions, roles, permissions,
user_roles, role_permissions, sync_nodes and application_setup events with
HTTP 403 / SYNC_CENTRAL_AUTHORITY_REQUIRED. This includes credential replacement,
activation, role removal, and higher-revision updates, not only administrator grants.
The whole batch rolls back, including heartbeat changes. Existing receipts do not
bypass the check. Pull excludes historical records of these entity types, preventing
previously accepted account claims from reaching additional PCs.

This deliberately suspends the former peer account snapshot distribution. Account
outbox entries remain pending and can block a mixed batch until operators resolve
them; they must not be marked delivered when rejected. Central bootstrap and existing
central account/RBAC administration remain the authority. A future centrally signed
or otherwise authenticated account distribution path needs a separate design.
No account materializer or remote user provisioning endpoint is added here.

Step 73M adds a separate [credential-free identity distribution path](trusted-identities-and-reconciliation.md).
It also quarantines previously downloaded generic account inbox events before any
account, credential or role write. Those events remain unapplied for review;
ordinary sync cannot retry them into account authority. Attribution-only references
cannot receive credentials, sessions or roles. Previously applied account changes
still require security review.

Previously downloaded inbox snapshots and already compromised accounts require
operator review: this change cannot revoke credentials or grants already applied.
Do not run the generic local account inbox projection against central identity tables.
Direct database access remains trusted and is outside the node-token boundary.

The database regression test covers all three operations for each protected entity,
mixed-batch rollback, historical quarantine, ordinary evidence delivery and retries.
Run with the dedicated test database URLs, using the existing isolated-schema fixture:

```powershell
node --env-file=apps/api/.env.test --import ./apps/api/node_modules/tsx/dist/loader.mjs --test apps/api/test/central-account-sync-database.test.ts
```

Attendance evidence completion, independent validation, canonical acceptance,
proposal/UI integration and cross-PC testing remain Steps 73K through 73P.

Verification on 2026-10-24: the previous 83-test attendance PostgreSQL regression
plus the new security test passed (84 passed, 0 failed, 0 skipped). A separate
targeted transport/authorization/inbox run passed all 32 tests. API TypeScript,
ESLint for changed TypeScript files, and formatting checks passed.
