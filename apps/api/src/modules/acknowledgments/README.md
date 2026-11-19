# modules/acknowledgments: "I have read this"

Asks people to confirm they read a version of a record, and records when they did. It is not a signature. A feature's module imports `AcknowledgmentsModule.forRecord(RECORD)`.

- **Routes on the record:** `POST /v1/<path>/{id}/acknowledgment-requests` (`recipients` as `user:<id>`, optional `dueAt`), `GET …/acknowledgments?version=` (the dashboard), `POST …/acknowledgments/remind` and `DELETE …/acknowledgments/{acknowledgmentId}`: whoever may update the record. `POST …/acknowledge`: the person asked.
- **Mine:** `GET /v1/acknowledgments?status=pending|acknowledged`, of records the caller may still read.
- **Versions:** a record starts at version 1 when someone is first asked about it; each later change of the record (the extension's `updated` hook) makes a new version, and requests for an older version can no longer be answered.
- **Rules:** recipients are active members who may read the record; at most 100 per request and 500 per version; a deadline is in the future; a person is reminded at most once a day; an answer stays (it can't be withdrawn). Asking or acknowledging again changes nothing.
- **Tells:** notifications `acknowledgment.requested` and `acknowledgment.reminder`; audit entries `acknowledgment.requested|acknowledged|reminded|withdrawn` on the record. Purging the record removes its rows; a person's requests are in their data export (`acknowledgments`) and deleted with their account.

Add-on: `pnpm feature:add --addons acknowledgments` ([adding-a-feature](../../../../../docs/adding-a-feature.md), `acknowledgments.addon.js`): "I have read this", per version.
