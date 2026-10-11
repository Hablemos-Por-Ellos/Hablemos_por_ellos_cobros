# Admin Session MFA - 0.4.2

Date: 2026-10-10, America/Bogota. Approved by the owner in this chat.
Scope: local implementation and fictional tests only. No commit, push,
production SQL, deployments, account changes or real charges authorized.
Subsequent authorization, 2026-10-10: after the real local integration and a
fresh private backup restored and compared, the owner permits publication and
replacement of this function only. Mandatory backup confirmation in chat before
production SQL remains in force. No charges, job reruns, tables or donor edits.

## Approved Behavior

Require password and Authenticator at login. An active AAL2 session can then
confirm admin operations without another TOTP prompt. Keep confirmation,
reason, roles, revocation, CSRF, version checks, payment barriers and atomic
audit. Existing login/enrollment, credentials and MFA factors are unchanged.

The owner rejected per-action TOTP and a short repeat-verification window.
Removing only the input would fail against the existing API and SQL guard.
The approved implementation therefore includes UI, both mutation APIs and
the existing `assert_admin_mutation_context` function.

## Boundaries

- No table, column, index, existing row or historical audit change.
- Preserve the SQL function signature, owner and execution permissions.
- Verify authenticated user, JWT expiry, AAL2 and active role on the server,
  including the final recheck before the mutation; never trust body identity.
- Pass NULL for per-action `totp_verified_at`, not a manufactured timestamp.
- Accept an optional old-client TOTP field but do not use it as authorization.
- Do not edit applied 0.3.0/0.4.0 migrations or change payment rules.
- SQL is prepared as a new function-only patch, tested only in a disposable
  fictional local database. Production requires separate approval.

## Implementation And Verification

1. Remove TOTP input/state from mutation and reconciliation dialogs.
2. Remove repeated challenges from both APIs, preserving all other barriers.
3. Prepare transactional function-only SQL with unchanged execution grants.
4. Cover absent MFA, revoked/expired sessions, CSRF, concurrency and unchanged
   idempotency; login still requires MFA, subsequent saves do not.
5. Apply/reapply SQL locally, compare all table definitions/data/ACL before
   and after, and exercise AAL1/AAL2/revocation guards using fictional rows.
6. Run focused/full tests, lint, types and local build/visual checks where the
   available isolated toolchain permits; record limits honestly.
7. Update README/changelog/Obsidian, leave changes local and uncommitted.
