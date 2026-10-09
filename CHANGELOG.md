# Changelog

## 0.4.0 - 2026-10-09 - Production Cutover, Reopening Pending

- Publish code 2769a11 through branch/dev/main. Fictional dev Preview and
  Production deployment 3HtXEsi6bGDz2oPtumDh1a2tvAnc are READY; production
  remains cutover/false with donations in maintenance and workflows paused.
- Restore and compare the fresh encrypted FINAL backup before SQL: 50 tables,
  490 rows, original IDs/content/amounts/schema/ACL and Auth/MFA rows preserved,
  zero differences and two private copies. Storage was empty.
- Apply billing-retry-v0.4.0 at 2026-10-09T05:40:17.068Z after the mandatory
  chat confirmation. A fresh read-only postflight verifies the exact marker,
  preservation and financial writer restrictions.
- Run native inventory and reconcile against v040 with a separate provider
  POST blocker: two existing Wompi transactions checked, zero new charges,
  no operational errors. Existing accounts and credentials were not recreated.
- Keep real login confirmation and explicit financial reopening as pending
  gates. See docs/REOPENING_0.4.0.md; no production charge is used as a test.

### Local Implementation - 2026-10-08

- Work on `codex/monthly-payment-retry`: compact administrative registry,
  mobile two-level rows and a separate timeline for payments and attempts.
- Introduce explicit billing cycles with one original and at most one
  additional attempt after verified insufficient funds, within the next
  Colombian day's 07:00-to-midnight window. Unknown results are reconciled,
  never blindly resent; one-time donations are excluded from automatic retries.
- Prepare a NEW additive migration and fictitious local laboratory. Preserve
  the applied 0.3.0 migration and all historical records; do not backfill consent.
- Align actual API/job/webhook envelopes with PostgreSQL, isolate linked legacy
  reviews, and replay administrative requests independently of provider changes.
  Keepalive becomes authenticated read-only; history is not cleaned up by it.
- Local dependency patches: Next/eslint-config-next 15.5.27, sharp 0.35.5 and
  source-map-js 1.2.2. Runtime audit clean; development-tool alerts remain documented.
- Add the guarded 0.4.0 migration entry point while retaining the 0.3.0 wrapper.
  Rehearse an encrypted fictional backup, restoration, content/ACL comparison,
  new-marker preservation and migration without accessing production backups.
- Exercise actual HTTP handlers and job/receipt code against PostgreSQL with
  mocked providers: six route cases and 15 job scenarios/313 checks. Repeated
  monthly confirmation retains its durable retry status without another POST.
- Local verification evidence is in docs/VALIDATION_0.4.0.md. Independent QA
  approved the bounded local scope after reproducing routes and job/SQL in an
  OS-enforced private sandbox; real Auth/provider/deployment checks remain gated.
- Implementation and verification are local. No commit, push, deployment,
  production SQL, provider charge or production configuration change is
  authorized by this phase. Production migration requires separate approval,
  a fresh encrypted backup, verified restoration and content comparison.
- Historical preparation checkpoint: the owner subsequently requested the complete production migration on
  October 8. Read-only production preflight passed; GitHub charge/activity
  workflows are paused with cutover/false gates and no active runs. Production
  deployment/migration were pending maintenance and the FINAL backup at that
  checkpoint. The production evidence above supersedes that pending state;
  financial reopening still requires a separate owner confirmation.

## 0.3.1 - 2026-10-04 - Administrative Contribution Types

- Show Mensual / Unico in subscriptions, linked payment history and donor
  details, with contribution-type filters. Read both monthly and one_time
  through the existing authenticated, RLS-protected administrative query.
- Keep one-time contributions read-only without amount/date/cancellation/
  reactivation controls. Preserve monthly counters and existing API guard.
- Add deterministic local fixtures and regressions. No migration or payment,
  webhook, job, authentication or production-data mutation in this patch.
