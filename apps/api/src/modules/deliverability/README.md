# modules/deliverability

Keeps the mail the app sends out of the spam folder: providers report bounces
and complaints, the **suppression list** keeps the addresses mail must not go
to, and the mail worker asks it before every send.

- **Intake** (`POST /v1/webhooks/mail/{ses,postmark,resend,sendgrid}`, public, verified on the bytes received): SES through SNS (RSA signature, certificate fetched only from an SNS host, topic in `SES_SNS_TOPIC_ARNS`; `SES_SNS_REQUIRE_SIGNATURE_V2` refuses SHA1 signatures), Postmark (shared secret), Resend (Svix HMAC), SendGrid (ECDSA). Each refusal has a `code` (`sns_*`, `postmark_*`, `resend_*`, `sendgrid_*`); a route is 403 until its variable is set. The request only queues (`mail-events`, job id = the provider's message id); a worker records each event once (`mail_events`) and updates `mail_suppressions` as `system:mail-intake`. A provider is one more intake class in `intake/` and in `MailEventsService`.
- **The list**: hard bounce, complaint, manual: kept until removed; soft bounce: `MAIL_SOFT_BOUNCE_THRESHOLD` within `MAIL_SOFT_BOUNCE_WINDOW_HOURS`, lasts `MAIL_SOFT_BOUNCE_SUPPRESSION_HOURS`. Essential mail (`@EssentialMail()`) still reaches a complaint or soft bounce, never a hard bounce or a manual entry.
- **core/mail's hook**: `SuppressionsService` is marked `@MailSuppressionList()` (`core/mail/mail-suppression.ts`, the contract); core/mail's worker finds it and sends to everyone when it is absent.
- **Delivery rules** (`MailDeliveryRules`, `@MailDeliveryPolicy()`): the setting `mail.delivery` (`all`, `essential`, `off`; tenant scope, operators enforce it for all at `PUT /v1/settings/mail.delivery/platform`; `MAIL_DELIVERY` stays the ceiling) and the quota `mail.perDay` (mails queued per UTC day and tenant, set through modules/quotas). Past `mail.essentialOnlyPercent` (setting, default 90) of the quota only essential mail is queued; essential mail is counted and never withheld by the budget. The old deployment-wide `mail.dailyLimit` is not ported (quotas are per tenant).
- **Routes** (the operators' tenant, `@OperatorOnly()` plus `MailSuppression` `read`, `create`, `delete`): `GET|POST /v1/mail/suppressions`, `GET|DELETE /v1/mail/suppressions/{id}`.
- **Metrics**: `mail_events{provider,type}`, `mail_suppressions{reason}`. A nightly job (03:40 UTC) deletes events older than `MAIL_EVENTS_RETENTION_DAYS` (90).
- **Personal data** (`mail-deliverability`): the suppression entry and events of a person's own address are in their export and go with their account.
- JSON providers need `rawBody: true` when the app is created (main.ts); SNS posts `text/plain`, read from the stream.

Setup of SES, SNS, SPF, DKIM and DMARC for the sending domain is DNS and console work, not code: follow the mail provider's own guide.

Remove: `pnpm module:remove deliverability` ([removing-a-module](../../../../../docs/removing-a-module.md)).
