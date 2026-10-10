# Billing Recovery 0.4.1

Date: 2026-10-10 (America/Bogota).
Status: patch published and canonical 0.4.1/e2f6baa verified on 2026-10-10.
Branch: codex/legacy-billing-compatibility. Previous production was
0.4.0/47290fc. Publication and audited calendar saves are separate operations;
the saves still need the owner's TOTP. Evidence is recorded in RELEASE_0.4.1.md.
No schema SQL, settings change, Docker cleanup or real test charge is included.

## Approved Scope

- Keep the 0.4.0 database schema, functions, source verification, monthly
  uniqueness budgets, retry consent protocol and financial stop barriers.
- Preserve checkout recovery when an existing or widget payment may already
  have been sent. Rate-limit transport, database-read, GET or result failures
  must not reset checkout or suggest another payment; browser identifiers
  never become provider evidence.
- Apply reconfirmed legacy attempt results through the existing verified
  legacy bridge, not the RPC that requires a v2 attempt ordinal. Do not grant
  retries, activate subscriptions or alter historical schedules implicitly.
- Report unsupported active monthly calendars in read-only inventory. Missing
  preferred days and non-finite/missing next dates require review; inactive
  subscriptions and one-time donations are not calendar failures.
- Make calendar review visible in the CLI summary and exit code. Inventory
  performs no provider GET/POST and no financial mutations.

## Calendar Decision And Remaining Production Work

The owner chose standard-day rescheduling rather than a database-calendar
expansion. Proposed effective dates are October 16 for the overdue day-10
case and November 6 for the day-2 case that already paid in October.
Those proposals do not imply that production schedules have been changed.

Use the existing authenticated admin with confirmation, reason, recent TOTP
and expected billing version. Saving changes subscription data and writes
audit atomically; it does not charge immediately or rewrite prior payments.
Before saving, recheck current status/version, payments for the Colombian
month and pending attempts. Confirm the new day/date and audit afterwards.

A plain SQL UPDATE is not an equivalent replacement: bypassing version,
locking and administrative audit can let job/webhook changes conflict. Any
manual database operation requires separate explicit authorization, exact
record identity and preservation of those controls. No such command is run
or supplied by this patch.

No schema cutover, key rotation or account recreation is required for this
code-only patch and normal supported-day administration. The owner separately
authorized publication and the two schedule saves. The legacy calendars stay
blocked until their schedules are actually updated; the patch does not
silently repair them or certify future bank outcomes.

## Deferred Risks

Legacy manual-review clearing and unidentified historical-attempt recovery
remain separate work; no rows currently in those blocking cohorts were found
in the read-only audit. Do not clear barriers or invent approvals to make
them pass. Seven preexisting legacy event reviews are not seven new payment
failures caused by this patch. The intentional global operational-error stop
is retained, so a failed reservation can still stop later due rows.

## Verification

See VALIDATION_0.4.1.md for actual tests and limits. Unit fixtures are fictional,
Vitest disables dotenv loading, and external provider calls are mocked.
Applied 0.3.0 and 0.4.0 migration files must remain byte-for-byte unchanged.