- Publish code f45b007 through branch/dev/main. Verify dev's fictional Preview,
  Production deployment success and the stable authenticated admin showing
  0.3.1 and contribution types; no demo in Production. Keep maintenance and
  financial gates unchanged until separate manual reopening. Full suite:
  968 tests, lint, build and scoped independent QA pass.

## 0.3.0 - 2026-10-03 - Published In Maintenance, Financial Enablement Pending

- 2026-10-04 Colombia: trace the pre-migration checkout flow, which saved a
  pending subscription before opening the tokenization widget. Four legacy
  pending records belong to donors with a different active/approved subscription;
  eight have no recorded approved payment across their subscriptions. Do not infer exact
  abandonment/failure or provider settlement without corresponding evidence.
  Reconfirm three manually disabled workflows and intentional cutover read-only
  administration; a push alone does not re-enable charges or administrative writes.
- 2026-10-04 Colombia: owner completes private activation/password/TOTP and
  reports entry to the real admin; read-only observation confirms invitation
  consumed and verified TOTP. Compare all 27 subscriptions and their original
  columns against the final pre-migration snapshot: zero differences.
  Distinguish 12 pending subscriptions without payment/source/schedule from
  zero pending payments; retain two past_due and all existing data unchanged.
  Record the review counter/list presentation mismatch without changing UI,
  payment behavior or authorizing financial reopening.
- 2026-10-04 Colombia: prepare only the first superadmin's private activation,
  with an active UUID allowlist and a one-use invitation registered atomically.
  Deliver a private local file, not an email or public token URL. Independently
  compare the five operational tables against the post-reconciliation snapshot:
  zero differences. Human password/TOTP setup remains pending; do not create
  the second administrator or schedule delivery before the owner asks tomorrow.
  Keep financial operations and workflows disabled; no runtime or SQL change.
- 2026-10-04 Colombia: retain two encrypted post-reconciliation snapshots
  (50 tables/448 rows), private ACLs and identical SHA-256s; not yet restored.
  Verify owner-saved Standard Protection and three unauthenticated GET gates:
  login 200, admin redirects to login 307, payment acceptance maintenance 503.
  Keep account activation, MFA validation and financial reopening pending.
- 2026-10-04 Colombia: reconcile 37 existing approved payments in one guarded
  transaction using verified Wompi GET evidence. Enrich only four new metadata
  fields and append 37 exact canonical events; preserve all original records,
  schedules, amounts, tokenized sources and permissions. Verify idempotent
  replay and commit through a fresh read-only connection; no provider POSTs.
  Read-only inventory subsequently reports zero due/outstanding/blocked/failures.
- 2026-10-04 Colombia: verify owner-saved production Site URL and the single
  exact administrative callback, without wildcards or Preview/localhost URLs.
  No invitations or accounts created; retain maintenance and financial blocking.
- 2026-10-04: verify owner-disabled public signup without creating accounts.
  Record pending production Auth URLs and built-in email delivery restrictions;
  defer the administrator's invitation until setup and superadmin validation
  are complete, because the recipient will activate it immediately.
- 2026-10-04: publish the scoped migration operator and verified SQL evidence
  as fcb5689 through branch/dev/main; Production is READY with the stable domain
  assigned. Refresh the admin setup guide to distinguish completed migration
  from pending accounts/MFA and financial enablement. Keep all three operational
  workflows disabled; hand off the still-enabled public signup switch to owner.
- 2026-10-04 Colombia (2026-10-05 UTC): after the required final-backup message,
  apply the exact production migration and independently verify its marker and
  digest. Compare all 43 original tables with zero original-record differences;
  preserve donor/subscription/payment/event/audit counts and keep cutover enabled.
- Preserve two encrypted post-migration snapshot copies (50 tables/411 rows),
  with matching hashes and private permissions; do not claim they were restored.
  The pre-migration final backup was restored and compared before production SQL.
- Observe the real admin login after schema readiness, without creating users
  or sending invitations. Read-only inventory identifies 37 legacy approved
  payments needing verified approval dates; Auth signup is still enabled.
  Account/MFA setup, reconciliation and separately authorized reopening remain
  pending. No production charges or workflow re-enablement were performed.

