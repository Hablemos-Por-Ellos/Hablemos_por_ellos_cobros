# Superseded: Legacy Calendar Expansion Proposal

Date: 2026-10-10 (America/Bogota).
Status: SUPERSEDED on 2026-10-10. The owner chose standard-day rescheduling
(historical 10 to 16 and 2 to 6) instead of expanding database calendars.
The SQL and calendar-mode design below is historical, NOT an implementation
instruction. No such migration was written or executed. The active 0.4.1
scope is docs/BILLING_RECOVERY_0.4.1.md: code only, existing 0.4.0 schema,
without changing production records, committing, pushing or deploying.

## Problem And Evidence

The current 0.4.0 reservation, dispatch and approval paths require a preferred
day in 1/6/16/28. Two of eleven active monthly subscriptions predate the day
selector and retain NULL, while their stored schedules and approved history
show legacy calendar days 10 and 2. One is overdue. Preserve those records;
do not turn their existing schedules into newly asserted donor preferences.

The October 10 scheduled job failed before reservation or sending. Its global
operational-error stop is intentional: fixing a legacy case must not disable
that financial barrier. Inventory currently misses this incompatibility.

Reconfirmation also loses knowledge that a payment was already sent when GET
or result recording fails. The current restart response can reset the UI and
invite a new checkout. Legacy attempts must use the legacy result bridge,
not an RPC that requires a v2 attempt ordinal.

## Alternatives

1. Recommended: preserve legacy schedules and explicitly distinguish legacy
   renewal calendars from selected-day calendars in new immutable cycles.
2. Ask donors to choose a new supported day: requires their agreement and an
   audited schedule change; not an automatic technical repair.
3. Leave the current code: the overdue legacy reservation remains blocked and
   can stop subsequent due rows. Not a restoration of normal billing.

## Proposed Behavior

- An existing active monthly subscription with no preferred day may retain
  its historical calendar only when its stored finite schedule, verified
  approved history and financial identity support that interpretation.
  Missing or conflicting evidence remains blocked for review.
- Snapshot the calendar mode and day on each new cycle. Keep subscription
  preferred_payment_day NULL, and preserve IDs, contacts, amounts, sources,
  payments and historical events. Do not create cycles for past payments.
- A legacy renewal has only its original attempt. Missing recurring retry
  authorization must never be inferred from active status or prior payments.
- Preserve the historical day when scheduling the month after a verified
  approval, clamping to the last valid day of shorter months. Keep the
  immutable anchor across cycles, and never override later administrative
  versions or move a saved future date backwards.
- New checkouts and administrator-selected calendars still use 1/6/16/28.
  No change to the public design, administrator roles or MFA requirements.
- If a payment may already exist, retain the checkout and return a safe
  reconciliation response instead of suggesting another payment. Separate
  that response from send-barrier ownership; never persist a browser-supplied
  transaction identifier without matching provider evidence.
- Reconfirm legacy attempts through the verified legacy bridge. Review-only
  historical results must not silently activate or reschedule subscriptions.
- Inventory remains read-only but reports legacy calendar compatibility and
  blocked cases explicitly. Green inventory alone is not payment approval.

## SQL Scope And Production Boundary

Prepare a NEW migration for the existing 0.4.0 schema; never edit or repeat
the previously applied migration files. Proposed scope is a calendar-mode
column/constraints on billing_cycles and narrowly scoped calendar helpers
and reservation, send-authorization, approval and schedule-repair functions.
Do not add a new financial table, change uniqueness budgets, weaken source
verification, erase history or restore old unrestricted financial writers.

The change is not JavaScript-only: billing_cycles constraints and server-side
SQL compare the snapshot day against the currently nullable subscription day.
Production application therefore requires a separately authorized short cutover,
financial blocking and workflow draining, with a fresh private backup restored
and compared before SQL. Confirm successful final backup here immediately
before migration. No key rotation, account recreation or MFA reset is required
by this fix. No production charge may be used as a test.

The audit's broader legacy manual-review and unidentified-attempt recovery
gaps remain separate follow-up work. There are no current rows in those
blocking cohorts; this patch must not clear their barriers speculatively.

## Local Verification

Reuse the existing fictional network-disabled PostgreSQL lab only after
checking its identity and mounts. Do not create more Docker containers,
delete volumes or use restored production backups as fixtures.

Cover legacy days 2/10, late approval, short months/leap years, future schedules,
missing evidence, revocation, amount/date edits, cancellation, concurrency,
monthly approval deduplication, duplicate requests and no unauthorized retries.
Exercise the exact SQL plus real API/job code with fictional providers; JavaScript
mocks alone cannot validate changed database functions. Verify migration
preservation, repeated application and failure/rollback locally.

Add GET/application failure cases after prior sends and widget payments,
legacy reconfirmation, rejected foreign IDs and truthful inventory reporting.
Then lint, full tests, type checking and an isolated build without production
credentials. Record actual results and limits in versioned documentation and
Obsidian; never label pending production work completed.

Baseline only: on 2026-10-10, four existing focused test files passed (126 tests):
monthly-retry-runner, billing-retry-policy, donations/retry-route and
donations/retry-route-extra. Vitest uses envDir=false and injected local/sandbox
fixtures. No live DB/provider was contacted by those tests. This baseline does
not test the proposed compatibility fix or establish production readiness.

## Review Gate

The earlier confirmation to retain days 10 and 2 was superseded by the owner's
later choice of standard days, followed by confirmation of the code-only scope.
Do not resume this SQL design. Production date writes and publication remain
separate from the local code patch.
