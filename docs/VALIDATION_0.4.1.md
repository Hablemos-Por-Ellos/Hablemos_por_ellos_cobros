# Validation 0.4.1

Date: 2026-10-10 (America/Bogota).
Status: local tests, isolated build and independent QA complete.
These results are local validation, not production verification. Subsequent
publication was explicitly authorized; see RELEASE_0.4.1.md for its evidence.

## Baseline

Before the patch, four focused files passed (126 tests): monthly-retry-runner,
billing-retry-policy, donations/retry-route and donations/retry-route-extra.
This baseline did not cover the newly identified recovery/calendar regressions.

## Patch Checks

- `npm test`: exit 0; 1,322 tests passed, six opt-in tests skipped;
  47 test files passed and one file skipped (48 total).
- `npm run lint`: exit 0, no errors.
- `node node_modules/typescript/bin/tsc --noEmit --incremental false`:
  exit 0, no diagnostics.
- Dedicated read-only inventory coverage: 18 tests, injected loopback
  environment/clock, paginated projections, frozen fictional rows and zero
  provider/network/database mutations.
- Recovery coverage includes repeated provider GET failures, persistent rate
  limits, nullable legacy ordinals, source/identity mismatches, expired known
  transactions, widget results and failures after this request's own send.
  Prior attempts are not adopted as new sends and browser claims are not
  echoed as verified identifiers.
- Three existing route tests initially failed because their mocks lacked the
  subscription relation and attempt ordinal. Only fictional fixtures were
  completed; rejection/success/no-second-POST assertions were preserved.
- Independent QA initially rejected recovery on two database-read failures.
  Eight permanent cases cover returned errors and rejected promises for intent
  and attempt reads, with and without a browser transaction claim: six failed
  before the correction and all eight passed afterwards. Both route files
  then passed 107 tests; full suite, lint and TypeScript were repeated on the
  corrected code. A failed confirm lookup keeps HTTP 202 reconciliation;
  a successful lookup with invalid identity still rejects the request.
- A second QA rejection covered a rejected rate-limit RPC promise, rather
  than a returned RPC error. Two more permanent tests failed before correction
  and passed afterwards; the confirm request now retains uncertainty during
  that initial check, without querying the provider, exposing a browser ID
  or consuming the limiter twice. Returned limiter errors still yield 429.
  The final two route files passed 109 tests; full tests/lint/types were
  repeated after this correction.
- Isolated `next build`: exit 0; compilation, lint/types and 13 static pages
  complete. Build uses a whitelisted source copy outside Git, no dotenv files, an
  environment allowlist, demo mode and financial operations disabled. Its
  network guard permits only public Google font GET/HEAD downloads. A C:/D:
  cross-drive dependency junction first failed module resolution; the same
  source/toolchain built successfully in a same-drive D: scratch copy. No
  dependency installation or production configuration change was needed.
- Final isolated build was repeated after both QA corrections and exited 0;
  compilation, lint/types and all 13 static pages passed on the final source.
- Independent QA: APPROVES LOCAL for recovery, inventory/CLI and contracts.
  It reran 240 tests in five patch files and 21 adversarial scratch tests,
  all passing. Both earlier rejections were closed using its own unchanged
  scratch assertions. QA did not itself rerun full suite/lint/types/build;
  those final results above are integrator evidence, not QA reproductions.

Vitest uses `envDir: false`. External dependencies are fictional/mocked;
this is not a Wompi or Supabase production integration test.

## Limits And Remaining Work

- The six opt-in HTTP/SQL integration tests were not rerun in this patch.
  The already-applied 0.4.0 SQL is unchanged; prior lab results are historical,
  not new verification of this JavaScript patch against a live database.
- Calendar inventory checks missing/unsupported preferred days and missing
  or non-finite next dates. It does not certify date/day/hour consistency,
  donor authorization, bank outcomes or every financial eligibility rule.
- The intentional global operational-error stop remains. Missing historical
  calendars still block production reservations until audited rescheduling;
  warnings do not repair records or make a charge succeed.
- Legacy manual-review clearing and unidentified historical-attempt recovery
  are deferred. No new consent is inferred from prior approved payments.
- No UI change: responsive browser checks were not repeated for this
  recovery/inventory-only patch.

## Local Validation Boundaries

No production DB writes, real charge/provider POST, live donor fixtures,
new Docker containers, volumes removed, commits, push or deployments.
This statement describes the completed local-validation phase, before later
publication authorization. Existing schema and consent version 0.4.0 remain
unchanged. Code-only validation does not change production calendars; later
audited saves and deployment outcomes are tracked separately in RELEASE_0.4.1.md.
The SHA-256 values of applied migration sources match the verified baseline:
0.3.0 `8be476be25cb06b40a6a202445ef6e293464fbac3e29a8ceacb0c4c7d53f1b10`;
0.4.0 `dbb0b98ca4d44f0d999d0f7a77b28d9e88fb6d71799e577a0a65491533f3b34d`.
Diff whitespace check passed. An added-line scan found zero credential-pattern
matches; this is a targeted check, not proof against every possible secret.
Read-only Git references: working branch is based on `47290fc`, and local
`origin/main`/`origin/dev` references point there. Local `main`/`dev` branches
still point to `f45b007`; none were moved. These local references do not replace
a fresh remote/deployment verification before any authorized publication.
