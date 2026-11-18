# Mail

`MailModule` (global `Mailer` from `@nestjs/mail`, and `MailQueue`) sends mail
through a queue: the request renders it, a worker sends it, with retries over hours.

A module adds a mail in its own folder, with nothing to register:

```ts
// iam/account/password-reset.mail.ts
@EssentialMail() // optional: still sent with MAIL_DELIVERY=essential
@Injectable()
export class PasswordResetMail implements Mailable<{ link: string }> {
  constructor(private readonly i18n: I18nService) {}
  render({ link }: { link: string }) {
    return {
      subject: this.i18n.t('account.mail.resetSubject'),
      template: 'password-reset',
      context: { link },
    };
  }
}
// iam/account/templates/password-reset.html (and password-reset.pt.html for locale pt): <a href="{{ link }}">...</a>
// the service: await this.mailQueue.send(PasswordResetMail, { to, data: { link }, locale }, { jobId });
```

- Templates live in a `templates/` folder of the module (anywhere under it), `.html`
  and optional `.txt`, partials in `templates/partials/`; `nest-cli.json` copies them to dist.
  `ModuleTemplateEngine` (mail.templates.ts) scans src (or dist) at boot and wraps every
  HTML body in the shared `core/mail/templates/layout.html`.
- Template names are global (`password-reset`, not per module): two folders holding the same
  name stop the boot with both file paths. Prefix with the module (`account-welcome`) to be safe.
- Texts (subjects, strings in the context) come from the module's `i18n/` catalog, not the template.
- A new template file needs a restart (the file list is read at boot); edits to one do not.
- `MAIL_TEMPLATE_ROOTS` adds directories to scan (tests use it for `test/fixtures/mail`).
- `MAIL_DELIVERY` = `all` | `essential` | `off`: the ceiling. A withheld mail is logged, counted in
  `mail_withheld_total{reason}` (`policy`, `budget`) and not queued.
- **Hooks**: core never imports the module that knows; that module marks its provider with a discovery
  decorator and core finds it (none in the app: the default applies).
  - `@MailDeliveryPolicy()` (mail-delivery.ts, `MailDelivery`): `mode()` (stricter than `MAIL_DELIVERY`, never looser)
    and `consume({ essential })` (the tenant's daily budget; false withholds). An unreadable policy leaves the ceiling alone.
    Provided by modules/deliverability.
  - `@MailBrand()` (mail-brand.ts, `MailBranding`): `current()` is the tenant's `{ name, color, logoUrl }`, read when the
    mail is rendered. Templates and the layout see it as `{{ brand.* }}` (default colour, no logo, no name); the sender's
    name becomes `brand.name` unless the mail sets its own `from`. A failing lookup sends the mail unbranded.
    Provided by modules/branding.
  - `@MailSuppressionList()` (mail-suppression.ts): asked by the worker before each send. Provided by modules/deliverability.

- **Metrics:** `mail_sent_total` (the transport accepted it, on the workers) and `mail_suppressed_total{reason}` (recipients the suppression list kept out), next to `mail_withheld_total`.
