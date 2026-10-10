# Release 0.4.1

Date: 2026-10-10 (America/Bogota).
Status: publication authorized; deployment verification in progress.

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
- Git commit and branch/dev/main promotion: pending.
- Dev Preview ready and demo isolation: pending.
- Production ready, canonical version/build/commit and safe read probes: pending.
- Read-only inventory against the final main commit: pending; never run charge
  to test this release.
- Two audited calendar saves: pending. Date proposals are October 16 and
  November 6, 2026, at 07:00 Colombia/12:00 UTC. Preserve amount, source, status,
  consent and prior payments. Recheck history and pending attempts before saving.
  Use existing admin/session/MFA/recent TOTP/version/atomic audit; do not bypass
  the controls with service-role SQL. Public docs must not contain donor IDs,
  names, contact details, TOTP codes or payment identifiers.
- Release tag/notes and final documentation: pending.

## Recovery

The database schema is unchanged. Previous stable code is 0.4.0/47290fc,
Vercel production deployment 5nnEZNLA7pRsb47f4WjKsqUR561T; retain it. A
deployment rollback is not a reversal of money or audited calendar changes.
Do not restore old backups over newer transactions. If verification fails,
report the failure and block further promotion or financial actions; do not
change flags or roll back cloud settings without authorization.

No Docker cleanup, backup deletion, account recreation, key rotation or real
provider POST is part of this release procedure.
