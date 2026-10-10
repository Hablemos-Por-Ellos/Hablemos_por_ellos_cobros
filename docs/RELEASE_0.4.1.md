# Release 0.4.1

Date: 2026-10-10 (America/Bogota).
Status: code published and verified; two audited calendar saves await TOTP.

## Scope And Authorization

The owner explicitly requested commit, push, publication and the two previously
agreed calendar saves. No migration or financial test charge is authorized or
needed. Retain the existing provider keys, production flags and workflow settings.

The working branch is codex/legacy-billing-compatibility. Before publication,
fresh remote checks showed main/dev at 47290fc. No charge workflow was running;
the workflow has schedule/manual triggers, not push. Main remains the production
branch for Hablemos-Por-Ellos/Hablemos_por_ellos_cobros, linked to the existing
Vercel team/project hablemos-por-ellos-projects/hablemos-por-ellos-cobros.

## Evidence Checklist

- Local: 1322 tests, lint, TypeScript and isolated build passed; independent QA
  approved local (240 focused and 21 adversarial checks). Six opt-in SQL/HTTP
  integrations were not rerun. See VALIDATION_0.4.1.md.
- Code commit e2f6baa, `[v0.4.1] Preserve payment recovery and flag unsupported
  calendars`, pushed to branch/dev/main as fast-forward updates, without force.
- Dev Preview D4vMkyqrJQh23WkFJcrJaraGBWdY and branch Preview
  EgGjLcDhuHw7NmPCsXr7YEFLphwy have successful Vercel commit statuses.
  No environment values were changed. Direct authenticated Preview UI testing
  was not repeated: the inspection tab required Vercel login and was closed,
  without disabling protection. Existing source rejects production Supabase
  URLs outside Vercel Production; local build/testing used disconnected demo.
- Initial Production BXfHQt4ebMra8edVZSSoVJ9QvWNN and GitHub deployment
  6987394139 succeeded at 2026-10-10T21:53:19Z. Its unique build URL is
  https://hablemos-por-ellos-cobros-6222l8oj7-hablemos-por-ellos-projects.vercel.app.
  Canonical https://hablemos-por-ellos-cobros.vercel.app/admin/login returned 200,
  version 0.4.1, production build and expected commit e2f6baa. Donar and acceptance
  returned 200 with both legal links; unauthenticated admin returned 307 to login.
  No payment, card tokenization, provider POST or donor mutation was used as a
  test. This proves the observed routes/revision, not future bank approvals or
  all authenticated sessions. Full Vercel runtime log inspection was unavailable.
- Documentation checkpoint 10f27f0 also reached Production:
  FfueH55zCndxS4hX7FXY3nsjzder/GitHub deployment 6987492754, successful at
  2026-10-10T22:02:53Z. Canonical probes repeated 200/200/200 and admin 307;
  the production footer matched 0.4.1 and 10f27f0. This is the Vercel deployment,
  not the separate GitHub environment deployment created by the inventory job.
- Read-only inventory 38089969318 ran on main/10f27f0. It exited with
  BILLING_JOB_CALENDAR_REVIEW_REQUIRED, as expected while the two approved
  schedule saves await TOTP. Observed schema v040 with no fallback,
  calendarReviewRequired=2, legacyCalendars=2, due=1, blocked=2,
  inventoryStatus=billing_configuration_review. Operational failures, receipts,
  reserves, provider sends and charges were all zero. This warning confirms
  detection, not repaired calendars or successful payments. A clean follow-up
  inventory remains pending after actual audited saves. Never run charge to test.
- Two audited calendar saves: NOT SAVED. Both existing production-admin dialogs
  were prepared and remain open; the owner must enter their current Authenticator
  code and confirm each change. No TOTP was read or requested in chat. Date
  proposals are October 16 and
  November 6, 2026, at 07:00 Colombia/12:00 UTC. Preserve amount, source, status,
  consent and prior payments. Recheck history and pending attempts before saving.
  Use existing admin/session/MFA/recent TOTP/version/atomic audit; do not bypass
  the controls with service-role SQL. Public docs must not contain donor IDs,
  names, contact details, TOTP codes or payment identifiers.
- Annotated tag/release v0.4.1 was created on documentation checkpoint 10f27f0;
  retain that immutable tag. Subsequent documentation-only checkpoints do not
  change runtime source from e2f6baa or database schema. Their final active
  revision/deployment checks are recorded in the GitHub release notes and the
  private project note, avoiding a self-referential deployment metadata commit.

## Recovery

The database schema is unchanged. Previous stable code is 0.4.0/47290fc,
Vercel production deployment 5nnEZNLA7pRsb47f4WjKsqUR561T; retain it. A
deployment rollback is not a reversal of money or audited calendar changes.
Do not restore old backups over newer transactions. If verification fails,
report the failure and block further promotion or financial actions; do not
change flags or roll back cloud settings without authorization.

No Docker cleanup, backup deletion, account recreation, key rotation or real
provider POST is part of this release procedure.
