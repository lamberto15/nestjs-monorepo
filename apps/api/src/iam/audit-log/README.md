# iam/audit-log

The audit pages: read-only routes over `iam/audit`'s log, for whoever has `Access.readAudit` (declared here). Apart from iam/audit because the routes need iam/access, which writes audit entries itself.

- `GET /v1/access/audit`: the tenant's log, newest first. Filters: `action` (eq, in, notIn, startsWith), `actor`, `actorLabel` (eq, contains, startsWith: the stored label, or a member's current name or address, or a client's name), `targetType`, `targetId`, `runId` (eq, isNull: a bulk run's entries, or none of a run), `at`; `sort`, `fields`, `filter`. Each entry has `actorName`.
- `GET /v1/access/sign-ins`: the tenant's members' sign-ins (`member.signed-in`, `member.sign-in-failed`): `user`, `method`, `result`, `ip`, `at`.
- Record changes are audited by the records engine itself (`<item>.created|updated|deleted|restored`, an update field by field).

`AuditLogModule` goes in app.module.ts. Tests: `audit-log.e2e-spec.ts`.
