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
- `MAIL_DELIVERY` = `all` | `essential` | `off`: a withheld mail is logged, not queued.
  Left for the settings and quotas modules: the per-tenant `mail.delivery` setting, the daily
  budgets (deployment and tenant) with their Redis counters, `mail_withheld_total`, suppression lists.