- 2026-10-04: resume the complete package with explicit preservation of existing
  records, IDs and subscription states; do not reconstruct ambiguous history.
  Record owner-saved All Deployments protection and two unauthenticated GET
  redirects, without certifying all writers excluded. Final backup, migration,
  exclusive-credential setup/retirement and financial reopening remain pending.
- 2026-10-04: map Monthly Charges only to the version-specific GitHub secret
  SUPABASE_SERVICE_ROLE_KEY_V030, without an old-secret fallback. Keep the SDK
  environment name unchanged and add a workflow contract regression test.
  This local change does not replace credentials, publish or enable workflows.
- 2026-10-04: repeat 902 tests in 37 files, lint and the isolated demo build;
  independent QA approves this local diff, not production readiness. Correct
  the proposed Supabase key label to hpe_prod_v030 after the owner's screenshot
  rejects hyphens; key creation and private configuration remain owner actions.
- 2026-10-04: observe owner-completed exclusive-key configuration: local SDK
  HEAD accepted, cloud secret names/scopes verified without reading values.
  Reconfirm cutover/false, demo and three disabled operational workflows.
  Deployed-consumer verification, old-access retirement and final backup/SQL
  remain pending; no provider charge or production database write.
- 2026-10-04: publish validated worktree/dev checkpoint e5b57ed and observe both
  READY Previews; dev renders fictitious data, version and seven-character revision.
  Verify the local secret against a bounded Auth admin GET without creating users.
  Keep main, credential retirement, final backup and production migration pending.
- 2026-10-04: receive explicit authorization to publish main in maintenance;
  keep production SQL gated by verified final backup and separate financial
  reopening approval. Organization-level job controls remain unverified (403);
  operational workflows stay disabled.
- 2026-10-04: publish a89a2c0 by fast-forward to main after dev; Production
  dpl_GY53wydFDWvGbQ5PP7VWfkoowZSE is READY/Current in maintenance. Observe
  unchanged original table counts and pre-migration admin guard; no production
  SQL, credential retirement, financial reopening or charges performed.
- 2026-10-04: honor the owner's narrower cutover scope: keep current API keys,
  preserve paused/protected consumers and prepare production SQL. Create and
  verify the fresh encrypted final backup, isolated restore and matching private
  twin: 43 tables/410 rows, zero differences and full schema/ACL coverage.
- 2026-10-04: production attempt stopped safely on provider-managed table locks;
  independent recovery confirmed not applied and original records preserved.
  Scope explicit locks to the migration's twelve public tables, retain complete
  backup comparisons and add sanitized phase/SQLSTATE diagnostics. Validate
  906 tests, lint and an offline full migration as non-superuser postgres.
- 2026-10-04: refresh read-only pre-cut evidence and create a new encrypted
  preparation backup. Record local restore access denial, observed Preview
  maintenance response and outstanding writer-exclusion/human handoff gates;
  do not claim final backup, production migration or financial enablement.
- 2026-10-04: diagnose the backup-access failure using the user's independent
  read and NTFS ACL inspection. The three files have empty protected DACLs after
  the permission adjustment; this is not a proven sandbox restriction. With
  explicit approval, repair only those files for the operator and SYSTEM;
  verify required grants, readability and unchanged encrypted hashes.
- 2026-10-04: restore the preparation backup offline: 43 tables/409 rows,
  zero content/schema/ACL differences, coverage 5. Preserve a private second
  copy with matching hashes for all three files. Rehearse the exact CRLF SQL
  artifact and reapplication on that isolated copy, with original-row checks
  before/after each local commit. No production migration, charge or final
  cutover-backup certification; old-writer exclusion remains pending.
- 2026-10-04: record the offline historical classification without fabricating
  approval times: 37 approved payments require reconciliation and seven events
  require review. The production GET-only observation stopped before any
  request because the explicit local production credential is unavailable.
