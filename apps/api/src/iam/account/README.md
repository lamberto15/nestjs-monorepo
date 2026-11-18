# iam/account

The signed-in person's own account, on iam/auth: passwords (change, reset
and invitation links, breach check, history), email verification,
sessions and token clients, two-factor, passkeys, magic links, sign-in with
providers, re-authentication and security alerts.

- **Profile:** `PATCH /v1/auth/me { name?, locale?, timezone? }` (never
  while impersonating; an unsupported language or an unknown time zone is
  a 400).
- **Who-am-I and sign-in methods:** `AccountParts` adds `mfaEnabled`,
  `hasPassword`, `authentication` and `can` (every catalog action as
  `Subject.action`; no `Access.*` while impersonating) to `GET
/v1/auth/me`, and `magicLink`, `passkeys`, `providers`, `captcha` to
  `GET /v1/auth/methods` (iam/auth's `@WhoAmIPart()`,
  `@SignInMethodsPart()`).
- **Security alerts:** `SecurityAlerts` mails the owner (SecurityAlertMail, essential) of a new sign-in, a password changed or found in a breach, two-factor on or off, a passkey added or removed, and publishes each as the domain event `account.security-alerted` (`account.events.ts`: `{ userId, kind, args, tenantId, at }`, in the change's transaction; nothing without the outbox). modules/notifications stores it as an in-app notice in the tenant the person acted in; the mail is only ever sent here.
- **Breach re-check at sign-in:** `SignInPasswordCheck` listens to iam/auth's `auth.password-verified` (in process; it carries the password's SHA-1, never the password) and checks the password against the breaches without delaying the sign-in, once per password per PASSWORD_BREACH_RECHECK_DAYS (a Redis key on a digest of the stored hash). A breached one is audited (`auth.password-breached`) and its owner told (`passwordBreached`).
- **Operators:** exports `AccountOperations` (a new password, removing two-factor, the lockout) for the `pnpm ops` commands (src/cli).
- **Tenant policy:** a new password meets `AuthPolicy.assertPasswordLength()`
  and the stricter of PASSWORD_HISTORY and the tenants' history.
- **Personal data:** `AccountPersonalData` (`@PersonalData()`, iam/personal-data)
  exports linked providers, passkeys and two-factor, and erases every way
  back in at an account's deletion.

Variables: `account.config.ts` (PASSWORD_BREACH_CHECK and its PASSWORD_BREACH_* settings, PASSWORD_HISTORY, …). Tests: `account.e2e-spec.ts`,
`passkeys.e2e-spec.ts`, `who-am-i.e2e-spec.ts`.
