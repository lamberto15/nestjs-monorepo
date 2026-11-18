# core/i18n

Translations (`@nestjs/i18n`, global). Texts live in each module's own `i18n/<locale>.json`: the loader finds every `**/i18n/*.json` and merges them, so no central list names them. A file's top-level keys are namespaces; two files may not define the same key (the start fails). The `validation` catalog here words the request validation errors (core/http's pipe).

- **Use:** `t('notes.title')` (or `I18nService`) in a service; texts are never hard-coded. Work outside a request (jobs, mail) passes the recipient's `locale` to `t()`.
- **Locale of a request:** `?lang=`, then `X-Lang`, then the signed-in user's saved `locale`, then `Accept-Language`, then the first of LOCALES. Responses carry `Content-Language`.
- **Adding a language:** give every module's `i18n` folder a `<locale>.json` and name it in LOCALES. Only English ships.
- **A missing key** throws in development and tests, falls back in production.

Variables (`i18n.config.ts`): LOCALES (comma separated, the first is the default; default `en`), NODE_ENV.

Remove: delete this folder and its line in `app.module.ts` (every module that translates needs it).