- 2026-10-04: after private credential activation, verify all 39 recorded
  transactions using provider GETs only. Rehearse enrichment of 37 approval
  dates and 37 idempotent replays through the existing SQL function on the
  isolated restored copy; preserve original rows, schedules, financial totals,
  schema and ACLs. A verifier-context failure rolled back before local commit;
  repeat with equivalent transaction contexts passed. No runtime/SQL change.
  Five additional legacy events have no linked payment/subscription in current
  read-only production inspection; provider GETs confirm two approved and
  three declined. Keep these cases unresolved pending private classification,
  with production migration and financial reopening blocked.
- 2026-10-04: review the legacy single-payment callback dependency and webhook
  early return as possible orphan-event paths, not proven historical causes.
  Current-donor email correspondence does not authorize subscription linkage;
  preserve ambiguous events and separate this finding from reported scheduler
  downtime. No record insertion, reassignment or new runtime change.
- 2026-10-04: honor the owner's instruction to leave databases as they are.
  Keep historical cases untouched and require new explicit authorization before
  production migration or any further database write. Productive data received
  reads only; earlier enrichment was limited to the isolated restored copy.
- 2026-10-04: identify fictitious admin data in the responsive header with
  explicit user approval. Keep the real admin subtitle and public donation
  routes unchanged; verify Production cannot enable the administrative demo.
  Repeat 901 tests, lint and isolated demo build; no production data writes.
- 2026-10-04: observe the corrected demo header at 320/360 px in READY Preview
  and fast-forward the candidate into dev. Verify dev deploys as Preview with
  fictitious data, while main remains unchanged; production cutover is pending.
- 2026-10-04: refresh the administrative setup notes: both identities are
  confirmed privately, no invitations were sent, and Preview must not send
  production-account activation links. Document the pending Production URL check.
- 2026-10-04: publish the candidate branch and observe a READY demo Preview.
  Verify masked fictional data, filters and three browser-only mutations with
  no administrative API or provider requests. Record incomplete remote API
  validation and the mobile demo-label issue; no production migration or charge.
- 2026-10-04: record the user's Production/Preview configuration and verified
  production-only scope of four private credentials. Document the existing
  administrative demo switch and remaining isolation/backup gates; no runtime
  change, deployment, production migration or financial enablement.
- 2026-10-04: begin the authorized release preparation while keeping finances
  disabled. Verify all three operational workflows paused, record outstanding
  Vercel configuration/backup gates, and restrict Keepalive to the main branch.
  This is not evidence of a deployment or production migration.
- Prepare a private administrative panel with email/password, mandatory TOTP,
  active UUID allowlist, server-side authorization and audited subscription changes.
- Move Wompi acceptance requests to `/merchants/info`; retain card tokenization.
- Add server-owned checkout capabilities, reserved payment attempts, reconciliation
  and Colombia-based monthly billing without guessed approval timestamps.
- Add independent financial maintenance gates and durable webhook receipts.
- Prepare non-destructive transactional migration, encrypted backups and local
  restoration/preservation verification before any production migration.
- Show app version, build date and only seven revision characters.
- Require an explicit before/after confirmation before administrative changes;
  returning or closing the dialog does not save, and repeated submits are blocked.
- Verify private restoration by original row hashes, roles, extension ownership,
  ACL and default privileges; preserve encrypted copies outside the repository.
- Exercise receipt and monthly reconciliation through real PostgreSQL RPCs with
  isolated fixtures, preserving historical amounts and later administrative schedules.
- Verify real local Auth invitations, TOTP, allowlist/RLS, revocation and audited
  mutations; accept GoTrue's 56-character invitation hashes without a SQL change.
- Exercise disconnects before and after COMMIT using an independent read-only
  observer; never retry or restore automatically after an uncertain outcome.
- Compare column ACLs in backup manifest v5 and reject repository-contained backup
  destinations, including misleading dot prefixes and junctions.
- Contain screen-reader-only labels inside scrollable administrative tables.
- Separate donor reservation from financial dispatch so failures before a Wompi
  transaction do not become false uncertain charges; retain timeout safeguards.
