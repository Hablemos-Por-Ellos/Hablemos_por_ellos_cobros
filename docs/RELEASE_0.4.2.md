# Release 0.4.2

Date: 2026-10-10 (America/Bogota).
Status: function applied and independently verified; code publication pending.

## Scope And Authorization

Owner authorization permits publication and replacement of only
`public.assert_admin_mutation_context(uuid,text,timestamptz,timestamptz)` after
the real local integration and a fresh private backup restored/compared.
The mandatory final-backup confirmation was posted in chat before production SQL.
No donor edits, table/index/grant changes, charges, job reruns, account/password/
factor changes, Vercel settings changes or key rotation are included.

Branch `codex/admin-session-mfa`; prior main/dev revision `ece238d`, version
0.4.1. Stable Vercel deployment `Ax5EGeuPTt9UxxahsKqjLci2JLso` has a successful
commit status and is retained. The immutable v0.4.1 tag remains on `10f27f0`.
Monthly Charges, Keepalive and repository-activity workflows have only schedule/
manual triggers, not push. No workflow dispatch or rerun was performed.

## Local Evidence

- 1329 Vitest tests pass, zero failures; six opt-in SQL/HTTP tests remain skipped.
- ESLint, TypeScript and isolated Next build pass; 13 static pages.
- Real GoTrue/PostgREST/Next lab: 66 Auth/API/RLS checks and 210 browser checks.
  Login requires Authenticator; three browser saves and three API saves create
  six truthful AAL2/NULL audits, with zero action MFA challenges/code payloads,
  payments, attempts, cycles, provider sends or charges.
- Fictional PostgreSQL regression: 14 tables preserve definitions/content;
  real Auth lab patch: all 36 tables preserve content. Anonymous/AAL1/unlisted/
  inactive/revoked sessions, direct writes, sensitive columns and CSRF fail.
- Tests use no production dotenv/keys or restored private data. Browser desktop/
  tablet/mobile checks pass. Cached local public font/browser binaries require
  no download. The Windows Node guard is application-level, not a full OS sandbox.
- Read-only-root private restoration has an opt-in generated-TOC streaming path
  and four focused regressions; the existing copy mode remains unchanged.

## Final Backup And Function

FINAL snapshot `2026-10-10T23:39:25.296Z`: 51 tables/501 rows, PostgreSQL17.
Restoration verified `2026-10-10T23:47:17.668Z`, with zero differences in original
IDs/content/amounts/Auth/schema/ACL/column permissions and coverage5. Storage
objects are zero; no used object files are omitted. Both private copies are
encrypted, readable only by operator/SYSTEM and hash-matched on the same PC:

- `D:\Backups\HablemosPorEllos\v042-final-2026-10-10T23-39-15Z\2026-10-10T23-39-25.299Z-15392`
- `C:\Users\USER\PrivateBackups\HablemosPorEllos\v042-final-2026-10-10T23-39-15Z\2026-10-10T23-39-25.299Z-15392`

Encrypted dump SHA-256: `d3d0973e8da1cf8130ba6b906b528e39e680ea5bcbde2d01b95eaf786c43d836`.
Encrypted manifest SHA-256: `29b9439c699082d3588d4444e2bf60d390311ac0113d56e7858698ee662f16f4`.
This is not an offsite copy. No backup or original data was deleted/overwritten.

Restored-copy rehearsal used the actual original login-role context and DB
owner, ended in ROLLBACK and preserved all 51 tables/501 rows and ACL. The
temporary lab is network=none, root read-only and tmpfs-only, with no published
ports or provider access. It was removed after verification; older labs remain.

Production executed one guarded transaction, global deadline300s, lock5s and
statement120s. COMMIT confirmed `2026-10-10T23:51:59.945Z`. Before COMMIT,
repeatable-read comparison verified every existing table/row and all metadata/
permissions, allowing only the target function definition to differ. Results:
51 tables/501 rows compared, one function changed, zero table/row/permission
changes, no new audits, provider sends or charges. OID/signature/owner/ACL remain.
Concurrent activity is not overwritten; this function-only patch needs no portal
cutover or table-writer exclusion. No current flags/settings were changed.

Applied Windows SQL artifact SHA-256:
`ee32ec842c5c902664d2326ef3415b6b3a417b9fc0679354209ce97df2c92e0e`.
Old definition SHA-256: `91c8968182472e5ed6611d395279d6b59d375e1376c4176b2f53df0c4bacfde2`.
New definition SHA-256: `4e637647fc4c2cf0d5cd2a6676b32449ca5a2c3f8092074486beeb5d27a2b2f8`.
Identifiable marker: `admin-session-mfa-v0.4.2`. No migration ledger row is
inserted. Applied 0.3.0/0.4.0 migrations remain physically unchanged.

An initial read-only observer ran while the writer transaction was still open
and saw the previous definition; it did not write or rerun SQL. After waiting
for confirmed COMMIT, a new independent read-only connection verifies the exact
new definition and expected service-role-only privileges. No uncertain commit
or automatic production retry occurred.

Post-function snapshot `2026-10-10T23:54:23.677Z`, 51 tables/501 rows, is also
consistent, encrypted and duplicated under the same roots in subdirectory
`2026-10-10T23-54-23.681Z-23060`; this additional copy has NOT been restored.
Do not confuse it with the verified pre-function FINAL.

## Publication And Recovery

Code commit/push/deployment verification is pending. The old 0.4.1 API remains
compatible with the new function while deployment is prepared; publishing only
new UI against the old function would have rejected NULL TOTP timestamps.
Do not reapply SQL when pushing code or because of a slow deployment.

Retain the old deployment and function definition in the encrypted FINAL. A
rollback uses compatible code and, only if separately authorized, restores that
function definition. Never restore an old database over newer payments/audits;
restoring DB state does not reverse money. No rollback has been executed.
