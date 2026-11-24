# modules/messaging

SMS and mobile push through providers. Browsers' web push is
modules/notifications'.

- **Providers**: SMS `off|twilio|memory` (`SMS_PROVIDER`), push `apns|fcm|memory` (`PUSH_PROVIDER`, several allowed); a configured provider with a missing credential stops the app at start.
- **Routes** (the caller's own, people only, not while impersonating): `PUT|GET /v1/messaging/devices`, `DELETE /v1/messaging/devices/{id}`, `GET|PUT|DELETE /v1/messaging/phone`, `POST /v1/messaging/phone/verify` (six-digit code, ten minutes, five guesses). Tokens and numbers are encrypted with a blind index; the number is shown masked.
- **Sending**: `MessagingSender.text()` and `pushToDevices()` queue (`messaging` queue); the worker applies the kill switch (setting `messaging.sms`), re-checks the number (verified, not opted out), the toll-fraud caps (allowed prefixes; per tenant, prefix, user and IP per day; monthly budget) and sends. Transient failures retry through the queue, a dead token deletes the device, Twilio's 21610 records an opt-out.
- **STOP and START**: `POST /v1/webhooks/sms/twilio` (public, `X-Twilio-Signature` HMAC-SHA1 over the URL and fields) opts every user with that number out, or back in.
- **Metrics**: `sms_sent`, `sms_spend_minor`, `sms_blocked{reason}` (alert on it rising). A nightly job removes stale devices (`MESSAGING_DEVICE_RETENTION_DAYS`) and old counters.

Remove: `pnpm module:remove messaging` ([removing-a-module](../../../../../docs/removing-a-module.md)).