- Exclude only verified, completed historical ERROR/VOIDED attempts from pending
  review so they cannot indefinitely block a later authorized reactivation.
- Share middleware/SSR Auth destination isolation and recover interrupted TOTP
  enrollments without removing verified or unrelated factors.
- Distinguish local and deployed behavior in operational documentation, prevent
  overwriting an existing private environment template, and document publication gates.
- Allow read-only legacy inventory for the specifically missing payment review
  column, explicitly report incomplete coverage and never reuse that fallback
  in charge/reconcile modes; preserve operational error handling and pagination.
- Normalize the Sandbox tokenization public-key descriptor's single-line PEM
  format in the local validation harness without relaxing RSA or JWE safeguards.
- Verify synthetic webhook receipt persistence over real local HTTP in cutover;
  provide a repeatable fixture profile that cannot enable charges or provider keys.
- Reject extra DER material in tokenization key descriptors, validate laboratory
  JWT provenance and pin laboratory Docker operations to the local daemon.
- Bound receipt-preservation evidence to eight observed operational tables and
  report expected mode without claiming independent application attestation.

Status: local implementation. Production remains unchanged until the cutover gate
is approved and the final backup verification is explicitly reported in chat.

Documentation update - 2026-10-04: record read-only production preflight,
observed service/workflow health and dependency/source-review scope. The second
administrator's invitation remains pending until their email is supplied.
No production migration, accounts, deployment or financial enablement occurred.
An explicitly authorized Sandbox-only card-tokenization probe returned
201 / CREATED using encrypted fictitious data; no sources, transactions or
database writes were created. Full payment flow validation remains pending.
The inventory CLI also passed against the existing real local PostgREST and
PostgreSQL fixture with three GETs, no provider calls and 244 unchanged rows in
35 observed tables. No due subscriptions or selected payments existed in this
fixture; this does not validate charges, populated pagination or production.
- 2026-10-04: use the private server credential to read backend-created card
  payment sources; require the matching source ID, CARD type and AVAILABLE
  status before administrative reactivation. A real fictitious Sandbox source
  returned 401 with the public credential and 200 with the private credential.
  Add regression coverage without exposing credentials to the browser.
- 2026-10-04: disable dotenv loading in Vitest, fix the administrative test
  clock and cover provider timeout/invalid JSON, production credential selection,
  successful/failed reactivation and a source-read failure after approval.

- 2026-10-04: keep the standard Supabase browser login selected by the user;
  share secure-cookie policy, prevent admin response caching and retain strict
  same-origin validation with an explicit loopback integration profile.
- 2026-10-04: clear interrupted login/enrollment state and hide private tables
  after a confirmed partial logout; retain server-side AAL2/allowlist checks.
- 2026-10-04: correct accented TOTP selectors in the browser harness, not the
  product. Verify amount, future month/day and cancellation through real local
  UI/API/RLS with atomic audit and no payment created for the fictional subscription.
- 2026-10-04: compare the complete final-backup manifest under the same table
  locks as the migration; preserve newly admitted receipts in the protected
  baseline and run preservation/postflight before the single COMMIT. Keep the
  versioned migration's logical content unchanged and retain uncertain-commit
  recovery. Windows CRLF changes the physical digest; identify, rehearse and
  preserve the exact artifact before applying or checking a migration marker.
- 2026-10-04: verify initial migration and reapplication in existing fictitious
  PostgreSQL labs, plus concurrent receipts, backup drift and lock timeout.
  No production SQL, final backup, commit, push, deployment or financial enablement.
  Validation: 897 tests/37 files, lint and isolated demo build passed; Auth
  passed twice after an earlier transient MFA rejection with unproven cause.
  Detailed evidence and remaining cutover gates: docs/LOCAL_CLOSURE_2026-10-04.md.

## 0.2.1 - Existing Production Baseline

- Existing donation flow, Colombia billing calendar and GitHub Actions schedules.
