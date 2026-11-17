# modules/deliverability

Keeps the mail the app sends out of the spam folder: providers report bounces
and complaints, the **suppression list** keeps the addresses mail must not go
to, and the mail worker asks it before every send.

- **Intake** (`POST /v1/webhooks/mail/{ses,postmark,resend,sendgrid}`, public, verified on the bytes received): SES through SNS (RSA signature, certificate fetched only from an SNS host, topic in `SES_SNS_TOPIC_ARNS`), Postmark (shared secret), Resend (Svix HMAC), SendGrid (ECDSA). Each refusal has a `code` (`sns_*`, `postmark_*`, `resend_*`, `sendgrid_*`); a route is 403 until its variable is set. The request only queues (`mail-events`, job id = the provider's message id); a worker records each event once (`mail_events`) and updates `mail_suppressions` as `system:mail-intake`. A provider is one more intake class in `intake/` and in `MailEventsService`.
- **The list**: hard bounce, complaint, manual: kept until removed; soft bounce: `MAIL_SOFT_BOUNCE_THRESHOLD` within `MAIL_SOFT_BOUNCE_WINDOW_HOURS`, lasts `MAIL_SOFT_BOUNCE_SUPPRESSION_HOURS`. Essential mail (`@EssentialMail()`) still reaches a complaint or soft bounce, never a hard bounce or a manual entry.
- **core/mail's hook**: `SuppressionsService` is marked `@MailSuppressionList()` (`core/mail/mail-suppression.ts`, the contract); core/mail's worker finds it and sends to everyone when it is absent.
- **Routes** (the operators' tenant, `@OperatorOnly()` plus `MailSuppression` `read`, `create`, `delete`): `GET|POST /v1/mail/suppressions`, `GET|DELETE /v1/mail/suppressions/{id}`.
- **Metrics**: `mail_events_total{provider,type}`, `mail_suppressions{reason}`. A nightly job (03:40 UTC) deletes events older than `MAIL_EVENTS_RETENTION_DAYS`.
- JSON providers need `rawBody: true` when the app is created (main.ts); SNS posts `text/plain`, read from the stream.

Setup of SES, SNS, SPF, DKIM and DMARC for the sending domain is DNS and console work, not code: the old docs/deliverability.md has the steps.

Remove: delete this folder and its line in `app.module.ts`.
