# reports

Scheduled exports: a data-transfer export run for its owner, daily, weekly
or monthly at an hour of a time zone. Each run mails the recipients a signed
link to the file. The owner's own address is the `To`, and the others are
`Bcc`. There are no analytical reports or dashboards: a report is a saved
list export.

- `GET/POST /v1/reports`, `GET/PATCH/DELETE /v1/reports/{id}`, and
  `POST /v1/reports/{id}/run` (202). Each principal sees only their own;
  another's is a 404. An owner has at most 20 active reports.
- The `exporter` is a record exportable through
  `DataTransferModule.forRecord()`. Its filters and sort are checked as the
  export route checks them.
- `ReportsRunner` runs every hour at :10 on one instance, one tenant at a
  time, as `system:report-runner`. It looks up each owner again: a report is
  deactivated when its owner is gone, or may no longer export.
  - A run is claimed by moving `nextRunAt`, so it starts once.
  - A refused export skips that run.
- When the export ends (`transferFinished`), the recipients get the
  `report-ready` or `report-failed` mail, once per transfer, in the
  owner's language. The link works for `REPORT_LINK_TTL_HOURS` (default 24).
- Audited: `report.created`, `.updated`, `.deleted`, `.ran`,
  `.finished`, `.skipped` and `.deactivated`.
